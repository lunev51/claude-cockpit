'use strict';
// Зеркало экрана вкладки в main (screen-mirror.js) — то, что подключившийся
// клиент получает по net:buffer вместо сырого хвоста вывода.
//
// Живая жалоба 05.11: браузер на ПК открыл кокпит, у вкладки akto внизу нет
// рамок поля ввода и статус-бара — только изменившиеся цифры счётчика. Поток
// pty на Windows — рендер ConPTY: абсолютные позиции, полная перерисовка
// только при ресайзе, дальше одни правки. Хвост 256 КБ после долгой работы
// спиннера начинался уже ПОСЛЕ последней полной перерисовки.
//
// Терминал здесь настоящий (@xterm/headless), без подделок: проверяется не
// «позвали ли write», а что снимок, записанный в свежий терминал, даёт тот же
// экран. Подкласс Recording — тот же настоящий терминал, он только запоминает
// созданные экземпляры, чтобы тест видел размер зеркала и его уборку.
const test = require('node:test');
const assert = require('node:assert');
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');
const { createScreenMirror, createTabHistory } = require('../src/main/screen-mirror');
const { createOutputBuffer } = require('../src/main/output-buffer');

const ESC = '\x1b';
const at = (row, col) => `${ESC}[${row};${col}H`;

const COLS = 100;
const ROWS = 30;
const SIZE = Object.freeze({ cols: COLS, rows: ROWS });
const RULE = '─'.repeat(COLS);
// Строки (с единицы, как в CSI H) нижней части экрана Claude Code.
const BOX_TOP = 24;
const PROMPT_ROW = BOX_TOP + 1;
const BOX_BOTTOM = BOX_TOP + 2;
const STATUS_ROW = BOX_TOP + 3;
const MODE_ROW = BOX_TOP + 4;
const STATUS_PREFIX = 'Opus 5.5 | proj | main | ';
const COUNTER_COL = STATUS_PREFIX.length + 1;

// Счётчик всегда одной ширины (10 клеток) — правка не оставляет хвостов от
// прошлого значения, как и у настоящего статус-бара между перерисовками.
const counterAt = (n) => `${100 + (n % 900)}k · ${String(n % 100).padStart(2, '0')}%`;

// Полная перерисовка — один раз, как у ConPTY после ресайза.
function conptyFullScreen() {
  return `${ESC}[2J${ESC}[H`
    + at(BOX_TOP, 1) + RULE
    + at(PROMPT_ROW, 1) + '> '
    + at(BOX_BOTTOM, 1) + RULE
    + at(STATUS_ROW, 1) + STATUS_PREFIX + '100k · 10%'
    + at(MODE_ROW, 1) + 'bypass permissions on';
}

// Дальше — только правки счётчика абсолютной позицией. Объём обязан
// превысить не 256 КБ, а потолок старого буфера с запасом на амортизацию
// (256 КБ × 1,25 = 320 КБ, OVERSHOOT_FACTOR в output-buffer.js): при 300 КБ
// старый путь хранил бы поток целиком и баг не воспроизводился бы.
const EDIT_BYTES = 400 * 1024;
function counterEdits(minBytes) {
  const parts = [];
  let bytes = 0;
  let n = 0;
  while (bytes < minBytes) {
    n += 1;
    const piece = at(STATUS_ROW, COUNTER_COL) + counterAt(n);
    parts.push(piece);
    bytes += Buffer.byteLength(piece, 'utf8');
  }
  return { text: parts.join(''), last: counterAt(n) };
}

// Кусками по 4 КБ — так данные приходят из node-pty.
function feed(history, tabId, text) {
  for (let i = 0; i < text.length; i += 4096) history.push(tabId, text.slice(i, i + 4096));
}

const writeAsync = (term, data) => new Promise((resolve) => term.write(data, resolve));

// Снимок → свежий терминал того же размера (так его принимает replayHistory
// в app.js) → строки экрана без хвостовых пробелов.
async function readScreen(snapshot, cols, rows) {
  const term = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
  try {
    await writeAsync(term, snapshot);
    const buf = term.buffer.active;
    const out = [];
    for (let y = 0; y < rows; y += 1) out.push(buf.getLine(buf.baseY + y).translateToString(true));
    return out;
  } finally {
    term.dispose();
  }
}

function recordingTerminal() {
  const made = [];
  class Recording extends Terminal {
    constructor(options) {
      super(options);
      this.disposed = false;
      made.push(this);
    }

    dispose() {
      this.disposed = true;
      super.dispose();
    }
  }
  return { Recording, made };
}

