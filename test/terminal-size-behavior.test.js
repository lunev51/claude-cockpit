'use strict';
// Поведение initTerminal вокруг размера — на поддельных xterm/FitAddon/DOM.
//
// Страж по исходнику (terminal-size-guard.test.js) держит форму кода; здесь —
// то, что из неё следует: какие вызовы реально уходят в window.api.term при
// скрытом, свёрнутом, узком и видимом контейнере и при догрузке шрифта.
//
// Подделки повторяют НАСТОЯЩУЮ форму данных — первая редакция этого файла
// задавала коробку свёрнутого окна как {0, 0}, а настоящий DOM отдаёт
// clientWidth/Height = 8×4 (отступ .term-view 4px 0 0 8px входит в client*).
// На такой фикстуре тест был холостым: зелёный, пока прод слал pty 2×1
// (ревью ветки в headless Chrome с настоящими xterm 6.0.0 + addon-fit 0.11.0).
// Поэтому теперь:
//   - getComputedStyle(контейнер) — как у .term-view с box-sizing: content-box:
//     у display:none 'auto', иначе контентный блок = хост минус отступ (не
//     меньше нуля); clientWidth/Height — контент ПЛЮС отступ;
//   - FitAddon.proposeDimensions — формула addon-fit 0.11.0 дословно: из
//     getComputedStyle родителя, минус полоса прокрутки 14px, зажим cols ≥ 2,
//     rows ≥ 1;
//   - ячейка — из _renderService.dimensions.css.cell, а её перемер — в open()
//     и после каждого ресайза с изменением сетки (_afterResize в xterm 6).
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const url = pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'js', 'terminal.js')).href;

const PAD = { left: 8, top: 4 }; // .term-view { padding: 4px 0 0 8px }

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

function styleOf(props) {
  return { ...props, getPropertyValue: (name) => props[name] };
}

let env;

beforeEach(() => {
  const calls = [];
  const fontListeners = new Map();
  const state = {
    hidden: true, // вкладка создаётся в .term-view.hidden
    host: { width: 0, height: 0 },
    font: { width: 8, height: 19 }, // что вернёт замер ячейки сейчас
  };
  const container = fakeEl();
  const content = () => ({
    width: Math.max(0, state.host.width - PAD.left),
    height: Math.max(0, state.host.height - PAD.top),
  });
  Object.defineProperty(container, 'clientWidth', { get: () => (state.hidden ? 0 : content().width + PAD.left) });
  Object.defineProperty(container, 'clientHeight', { get: () => (state.hidden ? 0 : content().height + PAD.top) });
  const termElement = { parentElement: container };

  const charSize = {
    width: 0,
    height: 0,
    measure() { this.width = state.font.width; this.height = state.font.height; },
  };
  class Terminal {
    constructor(opts) {
      this.cols = 80;
      this.rows = 24;
      this.options = { ...opts };
      this.element = null;
      this._core = {
        _charSizeService: charSize,
        _renderService: { dimensions: { css: { get cell() { return { width: charSize.width, height: charSize.height }; } } } },
      };
    }
    loadAddon(addon) { if (addon && typeof addon.activate === 'function') addon.activate(this); }
    open() { this.element = termElement; charSize.measure(); }
    onSelectionChange() {}
    attachCustomKeyEventHandler() {}
    write() {}
    onData() {}
    focus() {}
    hasSelection() { return false; }
    refresh(a, b) { calls.push(['refresh', a, b]); }
    resize(cols, rows) {
      if (cols === this.cols && rows === this.rows) return;
      this.cols = cols;
      this.rows = rows;
      calls.push(['xterm.resize', cols, rows]);
      charSize.measure(); // _afterResize
    }
    dispose() {}
  }
  // addon-fit 0.11.0, proposeDimensions/fit — по исходнику lib/addon-fit.js.
  class FitAddon {
    activate(t) { this.t = t; }
    proposeDimensions() {
      const t = this.t;
      if (!t.element || !t.element.parentElement) return undefined;
      const cell = t._core._renderService.dimensions.css.cell;
      if (cell.width === 0 || cell.height === 0) return undefined;
      const scrollbar = t.options.scrollback === 0 ? 0 : (t.options.overviewRuler?.width || 14);
      const ps = getComputedStyle(t.element.parentElement);
      const h = parseInt(ps.getPropertyValue('height'), 10);
      const w = Math.max(0, parseInt(ps.getPropertyValue('width'), 10));
      const es = getComputedStyle(t.element);
      const availH = h - (parseInt(es.getPropertyValue('padding-top'), 10) + parseInt(es.getPropertyValue('padding-bottom'), 10));
      const availW = w - (parseInt(es.getPropertyValue('padding-right'), 10) + parseInt(es.getPropertyValue('padding-left'), 10)) - scrollbar;
      return { cols: Math.max(2, Math.floor(availW / cell.width)), rows: Math.max(1, Math.floor(availH / cell.height)) };
    }
    fit() {
      const p = this.proposeDimensions();
      if (!p || !this.t || Number.isNaN(p.cols) || Number.isNaN(p.rows)) return;
      if (this.t.rows !== p.rows || this.t.cols !== p.cols) this.t.resize(p.cols, p.rows);
    }
  }
  let roCallback = null;
  globalThis.ResizeObserver = class {
    constructor(cb) { roCallback = cb; }
    observe() {}
    disconnect() { calls.push(['ro.disconnect']); }
  };
  globalThis.getComputedStyle = (el) => {
    if (el === container) {
      if (state.hidden) return styleOf({ position: 'absolute', width: 'auto', height: 'auto' });
      const c = content();
      return styleOf({ position: 'absolute', width: `${c.width}px`, height: `${c.height}px` });
    }
    return styleOf({
      position: 'relative', 'padding-top': '0px', 'padding-bottom': '0px', 'padding-left': '0px', 'padding-right': '0px',
    });
  };
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

// Хост 2254×1332 → контент 2246×1328 → (2246 − 14) / 8 = 279 колонок,
// 1328 / 19 = 69 строк: тот самый кадр со стенда.
function showWindow() {
  env.state.hidden = false;
  env.state.host = { width: 2254, height: 1332 };
}

function settle(t) {
  env.fireResize();
  t.mock.timers.tick(100);
}

test('вкладка в скрытом контейнере стартует БЕЗ размера и не шлёт resize', async (t) => {
  const view = await open(t);
  assert.deepStrictEqual(sent('start'), [['start', 'T1', null, null]], 'term:start ушёл с размером неподогнанного терминала');

  settle(t);
  assert.deepStrictEqual(sent('resize'), [], 'ResizeObserver скрытой вкладки снова прислал pty умолчание 80×24');
  assert.strictEqual(view.refit(), null, 'refit скрытой вкладки обязан сказать «не подогнан»');
  assert.deepStrictEqual(sent('resize'), []);
});

test('показ вкладки — первый и единственный размер, настоящий', async (t) => {
  await open(t);
  showWindow();
  settle(t);
  assert.deepStrictEqual(sent('resize'), [['resize', 'T1', 279, 69]]);
});

test('видимый контейнер при создании — старт сразу в настоящем размере', async (t) => {
  showWindow();
  await open(t);
  assert.deepStrictEqual(sent('start'), [['start', 'T1', 279, 69]]);
});

// Ревью в Chrome: хост 0×0 → client 8×4, FitAddon {2, 1} — и первая редакция
// это отправляла; хост 0×500 → client 8×500 и {2, 29}, которые main уже не
// отсекает (validDim 2..500): все pty уходили в две колонки.
for (const [name, host] of [
  ['свёрнутое окно (хост 0×0)', { width: 0, height: 0 }],
  ['узкое окно с диф-панелью (хост 0×500)', { width: 0, height: 500 }],
  ['ширина меньше двух клеток с полосой прокрутки (хост 30×500)', { width: 30, height: 500 }],
]) {
  test(`${name} — ни зажатой сетки в pty, ни ужатого xterm`, async (t) => {
    const grids = [];
    const view = await open(t, { onGrid: (s) => grids.push(s) });
    showWindow();
    settle(t);
    env.calls.length = 0;
    grids.length = 0;

    env.state.host = host;
    settle(t);
    assert.strictEqual(view.refit(), null, 'refit не сказал «не подогнан»');
    assert.deepStrictEqual(sent('resize'), [], 'в pty ушла зажатая сетка FitAddon');
    assert.deepStrictEqual(sent('xterm.resize'), [], 'xterm ужат — буфер переложится в две колонки');
    assert.deepStrictEqual(grids, [], 'зажатая сетка разнесена по скрытым вкладкам');
    assert.deepStrictEqual([view.term.cols, view.term.rows], [279, 69]);
  });
}

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
  env.state.font = { width: 8, height: 21 };
  onDone();
  assert.deepStrictEqual(sent('resize'), [['resize', 'T1', 279, 63]]); // 1328 / 21 = 63
  assert.strictEqual(sent('refresh').length, 1, 'после перемера экран не перерисован');
});

