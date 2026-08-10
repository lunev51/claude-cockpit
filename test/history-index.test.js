'use strict';
// history-index.js — индекс и поиск по транскриптам сессий (Phase 7, Task 2).
// Модуль под тестом ЧИСТЫЙ (никакого fs/electron внутри) — весь ввод-вывод
// инжектируется. Здесь, В ТЕСТЕ, мы свободно используем настоящие fs/os/path
// и настоящий readline, чтобы фикстуры на диске реалистично проверяли
// потоковое чтение (readFileLines — асинхронный генератор, см. бриф).
//
// Форма фикстур синтетическая, но повторяет РЕАЛЬНЫЙ формат транскриптов
// Claude Code (снято живьём на этой машине 28.07.2026, см. task-2-report.md
// за урезанными образцами): шумовые строки ({"type":"mode",...},
// {"type":"queue-operation",...}), запись пользователя
// ({"type":"user","message":{"role":"user","content":"текст"|[...]},
// "cwd":"C:\\...",...}), запись ассистента
// ({"type":"assistant","message":{"role":"assistant","content":[{"type":
// "text","text":"..."},{"type":"tool_use",...}]}}) и "user"-запись, которая
// на деле — tool_result (массив блоков без текста), а не текст человека.
// Тексты в фикстурах — не реальные пользовательские данные, а синтетика.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { createHistoryIndex } = require('../src/main/history-index');

// ---- фикстуры на диске ------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'history-index-test-'));
}

function rmDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// Пишет один транскрипт-файл <projectDir>/<sessionId>.jsonl из массива
// готовых JSON-строк (каждый элемент — либо строка (уже сериализованная,
// в т.ч. намеренно битая), либо объект (будет сериализован сам)).
function writeSession(projectAbsDir, sessionId, records) {
  fs.mkdirSync(projectAbsDir, { recursive: true });
  const lines = records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r)));
  const file = path.join(projectAbsDir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return file;
}

function userLine({ sessionId, cwd, text, timestamp = '2026-07-28T10:00:00.000Z' }) {
  return {
    parentUuid: null,
    isSidechain: false,
    promptId: 'p-' + sessionId,
    type: 'user',
    message: { role: 'user', content: text },
    uuid: 'u-' + sessionId,
    timestamp,
    cwd,
    sessionId,
    version: '2.1.191',
    gitBranch: 'main',
  };
}

function userToolResultLine({ sessionId, cwd }) {
  // Реальная форма: "user"-запись, чьё содержимое — РЕЗУЛЬТАТ инструмента,
  // а не текст человека (см. отчёт: реально встречается в транскриптах).
  return {
    parentUuid: 'x',
    isSidechain: false,
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'tool_reference', tool_name: 'X' }] }],
    },
    uuid: 'ur-' + sessionId,
    cwd,
    sessionId,
  };
}

function assistantLine({ sessionId, text }) {
  return {
    parentUuid: 'a',
    isSidechain: false,
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text },
        { type: 'tool_use', id: 'toolu_2', name: 'Read', input: { file_path: 'x.js' } },
      ],
    },
    uuid: 'as-' + sessionId,
    sessionId,
  };
}

function noiseLines(sessionId) {
  return [
    { type: 'mode', mode: 'normal', sessionId },
    { type: 'permission-mode', permissionMode: 'bypassPermissions', sessionId },
  ];
}

// Реальные зависимости, но нацеленные на tmpDir — listProjects обходит
// tmpDir/*/*.jsonl (один уровень проектов, как в %USERPROFILE%\.claude\projects).
function realListProjects(tmpDir) {
  return async () => {
    const out = [];
    let projectDirs;
    try {
      projectDirs = await fs.promises.readdir(tmpDir, { withFileTypes: true });
    } catch {
      return [];
    }
    for (const pd of projectDirs) {
      if (!pd.isDirectory()) continue;
      const projectDir = pd.name;
      const abs = path.join(tmpDir, projectDir);
      let files;
      try {
        files = await fs.promises.readdir(abs);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        out.push({ projectDir, sessionId: f.slice(0, -'.jsonl'.length), filePath: path.join(abs, f) });
      }
    }
    return out;
  };
}

