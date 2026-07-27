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
  // tabId → момент (now()), когда вкладка в последний раз перешла в 'working'.
  const workingSince = new Map();

  // Пользователь смотрит именно на эту вкладку прямо сейчас — уведомлять не о чем.
  function isSuppressed(tabId) {
    return isWindowFocused() && getActiveTabId() === tabId;
  }

  function show(tabId, title, body) {
    showNotification({ title, body, onClick: () => focusTab(tabId) });
  }

  function onStatus({
    tabId, tabName, status, waitingText,
  }) {
    if (status === 'working') {
      workingSince.set(tabId, now()); // база для порога done — обновляется, но сама 'working' молчит
      return;
    }

    // stuck и любые прочие статусы — тишина по контракту (working обработан выше).
    if (status !== 'waiting' && status !== 'done' && status !== 'dead') return;

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

  return { onStatus };
}

module.exports = { createToaster };
