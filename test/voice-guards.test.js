'use strict';
// Task 3 фазы 9 (голосовой ввод): чистые гарды push-to-talk — живут в
// src/renderer/js/voice/voice-guards.js как ESM-модуль (renderer использует
// import), тест — CommonJS (node --test) с динамическим import() внутри
// async-теста, тот же мост, что test/night-format.test.js/test/format.test.js.

const test = require('node:test');
const assert = require('node:assert');

test('canStartRecording: все условия выполнены → true', async () => {
  const { canStartRecording } = await import('../src/renderer/js/voice/voice-guards.js');
  assert.strictEqual(canStartRecording({
    overlays: { dashboard: false, palette: false, peek: false },
    hasActiveTab: true,
    sttAvailable: true,
  }), true);
});

test('canStartRecording: нет активной вкладки → false', async () => {
  const { canStartRecording } = await import('../src/renderer/js/voice/voice-guards.js');
  assert.strictEqual(canStartRecording({
    overlays: {},
    hasActiveTab: false,
    sttAvailable: true,
  }), false);
});

test('canStartRecording: голосовой стек недоступен → false', async () => {
  const { canStartRecording } = await import('../src/renderer/js/voice/voice-guards.js');
  assert.strictEqual(canStartRecording({
    overlays: {},
    hasActiveTab: true,
    sttAvailable: false,
  }), false);
});

test('canStartRecording: любой открытый оверлей блокирует запись', async () => {
  const { canStartRecording } = await import('../src/renderer/js/voice/voice-guards.js');
  const base = { hasActiveTab: true, sttAvailable: true };
  assert.strictEqual(canStartRecording({ ...base, overlays: { palette: true } }), false);
  assert.strictEqual(canStartRecording({ ...base, overlays: { dashboard: true } }), false);
  assert.strictEqual(canStartRecording({ ...base, overlays: { peek: true } }), false);
  assert.strictEqual(canStartRecording({ ...base, overlays: { historySearch: true } }), false);
  assert.strictEqual(canStartRecording({ ...base, overlays: { recipeForm: true } }), false);
  assert.strictEqual(canStartRecording({ ...base, overlays: { hotkeys: true } }), false);
  assert.strictEqual(canStartRecording({ ...base, overlays: { queue: true } }), false);
  assert.strictEqual(canStartRecording({ ...base, overlays: { restore: true } }), false);
});

test('canStartRecording: несколько флагов сразу, хотя бы один true → false', async () => {
  const { canStartRecording } = await import('../src/renderer/js/voice/voice-guards.js');
  assert.strictEqual(canStartRecording({
    overlays: {
      dashboard: false, palette: false, peek: false, queue: true,
    },
    hasActiveTab: true,
    sttAvailable: true,
  }), false);
});

test('canStartRecording: overlays отсутствуют/мусор — не бросает, трактуется как «ничего не открыто»', async () => {
  const { canStartRecording } = await import('../src/renderer/js/voice/voice-guards.js');
  const base = { hasActiveTab: true, sttAvailable: true };
  assert.strictEqual(canStartRecording({ ...base, overlays: null }), true);
  assert.strictEqual(canStartRecording({ ...base, overlays: undefined }), true);
  assert.strictEqual(canStartRecording({ ...base }), true);
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