async function realStat(filePath) {
  const st = await fs.promises.stat(filePath);
  return { mtimeMs: st.mtimeMs, size: st.size };
}

// Настоящий потоковый читатель строк (async generator) — readline поверх
// fs.createReadStream, ровно как рекомендовано в брифе для «живой проверки».
async function* realReadFileLines(filePath) {
  const rl = readline.createInterface({ input: fs.createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) yield line;
}

function memoryCache(initial = null) {
  let stored = initial;
  const writes = [];
  return {
    read: () => stored,
    write: (v) => {
      stored = v;
      writes.push(v);
    },
    writes,
    peek: () => stored,
  };
}

function realDeps(tmpDir, overrides = {}) {
  return {
    listProjects: overrides.listProjects || realListProjects(tmpDir),
    stat: overrides.stat || realStat,
    readFileLines: overrides.readFileLines || realReadFileLines,
    cache: overrides.cache || memoryCache(),
    now: overrides.now || (() => 1000),
  };
}

// ---- тесты -------------------------------------------------------------

test('refresh(): строит лёгкий индекс по фикстурам на диске — {sessionId, projectDir, cwd, mtime, size, firstUserText}', async (t) => {
  const tmp = makeTmpDir();
  t.after(() => rmDir(tmp));
  const dirA = path.join(tmp, 'C--Users-Lunev-helper');
  writeSession(dirA, 'sess-1', [
    ...noiseLines('sess-1'),
    userLine({ sessionId: 'sess-1', cwd: 'C:\\Users\\Lunev\\helper', text: 'первый вопрос про кокпит' }),
    assistantLine({ sessionId: 'sess-1', text: 'ответ ассистента' }),
  ]);

  const deps = realDeps(tmp);
  const idx = createHistoryIndex(deps);
  const entries = await idx.refresh({ force: true });

  assert.strictEqual(entries.length, 1);
  const e = entries[0];
  assert.strictEqual(e.sessionId, 'sess-1');
  assert.strictEqual(e.projectDir, 'C--Users-Lunev-helper');
  assert.strictEqual(e.cwd, 'C:\\Users\\Lunev\\helper');
  assert.strictEqual(e.firstUserText, 'первый вопрос про кокпит');
  assert.strictEqual(typeof e.mtime, 'number');
  assert.strictEqual(typeof e.size, 'number');
  assert.ok(e.size > 0);
  // Ровно эти 6 полей — filePath и прочая внутренняя механика наружу не течёт.
  assert.deepStrictEqual(Object.keys(e).sort(), ['cwd', 'firstUserText', 'mtime', 'projectDir', 'sessionId', 'size'].sort());
});

test('refresh(): firstUserText обрезается до 200 символов', async (t) => {
  const tmp = makeTmpDir();
  t.after(() => rmDir(tmp));
  const dirA = path.join(tmp, 'proj');
  const longText = 'а'.repeat(250);
  writeSession(dirA, 'sess-long', [
    userLine({ sessionId: 'sess-long', cwd: 'C:\\proj', text: longText }),
  ]);

  const idx = createHistoryIndex(realDeps(tmp));
  const entries = await idx.refresh({ force: true });

  assert.strictEqual(entries[0].firstUserText.length, 200);
  assert.strictEqual(entries[0].firstUserText, longText.slice(0, 200));
});

test('refresh(): tool_result-«user»-запись без текста не считается первым сообщением — берём следующую реальную', async (t) => {
  const tmp = makeTmpDir();
  t.after(() => rmDir(tmp));
  const dirA = path.join(tmp, 'proj');
  writeSession(dirA, 'sess-2', [
    userToolResultLine({ sessionId: 'sess-2', cwd: 'C:\\proj' }),
    userLine({ sessionId: 'sess-2', cwd: 'C:\\proj', text: 'реальный первый текст' }),
  ]);

  const idx = createHistoryIndex(realDeps(tmp));
  const entries = await idx.refresh({ force: true });

  assert.strictEqual(entries[0].firstUserText, 'реальный первый текст');
  assert.strictEqual(entries[0].cwd, 'C:\\proj'); // cwd можно взять и из tool_result-записи
});

test('refresh(): битая строка JSONL не ломает разбор остального файла', async (t) => {
  const tmp = makeTmpDir();
  t.after(() => rmDir(tmp));
  const dirA = path.join(tmp, 'proj');
  writeSession(dirA, 'sess-3', [
    '{this is not valid json,,,',
    userLine({ sessionId: 'sess-3', cwd: 'C:\\proj', text: 'после битой строки всё ок' }),
  ]);

  const idx = createHistoryIndex(realDeps(tmp));
  const entries = await idx.refresh({ force: true });

  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].firstUserText, 'после битой строки всё ок');
});

