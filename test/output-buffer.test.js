'use strict';
// Кольцевой буфер вывода: то, что клиент увидит в терминале, подключившись.
// Ограничение по байтам — не оптимизация, а условие жизни на 8 ГБ ОЗУ:
// без него вкладка с `npm test` в цикле съела бы память за ночь.
const test = require('node:test');
const assert = require('node:assert');
const { createOutputBuffer } = require('../src/main/output-buffer');

test('копит вывод вкладки и отдаёт склеенным', () => {
  const b = createOutputBuffer({ maxBytes: 1024 });
  b.push('T1', 'привет, ');
  b.push('T1', 'мир');
  assert.strictEqual(b.get('T1'), 'привет, мир');
});

test('вкладки не смешиваются', () => {
  const b = createOutputBuffer({ maxBytes: 1024 });
  b.push('T1', 'первая');
  b.push('T2', 'вторая');
  assert.strictEqual(b.get('T1'), 'первая');
  assert.strictEqual(b.get('T2'), 'вторая');
});

test('пустая вкладка — пустая строка, а не undefined', () => {
  const b = createOutputBuffer({ maxBytes: 1024 });
  assert.strictEqual(b.get('нет-такой'), '');
});

test('превышение предела режет НАЧАЛО — свежий хвост важнее', () => {
  const b = createOutputBuffer({ maxBytes: 10 });
  b.push('T1', 'абвгде');   // 12 байт в utf-8 (кириллица по 2)
  b.push('T1', 'жз');       // ещё 4
  const out = b.get('T1');
  assert.ok(Buffer.byteLength(out, 'utf8') <= 10, `осталось ${Buffer.byteLength(out, 'utf8')} байт`);
  assert.ok(out.endsWith('жз'), 'хвост обязан сохраниться');
});

test('одна порция длиннее предела обрезается до предела', () => {
  const b = createOutputBuffer({ maxBytes: 8 });
  b.push('T1', 'x'.repeat(100));
  assert.strictEqual(Buffer.byteLength(b.get('T1'), 'utf8'), 8);
});

test('обрезка не разрывает многобайтный символ пополам', () => {
  // Кириллица занимает 2 байта. Наивная резка по байтам даёт «замену» U+FFFD
  // прямо в первой строке, которую увидит человек на макбуке.
  const b = createOutputBuffer({ maxBytes: 5 });
  b.push('T1', 'абв');
  assert.ok(!b.get('T1').includes('�'), `битый символ: ${JSON.stringify(b.get('T1'))}`);
});

test('drop освобождает память закрытой вкладки', () => {
  const b = createOutputBuffer({ maxBytes: 1024 });
  b.push('T1', 'данные');
  b.drop('T1');
  assert.strictEqual(b.get('T1'), '');
  assert.strictEqual(b.totalBytes(), 0);
});

test('totalBytes считает все вкладки — им жить в одной памяти', () => {
  const b = createOutputBuffer({ maxBytes: 1024 });
  b.push('T1', 'abc');
  b.push('T2', 'de');
  assert.strictEqual(b.totalBytes(), 5);
});
