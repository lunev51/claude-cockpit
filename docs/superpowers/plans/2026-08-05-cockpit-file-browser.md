# Файловый обзор: новая сессия из любой папки — план реализации

> **Исполнителю:** обязательный под-навык — `superpowers:subagent-driven-development`.
> Шаги помечены чекбоксами (`- [ ]`) для отслеживания.

**Цель:** начинать сессию Claude Code в любой папке машины — одинаково из окна на
ПК и из браузера на макбуке, не трогая системный диалог выбора папки.

**Архитектура:** чтение каталогов — отдельный модуль main-процесса без Electron,
покрытый тестами на настоящей временной папке; решения интерфейса (сортировка,
хлебные крошки, пометка «здесь уже открыта вкладка») — чистый модуль renderer под
`node --test`; сам оверлей — тонкая DOM-обвязка по образцу палитры команд.

**Стек:** Electron 29.4.6, `node --test`, `fs`/`path`. Новых зависимостей нет.

## Общие ограничения

- Ветка `feat-file-browser` в `C:\Users\Lunev\AssistClaude\claude-cockpit-net`.
  Remote называется **`upstream`**, не `origin`.
- Запускать приложение ТОЛЬКО с изоляцией хранилища:
  `npm start -- --user-data-dir=C:\Users\Lunev\AppData\Roaming\cockpit-net-data`.
  Пользовательский конфиг там называется **`config.user.json`** (не `config.json`).
- Команды с путями Windows — **через PowerShell**, не через Bash: Bash съедает
  бэкслэши и уже дважды создавал мусорные папки из испорченного пути.
- Комментарии и сообщения коммитов — по-русски. Сообщение коммита писать **файлом**
  и `git commit -F`: двойные кавычки и длинное тире ломают разбор командной строки.
- Новых зависимостей не добавлять. Нативных модулей не добавлять.
- Тесты — `node --test`, файлы в `test/`, имя `<модуль>.test.js`.
- Renderer не покрыт `node --test`: из него тестируются только чистые модули через
  динамический `import()`.
- `git add` — **поимённо**, не `-A`. Не пушить без отдельной команды.

## Решения, уже принятые владельцем (не пересматривать)

- **Всегда новая сессия.** Кнопка «Открыть сессию здесь» заводит новую вкладку;
  подхват существующей сессии (`--resume`) в этот экран не входит — для этого есть
  поиск истории `Ctrl+Shift+H`.
- **Показываются ВСЕ папки**, включая скрытые (`.git`, `.claude`) и `node_modules`.
  Переключателя «показать скрытые» нет.
- **Файлы видны, но серым и не кликабельны** — человек должен понимать, что попал
  в нужную папку, а не в пустоту.
- **Обзор работает одинаково в окне ПК и в браузере.** Единственная разница —
  кнопка «Системное окно» (нативный диалог), которой в браузере нет.
- Спека фазы: `docs/superpowers/specs/2026-08-04-cockpit-remote-design.md`,
  раздел «Файловый обзор».

## Что уже есть и переиспользуется

- `window.api.tabs.list()` → живые вкладки (у каждой есть `cwd`) — источник пометки
  «здесь уже открыта вкладка» и списка недавних.
- `window.api.recipes.listWorkspaces()` → сохранённые воркспейсы — второй источник
  недавних.
- `openTab(cwd)` в `app.js` — уже умеет заводить вкладку по пути.
- `requireControl(action)` в `app.js` — отказ невладельцу понятным тостом.
- `overlayFlags()` в `app.js` — реестр «что из оверлееподобного открыто».
- Образец оверлея с фокусом и Escape: `src/renderer/js/palette.js`.

---

### Задача 1: чтение каталога — `fs-browse.js`

**Файлы:**
- Создать: `src/main/fs-browse.js`
- Тест: `test/fs-browse.test.js`

**Интерфейсы:**
- Использует: только `fs`/`path` (без Electron — модуль обязан идти под `node --test`).
- Отдаёт:
  - `listDir(dirPath, { limit = 1000 })` → `{ path, parent, entries, truncated, error }`
    - `path` — нормализованный абсолютный путь;
    - `parent` — родительский каталог или `null`, если это корень диска;
    - `entries` — `[{ name, dir }]`, папки первыми, внутри групп — по алфавиту без учёта регистра;
    - `truncated` — `true`, если записей было больше `limit`;
    - `error` — `null` либо строка для человека (`'нет доступа'`, `'папки не существует'`).
  - `listDrives()` → `['C:\\', 'D:\\', …]` — корни существующих дисков Windows.

**Почему так:** каталог с тысячами записей (один `node_modules`) подвесил бы и
сервер, и браузер — режем на `limit` и честно сообщаем об этом. Ошибки прав не
должны ронять процесс: `error` — часть ответа, а не исключение.

- [ ] **Шаг 1: написать падающий тест** — создать `test/fs-browse.test.js`