test('refresh(): сессия без единого текстового user-сообщения → firstUserText="" , cwd=null, но запись в индексе есть', async (t) => {
  const tmp = makeTmpDir();
  t.after(() => rmDir(tmp));
  const dirA = path.join(tmp, 'proj');
  writeSession(dirA, 'sess-4', [
    ...noiseLines('sess-4'),
    userToolResultLine({ sessionId: 'sess-4', cwd: undefined }),
  ]);
  // выше cwd специально не задан у единственной записи — переопределим руками без cwd:
  fs.writeFileSync(
    path.join(dirA, 'sess-4.jsonl'),
    [JSON.stringify({ type: 'mode', mode: 'normal', sessionId: 'sess-4' })].join('\n') + '\n',
    'utf8',
  );

  const idx = createHistoryIndex(realDeps(tmp));
  const entries = await idx.refresh({ force: true });

  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].firstUserText, '');
  assert.strictEqual(entries[0].cwd, null);
});

test('Инкрементальность: файл с неизменившимися mtime+size не перечитывается', async (t) => {
  const tmp = makeTmpDir();
  t.after(() => rmDir(tmp));
  const dirA = path.join(tmp, 'proj');
  const fileA = writeSession(dirA, 'sess-A', [userLine({ sessionId: 'sess-A', cwd: 'C:\\proj', text: 'файл A' })]);
  const fileB = writeSession(dirA, 'sess-B', [userLine({ sessionId: 'sess-B', cwd: 'C:\\proj', text: 'файл B' })]);

  const reads = [];
  const wrapReadFileLines = async function* (fp) {
    reads.push(fp);
    yield* realReadFileLines(fp);
  };

  const idx = createHistoryIndex(realDeps(tmp, { readFileLines: wrapReadFileLines }));
  await idx.refresh({ force: true });
  assert.strictEqual(reads.filter((r) => r === fileA).length, 1);
  assert.strictEqual(reads.filter((r) => r === fileB).length, 1);

  reads.length = 0;
  // Второй refresh без изменений на диске — НИ ОДИН файл не должен перечитываться.
  const entries2 = await idx.refresh({});
  assert.deepStrictEqual(reads, []);
  assert.strictEqual(entries2.length, 2);
  assert.strictEqual(entries2.find((e) => e.sessionId === 'sess-A').firstUserText, 'файл A');
});

test('Инкрементальность: изменённый (mtime+size другие) файл ПЕРЕЧИТЫВАЕТСЯ, неизменённый — нет', async (t) => {
  const tmp = makeTmpDir();
  t.after(() => rmDir(tmp));
  const dirA = path.join(tmp, 'proj');
  const fileA = writeSession(dirA, 'sess-A', [userLine({ sessionId: 'sess-A', cwd: 'C:\\proj', text: 'A v1' })]);
  const fileB = writeSession(dirA, 'sess-B', [userLine({ sessionId: 'sess-B', cwd: 'C:\\proj', text: 'B v1' })]);

  const reads = [];
  const wrapReadFileLines = async function* (fp) {
    reads.push(fp);
    yield* realReadFileLines(fp);
  };
  const idx = createHistoryIndex(realDeps(tmp, { readFileLines: wrapReadFileLines }));
  await idx.refresh({});

  // Меняем ТОЛЬКО файл B (новый контент => другой size, и mtime сдвинется).
  await new Promise((r) => setTimeout(r, 10));
  fs.appendFileSync(fileB, JSON.stringify(userLine({ sessionId: 'sess-B', cwd: 'C:\\proj', text: 'B v1' })) + '\n', 'utf8');

  reads.length = 0;
  const entries2 = await idx.refresh({});
  assert.deepStrictEqual(reads, [fileB]);
  assert.strictEqual(entries2.find((e) => e.sessionId === 'sess-A').firstUserText, 'A v1');
  assert.strictEqual(entries2.find((e) => e.sessionId === 'sess-B').firstUserText, 'B v1');
});

