'use strict';
// «Ночная смена» (Task 3 фазы 8): чистые функции рендера секции дашборда —
// маппинг типа записи журнала на человеческий текст (дословно из брифа
// task-3-brief.md, дополнено ревью раунда 1 — см. ниже) и строка состояния
// секции. Ничего про DOM — используется dashboard.js (renderer) и напрямую
// тестом через динамический import() (тот же приём, что countdown.js/
// peek-parse.js/format.js — см. test/format.test.js).
//
// Форма записи журнала (ядро — src/main/night-watch.js/appendJournal):
// {ts, type, tabId?, detail?}. Полный список из 16 типов ядра — КАЖДЫЙ имеет
// явный человеческий текст (ревью раунда 1, Minor 4: раньше 6 типов утекали
// сырым английским токеном — «cap-reached» ночью не экзотика, а штатное
// событие). tabId несут limit-stop/weekly-limit/no-resets-at/usage-error/
// no-usage-data/cap-reached/skipped/resumed/tab-closed — Important 2 ревью
// раунда 1: без имени вкладки утренний журнал из нескольких строк неотличим
// («какая именно вкладка пропущена» — п.5 приёмки фазы проверяет ровно это).
// 'tab-closed' (M1+M3, ревью финальной волны фазы 8) — pending-вкладка
// закрыта пользователем ДО пробуждения (main/ipc.js/'tabs:close' →
// nightWatch.forget()). 'pty-restarted' — новое ЗНАЧЕНИЕ detail у уже
// существующего типа 'skipped' (M2, ревью финальной волны): pty вкладки
// сменился МЕЖДУ детектом и пробуждением (авто-респавн провала резюма —
// контекстно пустая сессия; либо ручной Ctrl+Shift+R без sessionId —
// интерактивный ПИКЕР сессий Claude Code, куда голое «продолжай\r» выбрало
// бы произвольную строку меню) — резюм отменён как небезопасный.

import { formatClock, pluralTabs } from './format.js';

// Important 3 (ревью раунда 1): detail записи 'skipped' — служебное значение
// ядра (night-watch.js/processResumeTab: `status:${status}` для
// waiting/dead/отсутствующей вкладки, либо 'user-took-over' при перехвате) —
// показывать его сырым текстом означает нарушить обещание спеки «пропущена:
// <причина>» человеческим языком. Список исчерпывающий: processResumeTab
// пишет 'skipped' ТОЛЬКО для статусов из NO_RESUME_STATUSES ('waiting'/'dead')
// либо отсутствия вкладки (status===null → 'status:null'), либо перехвата —
// никаких иных значений detail для этого типа не бывает.
const SKIPPED_DETAIL_TEXT = {
  'status:waiting': 'ждёт ответа на диалог',
  'status:dead': 'вкладка умерла',
  'status:null': 'вкладки больше нет',
  'user-took-over': 'перехвачена тобой',
  // M2 (ревью финальной волны фазы 8): pty перезапустился между детектом и
  // пробуждением (авто-респавн/ручной рестарт в пикер сессий) — см. комментарий
  // в шапке файла.
  'pty-restarted': 'вкладка перезапущена — резюм отменён',
};

function skippedDetailText(detail) {
  return SKIPPED_DETAIL_TEXT[detail] || detail;
}

// Important 2 (ревью раунда 1): resolveTabName — необязательная функция
// tabId→имя (app.js прокидывает tabStore.peekInfo(tabId)?.name через
// createDashboard({resolveTabName}), см. dashboard.js). Обёрнуто в try/catch —
// чистая функция night-format.js не должна упасть, даже если резолвер
// (чужой код) бросит. Фолбэк — сырой tabId (закрытая вкладка/резолвер не дал
// строку/резолвер не передан вовсе — тот же случай, что и тест «без
// резолвера»).
function resolveName(tabId, resolveTabName) {
  if (tabId == null) return null;
  if (typeof resolveTabName === 'function') {
    try {
      const name = resolveTabName(tabId);
      if (typeof name === 'string' && name) return name;
    } catch {
      // резолвер чужой (tabStore.peekInfo) — сбой не должен ронять рендер журнала
    }
  }
  // N1 (ре-ревью раунда 1): tabId — 36-символьный UUID; после перезапуска
  // приложения журнал прошлой ночи резолвера не находит (вкладок уже нет), и
  // полный UUID-префикс на каждой строке переносил бы 11px-моно на две
  // строки. Первых 8 символов достаточно, чтобы различить вкладки между собой.
  return String(tabId).slice(0, 8);
}

