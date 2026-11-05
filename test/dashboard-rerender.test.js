'use strict';
// Дашборд: тик 30 с обновляет только «сброс через …», не пересобирая
// оверлей (ревью 09.08, C9).
//
// app.js раз в 30 с зовёт redrawUsageViews() → dashboard.render() с тем же
// снимком и новым now — ради одной строки обратного отсчёта. Раньше render()
// сносил и строил весь оверлей: подсказка у столбика под курсором слетала на
// «наведи на столбик», выделение в таблице пропадало, кнопка в фокусе теряла
// фокус. Тест гоняет настоящий dashboard.js на поддельном DOM; getData()
// собирает снимок так же, как app.js/dashboardSnapshot() — новый объект на
// каждый вызов из тех же lastUsage/lastGh/nightState.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const modUrl = (name) => pathToFileURL(
  path.join(__dirname, '..', 'src', 'renderer', 'js', name),
).href;

// --- поддельный DOM --------------------------------------------------------

function hasClass(n, c) {
  return typeof n.className === 'string' && n.className.split(/\s+/).includes(c);
}

function makeDom() {
  const doc = {
    activeElement: null,
    addEventListener() {},
    removeEventListener() {},
    contains(node) {
      for (let n = node; n; n = n.parent) if (n === doc.body) return true;
      return false;
    },
  };
  function el(tag) {
    return {
      tagName: tag.toUpperCase(),
      parent: null,
      children: [],
      listeners: {},
      className: '',
      title: '',
      type: '',
      disabled: false,
      style: {},
      _text: '',
      get classList() {
        const self = this;
        const list = () => self.className.split(/\s+/).filter(Boolean);
        const set = (c, on) => {
          const rest = list().filter((x) => x !== c);
          self.className = (on ? [...rest, c] : rest).join(' ');
        };
        return {
          add: (c) => set(c, true),
          remove: (c) => set(c, false),
          toggle: (c, force) => set(c, force === undefined ? !list().includes(c) : !!force),
          contains: (c) => list().includes(c),
        };
      },
      get textContent() {
        return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text;
      },
      set textContent(v) { this.children = []; this._text = String(v); },
      appendChild(child) { child.parent = this; this.children.push(child); return child; },
      append(...nodes) { nodes.forEach((n) => this.appendChild(n)); },
      setAttribute() {},
      addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
      removeEventListener() {},
      remove() {
        if (!this.parent) return;
        this.parent.children = this.parent.children.filter((c) => c !== this);
        this.parent = null;
      },
      focus() { doc.activeElement = this; },
    };
  }
  doc.createElement = el;
  doc.body = el('body');
  doc.activeElement = doc.body;
  return { doc, el };
}

function fire(node, type) {
  for (const fn of node.listeners[type] || []) fn({ type, target: node, preventDefault() {} });
}

function findAll(node, className, out = []) {
  if (!node) return out;
  if (hasClass(node, className)) out.push(node);
  for (const c of node.children || []) findAll(c, className, out);
  return out;
}

function findOne(root, className) {
  const found = findAll(root, className);
  assert.strictEqual(found.length, 1, `элемент .${className} не найден — разметка дашборда изменилась, тест ничего не проверяет`);
  return found[0];
}

const texts = (nodes) => nodes.map((n) => n.textContent);

// --- данные той формы, что отдаёт main --------------------------------------
//
// Сроки сброса — с запасом в 30 с: open() рисует с настоящим Date.now(),
// который успевает уйти на миллисекунды от T0.

const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function makeState(T0) {
  const weekReset = T0 + 3 * DAY + 5 * HOUR + 30000;
  // usage-oauth.js/snapshot() после удачного опроса.
  const limits = {
    ok: true,
    stale: false,
    fetchedAt: T0 - 2 * MIN,
    fiveHour: { percent: 42, resetsAt: T0 + 2 * HOUR + 30 * MIN + 30000 },
    sevenDay: { percent: 63, resetsAt: weekReset },
    scoped: [{ label: 'Opus', percent: 12, resetsAt: weekReset }],
    error: null,
  };
  // usage-ccusage.js/buildResult(): byDay — 30 последних дней по возрастанию.
  const byDay = [];
  for (let i = 29; i >= 0; i -= 1) {
    const d = new Date(T0 - i * DAY);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    byDay.push({ date: iso, costUsd: 20 + (i % 7), tokens: 40000000 + i * 1000 });
  }
  const spend = {
    ok: true,
    stale: false,
    fetchedAt: T0 - 5 * MIN,
    error: null,
    totals: { costUsd: 3497.12, tokens: 2100000000, sessions: 812 },
    byProject: [
      { name: 'C--Users-Lunev-AssistClaude-claude-cockpit', costUsd: 812.4, tokens: 990000000, lastActive: T0 - HOUR },
      { name: 'C--Users-Lunev-helper', costUsd: 120.05, tokens: 150000000, lastActive: T0 - 2 * DAY },
    ],
    byDay,
    byModel: [{ model: 'claude-opus-4-5', costUsd: 3000, tokens: 1900000000 }],
  };
  // gh-info.js/getGlobal(), удачный ответ.
  const gh = {
    ok: true,
    error: null,
    prs: [{
      repo: 'lunev51/claude-cockpit', number: 53, title: 'fix: перерисовки', checks: 'passing', url: 'https://github.com/lunev51/claude-cockpit/pull/53',
    }],
    issues: [],
    notifications: 3,
    prsAtLimit: false,
    issuesAtLimit: false,
    notificationsAtLimit: false,
    fetchedAt: T0 - MIN,
  };
  // night-watch.js/snapshot().
  const night = {
    armed: false, pendingCount: 0, wakeAt: null, resetsHandled: 0, journal: [],
  };
  return { usage: { limits, spend }, gh, night };
}

