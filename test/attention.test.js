'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createAttention, formatTitle } = require('../src/main/attention');

test('formatTitle: 0 → просто Cockpit, N → со счётчиком', () => {
  assert.strictEqual(formatTitle(0), 'Cockpit');
  assert.strictEqual(formatTitle(1), 'Cockpit — 1 ждёт');
  assert.strictEqual(formatTitle(2), 'Cockpit — 2 ждут');
  assert.strictEqual(formatTitle(5), 'Cockpit — 5 ждут');
});

function makeAttention() {
  const calls = { overlay: [], title: [] };
  const win = {
    isDestroyed: () => false,
    setTitle: (t) => calls.title.push(t),
  };
  const att = createAttention({
    getWindow: () => win,
    setOverlay: (img, desc) => calls.overlay.push({ img, desc }),
  });
  return { att, calls };
}

test('update с count>0 ставит overlay и заголовок', () => {
  const { att, calls } = makeAttention();
  att.update({ count: 2, dataUrl: 'data:image/png;base64,AAA' });
  assert.strictEqual(calls.overlay.length, 1);
  assert.strictEqual(calls.overlay[0].img, 'data:image/png;base64,AAA');
  assert.ok(calls.overlay[0].desc.includes('2'));
  assert.strictEqual(calls.title[0], 'Cockpit — 2 ждут');
});

test('update с count=0 снимает overlay', () => {
  const { att, calls } = makeAttention();
  att.update({ count: 1, dataUrl: 'data:image/png;base64,AAA' });
  att.update({ count: 0, dataUrl: null });
  assert.strictEqual(calls.overlay[1].img, null);
  assert.strictEqual(calls.title[1], 'Cockpit');
});

test('повторный update с тем же count не дёргает окно лишний раз', () => {
  const { att, calls } = makeAttention();
  att.update({ count: 1, dataUrl: 'data:image/png;base64,AAA' });
  att.update({ count: 1, dataUrl: 'data:image/png;base64,AAA' });
  assert.strictEqual(calls.overlay.length, 1);
  assert.strictEqual(calls.title.length, 1);
});

test('уничтоженное окно не роняет update', () => {
  const att = createAttention({
    getWindow: () => ({ isDestroyed: () => true, setTitle() { throw new Error('нельзя'); } }),
    setOverlay: () => { throw new Error('нельзя'); },
  });
  att.update({ count: 3, dataUrl: 'x' }); // не должно бросить
});
