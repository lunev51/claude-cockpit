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