test('force:true игнорирует кэш и перечитывает вообще все файлы', async (t) => {
  const tmp = makeTmpDir();
  t.after(() => rmDir(tmp));
  const dirA = path.join(tmp, 'proj');
  const fileA = writeSession(dirA, 'sess-A', [userLine({ sessionId: 'sess-A', cwd: 'C:\\proj', text: 'A' })]);

  const reads = [];
  const wrapReadFileLines = async function* (fp) {
    reads.push(fp);
    yield* realReadFileLines(fp);
  };
  const idx = createHistoryIndex(realDeps(tmp, { readFileLines: wrapReadFileLines }));
  await idx.refresh({});
  reads.length = 0;

  await idx.refresh({ force: true });
  assert.deepStrictEqual(reads, [fileA]);
});

test('Кэш другой версии схемы → полный пересбор (старые записи кэша игнорируются)', async (t) => {
  const tmp = makeTmpDir();
  t.after(() => rmDir(tmp));
  const dirA = path.join(tmp, 'proj');
  const fileA = writeSession(dirA, 'sess-A', [userLine({ sessionId: 'sess-A', cwd: 'C:\\proj', text: 'реальный текст' })]);

  const staleCache = memoryCache({
    schemaVersion: 999999, // заведомо другая версия схемы
    entries: [{ filePath: fileA, sessionId: 'sess-A', projectDir: 'proj', cwd: 'C:\\WRONG', mtime: 1, size: 1, firstUserText: 'ФЕЙК из старого кэша' }],
  });

  const reads = [];
  const wrapReadFileLines = async function* (fp) {
    reads.push(fp);
    yield* realReadFileLines(fp);
  };
  const idx = createHistoryIndex(realDeps(tmp, { readFileLines: wrapReadFileLines, cache: staleCache }));
  const entries = await idx.refresh({});

  assert.deepStrictEqual(reads, [fileA]); // не поверили кэшу битой версии — перечитали
  assert.strictEqual(entries[0].firstUserText, 'реальный текст');
  assert.strictEqual(entries[0].cwd, 'C:\\proj');
});

test('Устойчивость: исчезнувший файл (stat бросает) — пропускается, остальной индекс строится', async (t) => {
  const tmp = makeTmpDir();
  t.after(() => rmDir(tmp));
  const dirA = path.join(tmp, 'proj');
  writeSession(dirA, 'sess-ok', [userLine({ sessionId: 'sess-ok', cwd: 'C:\\proj', text: 'жив' })]);
  const goneFile = path.join(dirA, 'sess-gone.jsonl'); // на диске не существует вовсе

  const listProjects = async () => [
    { projectDir: 'proj', sessionId: 'sess-ok', filePath: path.join(dirA, 'sess-ok.jsonl') },
    { projectDir: 'proj', sessionId: 'sess-gone', filePath: goneFile },
  ];

  const idx = createHistoryIndex(realDeps(tmp, { listProjects }));
  const entries = await idx.refresh({ force: true });

  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].sessionId, 'sess-ok');
});

test('Устойчивость: readFileLines бросает во время чтения (файл исчез в процессе) — файл пропускается', async (t) => {
  const tmp = makeTmpDir();
  t.after(() => rmDir(tmp));
  const dirA = path.join(tmp, 'proj');
  writeSession(dirA, 'sess-ok', [userLine({ sessionId: 'sess-ok', cwd: 'C:\\proj', text: 'жив' })]);
  const badFile = writeSession(dirA, 'sess-bad', [userLine({ sessionId: 'sess-bad', cwd: 'C:\\proj', text: 'умрёт' })]);

  const readFileLines = async function* (fp) {
    if (fp === badFile) throw new Error('ENOENT: file vanished mid-read');
    yield* realReadFileLines(fp);
  };

  const idx = createHistoryIndex(realDeps(tmp, { readFileLines }));
  const entries = await idx.refresh({ force: true });

  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].sessionId, 'sess-ok');
});

