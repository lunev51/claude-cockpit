'use strict';
// «Подогнан ли терминал» и ожидание шрифта — чистые функции из term-size.js.
//
// Запись кадров на стенде 05.11 показала, откуда берётся «квадрат» 80×24:
// терминал, который НЕ подогнан под видимый контейнер (вкладка создана в
// скрытом .term-view, окно свёрнуто), всё равно сообщал pty свой размер — а у
// неподогнанного xterm это его умолчание 80×24. FitAddon в таком положении
// ничего не меняет и не говорит об этом ни слова: proposeDimensions отдаёт
// undefined или {NaN, NaN} (display:none), либо зажатый минимум cols ≥ 2,
// rows ≥ 1 (контейнер 0×0 у свёрнутого окна, нулевая ширина у узкого окна),
// а fit() молча выходит. Решение «слать или нет» принимает fittedSize.
//
// Ревью ветки (headless Chrome, настоящие xterm + addon-fit + app.css): первая
// редакция сверяла предложение с clientWidth/clientHeight, а они включают
// отступ .term-view (4px сверху, 8px слева). Хост 0×0 давал коробку 8×4 — не
// ноль, и зажатые 2×1 проходили; хост 0×500 давал 8×500 и {2, 29}. Теперь
// сверяем с ОБЛАСТЬЮ ПОД КЛЕТКИ (контентный блок минус полоса прокрутки — из
// неё же считает FitAddon) и требуем, чтобы предложенная сетка в неё
// действительно влезала: зажатый минимум не влезает по построению.
//
// Модуль — ESM в renderer, поэтому грузим динамическим import (тот же приём,
// что в clipboard.test.js).
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const url = pathToFileURL(
  path.join(__dirname, '..', 'src', 'renderer', 'js', 'term-size.js'),
).href;

// Ячейка и область под клетки окна со стенда: 279×69 по 8×19 px.
const CELL = { width: 8, height: 19 };
const AREA = { width: 2232, height: 1328 };

test('fittedSize: FitAddon ничего не предложил — размера нет', async () => {
  const { fittedSize } = await import(url);
  // undefined — терминал не открыт или ячейка ещё не измерена.
  assert.strictEqual(fittedSize(undefined, AREA, CELL), null);
  assert.strictEqual(fittedSize(null, AREA, CELL), null);
});

test('fittedSize: контейнер display:none — {NaN, NaN} не размер', async () => {
  const { fittedSize } = await import(url);
  // Ровно так отвечает proposeDimensions у вкладки в .term-view.hidden:
  // getComputedStyle(...).height там 'auto', parseInt даёт NaN.
  assert.strictEqual(fittedSize({ cols: NaN, rows: NaN }, AREA, CELL), null);
  assert.strictEqual(fittedSize({ cols: 120, rows: NaN }, AREA, CELL), null);
  assert.strictEqual(fittedSize({ cols: NaN, rows: 40 }, { width: NaN, height: NaN }, CELL), null);
});

test('fittedSize: свёрнутое окно — ни 2×1, ни 2×29 (формы из ревью в Chrome)', async () => {
  const { fittedSize } = await import(url);
  // Хост 0×0: clientWidth/Height .term-view = 8×4 (отступ), FitAddon — {2, 1}.
  // Именно эта пара проходила в первой редакции и уезжала в pty.
  assert.strictEqual(fittedSize({ cols: 2, rows: 1 }, { width: 8, height: 4 }, CELL), null);
  // Хост 0×500 (узкий браузер с диф-панелью): 8×500 и {2, 29} — 2×29 не
  // отсекает и main (validDim 2..500), все pty уходили в две колонки.
  assert.strictEqual(fittedSize({ cols: 2, rows: 29 }, { width: 8, height: 500 }, CELL), null);
  // Те же хосты в правильной коробке: контент 0×0 / 0×496 минус полоса 14px.
  assert.strictEqual(fittedSize({ cols: 2, rows: 1 }, { width: -14, height: 0 }, CELL), null);
  assert.strictEqual(fittedSize({ cols: 2, rows: 26 }, { width: -14, height: 496 }, CELL), null);
  assert.strictEqual(fittedSize({ cols: 2, rows: 1 }, { width: 1200, height: 0 }, CELL), null);
});

test('fittedSize: зажатый минимум FitAddon не влезает в область — не размер', async () => {
  const { fittedSize } = await import(url);
  // Ширина под клетки 8px: настоящих колонок 1, FitAddon зажал до 2.
  assert.strictEqual(fittedSize({ cols: 2, rows: 26 }, { width: 8, height: 496 }, CELL), null);
  // Высота 10px: строк 0, зажато до 1 — и строк меньше двух не бывает вовсе.
  assert.strictEqual(fittedSize({ cols: 100, rows: 1 }, { width: 800, height: 10 }, CELL), null);
  // Одна строка даже если влезает — main (validDim) её всё равно не примет.
  assert.strictEqual(fittedSize({ cols: 100, rows: 1 }, { width: 800, height: 19 }, CELL), null);
});

test('fittedSize: подогнанный терминал отдаёт свой размер', async () => {
  const { fittedSize } = await import(url);
  // Тот самый кадр со стенда: активная вкладка 279×69.
  assert.deepStrictEqual(fittedSize({ cols: 279, rows: 69 }, AREA, CELL), { cols: 279, rows: 69 });
  // Узкое, но настоящее окно — тоже размер: порога «слишком мало» нет, иначе
  // pty остался бы шире видимого и строки Claude Code резались бы справа.
  assert.deepStrictEqual(fittedSize({ cols: 20, rows: 10 }, { width: 160, height: 190 }, CELL), { cols: 20, rows: 10 });
});

