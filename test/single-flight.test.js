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

  const body = code.slice(code.indexOf('function toggleNight('));
  assert.match(
    body.slice(0, body.search(/\n\}/)),
    /toggleNightOnce\(\)/,
    'toggleNight не идёт через обёртку singleFlight',
  );
});
