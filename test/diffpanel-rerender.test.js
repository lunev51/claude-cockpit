'use strict';
// Панель диффа не пересобирает неизменный дифф и не теряет прокрутку
// (ревью 09.08, C8).
//
// Панель перечитывает git:get на каждый git:changed (дебаунс 1,5 с) — пока
// Claude работает, это каждые пару секунд. Раньше каждый ответ сносил и
// заново строил до ~2200 узлов, даже если дифф тот же: выделение текста
// пропадало, строка файла в фокусе теряла фокус. Тест гоняет настоящий
// diffpanel.js на поддельном DOM, а снимок для него делает настоящий
// git-info.js из main (тот же объект, что уходит по IPC, — со свежим
// fetchedAt на каждом запросе после TTL кэша).
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createGitInfo } = require('../src/main/git-info');

const modUrl = (name) => pathToFileURL(
  path.join(__dirname, '..', 'src', 'renderer', 'js', name),
).href;

// --- поддельный DOM --------------------------------------------------------
//
// Прокрутка: высота строки 16, видимое окно 160×400. Браузер поджимает
// scrollTop/scrollLeft к новому содержимому на ближайшей раскладке. Chromium
// откладывает её, и прежний код прокрутку на деле не сбрасывал (ревью ветки
// проверило в headless Chrome). Подделка поджимает сразу при очистке — так
// было бы, если бы между очисткой и сборкой кто-то прочитал размеры. Ровно
// этот случай держит страховка в show(); тесты прокрутки ниже — про неё.

const LINE = 16;
const CHAR = 8;
const VIEW_H = 160;
const VIEW_W = 400;

function hasClass(n, c) {
  return typeof n.className === 'string' && n.className.split(/\s+/).includes(c);
}

function contentHeight(n) {
  if (hasClass(n, 'diff-file-row')) return LINE; // flex-строка: дети в ряд
  if (!n.children.length) return n._text ? LINE : 0;
  return n.children.reduce((s, c) => s + contentHeight(c), 0);
}

function contentWidth(n) {
  if (!n.children.length) return String(n._text || '').length * CHAR;
  return n.children.reduce((m, c) => Math.max(m, contentWidth(c)), 0);
}

function clamp(v, max) {
  return Math.max(0, Math.min(Number(v) || 0, Math.max(0, max)));
}

function makeDom() {
  const doc = {
    activeElement: null,
    addEventListener() {},
    removeEventListener() {},
  };

  function relayout(node) {
    for (let n = node; n; n = n.parent) {
      n._scrollTop = clamp(n._scrollTop, contentHeight(n) - VIEW_H);
      n._scrollLeft = clamp(n._scrollLeft, contentWidth(n) - VIEW_W);
    }
  }

  function el(tag) {
    const node = {
      tagName: tag.toUpperCase(),
      parent: null,
      children: [],
      listeners: {},
      className: '',
      title: '',
      type: '',
      tabIndex: -1,
      _text: '',
      _scrollTop: 0,
      _scrollLeft: 0,
      get classList() {
        const self = this;
        const list = () => self.className.split(/\s+/).filter(Boolean);
        return {
          add(c) { if (!list().includes(c)) self.className = [...list(), c].join(' '); },
          remove(c) { self.className = list().filter((x) => x !== c).join(' '); },
          contains: (c) => list().includes(c),
        };
      },
      get textContent() {
        return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text;
      },
      set textContent(v) {
        this.children = [];
        this._text = String(v);
        relayout(this);
      },
      get scrollTop() { return this._scrollTop; },
      set scrollTop(v) { this._scrollTop = clamp(v, contentHeight(this) - VIEW_H); },
      get scrollLeft() { return this._scrollLeft; },
      set scrollLeft(v) { this._scrollLeft = clamp(v, contentWidth(this) - VIEW_W); },
      appendChild(child) { child.parent = this; this.children.push(child); return child; },
      append(...nodes) { nodes.forEach((n) => this.appendChild(n)); },
      setAttribute() {},
      addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
      scrollIntoView() {},
    };
    return node;
  }

  doc.createElement = el;
  return { doc, el };
}

function findAll(node, className, out = []) {
  if (!node) return out;
  if (hasClass(node, className)) out.push(node);
  for (const c of node.children || []) findAll(c, className, out);
  return out;
}