async function streamAndRead(history) {
  const edits = counterEdits(EDIT_BYTES);
  feed(history, 'T1', conptyFullScreen() + edits.text);
  const screen = await readScreen(await history.get('T1'), COLS, ROWS);
  return { screen, last: edits.last };
}

test('регрессия 05.11: после 400 КБ правок счётчика рамки, поле ввода и статус-бар на месте', async () => {
  const history = createTabHistory({ sizeOf: () => SIZE });
  const { screen, last } = await streamAndRead(history);
  assert.strictEqual(screen[BOX_TOP - 1], RULE, 'верхняя рамка поля ввода пропала');
  assert.strictEqual(screen[PROMPT_ROW - 1], '> ', 'поле ввода пропало');
  assert.strictEqual(screen[BOX_BOTTOM - 1], RULE, 'нижняя рамка поля ввода пропала');
  // Последнее значение счётчика — заодно проверка, что снимок снят после
  // разбора ВСЕГО принятого, а не середины очереди записи.
  assert.strictEqual(screen[STATUS_ROW - 1], STATUS_PREFIX + last, 'статус-бар не целый или не последний');
  assert.strictEqual(screen[MODE_ROW - 1], 'bypass permissions on', 'строка режима пропала');
});

// Самопроверка фикстуры: на старом пути (сырой хвост) этот поток обязан
// терять низ экрана. Без неё регрессия выше могла бы стать пустой правдой —
// хватит уменьшить объём правок ниже потолка буфера.
test('фикстура воспроизводит баг: сырой хвост createOutputBuffer теряет рамки и статус-бар', async () => {
  const raw = createOutputBuffer();
  const { screen, last } = await streamAndRead({ push: raw.push, get: async (tabId) => raw.get(tabId) });
  assert.notStrictEqual(screen[BOX_TOP - 1], RULE, 'старый путь сохранил рамку — фикстура не воспроизводит жалобу');
  assert.ok(!screen[STATUS_ROW - 1].includes('Opus 5.5'), 'старый путь сохранил статус-бар — фикстура не воспроизводит жалобу');
  assert.ok(screen[STATUS_ROW - 1].includes(last), 'в хвосте нет даже последней правки — фикстура сломана иначе');
});

test('ресайз: push в новом размере сначала подгоняет зеркало, поток ложится в новую сетку', async () => {
  const { Recording, made } = recordingTerminal();
  let size = { cols: 100, rows: 30 };
  const mirror = createScreenMirror({ Terminal: Recording, SerializeAddon, sizeOf: () => size });
  mirror.push('T1', `${ESC}[2J${ESC}[Hстарый размер`);
  assert.strictEqual(made.length, 1);
  assert.deepStrictEqual([made[0].cols, made[0].rows], [100, 30], 'зеркало создано не в размере pty');

  size = { cols: 120, rows: 40 };
  mirror.push('T1', `${ESC}[2J${at(40, 1)}низ нового экрана`);
  assert.strictEqual(made.length, 1, 'ресайз пересоздал зеркало вместо подгонки');
  assert.deepStrictEqual([made[0].cols, made[0].rows], [120, 40], 'зеркало осталось в старом размере');
  // Дожидаемся разбора мимо get: get сам подгоняет размер и скрыл бы
  // пропавший ресайз в push. В сетке 30 строк строка 40 прижалась бы к 30-й.
  await writeAsync(made[0], '');
  const screen = await readScreen(await mirror.get('T1'), 120, 40);
  assert.strictEqual(screen[39], 'низ нового экрана');
});

test('ресайз без данных: get отдаёт снимок уже в новом размере', async () => {
  const { Recording, made } = recordingTerminal();
  let size = { cols: 100, rows: 30 };
  const mirror = createScreenMirror({ Terminal: Recording, SerializeAddon, sizeOf: () => size });
  mirror.push('T1', `${ESC}[2J${ESC}[Hэкран`);
  size = { cols: 120, rows: 40 };
  const snapshot = await mirror.get('T1');
  assert.deepStrictEqual([made[0].cols, made[0].rows], [120, 40], 'снимок снят в старом размере');
  const screen = await readScreen(snapshot, 120, 40);
  assert.strictEqual(screen[0], 'экран');
});

