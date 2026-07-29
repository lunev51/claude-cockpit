'use strict';
// Чистые функции форматирования дашборда (Task 4 фазы 5) — живут в
// src/renderer/js/format.js как ESM-модуль (renderer использует import), тест —
// CommonJS (node --test) с динамическим import() внутри async-теста — тот же
// мост, что уже используется в test/countdown.test.js/test/peek-parse.test.js.

const test = require('node:test');
const assert = require('node:assert');

test('formatTokens: 1234 → «1.2K»', async () => {
  const { formatTokens } = await import('../src/renderer/js/format.js');
  assert.strictEqual(formatTokens(1234), '1.2K');
});

test('formatTokens: 1234567 → «1.2M»', async () => {
  const { formatTokens } = await import('../src/renderer/js/format.js');
  assert.strictEqual(formatTokens(1234567), '1.2M');
});

test('formatTokens: меньше 1000 — как есть, без суффикса', async () => {
  const { formatTokens } = await import('../src/renderer/js/format.js');
  assert.strictEqual(formatTokens(500), '500');
  assert.strictEqual(formatTokens(999), '999');
});

test('formatTokens: 0 → «0»', async () => {
  const { formatTokens } = await import('../src/renderer/js/format.js');
  assert.strictEqual(formatTokens(0), '0');
});

test('formatTokens: мусор (null/undefined/NaN) → «0», не бросает', async () => {
  const { formatTokens } = await import('../src/renderer/js/format.js');
  assert.strictEqual(formatTokens(null), '0');
  assert.strictEqual(formatTokens(undefined), '0');
  assert.strictEqual(formatTokens(NaN), '0');
});

test('formatUsd: «$12.34»', async () => {
  const { formatUsd } = await import('../src/renderer/js/format.js');
  assert.strictEqual(formatUsd(12.34), '$12.34');
});

test('formatUsd: 0 → «$0.00»', async () => {
  const { formatUsd } = await import('../src/renderer/js/format.js');
  assert.strictEqual(formatUsd(0), '$0.00');
});

test('formatUsd: округление до центов', async () => {
  const { formatUsd } = await import('../src/renderer/js/format.js');
  assert.strictEqual(formatUsd(12.345), '$12.35'); // toFixed(2) банковское округление вверх на этом значении
  assert.strictEqual(formatUsd(0.1), '$0.10');
});

test('formatUsd: мусор (null/undefined/NaN) → «$0.00», не бросает', async () => {
  const { formatUsd } = await import('../src/renderer/js/format.js');
  assert.strictEqual(formatUsd(null), '$0.00');
  assert.strictEqual(formatUsd(undefined), '$0.00');
  assert.strictEqual(formatUsd(NaN), '$0.00');
});

test('formatShortDate: ISO-дата (только день, без времени) → «28.07»', async () => {
  const { formatShortDate } = await import('../src/renderer/js/format.js');
  assert.strictEqual(formatShortDate('2026-07-28'), '28.07');
});

test('formatShortDate: ISO-дата со временем → тот же календарный день «01.01»', async () => {
  const { formatShortDate } = await import('../src/renderer/js/format.js');
  assert.strictEqual(formatShortDate('2026-01-01T23:59:00.000Z'), '01.01');
});

test('formatShortDate: ms эпохи → короткая дата', async () => {
  const { formatShortDate } = await import('../src/renderer/js/format.js');
  // 2026-07-28T12:00:00.000Z — полдень UTC, безопасно от сдвига дня в любом
  // разумном локальном поясе (±12ч).
  const ms = Date.parse('2026-07-28T12:00:00.000Z');
  assert.strictEqual(formatShortDate(ms), '28.07');
});

test('formatShortDate: мусор (null/undefined/битая строка/NaN) → «—»', async () => {
  const { formatShortDate } = await import('../src/renderer/js/format.js');
  assert.strictEqual(formatShortDate(null), '—');
  assert.strictEqual(formatShortDate(undefined), '—');
  assert.strictEqual(formatShortDate('не дата'), '—');
  assert.strictEqual(formatShortDate(NaN), '—');
});

// formatClock (Task 3 фазы 8, «Ночная смена»): HH:MM для wakeAt/ts журнала.
test('formatClock: полдень и полночь с ведущими нулями', async () => {
  const { formatClock } = await import('../src/renderer/js/format.js');
  const noon = new Date(2026, 6, 28, 12, 0, 0).getTime();
  const earlyMorning = new Date(2026, 6, 28, 1, 5, 0).getTime();
  assert.strictEqual(formatClock(noon), '12:00');
  assert.strictEqual(formatClock(earlyMorning), '01:05');
});

test('formatClock: мусор (не число/NaN/0/отрицательное) → null', async () => {
  const { formatClock } = await import('../src/renderer/js/format.js');
  assert.strictEqual(formatClock(null), null);
  assert.strictEqual(formatClock(undefined), null);
  assert.strictEqual(formatClock(NaN), null);
  assert.strictEqual(formatClock(0), null);
  assert.strictEqual(formatClock(-1), null);
  assert.strictEqual(formatClock('12:00'), null);
});

// pluralTabs (ре-ревью Task 4 раунда 1): двоичная развилка «вкладка/вкладок»
// давала «2 вкладок». Проверяем все три формы и оба исключения (11-14 и
// вторая сотня, где правило повторяется).
test('pluralTabs: единственное число на 1, 21, 101', async () => {
  const { pluralTabs } = await import('../src/renderer/js/format.js');
  assert.strictEqual(pluralTabs(1), 'вкладка');
  assert.strictEqual(pluralTabs(21), 'вкладка');
  assert.strictEqual(pluralTabs(101), 'вкладка');
});

test('pluralTabs: форма «вкладки» на 2-4 и 22-24', async () => {
  const { pluralTabs } = await import('../src/renderer/js/format.js');
  assert.strictEqual(pluralTabs(2), 'вкладки');
  assert.strictEqual(pluralTabs(4), 'вкладки');
  assert.strictEqual(pluralTabs(23), 'вкладки');
});

test('pluralTabs: форма «вкладок» на 0, 5-20 и 111-114', async () => {
  const { pluralTabs } = await import('../src/renderer/js/format.js');
  assert.strictEqual(pluralTabs(0), 'вкладок');
  assert.strictEqual(pluralTabs(5), 'вкладок');
  assert.strictEqual(pluralTabs(11), 'вкладок');
  assert.strictEqual(pluralTabs(14), 'вкладок');
  assert.strictEqual(pluralTabs(112), 'вкладок');
});

test('pluralTabs: мусор на входе не роняет — трактуется как 0', async () => {
  const { pluralTabs } = await import('../src/renderer/js/format.js');
  assert.strictEqual(pluralTabs(undefined), 'вкладок');
  assert.strictEqual(pluralTabs(NaN), 'вкладок');
  assert.strictEqual(pluralTabs('3'), 'вкладки');
});
