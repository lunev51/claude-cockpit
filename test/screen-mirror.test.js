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

// Ревью ветки (m6, мутация M6): проверка экспорта только у Terminal выживала —
// пакеты без нужного экспорта с обеих сторон ловились и так.
test('createTabHistory: экспорт есть только у одного пакета — запасной путь, а не зеркало без половины', async () => {
  for (const missing of ['@xterm/headless', '@xterm/addon-serialize']) {
    const warns = [];
    const history = createTabHistory({
      sizeOf: () => SIZE,
      load: (name) => (name === missing ? {} : require(name)),
      warn: (...args) => warns.push(args.join(' ')),
    });
    history.push('T1', 'вывод');
    // eslint-disable-next-line no-await-in-loop
    assert.strictEqual(await history.get('T1'), 'вывод', `без экспорта ${missing} история не стала сырым хвостом`);
    assert.strictEqual(warns.length, 1, `без экспорта ${missing}: предупреждений ${warns.length}`);
  }
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

// --- Режимы терминала, которые аддон serialize не переносит (ревью ветки, I1) ---
//
// Окно ПК — xterm, видевший сырой поток; клиент — свежий xterm, получивший
// снимок. Всё, что клиент делает по-другому, человек видит как поломку:
// ConPTY ставит ?1000h ?1002h ?1003h ?1006h (живые буферы владельца), аддон
// переносит слежение, но не кодировку SGR — колесо уходит в onBinary
// как \e[M…, а terminal.js слушает только onData: прокрутка мертва.
//
// Публичного способа послать событие мыши в headless нет (нет DOM) —
// событие шлётся через coreMouseService, как в эксперименте ревьюера; и
// видимость курсора с кодировкой публично не читаются. _core здесь — только
// оракул теста: сравнивается клиент с окном ПК, а не с ожиданием, записанным
// руками.
function mouseBytes(term) {
  const data = [];
  const binary = [];
  const d1 = term.onData((s) => data.push(s));
  const d2 = term.onBinary((s) => binary.push(s));
  const mouse = term._core.coreMouseService;
  mouse.triggerMouseEvent({ col: 10, row: 5, x: 0, y: 0, button: 4, action: 0, ctrl: false, alt: false, shift: false }); // колесо
  mouse.triggerMouseEvent({ col: 10, row: 5, x: 0, y: 0, button: 0, action: 1, ctrl: false, alt: false, shift: false }); // клик
  d1.dispose();
  d2.dispose();
  return { data, binary };
}

function terminalState(term) {
  return {
    mouseEncoding: term._core.coreMouseService.activeEncoding,
    mouseTracking: term.modes.mouseTrackingMode,
    cursorHidden: term._core.coreService.isCursorHidden,
    bracketedPaste: term.modes.bracketedPasteMode,
    bufferType: term.buffer.active.type,
  };
}

// Поток → (окно ПК, клиент со снимком зеркала) того же размера.
async function pcAndClient(stream) {
  const mirror = createScreenMirror({ Terminal, SerializeAddon, sizeOf: () => SIZE });
  mirror.push('T1', stream);
  const pc = new Terminal({ cols: COLS, rows: ROWS, scrollback: 1000, allowProposedApi: true });
  await writeAsync(pc, stream);
  const client = new Terminal({ cols: COLS, rows: ROWS, scrollback: 5000, allowProposedApi: true });
  await writeAsync(client, await mirror.get('T1'));
  mirror.drop('T1');
  return { pc, client };
}

test('мышь: снимок переносит кодировку SGR (?1006h) — колесо и клик уходят в onData, как у окна ПК (I1)', async () => {
  const { pc, client } = await pcAndClient(`${ESC}[?1000h${ESC}[?1002h${ESC}[?1003h${ESC}[?1006h${ESC}[2J${ESC}[Hэкран`);
  const want = mouseBytes(pc);
  // Самопроверка оракула: окно ПК шлёт SGR в onData.
  assert.deepStrictEqual(want, { data: [`${ESC}[<64;11;6M`, `${ESC}[<0;11;6M`], binary: [] });
  assert.deepStrictEqual(mouseBytes(client), want, 'клиент после снимка шлёт мышь не так, как окно ПК — колесо мёртвое');
  pc.dispose();
  client.dispose();
});

// Равенство состояния с окном ПК на последовательностях со сбросами. Таблица
// держит именно поведение xterm 6, а не «как должно быть по стандарту»:
// RIS (\ec) сбрасывает кодировку мыши, но скрытый курсор оставляет скрытым;
// DECSTR (\e[!p) показывает курсор, мышь не трогает. Обновление xterm с
// другой логикой покраснит здесь, а не у человека на экране.
const MODE_CASES = [
  ['скрытый курсор', `${ESC}[?25l`],
  ['скрыт и снова показан', `${ESC}[?25l${ESC}[?25h`],
  ['мышь и курсор одним кадром, несколько параметров', `${ESC}[?1002;1006h${ESC}[?25l`],
  ['SGR_PIXELS', `${ESC}[?1003h${ESC}[?1016h`],
  ['1006 снят через 1016l', `${ESC}[?1002h${ESC}[?1006h${ESC}[?1016l`],
  ['1006 снят через 1006l', `${ESC}[?1002h${ESC}[?1006h${ESC}[?1006l`],
  ['подпараметр 1006:1', `${ESC}[?1002h${ESC}[?1006:1h`],
  ['DECSTR после режимов', `${ESC}[?1002h${ESC}[?1006h${ESC}[?25l${ESC}[!p`],
  ['RIS после режимов', `${ESC}[?1002h${ESC}[?1006h${ESC}[?25l${ESC}c`],
  ['RIS, затем режимы заново', `${ESC}[?1006h${ESC}c${ESC}[?1003h${ESC}[?1006h`],
  ['bracketed paste (?2004h)', `${ESC}[?2004h`],
  ['альтернативный экран с режимами', `${ESC}[?1003h${ESC}[?1006h${ESC}[?25l${ESC}[?1049hальт`],
];

for (const [label, modes] of MODE_CASES) {
  test(`режимы после снимка = окно ПК: ${label}`, async () => {
    const { pc, client } = await pcAndClient(`${modes}${at(3, 1)}текст`);
    assert.deepStrictEqual(terminalState(client), terminalState(pc));
    pc.dispose();
    client.dispose();
  });
}

// --- push и get не бросают (ревью ветки, m2) ---
//
// push зовётся из onEvent менеджера сессий, то есть из onData node-pty: брошенное
// там исключение — uncaughtException в main и выход всего кокпита, а term:data
// этого куска не уходит клиентам (bufferTermData стоит до broadcast.emit).
// Реальный повод — очередь xterm сверх 50 МБ: write бросает «write data
// discarded». Тот же класс — serialize, брошенный внутри колбэка записи: он
// исполняется в таймере xterm, мимо любого try вызывающего.
test('push не бросает, когда xterm отказывает в записи: одно предупреждение, вкладка жива', async () => {
  class DiscardingTerminal extends Terminal {
    write(data, callback) {
      if (data) throw new Error('write data discarded, use flow control to avoid losing data');
      return super.write(data, callback);
    }
  }
  const warns = [];
  const mirror = createScreenMirror({
    Terminal: DiscardingTerminal, SerializeAddon, sizeOf: () => SIZE, warn: (...args) => warns.push(args.join(' ')),
  });
  for (let i = 0; i < 3; i += 1) assert.doesNotThrow(() => mirror.push('T1', `кусок ${i}`));
  assert.strictEqual(warns.length, 1, `предупреждений ${warns.length} — на каждый кусок вывода засыпали бы журнал`);
  assert.match(warns[0], /write data discarded/);
  assert.strictEqual(typeof await mirror.get('T1'), 'string');
});

test('createTabHistory: предупреждения зеркала идут в тот же warn, что и отказ загрузки', async () => {
  class DiscardingTerminal extends Terminal {
    write(data, callback) {
      if (data) throw new Error('write data discarded, use flow control to avoid losing data');
      return super.write(data, callback);
    }
  }
  const warns = [];
  const history = createTabHistory({
    sizeOf: () => SIZE,
    load: (name) => (name === '@xterm/headless' ? { Terminal: DiscardingTerminal } : require(name)),
    warn: (...args) => warns.push(args.join(' ')),
  });
  history.push('T1', 'вывод');
  assert.strictEqual(warns.length, 1, 'предупреждение зеркала ушло мимо warn истории');
  assert.match(warns[0], /write data discarded/);
});

test('get не роняет main, если serialize бросил: пустая история и предупреждение', async () => {
  class BrokenSerialize extends SerializeAddon {
    serialize() { throw new Error('serialize сломан'); }
  }
  const warns = [];
  const mirror = createScreenMirror({
    Terminal, SerializeAddon: BrokenSerialize, sizeOf: () => SIZE, warn: (...args) => warns.push(args.join(' ')),
  });
  mirror.push('T1', 'вывод');
  const outcome = await Promise.race([
    mirror.get('T1'),
    new Promise((resolve) => { setTimeout(() => resolve('висит'), 500); }),
  ]);
  assert.strictEqual(outcome, '');
  assert.strictEqual(warns.length, 1);
  assert.match(warns[0], /serialize сломан/);
});

// --- Выжившие мутации ревью (m6) ---

// M2: колбэк записи зовётся и ПОСЛЕ dispose (exp-dispose-cb ревью), и serialize
// на разобранном терминале печатает в журнал трассу «Trying to add a disposable
// to a DisposableStore that has already been disposed». Ответ ждущему уже дан
// в drop — снимать снимок с разобранного терминала нельзя.
test('drop во время ожидания снимка: serialize на разобранном терминале не зовётся', async () => {
  const serializers = [];
  class CountingSerialize extends SerializeAddon {
    constructor() {
      super();
      this.calls = 0;
      serializers.push(this);
    }

    serialize(options) {
      this.calls += 1;
      return super.serialize(options);
    }
  }
  const mirror = createScreenMirror({ Terminal, SerializeAddon: CountingSerialize, sizeOf: () => SIZE });
  mirror.push('T1', 'вывод');
  const pending = mirror.get('T1');
  mirror.drop('T1');
  assert.strictEqual(await pending, '');
  // Очередь записи xterm разбирается таймером: даём ей дойти до колбэка.
  await new Promise((resolve) => { setTimeout(resolve, 100); });
  assert.strictEqual(serializers[0].calls, 0, 'снимок снят с разобранного терминала — в журнале трасса DisposableStore');
});

// M3: подгонка сравнивала только ширину.
test('ресайз только по высоте: зеркало подгоняется и строки ложатся в новую сетку', async () => {
  const { Recording, made } = recordingTerminal();
  let size = { cols: 100, rows: 30 };
  const mirror = createScreenMirror({ Terminal: Recording, SerializeAddon, sizeOf: () => size });
  mirror.push('T1', `${ESC}[2J${ESC}[Hверх`);
  size = { cols: 100, rows: 40 };
  mirror.push('T1', `${ESC}[2J${at(40, 1)}низ высокого экрана`);
  assert.deepStrictEqual([made[0].cols, made[0].rows], [100, 40], 'зеркало осталось в старой высоте');
  await writeAsync(made[0], '');
  const screen = await readScreen(await mirror.get('T1'), 100, 40);
  assert.strictEqual(screen[39], 'низ высокого экрана');
});

// M4: правило валидного размера — общее с эстафетой и pty (isValidSize,
// 2..500 целые). Размер вне его зеркало не заводит: xterm принял бы 600
// колонок, и снимок лёг бы в сетку, которой у pty быть не может.
test('невалидный размер от sizeOf — зеркало не создаётся, предупреждений нет', async () => {
  for (const bad of [{ cols: 0, rows: 0 }, { cols: 600, rows: 30 }, { cols: 80, rows: 1 }, { cols: '80', rows: '24' }, { cols: 80.5, rows: 24 }, {}]) {
    const { Recording, made } = recordingTerminal();
    const warns = [];
    const mirror = createScreenMirror({
      Terminal: Recording, SerializeAddon, sizeOf: () => bad, warn: (...args) => warns.push(args.join(' ')),
    });
    mirror.push('T1', 'вывод');
    assert.strictEqual(made.length, 0, `зеркало создано в размере ${JSON.stringify(bad)}`);
    assert.deepStrictEqual(warns, [], `размер ${JSON.stringify(bad)} дошёл до xterm и уронил запись`);
    // eslint-disable-next-line no-await-in-loop
    assert.strictEqual(await mirror.get('T1'), '');
  }
});

// M8/M9: история над экраном (прокрутка) — часть снимка. ConPTY переводов
// строки почти не пишет, но когда пишет, уехавшее вверх — это и есть «на чём
// остановилась работа».
test('история над экраном попадает в снимок (прокрутка зеркала и serialize)', async () => {
  const mirror = createScreenMirror({ Terminal, SerializeAddon, sizeOf: () => SIZE });
  let text = '';
  for (let i = 0; i < 100; i += 1) text += `строка ${i}\r\n`;
  mirror.push('T1', text);
  const client = new Terminal({ cols: COLS, rows: ROWS, scrollback: 5000, allowProposedApi: true });
  await writeAsync(client, await mirror.get('T1'));
  const buf = client.buffer.active;
  const all = [];
  for (let y = 0; y < buf.length; y += 1) all.push(buf.getLine(y).translateToString(true));
  client.dispose();
  for (const want of ['строка 0', 'строка 50', 'строка 99']) {
    assert.ok(all.includes(want), `в снимке нет «${want}» — история над экраном потеряна`);
  }
});