```js
'use strict';
// Чтение каталогов для файлового обзора. Тесты — на НАСТОЯЩЕЙ временной папке
// (тот же приём, что в session-title.test.js): поведение fs на Windows слишком
// богато на частности, чтобы проверять его моками.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listDir, listDrives } = require('../src/main/fs-browse');

function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-browse-'));
  fs.mkdirSync(path.join(root, 'zebra'));
  fs.mkdirSync(path.join(root, 'Alpha'));
  fs.mkdirSync(path.join(root, '.hidden'));
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'readme.md'), 'x');
  fs.writeFileSync(path.join(root, 'A-file.txt'), 'x');
  return root;
}

test('папки идут первыми, потом файлы, внутри — по алфавиту без учёта регистра', () => {
  const root = makeTree();
  const res = listDir(root);
  assert.strictEqual(res.error, null);
  assert.deepStrictEqual(res.entries, [
    { name: '.hidden', dir: true },
    { name: 'Alpha', dir: true },
    { name: 'node_modules', dir: true },
    { name: 'zebra', dir: true },
    { name: 'A-file.txt', dir: false },
    { name: 'readme.md', dir: false },
  ], 'скрытые и node_modules показываются наравне — решение владельца');
});

test('родитель известен, а у корня диска его нет', () => {
  const root = makeTree();
  const res = listDir(root);
  assert.strictEqual(res.parent, path.dirname(root));

  const drive = path.parse(root).root; // 'C:\\'
  assert.strictEqual(listDir(drive).parent, null, 'выше корня диска идти некуда');
});

test('путь нормализуется: слеши, точки, хвостовой разделитель', () => {
  const root = makeTree();
  const messy = `${root}${path.sep}Alpha${path.sep}..${path.sep}`;
  assert.strictEqual(listDir(messy).path, path.resolve(root));
});

test('длинный каталог режется и честно об этом сообщает', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-big-'));
  for (let i = 0; i < 25; i += 1) fs.mkdirSync(path.join(root, `dir-${String(i).padStart(3, '0')}`));
  const res = listDir(root, { limit: 10 });
  assert.strictEqual(res.entries.length, 10);
  assert.strictEqual(res.truncated, true);
  // Обрезаем ПОСЛЕ сортировки, иначе список прыгал бы от вызова к вызову.
  assert.strictEqual(res.entries[0].name, 'dir-000');
});

test('короткий каталог не помечается обрезанным', () => {
  const root = makeTree();
  assert.strictEqual(listDir(root, { limit: 1000 }).truncated, false);
});

test('несуществующая папка — понятный текст, а не исключение', () => {
  const res = listDir(path.join(os.tmpdir(), 'нет-такой-папки-12345'));
  assert.strictEqual(res.entries.length, 0);
  assert.match(res.error, /не существует/i);
});

test('файл вместо папки — тоже понятный отказ', () => {
  const root = makeTree();
  const res = listDir(path.join(root, 'readme.md'));
  assert.ok(res.error, 'файл — не каталог, и это надо сказать');
});

test('пустой и не-строковый путь не роняют', () => {
  for (const bad of ['', null, undefined, 42, {}]) {
    const res = listDir(bad);
    assert.ok(res.error, `${JSON.stringify(bad)} должен дать ошибку, а не исключение`);
    assert.deepStrictEqual(res.entries, []);
  }
});

test('диски: непустой список, каждый существует', () => {
  const drives = listDrives();
  assert.ok(Array.isArray(drives) && drives.length > 0);
  for (const d of drives) {
    assert.match(d, /^[A-Z]:\\$/);
    assert.ok(fs.existsSync(d), `${d} обязан существовать — иначе он не диск`);
  }
  assert.ok(drives.includes('C:\\'), 'на этой машине C: есть всегда');
});
```

- [ ] **Шаг 2: убедиться, что тест падает**

```
npm test -- test/fs-browse.test.js
```
Ожидание: FAIL, `Cannot find module '../src/main/fs-browse'`.

- [ ] **Шаг 3: реализация** — создать `src/main/fs-browse.js`