test('sizeOf → null (вкладки нет): push не создаёт зеркало, get отдаёт пустую строку', async () => {
  const { Recording, made } = recordingTerminal();
  const mirror = createScreenMirror({ Terminal: Recording, SerializeAddon, sizeOf: () => null });
  mirror.push('T1', 'кусок после закрытия вкладки');
  assert.strictEqual(made.length, 0, 'зеркало создано для вкладки, которой нет, — утечка на каждое закрытие');
  assert.strictEqual(await mirror.get('T1'), '');
});

test('drop: зеркало разобрано, get пуст, поздний кусок закрытой вкладки ничего не воскрешает', async () => {
  const { Recording, made } = recordingTerminal();
  let size = SIZE;
  const mirror = createScreenMirror({ Terminal: Recording, SerializeAddon, sizeOf: () => size });
  mirror.push('T1', 'вывод до закрытия');
  mirror.push('T2', 'соседняя вкладка');
  assert.notStrictEqual(await mirror.get('T1'), '', 'страховка: зеркало было непустым до drop');

  mirror.drop('T1');
  assert.strictEqual(made[0].disposed, true, 'drop не разобрал терминал — память закрытой вкладки живёт до перезапуска');
  assert.strictEqual(await mirror.get('T1'), '');
  const neighbour = await readScreen(await mirror.get('T2'), COLS, ROWS);
  assert.strictEqual(neighbour[0], 'соседняя вкладка', 'drop одной вкладки задел соседнюю');

  // Хвост от убитого pty долетает уже после tabs:close: менеджер вкладку не
  // знает (sizeOf → null), и зеркало не должно родиться заново.
  size = null;
  mirror.push('T1', 'поздний кусок');
  assert.strictEqual(made.length, 2);
  assert.strictEqual(await mirror.get('T1'), '');
});

test('drop во время ожидания снимка не вешает ответ', async () => {
  const mirror = createScreenMirror({ Terminal, SerializeAddon, sizeOf: () => SIZE });
  mirror.push('T1', 'вывод');
  const pending = mirror.get('T1');
  mirror.drop('T1');
  const outcome = await Promise.race([
    pending.then((snapshot) => ({ snapshot })),
    new Promise((resolve) => { setTimeout(() => resolve('висит'), 500); }),
  ]);
  assert.notStrictEqual(outcome, 'висит', 'get после drop не ответил — клиент ждал бы историю вечно');
  assert.strictEqual(typeof outcome.snapshot, 'string');
});

test('createTabHistory: пакеты не загрузились — сырой хвост, одно предупреждение, кокпит жив', async () => {
  const warns = [];
  const history = createTabHistory({
    sizeOf: () => SIZE,
    load: (name) => { throw new Error(`Cannot find module '${name}'`); },
    warn: (...args) => warns.push(args.join(' ')),
  });
  history.push('T1', 'старый путь');
  history.push('T1', ' живой');
  assert.strictEqual(await history.get('T1'), 'старый путь живой');
  history.drop('T1');
  assert.strictEqual(await history.get('T1'), '');
  assert.strictEqual(warns.length, 1, `предупреждений ${warns.length}, ждали одно`);
  assert.match(warns[0], /@xterm\/headless/, 'предупреждение не говорит, чего не хватает');
});

test('createTabHistory: пакет без нужного экспорта — тоже запасной путь, а не падение на первом выводе', async () => {
  const warns = [];
  const history = createTabHistory({
    sizeOf: () => SIZE,
    load: () => ({}),
    warn: (...args) => warns.push(args.join(' ')),
  });
  history.push('T1', 'вывод');
  assert.strictEqual(await history.get('T1'), 'вывод');
  assert.strictEqual(warns.length, 1);
});

test('createTabHistory: пакеты на месте — зеркало экрана, а не сырой поток', async () => {
  const loaded = [];
  const warns = [];
  const history = createTabHistory({
    sizeOf: () => SIZE,
    load: (name) => { loaded.push(name); return require(name); },
    warn: (...args) => warns.push(args.join(' ')),
  });
  const raw = `${ESC}[2J${at(5, 3)}привет`;
  history.push('T1', raw);
  const snapshot = await history.get('T1');
  assert.deepStrictEqual(loaded.sort(), ['@xterm/addon-serialize', '@xterm/headless']);
  assert.deepStrictEqual(warns, []);
  assert.notStrictEqual(snapshot, raw, 'get отдал сырой поток — зеркало не подключено');
  const screen = await readScreen(snapshot, COLS, ROWS);
  assert.strictEqual(screen[4], '  привет');
});