export function journalEntryText(entry, resolveTabName) {
  if (!entry || typeof entry.type !== 'string') return '';
  const detail = entry.detail == null ? '' : entry.detail;

  let text;
  switch (entry.type) {
    case 'limit-stop': text = 'встала по лимиту'; break;
    case 'resumed': text = 'продолжена'; break;
    case 'skipped': text = `пропущена: ${skippedDetailText(detail)}`; break;
    case 'weekly-limit': text = 'недельный лимит'; break;
    case 'wake-complete': text = `пробуждение: ${detail}`; break;
    case 'gave-up': text = 'окно не сбросилось'; break;
    case 'armed': text = 'включена'; break;
    case 'disarmed': text = 'выключена'; break;
    case 'retry': text = `повтор: ${detail}`; break;
    // Minor 4 (ревью раунда 1): раньше эти 6 типов падали в default (сырой
    // английский токен) — теперь у каждого явный русский текст.
    case 'usage-error': text = 'сбой опроса лимитов'; break;
    case 'no-usage-data': text = 'нет данных о лимитах'; break;
    // N2 (ре-ревью раунда 1): у ядра ДВА случая no-resets-at — «времени
    // сброса нет вовсе» и «время сброса уже в прошлом» (detail
    // 'resets-at-in-past', протухший кэш/часы) — различаем их, диагностика
    // утром важнее краткости.
    case 'no-resets-at':
      text = detail === 'resets-at-in-past'
        ? 'время сброса уже в прошлом' : 'нет времени сброса';
      break;
    case 'cap-reached': text = 'потолок пробуждений исчерпан'; break;
    // N2: detail здесь — err.message, прятать его значит утром гадать.
    case 'internal-error': text = detail ? `внутренняя ошибка: ${detail}` : 'внутренняя ошибка'; break;
    case 'aborted': text = 'прервано выключением'; break;
    // M1+M3 (ревью финальной волны фазы 8): вкладка закрыта пользователем,
    // пока ждала сброса окна — будильник/блокер этой конкретной вкладки уже
    // сняты (nightWatch.forget(), main/ipc.js/'tabs:close').
    case 'tab-closed': text = 'закрыта до пробуждения'; break;
    // default остаётся защитным рубежом на случай БУДУЩЕГО типа ядра, ещё не
    // добавленного сюда, — «не бросать наружу» важнее полноты в этот момент.
    default: text = entry.type;
  }

  const name = resolveName(entry.tabId, resolveTabName);
  return name ? `${name} ${text}` : text;
}

// «HH:MM — текст» для одной записи журнала — ts отсутствует/битый → «—:—»
// (formatClock уже отдаёт null на мусор, не бросает). resolveTabName
// прокидывается насквозь в journalEntryText (Important 2 ревью раунда 1).
export function formatJournalLine(entry, resolveTabName) {
  const clock = formatClock(entry && entry.ts) || '—:—';
  return `${clock} — ${journalEntryText(entry, resolveTabName)}`;
}

// Последние `limit` записей журнала, НОВЫЕ СВЕРХУ — сам журнал (night-watch.js/
// journal.readAll()) хранит записи в порядке append (старые в начале), бриф
// требует обратный порядок для показа в дашборде.
//
// Nit (ревью раунда 1): limit<=0 (в т.ч. явный 0) → []. Array.prototype.slice(-0)
// эквивалентен slice(0) (ВЕСЬ массив, а не «ноль элементов») — без явного
// гарда recentJournalEntries(journal, 0) молча отдал бы журнал целиком, что
// противоречит и здравому смыслу параметра, и духу «чистая функция, не
// удивляет вызывающего». Сейчас в проекте нет вызывающих с limit<=0
// (buildNightSection всегда зовёт с дефолтом 20), но модуль заявлен
// экспортируемым и покрытым тестом — граница должна быть определена честно.
export function recentJournalEntries(journal, limit = 20) {
  const arr = Array.isArray(journal) ? journal : [];
  if (!(typeof limit === 'number' && limit > 0)) return [];
  return arr.slice(-limit).reverse();
}

// Строка состояния секции дашборда (бриф, порядок проверок дословно): не
// armed → «выключена»; armed и wakeAt непуст → «ждёт сброса…»; armed без
// ожидания → «вооружена, сбросов обработано N». Minor 5 (ревью раунда 1):
// «M вкладок» без склонения было неграмотно на самом частом случае («ждёт
// сброса: 1 вкладок») — pluralTabs() уже есть в format.js именно для этого.
export function nightStatusLine(snapshot) {
  const s = snapshot || {};
  if (!s.armed) return 'выключена';
  if (s.wakeAt) {
    const clock = formatClock(s.wakeAt) || '—:—';
    const pending = Number.isFinite(s.pendingCount) ? s.pendingCount : 0;
    return `ждёт сброса: ${pending} ${pluralTabs(pending)}, продолжу в ${clock}`;
  }
  const resets = Number.isFinite(s.resetsHandled) ? s.resetsHandled : 0;
  return `вооружена, сбросов обработано ${resets}`;
}
