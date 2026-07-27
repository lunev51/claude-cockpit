'use strict';
// filterActions (Phase 4, Task 4 — палитра команд) — чистая функция без DOM,
// живёт в src/renderer/js/palette-filter.js как ESM-модуль (renderer использует
// import), а этот тест — CommonJS (node --test). Мост между ними — тот же
// приём, что в test/peek-parse.test.js: динамический import() внутри
// async-теста (Node поддерживает это и в CommonJS-файле).

const test = require('node:test');
const assert = require('node:assert');

const ACTIONS = [
  { id: 'devtools', title: 'Открыть DevTools' },
  { id: 'new-project', title: 'Новый проект' },
  { id: 'tab-alpha', title: 'Перейти: alpha' },
  { id: 'tab-beta', title: 'Перейти: beta' },
];

test('пустой запрос — все действия в исходном порядке', async () => {
  const { filterActions } = await import('../src/renderer/js/palette-filter.js');
  assert.deepStrictEqual(filterActions(ACTIONS, ''), ACTIONS);
});

test('null/undefined запрос — тоже все действия в исходном порядке', async () => {
  const { filterActions } = await import('../src/renderer/js/palette-filter.js');
  assert.deepStrictEqual(filterActions(ACTIONS, null), ACTIONS);
  assert.deepStrictEqual(filterActions(ACTIONS, undefined), ACTIONS);
});

test('находит только действие с подстрокой в title', async () => {
  const { filterActions } = await import('../src/renderer/js/palette-filter.js');
  const res = filterActions(ACTIONS, 'alpha');
  assert.deepStrictEqual(res, [ACTIONS[2]]);
});

test('регистр игнорируется', async () => {
  const { filterActions } = await import('../src/renderer/js/palette-filter.js');
  const res = filterActions(ACTIONS, 'DEVTOOLS');
  assert.deepStrictEqual(res, [ACTIONS[0]]);
});

test('подпоследовательное совпадение (символы не обязаны идти подряд)', async () => {
  const { filterActions } = await import('../src/renderer/js/palette-filter.js');
  // 'dvt' — d,v,t в «DevTools» встречаются именно в этом порядке, но не подряд.
  const res = filterActions(ACTIONS, 'dvt');
  assert.deepStrictEqual(res, [ACTIONS[0]]);
});

test('нет совпадения — пустой список', async () => {
  const { filterActions } = await import('../src/renderer/js/palette-filter.js');
  assert.deepStrictEqual(filterActions(ACTIONS, 'zzz'), []);
});

test('сортировка по позиции первого совпадения (раньше в строке — выше)', async () => {
  const { filterActions } = await import('../src/renderer/js/palette-filter.js');
  const actions = [
    { id: 'late', title: 'abc xyz' }, // 'xyz' начинается с индекса 4
    { id: 'early', title: 'xyz abc' }, // 'xyz' начинается с индекса 0
  ];
  const res = filterActions(actions, 'xyz');
  assert.deepStrictEqual(res.map((a) => a.id), ['early', 'late']);
});

test('при равной позиции — сортировка по длине title (короче выше)', async () => {
  const { filterActions } = await import('../src/renderer/js/palette-filter.js');
  const actions = [
    { id: 'long', title: 'ab-long-tail' }, // 'ab' с индекса 0
    { id: 'short', title: 'ab' }, // 'ab' тоже с индекса 0, но короче
  ];
  const res = filterActions(actions, 'ab');
  assert.deepStrictEqual(res.map((a) => a.id), ['short', 'long']);
});

test('действие без поля title (не должно падать) — трактуется как пустая строка', async () => {
  const { filterActions } = await import('../src/renderer/js/palette-filter.js');
  const actions = [{ id: 'broken' }, { id: 'ok', title: 'test' }];
  const res = filterActions(actions, 'test');
  assert.deepStrictEqual(res, [actions[1]]);
});
