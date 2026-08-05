# Трей, автозапуск и эстафета управления — план реализации

> **Исполнителю:** обязательный под-навык — `superpowers:subagent-driven-development`.
> Шаги помечены чекбоксами (`- [ ]`) для отслеживания.

**Цель:** кокпит переживает закрытие окна (живёт в трее, поднимается при входе в
Windows), а управление передаётся между окном на ПК и браузером на макбуке — по
одному хозяину в каждый момент.

**Архитектура:** владение — чистый модуль `ownership.js` без Electron; запрет записи
для невладельца — единый гард в реестре команд (оба транспорта, локальный и сетевой,
проходят через него); трей, скрытие окна и автозапуск — тонкая проводка в `main.js`
поверх чистых модулей, которые решают «что показать» и «чем запуститься».

**Стек:** Electron 29.4.6, `node --test`, `ws` (уже есть). Новых зависимостей нет.

## Общие ограничения

- Ветка `feat-tray-handoff` в `C:\Users\Lunev\AssistClaude\claude-cockpit-net`.
  Remote называется **`upstream`**, не `origin`.
- Запускать приложение ТОЛЬКО с изоляцией хранилища:
  `npm start -- --user-data-dir=C:\Users\Lunev\AppData\Roaming\cockpit-net-data`.
  Без флага дубликат перепишет состояние рабочего кокпита (имя приложения общее).
- Команды с путями Windows — **через PowerShell**, не через Bash: Bash съедает
  бэкслэши и уже дважды создавал мусорные папки из испорченного пути.
- Комментарии и сообщения коммитов — по-русски. В логах и `.ps1` — только ASCII.
- Новых зависимостей не добавлять. Нативных модулей не добавлять.
- Тесты — `node --test`, файлы в `test/`, имя `<модуль>.test.js`.
- Renderer не покрыт `node --test` (структурный пробел проекта): из renderer
  тестируются только чистые модули через динамический `import()`.
- Каждая задача заканчивается коммитом. `git add` — **поимённо**, не `-A`.

---

### Задача 1: ядро эстафеты — `ownership.js`

Кто сейчас владеет управлением, кто может писать, что происходит при захвате и уходе.
Чистый модуль: ни Electron, ни сокетов, ни таймеров.

**Файлы:**
- Создать: `src/main/ownership.js`
- Тест: `test/ownership.test.js`

**Интерфейсы:**
- Использует: ничего.
- Отдаёт: `createOwnership({ onChange })` → объект с методами
  - `owner()` → `'local' | string` — идентификатор владельца (сетевой клиент — строка вида `'c1'`)
  - `size()` → `{ cols, rows } | null` — размер терминала, присланный владельцем при захвате
  - `claim(who, size)` → `boolean` — забрать управление; `true`, если владелец сменился
  - `drop(who)` → `boolean` — клиент ушёл; `true`, если ушедший был владельцем
  - `canWrite(who)` → `boolean`
  - `ownerOnline()` → `boolean` — владелец на связи (не отвалился)
- `onChange({ owner, previous, size })` зовётся ТОЛЬКО при реальной смене владельца.

**Правила поведения (фиксируются тестами):**

| событие | владелец до | владелец после | onChange |
| --- | --- | --- | --- |
| старт | — | `'local'` | нет |
| `claim('c1', {80,24})` | `'local'` | `'c1'` | да |
| `claim('c1', {100,30})` повторно | `'c1'` | `'c1'` | нет, но `size()` обновился |
| `claim('local', {200,50})` | `'c1'` | `'local'` | да |
| `drop('c2')` (не владелец) | `'c1'` | `'c1'` | нет |
| `drop('c1')` (владелец) | `'c1'` | `'c1'` | нет, но `ownerOnline()` → `false` |
| `claim('c1')` после своего же `drop` | `'c1'` | `'c1'` | нет, `ownerOnline()` → `true` |

Уход владельца **не отдаёт** управление обратно: закрытая крышка макбука не должна
разворачивать окно на ПК. Управление вернётся, когда его кто-то заберёт явно.

- [ ] **Шаг 1: написать падающий тест**

```js
'use strict';
// Эстафета: кто владеет управлением. Чистое ядро — Electron и сокеты сюда
// не входят, поэтому всё поведение проверяется прямыми вызовами.
const { test } = require('node:test');
const assert = require('node:assert');
const { createOwnership } = require('../src/main/ownership');

// Собираем вызовы onChange списком: «сколько раз позвали» — половина
// проверяемых правил (повторный захват тем же клиентом обязан молчать).
function make() {
  const changes = [];
  const own = createOwnership({ onChange: (info) => changes.push(info) });
  return { own, changes };
}

test('на старте владеет локальное окно, писать может только оно', () => {
  const { own, changes } = make();
  assert.strictEqual(own.owner(), 'local');
  assert.strictEqual(own.canWrite('local'), true);
  assert.strictEqual(own.canWrite('c1'), false);
  assert.strictEqual(own.size(), null);
  assert.deepStrictEqual(changes, []);
});

test('захват сетевым клиентом переносит владение и его размер', () => {
  const { own, changes } = make();
  assert.strictEqual(own.claim('c1', { cols: 80, rows: 24 }), true);
  assert.strictEqual(own.owner(), 'c1');
  assert.deepStrictEqual(own.size(), { cols: 80, rows: 24 });
  assert.strictEqual(own.canWrite('local'), false);
  assert.strictEqual(own.canWrite('c1'), true);
  assert.strictEqual(changes.length, 1);
  assert.deepStrictEqual(changes[0], {
    owner: 'c1', previous: 'local', size: { cols: 80, rows: 24 },
  });
});

test('повторный захват тем же клиентом не событие, но размер обновляет', () => {
  const { own, changes } = make();
  own.claim('c1', { cols: 80, rows: 24 });
  assert.strictEqual(own.claim('c1', { cols: 100, rows: 30 }), false);
  assert.strictEqual(changes.length, 1);
  assert.deepStrictEqual(own.size(), { cols: 100, rows: 30 });
});

test('захват без размера сохраняет прежний размер', () => {
  const { own } = make();
  own.claim('c1', { cols: 80, rows: 24 });
  own.claim('local');
  assert.deepStrictEqual(own.size(), { cols: 80, rows: 24 });
});

test('уход НЕ владельца ничего не меняет', () => {
  const { own, changes } = make();
  own.claim('c1', { cols: 80, rows: 24 });
  assert.strictEqual(own.drop('c2'), false);
  assert.strictEqual(own.owner(), 'c1');
  assert.strictEqual(own.ownerOnline(), true);
  assert.strictEqual(changes.length, 1);
});

test('уход владельца не отдаёт управление, но помечает его офлайн', () => {
  const { own, changes } = make();
  own.claim('c1', { cols: 80, rows: 24 });
  assert.strictEqual(own.drop('c1'), true);
  assert.strictEqual(own.owner(), 'c1', 'обрыв связи не равен потере управления');
  assert.strictEqual(own.ownerOnline(), false);
  assert.strictEqual(own.canWrite('local'), false, 'окно ПК не забирает управление само');
  assert.strictEqual(changes.length, 1, 'уход владельца — не смена владельца');
});

test('вернувшийся владелец снова онлайн без события смены', () => {
  const { own, changes } = make();
  own.claim('c1', { cols: 80, rows: 24 });
  own.drop('c1');
  assert.strictEqual(own.claim('c1', { cols: 80, rows: 24 }), false);
  assert.strictEqual(own.ownerOnline(), true);
  assert.strictEqual(changes.length, 1);
});

test('локальное окно забирает управление обратно', () => {
  const { own, changes } = make();
  own.claim('c1', { cols: 80, rows: 24 });
  assert.strictEqual(own.claim('local', { cols: 200, rows: 50 }), true);
  assert.strictEqual(own.owner(), 'local');
  assert.strictEqual(own.ownerOnline(), true);
  assert.deepStrictEqual(changes[1], {
    owner: 'local', previous: 'c1', size: { cols: 200, rows: 50 },
  });
});

test('createOwnership работает без onChange', () => {
  const own = createOwnership();
  assert.strictEqual(own.claim('c1', { cols: 80, rows: 24 }), true);
  assert.strictEqual(own.owner(), 'c1');
});
```

- [ ] **Шаг 2: убедиться, что тест падает**

```
npm test -- --test-name-pattern="владе|захват|уход"
```
Ожидание: FAIL, `Cannot find module '../src/main/ownership'`.