```js
'use strict';
// Чтение каталогов для файлового обзора (план 3 фазы «кокпит по сети»).
// Без Electron: модуль обязан идти под node --test, поэтому здесь только
// fs/path, а решение «показывать ли это человеку» принимает renderer.
//
// Владелец решил: показываем ВСЕ папки, включая скрытые и node_modules.
// Файлы тоже отдаём (renderer рисует их серыми и некликабельными) — иначе
// человек не отличит «пустая папка» от «зашёл не туда».
const fs = require('fs');
const path = require('path');

// Каталог на тысячи записей подвесил бы и сервер, и браузер: один node_modules
// в корне проекта — это десятки тысяч имён на каждый переход.
const DEFAULT_LIMIT = 1000;

function listDir(dirPath, { limit = DEFAULT_LIMIT } = {}) {
  const empty = (error) => ({
    path: typeof dirPath === 'string' ? dirPath : '', parent: null, entries: [], truncated: false, error,
  });
  if (typeof dirPath !== 'string' || !dirPath.trim()) return empty('путь не указан');

  const abs = path.resolve(dirPath);
  let raw;
  try {
    raw = fs.readdirSync(abs, { withFileTypes: true });
  } catch (err) {
    // Права, отсутствие, файл вместо каталога — всё это нормальные ответы
    // файловой системы, а не повод ронять процесс с необработанным исключением.
    if (err.code === 'ENOENT') return empty('папки не существует');
    if (err.code === 'ENOTDIR') return empty('это файл, а не папка');
    if (err.code === 'EPERM' || err.code === 'EACCES') return empty('нет доступа');
    return empty(`не удалось прочитать: ${err.code || err.message}`);
  }

  const entries = raw
    .map((d) => ({ name: d.name, dir: d.isDirectory() }))
    // Папки первыми: человек сюда пришёл выбирать папку, файлы — только
    // ориентир. Внутри группы — по алфавиту без учёта регистра, иначе
    // 'Alpha' и 'alpha' разъезжаются по разным концам списка.
    .sort((a, b) => {
      if (a.dir !== b.dir) return a.dir ? -1 : 1;
      return a.name.localeCompare(b.name, 'ru', { sensitivity: 'base' });
    });

  // Режем ПОСЛЕ сортировки — иначе набор видимых имён менялся бы от вызова к
  // вызову вместе с порядком выдачи файловой системы.
  const truncated = entries.length > limit;
  const parent = path.dirname(abs);

  return {
    path: abs,
    // dirname корня диска возвращает сам корень — выше идти некуда.
    parent: parent === abs ? null : parent,
    entries: truncated ? entries.slice(0, limit) : entries,
    truncated,
    error: null,
  };
}

// Список дисков: без него от C:\Users до C:\games не добраться вообще никак.
// Перебор букв дешевле любого внешнего вызова (wmic/powershell) и не зависит
// от локали вывода.
function listDrives() {
  const drives = [];
  for (let code = 'A'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code += 1) {
    const root = `${String.fromCharCode(code)}:\\`;
    try {
      if (fs.existsSync(root)) drives.push(root);
    } catch { /* недоступный диск — просто не показываем */ }
  }
  return drives;
}

module.exports = { listDir, listDrives, DEFAULT_LIMIT };
```

- [ ] **Шаг 4: тесты зелёные**

```
npm test -- test/fs-browse.test.js
```

- [ ] **Шаг 5: проверка мутацией**

Замени сортировку на `.sort((a, b) => a.name.localeCompare(b.name))` (без учёта
папок) — тест «папки идут первыми» обязан покраснеть. Верни как было.
Затем убери `entries.length > limit` (всегда `false`) — обязан покраснеть тест про
обрезку. Верни как было.

- [ ] **Шаг 6: коммит**

```
git add src/main/fs-browse.js test/fs-browse.test.js
git commit -F <файл с сообщением>
```
Сообщение: `feat: чтение каталогов для файлового обзора`

---

### Задача 2: каналы `fs:list` и `fs:drives`

**Файлы:**
- Изменить: `src/main/ipc.js`, `src/main/write-channels.js`, `src/preload/preload.js`,
  `src/renderer/js/api-shape.js`
- Тест: `test/write-channels.test.js` (дописать)

**Интерфейсы:**
- Использует: `listDir`, `listDrives` (задача 1).
- Отдаёт:
  - канал `fs:list` (invoke), аргумент — строка пути, ответ — объект из `listDir`;
  - канал `fs:drives` (invoke), без аргументов, ответ — массив строк;
  - `window.api.fs.list(dirPath)` и `window.api.fs.drives()`.

**Права:** оба канала — **свободные** (`FREE_CHANNELS`). Это чтение, а принцип
эстафеты: смотреть можно всем, менять — только владельцу. Спека фазы прямо
говорит, что скрывать имена папок от вошедшего бессмысленно: у него и так полный
доступ к терминалу. Заведение вкладки (`tabs:open`) остаётся пишущим.

- [ ] **Шаг 1: написать падающий тест** (дописать в `test/write-channels.test.js`)

```js
test('обзор файловой системы — чтение, доступен и невладельцу', () => {
  // Смотреть каталоги может кто угодно: это чтение, и оно ничего не меняет на
  // машине владельца. Заводит вкладку отдельная команда — она пишущая.
  assert.strictEqual(isWriteChannel('fs:list'), false);
  assert.strictEqual(isWriteChannel('fs:drives'), false);
  assert.strictEqual(isWriteChannel('tabs:open'), true);
});
```

- [ ] **Шаг 2: убедиться, что тест падает**

