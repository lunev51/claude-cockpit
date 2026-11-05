'use strict';
// Шпаргалка ↔ настоящие привязки терминала (ревью 09.08, C13).
//
// Шпаргалка (hotkeys.js) — список, собранный руками: источника правды в
// рантайме нет, хоткеи зашиты в обработчиках terminal.js. Так она и отстала:
// Ctrl+«+»/«−»/«0» и Ctrl+колесо работали с первой фазы, Ctrl+V — с 05.08, а
// в шпаргалке их не было, и человек о них не знал.
//
// Проверяем не текст исходника, а поведение: поднимаем настоящий initTerminal
// на фейковом окружении (xterm, DOM и мост window.api — заглушки) и жмём ту
// самую комбинацию, что написана в строке шпаргалки. Каждое утверждение —
// пара: строка в шпаргалке есть И клавиша делает то, что строка обещает.
// Пропадёт строка — красный; пропадёт или сменится привязка — красный.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer', 'js');
const modUrl = (name) => pathToFileURL(path.join(RENDERER, name)).href;

// --- фейковое окружение renderer ---

function fakeEl() {
  const listeners = {};
  return {
    style: {},
    listeners,
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener() {},
    append() {},
    appendChild() {},
    contains: () => false,
    focus() {},
    select() {},
  };
}

class FakeTerminal {
  constructor(opts) {
    this.options = { ...opts };
    this.cols = 80;
    this.rows = 24;
    this.selection = '';
    this.pasted = [];
    this.keyHandler = null;
  }
  loadAddon() {}
  open() {}
  write() {}
  focus() {}
  onData() {}
  onSelectionChange() {}
  attachCustomKeyEventHandler(fn) { this.keyHandler = fn; }
  getSelection() { return this.selection; }
  hasSelection() { return !!this.selection; }
  clearSelection() { this.selection = ''; }
  paste(text) { this.pasted.push(text); }
  resize() {}
  refresh() {}
  dispose() {}
}

const calls = { screenshotPaste: [], clipboardWrite: [] };

function installGlobals() {
  globalThis.window = {
    Terminal: FakeTerminal,
    // proposeDimensions → undefined: терминал «не подогнан», в pty размер не
    // уходит — для клавиш это не важно.
    FitAddon: { FitAddon: class { proposeDimensions() { return undefined; } fit() {} } },
    WebLinksAddon: { WebLinksAddon: class {} },
    SearchAddon: { SearchAddon: class { findNext() {} findPrevious() {} } },
    SerializeAddon: { SerializeAddon: class { serialize() { return ''; } } },
    dispatchEvent() {},
    api: {
      shell: { openExternal() {} },
      term: { resize() {}, start() {}, write() {}, restart() {} },
      config: { set() {} },
      screenshot: {
        // null — в буфере не картинка: дальше идёт текстовая вставка.
        paste: async (tabId) => { calls.screenshotPaste.push(tabId); return null; },
      },
    },
  };
  globalThis.document = { createElement: () => fakeEl() };
  globalThis.getComputedStyle = () => ({ position: 'relative', width: '800px', height: '600px' });
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  // Окно на ПК: Clipboard API есть (в Electron страница — защищённый контекст).
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: {
      clipboard: {
        readText: async () => 'из буфера',
        writeText: async (text) => { calls.clipboardWrite.push(text); },
      },
    },
  });
}

const FONT = 14;