- [ ] **Шаг 3: минимальная реализация**

```js
'use strict';
// Кто сейчас за рулём. У pty один размер на всех клиентов, поэтому
// одновременных хозяев быть не может — эксклюзивность убирает целый слой
// согласования колонок и строк.
//
// Уход владельца НЕ передаёт управление: закрытая крышка макбука не должна
// разворачивать окно на ПК посреди ночи. Управление меняется только явным
// захватом — открытием страницы в браузере или показом окна на ПК.
function createOwnership({ onChange } = {}) {
  let owner = 'local';
  let online = true;
  let size = null;

  function claim(who, nextSize) {
    if (nextSize) size = { cols: nextSize.cols, rows: nextSize.rows };
    if (who === owner) {
      // Тот же хозяин вернулся после обрыва — событие не нужно, но офлайн
      // снимаем: интерфейс показывает «владелец не на связи».
      online = true;
      return false;
    }
    const previous = owner;
    owner = who;
    online = true;
    if (typeof onChange === 'function') onChange({ owner, previous, size });
    return true;
  }

  function drop(who) {
    if (who !== owner) return false;
    online = false;
    return true;
  }

  return {
    owner: () => owner,
    size: () => size,
    ownerOnline: () => online,
    canWrite: (who) => who === owner,
    claim,
    drop,
  };
}

module.exports = { createOwnership };
```

- [ ] **Шаг 4: тесты зелёные**

```
npm test -- --test-name-pattern="владе|захват|уход"
```

- [ ] **Шаг 5: коммит**

```
git add src/main/ownership.js test/ownership.test.js
git commit -m "feat: ядро эстафеты — кто владеет управлением"
```

---

### Задача 2: какие команды требуют управления — `write-channels.js`

Список пишущих каналов и **тест полноты**: любой новый канал обязан быть
классифицирован, иначе тест краснеет. Это защита от класса ошибки «добавили команду
через полгода, она молча проходит мимо эстафеты».

**Файлы:**
- Создать: `src/main/write-channels.js`
- Тест: `test/write-channels.test.js`

**Интерфейсы:**
- Использует: ничего (список каналов сверяется тестом с `src/renderer/js/api-shape.js`).
- Отдаёт: `isWriteChannel(channel)` → `boolean`; `WRITE_CHANNELS`, `FREE_CHANNELS` (Set).

**Что запрещено невладельцу** (спека: ввод в терминал, вкладки, очередь, голос):
`term:start`, `term:write`, `term:resize`, `term:restart`, `tabs:open`, `tabs:close`,
`queue:add`, `queue:remove`, `queue:clear`, `stt:transcribe`, `ghost:save`,
`workspace:setActive`.

**Что разрешено всем** (чтение и безвредное): `config:get`, `config:set`, `tabs:list`,
`tabs:chooseFolder`, `tabs:seen`, `shell:openExternal`, `net:buffer`, `app:devtools`,
`project:connect`, `project:status`, `git:get`, `gh:repo`, `gh:global`, `workspace:get`,
`workspace:ready`, `ghost:load`, `attention:update`, `screenshot:paste`,
`history:search`, `history:refresh`, `recipes:list`, `recipes:savePrompt`,
`recipes:deletePrompt`, `recipes:fillPrompt`, `recipes:normalizeForPty`,
`recipes:listWorkspaces`, `recipes:saveWorkspace`, `recipes:deleteWorkspace`,
`night:toggle`, `night:get`, `usage:get`, `usage:refresh`, `stt:status`,
`owner:claim`, `owner:get`.

- [ ] **Шаг 1: написать падающий тест**

```js
'use strict';
// Классификация каналов для эстафеты. Главный тест здесь — не «term:write
// запрещён», а ПОЛНОТА: канал, забытый при добавлении новой команды, обязан
// ронять сборку, а не тихо получать право писать в чужой терминал.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  isWriteChannel, WRITE_CHANNELS, FREE_CHANNELS,
} = require('../src/main/write-channels');

// api-shape.js — ES-модуль renderer'а; из CommonJS-теста он доступен только
// динамическим import() (тот же приём, что в net-api.test.js).
const shapeUrl = pathToFileURL(
  path.join(__dirname, '..', 'src', 'renderer', 'js', 'api-shape.js'),
).href;

test('ввод в терминал требует управления, чтение — нет', () => {
  assert.strictEqual(isWriteChannel('term:write'), true);
  assert.strictEqual(isWriteChannel('term:resize'), true);
  assert.strictEqual(isWriteChannel('tabs:open'), true);
  assert.strictEqual(isWriteChannel('queue:add'), true);
  assert.strictEqual(isWriteChannel('stt:transcribe'), true);
  assert.strictEqual(isWriteChannel('usage:get'), false);
  assert.strictEqual(isWriteChannel('net:buffer'), false);
  assert.strictEqual(isWriteChannel('tabs:list'), false);
});

test('захват управления невладельцу не запрещён — иначе его не забрать', () => {
  assert.strictEqual(isWriteChannel('owner:claim'), false);
  assert.strictEqual(isWriteChannel('owner:get'), false);
});

test('неизвестный канал считается пишущим', () => {
  // Осторожная сторона по умолчанию: незнакомое имя скорее что-то меняет.
  assert.strictEqual(isWriteChannel('никогдатакогонебыло'), true);
});

test('списки не пересекаются', () => {
  const both = [...WRITE_CHANNELS].filter((c) => FREE_CHANNELS.has(c));
  assert.deepStrictEqual(both, [], 'канал не может быть одновременно и там, и там');
});

test('КАЖДЫЙ канал формы api классифицирован', async () => {
  const { API_SHAPE } = await import(shapeUrl);
  const missing = [];
  for (const [name, spec] of Object.entries(API_SHAPE)) {
    if (spec.kind === 'event') continue; // события идут в обратную сторону
    if (!WRITE_CHANNELS.has(spec.channel) && !FREE_CHANNELS.has(spec.channel)) {
      missing.push(`${name} (${spec.channel})`);
    }
  }
  assert.deepStrictEqual(
    missing, [],
    'новый канал не отнесён ни к пишущим, ни к свободным — допишите его в write-channels.js',
  );
});
```

- [ ] **Шаг 2: убедиться, что тест падает**

```
npm test -- --test-name-pattern="канал|управления|списки"
```
Ожидание: FAIL, модуль не найден.

- [ ] **Шаг 3: реализация**

```js
'use strict';
// Что невладелец делать не может. Принцип: запрещаем ровно то, чем можно
// испортить работу тому, кто сейчас за рулём, — ввод в pty, вкладки, очередь,
// голос и черновики. Чтение статусов, лимитов и истории идёт всем: без этого
// заглушка на неактивной машине была бы слепой и человек не понимал бы, что
// вообще происходит на той стороне.
//
// Списки ЯВНЫЕ, оба. Тест полноты (test/write-channels.test.js) требует, чтобы
// каждый канал формы api попал ровно в один из них: новая команда, добавленная
// через полгода, обязана уронить прогон, а не молча получить право писать.
const WRITE_CHANNELS = new Set([
  'term:start', 'term:write', 'term:resize', 'term:restart',
  'tabs:open', 'tabs:close',
  'queue:add', 'queue:remove', 'queue:clear',
  'stt:transcribe',
  'ghost:save',
  'workspace:setActive',
]);

const FREE_CHANNELS = new Set([
  'config:get', 'config:set',
  'tabs:list', 'tabs:chooseFolder', 'tabs:seen',
  'shell:openExternal', 'net:buffer', 'app:devtools',
  'project:connect', 'project:status',
  'git:get', 'gh:repo', 'gh:global',
  'workspace:get', 'workspace:ready',
  'ghost:load', 'attention:update', 'screenshot:paste',
  'history:search', 'history:refresh',
  'recipes:list', 'recipes:savePrompt', 'recipes:deletePrompt',
  'recipes:fillPrompt', 'recipes:normalizeForPty',
  'recipes:listWorkspaces', 'recipes:saveWorkspace', 'recipes:deleteWorkspace',
  'night:toggle', 'night:get',
  'usage:get', 'usage:refresh',
  'stt:status',
  // Захват управления обязан быть доступен тому, у кого управления нет, —
  // иначе забрать его невозможно в принципе.
  'owner:claim', 'owner:get',
]);

// Незнакомое имя считаем пишущим: ошибка в эту сторону стоит одного отказа,
// в другую — чужой команды в живом терминале.
function isWriteChannel(channel) {
  if (FREE_CHANNELS.has(channel)) return false;
  return true;
}

module.exports = { isWriteChannel, WRITE_CHANNELS, FREE_CHANNELS };
```