test('шрифт догрузился, а ресайз успел раньше loadingdone — строки всё равно пересчитаны', async (t) => {
  // Замечание ревью: xterm сам перемеряет ячейку в _afterResize. Если между
  // догрузкой шрифта и событием прошёл ресайз, fit посчитал строки по СТАРОЙ
  // ячейке, а замер после него уже видит новую. Обработчик, сравнивающий
  // ячейку до и после своего замера, видел «без изменений» и не подгонял.
  const view = await open(t);
  showWindow();
  view.refit();

  env.state.font = { width: 8, height: 21 }; // шрифт уже есть, замера ещё не было
  env.state.host = { width: 2262, height: 1332 }; // окно чуть шире: 280 колонок
  settle(t);
  assert.deepStrictEqual(sent('resize').at(-1), ['resize', 'T1', 280, 69], 'ресайз посчитан не по старой ячейке — сценарий не воспроизведён');
  env.calls.length = 0;

  env.fontListeners.get('loadingdone')();
  assert.deepStrictEqual(sent('resize'), [['resize', 'T1', 280, 63]], 'строки остались посчитаны по запасному шрифту');
});

test('догрузка шрифта у скрытой вкладки ячейку перемеряет, но pty не трогает', async (t) => {
  await open(t);
  env.state.font = { width: 8, height: 21 };
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
  settle(t);
  assert.deepStrictEqual(grids, [], 'неподогнанный терминал раздал свою сетку соседям');

  showWindow();
  settle(t);
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

test('adoptGrid: смена ТОЛЬКО строк или ТОЛЬКО колонок тоже доходит', async (t) => {
  // Замечание ревью: условие «сетка другая» стерегла только форма кода —
  // мутация `||` → `&&` выживала, и окно, ставшее ниже при той же ширине, не
  // доходило бы до скрытых вкладок.
  const view = await open(t);
  view.adoptGrid({ cols: 279, rows: 69 });
  view.adoptGrid({ cols: 279, rows: 50 });
  assert.deepStrictEqual([view.term.cols, view.term.rows], [279, 50], 'смена одних строк не дошла');
  view.adoptGrid({ cols: 200, rows: 50 });
  assert.deepStrictEqual([view.term.cols, view.term.rows], [200, 50], 'смена одних колонок не дошла');
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
