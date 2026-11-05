'use strict';
// Тосты Windows по правилу «не уведомлять о том, на что смотришь» (Phase 4,
// Task 2). Чистый модуль (без require('electron')) — showNotification,
// focusTab, isWindowFocused, getActiveTabId и now (клок) инжектируются извне
// (в проде — main.js/ipc.js), поэтому вся машина правил тестируется через
// node --test без живого окна.

const BODY_MAX = 120;
const DONE_THRESHOLD_MS = 30 * 1000; // тост «готово» — только если работали дольше 30с (иначе шум на каждую мелочь)

// Первая непустая строка текста — waitingText из хука Notification часто
// содержит служебные строки/пустые переносы перед сутью вопроса.
function firstNonEmptyLine(text) {
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    if (line.trim() !== '') return line;
  }
  return '';
}

function truncate(text, max = BODY_MAX) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

// isWindowFocused()/getActiveTabId() — состояние окна и активной вкладки на
// момент прихода статуса (в main эти геттеры читают win.isFocused() и
// последний activeTabId, который renderer репортит через workspace:setActive).
// showNotification({title, body, onClick}) — в main это
// new Notification({title, body}).on('click', onClick).show(), с гардом
// Notification.isSupported() (см. main.js/ipc.js — здесь модуль про это не знает).
// focusTab(tabId) — в main: поднять окно + win.webContents.send('tab:activate').
// now — клок, инжектируется ради детерминированного теста порога 30с.
function createToaster({
  isWindowFocused, getActiveTabId, showNotification, focusTab, now = Date.now,
}) {
  // tabId → момент (now()) НАСТОЯЩЕГО перехода в 'working' (не повторного пинга).
  const workingSince = new Map();
  // tabId → последний виденный статус. Нужен, чтобы отличить настоящий переход
  // в working (waiting/stuck/done/… → working, начало нового хода) от повторного
  // working-пинга ВНУТРИ уже идущего хода — sessions.js шлёт статус 'working'
  // не только на SessionStart/UserPromptSubmit, но и на КАЖДЫЙ PreToolUse
  // (каждый вызов инструмента). Без этой памяти workingSince уезжал бы вперёд
  // на каждый такой пинг, и done мерил бы «время с последнего инструмента»
  // вместо «время с начала хода» — тост подавлялся бы тем чаще, чем содержательнее
  // работа (ревью, finding 1 — прямо обратное задуманному).
  const lastStatus = new Map();

  // Пользователь смотрит именно на эту вкладку прямо сейчас — уведомлять не о чем.
  function isSuppressed(tabId) {
    return isWindowFocused() && getActiveTabId() === tabId;
  }

  function show(tabId, title, body) {
    showNotification({ title, body, onClick: () => focusTab(tabId) });
  }

  // taskNotification — ход начал сам CLI с уведомлением о конце фоновой
  // задачи (sessions.js, UserPromptSubmit), а не человек новым промптом.
  // subtitle — подпись статуса («фон · 1 команда»), идёт в тело тоста «фона».
  function onStatus({
    tabId, tabName, status, waitingText, taskNotification, subtitle,
  }) {
    const prevStatus = lastStatus.get(tabId);

    if (status === 'working') {
      // Переход в working только если ДО этого статус не был working —
      // иначе это просто очередной PreToolUse того же хода, отметку не трогаем.
      // Из «фона» по уведомлению о его конце — тоже не новое начало: такой ход
      // короткий, и порог 30с, мерь его отсюда, проглотил бы тот самый
      // «готово» (флешка записана), которого ждут. Новый же промпт человека
      // из «фона» — новый ход: иначе ответ за 2с после трёх часов dev-сервера
      // дал бы тост «готово» (ревью 05.11, S2).
      const continuesBackground = prevStatus === 'background' && taskNotification === true;
      if (prevStatus !== 'working' && !continuesBackground) workingSince.set(tabId, now());
      lastStatus.set(tabId, status);
      return;
    }

    lastStatus.set(tabId, status);

    // «Фон»: Claude ответил, но оставил живую фоновую задачу. Решение владельца
    // 05.11 — сказать об этом: вкладка с вечным dev-сервером каждый ход кончает
    // здесь, и тоста «готово» по ней не было бы никогда. Тост только на КОНЦЕ
    // ХОДА (из работы): в «фон» вкладку возвращает и хук фонового агента из
    // «Ждут тебя»/«Готово», и смена подписи — это не ответ Claude. Порог тот же,
    // что у «готово», по той же причине (шум на каждую мелочь).
    if (status === 'background') {
      if (prevStatus !== 'working' && prevStatus !== 'stuck') return;
      if (isSuppressed(tabId)) return;
      const startedAt = workingSince.get(tabId);
      const elapsed = startedAt == null ? Infinity : now() - startedAt;
      if (elapsed <= DONE_THRESHOLD_MS) return;
      show(tabId, `${tabName}: ответил · фон ещё работает`, truncate(String(subtitle || '')));
      return;
    }

    // stuck и любые прочие статусы — тишина по контракту (working обработан выше).
    if (status !== 'waiting' && status !== 'done' && status !== 'dead') return;

    if (status === 'dead') {
      // Вкладка мертва — дальше по этому tabId событий не будет; чистим карты,
      // чтобы они не копились бесконечно на каждую закрытую вкладку (finding 3).
      forget(tabId);
    }

    if (isSuppressed(tabId)) return;

    if (status === 'waiting') {
      show(tabId, `${tabName} ждёт ответа`, truncate(firstNonEmptyLine(waitingText)));
      return;
    }

    if (status === 'done') {
      const startedAt = workingSince.get(tabId);
      // Нет базовой отметки working (статус done пришёл сам по себе) —
      // не рискуем молчать: считаем порог пройденным.
      const elapsed = startedAt == null ? Infinity : now() - startedAt;
      if (elapsed <= DONE_THRESHOLD_MS) return;
      show(tabId, `${tabName}: готово`, '');
      return;
    }

    // dead
    show(tabId, `${tabName}: сессия завершилась`, '');
  }

  // forget(tabId) (Task 5 carryover фазы 4/5, утечка карт): та же чистка, что
  // onStatus уже делает на статусе 'dead' — вынесена сюда, чтобы её мог
  // вызвать и вызывающий код НАПРЯМУЮ, минуя ожидание статуса dead. Нужно,
  // потому что закрытие вкладки (tabs:close) НЕ гарантирует прихода dead в
  // этот toaster: manager.close() в sessions.js инкрементит generation ДО
  // kill() pty — события уже "неактуального" (закрытого) поколения попросту
  // не долетают сюда, и workingSince/lastStatus по её tabId оставались бы в
  // памяти НАВСЕГДА на каждую вкладку, закрытую пользователем (а не умершую
  // естественно). ipc.js зовёт forget() из обработчика tabs:close.
  function forget(tabId) {
    workingSince.delete(tabId);
    lastStatus.delete(tabId);
  }

  return { onStatus, forget };
}

module.exports = { createToaster };