- [ ] **Шаг 4: тесты зелёные**

```
npm test -- --test-name-pattern="канал|управления|списки"
```

- [ ] **Шаг 5: коммит**

```
git add src/main/write-channels.js test/write-channels.test.js
git commit -m "feat: классификация каналов — что требует управления"
```

---

### Задача 3: единый гард в реестре команд

Оба транспорта — локальный `ipcMain` и сетевой WebSocket — уже ходят через
`command-registry.js`. Гард ставится **там**, а не в каждом транспорте: иначе они
разъедутся, и один путь останется открытым.

**Файлы:**
- Изменить: `src/main/command-registry.js`
- Тест: `test/command-registry.test.js` (дописать)

**Интерфейсы:**
- Использует: `isWriteChannel` не импортирует — гард инжектируется параметром
  (модуль остаётся чистым и тестируемым без знания о списках).
- Отдаёт:
  - `createCommandRegistry({ ipcMain, guard })`, где `guard({ channel, who })` → `boolean`;
    без параметра — разрешено всё (существующие вызовы не ломаются)
  - `call(channel, args, who = 'local')` — третий параметр: кто зовёт
  - при отказе: `call` **бросает** `Error('нет управления')` с полем `err.denied === true`;
    локальный `invoke` возвращает `null`, локальный `send` не делает ничего

- [ ] **Шаг 1: написать падающий тест** (дописать в конец `test/command-registry.test.js`)

```js
test('гард отклоняет запись от того, у кого нет управления', async () => {
  const calls = [];
  const ipcMain = fakeIpcMain();
  const registry = createCommandRegistry({
    ipcMain,
    guard: ({ channel, who }) => !(channel === 'term:write' && who !== 'local'),
  });
  registry.handle('term:write', (payload) => { calls.push(payload); return 'ок'; });

  assert.strictEqual(await registry.call('term:write', ['от локального'], 'local'), 'ок');
  await assert.rejects(
    () => registry.call('term:write', ['от чужого'], 'c1'),
    (err) => err.denied === true,
  );
  assert.deepStrictEqual(calls, ['от локального'], 'обработчик не должен был увидеть чужой вызов');
});

test('who по умолчанию — локальное окно', async () => {
  const registry = createCommandRegistry({
    ipcMain: fakeIpcMain(),
    guard: ({ who }) => who === 'local',
  });
  registry.handle('term:write', () => 'ок');
  assert.strictEqual(await registry.call('term:write', ['x']), 'ок');
});

test('локальный invoke при отказе возвращает null, а не бросает в окно', async () => {
  const ipcMain = fakeIpcMain();
  const registry = createCommandRegistry({ ipcMain, guard: () => false });
  let called = false;
  registry.handle('term:write', () => { called = true; return 'ок'; });
  const result = await ipcMain.invokeHandler('term:write', {}, 'полезная нагрузка');
  assert.strictEqual(result, null);
  assert.strictEqual(called, false);
});

test('локальный send при отказе молчит', () => {
  const ipcMain = fakeIpcMain();
  const registry = createCommandRegistry({ ipcMain, guard: () => false });
  let called = false;
  registry.on('term:data', () => { called = true; });
  ipcMain.sendHandler('term:data', {}, 'полезная нагрузка');
  assert.strictEqual(called, false);
});

test('без guard реестр работает как раньше', async () => {
  const registry = createCommandRegistry({ ipcMain: fakeIpcMain() });
  registry.handle('term:write', () => 'ок');
  assert.strictEqual(await registry.call('term:write', ['x'], 'кто-угодно'), 'ок');
});
```

Если в файле нет `fakeIpcMain` с возможностью вызвать зарегистрированный обработчик —
добавить вверху файла:

```js
// Поддельный ipcMain, который УМЕЕТ позвать зарегистрированный обработчик:
// без этого локальный путь (окно ПК) остался бы непокрытым, а именно на нём
// живёт половина гарда.
function fakeIpcMain() {
  const invoke = new Map();
  const send = new Map();
  return {
    handle: (ch, fn) => invoke.set(ch, fn),
    on: (ch, fn) => send.set(ch, fn),
    invokeHandler: (ch, ...args) => invoke.get(ch)(...args),
    sendHandler: (ch, ...args) => send.get(ch)(...args),
  };
}
```

- [ ] **Шаг 2: убедиться, что тест падает**

```
npm test -- test/command-registry.test.js
```
Ожидание: FAIL — гарда нет, чужой вызов проходит.

- [ ] **Шаг 3: реализация** — заменить тело `createCommandRegistry`:

```js
function createCommandRegistry({ ipcMain, guard } = {}) {
  const handlers = new Map(); // channel → { kind: 'invoke' | 'send', fn }

  // Гард живёт ЗДЕСЬ, а не в транспортах: локальный ipcMain и сетевой сокет
  // оба приходят сюда, и это единственное место, где их нельзя развести по
  // разным правилам. Инжектируется параметром, чтобы модуль не знал ни про
  // список пишущих каналов, ни про эстафету, — и тестировался без них.
  const allowed = (channel, who) => (typeof guard === 'function' ? guard({ channel, who }) : true);

  function handle(channel, fn) {
    handlers.set(channel, { kind: 'invoke', fn });
    ipcMain.handle(channel, (_event, ...args) => {
      // Локальный отказ — молчаливый null. Бросать в окно нельзя: renderer
      // показал бы ошибку там, где по замыслу просто ничего не происходит.
      if (!allowed(channel, 'local')) return null;
      return fn(...args);
    });
  }

  function on(channel, fn) {
    handlers.set(channel, { kind: 'send', fn });
    ipcMain.on(channel, (_event, ...args) => {
      if (!allowed(channel, 'local')) return;
      fn(...args);
    });
  }

  async function call(channel, args = [], who = 'local') {
    const entry = handlers.get(channel);
    if (!entry) throw new Error(`неизвестная команда: ${channel}`);
    if (!allowed(channel, who)) {
      // Отдельное поле, а не разбор текста: сетевой транспорт по нему решает,
      // что это штатный отказ эстафеты, а не поломка команды.
      throw Object.assign(new Error('нет управления'), { denied: true });
    }
    return entry.fn(...args);
  }

  return {
    handle,
    on,
    call,
    has: (channel) => handlers.has(channel),
    names: () => [...handlers.keys()],
  };
}
```

- [ ] **Шаг 4: весь прогон зелёный** (гард не должен сломать существующие тесты)

```
npm test
```

- [ ] **Шаг 5: коммит**

```
git add src/main/command-registry.js test/command-registry.test.js
git commit -m "feat: гард записи в реестре команд — один на оба транспорта"
```

---

### Задача 4: сетевой транспорт — личность клиента, захват, отказ

Сервер должен знать, КТО прислал кадр, сообщать клиенту его имя и обслуживать захват
управления. Захват обслуживается сервером напрямую (как уже сделано для `net:buffer`):
только он знает, какому сокету принадлежит кадр.

**Файлы:**
- Изменить: `src/main/net-server.js`
- Тест: `test/net-server.test.js` (дописать)

**Интерфейсы:**
- Использует: `ownership` из задачи 1 — передаётся параметром `createNetServer({ ownership, ... })`.
  Параметр необязательный: без него сервер ведёт себя как раньше (существующие тесты живы).
- Отдаёт:
  - клиенту сразу после подключения уходит событие `{ event: 'net:hello', payload: { clientId } }`
  - кадр `{ channel: 'owner:claim', args: [{ cols, rows }] }` от клиента `cN` → `ownership.claim('cN', size)`,
    ответ `{ ok: true, result: { owner, self } }`
  - кадр `{ channel: 'owner:get' }` → `{ ok: true, result: { owner, self, online } }`
  - закрытие сокета → `ownership.drop(clientId)`
  - отказ гарда → `{ ok: false, error: 'нет управления', denied: true }`

- [ ] **Шаг 1: написать падающий тест** (дописать в `test/net-server.test.js`)

