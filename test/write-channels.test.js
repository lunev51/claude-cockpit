'use strict';
// Классификация каналов для эстафеты. Главный тест здесь — не «term:write
// запрещён», а ПОЛНОТА: канал, забытый при добавлении новой команды, обязан
// ронять сборку, а не тихо получать право писать в чужой терминал.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  isWriteChannel, WRITE_CHANNELS, FREE_CHANNELS,
} = require('../src/main/write-channels');

// api-shape.js — ES-модуль renderer'а; из CommonJS-теста он доступен только
// динамическим import() (тот же приём, что в net-api.test.js).
const shapeUrl = pathToFileURL(
  path.join(__dirname, '..', 'src', 'renderer', 'js', 'api-shape.js'),
).href;

test('ввод в терминал требует управления, чтение — нет', () => {
  assert.strictEqual(isWriteChannel('term:write'), true);
  assert.strictEqual(isWriteChannel('term:resize'), true);
  assert.strictEqual(isWriteChannel('tabs:open'), true);
  assert.strictEqual(isWriteChannel('queue:add'), true);
  assert.strictEqual(isWriteChannel('stt:transcribe'), true);
  assert.strictEqual(isWriteChannel('usage:get'), false);
  assert.strictEqual(isWriteChannel('net:buffer'), false);
  assert.strictEqual(isWriteChannel('tabs:list'), false);
});

test('захват управления невладельцу не запрещён — иначе его не забрать', () => {
  assert.strictEqual(isWriteChannel('owner:claim'), false);
  assert.strictEqual(isWriteChannel('owner:get'), false);
});

test('неизвестный канал считается пишущим', () => {
  // Осторожная сторона по умолчанию: незнакомое имя скорее что-то меняет.
  assert.strictEqual(isWriteChannel('никогдатакогонебыло'), true);
});

test('списки не пересекаются', () => {
  const both = [...WRITE_CHANNELS].filter((c) => FREE_CHANNELS.has(c));
  assert.deepStrictEqual(both, [], 'канал не может быть одновременно и там, и там');
});

test('КАЖДЫЙ канал формы api классифицирован', async () => {
  const { API_SHAPE } = await import(shapeUrl);
  const missing = [];
  for (const [name, spec] of Object.entries(API_SHAPE)) {
    if (spec.kind === 'event') continue; // события идут в обратную сторону
    if (!WRITE_CHANNELS.has(spec.channel) && !FREE_CHANNELS.has(spec.channel)) {
      missing.push(`${name} (${spec.channel})`);
    }
  }
  assert.deepStrictEqual(
    missing, [],
    'новый канал не отнесён ни к пишущим, ни к свободным — допишите его в write-channels.js',
  );
});