test('fittedSize: граница — сетка ровно по области проходит, на пиксель больше нет', async () => {
  const { fittedSize } = await import(url);
  assert.deepStrictEqual(fittedSize({ cols: 10, rows: 5 }, { width: 80, height: 95 }, CELL), { cols: 10, rows: 5 });
  // Дробная ячейка: floor(l / w) * w обгоняет l на ошибку округления. Найдено
  // перебором на реальных значениях — масштаб 125% (ячейка 11 / 1.25 = 8.8):
  // floor(748 / 8.8) = 85, а 85 * 8.8 = 748.0000000000001 > 748. Без допуска
  // терминал ровно такой ширины никогда не сообщил бы свой размер.
  const cell = { width: 8.8, height: 19 };
  assert.strictEqual(Math.floor(748 / cell.width), 85);
  assert.ok(85 * cell.width > 748, 'случай округления больше не воспроизводится — тест холостой');
  assert.deepStrictEqual(fittedSize({ cols: 85, rows: 5 }, { width: 748, height: 95 }, cell), { cols: 85, rows: 5 });
  assert.strictEqual(fittedSize({ cols: 10, rows: 5 }, { width: 79, height: 95 }, CELL), null);
  assert.strictEqual(fittedSize({ cols: 10, rows: 5 }, { width: 80, height: 94 }, CELL), null);
});

test('fittedSize: без ячейки судить не о чем', async () => {
  const { fittedSize } = await import(url);
  assert.strictEqual(fittedSize({ cols: 279, rows: 69 }, AREA, null), null);
  assert.strictEqual(fittedSize({ cols: 279, rows: 69 }, AREA, undefined), null);
  assert.strictEqual(fittedSize({ cols: 279, rows: 69 }, AREA, { width: 0, height: 19 }), null);
  assert.strictEqual(fittedSize({ cols: 279, rows: 69 }, AREA, { width: 8, height: NaN }), null);
});

test('fittedSize: дробные, нулевые и нечисловые размеры отсекаются', async () => {
  const { fittedSize } = await import(url);
  assert.strictEqual(fittedSize({ cols: 0, rows: 24 }, AREA, CELL), null);
  assert.strictEqual(fittedSize({ cols: 80, rows: 0 }, AREA, CELL), null);
  assert.strictEqual(fittedSize({ cols: 80.5, rows: 24 }, AREA, CELL), null);
  assert.strictEqual(fittedSize({ cols: Infinity, rows: 24 }, AREA, CELL), null);
  assert.strictEqual(fittedSize({ cols: '80', rows: '24' }, AREA, CELL), null);
  assert.strictEqual(fittedSize({ cols: 80, rows: 24 }, null, CELL), null, 'без контейнера судить не о чем');
  assert.strictEqual(fittedSize({ cols: 80, rows: 24 }, { width: NaN, height: 900 }, CELL), null);
});

test('fittedSize: результат — новый объект с ровно двумя полями', async () => {
  const { fittedSize } = await import(url);
  // Отдаём наружу копию: результат уходит в IPC и в app.js, а предложение
  // FitAddon — его внутренний объект.
  const proposed = { cols: 100, rows: 30, extra: 1 };
  const res = fittedSize(proposed, AREA, CELL);
  assert.deepStrictEqual(res, { cols: 100, rows: 30 });
  assert.notStrictEqual(res, proposed);
});

test('waitForFont: шрифт загрузился — loaded', async () => {
  const { waitForFont } = await import(url);
  const asked = [];
  const fonts = { load: (spec) => { asked.push(spec); return Promise.resolve([{}]); } };
  assert.strictEqual(await waitForFont(fonts, '14px "JetBrainsMono NF"', 1000), 'loaded');
  assert.deepStrictEqual(asked, ['14px "JetBrainsMono NF"'], 'грузить надо ровно то, что спросили');
});

test('waitForFont: загрузка отклонена — failed, а не исключение', async () => {
  const { waitForFont } = await import(url);
  const fonts = { load: () => Promise.reject(new Error('SyntaxError: битая строка шрифта')) };
  assert.strictEqual(await waitForFont(fonts, '14px x', 1000), 'failed');
});

test('waitForFont: load бросает синхронно — тоже failed', async () => {
  const { waitForFont } = await import(url);
  const fonts = { load: () => { throw new Error('синхронный сбой'); } };
  assert.strictEqual(await waitForFont(fonts, '14px x', 1000), 'failed');
});

test('waitForFont: шрифт не грузится никогда — timeout, загрузка терминала не встаёт', async () => {
  const { waitForFont } = await import(url);
  const fonts = { load: () => new Promise(() => {}) };
  const t0 = Date.now();
  assert.strictEqual(await waitForFont(fonts, '14px x', 30), 'timeout');
  assert.ok(Date.now() - t0 < 1000, 'таймаут не сработал вовремя');
});

test('waitForFont: нет FontFaceSet вовсе — failed, без исключения', async () => {
  const { waitForFont } = await import(url);
  assert.strictEqual(await waitForFont(undefined, '14px x', 30), 'failed');
  assert.strictEqual(await waitForFont({}, '14px x', 30), 'failed');
});