```js
const { createOwnership } = require('../src/main/ownership');

// makeServer из этого файла не знает про эстафету — собираем отдельный,
// с гардом и владением, ровно как их собирает ipc.js в проде.
function makeHandoffServer() {
  const ownership = createOwnership({});
  const registry = createCommandRegistry({
    ipcMain: fakeIpcMain(),
    guard: ({ channel, who }) => !isWriteChannel(channel) || ownership.canWrite(who),
  });
  const written = [];
  registry.handle('term:write', (payload) => { written.push(payload); return 'ок'; });
  registry.handle('usage:get', () => ({ спент: 1 }));
  const server = createNetServer({
    registry,
    ownership,
    broadcast: createBroadcast({ getWindow: () => null }),
    outputBuffer: createOutputBuffer({}),
    staticRoots: { '/': path.join(__dirname, '..', 'src', 'renderer') },
    port: 0,
    host: '127.0.0.1',
  });
  activeServers.push(server);
  return { server, ownership, written };
}

const ask = (ws, frame) => {
  const answer = nextFrame(ws);
  ws.send(JSON.stringify(frame));
  return answer;
};

test('клиент узнаёт своё имя сразу после подключения', async () => {
  const { server } = makeHandoffServer();
  const { port } = await server.start();
  const ws = await open(`ws://127.0.0.1:${port}/ws`);
  const hello = await nextFrame(ws);
  assert.strictEqual(hello.event, 'net:hello');
  assert.strictEqual(typeof hello.payload.clientId, 'string');
  assert.ok(hello.payload.clientId.length > 0);
  ws.close();
});

test('без управления запись отклоняется, а чтение проходит', async () => {
  const { server, written } = makeHandoffServer();
  const { port } = await server.start();
  const ws = await open(`ws://127.0.0.1:${port}/ws`);
  await nextFrame(ws); // net:hello

  const denied = await ask(ws, { id: 1, channel: 'term:write', args: [{ tabId: 'T1', data: 'ls\r' }] });
  assert.strictEqual(denied.ok, false);
  assert.strictEqual(denied.denied, true);
  assert.deepStrictEqual(written, [], 'до захвата ни один байт не имеет права дойти до pty');

  const read = await ask(ws, { id: 2, channel: 'usage:get', args: [] });
  assert.strictEqual(read.ok, true, 'чтение доступно и без управления — иначе заглушка слепая');
  ws.close();
});

test('после захвата тот же клиент пишет свободно', async () => {
  const { server, ownership, written } = makeHandoffServer();
  const { port } = await server.start();
  const ws = await open(`ws://127.0.0.1:${port}/ws`);
  const hello = await nextFrame(ws);

  const claimed = await ask(ws, { id: 1, channel: 'owner:claim', args: [{ cols: 90, rows: 30 }] });
  assert.strictEqual(claimed.ok, true);
  assert.strictEqual(claimed.result.owner, hello.payload.clientId);
  assert.strictEqual(claimed.result.self, hello.payload.clientId);
  assert.deepStrictEqual(ownership.size(), { cols: 90, rows: 30 });

  const ok = await ask(ws, { id: 2, channel: 'term:write', args: [{ tabId: 'T1', data: 'ls\r' }] });
  assert.strictEqual(ok.ok, true);
  assert.deepStrictEqual(written, [{ tabId: 'T1', data: 'ls\r' }]);
  ws.close();
});

test('второй клиент забирает управление у первого', async () => {
  const { server, written } = makeHandoffServer();
  const { port } = await server.start();
  const a = await open(`ws://127.0.0.1:${port}/ws`);
  await nextFrame(a);
  await ask(a, { id: 1, channel: 'owner:claim', args: [{ cols: 80, rows: 24 }] });

  const b = await open(`ws://127.0.0.1:${port}/ws`);
  await nextFrame(b);
  await ask(b, { id: 1, channel: 'owner:claim', args: [{ cols: 120, rows: 40 }] });

  const denied = await ask(a, { id: 2, channel: 'term:write', args: [{ tabId: 'T1', data: 'вредное' }] });
  assert.strictEqual(denied.ok, false);
  assert.deepStrictEqual(written, [], 'потерявший управление больше не пишет');
  a.close();
  b.close();
});

