'use strict';
// Чистое ядро «названия» сессии (session-title.js): два источника в
// транскрипте — custom-title (`/rename`, приоритетный, лежит в КОНЦЕ файла,
// берётся ПОСЛЕДНИЙ) и ai-title (автозаголовок, лежит в НАЧАЛЕ, берётся
// ПЕРВЫЙ). Обоснование выбора источников и мест чтения — в шапке модуля.

const test = require('node:test');
const assert = require('node:assert');
const {
  createSessionTitleReader, parseAiTitle, parseCustomTitle, truncateTitle, TITLE_MAX,
} = require('../src/main/session-title');

const AI_LINE = '{"type":"ai-title","aiTitle":"Организовать папку Акто","sessionId":"S1"}';
const CUSTOM_LINE = '{"type":"custom-title","customTitle":"RZ paper","sessionId":"S1"}';
const USER_LINE = '{"type":"user","message":{"role":"user","content":"привет"}}';

// ---------------- ai-title (начало файла) ----------------

test('parseAiTitle: находит ai-title среди обычных записей', () => {
  assert.strictEqual(parseAiTitle([USER_LINE, AI_LINE, USER_LINE, ''].join('\n')), 'Организовать папку Акто');
});

test('parseAiTitle: берёт ПЕРВОЕ вхождение (заголовок дублируется на чекпоинтах сотнями записей)', () => {
  const second = '{"type":"ai-title","aiTitle":"Другой заголовок","sessionId":"S1"}';
  assert.strictEqual(parseAiTitle([USER_LINE, AI_LINE, second, ''].join('\n')), 'Организовать папку Акто');
});

test('parseAiTitle: ПОСЛЕДНЯЯ строка куска игнорируется — она обрезана границей чтения', () => {
  assert.strictEqual(parseAiTitle(AI_LINE), '');
});

test('parseAiTitle: битая строка пропускается, валидная дальше — находится', () => {
  const broken = '{"type":"ai-title","aiTitle":"обрез';
  assert.strictEqual(parseAiTitle([broken, AI_LINE, ''].join('\n')), 'Организовать папку Акто');
});

test('parseAiTitle: мусор на входе не роняет', () => {
  assert.strictEqual(parseAiTitle(null), '');
  assert.strictEqual(parseAiTitle(''), '');
  assert.strictEqual(parseAiTitle(42), '');
});

// ---------------- custom-title (конец файла) ----------------

test('parseCustomTitle: берёт ПОСЛЕДНЕЕ вхождение — переименовать можно несколько раз', () => {
  const first = '{"type":"custom-title","customTitle":"fix-trailing-space","sessionId":"S1"}';
  const text = ['', first, USER_LINE, CUSTOM_LINE].join('\n');
  assert.strictEqual(parseCustomTitle(text), 'RZ paper');
});

test('parseCustomTitle: ПЕРВАЯ строка куска игнорируется — обрезана границей чтения', () => {
  // Единственная запись пришла первой строкой хвоста: доверять нельзя.
  assert.strictEqual(parseCustomTitle(CUSTOM_LINE), '');
});

test('parseCustomTitle: нет записи — пустая строка', () => {
  assert.strictEqual(parseCustomTitle(['', USER_LINE, USER_LINE].join('\n')), '');
});

test('parseCustomTitle: чужой sessionId пропускается (после --resume/fork в файле бывают чужие записи)', () => {
  const alien = '{"type":"custom-title","customTitle":"ЧУЖОЕ ИМЯ","sessionId":"OTHER"}';
  assert.strictEqual(parseCustomTitle(['', alien].join('\n'), 'S1'), '');
  assert.strictEqual(parseCustomTitle(['', CUSTOM_LINE].join('\n'), 'S1'), 'RZ paper');
});

test('parseCustomTitle: запись без sessionId принимается (старый формат)', () => {
  const noSid = '{"type":"custom-title","customTitle":"Без sid"}';
  assert.strictEqual(parseCustomTitle(['', noSid].join('\n'), 'S1'), 'Без sid');
});

// ---------------- приоритет и чтение ----------------

test('read: custom-title из ХВОСТА побеждает ai-title из начала (запрос пользователя)', async () => {
  const reader = createSessionTitleReader({
    readParts: () => Promise.resolve({
      prefix: [USER_LINE, AI_LINE, ''].join('\n'),
      suffix: ['', CUSTOM_LINE].join('\n'),
    }),
  });
  assert.strictEqual(await reader.read('C:\\t\\S1.jsonl', 'S1'), 'RZ paper');
});

test('read: нет своего имени — берётся автозаголовок Claude', async () => {
  const reader = createSessionTitleReader({
    readParts: () => Promise.resolve({
      prefix: [USER_LINE, AI_LINE, ''].join('\n'),
      suffix: ['', USER_LINE].join('\n'),
    }),
  });
  assert.strictEqual(await reader.read('C:\\t\\S1.jsonl', 'S1'), 'Организовать папку Акто');
});

test('read: короткий файл (хвост пуст) — custom-title ищется в префиксе', async () => {
  // Реализация вправе вернуть весь короткий файл в prefix и пустой suffix.
  const reader = createSessionTitleReader({
    readParts: () => Promise.resolve({
      prefix: [USER_LINE, AI_LINE, CUSTOM_LINE, ''].join('\n'),
      suffix: '',
    }),
  });
  assert.strictEqual(await reader.read('C:\\t\\S1.jsonl', 'S1'), 'RZ paper');
});

test('read: запрашивает оба куска с заданными размерами', async () => {
  const calls = [];
  const reader = createSessionTitleReader({
    readParts: (p, pre, suf) => { calls.push({ p, pre, suf }); return Promise.resolve({ prefix: '', suffix: '' }); },
    prefixBytes: 1111,
    suffixBytes: 222,
  });
  await reader.read('C:\\t\\S1.jsonl', 'S1');
  assert.deepStrictEqual(calls, [{ p: 'C:\\t\\S1.jsonl', pre: 1111, suf: 222 }]);
});

test('read: сбой чтения — пустая строка, наружу не бросает', async () => {
  const reader = createSessionTitleReader({ readParts: () => Promise.reject(new Error('ENOENT')) });
  assert.strictEqual(await reader.read('C:\\нет.jsonl', 'S1'), '');
});

test('read: пустой/невалидный путь не приводит к чтению вовсе', async () => {
  let reads = 0;
  const reader = createSessionTitleReader({
    readParts: () => { reads += 1; return Promise.resolve({ prefix: '', suffix: '' }); },
  });
  assert.strictEqual(await reader.read(''), '');
  assert.strictEqual(await reader.read(null), '');
  assert.strictEqual(reads, 0);
});

test('truncateTitle: схлопывает пробелы и режет длинное многоточием', () => {
  assert.strictEqual(truncateTitle('  две   строки\nв одну  '), 'две строки в одну');
  const long = truncateTitle('я'.repeat(200));
  assert.strictEqual(long.length, TITLE_MAX);
  assert.ok(long.endsWith('…'));
});