```
npm test -- test/write-channels.test.js
```
Ожидание: FAIL — неизвестные каналы считаются пишущими (`isWriteChannel` по
умолчанию отвечает `true`).

- [ ] **Шаг 3: реализация**

В `src/main/write-channels.js`, в `FREE_CHANNELS`, рядом с `net:buffer`:

```js
  // Файловый обзор (план 3): чтение каталогов и список дисков. Заведение
  // вкладки из обзора — отдельная пишущая команда tabs:open.
  'fs:list', 'fs:drives',
```

В `src/main/ipc.js` — импорт рядом с остальными:

```js
const { listDir, listDrives } = require('./fs-browse');
```

И регистрация рядом с `tabs:chooseFolder`:

```js
  // Файловый обзор (план 3): системный диалог выбора папки при удалённой
  // работе открывался бы на ПК, где никого нет, — поэтому свой экран, общий
  // для окна и браузера. Ограничение в 1000 записей и текст ошибки приходят
  // из fs-browse.js, тут только проводка.
  registry.handle('fs:list', (dirPath) => listDir(dirPath));
  registry.handle('fs:drives', () => listDrives());
```

В `src/preload/preload.js`, рядом с группой `tabs`:

```js
  fs: {
    // Файловый обзор (план 3): каталоги читает main, renderer только рисует.
    list: (dirPath) => ipcRenderer.invoke('fs:list', dirPath),
    drives: () => ipcRenderer.invoke('fs:drives'),
  },
```

В `src/renderer/js/api-shape.js`:

```js
  'fs.list': { channel: 'fs:list', kind: 'invoke' },
  'fs.drives': { channel: 'fs:drives', kind: 'invoke' },
```

- [ ] **Шаг 4: тесты зелёные**

```
npm test -- test/write-channels.test.js test/net-api.test.js
```
`net-api.test.js` сверяет `api-shape.js` с `preload.js` построчно — расхождение в
имени, виде вызова или переупаковке он поймает.

- [ ] **Шаг 5: коммит**

```
git add src/main/ipc.js src/main/write-channels.js src/preload/preload.js src/renderer/js/api-shape.js test/write-channels.test.js
git commit -F <файл с сообщением>
```
Сообщение: `feat: каналы чтения каталогов для обзора`

---

### Задача 3: решения интерфейса — `browse-view.js`

Чистая часть обзора: что показать, что пометить, куда ведёт клик. Отдельно от DOM,
потому что renderer под `node --test` не идёт, а именно здесь живут правила,
которые легко испортить незаметно.

**Файлы:**
- Создать: `src/renderer/js/browse-view.js`
- Тест: `test/browse-view.test.js`

**Интерфейсы:**
- Использует: ничего.
- Отдаёт:
  - `crumbs(dirPath)` → `[{ name, path }]` — хлебные крошки от корня диска к текущей папке;
  - `markOpen(entries, currentPath, openCwds)` → те же записи плюс `open: true` у папок,
    в которых уже открыта вкладка;
  - `recentFolders({ tabs, workspaces, limit })` → `[{ path, label }]` — недавние без
    повторов, свежие первыми;
  - `normalizeInput(raw)` → строка пути или `null`, если вводить нечего.

- [ ] **Шаг 1: написать падающий тест** — создать `test/browse-view.test.js`

```js
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
```

- [ ] **Шаг 2: убедиться, что тест падает**

```
npm test -- test/browse-view.test.js
```

- [ ] **Шаг 3: реализация** — создать `src/renderer/js/browse-view.js`