async function setup() {
  const dom = makeDom();
  globalThis.document = dom.doc;
  const { createDashboard } = await import(modUrl('dashboard.js'));
  const T0 = Date.now();
  const state = makeState(T0);
  const root = dom.el('div');
  dom.doc.body.appendChild(root);
  // app.js/dashboardSnapshot(): { ...lastUsage, gh: lastGh, night: nightState }.
  const getData = () => ({ ...state.usage, gh: state.gh, night: state.night });
  const dash = createDashboard({
    root,
    getData,
    onRefresh: async () => state.usage,
    onOpen() {},
    fallbackFocus: () => null,
    api: { shell: { openExternal() {} } },
    resolveTabName: () => '',
  });
  dash.open();
  // Тик app.js: redrawUsageViews(now) → dashboard.render(dashboardSnapshot(), now).
  const tick = (now) => dash.render(getData(), now);
  return {
    dom, root, dash, state, T0, tick,
  };
}

const sections = (root) => [...findOne(root, 'dashboard-body').children];

test('тик 30 с: секции те же, «сброс через …» пересчитан', async () => {
  const { root, T0, tick } = await setup();
  const before = sections(root);
  const resets = findAll(root, 'limit-bar-reset');
  assert.ok(before.length >= 6, 'секций дашборда меньше ожидаемого — сценарий не воспроизведён');
  assert.deepStrictEqual(
    texts(resets),
    ['сброс через 2ч 30м', 'сброс через 3д 5ч', 'сброс через 3д 5ч'],
    'исходные отсчёты не те — сценарий не воспроизведён',
  );

  tick(T0 + 31 * MIN);

  const after = sections(root);
  assert.strictEqual(after.length, before.length);
  assert.ok(after.every((n, i) => n === before[i]), 'тик 30 с пересобрал секции дашборда — данные не менялись');
  assert.ok(findAll(root, 'limit-bar-reset').every((n, i) => n === resets[i]), 'строки отсчёта заменены новыми узлами');
  assert.deepStrictEqual(
    texts(resets),
    ['сброс через 1ч 59м', 'сброс через 3д 4ч', 'сброс через 3д 4ч'],
    'отсчёт не обновился тиком',
  );
});

test('подсказка у столбика под курсором переживает тик', async () => {
  const { root, T0, tick } = await setup();
  const cols = findAll(root, 'chart-col');
  assert.strictEqual(cols.length, 7, 'столбиков не 7 — сценарий не воспроизведён');
  fire(cols[6], 'mouseenter');
  const hovered = findOne(root, 'dashboard-chart-hint').textContent;
  assert.notStrictEqual(hovered, '$ за день · наведи на столбик', 'наведение не сработало — сценарий не воспроизведён');

  tick(T0 + 30000);

  assert.strictEqual(
    findOne(root, 'dashboard-chart-hint').textContent, hovered,
    'тик сбросил подсказку столбика, хотя курсор всё ещё на нём',
  );
});

test('новые данные — пересборка, и тик дальше считает новые строки', async () => {
  const { root, state, T0, tick } = await setup();
  const before = sections(root);
  const oldResets = findAll(root, 'limit-bar-reset');

  // usage:update: опрос принёс новые цифры и новый срок сброса 5-часового окна.
  state.usage = {
    ...state.usage,
    limits: {
      ...state.usage.limits,
      fetchedAt: T0,
      fiveHour: { percent: 55, resetsAt: T0 + 4 * HOUR + 30000 },
    },
  };
  tick(T0 + MIN);

  assert.ok(sections(root).every((n) => !before.includes(n)), 'новые данные не пересобрали дашборд');
  assert.strictEqual(findAll(root, 'limit-bar-pct')[0].textContent, '55%', 'новый процент не нарисован');
  const resets = findAll(root, 'limit-bar-reset');
  assert.strictEqual(resets[0].textContent, 'сброс через 3ч 59м');

  tick(T0 + 31 * MIN);
  assert.strictEqual(resets[0].textContent, 'сброс через 3ч 29м', 'после пересборки тик не обновляет новые строки отсчёта');
  assert.deepStrictEqual(
    texts(oldResets),
    ['сброс через 2ч 30м', 'сброс через 3д 5ч', 'сброс через 3д 5ч'],
    'тик трогает узлы прежней сборки — список отсчётов копится с каждой пересборкой',
  );
});

test('переключение 7д/30д перерисовывает график, хотя данные те же', async () => {
  const { root } = await setup();
  assert.strictEqual(findAll(root, 'chart-col').length, 7);
  const btn30 = findAll(root, 'chart-preset').find((b) => b.textContent === '30д');
  assert.ok(btn30, 'кнопки «30д» нет — разметка изменилась');

  fire(btn30, 'click');

  assert.strictEqual(findAll(root, 'chart-col').length, 30, '«30д» нажата, а график остался за 7 дней');
  const active = findAll(root, 'chart-preset').filter((b) => b.classList.contains('active'));
  assert.deepStrictEqual(texts(active), ['30д']);
});

test('закрыть и открыть снова — дашборд нарисован, не пустой', async () => {
  const { root, dash } = await setup();
  const count = sections(root).length;
  dash.close();
  dash.open();
  assert.strictEqual(sections(root).length, count, 'повторно открытый дашборд пуст — сверка осталась от прошлого открытия');
});
