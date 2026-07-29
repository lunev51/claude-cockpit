'use strict';
// «Ночная смена» (Task 3 фазы 8): чистые функции рендера секции дашборда —
// маппинг типа записи журнала на человеческий текст (дословно из брифа
// task-3-brief.md) и строка состояния секции. Ничего про DOM — используется
// dashboard.js (renderer) и напрямую тестом через динамический import() (тот
// же приём, что countdown.js/peek-parse.js/format.js — см. test/format.test.js).
//
// Форма записи журнала (ядро — src/main/night-watch.js/appendJournal):
// {ts, type, tabId?, detail?}. Типы, дословно из брифа: limit-stop, resumed,
// skipped (всегда с detail — «status:X» или «user-took-over»), weekly-limit,
// wake-complete (detail — «N of M»), gave-up, armed, disarmed, retry (detail —
// «попытка (tabId, …)»). Прочие типы (usage-error, no-usage-data,
// no-resets-at, cap-reached, internal-error, aborted) — показываются КАК ЕСТЬ
// (сырой type), тем же приглушённым стилем, что и остальные строки журнала —
// без отдельной раскраски по типу (бриф).

import { formatClock } from './format.js';

export function journalEntryText(entry) {
  if (!entry || typeof entry.type !== 'string') return '';
  const detail = entry.detail == null ? '' : entry.detail;
  switch (entry.type) {
    case 'limit-stop': return 'встала по лимиту';
    case 'resumed': return 'продолжена';
    case 'skipped': return `пропущена: ${detail}`;
    case 'weekly-limit': return 'недельный лимит';
    case 'wake-complete': return `пробуждение: ${detail}`;
    case 'gave-up': return 'окно не сбросилось';
    case 'armed': return 'включена';
    case 'disarmed': return 'выключена';
    case 'retry': return `повтор: ${detail}`;
    default: return entry.type;
  }
}

// «HH:MM — текст» для одной записи журнала — ts отсутствует/битый → «—:—»
// (formatClock уже отдаёт null на мусор, не бросает).
export function formatJournalLine(entry) {
  const clock = formatClock(entry && entry.ts) || '—:—';
  return `${clock} — ${journalEntryText(entry)}`;
}

// Последние `limit` записей журнала, НОВЫЕ СВЕРХУ — сам журнал (night-watch.js/
// journal.readAll()) хранит записи в порядке append (старые в начале), бриф
// требует обратный порядок для показа в дашборде.
export function recentJournalEntries(journal, limit = 20) {
  const arr = Array.isArray(journal) ? journal : [];
  return arr.slice(-limit).reverse();
}

// Строка состояния секции дашборда (бриф, порядок проверок дословно): не
// armed → «выключена»; armed и wakeAt непуст → «ждёт сброса…»; armed без
// ожидания → «вооружена, сбросов обработано N».
export function nightStatusLine(snapshot) {
  const s = snapshot || {};
  if (!s.armed) return 'выключена';
  if (s.wakeAt) {
    const clock = formatClock(s.wakeAt) || '—:—';
    const pending = Number.isFinite(s.pendingCount) ? s.pendingCount : 0;
    return `ждёт сброса: ${pending} вкладок, продолжу в ${clock}`;
  }
  const resets = Number.isFinite(s.resetsHandled) ? s.resetsHandled : 0;
  return `вооружена, сбросов обработано ${resets}`;
}