```js
'use strict';
// Решения файлового обзора, отделённые от DOM: крошки, пометка занятых папок,
// недавние, чистка введённого пути. Renderer под node --test не идёт, поэтому
// всё, что можно испортить незаметно, живёт здесь и проверяется напрямую.
//
// Пути только Windows-вида: кокпит запускается на Windows, а обзор всегда
// показывает файловую систему МАШИНЫ С КОКПИТОМ, даже когда смотрят с макбука.

const SEP = '\\';

// 'C:\\Users\\Lunev' → [{name:'C:',path:'C:\\'}, {name:'Users',…}, …]
export function crumbs(dirPath) {
  if (typeof dirPath !== 'string' || !dirPath.trim()) return [];
  const parts = dirPath.replace(/[/\\]+$/, '').split(/[/\\]+/).filter(Boolean);
  if (!parts.length) return [];
  const out = [{ name: parts[0], path: `${parts[0]}${SEP}` }];
  let acc = parts[0];
  for (const part of parts.slice(1)) {
    acc = `${acc}${SEP}${part}`;
    out.push({ name: part, path: acc });
  }
  return out;
}

// Windows не различает регистр путей, а хвостовой разделитель ничего не значит —
// сравнивать «как есть» означало бы не пометить половину совпадений.
function samePath(a, b) {
  const norm = (p) => String(p || '').replace(/[/\\]+$/, '').replace(/\//g, SEP).toLowerCase();
  return norm(a) === norm(b);
}

export function markOpen(entries, currentPath, openCwds) {
  const opened = Array.isArray(openCwds) ? openCwds : [];
  return (Array.isArray(entries) ? entries : []).map((e) => ({
    ...e,
    // Файл открытой вкладкой быть не может — пометка только для папок.
    open: !!e.dir && opened.some((cwd) => samePath(cwd, `${currentPath}${SEP}${e.name}`)),
  }));
}

// Недавние: сначала папки живых вкладок (самое свежее, что человек трогал),
// потом папки из сохранённых воркспейсов. Повторы убираем — список короткий,
// и одно и то же имя дважды в нём выглядит поломкой.
export function recentFolders({ tabs, workspaces, limit = 8 } = {}) {
  const paths = [];
  for (const t of Array.isArray(tabs) ? tabs : []) {
    if (t && typeof t.cwd === 'string' && t.cwd.trim()) paths.push(t.cwd);
  }
  for (const w of Array.isArray(workspaces) ? workspaces : []) {
    for (const t of (w && Array.isArray(w.tabs)) ? w.tabs : []) {
      if (t && typeof t.cwd === 'string' && t.cwd.trim()) paths.push(t.cwd);
    }
  }
  const seen = new Set();
  const out = [];
  for (const p of paths) {
    const key = p.replace(/[/\\]+$/, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const parts = p.replace(/[/\\]+$/, '').split(/[/\\]+/).filter(Boolean);
    out.push({ path: p, label: parts[parts.length - 1] || p });
    if (out.length >= limit) break;
  }
  return out;
}

// Путь, скопированный из проводника, приезжает в кавычках и с пробелами по
// краям; путь из браузера на макбуке — со слешами в другую сторону.
export function normalizeInput(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/^"+|"+$/g, '').trim();
  if (!trimmed) return null;
  return trimmed.replace(/\//g, SEP);
}
```

- [ ] **Шаг 4: тесты зелёные**

```
npm test -- test/browse-view.test.js
```

- [ ] **Шаг 5: проверка мутацией**

В `samePath` убери `.toLowerCase()` — тест «пометка не зависит от регистра» обязан
покраснеть. Верни. В `recentFolders` убери проверку `seen.has(key)` — обязан
покраснеть тест про повторы. Верни.

- [ ] **Шаг 6: коммит**

```
git add src/renderer/js/browse-view.js test/browse-view.test.js
git commit -F <файл с сообщением>
```
Сообщение: `feat: решения файлового обзора - крошки, пометки, недавние`

---

### Задача 4: сам оверлей обзора

**Файлы:**
- Создать: `src/renderer/js/browse.js`
- Изменить: `src/renderer/index.html`, `src/renderer/css/app.css`

**Интерфейсы:**
- Использует: `crumbs`, `markOpen`, `recentFolders`, `normalizeInput` (задача 3);
  `window.api.fs.list/drives` (задача 2); `window.api.tabs.list`,
  `window.api.recipes.listWorkspaces` (уже есть).
- Отдаёт: `createBrowse({ onOpenHere, onSystemDialog, isElectron })` →
  `{ open(startPath), close(), isOpen() }`.
  - `onOpenHere(cwd)` — вызывается по кнопке «Открыть сессию здесь»;
  - `onSystemDialog()` — по кнопке «Системное окно»; кнопка не рисуется вовсе, если
    `isElectron === false`;
  - `open(startPath)` — открыть обзор на этой папке (или на последней посещённой).

**Образец:** `src/renderer/js/palette.js` — тот же приём: корень-контейнер в
`index.html`, модуль сам наполняет и чистит его, Escape закрывает, фокус уходит в
поле ввода и возвращается назад при закрытии.

- [ ] **Шаг 1: разметка** — в `src/renderer/index.html`, рядом с `#palette-root`:

```html
  <!-- План 3 (файловый обзор): выбор папки для новой сессии — свой экран
       вместо системного диалога, который при удалённой работе открывался бы
       на ПК, где никого нет. Корень вне #sidebar/#main, как у палитры:
       оверлей накрывает окно целиком. createBrowse() наполняет и чистит его
       сам (см. src/renderer/js/browse.js). -->
  <div id="browse-root"></div>
```

- [ ] **Шаг 2: стили** — в `src/renderer/css/app.css`, рядом со стилями палитры:

