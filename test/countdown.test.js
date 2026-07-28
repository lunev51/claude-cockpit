'use strict';
// formatCountdown (Task 3 фазы 5, кольца лимитов) — чистая функция форматирования
// обратного отсчёта до resetsAt. Живёт в src/renderer/js/countdown.js как ESM-модуль
// (renderer использует import), тест — CommonJS (node --test) с динамическим
// import() внутри async-теста — тот же мост, что уже используется в
// test/peek-parse.test.js.

const test = require('node:test');
const assert = require('node:assert');

const H = 3600000;
const M = 60000;
const D = 86400000;

test('formatCountdown: больше часа → «2ч 13м»', async () => {
  const { formatCountdown } = await import('../src/renderer/js/countdown.js');
  const now = 1000000;
  const resetsAt = now + 2 * H + 13 * M;
  assert.strictEqual(formatCountdown(resetsAt, now), '2ч 13м');
});

test('formatCountdown: меньше часа → «47м»', async () => {
  const { formatCountdown } = await import('../src/renderer/js/countdown.js');
  const now = 1000000;
  const resetsAt = now + 47 * M;
  assert.strictEqual(formatCountdown(resetsAt, now), '47м');
});

test('formatCountdown: меньше минуты → «меньше минуты»', async () => {
  const { formatCountdown } = await import('../src/renderer/js/countdown.js');
  const now = 1000000;
  const resetsAt = now + 30000; // 30 секунд
  assert.strictEqual(formatCountdown(resetsAt, now), 'меньше минуты');
});

test('formatCountdown: прошедшее время → «—»', async () => {
  const { formatCountdown } = await import('../src/renderer/js/countdown.js');
  const now = 1000000;
  assert.strictEqual(formatCountdown(now - 1000, now), '—');
  assert.strictEqual(formatCountdown(now, now), '—'); // ровно «сейчас» — уже не будущее
});

test('formatCountdown: невалидные значения → «—»', async () => {
  const { formatCountdown } = await import('../src/renderer/js/countdown.js');
  const now = 1000000;
  assert.strictEqual(formatCountdown(null, now), '—');
  assert.strictEqual(formatCountdown(undefined, now), '—');
  assert.strictEqual(formatCountdown(NaN, now), '—');
  assert.strictEqual(formatCountdown('not-a-number', now), '—');
});

test('formatCountdown: ровно 1 минута → «1м» (не «меньше минуты»)', async () => {
  const { formatCountdown } = await import('../src/renderer/js/countdown.js');
  const now = 1000000;
  assert.strictEqual(formatCountdown(now + 1 * M, now), '1м');
});

test('formatCountdown: ровно на границе часа (60м) → «1ч 0м»', async () => {
  const { formatCountdown } = await import('../src/renderer/js/countdown.js');
  const now = 1000000;
  assert.strictEqual(formatCountdown(now + 60 * M, now), '1ч 0м');
});

// FINDING 3 (ревью, fix round 1): недельное кольцо показывало «164ч 26м» —
// формат не умел переходить на дни. Пороги брифа: ≥24ч → «Xд Yч» (минуты
// отбрасываются), 1..24ч (не включая 24ч) → «Xч Yм» как раньше.
test('formatCountdown: чуть меньше суток (23ч 59м) → всё ещё часовой формат «23ч 59м»', async () => {
  const { formatCountdown } = await import('../src/renderer/js/countdown.js');
  const now = 1000000;
  assert.strictEqual(formatCountdown(now + 23 * H + 59 * M, now), '23ч 59м');
});

test('formatCountdown: ровно на границе суток (24ч) → «1д 0ч»', async () => {
  const { formatCountdown } = await import('../src/renderer/js/countdown.js');
  const now = 1000000;
  assert.strictEqual(formatCountdown(now + D, now), '1д 0ч');
});

test('formatCountdown: несколько суток с часами, минуты отбрасываются → «6д 20ч»', async () => {
  const { formatCountdown } = await import('../src/renderer/js/countdown.js');
  const now = 1000000;
  // Тот самый пример из ревью: реальный недельный отсчёт «164ч 26м» — это
  // ровно 6д 20ч 26м, минуты в дневном формате не показываем.
  const resetsAt = now + 6 * D + 20 * H + 26 * M;
  assert.strictEqual(formatCountdown(resetsAt, now), '6д 20ч');
});

test('formatCountdown: много суток (например, недельное окно почти целиком) → «6д 23ч»', async () => {
  const { formatCountdown } = await import('../src/renderer/js/countdown.js');
  const now = 1000000;
  const resetsAt = now + 6 * D + 23 * H + 1 * M;
  assert.strictEqual(formatCountdown(resetsAt, now), '6д 23ч');
});
