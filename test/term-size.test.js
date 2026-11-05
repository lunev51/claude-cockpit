'use strict';
// «Подогнан ли терминал» и ожидание шрифта — чистые функции из term-size.js.
//
// Запись кадров на стенде 05.11 показала, откуда берётся «квадрат» 80×24:
// терминал, который НЕ подогнан под видимый контейнер (вкладка создана в
// скрытом .term-view, окно свёрнуто), всё равно сообщал pty свой размер — а у
// неподогнанного xterm это его умолчание 80×24. FitAddon в таком положении
// ничего не меняет и не говорит об этом ни слова: proposeDimensions отдаёт
// undefined или {NaN, NaN} (display:none), либо минимальные 2×1 (контейнер
// 0×0 у свёрнутого окна), а fit() молча выходит. Решение «слать или нет»
// теперь принимает fittedSize, и здесь проверяется ровно оно.
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

const BOX = { width: 2360, height: 1332 };

test('fittedSize: FitAddon ничего не предложил — размера нет', async () => {
  const { fittedSize } = await import(url);
  // undefined — терминал не открыт или ячейка ещё не измерена.
  assert.strictEqual(fittedSize(undefined, BOX), null);
  assert.strictEqual(fittedSize(null, BOX), null);
});

test('fittedSize: контейнер display:none — {NaN, NaN} не размер', async () => {
  const { fittedSize } = await import(url);
  // Ровно так отвечает proposeDimensions у вкладки в .term-view.hidden:
  // getComputedStyle(...).height там 'auto', parseInt даёт NaN.
  assert.strictEqual(fittedSize({ cols: NaN, rows: NaN }, BOX), null);
  assert.strictEqual(fittedSize({ cols: 120, rows: NaN }, BOX), null);
  assert.strictEqual(fittedSize({ cols: NaN, rows: 40 }, { width: 0, height: 0 }), null);
});

test('fittedSize: свёрнутое окно (контейнер 0×0) — никаких 2×1', async () => {
  const { fittedSize } = await import(url);
  // FitAddon зажимает минимум: cols ≥ 2, rows ≥ 1 — и на нулевом контейнере
  // предлагает 2×1, которые раньше честно уезжали в pty.
  assert.strictEqual(fittedSize({ cols: 2, rows: 1 }, { width: 0, height: 0 }), null);
  assert.strictEqual(fittedSize({ cols: 2, rows: 1 }, { width: 0, height: 900 }), null);
  assert.strictEqual(fittedSize({ cols: 2, rows: 1 }, { width: 1200, height: 0 }), null);
  assert.strictEqual(fittedSize({ cols: 2, rows: 1 }, { width: -1, height: 900 }), null);
});

test('fittedSize: подогнанный терминал отдаёт свой размер', async () => {
  const { fittedSize } = await import(url);
  // Тот самый кадр со стенда: активная вкладка 279×69 на окне 2360×1332.
  assert.deepStrictEqual(fittedSize({ cols: 279, rows: 69 }, BOX), { cols: 279, rows: 69 });
});

test('fittedSize: дробные, нулевые и нечисловые размеры отсекаются', async () => {
  const { fittedSize } = await import(url);
  assert.strictEqual(fittedSize({ cols: 0, rows: 24 }, BOX), null);
  assert.strictEqual(fittedSize({ cols: 80, rows: 0 }, BOX), null);
  assert.strictEqual(fittedSize({ cols: 80.5, rows: 24 }, BOX), null);
  assert.strictEqual(fittedSize({ cols: Infinity, rows: 24 }, BOX), null);
  assert.strictEqual(fittedSize({ cols: '80', rows: '24' }, BOX), null);
  assert.strictEqual(fittedSize({ cols: 80, rows: 24 }, null), null, 'без контейнера судить не о чем');
  assert.strictEqual(fittedSize({ cols: 80, rows: 24 }, { width: NaN, height: 900 }), null);
});

test('fittedSize: результат — новый объект с ровно двумя полями', async () => {
  const { fittedSize } = await import(url);
  // Отдаём наружу копию: результат уходит в IPC и в app.js, а предложение
  // FitAddon — его внутренний объект.
  const proposed = { cols: 100, rows: 30, extra: 1 };
  const res = fittedSize(proposed, BOX);
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
