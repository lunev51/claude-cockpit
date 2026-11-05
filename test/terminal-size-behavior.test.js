'use strict';
// Поведение initTerminal вокруг размера — на поддельных xterm/FitAddon/DOM.
//
// Страж по исходнику (terminal-size-guard.test.js) держит форму кода; здесь —
// то, что из неё следует: какие вызовы реально уходят в window.api.term при
// скрытом, свёрнутом и видимом контейнере и при догрузке шрифта. Подделки
// повторяют ровно те ответы настоящих библиотек, на которых держится баг:
//   - proposeDimensions у контейнера display:none → {NaN, NaN} (getComputedStyle
//     даёт 'auto'), у контейнера 0×0 → зажатый минимум {2, 1};
//   - fit() на NaN молча выходит, на 2×1 честно ужимает терминал;
//   - новый xterm до первого fit — 80×24.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const url = pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'js', 'terminal.js')).href;

function fakeEl() {
  return {
    style: {},
    children: [],
    append(...els) { this.children.push(...els); },
    appendChild(el) { this.children.push(el); },
    addEventListener() {},
    contains() { return false; },
    focus() {},
    select() {},
  };
}

let env;

beforeEach(() => {
  const calls = [];
  const fontListeners = new Map();
  const state = {
    proposed: { cols: NaN, rows: NaN }, // как у .term-view.hidden
    box: { width: 0, height: 0 },
    cell: { width: 8, height: 17 },
  };
  const charSize = {
    width: 8,
    height: 17,
    measure() { this.width = state.cell.width; this.height = state.cell.height; },
  };
  class Terminal {
    constructor(opts) {
      this.cols = 80;
      this.rows = 24;
      this.options = { ...opts };
      this._core = { _charSizeService: charSize };
    }
    loadAddon(addon) { if (addon && typeof addon.activate === 'function') addon.activate(this); }
    open() {}
    onSelectionChange() {}
    attachCustomKeyEventHandler() {}
    write() {}
    onData() {}
    focus() {}
    hasSelection() { return false; }
    refresh(a, b) { calls.push(['refresh', a, b]); }
    resize(cols, rows) { this.cols = cols; this.rows = rows; calls.push(['xterm.resize', cols, rows]); }
    dispose() {}
  }
  class FitAddon {
    activate(t) { this.t = t; }
    proposeDimensions() { return state.proposed; }
    fit() {
      const p = this.proposeDimensions();
      if (!p || Number.isNaN(p.cols) || Number.isNaN(p.rows)) return;
      if (p.cols !== this.t.cols || p.rows !== this.t.rows) this.t.resize(p.cols, p.rows);
    }
  }
  let roCallback = null;
  globalThis.ResizeObserver = class {
    constructor(cb) { roCallback = cb; }
    observe() {}
    disconnect() { calls.push(['ro.disconnect']); }
  };
  globalThis.getComputedStyle = () => ({ position: 'absolute' });
  globalThis.document = {
    createElement: () => fakeEl(),
    fonts: {
      addEventListener: (ev, fn) => fontListeners.set(ev, fn),
      removeEventListener: (ev, fn) => { if (fontListeners.get(ev) === fn) fontListeners.delete(ev); },
    },
  };
  globalThis.window = {
    Terminal,
    FitAddon: { FitAddon },
    WebLinksAddon: { WebLinksAddon: class {} },
    SearchAddon: { SearchAddon: class {} },
    SerializeAddon: { SerializeAddon: class {} },
    dispatchEvent() {},
    api: {
      term: {
        start: (...a) => calls.push(['start', ...a]),
        resize: (...a) => calls.push(['resize', ...a]),
        write() {},
        restart() {},
      },
      shell: { openExternal() {} },
      config: { set() {} },
    },
  };
  const container = fakeEl();
  Object.defineProperty(container, 'clientWidth', { get: () => state.box.width });
  Object.defineProperty(container, 'clientHeight', { get: () => state.box.height });
  env = {
    calls, state, container, fontListeners, fireResize: () => roCallback(),
  };
});

const CONFIG = {
  terminal: {
    fontSize: 14, fontFamily: 'x', scrollback: 1000, copyOnSelect: false, rightClickPaste: false,
  },
};

const sent = (kind) => env.calls.filter((c) => c[0] === kind);

async function open(t, extra = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { initTerminal } = await import(url);
  return initTerminal(env.container, CONFIG, { tabId: 'T1', onPtyStatus: () => {}, ...extra });
}

function showWindow() {
  env.state.box = { width: 2360, height: 1332 };
  env.state.proposed = { cols: 279, rows: 69 };
}

test('вкладка в скрытом контейнере стартует БЕЗ размера и не шлёт resize', async (t) => {
  const view = await open(t);
  assert.deepStrictEqual(sent('start'), [['start', 'T1', null, null]], 'term:start ушёл с размером неподогнанного терминала');

  env.fireResize();
  t.mock.timers.tick(100);
  assert.deepStrictEqual(sent('resize'), [], 'ResizeObserver скрытой вкладки снова прислал pty умолчание 80×24');
  assert.strictEqual(view.refit(), null, 'refit скрытой вкладки обязан сказать «не подогнан»');
  assert.deepStrictEqual(sent('resize'), []);
});

