'use strict';
// Решения файлового обзора: крошки, пометка занятых папок, недавние. DOM здесь
// не участвует — обвязка живёт в browse.js, а правила проверяются напрямую.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const url = pathToFileURL(
  path.join(__dirname, '..', 'src', 'renderer', 'js', 'browse-view.js'),
).href;

test('крошки ведут от корня диска к текущей папке', async () => {
  const { crumbs } = await import(url);
  assert.deepStrictEqual(crumbs('C:\\Users\\Lunev\\helper'), [
    { name: 'C:', path: 'C:\\' },
    { name: 'Users', path: 'C:\\Users' },
    { name: 'Lunev', path: 'C:\\Users\\Lunev' },
    { name: 'helper', path: 'C:\\Users\\Lunev\\helper' },
  ]);
});

test('крошки корня диска — одна', async () => {
  const { crumbs } = await import(url);
  assert.deepStrictEqual(crumbs('C:\\'), [{ name: 'C:', path: 'C:\\' }]);
});

test('крошки пустого пути — пусто, а не исключение', async () => {
  const { crumbs } = await import(url);
  assert.deepStrictEqual(crumbs(''), []);
  assert.deepStrictEqual(crumbs(null), []);
});

test('папка с открытой вкладкой помечена', async () => {
  const { markOpen } = await import(url);
  const entries = [
    { name: 'helper', dir: true },
    { name: 'akto', dir: true },
    { name: 'readme.md', dir: false },
  ];
  const marked = markOpen(entries, 'C:\\Users\\Lunev', ['C:\\Users\\Lunev\\helper']);
  assert.strictEqual(marked[0].open, true, 'здесь уже открыта вкладка');
  assert.strictEqual(marked[1].open, false);
  assert.strictEqual(marked[2].open, false, 'файл не бывает открытой вкладкой');
});

test('пометка не зависит от регистра и хвостового слеша', async () => {
  const { markOpen } = await import(url);
  const marked = markOpen(
    [{ name: 'Helper', dir: true }],
    'C:\\Users\\Lunev',
    ['c:\\users\\lunev\\helper\\'],
  );
  assert.strictEqual(marked[0].open, true, 'Windows не различает регистр путей');
});

test('недавние: без повторов, свежие первыми, с ограничением', async () => {
  const { recentFolders } = await import(url);
  const res = recentFolders({
    tabs: [
      { cwd: 'C:\\Users\\Lunev\\helper' },
      { cwd: 'C:\\Users\\Lunev\\akto' },
      { cwd: 'C:\\Users\\Lunev\\helper' },
    ],
    workspaces: [{ tabs: [{ cwd: 'C:\\games' }, { cwd: 'C:\\Users\\Lunev\\akto' }] }],
    limit: 3,
  });
  assert.deepStrictEqual(res.map((r) => r.path), [
    'C:\\Users\\Lunev\\helper',
    'C:\\Users\\Lunev\\akto',
    'C:\\games',
  ]);
  assert.strictEqual(res[0].label, 'helper', 'в списке показываем имя папки, путь — подписью');
});

test('недавние переживают пустые и кривые источники', async () => {
  const { recentFolders } = await import(url);
  assert.deepStrictEqual(recentFolders({}), []);
  assert.deepStrictEqual(recentFolders({ tabs: null, workspaces: undefined }), []);
  assert.deepStrictEqual(
    recentFolders({ tabs: [{ cwd: '' }, {}, { cwd: 'C:\\ok' }] }).map((r) => r.path),
    ['C:\\ok'],
  );
});

test('введённый путь чистится от кавычек и пробелов', async () => {
  const { normalizeInput } = await import(url);
  // Путь из проводника копируется в кавычках — человек вставит его как есть.
  assert.strictEqual(normalizeInput('  "C:\\Users\\Lunev"  '), 'C:\\Users\\Lunev');
  assert.strictEqual(normalizeInput('C:/Users/Lunev'), 'C:\\Users\\Lunev');
  assert.strictEqual(normalizeInput('   '), null);
  assert.strictEqual(normalizeInput(null), null);
});