test('уход клиента не отдаёт управление обратно локальному окну', async () => {
  const { server, ownership } = makeHandoffServer();
  const { port } = await server.start();
  const ws = await open(`ws://127.0.0.1:${port}/ws`);
  const hello = await nextFrame(ws);
  await ask(ws, { id: 1, channel: 'owner:claim', args: [{ cols: 80, rows: 24 }] });

  const gone = new Promise((resolve) => ws.on('close', resolve));
  ws.close();
  await gone;
  // Сокет закрывается асинхронно и на стороне сервера — ждём, пока он это заметит.
  const deadline = Date.now() + 2000;
  while (ownership.ownerOnline() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.strictEqual(ownership.owner(), hello.payload.clientId, 'обрыв ≠ потеря управления');
  assert.strictEqual(ownership.ownerOnline(), false);
});
```

Импорт `isWriteChannel` добавить вверху файла: `const { isWriteChannel } = require('../src/main/write-channels');`

- [ ] **Шаг 2: убедиться, что тест падает**

```
npm test -- test/net-server.test.js
```
Ожидание: FAIL — `net:hello` не приходит, запись проходит без захвата.

- [ ] **Шаг 3: реализация** в `net-server.js`:

1. В сигнатуру `createNetServer({ ... })` добавить `ownership`.
2. Счётчик имён рядом с `const clients = new Set();`:

```js
  // Имя клиента живёт ровно столько, сколько сокет: переподключившийся
  // макбук — НОВЫЙ клиент и захватывает управление заново. Считать его тем
  // же было бы неверно (браузер мог быть закрыт и открыт на другой машине).
  let nextClientId = 1;
```

3. `onFrame(ws, raw)` → `onFrame(ws, raw, clientId)`; внутри, рядом с обработкой `net:buffer`:

```js
    try {
      let result;
      if (msg.channel === 'net:buffer') {
        // net:buffer обслуживает сервер, а не реестр: история — свойство
        // соединения, локальному окну она не нужна (у него свой xterm).
        result = outputBuffer.get(args[0]);
      } else if (msg.channel === 'owner:claim' || msg.channel === 'owner:get') {
        // Тот же случай, что и net:buffer: только сервер знает, ЧЕЙ это
        // сокет. Реестр получил бы кадр без личности и не смог бы отличить
        // захват макбуком от захвата локальным окном.
        if (!ownership) throw new Error('эстафета не подключена');
        if (msg.channel === 'owner:claim') ownership.claim(clientId, args[0]);
        result = { owner: ownership.owner(), self: clientId, online: ownership.ownerOnline() };
      } else {
        result = await registry.call(msg.channel, args, clientId);
      }
      reply({ ok: true, result: result === undefined ? null : result });
    } catch (err) {
      // denied — штатный отказ эстафеты, а не поломка: браузерный мост по
      // этому полю молчит вместо показа ошибки (спека: отклонение молчаливое).
      const body = { ok: false, error: String((err && err.message) || err) };
      if (err && err.denied) body.denied = true;
      reply(body);
    }
```

4. В `wss.on('connection', (ws) => { ... })`:

```js
        wss.on('connection', (ws) => {
          const clientId = `c${nextClientId}`;
          nextClientId += 1;
          const send = (event, payload) => ws.send(JSON.stringify({ event, payload }));
          clients.add(ws);
          heartbeats.set(ws, true);
          broadcast.addClient(send);
          // Своё имя клиент обязан узнать ДО первого кадра: без него он не
          // может понять, у него сейчас управление или у соседа.
          try { send('net:hello', { clientId }); } catch { /* сокет ушёл сразу */ }
          ws.on('message', (raw) => onFrame(ws, raw, clientId));
          ws.on('pong', () => heartbeats.set(ws, true));
          const forget = () => {
            clients.delete(ws);
            heartbeats.delete(ws);
            broadcast.removeClient(send);
            // Ушедший владелец управление НЕ теряет (спека: обрыв ≠ потеря),
            // ownership.drop лишь помечает его офлайн.
            if (ownership) ownership.drop(clientId);
          };
          ws.on('close', forget);
          ws.on('error', forget);
        });
```

- [ ] **Шаг 4: тесты зелёные**

```
npm test -- test/net-server.test.js
npm test
```

- [ ] **Шаг 5: коммит**

```
git add src/main/net-server.js test/net-server.test.js
git commit -m "feat: сетевой транспорт знает клиента и обслуживает захват"
```

---

### Задача 5: проводка эстафеты в `ipc.js`

Связывает ядро с реальностью: гард получает список каналов, локальное окно умеет
захватывать, смена владельца рассылается всем и переразмеривает pty.

**Файлы:**
- Изменить: `src/main/ipc.js`
- Тест: `test/ipc-handoff-wiring.test.js` (создать)

**Интерфейсы:**
- Использует: `createOwnership` (задача 1), `isWriteChannel` (задача 2),
  `registry.call(channel, args, who)` (задача 3), `createNetServer({ ownership })` (задача 4),
  `manager.list()` и `manager.resize(tabId, cols, rows)` — существующий API `sessions.js`.
- Отдаёт:
  - канал `owner:claim` (invoke) — для локального окна: `(size) => { ownership.claim('local', size); return состояние }`
  - канал `owner:get` (invoke) → `{ owner, self: 'local', online }`
  - событие `owner:changed` с `{ owner, online }` через `broadcast`
  - `registerIpc(...)` возвращает **дополнительно** `ownership` (нужен `main.js` для трея и окна)
  - функция-хелпер `applyHandoffSize({ manager, size })` — экспортируется из модуля
    для собственного теста (тот же приём, что `bufferTermData`)

- [ ] **Шаг 1: написать падающий тест** — создать `test/ipc-handoff-wiring.test.js`

```js
'use strict';
// Проводка эстафеты. registerIpc целиком под node --test не запускается
// (require('electron') вне рантайма не даёт объект), поэтому проверяем ту
// самую функцию, которую зовёт прод, — не копию.
const { test } = require('node:test');
const assert = require('node:assert');
const { applyHandoffSize } = require('../src/main/ipc');

function fakeManager(tabs) {
  const calls = [];
  return {
    calls,
    list: () => tabs,
    resize: (tabId, cols, rows) => calls.push({ tabId, cols, rows }),
  };
}

test('смена владельца переразмеривает ВСЕ живые вкладки под его терминал', () => {
  const manager = fakeManager([{ id: 'T1' }, { id: 'T2' }, { id: 'T3' }]);
  applyHandoffSize({ manager, size: { cols: 120, rows: 40 } });
  assert.deepStrictEqual(manager.calls, [
    { tabId: 'T1', cols: 120, rows: 40 },
    { tabId: 'T2', cols: 120, rows: 40 },
    { tabId: 'T3', cols: 120, rows: 40 },
  ]);
});

test('без размера не трогаем ничего', () => {
  const manager = fakeManager([{ id: 'T1' }]);
  applyHandoffSize({ manager, size: null });
  applyHandoffSize({ manager, size: { cols: 0, rows: 0 } });
  applyHandoffSize({ manager, size: { cols: 80 } });
  assert.deepStrictEqual(manager.calls, [], 'кривой размер хуже, чем прежний');
});
```

- [ ] **Шаг 2: убедиться, что тест падает**

```
npm test -- test/ipc-handoff-wiring.test.js
```
Ожидание: FAIL — `applyHandoffSize is not a function`.

- [ ] **Шаг 3: реализация в `ipc.js`**

Импорты рядом с остальными (верх файла):

```js
const { createOwnership } = require('./ownership');
const { isWriteChannel } = require('./write-channels');
```

Рядом с `bufferTermData` (там же, где живут вынесенные ради тестов функции):

```js
// У pty один размер на всех, поэтому терминал подгоняется под того, кто сейчас
// за рулём, — один раз, в момент пересадки. Все вкладки рисуются в одну и ту
// же область окна, значит и размер у них общий.
// Кривой размер (нули, отсутствующее поле) ХУЖЕ, чем прежний: ConPTY на нулевых
// колонках ломает перерисовку Claude Code.
function applyHandoffSize({ manager, size }) {
  if (!size || !(size.cols > 0) || !(size.rows > 0)) return;
  for (const tab of manager.list()) manager.resize(tab.id, size.cols, size.rows);
}
```

В `registerIpc(...)` — **между** присвоением `manager = createSessionManager({...})`
(`ipc.js:1356`) и созданием реестра (`ipc.js:1587`). Порядок обязателен в обе стороны:
`onChange` дёргает `manager`, а гард нужен реестру уже при сборке.

```js
  // Эстафета: один хозяин в каждый момент. Владение живёт в чистом модуле,
  // здесь — только проводка к настоящим pty, окну и клиентам.
  const ownership = createOwnership({
    onChange: ({ owner, size }) => {
      applyHandoffSize({ manager, size });
      broadcast.emit('owner:changed', { owner, online: ownership.ownerOnline() });
      if (typeof onOwnerChange === 'function') onOwnerChange(owner);
    },
  });
```

Гард при создании реестра:

```js
  const registry = createCommandRegistry({
    ipcMain,
    // Чтение доступно всем, запись — только владельцу. Оба транспорта
    // приходят сюда, так что путей в обход нет.
    guard: ({ channel, who }) => !isWriteChannel(channel) || ownership.canWrite(who),
  });
```

Каналы (рядом с `net:buffer`):

```js
  // Локальное окно захватывает управление своим размером терминала — тот же
  // путь, что у браузера, только личность другая ('local').
  registry.handle('owner:claim', (size) => {
    ownership.claim('local', size);
    return { owner: ownership.owner(), self: 'local', online: ownership.ownerOnline() };
  });
  registry.handle('owner:get', () => (
    { owner: ownership.owner(), self: 'local', online: ownership.ownerOnline() }
  ));
```

`createNetServer({ ... })` — добавить `ownership,` в параметры.

`registerIpc` принимает новый необязательный колбэк — в сигнатуру опций:
`function registerIpc(win, { smoke, attention, toaster, onOwnerChange } = {})`.

Возврат `registerIpc` дополнить: `return { broadcast, netServer, ownership };`

Экспорт модуля дополнить: `applyHandoffSize`.

- [ ] **Шаг 4: тесты зелёные**

```
npm test
```

- [ ] **Шаг 5: коммит**

```
git add src/main/ipc.js test/ipc-handoff-wiring.test.js
git commit -m "feat: проводка эстафеты — гард, захват, переразмер pty"
```

---

### Задача 6: трей и жизненный цикл окна

Крестик прячет окно вместо выхода; выход — из меню трея; окно прячется само, когда
управление уходит на другую машину, и показывается, когда возвращается.

**Файлы:**
- Создать: `src/main/tray-menu.js`, `test/tray-menu.test.js`
- Создать иконки: `assets/tray-local.ico`, `assets/tray-remote.ico`
- Изменить: `src/main/main.js`

**Интерфейсы:**
- Использует: `ownership` из `registerIpc` (задача 5), `onOwnerChange` (задача 5).
- Отдаёт: `buildTrayModel({ owner, online, address, autostart })` → чистое описание:

```js
{
  tooltip: 'Cockpit — управление здесь',
  icon: 'tray-local.ico',   // имя файла в assets/
  items: [
    { id: 'status', label: 'Управление здесь', enabled: false },
    { id: 'address', label: 'http://100.120.245.85:48300', enabled: true },
    { type: 'separator' },
    { id: 'show', label: 'Показать окно' },
    { id: 'autostart', label: 'Запускать при входе в Windows', type: 'checkbox', checked: false },
    { type: 'separator' },
    { id: 'quit', label: 'Выход' },
  ],
}
```

- [ ] **Шаг 1: написать падающий тест** — создать `test/tray-menu.test.js`

```js
'use strict';
// Меню трея. Electron сюда не входит: модуль решает ТОЛЬКО что показать,
// сборка настоящего Menu живёт в main.js.
const { test } = require('node:test');
const assert = require('node:assert');
const { buildTrayModel } = require('../src/main/tray-menu');

const ids = (model) => model.items.filter((i) => i.id).map((i) => i.id);

test('управление на ПК: обычная иконка и понятный статус', () => {
  const model = buildTrayModel({
    owner: 'local', online: true, address: 'http://100.120.245.85:48300', autostart: false,
  });
  assert.strictEqual(model.icon, 'tray-local.ico');
  assert.match(model.tooltip, /управление здесь/i);
  assert.deepStrictEqual(ids(model), ['status', 'address', 'show', 'autostart', 'quit']);
  assert.strictEqual(model.items.find((i) => i.id === 'status').enabled, false);
  assert.match(model.items.find((i) => i.id === 'status').label, /здесь/i);
});

test('управление на другой машине: приглушённая иконка и другой статус', () => {
  const model = buildTrayModel({
    owner: 'c1', online: true, address: 'http://100.120.245.85:48300', autostart: false,
  });
  assert.strictEqual(model.icon, 'tray-remote.ico');
  assert.match(model.items.find((i) => i.id === 'status').label, /на другой машине/i);
  assert.match(model.tooltip, /на другой машине/i);
});

test('владелец не на связи — так и написано', () => {
  const model = buildTrayModel({
    owner: 'c1', online: false, address: 'http://x:1', autostart: false,
  });
  assert.match(model.items.find((i) => i.id === 'status').label, /не на связи/i);
});

test('галочка автозапуска отражает состояние', () => {
  const on = buildTrayModel({ owner: 'local', online: true, address: 'http://x:1', autostart: true });
  const off = buildTrayModel({ owner: 'local', online: true, address: 'http://x:1', autostart: false });
  assert.strictEqual(on.items.find((i) => i.id === 'autostart').checked, true);
  assert.strictEqual(off.items.find((i) => i.id === 'autostart').checked, false);
  assert.strictEqual(on.items.find((i) => i.id === 'autostart').type, 'checkbox');
});

test('сеть не поднялась — строка адреса это говорит и не кликается', () => {
  const model = buildTrayModel({ owner: 'local', online: true, address: null, autostart: false });
  const item = model.items.find((i) => i.id === 'address');
  assert.match(item.label, /сеть недоступна/i);
  assert.strictEqual(item.enabled, false);
});
```

- [ ] **Шаг 2: убедиться, что тест падает**

```
npm test -- test/tray-menu.test.js
```

- [ ] **Шаг 3: реализация** — создать `src/main/tray-menu.js`

```js
'use strict';
// Что показывает трей. Чистый модуль: Electron собирает по этому описанию
// настоящее Menu, но решение «какой пункт, какая иконка, какой текст»
// принимается здесь и проверяется node --test.
function buildTrayModel({ owner, online, address, autostart }) {
  const local = owner === 'local';
  let status;
  if (local) status = 'Управление здесь';
  else if (online) status = 'Управление на другой машине';
  else status = 'Управление на другой машине (не на связи)';

  return {
    icon: local ? 'tray-local.ico' : 'tray-remote.ico',
    tooltip: `Cockpit — ${status.toLowerCase()}`,
    items: [
      { id: 'status', label: status, enabled: false },
      address
        ? { id: 'address', label: address, enabled: true }
        : { id: 'address', label: 'Сеть недоступна', enabled: false },
      { type: 'separator' },
      { id: 'show', label: 'Показать окно' },
      {
        id: 'autostart', label: 'Запускать при входе в Windows', type: 'checkbox', checked: !!autostart,
      },
      { type: 'separator' },
      { id: 'quit', label: 'Выход' },
    ],
  };
}

module.exports = { buildTrayModel };
```

- [ ] **Шаг 4: тест зелёный**

```
npm test -- test/tray-menu.test.js
```

- [ ] **Шаг 5: сгенерировать иконки** (PowerShell, ImageMagick 7 уже установлен)

```powershell
Set-Location C:\Users\Lunev\AssistClaude\claude-cockpit-net
magick assets\cockpit.png -resize 32x32 -define icon:auto-resize=32,24,16 assets\tray-local.ico
magick assets\cockpit.png -resize 32x32 -colorspace Gray -modulate 100,0,100 -alpha set -channel A -evaluate multiply 0.55 +channel -define icon:auto-resize=32,24,16 assets\tray-remote.ico
Get-ChildItem assets\tray-*.ico | Select-Object Name, Length
```

Ожидание: два файла, оба ненулевого размера. Приглушённая — серая и полупрозрачная.

- [ ] **Шаг 6: проводка в `main.js`**

Импорт `Tray` из electron и модуля:

```js
const {
  app, BrowserWindow, screen, Menu, Tray, nativeImage, Notification,
} = require('electron');
const { buildTrayModel } = require('./tray-menu');
```

Рядом с `let netServer = null;`:

```js
// Трей и намерение выйти. Крестик теперь ПРЯЧЕТ окно (кокпит должен пережить
// уход от компьютера — иначе с макбука не к чему подключаться), поэтому
// настоящий выход возможен только через меню трея, и отличается он именно
// этим флагом.
let tray = null;
let quitting = false;
// Первое скрытие окна объясняем один раз за запуск: без этого пропажа окна
// из панели задач и Alt+Tab выглядит как «приложение закрылось само».
let hideExplained = false;
```

В `createWindow()` — окно не показывать при автозапуске, а `close` перехватывать:

```js
  const winOpts = {
    width,
    height,
    // --hidden ставит автозапуск (задача 7): при входе в Windows кокпит
    // поднимается в трей и восстанавливает вкладки, но на экран не лезет.
    show: !process.argv.includes('--hidden'),
```

Существующий `win.on('close', ...)` заменить на:

```js
  win.on('close', (e) => {
    if (saveTimer) clearTimeout(saveTimer);
    saveState();
    // Выход только из меню трея. Всё остальное — прятать.
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
```

В `app.whenReady().then(...)`, после `registerIpc`:

```js
  const showWindow = () => {
    if (win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    // Показ окна = возврат управления. Размер знает только renderer (у него
    // xterm), поэтому просим ЕГО позвать owner.claim — путь один и тот же для
    // обеих машин, отличается только личность.
    win.webContents.send('owner:reclaim');
  };

  const hideWindow = () => {
    if (win.isDestroyed() || !win.isVisible()) return;
    win.hide();
    if (!hideExplained) {
      hideExplained = true;
      if (Notification.isSupported()) {
        new Notification({
          title: 'Cockpit свёрнут в трей',
          body: 'Управление ушло на другую машину. Значок в трее вернёт окно.',
        }).show();
      }
    }
  };

  function refreshTray() {
    if (!tray) return;
    const model = buildTrayModel({
      owner: ownership.owner(),
      online: ownership.ownerOnline(),
      address: netAddress,
      autostart: app.getLoginItemSettings().openAtLogin,
    });
    tray.setImage(path.join(appRoot(), 'assets', model.icon));
    tray.setToolTip(model.tooltip);
    tray.setContextMenu(Menu.buildFromTemplate(model.items.map((item) => {
      if (item.type === 'separator') return { type: 'separator' };
      const entry = { label: item.label, enabled: item.enabled !== false };
      if (item.type === 'checkbox') { entry.type = 'checkbox'; entry.checked = item.checked; }
      entry.click = () => trayClick(item.id);
      return entry;
    })));
  }

  function trayClick(id) {
    if (id === 'show') showWindow();
    else if (id === 'address' && netAddress) shell.openExternal(netAddress);
    else if (id === 'autostart') toggleAutostart();   // задача 7
    else if (id === 'quit') { quitting = true; app.quit(); }
  }
```

`shell` добавить в импорт electron. Адрес берётся у самого сервера, а не собирается
заново из конфига: при `port: 0` реальный порт эфемерный, а при неподнявшейся сети
адреса нет вовсе. В `main.js` — `const netAddress = netServer ? netServer.address() : null;`
(вычислять внутри `refreshTray()`, а не один раз: сервер мог подняться позже, с
повторной попытки). В `net-server.js` добавить в возвращаемый объект:

```js
    // Адрес для меню трея и для показа человеку: сервер знает и реальный порт
    // (при port:0 он эфемерный), и то, поднялся ли он вообще.
    address: () => (server && server.listening
      ? `http://${host.includes(':') ? `[${host}]` : host}:${server.address().port}`
      : null),
```

Создание трея и подписка на смену владельца — сразу после `registerIpc`:

```js
  tray = new Tray(nativeImage.createFromPath(path.join(appRoot(), 'assets', 'tray-local.ico')));
  tray.on('click', showWindow);
  refreshTray();
```

`registerIpc` вызвать с колбэком:

```js
  ({ broadcast, netServer, ownership } = registerIpc(win, {
    smoke: SMOKE,
    attention,
    toaster,
    onOwnerChange: (owner) => {
      if (owner === 'local') showWindow(); else hideWindow();
      refreshTray();
    },
  }));
```

`ownership` объявить рядом с `let broadcast = null;` (`let ownership = null;`).

`app.on('window-all-closed')` теперь недостижим при обычной работе (окно не
закрывается), но остаётся как есть — на случай `destroy()`.

- [ ] **Шаг 7: smoke не должен сломаться**

Smoke закрывает приложение через `app.exit()`, минуя трей. Проверить:

```powershell
Set-Location C:\Users\Lunev\AssistClaude\claude-cockpit-net
npm run smoke -- --user-data-dir=C:\Users\Lunev\AppData\Roaming\cockpit-net-data
```
Ожидание: `[smoke] window=OK`, `[smoke] renderer-errors=0`, код выхода 0.

- [ ] **Шаг 8: живая проверка трея** (руками, это единственный способ)

```powershell
Set-Location C:\Users\Lunev\AssistClaude\claude-cockpit-net
npm start -- --user-data-dir=C:\Users\Lunev\AppData\Roaming\cockpit-net-data
```
Проверить: значок в трее есть; крестик прячет окно, процесс жив
(`Get-Process electron`); клик по значку возвращает окно; «Выход» реально завершает
процесс. Приложить вывод `Get-Process` до и после «Выхода».

- [ ] **Шаг 9: коммит**

```
git add src/main/tray-menu.js test/tray-menu.test.js src/main/main.js src/main/net-server.js assets/tray-local.ico assets/tray-remote.ico
git commit -m "feat: трей, скрытие окна вместо выхода, показ по клику"
```

---

### Задача 7: автозапуск при входе в Windows

**Файлы:**
- Создать: `src/main/autostart.js`, `test/autostart.test.js`
- Изменить: `src/main/main.js`

**Интерфейсы:**
- Использует: ничего от Electron — параметры передаются вызывающим.
- Отдаёт: `buildLoginItem({ packaged, execPath, appRoot })` → `{ path, args }` —
  готовые параметры для `app.setLoginItemSettings({ openAtLogin, ...buildLoginItem(...) })`.

Разница принципиальная: в собранном приложении запускается сам exe, а в разработке —
`electron.exe`, которому нужен путь к проекту первым аргументом. Без этого галочка в
дубликате прописала бы в автозапуск голый Electron, который стартует с пустым окном.

- [ ] **Шаг 1: написать падающий тест** — создать `test/autostart.test.js`

```js
'use strict';
// Автозапуск. Проверяем ровно то, что легко перепутать: чем именно Windows
// будет запускать кокпит при входе — собранным exe или electron.exe с путём
// к проекту.
const { test } = require('node:test');
const assert = require('node:assert');
const { buildLoginItem } = require('../src/main/autostart');

test('собранное приложение стартует само собой, скрытым', () => {
  const item = buildLoginItem({
    packaged: true,
    execPath: 'C:\\Apps\\Cockpit.exe',
    appRoot: 'C:\\Apps',
  });
  assert.strictEqual(item.path, 'C:\\Apps\\Cockpit.exe');
  assert.deepStrictEqual(item.args, ['--hidden']);
});

test('в разработке electron.exe получает путь к проекту первым аргументом', () => {
  const item = buildLoginItem({
    packaged: false,
    execPath: 'C:\\proj\\node_modules\\electron\\dist\\electron.exe',
    appRoot: 'C:\\proj',
  });
  assert.strictEqual(item.path, 'C:\\proj\\node_modules\\electron\\dist\\electron.exe');
  assert.deepStrictEqual(item.args, ['C:\\proj', '--hidden'],
    'без пути к проекту electron.exe поднимет пустое окно, а не кокпит');
});
```

- [ ] **Шаг 2: убедиться, что тест падает**

```
npm test -- test/autostart.test.js
```

- [ ] **Шаг 3: реализация** — создать `src/main/autostart.js`

```js
'use strict';
// Чем Windows запускает кокпит при входе. Вынесено из main.js отдельным
// модулем ровно из-за разницы между «собрано» и «разработка»: в проде
// execPath — сам кокпит, в разработке — electron.exe, который без пути к
// проекту поднимет пустое окно Electron и человек решит, что автозапуск сломан.
function buildLoginItem({ packaged, execPath, appRoot }) {
  return {
    path: execPath,
    args: packaged ? ['--hidden'] : [appRoot, '--hidden'],
  };
}

module.exports = { buildLoginItem };
```

- [ ] **Шаг 4: тест зелёный**

```
npm test -- test/autostart.test.js
```

- [ ] **Шаг 5: проводка в `main.js`** — рядом с `trayClick`:

```js
  function toggleAutostart() {
    const enabled = app.getLoginItemSettings().openAtLogin;
    app.setLoginItemSettings({
      openAtLogin: !enabled,
      ...buildLoginItem({
        packaged: app.isPackaged, execPath: process.execPath, appRoot: appRoot(),
      }),
    });
    refreshTray();
  }
```

Импорт: `const { buildLoginItem } = require('./autostart');`

- [ ] **Шаг 6: живая проверка автозапуска**

```powershell
Set-Location C:\Users\Lunev\AssistClaude\claude-cockpit-net
npm start -- --user-data-dir=C:\Users\Lunev\AppData\Roaming\cockpit-net-data
# включить галочку в меню трея, затем в другом окне:
Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' | Format-List
```
Ожидание: появилась запись с `electron.exe`, путём к `claude-cockpit-net` и `--hidden`.
Снять галочку — запись исчезает. **Приложить оба вывода в отчёт.**

Важно: запись создаётся под именем приложения `claude-cockpit`, общим с рабочим
кокпитом. После проверки галочку **снять** — иначе при входе в Windows поднимется
дубликат вместо рабочего кокпита.

- [ ] **Шаг 7: коммит**

```
git add src/main/autostart.js test/autostart.test.js src/main/main.js
git commit -m "feat: автозапуск при входе в Windows"
```

---

### Задача 8: заглушка и захват в интерфейсе

Браузер и окно ПК должны видеть, у кого управление, и уметь забрать его кнопкой.

**Файлы:**
- Создать: `src/renderer/js/handoff-view.js`, `test/handoff-view.test.js`
- Изменить: `src/renderer/js/api-shape.js`, `src/renderer/js/app.js`,
  `src/preload/preload.js`, `src/renderer/index.html`, `src/renderer/css/style.css`

**Интерфейсы:**
- Использует: `owner:changed` (задача 5), `net:hello` (задача 4), `owner:claim`, `owner:get`.
- Отдаёт: чистые функции
  - `curtainState({ owner, self, online })` → `{ visible, title, hint }`
  - `selfId({ clientId })` → `'local' | clientId` — кто мы: в Electron `clientId` нет.

- [ ] **Шаг 1: написать падающий тест** — создать `test/handoff-view.test.js`

```js
'use strict';
// Заглушка «управление на другой машине». Чистая часть — DOM не участвует
// (renderer под node --test не идёт), поэтому решение «показывать или нет»
// вынесено сюда и проверяется прямо.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const url = pathToFileURL(
  path.join(__dirname, '..', 'src', 'renderer', 'js', 'handoff-view.js'),
).href;

test('владелец не видит заглушку', async () => {
  const { curtainState } = await import(url);
  assert.strictEqual(curtainState({ owner: 'local', self: 'local', online: true }).visible, false);
  assert.strictEqual(curtainState({ owner: 'c1', self: 'c1', online: true }).visible, false);
});

test('невладелец видит заглушку с объяснением', async () => {
  const { curtainState } = await import(url);
  const state = curtainState({ owner: 'local', self: 'c1', online: true });
  assert.strictEqual(state.visible, true);
  assert.match(state.title, /управление/i);
  assert.match(state.hint, /забрать/i);
});

test('владелец офлайн — так и сказано, кнопка та же', async () => {
  const { curtainState } = await import(url);
  const state = curtainState({ owner: 'c2', self: 'c1', online: false });
  assert.strictEqual(state.visible, true);
  assert.match(state.title, /не на связи/i);
});

test('до ответа сервера заглушки нет', async () => {
  const { curtainState } = await import(url);
  // Первый кадр страницы: owner ещё неизвестен. Показать заглушку на пустом
  // месте — испугать человека там, где всё в порядке.
  assert.strictEqual(curtainState({ owner: null, self: 'c1', online: true }).visible, false);
});

test('в Electron мы всегда local', async () => {
  const { selfId } = await import(url);
  assert.strictEqual(selfId({ clientId: null }), 'local');
  assert.strictEqual(selfId({ clientId: 'c3' }), 'c3');
});
```

- [ ] **Шаг 2: убедиться, что тест падает**

```
npm test -- test/handoff-view.test.js
```

- [ ] **Шаг 3: реализация** — создать `src/renderer/js/handoff-view.js`

```js
'use strict';
// Кто сейчас за рулём — с точки зрения интерфейса. Чистая часть: DOM-обвязка
// живёт в app.js, здесь только решение «показывать заглушку и что на ней
// написать». Так эта логика попадает под node --test, которого у renderer нет.
export function selfId({ clientId }) {
  // В Electron сетевого имени нет вовсе — окно ПК всегда 'local'.
  return clientId || 'local';
}

export function curtainState({ owner, self, online }) {
  // owner === null — ответа сервера ещё не было. Заглушка на первом кадре
  // напугала бы там, где всё в порядке.
  if (!owner || owner === self) return { visible: false, title: '', hint: '' };
  return {
    visible: true,
    title: online ? 'Управление на другой машине' : 'Управление на другой машине (не на связи)',
    hint: 'Можно смотреть. Чтобы писать — забрать управление себе.',
  };
}
```

- [ ] **Шаг 4: тест зелёный**

```
npm test -- test/handoff-view.test.js
```

- [ ] **Шаг 5: форма api и preload**

В `src/renderer/js/api-shape.js` добавить:

```js
  // pack ОБЯЗАТЕЛЕН: без него net-api.js отправит позиционный список
  // [cols, rows], сервер возьмёт args[0] — и ownership.claim получит ЧИСЛО
  // вместо размера. Ровно этот класс ошибки был Critical 2 прошлой задачи.
  'owner.claim': { channel: 'owner:claim', kind: 'invoke', pack: ['cols', 'rows'] },
  'owner.get': { channel: 'owner:get', kind: 'invoke' },
  'owner.onChanged': { channel: 'owner:changed', kind: 'event' },
  // Только для сетевого клиента: в Electron этого события не бывает, но форма
  // общая, а подписка на несуществующий канал безвредна.
  'owner.onHello': { channel: 'net:hello', kind: 'event' },
  'owner.onReclaim': { channel: 'owner:reclaim', kind: 'event' },
```

В `src/preload/preload.js` — соответствующие точки (по образцу соседних):

```js
  owner: {
    claim: (cols, rows) => ipcRenderer.invoke('owner:claim', { cols, rows }),
    get: () => ipcRenderer.invoke('owner:get'),
    onChanged: (fn) => ipcRenderer.on('owner:changed', (_e, p) => fn(p)),
    onHello: () => {},
    onReclaim: (fn) => ipcRenderer.on('owner:reclaim', () => fn()),
  },
```

Сверка: `preload.js` шлёт `invoke('owner:claim', {cols, rows})` — один объект;
`API_SHAPE` с `pack: ['cols','rows']` даёт сетевому клиенту ровно то же самое.
Обе стороны обязаны совпадать, иначе команда молча превращается в мусор.
Расхождение preload и формы ловится существующим тестом — прогнать его отдельно:

```
npm test -- test/net-api.test.js
```

- [ ] **Шаг 6: обвязка в `app.js`**

Импорт: `import { curtainState, selfId } from './handoff-view.js';`

```js
// Эстафета: у кого сейчас управление. Захват — при первом кадре страницы и
// по кнопке заглушки; размер берём у активного терминала, потому что pty
// переразмеривается ровно под того, кто за рулём.
let ownerState = { owner: null, self: 'local', online: true };

// views и activeId — существующие структуры app.js (см. views.get(...)?.view.term
// около строки 706 и activeId около 1567). Запасной размер нужен, когда вкладок
// нет вовсе: захват на пустом кокпите обязан пройти, а не упасть.
function termSize() {
  const term = views.get(activeId)?.view?.term;
  return term ? { cols: term.cols, rows: term.rows } : { cols: 80, rows: 24 };
}

async function claimControl() {
  const { cols, rows } = termSize();
  const state = await window.api.owner.claim(cols, rows);
  if (state) ownerState = { ...ownerState, ...state };
  renderCurtain();
}

function renderCurtain() {
  const el = document.getElementById('handoff-curtain');
  const state = curtainState(ownerState);
  el.classList.toggle('visible', state.visible);
  el.querySelector('.curtain-title').textContent = state.title;
  el.querySelector('.curtain-hint').textContent = state.hint;
}

window.api.owner.onHello(({ clientId }) => { ownerState.self = selfId({ clientId }); });
window.api.owner.onChanged((p) => { ownerState = { ...ownerState, ...p }; renderCurtain(); });
window.api.owner.onReclaim(() => { claimControl(); });
document.getElementById('curtain-take').addEventListener('click', claimControl);
```

Захват при загрузке — в существующую точку старта интерфейса (там же, где
`workspace.ready`), **после** восстановления вкладок:

```js
  // Открыли страницу — забрали управление. Правило «последний открывший
  // владеет» описано в спеке: подтверждений нет намеренно.
  await claimControl();
```

Петли из этого не выходит, и это нужно понимать: клик по трею зовёт `showWindow()` →
`owner:reclaim` → `claimControl()` → `ownership.claim('local')`. Если владельцем уже
было локальное окно, `claim` вернёт `false`, `onChange` не сработает, второго
`showWindow()` не будет. Цепочка обрывается на первом же повторе.

- [ ] **Шаг 7: разметка и стиль**

В `src/renderer/index.html`, внутри контейнера терминалов:

```html
    <div id="handoff-curtain" class="handoff-curtain">
      <div class="curtain-title"></div>
      <div class="curtain-hint"></div>
      <button id="curtain-take" class="curtain-take">Забрать управление себе</button>
    </div>
```

В `src/renderer/css/style.css`:

```css
/* Заглушка эстафеты: терминал под ней виден (сквозь затемнение), но кликнуть
   и напечатать нельзя — это и есть «смотреть можно, писать нельзя». */
.handoff-curtain {
  display: none;
  position: absolute;
  inset: 0;
  z-index: 40;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: rgba(15, 15, 15, 0.82);
  backdrop-filter: blur(1px);
}
.handoff-curtain.visible { display: flex; }
.curtain-title { font-size: 15px; color: var(--fg-primary, #E8E8E8); }
.curtain-hint { font-size: 13px; color: var(--fg-muted, #9E9E9E); }
.curtain-take {
  padding: 8px 16px;
  border: 1px solid var(--border, #2A2A2A);
  border-radius: 6px;
  background: var(--bg-elevated, #1A1A1A);
  color: var(--fg-primary, #E8E8E8);
  cursor: pointer;
}
.curtain-take:hover { border-color: var(--accent, #4A9EFF); }
```

Проверить, что у контейнера терминалов есть `position: relative` — иначе `inset: 0`
растянет заглушку по всему окну и накроет сайдбар.

- [ ] **Шаг 8: весь прогон + smoke**

```
npm test
npm run smoke -- --user-data-dir=C:\Users\Lunev\AppData\Roaming\cockpit-net-data
```

- [ ] **Шаг 9: коммит**

```
git add src/renderer/js/handoff-view.js test/handoff-view.test.js src/renderer/js/api-shape.js src/renderer/js/app.js src/preload/preload.js src/renderer/index.html src/renderer/css/style.css
git commit -m "feat: заглушка эстафеты и захват управления в интерфейсе"
```

---

## Приёмка фазы (после всех задач)

Тестами это не проверяется — только руками, на двух машинах.

1. Кокпит на ПК, окно открыто. Открыть `http://100.120.245.85:48300` на макбуке.
   **Ожидание:** окно на ПК исчезло (в трее значок приглушён), браузер пишет в терминал.
2. На ПК кликнуть значок трея. **Ожидание:** окно вернулось, на макбуке легла заглушка,
   кнопка «Забрать управление себе» работает.
3. Напечатать что-то в терминал на ПК, пока управление у мака. **Ожидание:** ничего не
   происходит, ошибок на экране нет.
4. Закрыть крышку макбука. **Ожидание:** окно ПК само не появилось, вкладки живы.
5. Крестик на окне ПК. **Ожидание:** окно спряталось, уведомление показано один раз,
   процесс жив, макбук продолжает работать.
6. Меню трея → «Выход». **Ожидание:** процесс завершился, порт освободился.
7. Размер терминала: развернуть окно на ПК на весь экран, забрать управление, потом
   отдать маку с маленьким окном браузера. **Ожидание:** после каждой пересадки Claude
   Code перерисовывается по размеру того, кто за рулём.

Отчёт по каждому пункту: что сделано, что увидел, скриншот на ПК.