```css
/* --- Файловый обзор (план 3): выбор папки для новой сессии. Тот же слой, что
   палитра (60) — он и открывается вместо неё, и накрывать её не должен. --- */
#browse-root:empty { display: none; }
.browse-overlay {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.5);
}
.browse-card {
  width: min(900px, 92vw);
  height: min(620px, 86vh);
  display: flex;
  flex-direction: column;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-m, 10px);
  overflow: hidden;
}
.browse-head { display: flex; gap: 8px; padding: 10px; border-bottom: 1px solid var(--border); }
.browse-path {
  flex: 1;
  padding: 7px 10px;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text);
  background: var(--bg-window);
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
}
.browse-crumbs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 6px 10px;
  font-size: 11px;
  color: var(--text-dim);
  border-bottom: 1px solid var(--border);
}
.browse-crumb { cursor: pointer; }
.browse-crumb:hover { color: var(--text); text-decoration: underline; }
.browse-body { flex: 1; display: flex; min-height: 0; }
.browse-side {
  width: 220px;
  flex: none;
  border-right: 1px solid var(--border);
  overflow-y: auto;
  padding: 8px;
}
.browse-side-title {
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-dim);
  padding: 6px 6px 4px;
}
.browse-list { flex: 1; overflow-y: auto; padding: 8px; }
.browse-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: var(--radius-s);
  font-size: 12px;
}
.browse-row.dir { cursor: pointer; color: var(--text); }
.browse-row.dir:hover { background: var(--bg-hover); }
/* Файлы показываем, чтобы человек видел, что попал в нужную папку, — но они
   не кликабельны: обзор выбирает ПАПКУ. */
.browse-row.file { color: var(--text-muted); cursor: default; }
.browse-row .badge { font-size: 10px; color: var(--accent); }
.browse-note { padding: 6px 10px; font-size: 11px; color: var(--warn); }
.browse-foot {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 10px;
  border-top: 1px solid var(--border);
}
.browse-foot .grow { flex: 1; font-size: 11px; color: var(--text-dim); }
```

- [ ] **Шаг 3: модуль** — создать `src/renderer/js/browse.js`

```js
'use strict';
// Файловый обзор: выбор папки для НОВОЙ сессии. Один и тот же экран в окне на
// ПК и в браузере на макбуке — системный диалог при удалённой работе открылся
// бы на машине, где никого нет (а окно кокпита в этот момент спрятано в трей).
//
// Решения (сортировка, крошки, пометки, недавние) живут в browse-view.js под
// тестами; здесь только DOM и разговор с main.
import {
  crumbs, markOpen, recentFolders, normalizeInput,
} from './browse-view.js';

export function createBrowse({ onOpenHere, onSystemDialog, isElectron = true }) {
  const root = document.getElementById('browse-root');
  let current = '';
  let lastFocus = null;

  function close() {
    root.innerHTML = '';
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
    lastFocus = null;
  }

  const isOpen = () => !!root.firstChild;

  async function render(dirPath) {
    const res = await window.api.fs.list(dirPath);
    if (res && res.path) current = res.path;

    const [live, workspaces, drives] = await Promise.all([
      window.api.tabs.list().catch(() => []),
      window.api.recipes.listWorkspaces().catch(() => []),
      window.api.fs.drives().catch(() => []),
    ]);
    const openCwds = (Array.isArray(live) ? live : []).map((t) => t.cwd).filter(Boolean);
    const rows = markOpen(res.entries, res.path, openCwds);

    root.innerHTML = '';
    const overlay = document.createElement('div');
    overlay.className = 'browse-overlay';
    const card = document.createElement('div');
    card.className = 'browse-card';
    overlay.appendChild(card);

    // --- строка пути ---
    const head = document.createElement('div');
    head.className = 'browse-head';
    const input = document.createElement('input');
    input.className = 'browse-path';
    input.value = current;
    input.spellcheck = false;
    input.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      const next = normalizeInput(input.value);
      if (next) render(next);
    });
    head.appendChild(input);
    card.appendChild(head);

    // --- хлебные крошки ---
    const crumbBar = document.createElement('div');
    crumbBar.className = 'browse-crumbs';
    crumbs(current).forEach((c, i, all) => {
      const el = document.createElement('span');
      el.className = 'browse-crumb';
      el.textContent = c.name;
      el.addEventListener('click', () => render(c.path));
      crumbBar.appendChild(el);
      if (i < all.length - 1) {
        const sep = document.createElement('span');
        sep.textContent = '›';
        crumbBar.appendChild(sep);
      }
    });
    card.appendChild(crumbBar);

    // --- тело: слева недавние и диски, справа содержимое ---
    const body = document.createElement('div');
    body.className = 'browse-body';
    const side = document.createElement('div');
    side.className = 'browse-side';

    const addSideTitle = (text) => {
      const t = document.createElement('div');
      t.className = 'browse-side-title';
      t.textContent = text;
      side.appendChild(t);
    };
    const addSideRow = (label, target, hint) => {
      const r = document.createElement('div');
      r.className = 'browse-row dir';
      r.textContent = label;
      if (hint) r.title = hint;
      r.addEventListener('click', () => render(target));
      side.appendChild(r);
    };

    const recents = recentFolders({ tabs: live, workspaces });
    if (recents.length) {
      addSideTitle('Недавние');
      recents.forEach((r) => addSideRow(r.label, r.path, r.path));
    }
    addSideTitle('Диски');
    (Array.isArray(drives) ? drives : []).forEach((d) => addSideRow(d, d));
    body.appendChild(side);

    // --- содержимое каталога ---
    const list = document.createElement('div');
    list.className = 'browse-list';
    if (res.error) {
      const err = document.createElement('div');
      err.className = 'browse-note';
      err.textContent = res.error;
      list.appendChild(err);
    }
    if (res.parent) {
      const up = document.createElement('div');
      up.className = 'browse-row dir';
      up.textContent = '..';
      up.addEventListener('click', () => render(res.parent));
      list.appendChild(up);
    }
    rows.forEach((e) => {
      const r = document.createElement('div');
      r.className = `browse-row ${e.dir ? 'dir' : 'file'}`;
      const name = document.createElement('span');
      name.textContent = e.name;
      r.appendChild(name);
      if (e.open) {
        // Иначе легко завести вторую сессию в том же проекте, не заметив первой.
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = '· открыт';
        r.appendChild(badge);
      }
      if (e.dir) r.addEventListener('click', () => render(`${res.path}\\${e.name}`));
      list.appendChild(r);
    });
    if (res.truncated) {
      const note = document.createElement('div');
      note.className = 'browse-note';
      note.textContent = 'показана первая тысяча записей — уточните путь в строке сверху';
      list.appendChild(note);
    }
    body.appendChild(list);
    card.appendChild(body);

    // --- низ: открыть здесь / системное окно / закрыть ---
    const foot = document.createElement('div');
    foot.className = 'browse-foot';
    const openBtn = document.createElement('button');
    openBtn.className = 'sidebar-btn';
    openBtn.id = 'browse-open-here';
    openBtn.textContent = 'Открыть сессию здесь';
    openBtn.addEventListener('click', () => {
      const target = current;
      close();
      onOpenHere(target);
    });
    foot.appendChild(openBtn);

    if (isElectron && typeof onSystemDialog === 'function') {
      // Только в окне на ПК: в браузере системный диалог показать негде.
      const sysBtn = document.createElement('button');
      sysBtn.className = 'sidebar-btn';
      sysBtn.textContent = 'Системное окно';
      sysBtn.addEventListener('click', () => {
        close();
        onSystemDialog();
      });
      foot.appendChild(sysBtn);
    }

    const grow = document.createElement('div');
    grow.className = 'grow';
    grow.textContent = 'Enter в строке пути — перейти · Esc — закрыть';
    foot.appendChild(grow);
    card.appendChild(foot);

    overlay.addEventListener('mousedown', (ev) => { if (ev.target === overlay) close(); });
    // Escape ловим ЗДЕСЬ, а не в общем обработчике app.js: палитра и поиск
    // устроены так же — каждый оверлей закрывает себя сам, и порядок между
    // ними не приходится согласовывать вручную. capture, чтобы клавиша не
    // ушла в поле ввода пути раньше нас.
    overlay.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      close();
    }, true);
    root.appendChild(overlay);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  return {
    isOpen,
    close,
    async open(startPath) {
      lastFocus = document.activeElement;
      await render(startPath || current || 'C:\\');
    },
  };
}
```