function findOne(root, className) {
  const found = findAll(root, className);
  assert.strictEqual(found.length, 1, `элемент .${className} не найден — разметка панели изменилась, тест ничего не проверяет`);
  return found[0];
}

// --- git: настоящий git-info.js на подставленном run() ----------------------
//
// 12 изменённых файлов по 10 строк диффа — 120 строк текста и 12 строк
// списка файлов: обе области прокручиваются.

function makeRepo() {
  const state = { files: 12, edited: null };

  function fileName(i) { return `src/renderer/js/модуль-${String(i).padStart(2, '0')}.js`; }

  function statusOut() {
    const lines = ['## feat/visible-c-render...origin/feat/visible-c-render [ahead 1]'];
    for (let i = 0; i < state.files; i += 1) lines.push(` M ${fileName(i)}`);
    return `${lines.join('\n')}\n`;
  }

  function numstatOut() {
    const lines = [];
    for (let i = 0; i < state.files; i += 1) lines.push(`3\t1\t${fileName(i)}`);
    return `${lines.join('\n')}\n`;
  }

  function diffOut() {
    const out = [];
    for (let i = 0; i < state.files; i += 1) {
      const f = fileName(i);
      out.push(
        `diff --git a/${f} b/${f}`,
        'index 8343da4..e84a0b4 100644',
        `--- a/${f}`,
        `+++ b/${f}`,
        '@@ -26,4 +26,6 @@ function appRoot() {',
        '   const host = document.getElementById(\'diff-panel\'); // длинная строка контекста, шире окна панели',
        '-  return host;',
        `+  return host ?? null; // правка ${i}`,
        state.edited === i ? '+  // вторая правка, уже после первого чтения' : '+  // правка',
        '+  // ещё строка',
      );
    }
    return `${out.join('\n')}\n`;
  }

  const ok = (stdout) => ({ code: 0, stdout, stderr: '' });
  const run = async (args) => {
    if (args.includes('--numstat')) return ok(numstatOut());
    if (args.includes('status')) return ok(statusOut());
    if (args.includes('diff')) return ok(diffOut());
    throw new Error(`неожиданные args: ${JSON.stringify(args)}`);
  };

  // Часы идут на 5 с за обращение — больше TTL кэша git-info (3 с): каждый
  // git:get идёт в git заново и приносит новый fetchedAt, как у живой панели.
  let clock = Date.UTC(2026, 10, 5, 12, 0, 0);
  const info = createGitInfo({ run, now: () => (clock += 5000), cache: new Map() });
  const fetched = [];
  const repo = { state, fetched, hold: null };
  repo.api = {
    git: {
      async get(tabId, opts) {
        // IPC отдаёт копию: ссылка на прошлый ответ никогда не совпадает.
        const snap = structuredClone(await info.get(`C:\\proj\\${tabId}`, opts));
        // hold — ответ «ещё в пути»: тест сам решает, когда он долетит.
        if (repo.hold) await repo.hold;
        fetched.push(snap.fetchedAt);
        return snap;
      },
    },
  };
  return repo;
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  promise.resolve = resolve;
  return promise;
}

const flush = () => new Promise((resolve) => { setImmediate(resolve); });

async function setup(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dom = makeDom();
  globalThis.document = dom.doc;
  const { createDiffPanel } = await import(modUrl('diffpanel.js'));
  const repo = makeRepo();
  const root = dom.el('div');
  const panel = createDiffPanel({ root, api: repo.api });
  repo.panel = panel;
  panel.setActiveTab('t1');
  panel.open();
  await flush();

  const ui = {
    root,
    body: findOne(root, 'diff-panel-body'),
    files: findOne(root, 'diff-panel-files'),
    text: findOne(root, 'diff-panel-text'),
  };
  assert.strictEqual(ui.text.children.length, 120, 'дифф не нарисован — сценарий не воспроизведён');
  assert.strictEqual(ui.files.children.length, 12, 'список файлов не нарисован');

  // Человек долистал до середины диффа и сдвинул его вбок.
  ui.body.scrollTop = 900;
  ui.body.scrollLeft = 120;
  ui.files.scrollTop = 20;
  assert.deepStrictEqual(
    [ui.body.scrollTop, ui.body.scrollLeft, ui.files.scrollTop], [900, 120, 20],
    'прокрутка не встала — содержимого не хватает, тест ничего не проверяет',
  );

  // Тот путь, что дёргает панель каждые пару секунд: git:changed + дебаунс.
  async function gitChanged() {
    panel.handleGitChanged('t1');
    t.mock.timers.tick(1500);
    await flush();
  }
  return { ...ui, repo, ...repo, gitChanged };
}