test('Устойчивость: listProjects() бросает — refresh() не падает, отдаёт пустой (или прежний) индекс', async (t) => {
  const idx = createHistoryIndex({
    listProjects: async () => { throw new Error('boom'); },
    stat: async () => ({ mtimeMs: 1, size: 1 }),
    readFileLines: async function* () {},
    cache: memoryCache(),
    now: () => 1,
  });

  const entries = await idx.refresh({ force: true });
  assert.deepStrictEqual(entries, []);
});

test('Устойчивость: cache.write() бросает — refresh() всё равно возвращает свежепостроенный индекс', async (t) => {
  const tmp = makeTmpDir();
  t.after(() => rmDir(tmp));
  const dirA = path.join(tmp, 'proj');
  writeSession(dirA, 'sess-A', [userLine({ sessionId: 'sess-A', cwd: 'C:\\proj', text: 'ok' })]);

  const throwingCache = { read: () => null, write: () => { throw new Error('disk full'); } };
  const idx = createHistoryIndex(realDeps(tmp, { cache: throwingCache }));

  const entries = await idx.refresh({ force: true });
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].firstUserText, 'ok');
});

test('Устойчивость: cache.read() бросает — трактуется как «нет кэша», индекс строится с нуля', async (t) => {
  const tmp = makeTmpDir();
  t.after(() => rmDir(tmp));
  const dirA = path.join(tmp, 'proj');
  writeSession(dirA, 'sess-A', [userLine({ sessionId: 'sess-A', cwd: 'C:\\proj', text: 'ok' })]);

  const throwingReadCache = { read: () => { throw new Error('disk error'); }, write: () => {} };
  const idx = createHistoryIndex(realDeps(tmp, { cache: throwingReadCache }));

  const entries = await idx.refresh({});
  assert.strictEqual(entries.length, 1);
});

test('now() пробрасывается в персистентный кэш (builtAt в объекте, переданном cache.write)', async (t) => {
  const tmp = makeTmpDir();
  t.after(() => rmDir(tmp));
  const dirA = path.join(tmp, 'proj');
  writeSession(dirA, 'sess-A', [userLine({ sessionId: 'sess-A', cwd: 'C:\\proj', text: 'ok' })]);

  const cache = memoryCache();
  const idx = createHistoryIndex(realDeps(tmp, { cache, now: () => 424242 }));
  await idx.refresh({ force: true });

  assert.strictEqual(cache.writes.length, 1);
  assert.strictEqual(cache.writes[0].builtAt, 424242);
  assert.strictEqual(cache.writes[0].schemaVersion, cache.writes[0].schemaVersion); // просто проверяем наличие поля ниже
  assert.strictEqual(typeof cache.writes[0].schemaVersion, 'number');
});

// ---- search() -----------------------------------------------------------

async function buildTwoSessionIndex(tmp) {
  const dirA = path.join(tmp, 'proj');
  writeSession(dirA, 'sess-cockpit', [
    userLine({ sessionId: 'sess-cockpit', cwd: 'C:\\proj', text: 'обсуждаем историю и поиск в кокпите' }),
    assistantLine({ sessionId: 'sess-cockpit', text: 'да, добавим индекс транскриптов cockpit history search' }),
  ]);
  writeSession(dirA, 'sess-other', [
    userLine({ sessionId: 'sess-other', cwd: 'C:\\proj', text: 'вопрос про совсем другое — рецепты воркспейсов' }),
  ]);

  const idx = createHistoryIndex(realDeps(tmp));
  await idx.refresh({ force: true });
  return idx;
}

