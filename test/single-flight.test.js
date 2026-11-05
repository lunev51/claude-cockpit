'use strict';
// singleFlight: повторный вызов, пока первый не завершился, не зовёт fn
// второй раз (ревью 09.08, C16).
//
// Живой повод — тумблер ночной смены 🌙. Двойной клик слал night:toggle
// дважды: вооружил и тут же разоружил, а человек видел мелькнувшую кнопку и
// уходил спать в уверенности, что включил.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const url = pathToFileURL(
  path.join(__dirname, '..', 'src', 'renderer', 'js', 'single-flight.js'),
).href;

// Промис, которым тест управляет сам: fn не завершится, пока не скажем.
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('два вызова подряд — fn один раз, у обоих один результат', async () => {
  const { singleFlight } = await import(url);
  let calls = 0;
  const d = deferred();
  const once = singleFlight(() => { calls += 1; return d.promise; });

  const a = once();
  const b = once();
  assert.strictEqual(calls, 1, 'второй вызов в полёте снова позвал fn — двойной клик переключит дважды');
  assert.strictEqual(a, b, 'второй вызов получил не тот же промис');

  d.resolve('armed');
  assert.deepStrictEqual(await Promise.all([a, b]), ['armed', 'armed']);
});

test('после завершения новый вызов снова зовёт fn', async () => {
  const { singleFlight } = await import(url);
  let calls = 0;
  const once = singleFlight(async () => { calls += 1; return calls; });

  assert.strictEqual(await once(), 1);
  assert.strictEqual(await once(), 2, 'после завершения fn больше не зовётся — тумблер залип навсегда');
  assert.strictEqual(calls, 2);
});

test('отказ доходит до обоих вызывающих и не залипает', async () => {
  const { singleFlight } = await import(url);
  let calls = 0;
  const d = deferred();
  const once = singleFlight(() => { calls += 1; return calls === 1 ? d.promise : Promise.resolve('ok'); });

  const a = once();
  const b = once();
  const boom = new Error('night:toggle отклонён');
  d.reject(boom);
  await assert.rejects(a, (err) => err === boom);
  await assert.rejects(b, (err) => err === boom);

  assert.strictEqual(await once(), 'ok', 'после отказа тумблер больше не срабатывает — вызов залип в полёте');
  assert.strictEqual(calls, 2);
});

test('синхронный throw в fn — отказ промисом, без залипания', async () => {
  const { singleFlight } = await import(url);
  let calls = 0;
  const once = singleFlight(() => {
    calls += 1;
    if (calls === 1) throw new Error('api ещё не готов');
    return 'ok';
  });

  await assert.rejects(once(), /api ещё не готов/);
  assert.strictEqual(await once(), 'ok', 'после синхронного throw вызов залип');
});

// --- удержание после завершения (ревью ветки: реальный двойной клик) --------
//
// night:toggle в main синхронный: ответ IPC приходит за миллисекунды, а
// между кликами двойного клика 100–300 мс. То есть второй клик приходит,
// когда первый вызов УЖЕ завершился, — «в полёте» его не поймать. Часы
// поддельные: тест не ждёт реальных 600 мс и не зависит от загрузки машины.

test('второй клик ПОСЛЕ ответа на первый, но в окне удержания — fn не зовётся', async () => {
  const { singleFlight } = await import(url);
  let clock = 1000;
  let calls = 0;
  const once = singleFlight(async () => { calls += 1; return calls; }, { holdMs: 600, now: () => clock });

  const first = await once(); // ответ пришёл — вызов завершён
  clock += 150; // пауза между кликами двойного клика
  const second = await once();

  assert.strictEqual(calls, 1, 'второй клик двойного клика снова позвал fn — ночная смена переключилась дважды');
  assert.strictEqual(second, first, 'в окне удержания вызов должен получить прежний результат');
});

test('после окна удержания fn зовётся снова', async () => {
  const { singleFlight } = await import(url);
  let clock = 1000;
  let calls = 0;
  const once = singleFlight(async () => { calls += 1; return calls; }, { holdMs: 600, now: () => clock });

  await once();
  clock += 601;
  assert.strictEqual(await once(), 2, 'после окна удержания тумблер не срабатывает — он залип');
});

