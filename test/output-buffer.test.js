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

// Important 2 (ревью задачи 4): эмодзи в UTF-16 — суррогатная ПАРА (два
// code unit на одну кодовую точку), а не один символ. Резка по code unit
// (что делала брифовая реализация — по text.length, а не по codePointAt)
// может остановиться МЕЖДУ высоким и низким суррогатом — на проводе (после
// кодирования в UTF-8, ровно то, что уйдёт клиенту по сети) одинокий
// суррогат превращается в символ замены. Живой репро именно этого сценария —
// limit=11, три ракеты — воспроизведён в task-4-report.md: старый алгоритм
// давал [U+DE80(одинокий) U+1F680 U+1F680], wire_has_FFFD=true.
test('обрезка не разрывает суррогатную пару эмодзи пополам', () => {
  const b = createOutputBuffer({ maxBytes: 11 });
  b.push('T1', '\u{1F680}\u{1F680}\u{1F680}'); // три ракеты, по 4 байта UTF-8 / 2 code unit каждая
  const out = b.get('T1');
  // Проверяем то же, чем это ловит ревью: как строка ляжет НА ПРОВОД. Node
  // кодирует одинокий суррогат в UTF-8 как U+FFFD (замена) — если резка
  // разорвала пару, это всплывёт именно здесь, а не в JS-строке напрямую.
  const wire = Buffer.from(out, 'utf8').toString('utf8');
  assert.ok(!wire.includes('�'), `на проводе битый символ: ${JSON.stringify(out)}`);
});

// Мелочь ревью («нет теста на длинный поток: все восемь работают с пределом
// 5-1024 байта, ни один не упал бы на Critical 1») — страж от повторного
// скатывания в O(n²): реалистичная смесь ASCII + рамок TUI + кириллицы,
// сотни push поверх уже заполненного буфера. Щедрый бюджет (2 с на этой
// машине новый алгоритм укладывается в ~100 мс — см. task-4-report.md);
// смысл не в точной цифре, а в том, чтобы квадратичный регресс всегда падал
// здесь, а не только всплывал в ручном бенчмарке ревью.
test('поток из сотен разнородных записей не проваливается в O(n²) (страж от Critical 1)', () => {
  const b = createOutputBuffer({ maxBytes: 256 * 1024 });
  const frame = '─'.repeat(40) + '│';
  const chunk = 'Running task... [====>    ] 42% '.repeat(3) + frame + 'русский текст статуса выполнения задачи ';
  const t0 = Date.now();
  for (let i = 0; i < 256; i++) b.push('T1', chunk);
  const elapsedMs = Date.now() - t0;
  assert.ok(elapsedMs < 2000, `256 push заняли ${elapsedMs} мс — похоже на регресс в O(n²)`);
  assert.ok(b.size('T1') <= 256 * 1024);
});