test('показ вкладки — первый и единственный размер, настоящий', async (t) => {
  await open(t);
  showWindow();
  env.fireResize();
  t.mock.timers.tick(100);
  assert.deepStrictEqual(sent('resize'), [['resize', 'T1', 279, 69]]);
  assert.strictEqual(env.calls.some((c) => c[0] === 'resize' && c[2] === 80 && c[3] === 24), false);
});

test('видимый контейнер при создании — старт сразу в настоящем размере', async (t) => {
  showWindow();
  await open(t);
  assert.deepStrictEqual(sent('start'), [['start', 'T1', 279, 69]]);
});

test('свёрнутое окно (контейнер 0×0) — ни 2×1 в pty, ни ужатого xterm', async (t) => {
  const view = await open(t);
  showWindow();
  env.fireResize();
  t.mock.timers.tick(100);
  env.calls.length = 0;

  env.state.box = { width: 0, height: 0 };
  env.state.proposed = { cols: 2, rows: 1 }; // так FitAddon отвечает на нулевой контейнер
  env.fireResize();
  t.mock.timers.tick(100);
  assert.deepStrictEqual(sent('resize'), [], 'свёрнутое окно прислало pty 2×1');
  assert.deepStrictEqual(sent('xterm.resize'), [], 'xterm ужат до 2×1 — буфер переложится в две колонки');
  assert.strictEqual(view.term.cols, 279);
});

test('refit видимого терминала отдаёт размер и шлёт его', async (t) => {
  const view = await open(t);
  showWindow();
  assert.deepStrictEqual(view.refit(), { cols: 279, rows: 69 });
  assert.deepStrictEqual(sent('resize'), [['resize', 'T1', 279, 69]]);
});

test('догрузка шрифта перемеряет ячейку и шлёт новый размер; пустая догрузка молчит', async (t) => {
  const view = await open(t);
  showWindow();
  view.refit();
  env.calls.length = 0;

  const onDone = env.fontListeners.get('loadingdone');
  assert.strictEqual(typeof onDone, 'function', 'подписки на loadingdone нет');

  // Догрузился чужой шрифт (Inter интерфейса) — ячейка та же, ресайзить нечего.
  onDone();
  assert.deepStrictEqual(sent('resize'), [], 'догрузка шрифта без смены ячейки гоняет ресайз всех pty');

  // Догрузился JetBrains Mono: строка выше запасной — строк влезает меньше.
  env.state.cell = { width: 8, height: 19 };
  env.state.proposed = { cols: 279, rows: 62 };
  onDone();
  assert.deepStrictEqual(sent('resize'), [['resize', 'T1', 279, 62]]);
  assert.strictEqual(sent('refresh').length, 1, 'после перемера экран не перерисован');
});

test('догрузка шрифта у скрытой вкладки ячейку перемеряет, но pty не трогает', async (t) => {
  await open(t);
  env.state.cell = { width: 8, height: 19 };
  env.fontListeners.get('loadingdone')();
  assert.deepStrictEqual(sent('resize'), []);
});

// --- Сетка скрытых вкладок (A6) ----------------------------------------------
// main раздаёт размер видимой вкладки ВСЕМ pty (termResizeHandler в ipc.js), а
// скрытый xterm сам подогнаться не может. Без общей сетки фоновая сессия
// рисовала бы в pty одного размера, а её xterm держал бы другой (80×24 у ни
// разу не показанной) — и при показе ресайз pty выходил бы пустым (размер уже
// тот), то есть Claude Code НЕ перерисовался бы поверх испорченного экрана.

test('подогнанный размер уходит и наружу (onGrid) — для соседних вкладок', async (t) => {
  const grids = [];
  await open(t, { onGrid: (size) => grids.push(size) });
  env.fireResize();
  t.mock.timers.tick(100);
  assert.deepStrictEqual(grids, [], 'неподогнанный терминал раздал свою сетку соседям');

  showWindow();
  env.fireResize();
  t.mock.timers.tick(100);
  assert.deepStrictEqual(grids, [{ cols: 279, rows: 69 }]);
});

test('adoptGrid: скрытый терминал принимает сетку видимой, ничего не отправляя в pty', async (t) => {
  const view = await open(t);
  env.calls.length = 0;
  view.adoptGrid({ cols: 279, rows: 69 });
  assert.deepStrictEqual([view.term.cols, view.term.rows], [279, 69], 'скрытый xterm остался в своей сетке');
  assert.deepStrictEqual(sent('resize'), [], 'adoptGrid слал размер в pty — это решает только видимая вкладка');
  assert.deepStrictEqual(sent('start'), []);
});

test('adoptGrid: подогнанный терминал чужую сетку не берёт', async (t) => {
  const view = await open(t);
  showWindow();
  view.refit();
  view.adoptGrid({ cols: 100, rows: 30 });
  assert.deepStrictEqual([view.term.cols, view.term.rows], [279, 69]);
});

test('dispose снимает подписку на шрифты', async (t) => {
  const view = await open(t);
  assert.ok(env.fontListeners.has('loadingdone'));
  view.dispose();
  assert.strictEqual(env.fontListeners.has('loadingdone'), false, 'закрытая вкладка осталась подписана на document.fonts');
});
