'use strict';
// Чистые функции форматирования чисел/дат для дашборда (Task 4 фазы 5).
// Никакого DOM — используются и в dashboard.js (renderer), и напрямую в тесте
// через динамический import() (см. test/format.test.js).

// formatTokens(n) → «1234»→«1.2K», «1234567»→«1.2M», <1000 — как есть (округлено
// до целого), 0/мусор (null/undefined/NaN) → «0». Один десятичный знак у K/M —
// брифу этого достаточно (примеры «1.2M»/«1.2K»), без обрезки хвостового «.0».
export function formatTokens(n) {
  const num = Number(n);
  const safe = Number.isFinite(num) && num > 0 ? num : 0;
  if (safe < 1000) return String(Math.round(safe));
  if (safe < 1000000) return `${(safe / 1000).toFixed(1)}K`;
  return `${(safe / 1000000).toFixed(1)}M`;
}

// formatUsd(n) → «$12.34», «$0.00» для нуля/мусора. Отрицательных расходов не
// бывает (ccusage их не отдаёт) — специальной обработки знака нет.
export function formatUsd(n) {
  const num = Number(n);
  const safe = Number.isFinite(num) ? num : 0;
  return `$${safe.toFixed(2)}`;
}

// formatShortDate(isoOrMs) → «28.07» / «—» для мусора.
//
// Два входных случая:
//  - ISO-строка даты (byDay[].date из usage-ccusage.js, «YYYY-MM-DD», без
//    времени) — разбираем префикс регуляркой НАПРЯМУЮ, без Date.parse: сам
//    ccusage отдаёт календарный день без времени и часового пояса, поэтому
//    любой проход через Date (который трактует «YYYY-MM-DD» как полночь UTC)
//    рискует сместить день в локальном поясе с отрицательным смещением от UTC.
//  - ms эпохи (byProject[].lastActive из usage-ccusage.js — реальный момент
//    времени) — тут смещение в локальный день ожидаемо и корректно, идём
//    через Date.
function pad2(n) {
  return String(n).padStart(2, '0');
}

// Русская форма слова «вкладка» для числа n (ре-ревью раунда 1, косметика):
// раньше в двух местах стояла двоичная развилка «вкладка/вкладок», из-за
// которой на 2-4 получалось «Текущие 2 вкладок будут закрыты». Правило
// стандартное: 1, 21, 31… — «вкладка»; 2-4, 22-24… — «вкладки»; всё
// остальное, включая 11-14, — «вкладок».
export function pluralTabs(n) {
  const abs = Math.abs(Math.trunc(Number(n) || 0));
  const mod100 = abs % 100;
  if (mod100 >= 11 && mod100 <= 14) return 'вкладок';
  const mod10 = abs % 10;
  if (mod10 === 1) return 'вкладка';
  if (mod10 >= 2 && mod10 <= 4) return 'вкладки';
  return 'вкладок';
}

// formatClock(ms) → «HH:MM» / null для мусора (не число/NaN/<=0) — Task 3
// фазы 8 («Ночная смена»): секция дашборда форматирует так wakeAt (момент
// запланированного пробуждения) и ts записей журнала, а сам дашборд — «обновлено
// в HH:MM» из fetchedAt лимитов/расходов. Там 0 значит «данных ещё не было»
// (buildResult/zeroSnapshot), отсюда null вместо «01.01.1970». Приватная копия
// formatTime в dashboard.js убрана (ревью 09.08, C14) — она была дословной.
export function formatClock(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// limitColor(percent) → цвет лимита: ok ниже 60%, warn от 60 до 85 включительно,
// err выше 85 (бриф фазы 5). Одна копия на кольца сайдбара (rings.js) и полосы
// дашборда (dashboard.js): раньше у каждого была своя colorFor с теми же
// числами, и правка порогов в одной разъехалась бы с другой молча (ревью
// 09.08, C14).
export function limitColor(percent) {
  if (percent > 85) return 'var(--err)';
  if (percent >= 60) return 'var(--warn)';
  return 'var(--ok)';
}

export function formatShortDate(isoOrMs) {
  if (typeof isoOrMs === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoOrMs);
    if (m) return `${m[3]}.${m[2]}`;
    const ms = Date.parse(isoOrMs);
    if (Number.isNaN(ms)) return '—';
    return formatShortDate(ms);
  }
  if (typeof isoOrMs === 'number' && Number.isFinite(isoOrMs)) {
    const d = new Date(isoOrMs);
    if (Number.isNaN(d.getTime())) return '—';
    return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}`;
  }
  return '—';
}
