'use strict';
// Чистое ядро «названия» сессии (session-title.js): два источника в
// транскрипте — custom-title (`/rename`, приоритетный, лежит в КОНЦЕ файла,
// берётся ПОСЛЕДНИЙ) и ai-title (автозаголовок, лежит в НАЧАЛЕ, берётся
// ПЕРВЫЙ). Обоснование выбора источников и мест чтения — в шапке модуля.

const test = require('node:test');
const assert = require('node:assert');
const {
  createSessionTitleReader, createFsReadParts,
  parseAiTitle, parseCustomTitle, truncateTitle, TITLE_MAX,
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

// ---------------- createFsReadParts: чтение НАСТОЯЩЕГО файла ----------------
// Critical 1 (ревью): именно здесь пряталась дыра «мёртвого окна» размеров —
// у файлов чуть длиннее префикса хвост не читался вовсе, а префикс их не
// покрывал, и байты между ними не читал НИКТО. `/rename` в этой полосе
// терялся, а при двух переименованиях показывалось СТАРОЕ имя. Раньше эта
// функция жила в ipc.js и была недостижима для тестов — теперь она здесь.

const fsReal = require('fs');
const os = require('os');
const pathReal = require('path');

// Собирает транскрипт нужного размера: ai-title в начале, наполнитель,
// custom-title в самом конце — ровно как настоящий файл после `/rename`.
function makeTranscript(sizeBytes, { customTitles = ['МОЁ ИМЯ'] } = {}) {
  const dir = fsReal.mkdtempSync(pathReal.join(os.tmpdir(), 'cockpit-title-'));
  const file = pathReal.join(dir, 'S1.jsonl');
  const head = `{"type":"ai-title","aiTitle":"Автозаголовок Claude","sessionId":"S1"}\n`;
  const tails = customTitles
    .map((t) => `{"type":"custom-title","customTitle":${JSON.stringify(t)},"sessionId":"S1"}\n`);
  const tailBytes = Buffer.byteLength(tails.join(''));
  const fillerLine = `{"type":"user","message":{"role":"user","content":"${'x'.repeat(200)}"}}\n`;
  const parts = [head];
  let written = Buffer.byteLength(head) + tailBytes;
  while (written + Buffer.byteLength(fillerLine) <= sizeBytes) {
    parts.push(fillerLine);
    written += Buffer.byteLength(fillerLine);
  }
  // Первый custom-title кладём в середину (имитируя переиздание на чекпоинте),
  // последний — в конец файла.
  if (tails.length > 1) {
    parts.splice(Math.floor(parts.length / 2), 0, tails[0]);
    parts.push(...tails.slice(1));
  } else {
    parts.push(...tails);
  }
  fsReal.writeFileSync(file, parts.join(''));
  return { file, dir, size: fsReal.statSync(file).size };
}

const SIZES = [
  ['короткий (10 КБ) — весь файл в префиксе', 10 * 1024],
  ['ровно префикс (256 КБ)', 256 * 1024],
  ['префикс + 1 КБ — начало мёртвого окна', 257 * 1024],
  ['300 КБ — середина мёртвого окна', 300 * 1024],
  ['320 КБ — конец мёртвого окна', 320 * 1024],
  ['321 КБ — за окном', 321 * 1024],
  ['600 КБ — обычный длинный', 600 * 1024],
];

for (const [label, size] of SIZES) {
  test(`createFsReadParts: /rename найден в файле «${label}»`, async () => {
    const { file, dir } = makeTranscript(size);
    try {
      const reader = createSessionTitleReader({ readParts: createFsReadParts(fsReal) });
      assert.strictEqual(await reader.read(file, 'S1'), 'МОЁ ИМЯ');
    } finally {
      fsReal.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('createFsReadParts: ДВА переименования в мёртвом окне — берётся СВЕЖЕЕ имя, не старое', async () => {
  // Худший случай ревью: ранняя копия записи лежит в префиксе, свежая — в
  // той самой дыре. Без фикса вкладка уверенно показывала бы старое имя.
  const { file, dir } = makeTranscript(300 * 1024, { customTitles: ['СТАРОЕ ИМЯ', 'СВЕЖЕЕ ИМЯ'] });
  try {
    const reader = createSessionTitleReader({ readParts: createFsReadParts(fsReal) });
    assert.strictEqual(await reader.read(file, 'S1'), 'СВЕЖЕЕ ИМЯ');
  } finally {
    fsReal.rmSync(dir, { recursive: true, force: true });
  }
});

test('createFsReadParts: нет /rename — берётся автозаголовок из начала файла', async () => {
  const { file, dir } = makeTranscript(300 * 1024, { customTitles: [] });
  try {
    const reader = createSessionTitleReader({ readParts: createFsReadParts(fsReal) });
    assert.strictEqual(await reader.read(file, 'S1'), 'Автозаголовок Claude');
  } finally {
    fsReal.rmSync(dir, { recursive: true, force: true });
  }
});

test('createFsReadParts: несуществующий файл — пусто, наружу не бросает', async () => {
  const reader = createSessionTitleReader({ readParts: createFsReadParts(fsReal) });
  assert.strictEqual(await reader.read(pathReal.join(os.tmpdir(), 'нет-такого-файла.jsonl'), 'S1'), '');
});

test('createFsReadParts: каталог вместо файла — пусто, не бросает', async () => {
  const reader = createSessionTitleReader({ readParts: createFsReadParts(fsReal) });
  assert.strictEqual(await reader.read(os.tmpdir(), 'S1'), '');
});

test('parseAiTitle: пустой aiTitle не считается заголовком', () => {
  const empty = '{"type":"ai-title","aiTitle":"","sessionId":"S1"}';
  assert.strictEqual(parseAiTitle([empty, USER_LINE, ''].join('\n')), '');
});
