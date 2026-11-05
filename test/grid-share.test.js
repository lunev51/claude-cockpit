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

// --- Порог раздачи (ре-ревью) -------------------------------------------------
// Ре-ревью в headless Chrome: браузер ~720px с диф-панелью → видимая вкладка
// 14×27. Скрытая B (2000 строк по 101 символу) приняла 14×27, её буфер упёрся
// в лимит прокрутки, и при возврате к 1440px от 2000 строк осталось ~190. На
// main скрытые так не страдали. Видимая вкладка свой узкий размер получает,
// остальным он не раздаётся.

test('узкая сетка (уже порога) скрытым не раздаётся и общей не становится', async () => {
  const { createGridShare } = await import(url);
  const grid = createGridShare();
  const { views, got } = fakeViews(['A', 'B', 'C']);
  grid.share(views, 'A', { cols: 200, rows: 50 });
  got.length = 0;

  grid.share(views, 'A', { cols: 14, rows: 27 });
  assert.deepStrictEqual(got, [], 'узкая сетка видимой вкладки срезала прокрутку скрытых');
  assert.deepStrictEqual(grid.current(), { cols: 200, rows: 50 }, 'узкая сетка стала общей — её примет и вкладка, открытая позже');

  const late = [];
  grid.adopt({ adoptGrid: (size) => late.push({ ...size }) });
  assert.deepStrictEqual(late, [{ cols: 200, rows: 50 }], 'новая вкладка встала не в последнюю раздаваемую сетку');

  // Ширину вернули — раздаётся снова.
  grid.share(views, 'A', { cols: 180, rows: 50 });
  assert.deepStrictEqual(got, [['B', { cols: 180, rows: 50 }], ['C', { cols: 180, rows: 50 }]]);
});

test('узкая сетка до первой нормальной — общей сетки нет вовсе', async () => {
  const { createGridShare } = await import(url);
  const grid = createGridShare();
  const { views, got } = fakeViews(['A', 'B']);
  grid.share(views, 'A', { cols: 14, rows: 27 });
  assert.deepStrictEqual(got, []);
  assert.strictEqual(grid.current(), null);
});

test('порог раздачи: ровно на пороге раздаётся, на единицу меньше по любой оси — нет', async () => {
  const { createGridShare } = await import(url);
  const { MIN_SHARED_GRID } = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'js', 'term-size.js')).href);
  const { cols: c, rows: r } = MIN_SHARED_GRID;
  for (const [size, shared] of [
    [{ cols: c, rows: r }, true],
    [{ cols: c - 1, rows: r }, false],
    [{ cols: c, rows: r - 1 }, false],
    [{ cols: c + 100, rows: r + 100 }, true],
  ]) {
    const grid = createGridShare();
    const { views, got } = fakeViews(['A', 'B']);
    grid.share(views, 'A', size);
    assert.strictEqual(got.length > 0, shared, `${size.cols}×${size.rows}: раздача ${shared ? 'не случилась' : 'случилась'}`);
  }
});

test('порог раздачи один и тот же в renderer (term-size.js) и main (ownership.js)', async () => {
  // Скрытые xterm (renderer) и их pty (main) обязаны оставаться в одной сетке:
  // раздай одна сторона узкую сетку, а другая нет — вывод фоновой сессии
  // снова ляжет в чужую. ESM renderer и CJS main не могут импортировать один
  // файл, поэтому копии две, а держит их вместе этот тест.
  const { MIN_SHARED_GRID: renderer } = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'js', 'term-size.js')).href);
  const { MIN_SHARED_GRID: main } = require('../src/main/ownership');
  for (const [side, v] of [['renderer', renderer], ['main', main]]) {
    assert.ok(v && Number.isInteger(v.cols) && Number.isInteger(v.rows) && v.cols > 2 && v.rows > 2, `порог в ${side} не задан`);
  }
  assert.deepStrictEqual({ cols: renderer.cols, rows: renderer.rows }, { cols: main.cols, rows: main.rows }, 'пороги раздачи renderer и main разъехались');
});

test('renderer и main одинаково решают, раздавать ли размер, — и выше 500 колонок тоже', async () => {
  // Одних порогов мало: у main сверху ещё validDim (2..500). Ре-ревью нашло
  // расхождение на 4K с мелким шрифтом (~533 колонки): renderer раздавал такую
  // сетку скрытым xterm, а main её не применял ни к одному pty.
  const { isShareableGrid } = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'js', 'term-size.js')).href);
  const { isShareableSize } = require('../src/main/ownership');
  const sizes = [
    { cols: 150, rows: 46 }, { cols: 40, rows: 10 }, { cols: 39, rows: 10 }, { cols: 40, rows: 9 },
    { cols: 500, rows: 500 }, { cols: 501, rows: 46 }, { cols: 600, rows: 100 }, { cols: 150, rows: 501 },
  ];
  for (const s of sizes) {
    assert.strictEqual(isShareableGrid(s), isShareableSize(s), `разные ответы для ${s.cols}×${s.rows}`);
  }
});

test('запись без view (initTerminal ещё не вернулся) пропускается без исключения', async () => {
  const { createGridShare } = await import(url);
  const grid = createGridShare();
  const { views, got } = fakeViews(['A', 'C']);
  views.set('B', { view: null });
  assert.doesNotThrow(() => grid.share(views, 'A', { cols: 80, rows: 30 }));
  assert.deepStrictEqual(got, [['C', { cols: 80, rows: 30 }]]);
});