test('search(): пустой запрос → []', async (t) => {
  const tmp = makeTmpDir();
  t.after(() => rmDir(tmp));
  const idx = await buildTwoSessionIndex(tmp);

  assert.deepStrictEqual(await idx.search(''), []);
  assert.deepStrictEqual(await idx.search('   '), []);
  assert.deepStrictEqual(await idx.search(undefined), []);
  assert.deepStrictEqual(await idx.search(null), []);
});

test('search(): поиск по одному слову находит нужную сессию, регистронезависимо', async (t) => {
  const tmp = makeTmpDir();
  t.after(() => rmDir(tmp));
  const idx = await buildTwoSessionIndex(tmp);

  const res = await idx.search('КОКПИТЕ');
  assert.strictEqual(res.length, 1);
  assert.strictEqual(res[0].sessionId, 'sess-cockpit');
  assert.strictEqual(res[0].cwd, 'C:\\proj');
  assert.strictEqual(res[0].firstUserText, 'обсуждаем историю и поиск в кокпите');
  assert.strictEqual(typeof res[0].mtime, 'number');
  assert.strictEqual(typeof res[0].line, 'number');
  assert.ok(res[0].snippet.text.toLowerCase().includes('кокпите'));
});

test('search(): несколько слов — все должны встретиться в ОДНОЙ строке (иначе не матчит)', async (t) => {
  const tmp = makeTmpDir();
  t.after(() => rmDir(tmp));
  const idx = await buildTwoSessionIndex(tmp);

  // оба слова реально есть в assistant-строке этой сессии одновременно.
  const hit = await idx.search('cockpit history');
  assert.strictEqual(hit.length, 1);
  assert.strictEqual(hit[0].sessionId, 'sess-cockpit');

  // "кокпите" — в user-строке, "cockpit" — в assistant-строке; РАЗНЫЕ строки → не матчит.
  const miss = await idx.search('кокпите cockpit');
  assert.deepStrictEqual(miss, []);
});

test('search(): snippet.ranges — верные позиции совпадений в snippet.text', async (t) => {
  const tmp = makeTmpDir();
  t.after(() => rmDir(tmp));
  const dirA = path.join(tmp, 'proj');
  writeSession(dirA, 'sess-1', [
    userLine({ sessionId: 'sess-1', cwd: 'C:\\proj', text: 'найди слово алгоритм и слово структура в этом тексте' }),
  ]);
  const idx = createHistoryIndex(realDeps(tmp));
  await idx.refresh({ force: true });

  const res = await idx.search('алгоритм структура');
  assert.strictEqual(res.length, 1);
  const { text, ranges } = res[0].snippet;
  assert.ok(ranges.length >= 2, 'ожидали минимум по одному диапазону на каждое слово');
  for (const [s, e] of ranges) {
    const chunk = text.slice(s, e).toLowerCase();
    assert.ok(chunk === 'алгоритм' || chunk === 'структура', `диапазон [${s},${e}] дал "${chunk}", ожидали одно из слов запроса`);
  }
});

test('search(): лимит результатов ограничивает выдачу (limit параметр вызова)', async (t) => {
  const tmp = makeTmpDir();
  t.after(() => rmDir(tmp));
  const dirA = path.join(tmp, 'proj');
  for (let i = 0; i < 5; i++) {
    writeSession(dirA, `sess-${i}`, [userLine({ sessionId: `sess-${i}`, cwd: 'C:\\proj', text: `общее слово маркер номер ${i}` })]);
  }
  const idx = createHistoryIndex(realDeps(tmp));
  await idx.refresh({ force: true });

  const all = await idx.search('маркер');
  assert.strictEqual(all.length, 5);

  const limited = await idx.search('маркер', { limit: 2 });
  assert.strictEqual(limited.length, 2);
});

test('search(): лимит результатов по умолчанию — maxResults конструктора', async (t) => {
  const tmp = makeTmpDir();
  t.after(() => rmDir(tmp));
  const dirA = path.join(tmp, 'proj');
  for (let i = 0; i < 4; i++) {
    writeSession(dirA, `sess-${i}`, [userLine({ sessionId: `sess-${i}`, cwd: 'C:\\proj', text: `общее слово маркер номер ${i}` })]);
  }
  const idx = createHistoryIndex(realDeps(tmp, {}));
  const idxLimited = createHistoryIndex({ ...realDeps(tmp), maxResults: 2 });
  await idx.refresh({ force: true });
  await idxLimited.refresh({ force: true });

  const res = await idxLimited.search('маркер');
  assert.strictEqual(res.length, 2);
});