async function makeTerminal() {
  installGlobals();
  const { initTerminal } = await import(modUrl('terminal.js'));
  const container = fakeEl();
  const view = initTerminal(container, { terminal: { fontSize: FONT, fontFamily: 'x', scrollback: 1000 } }, {
    tabId: 't1',
  });
  const term = view.term;
  assert.ok(term.keyHandler, 'initTerminal не повесил обработчик клавиш xterm');
  return {
    view,
    term,
    // Возвращает то же, что xterm получил бы от обработчика: false — «клавиша
    // наша, в pty не слать».
    key(init) {
      const ev = {
        type: 'keydown', key: '', code: '',
        ctrlKey: false, shiftKey: false, altKey: false, metaKey: false,
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
        ...init,
      };
      return { ret: term.keyHandler(ev), ev };
    },
    wheel(init) {
      const ev = {
        ctrlKey: false, deltaY: 0, defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
        ...init,
      };
      for (const fn of container.listeners.wheel || []) fn(ev);
      return ev;
    },
    fontSize: () => term.options.fontSize,
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function cheatsheetRows() {
  const { GROUPS } = await import(modUrl('hotkeys.js'));
  assert.ok(Array.isArray(GROUPS), 'hotkeys.js не отдаёт GROUPS — тест не видит шпаргалку');
  return GROUPS.flatMap((g) => g.keys.map(([combo, desc]) => ({ combo, desc })));
}

// Строка шпаргалки, где комбинация совпала с re, а описание — с descRe.
async function row(re, descRe, what) {
  const rows = await cheatsheetRows();
  const found = rows.find((r) => re.test(r.combo));
  assert.ok(found, `в шпаргалке нет строки про ${what} (ищу комбинацию ${re})`);
  assert.match(found.desc, descRe, `строка «${found.combo}» в шпаргалке не про ${what}: «${found.desc}»`);
  return found;
}

test('Ctrl+«+» и Ctrl+«−»: в шпаргалке есть, и шрифт правда меняется', async () => {
  await row(/Ctrl\+«\+»/, /шрифт/i, 'увеличение шрифта');
  // «−» пишется и сокращённо — «Ctrl+«+»/«−»», лишь бы с Ctrl.
  await row(/Ctrl\+(«\+»\s*\/\s*)?«−»/, /шрифт/i, 'уменьшение шрифта');

  const t = await makeTerminal();
  // «+» без Shift на основной клавиатуре — это клавиша «=» (code Equal).
  let r = t.key({ ctrlKey: true, key: '=', code: 'Equal' });
  assert.strictEqual(r.ret, false, 'Ctrl+«+» ушёл бы в pty');
  assert.strictEqual(t.fontSize(), FONT + 1, 'Ctrl+«+» не увеличил шрифт');
  // M1 ревью ветки: false от обработчика xterm событие не гасит (_keyDown,
  // xterm 6), и Chrome в браузере на ПК вместе со шрифтом масштабировал всю
  // страницу. Тот же preventDefault, что у Ctrl+колеса.
  assert.ok(r.ev.defaultPrevented, 'Ctrl+«+» не погасил зум страницы в браузере');
  r = t.key({ ctrlKey: true, key: '+', code: 'NumpadAdd' });
  assert.strictEqual(t.fontSize(), FONT + 2, 'Ctrl+«+» на цифровом блоке не увеличил шрифт');
  assert.ok(r.ev.defaultPrevented, 'Ctrl+«+» на цифровом блоке не погасил зум страницы');
  r = t.key({ ctrlKey: true, key: '-', code: 'Minus' });
  assert.strictEqual(r.ret, false, 'Ctrl+«−» ушёл бы в pty');
  assert.strictEqual(t.fontSize(), FONT + 1, 'Ctrl+«−» не уменьшил шрифт');
  assert.ok(r.ev.defaultPrevented, 'Ctrl+«−» не погасил зум страницы в браузере');
  t.view.dispose();
});

test('Ctrl+0: в шпаргалке есть, и шрифт возвращается к размеру при запуске', async () => {
  await row(/Ctrl\+0/, /шрифт/i, 'сброс размера шрифта');

  const t = await makeTerminal();
  t.key({ ctrlKey: true, key: '=', code: 'Equal' });
  t.key({ ctrlKey: true, key: '=', code: 'Equal' });
  assert.strictEqual(t.fontSize(), FONT + 2);
  const r = t.key({ ctrlKey: true, key: '0', code: 'Digit0' });
  assert.strictEqual(r.ret, false, 'Ctrl+0 ушёл бы в pty');
  assert.strictEqual(t.fontSize(), FONT, 'Ctrl+0 не вернул шрифт к размеру из конфига');
  assert.ok(r.ev.defaultPrevented, 'Ctrl+0 не погасил сброс зума страницы в браузере');
  t.view.dispose();
});

test('Ctrl+колесо: в шпаргалке есть, и шрифт меняется без зума страницы', async () => {
  await row(/Ctrl\+колесо/, /шрифт/i, 'шрифт колесом');

  const t = await makeTerminal();
  let ev = t.wheel({ ctrlKey: true, deltaY: -100 });
  assert.strictEqual(t.fontSize(), FONT + 1, 'Ctrl+колесо вверх не увеличил шрифт');
  assert.ok(ev.defaultPrevented, 'Ctrl+колесо не погасил зум страницы');
  ev = t.wheel({ ctrlKey: true, deltaY: 100 });
  assert.strictEqual(t.fontSize(), FONT, 'Ctrl+колесо вниз не уменьшил шрифт');
  // Без Ctrl колесо — обычная прокрутка, шрифт не трогаем.
  ev = t.wheel({ deltaY: -100 });
  assert.strictEqual(t.fontSize(), FONT, 'колесо без Ctrl поменяло шрифт');
  assert.ok(!ev.defaultPrevented, 'колесо без Ctrl погашено — прокрутка умерла бы');
  t.view.dispose();
});

test('вставка: шпаргалка называет обычный Ctrl+V, и он правда вставляет', async () => {
  // Именно обычный Ctrl+V (без Shift): ради него и правка 05.08 — по
  // умолчанию xterm слал бы его в pty как 0x16 и ничего не вставлял.
  await row(/(^|[^+\w])Ctrl\+V\b/, /встав/i, 'вставку обычным Ctrl+V');
  await row(/Ctrl\+Shift\+V/, /встав/i, 'вставку Ctrl+Shift+V');

  for (const shiftKey of [false, true]) {
    const t = await makeTerminal();
    calls.screenshotPaste.length = 0;
    const r = t.key({ ctrlKey: true, shiftKey, key: shiftKey ? 'V' : 'v', code: 'KeyV' });
    const name = shiftKey ? 'Ctrl+Shift+V' : 'Ctrl+V';
    assert.strictEqual(r.ret, false, `${name} ушёл бы в pty`);
    assert.deepStrictEqual(calls.screenshotPaste, ['t1'], `${name} не проверил скриншот в буфере`);
    await flush();
    await flush();
    assert.deepStrictEqual(t.term.pasted, ['из буфера'], `${name} не вставил текст из буфера`);
    t.view.dispose();
  }
});

test('копирование: шпаргалка называет Ctrl+Shift+C, и он правда копирует выделение', async () => {
  await row(/Ctrl\+Shift\+C/, /копир/i, 'копирование');

  const t = await makeTerminal();
  calls.clipboardWrite.length = 0;
  t.term.selection = 'выделено';
  const r = t.key({ ctrlKey: true, shiftKey: true, key: 'C', code: 'KeyC' });
  assert.strictEqual(r.ret, false, 'Ctrl+Shift+C ушёл бы в pty');
  await flush();
  assert.deepStrictEqual(calls.clipboardWrite, ['выделено'], 'Ctrl+Shift+C не скопировал выделение');
  t.view.dispose();
});