test('тот же дифф второй раз: DOM не перестраивается, прокрутка на месте', async (t) => {
  const { text, files, body, fetched, gitChanged } = await setup(t);
  const lines = [...text.children];
  const rows = [...files.children];

  await gitChanged();

  assert.strictEqual(fetched.length, 2, 'второго git:get не было — сценарий не воспроизведён');
  assert.notStrictEqual(fetched[0], fetched[1], 'fetchedAt не сменился — проверка «по содержимому» не испытана');
  assert.strictEqual(text.children.length, lines.length);
  assert.ok(text.children.every((n, i) => n === lines[i]), 'строки диффа перестроены, хотя дифф тот же');
  assert.ok(files.children.every((n, i) => n === rows[i]), 'строки файлов перестроены, хотя список тот же');
  assert.deepStrictEqual([body.scrollTop, body.scrollLeft, files.scrollTop], [900, 120, 20], 'прокрутка сбита');
});

test('дифф изменился: новое содержимое, прокрутка на месте, при укорачивании — в пределах высоты', async (t) => {
  const { state, text, files, body, gitChanged } = await setup(t);

  state.edited = 5;
  await gitChanged();

  assert.ok(
    text.children.some((n) => n.textContent === '+  // вторая правка, уже после первого чтения'),
    'новая строка диффа не нарисована',
  );
  assert.deepStrictEqual(
    [body.scrollTop, body.scrollLeft, files.scrollTop], [900, 120, 20],
    'дифф обновился — и читателя выкинуло к началу',
  );

  // Дифф сократился до трёх файлов: 30 строк (480 px) — ниже 900 не
  // прокрутить, браузер прижмёт к концу. Обнулять прокрутку незачем.
  state.files = 3;
  await gitChanged();

  assert.strictEqual(text.children.length, 30, 'укороченный дифф не нарисован');
  assert.strictEqual(body.scrollTop, 30 * LINE - VIEW_H, 'прокрутка не прижата к концу укороченного диффа');
  assert.strictEqual(body.scrollLeft, 120, 'горизонтальная прокрутка сбита');
});

test('после «нет активной вкладки» тот же дифф рисуется заново', async (t) => {
  // Пропуск неизменного диффа сверяет с тем, что нарисовано. Пустое
  // состояние «нет активной вкладки» рисуется мимо снимков — без сброса
  // сверки возврат к той же вкладке оставил бы панель пустой.
  const { panel, text, root } = await setup(t);

  panel.setActiveTab(null);
  await flush();
  assert.strictEqual(text.children.length, 0, 'панель не опустела без активной вкладки');
  assert.strictEqual(findOne(root, 'diff-panel-empty').textContent, 'нет активной вкладки');

  panel.setActiveTab('t1');
  await flush();
  assert.strictEqual(text.children.length, 120, 'вернулись к вкладке с тем же диффом — а панель пустая');
});

test('закрыли панель, пока летел git:get, дифф изменился — при открытии новый дифф', async (t) => {
  // Ответ долетает в закрытую панель: рисовать некуда, и запоминать его как
  // «нарисованный» нельзя — иначе при открытии тот же снимок совпадёт со
  // сверкой и на экране останется прежний дифф.
  const { repo, panel, state, text, gitChanged } = await setup(t);

  state.edited = 5;
  repo.hold = deferred();
  await gitChanged(); // запрос ушёл, ответ в пути
  panel.close(); // Ctrl+G
  const hold = repo.hold;
  repo.hold = null;
  hold.resolve();
  await flush();

  panel.open();
  await flush();

  assert.ok(
    text.children.some((n) => n.textContent === '+  // вторая правка, уже после первого чтения'),
    'открыли панель после изменения диффа — а на экране прежний',
  );
});
