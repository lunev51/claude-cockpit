'use strict';
// Окраска лимитов и «обновлено в HH:MM» — на настоящих rings.js и dashboard.js
// (ревью 09.08, C14).
//
// Пороги и формат времени теперь живут одной копией в format.js (там же их
// тест, format.test.js). Здесь — что оба потребителя этой копией и рисуют:
// кольцо сайдбара и полоса дашборда одного и того же лимита обязаны быть
// одного цвета на любой границе. Поддельный DOM — ровно то, чем пользуются
// renderRings и render() дашборда.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const modUrl = (name) => pathToFileURL(
  path.join(__dirname, '..', 'src', 'renderer', 'js', name),
).href;

function makeDom() {
  const doc = {
    addEventListener() {},
    removeEventListener() {},
    contains: () => false,
    activeElement: null,
  };
  function el(tag) {
    const props = {};
    return {
      tagName: tag.toUpperCase(),
      parent: null,
      children: [],
      className: '',
      title: '',
      dataset: {},
      style: { setProperty: (k, v) => { props[k] = v; }, props },
      classList: { toggle() {}, add() {}, remove() {} },
      _text: '',
      get textContent() { return this._text; },
      set textContent(v) { this.children = []; this._text = v; },
      appendChild(child) { child.parent = this; this.children.push(child); return child; },
      append(...nodes) { nodes.forEach((n) => this.appendChild(n)); },
      setAttribute() {},
      removeAttribute() {},
      addEventListener() {},
      removeEventListener() {},
      remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); },
      focus() { doc.activeElement = this; },
      querySelector: () => null,
    };
  }
  doc.createElement = el;
  doc.createTextNode = (text) => ({ text, children: [] });
  doc.createDocumentFragment = () => el('#fragment');
  doc.body = el('body');
  return { doc, el };
}

function findAll(node, className, out = []) {
  if (!node) return out;
  if (typeof node.className === 'string' && node.className.split(/\s+/).includes(className)) out.push(node);
  for (const c of node.children || []) findAll(c, className, out);
  return out;
}

// Граница каждого порога с обеих сторон: 59/60 и 85/86.
const CASES = [[59, 'var(--ok)'], [60, 'var(--warn)'], [85, 'var(--warn)'], [86, 'var(--err)']];
const NOW = new Date(2026, 10, 5, 12, 0, 0).getTime();
const FETCHED = new Date(2026, 10, 5, 9, 7, 0).getTime();

function snapshot(fiveHour, sevenDay) {
  return {
    ok: true,
    stale: false,
    fetchedAt: FETCHED,
    fiveHour: { percent: fiveHour, resetsAt: NOW + 3600000 },
    sevenDay: { percent: sevenDay, resetsAt: NOW + 86400000 },
  };
}

test('кольца сайдбара красятся по общим порогам', async () => {
  const dom = makeDom();
  globalThis.document = dom.doc;
  const { renderRings } = await import(modUrl('rings.js'));
  for (const [pct, color] of CASES) {
    const host = dom.el('div');
    renderRings(host, snapshot(pct, pct), NOW);
    const rings = findAll(host, 'ring-visual');
    assert.strictEqual(rings.length, 2, 'колец не два — разметка renderRings изменилась, тест ничего не проверяет');
    for (const r of rings) assert.strictEqual(r.style.props['--ring-color'], color, `кольцо на ${pct}%`);
  }
  // Нет данных — нейтральный цвет, а не «ok».
  const host = dom.el('div');
  renderRings(host, { ok: false }, NOW);
  for (const r of findAll(host, 'ring-visual')) assert.strictEqual(r.style.props['--ring-color'], 'var(--text-dim)');
});

test('полосы дашборда красятся по тем же порогам и подписаны временем получения', async () => {
  const dom = makeDom();
  globalThis.document = dom.doc;
  const { createDashboard } = await import(modUrl('dashboard.js'));
  for (const [pct, color] of CASES) {
    const root = dom.el('div');
    const dash = createDashboard({
      root,
      getData: () => ({ limits: snapshot(pct, pct), spend: null }),
      onRefresh: async () => null,
      onOpen() {},
      fallbackFocus: () => null,
      api: {},
      resolveTabName: () => '',
    });
    dash.open();
    const fills = findAll(root, 'limit-bar-fill');
    assert.strictEqual(fills.length, 2, 'полос лимитов не две — разметка дашборда изменилась, тест ничего не проверяет');
    for (const f of fills) assert.strictEqual(f.style.background, color, `полоса на ${pct}%`);
    const updated = findAll(root, 'dashboard-limits-updated');
    assert.strictEqual(updated.length, 1, 'подписи «обновлено в» у лимитов нет');
    assert.strictEqual(updated[0].textContent, 'обновлено в 09:07');
    dash.close();
  }
});
