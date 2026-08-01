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

test('parseCustomTitle: чужой sessionId пропускается (страховка на случай чужих записей в файле)', () => {
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

// Собирает транскрипт РОВНО заданного размера: ai-title в начале,
// наполнитель, custom-title, а после него — ещё `tailGap` байт обычных
// записей. tailGap здесь не мелочь, а суть: в живом транскрипте `/rename`
// почти никогда не последняя строка, после него работа продолжается. Пока
// фикстура клала запись впритык к концу файла, она не ловила НИ дыру
// просмотра (запись всегда попадала в хвост любого размера), НИ откат
// SUFFIX_BYTES — оба бага проходили её зелёными.
function makeTranscript(sizeBytes, { customTitles = ['МОЁ ИМЯ'], tailGap = 0 } = {}) {
  const dir = fsReal.mkdtempSync(pathReal.join(os.tmpdir(), 'cockpit-title-'));
  const file = pathReal.join(dir, 'S1.jsonl');
  const head = `{"type":"ai-title","aiTitle":"Автозаголовок Claude","sessionId":"S1"}\n`;
  const tails = customTitles
    .map((t) => `{"type":"custom-title","customTitle":${JSON.stringify(t)},"sessionId":"S1"}\n`);
  const filler = (n) => `{"type":"user","message":{"role":"user","content":"${'x'.repeat(n)}"}}\n`;
  const line = filler(200);
  const lineBytes = Buffer.byteLength(line);

  const parts = [head];
  let written = Buffer.byteLength(head) + Buffer.byteLength(tails.join('')) + tailGap;
  while (written + lineBytes <= sizeBytes) { parts.push(line); written += lineBytes; }
  // Ранние копии — в середину (переиздание на чекпоинтах), последняя — за
  // tailGap байт до конца файла.
  if (tails.length > 1) {
    parts.splice(Math.floor(parts.length / 2), 0, ...tails.slice(0, -1));
  }
  parts.push(tails[tails.length - 1] || '');
  let rest = tailGap;
  while (rest >= lineBytes) { parts.push(line); rest -= lineBytes; }
  // Добиваем до ТОЧНОГО размера — границы вроде 262145 иначе не проверить.
  const short = sizeBytes - Buffer.byteLength(parts.join(''));
  if (short >= lineBytes) {
    parts.push(filler(200 + short - lineBytes));
  } else if (short > 0) {
    parts.push(`${'#'.repeat(short - 1)}\n`); // хвостовой мусор: парсер его пропустит
  }
  fsReal.writeFileSync(file, parts.join(''));
  return { file, dir, size: fsReal.statSync(file).size };
}

// Границы задаёт геометрия чтения: 262144 — край префикса, 524288 — предел
// непрерывности двух кусков. Ровно на них менялось поведение в обоих
// провалившихся раундах, поэтому проверяются они и их соседи ±1 байт.
const SIZES = [
  ['короткий (10 КБ) — весь файл в префиксе', 10 * 1024, 0],
  ['ровно край префикса, 262144', 262144, 8 * 1024],
  ['край префикса + 1 байт, 262145', 262145, 8 * 1024],
  ['270 КБ, /rename в 8 КБ от конца', 270 * 1024, 8 * 1024],
  ['400 КБ, /rename в 60 КБ от конца', 400 * 1024, 60 * 1024],
  ['ровно предел непрерывности, 524288', 524288, 100 * 1024],
  ['предел непрерывности + 1 байт, 524289', 524289, 100 * 1024],
  ['1 МБ, /rename в 100 КБ от конца — уже два раздельных куска', 1024 * 1024, 100 * 1024],
];

for (const [label, size, tailGap] of SIZES) {
  test(`createFsReadParts: /rename найден в файле «${label}»`, async () => {
    const { file, dir, size: real } = makeTranscript(size, { tailGap });
    try {
      assert.strictEqual(real, size, 'фикстура обязана дать ТОЧНЫЙ размер — проверяются границы');
      const reader = createSessionTitleReader({ readParts: createFsReadParts(fsReal) });
      assert.strictEqual(await reader.read(file, 'S1'), 'МОЁ ИМЯ');
    } finally {
      fsReal.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('createFsReadParts: хвоста 256 КБ хватает на интервал переиздания /rename (сторож SUFFIX_BYTES)', async () => {
  // Именно этот замер сделал 64 КБ негодными: custom-title переиздаётся на
  // чекпоинтах с интервалом до 89 640 байт, значит последняя копия может
  // отстоять от конца файла дальше, чем короткий хвост. Файл берём заведомо
  // длиннее предела непрерывности, чтобы работал именно хвост, а не
  // полное чтение. При откате SUFFIX_BYTES на 64 КБ тест краснеет.
  const { file, dir } = makeTranscript(1024 * 1024, { tailGap: 100 * 1024 });
  try {
    const reader = createSessionTitleReader({ readParts: createFsReadParts(fsReal) });
    assert.strictEqual(await reader.read(file, 'S1'), 'МОЁ ИМЯ');
  } finally {
    fsReal.rmSync(dir, { recursive: true, force: true });
  }
});

test('createFsReadParts: ДВА переименования — берётся СВЕЖЕЕ имя, не старое', async () => {
  // Ранняя копия записи лежит в префиксе, свежая — дальше по файлу. Пока
  // просмотр префикса был единственным путём, вкладка уверенно показывала
  // бы старое имя.
  const { file, dir } = makeTranscript(300 * 1024, {
    customTitles: ['СТАРОЕ ИМЯ', 'СВЕЖЕЕ ИМЯ'], tailGap: 8 * 1024,
  });
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
