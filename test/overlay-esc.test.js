'use strict';
// Esc закрывает палитру и поиск истории, где бы внутри ни был фокус
// (ревью 09.08, C11).
//
// Оба оверлея слушали Esc только на своём поле ввода. Клик по паддингу
// панели (обычный div без tabindex) уводит фокус на <body> — и клавиша до
// поля больше не доходила: оверлей висел, пока не кликнешь мимо него.
// Дашборд, peek и шпаргалка этим не страдают: они слушают Esc на document,
// пока открыты. Тест гоняет настоящие palette.js и search.js на минимальном
// поддельном DOM — ровно на том, чем они пользуются.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const modUrl = (name) => pathToFileURL(
  path.join(__dirname, '..', 'src', 'renderer', 'js', name),
).href;

// --- поддельный DOM --------------------------------------------------------

function makeDom() {
  const doc = {
    activeElement: null,
    listeners: [], // { type, fn, capture }
    addEventListener(type, fn, opts) {
      const capture = opts === true || !!(opts && opts.capture);
      this.listeners.push({ type, fn, capture });
    },
    removeEventListener(type, fn, opts) {
      const capture = opts === true || !!(opts && opts.capture);
      this.listeners = this.listeners.filter((l) => !(l.type === type && l.fn === fn && l.capture === capture));
    },
    createTextNode: (text) => ({ text, parent: null }),
    contains(node) {
      for (let n = node; n; n = n.parent) if (n === doc.body) return true;
      return false;
    },
  };

  function el(tag) {
    const node = {
      tagName: tag.toUpperCase(),
      parent: null,
      children: [],
      listeners: [],
      style: {},
      className: '',
      value: '',
      type: '',
      placeholder: '',
      title: '',
      focusCalls: 0,
      classList: { toggle() {}, add() {}, remove() {} },
      _text: '',
      get textContent() { return this._text; },
      set textContent(v) { this.children = []; this._text = v; },
      appendChild(child) { child.parent = this; this.children.push(child); return child; },
      remove() {
        if (!this.parent) return;
        this.parent.children = this.parent.children.filter((c) => c !== this);
        this.parent = null;
        // Удалённый из DOM сфокусированный элемент отдаёт фокус <body> —
        // как в браузере.
        if (doc.activeElement && !doc.contains(doc.activeElement)) doc.activeElement = doc.body;
      },
      addEventListener(type, fn, opts) {
        const capture = opts === true || !!(opts && opts.capture);
        this.listeners.push({ type, fn, capture });
      },
      removeEventListener(type, fn, opts) {
        const capture = opts === true || !!(opts && opts.capture);
        this.listeners = this.listeners.filter((l) => !(l.type === type && l.fn === fn && l.capture === capture));
      },
      focus() { this.focusCalls += 1; doc.activeElement = this; },
      querySelector: () => null,
      scrollIntoView() {},
    };
    return node;
  }

  doc.createElement = el;
  doc.createDocumentFragment = () => el('#fragment');
  doc.body = el('body');
  doc.activeElement = doc.body;

  // Нажатие клавиши: адресат — элемент в фокусе, как в браузере. Путь
  // события снят ДО раздачи (оверлей может уйти из DOM посреди неё):
  // capture document → capture предков → цель → всплытие предков → document.
  function press(key) {
    const target = doc.activeElement || doc.body;
    const ev = {
      key,
      target,
      defaultPrevented: false,
      stopped: false,
      immediate: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.stopped = true; },
      stopImmediatePropagation() { this.stopped = true; this.immediate = true; },
    };
    const chain = [];
    for (let n = target; n; n = n.parent) chain.push(n);
    const run = (list, capture) => {
      for (const l of [...list]) {
        if (ev.immediate) return;
        if (l.type !== 'keydown' || l.capture !== capture) continue;
        l.fn(ev);
      }
    };
    run(doc.listeners, true);
    for (const n of [...chain].reverse()) { if (ev.stopped) return ev; if (n !== target) run(n.listeners, true); }
    if (!ev.stopped) { run(target.listeners, true); run(target.listeners, false); }
    for (const n of chain.slice(1)) { if (ev.stopped) return ev; run(n.listeners, false); }
    if (!ev.stopped) run(doc.listeners, false);
    return ev;
  }

  return { doc, el, press };
}

// --- оба оверлея по одной схеме -------------------------------------------