// === B10: поиск не читает всё хранилище и уступает более свежему запросу ===
//
// Кэш хранит только firstUserText, поэтому КАЖДЫЙ поиск заново стримит
// транскрипты с диска. Остановов было ровно два: набралось maxResults
// попаданий или кончились файлы. Запрос без совпадений («опечатка», редкое
// слово) читал всё хранилище целиком — на машине владельца это ~1.7 ГБ и
// десятки секунд диска, конкурируя с выводом живых вкладок. Плюс отмены не
// было: человек уточняет запрос, а прошлый проход дочитывает диск впустую.

test('search(): потолок просмотренных сессий — не читаем всё хранилище ради промаха', async (t) => {
  const tmp = makeTmpDir();
  t.after(() => rmDir(tmp));
  const dir = path.join(tmp, 'proj');
  for (let i = 0; i < 6; i++) {
    writeSession(dir, `sess-${i}`, [userLine({ sessionId: `sess-${i}`, cwd: 'C:\\proj', text: `запись номер ${i}` })]);
  }

  // Считаем, сколько файлов реально открыл поиск.
  const deps = realDeps(tmp);
  let opened = 0;
  const idx = createHistoryIndex({
    ...deps,
    scanCap: 3,
    readFileLines: (file) => { opened += 1; return deps.readFileLines(file); },
  });
  await idx.refresh({ force: true });

  opened = 0;
  const res = await idx.search('такогословатутнет');

  assert.deepStrictEqual(res, [], 'совпадений и не должно быть');
  assert.strictEqual(opened, 3, `прочитано ${opened} сессий вместо потолка в 3 — промах снова читает всё хранилище`);
  assert.deepStrictEqual(
    res.scannedOf, { scanned: 3, total: 6 },
    'усечение не сообщено наружу — интерфейс не сможет честно сказать «просмотрено N из M»',
  );
});

test('search(): полный обход не помечается усечённым', async (t) => {
  const tmp = makeTmpDir();
  t.after(() => rmDir(tmp));
  const dir = path.join(tmp, 'proj');
  writeSession(dir, 'sess-1', [userLine({ sessionId: 'sess-1', cwd: 'C:\\proj', text: 'первая' })]);
  writeSession(dir, 'sess-2', [userLine({ sessionId: 'sess-2', cwd: 'C:\\proj', text: 'вторая' })]);

  const idx = createHistoryIndex({ ...realDeps(tmp), scanCap: 10 });
  await idx.refresh({ force: true });

  const res = await idx.search('нетничего');
  assert.strictEqual(res.scannedOf, undefined, 'обошли всё, но пометили усечением — интерфейс соврёт про пропущенное');
});

test('search(): более свежий запрос обесценивает предыдущий', async (t) => {
  const tmp = makeTmpDir();
  t.after(() => rmDir(tmp));
  const dir = path.join(tmp, 'proj');
  for (let i = 0; i < 5; i++) {
    writeSession(dir, `sess-${i}`, [userLine({ sessionId: `sess-${i}`, cwd: 'C:\\proj', text: `общее маркер ${i}` })]);
  }

  // Замедляем чтение, чтобы первый проход гарантированно был в работе, когда
  // стартует второй.
  const deps = realDeps(tmp);
  const idx = createHistoryIndex({
    ...deps,
    readFileLines: (file) => (async function* () {
      await new Promise((r) => { setTimeout(r, 15); });
      yield* deps.readFileLines(file);
    }()),
  });
  await idx.refresh({ force: true });

  const первый = idx.search('маркер');
  await new Promise((r) => { setTimeout(r, 20); }); // первый уже читает
  const второй = idx.search('маркер');

  const [резПервый, резВторой] = await Promise.all([первый, второй]);
  assert.deepStrictEqual(резПервый, [], 'устаревший запрос обязан бросить работу, а не дочитывать диск впустую');
  assert.ok(резВторой.length > 0, 'свежий запрос должен вернуть настоящие результаты');
});

