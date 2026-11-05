'use strict';
// Клавиши оверлея восстановления воркспейса (restore-keys.js).
//
// Решение здесь необратимое: Esc — «начать пусто», и вчерашний список
// проектов на восстановление теряется. Поэтому обработчик уступает клавишу,
// если её уже обработал кто-то другой (ev.defaultPrevented) или сверху открыт
// другой оверлей. Взаимодействие с настоящими оверлеями — в
// overlay-esc.test.js; здесь — само решение и проводка в app.js.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const url = pathToFileURL(
  path.join(__dirname, '..', 'src', 'renderer', 'js', 'restore-keys.js'),
).href;

function key(name, { prevented = false } = {}) {
  return {
    key: name,
    defaultPrevented: prevented,
    preventDefault() { this.defaultPrevented = true; },
  };
}

async function handler({ covered = false } = {}) {
  const { createRestoreKeyHandler } = await import(url);
  const calls = { restore: 0, empty: 0 };
  const onKey = createRestoreKeyHandler({
    isCovered: () => covered,
    onRestore: () => { calls.restore += 1; },
    onEmpty: () => { calls.empty += 1; },
  });
  return { onKey, calls };
}

test('Enter — восстановить, Esc — начать пусто, обе клавиши погашены', async () => {
  const { onKey, calls } = await handler();
  const enter = key('Enter');
  onKey(enter);
  const esc = key('Escape');
  onKey(esc);
  assert.deepStrictEqual(calls, { restore: 1, empty: 1 });
  assert.ok(enter.defaultPrevented && esc.defaultPrevented, 'клавиши restore не погашены');
});

test('прочие клавиши restore не трогают', async () => {
  const { onKey, calls } = await handler();
  onKey(key('a'));
  onKey(key('Tab'));
  assert.deepStrictEqual(calls, { restore: 0, empty: 0 });
});

test('сверху другой оверлей — клавиши не наши', async () => {
  const { onKey, calls } = await handler({ covered: true });
  const esc = key('Escape');
  onKey(esc);
  onKey(key('Enter'));
  assert.deepStrictEqual(calls, { restore: 0, empty: 0 });
  assert.strictEqual(esc.defaultPrevented, false, 'restore погасил клавишу, предназначенную оверлею сверху');
});

test('клавиша уже обработана другим — restore уступает', async () => {
  // Оверлей, подписанный раньше restore, закрывается по Esc и зовёт
  // preventDefault. К моменту, когда очередь доходит до restore, сверху уже
  // ничего нет — единственный след, что Esc был не ему, это defaultPrevented.
  const { onKey, calls } = await handler();
  onKey(key('Escape', { prevented: true }));
  onKey(key('Enter', { prevented: true }));
  assert.deepStrictEqual(
    calls, { restore: 0, empty: 0 },
    'restore выполнил уже обработанную клавишу: Esc, закрывший оверлей сверху, заодно выбросил воркспейс',
  );
});

test('app.js подписывает restore через createRestoreKeyHandler', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'js', 'app.js'),
    'utf8',
  );
  const code = source
    .split(/\r?\n/)
    .filter((line) => !/^\s*\/\//.test(line))
    .map((line) => line.replace(/\s\/\/\s.*$/, ''))
    .join('\n');
  const start = code.indexOf('function showRestoreOverlay(');
  assert.notStrictEqual(start, -1, 'не найден showRestoreOverlay — страж разъехался с исходником');
  const rest = code.slice(start);
  const body = rest.slice(0, rest.search(/\n\}/));

  assert.match(body, /const onKey = createRestoreKeyHandler\(\{/, 'restore подписывает свой обработчик клавиш мимо restore-keys.js');
  assert.match(body, /isCovered:\s*\(\)\s*=>\s*otherOverlayOpen\('restore'\)/, 'restore не спрашивает общий реестр оверлеев');
  assert.match(body, /onEmpty:\s*startEmpty\b/, 'Esc restore не ведёт в startEmpty');
  assert.match(body, /onRestore:\s*startRestore\b/, 'Enter restore не ведёт в startRestore');
  assert.match(body, /document\.addEventListener\('keydown', onKey, true\)/, 'обработчик restore не подписан на document в capture');
  assert.doesNotMatch(body, /ev\.key === 'Escape'/, 'в showRestoreOverlay снова своя копия разбора клавиш мимо restore-keys.js');
});
