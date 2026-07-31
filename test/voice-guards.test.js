'use strict';
// Task 3 фазы 9 (голосовой ввод): чистые гарды push-to-talk — живут в
// src/renderer/js/voice/voice-guards.js как ESM-модуль (renderer использует
// import), тест — CommonJS (node --test) с динамическим import() внутри
// async-теста, тот же мост, что test/night-format.test.js/test/format.test.js.

const test = require('node:test');
const assert = require('node:assert');

test('resolveStartBlock: всё ок → allowed:true, без причины/тоста', async () => {
  const { resolveStartBlock } = await import('../src/renderer/js/voice/voice-guards.js');
  assert.deepStrictEqual(
    resolveStartBlock({ overlaysOpen: false, hasActiveTab: true, sttAvailable: true }),
    { allowed: true, reason: null },
  );
});

test('resolveStartBlock: нет активной вкладки → allowed:false, reason:no-tab, БЕЗ тоста', async () => {
  const { resolveStartBlock } = await import('../src/renderer/js/voice/voice-guards.js');
  assert.deepStrictEqual(
    resolveStartBlock({ overlaysOpen: false, hasActiveTab: false, sttAvailable: true }),
    { allowed: false, reason: 'no-tab' },
  );
});

test('resolveStartBlock: открыт оверлей → allowed:false, reason:overlay, БЕЗ тоста', async () => {
  const { resolveStartBlock } = await import('../src/renderer/js/voice/voice-guards.js');
  assert.deepStrictEqual(
    resolveStartBlock({ overlaysOpen: true, hasActiveTab: true, sttAvailable: true }),
    { allowed: false, reason: 'overlay' },
  );
});

test('resolveStartBlock: стек недоступен (вкладка есть, оверлеев нет) → allowed:false, reason:stt-unavailable, тост с текстом', async () => {
  const { resolveStartBlock } = await import('../src/renderer/js/voice/voice-guards.js');
  assert.deepStrictEqual(
    resolveStartBlock({ overlaysOpen: false, hasActiveTab: true, sttAvailable: false }),
    {
      allowed: false,
      reason: 'stt-unavailable',
      toast: { message: 'Голосовой стек не найден (см. stt.stackRoots в конфиге)', level: 'warn' },
    },
  );
});

test('resolveStartBlock: приоритет причин — нет вкладки ПЕРЕКРЫВАЕТ недоступность стека (Minor 3 ревью раунда 1) — тост про стек не показываем', async () => {
  const { resolveStartBlock } = await import('../src/renderer/js/voice/voice-guards.js');
  const result = resolveStartBlock({ overlaysOpen: false, hasActiveTab: false, sttAvailable: false });
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.reason, 'no-tab');
  assert.strictEqual(result.toast, undefined);
});

test('resolveStartBlock: приоритет причин — открытый оверлей ПЕРЕКРЫВАЕТ недоступность стека — тост про стек не показываем', async () => {
  const { resolveStartBlock } = await import('../src/renderer/js/voice/voice-guards.js');
  const result = resolveStartBlock({ overlaysOpen: true, hasActiveTab: true, sttAvailable: false });
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.reason, 'overlay');
  assert.strictEqual(result.toast, undefined);
});

test('resolveTranscribeResult: непустой текст → deliver', async () => {
  const { resolveTranscribeResult } = await import('../src/renderer/js/voice/voice-guards.js');
  assert.deepStrictEqual(
    resolveTranscribeResult({ text: 'привет мир' }),
    { action: 'deliver', text: 'привет мир' },
  );
});

test('resolveTranscribeResult: пустая строка → тост «Не расслышал»', async () => {
  const { resolveTranscribeResult } = await import('../src/renderer/js/voice/voice-guards.js');
  assert.deepStrictEqual(
    resolveTranscribeResult({ text: '' }),
    { action: 'toast', level: 'warn', message: 'Не расслышал' },
  );
});

test('resolveTranscribeResult: строка из одних пробелов/переводов строк → тост «Не расслышал»', async () => {
  const { resolveTranscribeResult } = await import('../src/renderer/js/voice/voice-guards.js');
  assert.deepStrictEqual(
    resolveTranscribeResult({ text: '   \n\t  ' }),
    { action: 'toast', level: 'warn', message: 'Не расслышал' },
  );
});

test('resolveTranscribeResult: {error} → тост с текстом ошибки как есть', async () => {
  const { resolveTranscribeResult } = await import('../src/renderer/js/voice/voice-guards.js');
  assert.deepStrictEqual(
    resolveTranscribeResult({ error: 'оба бекенда не поднялись' }),
    { action: 'toast', level: 'error', message: 'оба бекенда не поднялись' },
  );
});

test('resolveTranscribeResult: и error, и text одновременно — error приоритетнее (защитный рубеж)', async () => {
  const { resolveTranscribeResult } = await import('../src/renderer/js/voice/voice-guards.js');
  assert.deepStrictEqual(
    resolveTranscribeResult({ error: 'сбой', text: 'что-то распозналось' }),
    { action: 'toast', level: 'error', message: 'сбой' },
  );
});

test('resolveTranscribeResult: мусор на входе не бросает — трактуется как пусто', async () => {
  const { resolveTranscribeResult } = await import('../src/renderer/js/voice/voice-guards.js');
  const empty = { action: 'toast', level: 'warn', message: 'Не расслышал' };
  assert.deepStrictEqual(resolveTranscribeResult(null), empty);
  assert.deepStrictEqual(resolveTranscribeResult(undefined), empty);
  assert.deepStrictEqual(resolveTranscribeResult({}), empty);
});