test('окно удержания отсчитывается от ответа, а не от клика', async () => {
  // Медленный ответ (сеть с макбука) не должен съедать окно: второй клик
  // через 100 мс после ответа — всё ещё тот же жест.
  const { singleFlight } = await import(url);
  let clock = 1000;
  let calls = 0;
  const d = deferred();
  const once = singleFlight(() => { calls += 1; return d.promise; }, { holdMs: 600, now: () => clock });

  const first = once();
  clock += 700; // ответ шёл дольше окна
  d.resolve('armed');
  await first;
  clock += 100;
  await once();
  assert.strictEqual(calls, 1, 'окно удержания посчитано от клика: после долгого ответа двойной клик снова переключает');
});

test('без holdMs поведение прежнее — удержания нет', async () => {
  const { singleFlight } = await import(url);
  let calls = 0;
  const once = singleFlight(async () => { calls += 1; });
  await once();
  await once();
  assert.strictEqual(calls, 2);
});

test('аргументы доходят до fn', async () => {
  const { singleFlight } = await import(url);
  const once = singleFlight(async (x, y) => x + y);
  assert.strictEqual(await once(2, 3), 5);
});

// --- проводка: 🌙 действительно идёт через singleFlight ---------------------

test('toggleNight зовёт night:toggle только через singleFlight', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'js', 'app.js'),
    'utf8',
  );
  // Комментарии выкидываем: разбор бага у toggleNight цитирует вызовы.
  const code = source
    .split(/\r?\n/)
    .filter((line) => !/^\s*\/\//.test(line))
    .map((line) => line.replace(/\s\/\/\s.*$/, ''))
    .join('\n');

  assert.match(
    code,
    /^import \{ singleFlight \} from '\.\/single-flight\.js';$/m,
    'app.js не импортирует singleFlight',
  );

  const calls = [...code.matchAll(/window\.api\.night\.toggle\(/g)].map((m) => m.index);
  assert.strictEqual(
    calls.length, 1,
    `night.toggle() зовётся в app.js ${calls.length} раз(а) — ожидался ровно один вызов, внутри singleFlight`,
  );

  // Единственный вызов — внутри аргумента singleFlight(...), привязанного к
  // тумблеру, а не просто где-то рядом.
  const wrap = code.search(/const toggleNightOnce = singleFlight\(/);
  assert.notStrictEqual(wrap, -1, 'тумблер ночной смены не обёрнут в singleFlight — двойной клик переключит дважды');
  const open = code.indexOf('(', wrap + 'const toggleNightOnce = singleFlight'.length);
  let depth = 0;
  let end = -1;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '(') depth += 1;
    else if (code[i] === ')') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  assert.notStrictEqual(end, -1, 'не найден конец singleFlight(...)');
  assert.ok(
    calls[0] > open && calls[0] < end,
    'night.toggle() зовётся мимо singleFlight — двойной клик переключит дважды',
  );

  // Без окна удержания singleFlight двойной клик не ловит: ответ приходит
  // раньше второго клика. Окно — не меньше системного интервала двойного
  // клика Windows по умолчанию (500 мс).
  const callText = code.slice(open, end + 1);
  const hold = callText.match(/holdMs:\s*([A-Z_]+|\d+)/);
  assert.ok(hold, 'у тумблера ночной смены нет holdMs — второй клик двойного клика придёт после ответа и переключит');
  let holdMs = Number(hold[1]);
  if (Number.isNaN(holdMs)) {
    const decl = code.match(new RegExp(`const ${hold[1]} = (\\d+);`));
    assert.ok(decl, `не найдено значение ${hold[1]}`);
    holdMs = Number(decl[1]);
  }
  assert.ok(holdMs >= 500, `окно удержания ${holdMs} мс короче двойного клика Windows (500 мс)`);

  const body = code.slice(code.indexOf('function toggleNight('));
  assert.match(
    body.slice(0, body.search(/\n\}/)),
    /toggleNightOnce\(\)/,
    'toggleNight не идёт через обёртку singleFlight',
  );
});
