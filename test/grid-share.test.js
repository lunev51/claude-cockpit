'use strict';
// Общая сетка терминалов: подогнанная сетка видимой вкладки — скрытым.
//
// main применяет размер видимой вкладки ко ВСЕМ pty (termResizeHandler в
// ipc.js), а скрытый xterm сам подогнаться не может — и без этой раздачи
// фоновая сессия рисовала бы в чужую сетку. Ревью ветки: раздачу стерегла
// только форма кода в app.js, и мутация «rows: size.cols» выживала — сетка
// уходила бы скрытым вкладкам с неверными строками, а смена одних строк не
// доходила бы вовсе. Здесь проверяются значения.
//
// Форма views — та же, что в app.js: Map tabId → запись с полем view (view
// может быть ещё null, пока initTerminal не вернулся).
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const url = pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'js', 'grid-share.js')).href;

function fakeViews(ids) {
  const got = [];
  const views = new Map();
  for (const id of ids) {
    views.set(id, { view: { adoptGrid: (size) => got.push([id, { ...size }]) }, container: {} });
  }
  return { views, got };
}

test('сетка уходит всем вкладкам, кроме источника, — с теми же cols и rows', async () => {
  const { createGridShare } = await import(url);
  const grid = createGridShare();
  const { views, got } = fakeViews(['A', 'B', 'C']);
  grid.share(views, 'A', { cols: 279, rows: 69 });
  assert.deepStrictEqual(got, [['B', { cols: 279, rows: 69 }], ['C', { cols: 279, rows: 69 }]]);
});

test('смена одних строк и одних колонок доходит до скрытых', async () => {
  const { createGridShare } = await import(url);
  const grid = createGridShare();
  const { views, got } = fakeViews(['A', 'B']);
  grid.share(views, 'A', { cols: 279, rows: 69 });
  grid.share(views, 'A', { cols: 279, rows: 40 });
  grid.share(views, 'A', { cols: 120, rows: 40 });
  assert.deepStrictEqual(got.map(([, s]) => s), [
    { cols: 279, rows: 69 }, { cols: 279, rows: 40 }, { cols: 120, rows: 40 },
  ]);
});

test('вкладка, открытая позже, получает последнюю сетку', async () => {
  const { createGridShare } = await import(url);
  const grid = createGridShare();
  const late = [];
  const lateView = { adoptGrid: (size) => late.push({ ...size }) };

  grid.adopt(lateView);
  assert.deepStrictEqual(late, [], 'сетки ещё не было — принимать нечего');

  const { views } = fakeViews(['A']);
  grid.share(views, 'A', { cols: 200, rows: 50 });
  grid.adopt(lateView);
  assert.deepStrictEqual(late, [{ cols: 200, rows: 50 }]);
  assert.deepStrictEqual(grid.current(), { cols: 200, rows: 50 });
});

test('хранится копия: чужой объект размера не меняет общую сетку задним числом', async () => {
  const { createGridShare } = await import(url);
  const grid = createGridShare();
  const size = { cols: 100, rows: 30 };
  grid.share(new Map(), 'A', size);
  size.rows = 1;
  assert.deepStrictEqual(grid.current(), { cols: 100, rows: 30 });
});

test('запись без view (initTerminal ещё не вернулся) пропускается без исключения', async () => {
  const { createGridShare } = await import(url);
  const grid = createGridShare();
  const { views, got } = fakeViews(['A', 'C']);
  views.set('B', { view: null });
  assert.doesNotThrow(() => grid.share(views, 'A', { cols: 80, rows: 30 }));
  assert.deepStrictEqual(got, [['C', { cols: 80, rows: 30 }]]);
});
