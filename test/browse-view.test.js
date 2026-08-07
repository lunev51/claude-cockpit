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

// --- Находки ревью плана 3 -------------------------------------------------

test('пометка работает в КОРНЕ диска', async () => {
  // I3 ревью: currentPath = 'C:\\' даёт при склейке 'C:\\\\games' (двойной
  // разделитель), и сравнение не сходилось. Корень диска — штатная точка
  // входа: слева есть панель «Диски», человек попадает туда одним кликом.
  const { markOpen } = await import(url);
  const marked = markOpen(
    [{ name: 'games', dir: true }],
    'C:\\',
    ['C:\\games'],
  );
  assert.strictEqual(marked[0].open, true, 'в корне диска пометка обязана работать так же');
});

test('пометка не путает одноимённые папки в разных родителях', async () => {
  // I5 ревью (мутация): сравнение по «cwd содержит имя» проходило тесты, хотя
  // помечало бы helper в ЛЮБОЙ папке, где рядом лежит одноимённая.
  const { markOpen } = await import(url);
  const marked = markOpen(
    [{ name: 'helper', dir: true }],
    'C:\\Users\\Другой',
    ['C:\\Users\\Lunev\\helper'],
  );
  assert.strictEqual(marked[0].open, false, 'открыта другая helper, не эта');
});

test('файл не помечается открытым, даже если путь совпал', async () => {
  // I5 ревью (мутация): убрать проверку `e.dir` — и тест оставался зелёным,
  // потому что в фикстуре файл и открытая вкладка совпасть не могли в принципе.
  const { markOpen } = await import(url);
  const marked = markOpen(
    [{ name: 'helper', dir: false }],
    'C:\\Users\\Lunev',
    ['C:\\Users\\Lunev\\helper'],
  );
  assert.strictEqual(marked[0].open, false, 'вкладка живёт в папке, а не в файле');
});

test('крошки понимают сетевой путь UNC', async () => {
  // I4 ревью: '\\\\srv\\share\\dir' разбирался как обычный путь, и первая
  // крошка вела в 'srv\\', который разрешался относительно рабочей папки
  // главного процесса кокпита — то есть уводил в постороннее место.
  // Попасть на UNC можно прямо из строки ввода: normalizeInput('//srv/share')
  // честно даёт '\\\\srv\\share'.
  const { crumbs } = await import(url);
  assert.deepStrictEqual(crumbs('\\\\srv\\share\\dir'), [
    { name: '\\\\srv\\share', path: '\\\\srv\\share' },
    { name: 'dir', path: '\\\\srv\\share\\dir' },
  ]);
});

test('UNC без имени шары не превращается в локальную папку', async () => {
  // I-2 ре-ревью: '\\\\srv' (нормальный первый шаг — в проводнике так смотрят
  // список шар) не подходил под «два сегмента» и уходил в обычную ветку. Крошка
  // получалась 'srv\\', а path.resolve('srv\\') разрешает её ОТНОСИТЕЛЬНО
  // рабочей папки главного процесса кокпита. Замер ревьюера:
  //   path.resolve('srv\\')     -> C:\Users\Lunev\helper\srv
  //   path.resolve('\\\\srv')   -> C:\srv
  // То есть содержимое локальной папки показывалось как содержимое сервера,
  // вместе с кнопкой «Открыть сессию здесь».
  const { crumbs } = await import(url);
  assert.deepStrictEqual(crumbs('\\\\srv'), [
    { name: '\\\\srv', path: '\\\\srv' },
  ], 'сервер без шары — уже сетевой путь, а не папка «srv»');

  assert.deepStrictEqual(crumbs('\\\\srv\\'), [
    { name: '\\\\srv', path: '\\\\srv' },
  ]);
});

test('крошки UNC не ломаются на сдвоенном разделителе', async () => {
  // M-2 ре-ревью: длина корня считалась по нормализованной строке, а срез
  // делался по исходной — из '\\\\srv\\\\share\\dir' получалась лишняя крошка 'e'.
  const { crumbs } = await import(url);
  assert.deepStrictEqual(crumbs('\\\\srv\\\\share\\dir'), [
    { name: '\\\\srv\\share', path: '\\\\srv\\share' },
    { name: 'dir', path: '\\\\srv\\share\\dir' },
  ]);
});

test('ведущие слеши UNC не схлопываются при сравнении путей', async () => {
  // M-1 ре-ревью: защиту ведущих '\\\\' в samePath не ловила ни одна мутация —
  // обе стороны сравнения проходили одну нормализацию, поэтому схлопывание их
  // не разводило. Сравниваем сетевой путь с ЛОКАЛЬНЫМ двойником: они обязаны
  // остаться разными, иначе пометка «открыт» переползёт с \\srv\share на C:\.
  const { markOpen } = await import(url);
  const marked = markOpen(
    [{ name: 'share', dir: true }],
    '\\\\srv',
    ['\\srv\\share'],
  );
  assert.strictEqual(
    marked[0].open, false,
    'локальный \\srv\\share — не то же самое, что сетевой \\\\srv\\share',
  );
});

test('пометка работает и в корне сетевой шары', async () => {
  const { markOpen } = await import(url);
  const marked = markOpen(
    [{ name: 'проект', dir: true }],
    '\\\\srv\\share',
    ['\\\\srv\\share\\проект'],
  );
  assert.strictEqual(marked[0].open, true);
});

test('недавние не двоятся из-за регистра и хвостового слеша', async () => {
  // I5 ревью (мутация): ключ дедупа без toLowerCase/среза слеша проходил тесты.
  const { recentFolders } = await import(url);
  const res = recentFolders({
    tabs: [
      { cwd: 'C:\\Users\\Lunev\\helper' },
      { cwd: 'c:\\users\\lunev\\helper\\' },
      { cwd: 'C:\\Users\\Lunev\\akto' },
    ],
  });
  assert.deepStrictEqual(res.map((r) => r.path), [
    'C:\\Users\\Lunev\\helper',
    'C:\\Users\\Lunev\\akto',
  ], 'одна и та же папка в разном написании — одна строка');
});

test('недавние честно обрезаются по limit', async () => {
  // I5 ревью (мутация): убрать break по limit — тест оставался зелёным, потому
  // что уникальных путей было ровно столько же, сколько limit.
  const { recentFolders } = await import(url);
  const res = recentFolders({
    tabs: [
      { cwd: 'C:\\a' }, { cwd: 'C:\\b' }, { cwd: 'C:\\c' }, { cwd: 'C:\\d' },
    ],
    limit: 2,
  });
  assert.deepStrictEqual(res.map((r) => r.path), ['C:\\a', 'C:\\b']);
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