- [ ] **Шаг 4: прогон и smoke**

```
npm test
npm run smoke -- --user-data-dir=C:\Users\Lunev\AppData\Roaming\cockpit-net-data
```
Smoke обязан остаться зелёным (`window=OK`, `renderer-errors=0`, код выхода 0).
**Не обрывай конвейер** `Select-Object -First` — это само роняет процесс и даёт
ложный ненулевой код.

- [ ] **Шаг 5: коммит**

```
git add src/renderer/js/browse.js src/renderer/index.html src/renderer/css/app.css
git commit -F <файл с сообщением>
```
Сообщение: `feat: оверлей файлового обзора`

---

### Задача 5: проводка — «+ Проект» ведёт в обзор

**Файлы:**
- Изменить: `src/renderer/js/app.js`

**Интерфейсы:**
- Использует: `createBrowse` (задача 4), `requireControl`, `openTab`, `overlayFlags`
  (уже есть в `app.js`).
- Отдаёт: ничего наружу; меняет поведение кнопки «+ Проект», палитры и добавляет
  `Ctrl+O`.

- [ ] **Шаг 1: импорт и создание** — рядом с созданием палитры в `boot()`:

```js
import { createBrowse } from './browse.js';
```

```js
  // План 3: файловый обзор вместо системного диалога. Кнопка «Системное окно»
  // остаётся только в Electron — в браузере показать её негде, а канал
  // tabs:chooseFolder пишущий (он открывает модалку на машине владельца).
  browse = createBrowse({
    onOpenHere: (cwd) => {
      // Заведение вкладки — пишущее действие: у невладельца оно отклонится
      // гардом, поэтому спрашиваем заранее и говорим человеку словами.
      if (!requireControl('Открыть сессию здесь')) return;
      if (restoreOverlaySkip) restoreOverlaySkip();
      openTab(cwd);
    },
    onSystemDialog: async () => {
      if (!requireControl('Системный выбор папки')) return;
      const folder = await window.api.tabs.chooseFolder();
      if (!folder) return;
      if (restoreOverlaySkip) restoreOverlaySkip();
      openTab(folder);
    },
    isElectron: !window.__cockpitNetClient,
  });
```