test('search(): битая строка JSONL пропускается при поиске, остальное находится', async (t) => {
  const tmp = makeTmpDir();
  t.after(() => rmDir(tmp));
  const dirA = path.join(tmp, 'proj');
  writeSession(dirA, 'sess-1', [
    '{broken,,,',
    userLine({ sessionId: 'sess-1', cwd: 'C:\\proj', text: 'уникальноеслово после сломанной строки' }),
  ]);
  const idx = createHistoryIndex(realDeps(tmp));
  await idx.refresh({ force: true });

  const res = await idx.search('уникальноеслово');
  assert.strictEqual(res.length, 1);
  assert.strictEqual(res[0].sessionId, 'sess-1');
});

test('search(): файл исчез между refresh() и search() — сессия пропускается, остальные ищутся', async (t) => {
  const tmp = makeTmpDir();
  t.after(() => rmDir(tmp));
  const dirA = path.join(tmp, 'proj');
  const fileOk = writeSession(dirA, 'sess-ok', [userLine({ sessionId: 'sess-ok', cwd: 'C:\\proj', text: 'общее слово алярм здесь' })]);
  const fileGone = writeSession(dirA, 'sess-gone', [userLine({ sessionId: 'sess-gone', cwd: 'C:\\proj', text: 'общее слово алярм тоже здесь' })]);

  const readFileLines = async function* (fp) {
    if (fp === fileGone) throw new Error('ENOENT');
    yield* realReadFileLines(fp);
  };
  const idx = createHistoryIndex(realDeps(tmp, { readFileLines }));
  await idx.refresh({ force: true }); // на момент refresh файл ещё "жив" в этом моке для stat/пере-чтения структуры

  const res = await idx.search('алярм');
  assert.strictEqual(res.length, 1);
  assert.strictEqual(res[0].sessionId, 'sess-ok');
});

test('search(): не найдено ни в одной сессии → []', async (t) => {
  const tmp = makeTmpDir();
  t.after(() => rmDir(tmp));
  const idx = await buildTwoSessionIndex(tmp);

  assert.deepStrictEqual(await idx.search('совершенно_несуществующееслово_xyz'), []);
});

test('search(): без предварительного refresh(), но с валидным диск-кэшем той же схемы — работает сразу (ленивая загрузка кэша)', async (t) => {
  const tmp = makeTmpDir();
  t.after(() => rmDir(tmp));
  const dirA = path.join(tmp, 'proj');
  const file = writeSession(dirA, 'sess-1', [userLine({ sessionId: 'sess-1', cwd: 'C:\\proj', text: 'загруженное из кэша слово редкоеслово' })]);
  const st = fs.statSync(file);

  // Собираем первым инстансом, чтобы получить РЕАЛЬНЫЙ валидный кэш-объект схемы модуля.
  const cache = memoryCache();
  const producer = createHistoryIndex(realDeps(tmp, { cache }));
  await producer.refresh({ force: true });
  const persisted = cache.peek();
  assert.ok(persisted, 'ожидали, что producer реально записал кэш на "диск" (в memoryCache)');

  // Второй, свежий инстанс — та же cache (уже с данными), search() БЕЗ refresh().
  const cache2 = memoryCache(persisted);
  const idx2 = createHistoryIndex(realDeps(tmp, { cache: cache2 }));
  const res = await idx2.search('редкоеслово');
  assert.strictEqual(res.length, 1);
  assert.strictEqual(res[0].sessionId, 'sess-1');
});

test('search(): без refresh() и без диск-кэша — индекс пуст, вернёт []', async (t) => {
  const idx = createHistoryIndex({
    listProjects: async () => [{ projectDir: 'p', sessionId: 's', filePath: 'C:\\nope.jsonl' }],
    stat: async () => { throw new Error('unused'); },
    readFileLines: async function* () {},
    cache: memoryCache(),
    now: () => 1,
  });

  const res = await idx.search('что угодно');
  assert.deepStrictEqual(res, []);
});