const OVERLAYS = [
  {
    name: 'палитра',
    async create(root) {
      const { createPalette } = await import(modUrl('palette.js'));
      return createPalette({ root, getActions: () => [{ title: 'Тест', run() {} }] });
    },
  },
  {
    name: 'поиск истории',
    async create(root) {
      const { createSearch } = await import(modUrl('search.js'));
      return createSearch({
        root,
        api: { history: { search: async () => ({ results: [], indexSize: 0 }) } },
        onOpenResult() {},
      });
    },
  },
];

async function setup(overlay) {
  const dom = makeDom();
  globalThis.document = dom.doc;
  const root = dom.el('div');
  dom.doc.body.appendChild(root);
  // Стоит за терминал: фокус до открытия — на нём, и при закрытии обязан
  // вернуться к нему же.
  const term = dom.el('textarea');
  root.appendChild(term);
  term.focus();
  term.focusCalls = 0;
  const ui = await overlay.create(root);
  return { ...dom, root, term, ui };
}

for (const overlay of OVERLAYS) {
  test(`${overlay.name}: Esc закрывает, когда фокус ушёл кликом по панели`, async () => {
    const { doc, term, ui, press } = await setup(overlay);
    ui.open();
    assert.ok(ui.isOpen());
    // Клик по паддингу панели — не фокусируемый div: фокус уходит на <body>.
    doc.activeElement = doc.body;

    const ev = press('Escape');

    assert.strictEqual(ui.isOpen(), false, 'Esc с фокусом вне поля не закрыл оверлей — он висит до клика мимо');
    assert.ok(ev.defaultPrevented, 'Esc не погашен: preventDefault не вызван');
    assert.strictEqual(doc.activeElement, term, 'после закрытия фокус не вернулся терминалу');
  });

  test(`${overlay.name}: Esc в поле ввода по-прежнему закрывает — ровно один раз`, async () => {
    const { doc, term, ui, press } = await setup(overlay);
    ui.open();
    assert.notStrictEqual(doc.activeElement, term, 'open() не перевёл фокус в поле ввода');

    press('Escape');

    assert.strictEqual(ui.isOpen(), false, 'Esc в поле ввода больше не закрывает оверлей');
    assert.strictEqual(term.focusCalls, 1, 'фокус возвращали терминалу не один раз — Esc обработан дважды');
  });

  test(`${overlay.name}: закрытие снимает слушатель с document`, async () => {
    const { doc, ui, press } = await setup(overlay);
    const before = doc.listeners.length;
    ui.open();
    ui.close();
    assert.strictEqual(
      doc.listeners.length, before,
      'после закрытия на document остался слушатель — копятся с каждым открытием',
    );
    // И повторное открытие после закрытия снова слушает Esc.
    ui.open();
    doc.activeElement = doc.body;
    press('Escape');
    assert.strictEqual(ui.isOpen(), false, 'после повторного открытия Esc вне поля не закрывает');
  });

  test(`${overlay.name}: Esc не достаётся restore, подписанному позже оверлея`, async () => {
    // Обработчик restore (app.js/showRestoreOverlay) тоже на document в
    // capture и уступает, только пока открыт другой оверлей. Подписан он не
    // всегда раньше: bootWorkspace ждёт IPC до показа restore, а для зрителя
    // проходит заново после захвата управления. Если оверлей, закрывшись,
    // пропустит Esc дальше, restore решит «начать пусто» за спиной человека.
    const { doc, ui, press } = await setup(overlay);
    ui.open();
    let startEmpty = 0;
    doc.addEventListener('keydown', (ev) => {
      if (ui.isOpen()) return; // otherOverlayOpen('restore')
      if (ev.key === 'Escape') startEmpty += 1;
    }, true);

    press('Escape');

    assert.strictEqual(ui.isOpen(), false);
    assert.strictEqual(startEmpty, 0, 'тот же Esc после закрытия оверлея долетел до restore — «начать пусто» без спроса');
  });

  test(`${overlay.name}: другие клавиши вне поля оверлей не закрывают`, async () => {
    const { doc, ui, press } = await setup(overlay);
    ui.open();
    doc.activeElement = doc.body;
    press('a');
    press('Enter');
    assert.strictEqual(ui.isOpen(), true, 'оверлей закрылся не по Esc');
  });
}