Объявление рядом с другими оверлеями (`let palette = null;` и т.п.):

```js
let browse = null;
```

Признак «мы в браузере» ставит сетевой мост: в `src/renderer/js/api-boot.js`, сразу
после `window.api = api;`, добавить строку

```js
  // Признак сетевого клиента: обзор прячет по нему кнопку системного диалога —
  // в браузере показать её негде.
  window.__cockpitNetClient = true;
```

- [ ] **Шаг 2: точки входа** — заменить тело `newProject()`:

```js
async function newProject() {
  // План 3: вместо системного диалога — свой обзор, одинаковый в окне и в
  // браузере. Гард управления здесь больше не нужен: обзор — это чтение, а
  // отказ невладельцу выдаёт кнопка «Открыть сессию здесь» (см. onOpenHere).
  await browse.open();
}
```

- [ ] **Шаг 3: хоткей** — рядом с другими в `bindHotkeys()`:

```js
    // Ctrl+O — файловый обзор. Гард otherOverlayOpen: открывать обзор поверх
    // палитры/дашборда/оверлея восстановления нельзя, иначе он ляжет под ними
    // (тот же класс дыры, что уже ловили с заглушкой эстафеты).
    if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && ev.key === 'o') {
      ev.preventDefault();
      if (!otherOverlayOpen('browse')) browse.open();
      return;
    }
```

- [ ] **Шаг 4: реестр оверлеев** — в `overlayFlags()`:

```js
    // План 3: обзор — такой же модальный слой, как палитра. Без регистрации
    // Ctrl+Q/Ctrl+G открывались бы под ним, а вкладка под открытым обзором
    // считалась бы прочитанной (seen.js).
    browse: !!browse?.isOpen(),
```

- [ ] **Шаг 5: прогон, smoke и живая проверка**

```
npm test
npm run smoke -- --user-data-dir=C:\Users\Lunev\AppData\Roaming\cockpit-net-data
npm start -- --user-data-dir=C:\Users\Lunev\AppData\Roaming\cockpit-net-data
```

Живьём (и в окне, и в браузере на `http://127.0.0.1:48301`):
1. «+ Проект» открывает обзор, а не системный диалог.
2. Клик по папке углубляет, `..` и крошки поднимают, диски слева переключают.
3. Скрытые папки и `node_modules` видны; файлы серые и на клик не реагируют.
4. Папка с уже открытой вкладкой помечена.
5. «Открыть сессию здесь» заводит вкладку в выбранной папке.
6. В браузере кнопки «Системное окно» нет; в окне ПК — есть и работает.
7. `Esc` закрывает, фокус возвращается туда, откуда открыли.
8. Каталог с тысячами записей (`C:\Windows\System32`) не вешает интерфейс и
   показывает пометку об обрезке.
9. Папка без прав (`C:\System Volume Information`) даёт строку «нет доступа», а не
   пустой экран и не падение.

- [ ] **Шаг 6: коммит**

```
git add src/renderer/js/app.js src/renderer/js/api-boot.js
git commit -F <файл с сообщением>
```
Сообщение: `feat: плюс-проект открывает файловый обзор`

---

## Осознанно НЕ делаем

- **Закреплённые папки.** Спека упоминала их рядом с недавними, но отдельного
  хранилища для них нет, а недавние собираются даром из живых вкладок и
  воркспейсов. Добавить позже дешевле, чем поддерживать пустой раздел.
- **Создание, переименование, удаление, копирование, превью файлов** — прямой
  запрет спеки. Это выбор папки, а не файловый менеджер.
- **Подхват существующей сессии (`--resume`)** — решение владельца: всегда новая
  сессия, для старых есть поиск истории `Ctrl+Shift+H`.
- **Переключатель «показать скрытые»** — решение владельца: показываем всё.

---

## Приёмка (руками, на двух машинах)

1. На ПК: «+ Проект» → обзор → выбрать `C:\Users\Lunev\helper` → «Открыть сессию
   здесь» → вкладка поднялась в этой папке.
2. С макбука через браузер: то же самое, включая переход по дискам. Системного
   диалога на ПК при этом НЕ появляется.
3. Невладелец (второй клиент): обзор открывается и листается, «Открыть сессию
   здесь» отвечает тостом про управление.
4. Обзор поверх дашборда/палитры не открывается, `Esc` закрывает, `Ctrl+Q` под
   открытым обзором не разворачивает поле очереди.
