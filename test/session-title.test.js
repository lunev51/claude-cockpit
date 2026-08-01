'use strict';
// Чистое ядро «названия» сессии (session-title.js): парс записи ai-title из
// префикса транскрипта. Живая приёмка 01.08 — см. шапку модуля, там же
// обоснование, почему источник именно ai-title, а не session_title из хука,
// и почему читается только префикс файла.

const test = require('node:test');
const assert = require('node:assert');
const {
  createSessionTitleReader, parseAiTitle, truncateTitle, TITLE_MAX,
} = require('../src/main/session-title');

const AI_TITLE_LINE = '{"type":"ai-title","aiTitle":"Организовать папку Акто","sessionId":"S1"}';
const USER_LINE = '{"type":"user","message":{"role":"user","content":"привет"}}';

test('parseAiTitle: находит ai-title среди обычных записей', () => {
  const text = [USER_LINE, AI_TITLE_LINE, USER_LINE, ''].join('\n');
  assert.strictEqual(parseAiTitle(text), 'Организовать папку Акто');
});

test('parseAiTitle: берёт ПЕРВОЕ вхождение (заголовок дублируется на чекпоинтах — 557 раз на реальных данных)', () => {
  const second = '{"type":"ai-title","aiTitle":"Другой заголовок","sessionId":"S1"}';
  const text = [USER_LINE, AI_TITLE_LINE, second, ''].join('\n');
  assert.strictEqual(parseAiTitle(text), 'Организовать папку Акто');
});

test('parseAiTitle: нет записи ai-title — пустая строка, а не исключение', () => {
  assert.strictEqual(parseAiTitle([USER_LINE, USER_LINE, ''].join('\n')), '');
});

test('parseAiTitle: битая/обрезанная строка пропускается, валидная дальше — находится', () => {
  const broken = '{"type":"ai-title","aiTitle":"обрез';
  const text = [broken, AI_TITLE_LINE, ''].join('\n');
  assert.strictEqual(parseAiTitle(text), 'Организовать папку Акто');
});

test('parseAiTitle: ПОСЛЕДНЯЯ строка префикса игнорируется — она обрезана серединой файла', () => {
  // Единственная запись — последняя строка без завершающего \n: доверять ей
  // нельзя, JSON мог оборваться ровно на границе прочитанного префикса.
  assert.strictEqual(parseAiTitle(AI_TITLE_LINE), '');
});

test('parseAiTitle: пустой aiTitle не считается заголовком', () => {
  const empty = '{"type":"ai-title","aiTitle":"","sessionId":"S1"}';
  assert.strictEqual(parseAiTitle([empty, USER_LINE, ''].join('\n')), '');
});

test('parseAiTitle: мусор на входе не роняет', () => {
  assert.strictEqual(parseAiTitle(null), '');
  assert.strictEqual(parseAiTitle(''), '');
  assert.strictEqual(parseAiTitle(42), '');
});

test('truncateTitle: схлопывает пробелы и режет длинное многоточием', () => {
  assert.strictEqual(truncateTitle('  две   строки\nв одну  '), 'две строки в одну');
  const long = truncateTitle('я'.repeat(200));
  assert.strictEqual(long.length, TITLE_MAX);
  assert.ok(long.endsWith('…'));
});

test('read: отдаёт заголовок и запрашивает ровно ограниченный префикс', async () => {
  const calls = [];
  const reader = createSessionTitleReader({
    readPrefix: (p, max) => { calls.push({ p, max }); return Promise.resolve([AI_TITLE_LINE, ''].join('\n')); },
    prefixBytes: 1234,
  });

  assert.strictEqual(await reader.read('C:\\t\\S1.jsonl'), 'Организовать папку Акто');
  assert.deepStrictEqual(calls, [{ p: 'C:\\t\\S1.jsonl', max: 1234 }]);
});

test('read: сбой чтения — пустая строка, наружу не бросает', async () => {
  const reader = createSessionTitleReader({ readPrefix: () => Promise.reject(new Error('ENOENT')) });
  assert.strictEqual(await reader.read('C:\\нет.jsonl'), '');
});

test('read: пустой/невалидный путь не приводит к чтению вовсе', async () => {
  let reads = 0;
  const reader = createSessionTitleReader({ readPrefix: () => { reads += 1; return Promise.resolve(''); } });

  assert.strictEqual(await reader.read(''), '');
  assert.strictEqual(await reader.read(null), '');
  assert.strictEqual(await reader.read(undefined), '');
  assert.strictEqual(reads, 0);
});
