# Кокпит по сети: фундамент и сеть — план реализации

> **Для агентов:** ОБЯЗАТЕЛЬНЫЙ СУБ-СКИЛЛ: используйте superpowers:subagent-driven-development
> (рекомендуется) или superpowers:executing-plans для выполнения задача-за-задачей.
> Шаги помечены чекбоксами (`- [ ]`).

**Цель:** кокпит на ПК отдаёт свой интерфейс по сети, и он открывается в браузере на
макбуке — с живым терминалом, вкладками и статусами.

**Архитектура:** реестр команд перехватывает регистрацию обработчиков `ipcMain`, не
трогая их логику; одна точка рассылки событий кормит и локальное окно, и сетевых
клиентов. HTTP-сервер отдаёт существующий renderer как статику, WebSocket несёт команды
и события. В браузере `window.api` собирается поверх сокета — renderer разницы не видит,
потому что не знает про Electron вовсе.

**Стек:** Node 24 / Electron 29.4.6, `node --test`, `ws` (единственная новая
зависимость — чистый JS, без нативной сборки).

## Глобальные ограничения

- **Работаем в `C:\Users\Lunev\AssistClaude\claude-cockpit-net`** — дубликат уже создан,
  ветка `feat-remote-design`. Оригинал `claude-cockpit` не трогать: пользователь работает
  в нём каждый день.
- **Запуск дубликата только с флагом** `--user-data-dir=C:\Users\Lunev\AppData\Roaming\cockpit-net-data`.
  Без него дубликат перезапишет `workspace.json` рабочего кокпита и, что опаснее, его
  `bridge-port` — хуки живых сессий уйдут не в тот процесс.
- **`package.json` и код изоляции не менять** — изоляция сделана флагом запуска именно
  для того, чтобы не утечь переименованием в основной проект при слиянии PR.
- Windows 10, PowerShell 5.1: нет `&&`, `||`, тернарника. Только `if/else` и `;`.
- Никаких нативных модулей. `ws` — чистый JS, ставится как `npm i ws`.
- Тесты: `npm test` (= `node --test`), смоук: `npm run smoke -- --user-data-dir=...`.
- Комментарии и названия тестов — по-русски, как во всём проекте. Комментарий объясняет
  ПОЧЕМУ, а не пересказывает код.
- В `.ps1`-файлах и format-строках `curl -w` — только ASCII (иначе cp866 ломает вывод).
- Порт сетевого сервера: **48300** (48200 занят мостом хуков, 48210 — разведкой).

## Структура файлов

| файл | ответственность |
| --- | --- |
| `src/main/command-registry.js` | **создать.** Реестр: регистрирует обработчик и в `ipcMain`, и в карте имён; умеет вызывать по имени. Чистый, без Electron внутри — `ipcMain` инжектируется. |
| `src/main/broadcast.js` | **создать.** Одна точка исходящих событий: локальное окно + список сетевых клиентов. |
| `src/main/output-buffer.js` | **создать.** Кольцевой буфер вывода pty на вкладку. Чистый. |
| `src/main/net-server.js` | **создать.** HTTP-статика + WebSocket, разбор кадров протокола, вызов реестра. |
| `src/renderer/js/net-api.js` | **создать.** Сборка `window.api` поверх WebSocket в браузере. |
| `src/main/ipc.js` | **изменить.** Регистрации переводятся на реестр; `webContents.send` — на `broadcast`. |
| `src/renderer/index.html` | **изменить.** Один тег `<script>` выбора транспорта перед `app.js`. |
| `test/command-registry.test.js`, `test/broadcast.test.js`, `test/output-buffer.test.js`, `test/net-server.test.js` | **создать.** |

---

### Задача 1: Реестр команд

Обработчики `ipcMain` сегодня недостижимы ниоткуда, кроме самого `ipcMain`. Реестр
делает их вызываемыми по имени, не меняя ни одной строки их логики.

**Файлы:**
- Создать: `src/main/command-registry.js`
- Создать: `test/command-registry.test.js`
- Изменить: `src/main/ipc.js` (только группа `tabs:*`, остальное — задача 2)

**Интерфейсы:**
- Отдаёт: `createCommandRegistry({ ipcMain })` → `{ handle(channel, fn), on(channel, fn), call(channel, args), has(channel), names() }`.
  `handle` — команда с ответом, `on` — без ответа. `call(channel, args)` возвращает
  `Promise` с результатом; для неизвестного канала реджектит `Error` с текстом
  `неизвестная команда: <channel>`.

- [ ] **Шаг 1: Написать падающий тест**

```js
// test/command-registry.test.js
'use strict';
// Реестр команд: обработчики ipcMain становятся вызываемыми по имени, чтобы
// их мог позвать не только локальный renderer, но и сетевой клиент.
const test = require('node:test');
const assert = require('node:assert');
const { createCommandRegistry } = require('../src/main/command-registry');

function fakeIpcMain() {
  const handled = new Map();
  const oned = new Map();
  return {
    handled,
    oned,
    handle: (ch, fn) => handled.set(ch, fn),
    on: (ch, fn) => oned.set(ch, fn),
  };
}

test('handle: регистрирует и в ipcMain, и в реестре', async () => {
  const ipc = fakeIpcMain();
  const reg = createCommandRegistry({ ipcMain: ipc });
  reg.handle('tabs:open', async (opts) => ({ tabId: 'T1', cwd: opts.cwd }));

  assert.ok(ipc.handled.has('tabs:open'), 'локальный renderer должен работать как раньше');
  assert.deepStrictEqual(await reg.call('tabs:open', [{ cwd: 'C:\\proj' }]), { tabId: 'T1', cwd: 'C:\\proj' });
});

test('handle: вызов через ipcMain отбрасывает объект события', async () => {
  // Обработчики в ipc.js написаны как (event, payload) — обёртка обязана
  // скрыть event, иначе сетевой вызов с теми же аргументами разъедется с локальным.
  const ipc = fakeIpcMain();
  const reg = createCommandRegistry({ ipcMain: ipc });
  let got = null;
  reg.handle('tabs:close', async (tabId) => { got = tabId; return 'ok'; });

  const viaIpc = await ipc.handled.get('tabs:close')({ sender: 'фиктивное событие' }, 'T7');
  assert.strictEqual(got, 'T7');
  assert.strictEqual(viaIpc, 'ok');
});

test('on: команда без ответа тоже вызывается по имени', async () => {
  const ipc = fakeIpcMain();
  const reg = createCommandRegistry({ ipcMain: ipc });
  const seen = [];
  reg.on('term:write', (p) => seen.push(p));

  await reg.call('term:write', [{ tabId: 'T1', data: 'ls\r' }]);
  assert.deepStrictEqual(seen, [{ tabId: 'T1', data: 'ls\r' }]);
});

test('call: неизвестная команда — понятная ошибка, а не тишина', async () => {
  const reg = createCommandRegistry({ ipcMain: fakeIpcMain() });
  await assert.rejects(() => reg.call('нет:такой', []), /неизвестная команда: нет:такой/);
});

test('names/has: реестр знает свой состав', () => {
  const reg = createCommandRegistry({ ipcMain: fakeIpcMain() });
  reg.handle('a:b', async () => 1);
  reg.on('c:d', () => {});
  assert.ok(reg.has('a:b'));
  assert.ok(reg.has('c:d'));
  assert.ok(!reg.has('нет'));
  assert.deepStrictEqual(reg.names().sort(), ['a:b', 'c:d']);
});

test('ошибка внутри обработчика доезжает до вызывающего, а не теряется', async () => {
  const reg = createCommandRegistry({ ipcMain: fakeIpcMain() });
  reg.handle('плохая:команда', async () => { throw new Error('внутри рвануло'); });
  await assert.rejects(() => reg.call('плохая:команда', []), /внутри рвануло/);
});
```

- [ ] **Шаг 2: Запустить и убедиться, что падает**

Выполнить: `node --test test/command-registry.test.js`
Ожидается: `Cannot find module '../src/main/command-registry'`

- [ ] **Шаг 3: Написать минимальную реализацию**

```js
// src/main/command-registry.js
'use strict';
// Реестр команд: единая точка регистрации обработчиков.
//
// Зачем. Обработчики ipcMain недостижимы ниоткуда, кроме самого ipcMain, —
// поэтому сетевой клиент не мог бы позвать ничего, не дублируя их. Реестр
// кладёт обработчик СРАЗУ в два места: в ipcMain (локальное окно продолжает
// работать буквально как раньше) и в карту имён (сетевой транспорт зовёт по
// имени канала). Логика самих обработчиков не меняется ни на строку.
//
// ipcMain инжектируется, а не подключается здесь: так модуль остаётся чистым
// и тестируется без Electron.

function createCommandRegistry({ ipcMain }) {
  const handlers = new Map(); // channel → { kind: 'invoke' | 'send', fn }

  // Обработчики в ipc.js написаны как (event, payload). Обёртка отбрасывает
  // event, чтобы сетевой вызов передавал РОВНО те же аргументы, что локальный:
  // иначе два транспорта незаметно разъедутся в сигнатурах.
  function handle(channel, fn) {
    handlers.set(channel, { kind: 'invoke', fn });
    ipcMain.handle(channel, (_event, ...args) => fn(...args));
  }

  function on(channel, fn) {
    handlers.set(channel, { kind: 'send', fn });
    ipcMain.on(channel, (_event, ...args) => fn(...args));
  }

  async function call(channel, args = []) {
    const entry = handlers.get(channel);
    if (!entry) throw new Error(`неизвестная команда: ${channel}`);
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

module.exports = { createCommandRegistry };
```

- [ ] **Шаг 4: Запустить тесты — должны пройти**

Выполнить: `node --test test/command-registry.test.js`
Ожидается: `pass 6`, `fail 0`

- [ ] **Шаг 5: Перевести на реестр группу `tabs:*` в ipc.js**

Найти в `src/main/ipc.js` регистрации каналов `tabs:open`, `tabs:close`,
`tabs:chooseFolder`, `tabs:seen`. Создать реестр один раз рядом с их первой
регистрацией:

```js
const registry = createCommandRegistry({ ipcMain });
```

и заменить в этих четырёх местах `ipcMain.handle(` → `registry.handle(`,
`ipcMain.on(` → `registry.on(`, убрав из сигнатуры первый параметр события:

```js
// было
ipcMain.handle('tabs:close', async (_e, tabId) => { … });
// стало
registry.handle('tabs:close', async (tabId) => { … });
```

Добавить импорт в шапку файла:

```js
const { createCommandRegistry } = require('./command-registry');
```

- [ ] **Шаг 6: Полный прогон и смоук**

Выполнить: `npm test`
Ожидается: `pass 762`, `fail 0` (756 прежних + 6 новых)

Выполнить: `npm run smoke -- --user-data-dir=C:\Users\Lunev\AppData\Roaming\cockpit-net-data`
Ожидается: `[smoke] window=OK`, `[smoke] renderer-errors=0`

- [ ] **Шаг 7: Коммит**

```bash
git add src/main/command-registry.js test/command-registry.test.js src/main/ipc.js
git commit -m "feat: реестр команд — обработчики становятся вызываемыми по имени"
```

---

### Задача 2: Перевести оставшиеся команды на реестр

**Файлы:**
- Изменить: `src/main/ipc.js` (оставшиеся 41 регистрация)
- Создать: `test/command-registry.coverage.test.js`

**Интерфейсы:**
- Потребляет: `createCommandRegistry` из задачи 1.
- Отдаёт: `registry` со всеми 45 каналами — сетевой транспорт задачи 5 полагается на
  их полноту.

- [ ] **Шаг 1: Написать падающий тест на полноту**

Смысл теста: сетевой клиент бесполезен, если половина команд осталась вне реестра, а
заметить это иначе нечем — забытая команда просто «не работает с макбука».

```js
// test/command-registry.coverage.test.js
'use strict';
// Шов «сколько каналов зарегистрировано в ipc.js» ↔ «сколько попало в реестр».
// Забытая команда не ломает локальный кокпит и потому незаметна — она молча
// не работает только по сети. Тест читает исходник и требует, чтобы прямых
// вызовов ipcMain не осталось вовсе.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ipc.js'), 'utf8');

test('в ipc.js не осталось прямых ipcMain.handle/ipcMain.on', () => {
  const direct = [...src.matchAll(/ipcMain\.(handle|on)\(\s*'([^']+)'/g)].map((m) => m[2]);
  assert.deepStrictEqual(direct, [], `эти каналы не попали в реестр: ${direct.join(', ')}`);
});

test('через реестр зарегистрировано не меньше 45 каналов', () => {
  const viaRegistry = [...src.matchAll(/registry\.(handle|on)\(\s*'([^']+)'/g)].map((m) => m[2]);
  assert.ok(viaRegistry.length >= 45, `в реестре только ${viaRegistry.length}`);
  assert.strictEqual(new Set(viaRegistry).size, viaRegistry.length, 'канал зарегистрирован дважды');
});
```

- [ ] **Шаг 2: Запустить и убедиться, что падает**

Выполнить: `node --test test/command-registry.coverage.test.js`
Ожидается: FAIL со списком каналов, оставшихся на прямом `ipcMain`

- [ ] **Шаг 3: Заменить оставшиеся регистрации**

Механическая замена по всему `src/main/ipc.js`, тем же приёмом, что в задаче 1, шаг 5:
`ipcMain.handle(` → `registry.handle(`, `ipcMain.on(` → `registry.on(`, из сигнатуры
убрать первый параметр (объект события). Если обработчик РЕАЛЬНО использует `event`
(например, `event.sender`), не переводить его на реестр, а вынести отдельным
комментарием почему — такие каналы сетевому клиенту недоступны by design.

- [ ] **Шаг 4: Прогнать тесты**

Выполнить: `npm test`
Ожидается: `fail 0`; тест полноты проходит

- [ ] **Шаг 5: Смоук — локальный кокпит не сломан**

Выполнить: `npm run smoke -- --user-data-dir=C:\Users\Lunev\AppData\Roaming\cockpit-net-data`
Ожидается: `[smoke] window=OK`, `[smoke] renderer-errors=0`

- [ ] **Шаг 6: Коммит**

```bash
git add src/main/ipc.js test/command-registry.coverage.test.js
git commit -m "refactor: все команды ipc.js проходят через реестр"
```

---

### Задача 3: Одна точка рассылки событий

**Файлы:**
- Создать: `src/main/broadcast.js`
- Создать: `test/broadcast.test.js`
- Изменить: `src/main/ipc.js` (замена `win.webContents.send` на `broadcast.emit`)

**Интерфейсы:**
- Отдаёт: `createBroadcast({ getWindow })` → `{ emit(channel, payload), addClient(fn), removeClient(fn), clientCount() }`.
  `addClient` принимает функцию `(channel, payload) => void`; она зовётся на каждое
  событие. Падение одного клиента не мешает остальным.

- [ ] **Шаг 1: Написать падающий тест**

```js
// test/broadcast.test.js
'use strict';
// Одна точка исходящих событий. До неё события уходили прямыми
// win.webContents.send из нескольких мест — сетевому клиенту пришлось бы
// перехватывать каждое, и любое новое место молча прошло бы мимо сети.
const test = require('node:test');
const assert = require('node:assert');
const { createBroadcast } = require('../src/main/broadcast');

const fakeWin = () => {
  const sent = [];
  return { sent, isDestroyed: () => false, webContents: { send: (c, p) => sent.push([c, p]) } };
};

test('emit доставляет и в окно, и в сетевых клиентов', () => {
  const win = fakeWin();
  const b = createBroadcast({ getWindow: () => win });
  const got = [];
  b.addClient((c, p) => got.push([c, p]));

  b.emit('tab:status', { tabId: 'T1', status: 'working' });

  assert.deepStrictEqual(win.sent, [['tab:status', { tabId: 'T1', status: 'working' }]]);
  assert.deepStrictEqual(got, [['tab:status', { tabId: 'T1', status: 'working' }]]);
});

test('уничтоженное окно не роняет рассылку — сетевые клиенты получают событие', () => {
  const win = fakeWin();
  win.isDestroyed = () => true;
  const b = createBroadcast({ getWindow: () => win });
  const got = [];
  b.addClient((c) => got.push(c));

  b.emit('term:data', { tabId: 'T1', data: 'привет' });

  assert.deepStrictEqual(win.sent, [], 'в мёртвое окно не пишем');
  assert.deepStrictEqual(got, ['term:data']);
});

test('падение одного клиента не мешает остальным', () => {
  // Оборванный сокет бросает на запись. Один упавший макбук не должен
  // останавливать поток вывода в локальное окно и другие клиенты.
  const win = fakeWin();
  const b = createBroadcast({ getWindow: () => win });
  const got = [];
  b.addClient(() => { throw new Error('сокет закрыт'); });
  b.addClient((c) => got.push(c));

  b.emit('tab:status', {});

  assert.deepStrictEqual(got, ['tab:status']);
  assert.strictEqual(win.sent.length, 1);
});

test('removeClient отписывает', () => {
  const b = createBroadcast({ getWindow: () => fakeWin() });
  const got = [];
  const fn = (c) => got.push(c);
  b.addClient(fn);
  b.removeClient(fn);
  b.emit('tab:status', {});
  assert.deepStrictEqual(got, []);
  assert.strictEqual(b.clientCount(), 0);
});

test('окна нет вовсе (сервер без интерфейса) — не падаем', () => {
  const b = createBroadcast({ getWindow: () => null });
  const got = [];
  b.addClient((c) => got.push(c));
  b.emit('tab:status', {});
  assert.deepStrictEqual(got, ['tab:status']);
});
```

- [ ] **Шаг 2: Запустить и убедиться, что падает**

Выполнить: `node --test test/broadcast.test.js`
Ожидается: `Cannot find module '../src/main/broadcast'`

- [ ] **Шаг 3: Написать реализацию**

```js
// src/main/broadcast.js
'use strict';
// Единственная точка исходящих событий кокпита.
//
// Зачем. События уходили прямыми win.webContents.send из нескольких мест
// ipc.js. Сетевому клиенту пришлось бы перехватывать каждое такое место, а
// любое НОВОЕ молча проходило бы мимо сети — класс ошибки, который замечаешь
// через месяц и не понимаешь, почему с макбука «иногда не обновляется».
//
// getWindow — функция, а не окно: на момент сборки окна может ещё не быть, а
// при перезапуске оно меняется.
function createBroadcast({ getWindow }) {
  const clients = new Set();

  function emit(channel, payload) {
    const win = typeof getWindow === 'function' ? getWindow() : null;
    if (win && !win.isDestroyed()) {
      try { win.webContents.send(channel, payload); } catch { /* окно уходит — не наша забота */ }
    }
    // Копия набора: клиент может отписаться прямо из обработчика (оборвался сокет).
    for (const client of [...clients]) {
      // Падение одного клиента не должно останавливать остальных: оборванный
      // макбук не имеет права глушить поток вывода в локальное окно.
      try { client(channel, payload); } catch { /* мёртвый клиент отвалится сам */ }
    }
  }

  return {
    emit,
    addClient: (fn) => { clients.add(fn); },
    removeClient: (fn) => { clients.delete(fn); },
    clientCount: () => clients.size,
  };
}

module.exports = { createBroadcast };
```

- [ ] **Шаг 4: Запустить тесты**

Выполнить: `node --test test/broadcast.test.js`
Ожидается: `pass 5`, `fail 0`

- [ ] **Шаг 5: Перевести ipc.js на broadcast**

В `src/main/ipc.js` создать рассылку рядом с реестром:

```js
const { createBroadcast } = require('./broadcast');
const broadcast = createBroadcast({ getWindow: () => win });
```

Заменить каждое `win.webContents.send(X, Y)` на `broadcast.emit(X, Y)` — включая три
частных случая `usage:update`. Обёртки, где уже стоит проверка `!win.isDestroyed()`,
упростить: проверка теперь внутри `broadcast.emit`.

- [ ] **Шаг 6: Проверить, что прямых отправок не осталось**

Выполнить: `grep -n "webContents.send" src/main/ipc.js`
Ожидается: пусто

- [ ] **Шаг 7: Тесты и смоук**

Выполнить: `npm test` — ожидается `fail 0`
Выполнить: `npm run smoke -- --user-data-dir=C:\Users\Lunev\AppData\Roaming\cockpit-net-data` — ожидается `[smoke] renderer-errors=0`

- [ ] **Шаг 8: Коммит**

```bash
git add src/main/broadcast.js test/broadcast.test.js src/main/ipc.js
git commit -m "feat: единая точка рассылки событий вместо прямых webContents.send"
```

---

### Задача 4: Кольцевой буфер вывода

Без него подключившийся с макбука клиент увидит пустой терминал: `main` истории не
хранит, она живёт в xterm внутри окна ПК.

**Файлы:**
- Создать: `src/main/output-buffer.js`
- Создать: `test/output-buffer.test.js`

**Интерфейсы:**
- Отдаёт: `createOutputBuffer({ maxBytes = 262144 })` → `{ push(tabId, data), get(tabId), drop(tabId), size(tabId), totalBytes() }`.
  `get` возвращает строку — склеенный хвост вывода не длиннее `maxBytes`.

- [ ] **Шаг 1: Написать падающий тест**

```js
// test/output-buffer.test.js
'use strict';
// Кольцевой буфер вывода: то, что клиент увидит в терминале, подключившись.
// Ограничение по байтам — не оптимизация, а условие жизни на 8 ГБ ОЗУ:
// без него вкладка с `npm test` в цикле съела бы память за ночь.
const test = require('node:test');
const assert = require('node:assert');
const { createOutputBuffer } = require('../src/main/output-buffer');

test('копит вывод вкладки и отдаёт склеенным', () => {
  const b = createOutputBuffer({ maxBytes: 1024 });
  b.push('T1', 'привет, ');
  b.push('T1', 'мир');
  assert.strictEqual(b.get('T1'), 'привет, мир');
});

test('вкладки не смешиваются', () => {
  const b = createOutputBuffer({ maxBytes: 1024 });
  b.push('T1', 'первая');
  b.push('T2', 'вторая');
  assert.strictEqual(b.get('T1'), 'первая');
  assert.strictEqual(b.get('T2'), 'вторая');
});

test('пустая вкладка — пустая строка, а не undefined', () => {
  const b = createOutputBuffer({ maxBytes: 1024 });
  assert.strictEqual(b.get('нет-такой'), '');
});

test('превышение предела режет НАЧАЛО — свежий хвост важнее', () => {
  const b = createOutputBuffer({ maxBytes: 10 });
  b.push('T1', 'абвгде');   // 12 байт в utf-8 (кириллица по 2)
  b.push('T1', 'жз');       // ещё 4
  const out = b.get('T1');
  assert.ok(Buffer.byteLength(out, 'utf8') <= 10, `осталось ${Buffer.byteLength(out, 'utf8')} байт`);
  assert.ok(out.endsWith('жз'), 'хвост обязан сохраниться');
});

test('одна порция длиннее предела обрезается до предела', () => {
  const b = createOutputBuffer({ maxBytes: 8 });
  b.push('T1', 'x'.repeat(100));
  assert.strictEqual(Buffer.byteLength(b.get('T1'), 'utf8'), 8);
});

test('обрезка не разрывает многобайтный символ пополам', () => {
  // Кириллица занимает 2 байта. Наивная резка по байтам даёт «замену» U+FFFD
  // прямо в первой строке, которую увидит человек на макбуке.
  const b = createOutputBuffer({ maxBytes: 5 });
  b.push('T1', 'абв');
  assert.ok(!b.get('T1').includes('\uFFFD'), `битый символ: ${JSON.stringify(b.get('T1'))}`);
});

test('drop освобождает память закрытой вкладки', () => {
  const b = createOutputBuffer({ maxBytes: 1024 });
  b.push('T1', 'данные');
  b.drop('T1');
  assert.strictEqual(b.get('T1'), '');
  assert.strictEqual(b.totalBytes(), 0);
});

test('totalBytes считает все вкладки — им жить в одной памяти', () => {
  const b = createOutputBuffer({ maxBytes: 1024 });
  b.push('T1', 'abc');
  b.push('T2', 'de');
  assert.strictEqual(b.totalBytes(), 5);
});
```

- [ ] **Шаг 2: Запустить и убедиться, что падает**

Выполнить: `node --test test/output-buffer.test.js`
Ожидается: `Cannot find module '../src/main/output-buffer'`

- [ ] **Шаг 3: Написать реализацию**

```js
// src/main/output-buffer.js
'use strict';
// Хвост вывода каждой вкладки — то, что клиент увидит, подключившись.
//
// Зачем. main не хранит вывод pty вообще: история живёт в xterm внутри окна
// ПК. Клиент с макбука увидел бы пустой терминал и не понял бы, на чём
// остановилась работа, — то есть главный сценарий («встал из-за ПК, сел с
// макбука») не работал бы вовсе.
//
// Предел по байтам — условие жизни на 8 ГБ ОЗУ: вкладка, гоняющая тесты в
// цикле, иначе съела бы память за ночь. 256 КБ × 10 вкладок ≈ 2,5 МБ.
const DEFAULT_MAX = 256 * 1024;

function createOutputBuffer({ maxBytes = DEFAULT_MAX } = {}) {
  const buffers = new Map(); // tabId → string

  // Режем по СИМВОЛАМ с конца, а не по байтам: наивная байтовая резка
  // разрывает кириллицу пополам, и первая строка на экране макбука
  // встречает человека символом замены.
  function trimToBytes(text, limit) {
    if (Buffer.byteLength(text, 'utf8') <= limit) return text;
    let start = Math.max(0, text.length - limit);
    while (start < text.length && Buffer.byteLength(text.slice(start), 'utf8') > limit) start += 1;
    return text.slice(start);
  }

  return {
    push(tabId, data) {
      if (!tabId || typeof data !== 'string' || !data) return;
      buffers.set(tabId, trimToBytes((buffers.get(tabId) || '') + data, maxBytes));
    },
    get: (tabId) => buffers.get(tabId) || '',
    drop: (tabId) => { buffers.delete(tabId); },
    size: (tabId) => Buffer.byteLength(buffers.get(tabId) || '', 'utf8'),
    totalBytes: () => [...buffers.values()]
      .reduce((sum, text) => sum + Buffer.byteLength(text, 'utf8'), 0),
  };
}

module.exports = { createOutputBuffer };
```

- [ ] **Шаг 4: Запустить тесты**

Выполнить: `node --test test/output-buffer.test.js`
Ожидается: `pass 8`, `fail 0`

- [ ] **Шаг 5: Подключить к потоку term:data в ipc.js**

В `src/main/ipc.js` создать буфер рядом с рассылкой и наполнять его в том же месте,
где событие `term:data` уходит в `broadcast.emit`. Закрытие вкладки (`tabs:close`)
должно звать `outputBuffer.drop(tabId)` — иначе память закрытых вкладок копится до
перезапуска.

```js
const { createOutputBuffer } = require('./output-buffer');
const outputBuffer = createOutputBuffer({});
```

- [ ] **Шаг 6: Тесты и смоук**

Выполнить: `npm test` — ожидается `fail 0`
Выполнить: `npm run smoke -- --user-data-dir=C:\Users\Lunev\AppData\Roaming\cockpit-net-data` — ожидается `[smoke] renderer-errors=0`

- [ ] **Шаг 7: Коммит**

```bash
git add src/main/output-buffer.js test/output-buffer.test.js src/main/ipc.js
git commit -m "feat: кольцевой буфер вывода — подключившийся клиент видит историю"
```

---

### Задача 5: Сетевой сервер

**Файлы:**
- Создать: `src/main/net-server.js`
- Создать: `test/net-server.test.js`
- Изменить: `package.json` (зависимость `ws`)

**Интерфейсы:**
- Потребляет: `registry` (задачи 1–2), `broadcast` (задача 3), `outputBuffer` (задача 4).
- Отдаёт: `createNetServer({ registry, broadcast, outputBuffer, staticRoots, port, host })`
  → `{ start(): Promise<{port}>, stop(): Promise<void>, clientCount() }`.

**Протокол** (кадры JSON в текстовых сообщениях WebSocket):
- клиент → сервер: `{ "id": 17, "channel": "tabs:open", "args": [{...}] }`
- сервер → клиент, ответ: `{ "id": 17, "ok": true, "result": {...} }` либо
  `{ "id": 17, "ok": false, "error": "текст" }`
- сервер → клиент, событие: `{ "event": "tab:status", "payload": {...} }`
- клиент → сервер, запрос истории: `{ "id": 18, "channel": "net:buffer", "args": ["T1"] }`
  — обслуживается сервером, а не реестром.

- [ ] **Шаг 1: Установить зависимость**

```bash
npm i ws
```

Проверить, что нативного модуля не приехало:
Выполнить: `node -e "console.log(require('ws/package.json').version)"`
Ожидается: номер версии без ошибок сборки

- [ ] **Шаг 2: Написать падающий тест**

```js
// test/net-server.test.js
'use strict';
// Сетевой сервер: статика renderer + WebSocket с командами и событиями.
// Тесты интеграционные — поднимаем настоящий сервер на случайном порту и
// ходим настоящим клиентом: протокол нельзя проверить моками, в нём вся суть.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const WebSocket = require('ws');
const { createNetServer } = require('../src/main/net-server');
const { createCommandRegistry } = require('../src/main/command-registry');
const { createBroadcast } = require('../src/main/broadcast');
const { createOutputBuffer } = require('../src/main/output-buffer');

const fakeIpcMain = () => ({ handle: () => {}, on: () => {} });

function makeServer(extra = {}) {
  const registry = createCommandRegistry({ ipcMain: fakeIpcMain() });
  registry.handle('эхо', async (x) => ({ эхо: x }));
  registry.handle('рвётся', async () => { throw new Error('обработчик упал'); });
  const broadcast = createBroadcast({ getWindow: () => null });
  const outputBuffer = createOutputBuffer({});
  const server = createNetServer({
    registry,
    broadcast,
    outputBuffer,
    staticRoots: { '/': path.join(__dirname, '..', 'src', 'renderer') },
    port: 0,
    host: '127.0.0.1',
    ...extra,
  });
  return { server, registry, broadcast, outputBuffer };
}

// Ждём один кадр от сокета — иначе тесты превращаются в гонку таймеров.
const nextFrame = (ws) => new Promise((resolve) => ws.once('message', (m) => resolve(JSON.parse(m))));
const open = (url) => new Promise((resolve) => {
  const ws = new WebSocket(url);
  ws.once('open', () => resolve(ws));
});

test('отдаёт страницу renderer по HTTP', async () => {
  const { server } = makeServer();
  const { port } = await server.start();
  const res = await fetch(`http://127.0.0.1:${port}/index.html`);
  const body = await res.text();
  assert.strictEqual(res.status, 200);
  assert.ok(body.includes('<div id="app">'), 'отдана не та страница');
  await server.stop();
});

test('команда доходит до реестра и возвращает результат', async () => {
  const { server } = makeServer();
  const { port } = await server.start();
  const ws = await open(`ws://127.0.0.1:${port}/ws`);
  ws.send(JSON.stringify({ id: 1, channel: 'эхо', args: ['привет'] }));
  assert.deepStrictEqual(await nextFrame(ws), { id: 1, ok: true, result: { эхо: 'привет' } });
  ws.close();
  await server.stop();
});

test('ошибка обработчика приезжает клиенту текстом, а не тишиной', async () => {
  const { server } = makeServer();
  const { port } = await server.start();
  const ws = await open(`ws://127.0.0.1:${port}/ws`);
  ws.send(JSON.stringify({ id: 2, channel: 'рвётся', args: [] }));
  const frame = await nextFrame(ws);
  assert.strictEqual(frame.ok, false);
  assert.match(frame.error, /обработчик упал/);
  ws.close();
  await server.stop();
});

test('неизвестная команда — понятная ошибка', async () => {
  const { server } = makeServer();
  const { port } = await server.start();
  const ws = await open(`ws://127.0.0.1:${port}/ws`);
  ws.send(JSON.stringify({ id: 3, channel: 'нет:такой', args: [] }));
  const frame = await nextFrame(ws);
  assert.strictEqual(frame.ok, false);
  assert.match(frame.error, /неизвестная команда/);
  ws.close();
  await server.stop();
});

test('события рассылки долетают до подключённого клиента', async () => {
  const { server, broadcast } = makeServer();
  const { port } = await server.start();
  const ws = await open(`ws://127.0.0.1:${port}/ws`);
  const frame = nextFrame(ws);
  broadcast.emit('tab:status', { tabId: 'T1', status: 'working' });
  assert.deepStrictEqual(await frame, { event: 'tab:status', payload: { tabId: 'T1', status: 'working' } });
  ws.close();
  await server.stop();
});

test('net:buffer отдаёт накопленную историю вкладки', async () => {
  const { server, outputBuffer } = makeServer();
  outputBuffer.push('T1', 'старый вывод');
  const { port } = await server.start();
  const ws = await open(`ws://127.0.0.1:${port}/ws`);
  ws.send(JSON.stringify({ id: 4, channel: 'net:buffer', args: ['T1'] }));
  assert.deepStrictEqual(await nextFrame(ws), { id: 4, ok: true, result: 'старый вывод' });
  ws.close();
  await server.stop();
});

test('битый кадр не роняет сервер', async () => {
  const { server } = makeServer();
  const { port } = await server.start();
  const ws = await open(`ws://127.0.0.1:${port}/ws`);
  ws.send('это не json');
  ws.send(JSON.stringify({ id: 5, channel: 'эхо', args: ['жив'] }));
  assert.deepStrictEqual(await nextFrame(ws), { id: 5, ok: true, result: { эхо: 'жив' } });
  ws.close();
  await server.stop();
});

test('отключившийся клиент снимается с рассылки', async () => {
  const { server, broadcast } = makeServer();
  const { port } = await server.start();
  const ws = await open(`ws://127.0.0.1:${port}/ws`);
  assert.strictEqual(server.clientCount(), 1);
  await new Promise((r) => { ws.once('close', r); ws.close(); });
  await new Promise((r) => { setTimeout(r, 50); });
  assert.strictEqual(server.clientCount(), 0);
  broadcast.emit('tab:status', {}); // не должно бросить
  await server.stop();
});

test('обход каталога наружу не проходит', async () => {
  const { server } = makeServer();
  const { port } = await server.start();
  const res = await fetch(`http://127.0.0.1:${port}/../../package.json`);
  assert.notStrictEqual(res.status, 200);
  await server.stop();
});
```

- [ ] **Шаг 3: Запустить и убедиться, что падает**

Выполнить: `node --test test/net-server.test.js`
Ожидается: `Cannot find module '../src/main/net-server'`

- [ ] **Шаг 4: Написать реализацию**

```js
// src/main/net-server.js
'use strict';
// HTTP-статика + WebSocket: через них кокпит открывается на другой машине.
//
// Статика — ТОТ ЖЕ src/renderer, без правок разметки. Проверено на живом
// браузере: ссылка ../../node_modules/... из index.html схлопывается в
// /node_modules/..., поэтому достаточно отдать две папки.
//
// Протокол намеренно примитивный: кадр-запрос с id, кадр-ответ с тем же id,
// кадр-событие без id. Ничего, кроме JSON, — отлаживается глазами в консоли
// браузера.
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function createNetServer({
  registry, broadcast, outputBuffer, staticRoots, port = 48300, host = '127.0.0.1',
}) {
  let server = null;
  let wss = null;
  const clients = new Set();

  // Каждый путь обязан остаться внутри объявленного корня: '..' в запросе —
  // это попытка вылезти к KEYS.md и остальному, что лежит рядом.
  function resolveFile(urlPath) {
    const clean = path.normalize(decodeURIComponent(urlPath.split('?')[0]));
    for (const [prefix, root] of Object.entries(staticRoots)) {
      if (prefix !== '/' && !clean.startsWith(prefix)) continue;
      const rel = prefix === '/' ? clean : clean.slice(prefix.length);
      const abs = path.join(root, rel === '' || rel === '\\' ? 'index.html' : rel);
      if (!abs.startsWith(path.resolve(root))) return null;
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
    }
    return null;
  }

  function onHttp(req, res) {
    const file = resolveFile(req.url === '/' ? '/index.html' : req.url);
    if (!file) { res.writeHead(404); res.end('нет такого'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  }

  async function onFrame(ws, raw) {
    let msg;
    // Битый кадр не имеет права ронять сервер: на другом конце браузер,
    // который может прислать что угодно при обрыве.
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.channel !== 'string') return;
    const args = Array.isArray(msg.args) ? msg.args : [];
    const reply = (body) => { try { ws.send(JSON.stringify({ id: msg.id, ...body })); } catch { /* сокет ушёл */ } };
    try {
      // net:buffer обслуживает сервер, а не реестр: история — свойство
      // соединения, локальному окну она не нужна (у него свой xterm).
      const result = msg.channel === 'net:buffer'
        ? outputBuffer.get(args[0])
        : await registry.call(msg.channel, args);
      reply({ ok: true, result: result === undefined ? null : result });
    } catch (err) {
      reply({ ok: false, error: String((err && err.message) || err) });
    }
  }

  return {
    start() {
      return new Promise((resolve, reject) => {
        server = http.createServer(onHttp);
        wss = new WebSocket.Server({ server, path: '/ws' });
        wss.on('connection', (ws) => {
          const send = (event, payload) => ws.send(JSON.stringify({ event, payload }));
          clients.add(ws);
          broadcast.addClient(send);
          ws.on('message', (raw) => onFrame(ws, raw));
          ws.on('close', () => { clients.delete(ws); broadcast.removeClient(send); });
          ws.on('error', () => { clients.delete(ws); broadcast.removeClient(send); });
        });
        server.on('error', reject);
        server.listen(port, host, () => resolve({ port: server.address().port }));
      });
    },
    stop() {
      return new Promise((resolve) => {
        for (const ws of clients) { try { ws.terminate(); } catch { /* уже мёртв */ } }
        clients.clear();
        if (!server) { resolve(); return; }
        server.close(() => resolve());
      });
    },
    clientCount: () => clients.size,
  };
}

module.exports = { createNetServer };
```

- [ ] **Шаг 5: Запустить тесты**

Выполнить: `node --test test/net-server.test.js`
Ожидается: `pass 9`, `fail 0`

- [ ] **Шаг 6: Коммит**

```bash
git add src/main/net-server.js test/net-server.test.js package.json package-lock.json
git commit -m "feat: сетевой сервер — статика renderer и WebSocket с командами"
```

---

### Задача 6: Мост window.api в браузере

**Файлы:**
- Создать: `src/renderer/js/net-api.js`
- Создать: `test/net-api.test.js`
- Изменить: `src/renderer/index.html`

**Интерфейсы:**
- Потребляет: протокол задачи 5.
- Отдаёт: `createNetApi({ socket, shape })` → объект той же формы, что `window.api`
  из `preload`. `shape` — описание вида `{ 'tabs.open': {channel:'tabs:open', kind:'invoke'}, … }`.

- [ ] **Шаг 1: Написать падающий тест**

```js
// test/net-api.test.js
'use strict';
// Мост window.api поверх сокета. Renderer не знает, где он работает, — вся
// разница между Electron и браузером живёт здесь, в одном модуле.
const test = require('node:test');
const assert = require('node:assert');

const load = () => import('../src/renderer/js/net-api.js');

// Поддельный сокет: тот же интерфейс, что у WebSocket, но без сети.
function fakeSocket() {
  const sent = [];
  const listeners = {};
  return {
    sent,
    readyState: 1,
    send: (raw) => sent.push(JSON.parse(raw)),
    addEventListener: (name, fn) => { listeners[name] = fn; },
    receive(obj) { listeners.message({ data: JSON.stringify(obj) }); },
  };
}

const SHAPE = {
  'tabs.open': { channel: 'tabs:open', kind: 'invoke' },
  'term.write': { channel: 'term:write', kind: 'send' },
  'tab.onStatus': { channel: 'tab:status', kind: 'event' },
};

test('invoke уходит кадром с id и резолвится ответом', async () => {
  const { createNetApi } = await load();
  const socket = fakeSocket();
  const api = createNetApi({ socket, shape: SHAPE });

  const promise = api.tabs.open({ cwd: 'C:\\proj' });
  assert.deepStrictEqual(socket.sent[0], { id: 1, channel: 'tabs:open', args: [{ cwd: 'C:\\proj' }] });

  socket.receive({ id: 1, ok: true, result: { tabId: 'T1' } });
  assert.deepStrictEqual(await promise, { tabId: 'T1' });
});

test('ошибка с той стороны становится отказом промиса', async () => {
  const { createNetApi } = await load();
  const socket = fakeSocket();
  const api = createNetApi({ socket, shape: SHAPE });
  const promise = api.tabs.open({});
  socket.receive({ id: 1, ok: false, error: 'папки нет' });
  await assert.rejects(() => promise, /папки нет/);
});

test('send уходит без ожидания ответа', async () => {
  const { createNetApi } = await load();
  const socket = fakeSocket();
  const api = createNetApi({ socket, shape: SHAPE });
  api.term.write('T1', 'ls\r');
  assert.deepStrictEqual(socket.sent[0], { id: 1, channel: 'term:write', args: ['T1', 'ls\r'] });
});

test('подписка получает события сервера', async () => {
  const { createNetApi } = await load();
  const socket = fakeSocket();
  const api = createNetApi({ socket, shape: SHAPE });
  const got = [];
  api.tab.onStatus((p) => got.push(p));
  socket.receive({ event: 'tab:status', payload: { tabId: 'T1', status: 'working' } });
  assert.deepStrictEqual(got, [{ tabId: 'T1', status: 'working' }]);
});

test('несколько одновременных вызовов не путают ответы', async () => {
  // Ответы приходят в произвольном порядке: id — единственное, что их
  // различает, и перепутанный ответ выглядел бы как «данные другой вкладки».
  const { createNetApi } = await load();
  const socket = fakeSocket();
  const api = createNetApi({ socket, shape: SHAPE });
  const first = api.tabs.open({ cwd: 'первая' });
  const second = api.tabs.open({ cwd: 'вторая' });

  socket.receive({ id: 2, ok: true, result: 'ответ второй' });
  socket.receive({ id: 1, ok: true, result: 'ответ первой' });

  assert.strictEqual(await first, 'ответ первой');
  assert.strictEqual(await second, 'ответ второй');
});

test('ответ на неизвестный id игнорируется молча', async () => {
  const { createNetApi } = await load();
  const socket = fakeSocket();
  createNetApi({ socket, shape: SHAPE });
  socket.receive({ id: 999, ok: true, result: 'ничей' }); // не должно бросить
});
```

- [ ] **Шаг 2: Запустить и убедиться, что падает**

Выполнить: `node --test test/net-api.test.js`
Ожидается: `Cannot find module '../src/renderer/js/net-api.js'`

- [ ] **Шаг 3: Написать реализацию**

```js
// src/renderer/js/net-api.js
'use strict';
// Сборка window.api поверх WebSocket — вся разница между «мы в Electron» и
// «мы в браузере на макбуке» живёт здесь. Renderer её не видит: он знает
// только форму window.api и не подозревает про Electron (проверено — в нём
// нет ни require, ни process, ни __dirname).
//
// shape описывает форму api: путь через точку → канал и вид вызова.
// invoke — с ответом, send — без, event — подписка.
export function createNetApi({ socket, shape }) {
  const pending = new Map(); // id → {resolve, reject}
  const subscribers = new Map(); // канал события → [функции]
  let nextId = 1;

  socket.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.event) {
      for (const fn of subscribers.get(msg.event) || []) {
        // Падение одного подписчика не должно рвать поток остальным.
        try { fn(msg.payload); } catch { /* его беда */ }
      }
      return;
    }
    const waiter = pending.get(msg.id);
    // Ответ на неизвестный id — нормальная ситуация после переподключения:
    // молчим, а не падаем.
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.ok) waiter.resolve(msg.result);
    else waiter.reject(new Error(msg.error || 'сетевая команда не удалась'));
  });

  function send(channel, args) {
    const id = nextId;
    nextId += 1;
    socket.send(JSON.stringify({ id, channel, args }));
    return id;
  }

  const api = {};
  for (const [dotted, spec] of Object.entries(shape)) {
    const [group, name] = dotted.split('.');
    if (!api[group]) api[group] = {};
    if (spec.kind === 'invoke') {
      api[group][name] = (...args) => new Promise((resolve, reject) => {
        pending.set(send(spec.channel, args), { resolve, reject });
      });
    } else if (spec.kind === 'send') {
      api[group][name] = (...args) => { send(spec.channel, args); };
    } else {
      api[group][name] = (fn) => {
        if (!subscribers.has(spec.channel)) subscribers.set(spec.channel, []);
        subscribers.get(spec.channel).push(fn);
      };
    }
  }
  return api;
}
```

- [ ] **Шаг 4: Запустить тесты**

Выполнить: `node --test test/net-api.test.js`
Ожидается: `pass 6`, `fail 0`

- [ ] **Шаг 5: Добавить выбор транспорта в разметку**

В `src/renderer/index.html` перед строкой `<script type="module" src="./js/app.js"></script>`
вставить:

```html
    <!-- Выбор транспорта. В Electron window.api уже собран preload'ом; в
         браузере его собирает сетевой мост поверх WebSocket. Одна разметка
         на оба случая — чтобы не заводить вторую страницу, которая начнёт
         отставать от первой. -->
    <script type="module" src="./js/api-boot.js"></script>
```

Создать `src/renderer/js/api-boot.js`:

```js
'use strict';
// Если preload уже дал window.api — мы в Electron, ничего не делаем.
// Иначе поднимаем сокет к тому же хосту, откуда пришла страница.
import { createNetApi } from './net-api.js';
import { API_SHAPE } from './api-shape.js';

if (!window.api) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${proto}://${location.host}/ws`);
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
  window.api = createNetApi({ socket, shape: API_SHAPE });
}
```

- [ ] **Шаг 6: Составить описание формы api**

Создать `src/renderer/js/api-shape.js` — список снят с `src/preload/preload.js`
разбором исходника, все 53 метода:

```js
'use strict';
// Форма window.api: единый список для сетевого моста. Сверяется с preload.js
// тестом ниже — расхождение означает метод, который в браузере просто
// отсутствует и падает в неожиданный момент, а не при загрузке.
export const API_SHAPE = {
  'config.get': { channel: 'config:get', kind: 'invoke' },
  'config.set': { channel: 'config:set', kind: 'invoke' },
  'tabs.open': { channel: 'tabs:open', kind: 'invoke' },
  'tabs.close': { channel: 'tabs:close', kind: 'invoke' },
  'tabs.chooseFolder': { channel: 'tabs:chooseFolder', kind: 'invoke' },
  'tabs.markSeen': { channel: 'tabs:seen', kind: 'send' },
  'term.start': { channel: 'term:start', kind: 'send' },
  'term.write': { channel: 'term:write', kind: 'send' },
  'term.resize': { channel: 'term:resize', kind: 'send' },
  'term.restart': { channel: 'term:restart', kind: 'send' },
  'term.onData': { channel: 'term:data', kind: 'event' },
  'term.onExit': { channel: 'term:exit', kind: 'event' },
  'term.onStarted': { channel: 'term:started', kind: 'event' },
  'shell.openExternal': { channel: 'shell:openExternal', kind: 'invoke' },
  'app.onNotice': { channel: 'app:notice', kind: 'event' },
  'app.devtools': { channel: 'app:devtools', kind: 'invoke' },
  'project.connect': { channel: 'project:connect', kind: 'invoke' },
  'project.status': { channel: 'project:status', kind: 'invoke' },
  'git.get': { channel: 'git:get', kind: 'invoke' },
  'git.onChanged': { channel: 'git:changed', kind: 'event' },
  'gh.repo': { channel: 'gh:repo', kind: 'invoke' },
  'gh.global': { channel: 'gh:global', kind: 'invoke' },
  'tab.onStatus': { channel: 'tab:status', kind: 'event' },
  'tab.onActivate': { channel: 'tab:activate', kind: 'event' },
  'workspace.get': { channel: 'workspace:get', kind: 'invoke' },
  'workspace.setActive': { channel: 'workspace:setActive', kind: 'send' },
  'workspace.ready': { channel: 'workspace:ready', kind: 'send' },
  'ghost.save': { channel: 'ghost:save', kind: 'invoke' },
  'ghost.load': { channel: 'ghost:load', kind: 'invoke' },
  'attention.update': { channel: 'attention:update', kind: 'send' },
  'screenshot.paste': { channel: 'screenshot:paste', kind: 'invoke' },
  'queue.add': { channel: 'queue:add', kind: 'send' },
  'queue.remove': { channel: 'queue:remove', kind: 'send' },
  'queue.clear': { channel: 'queue:clear', kind: 'send' },
  'queue.onChanged': { channel: 'queue:changed', kind: 'event' },
  'history.search': { channel: 'history:search', kind: 'invoke' },
  'history.refresh': { channel: 'history:refresh', kind: 'invoke' },
  'recipes.list': { channel: 'recipes:list', kind: 'invoke' },
  'recipes.savePrompt': { channel: 'recipes:savePrompt', kind: 'invoke' },
  'recipes.deletePrompt': { channel: 'recipes:deletePrompt', kind: 'invoke' },
  'recipes.fillPrompt': { channel: 'recipes:fillPrompt', kind: 'invoke' },
  'recipes.normalizeForPty': { channel: 'recipes:normalizeForPty', kind: 'invoke' },
  'recipes.listWorkspaces': { channel: 'recipes:listWorkspaces', kind: 'invoke' },
  'recipes.saveWorkspace': { channel: 'recipes:saveWorkspace', kind: 'invoke' },
  'recipes.deleteWorkspace': { channel: 'recipes:deleteWorkspace', kind: 'invoke' },
  'night.toggle': { channel: 'night:toggle', kind: 'invoke' },
  'night.get': { channel: 'night:get', kind: 'invoke' },
  'night.onChanged': { channel: 'night:changed', kind: 'event' },
  'usage.get': { channel: 'usage:get', kind: 'invoke' },
  'usage.refresh': { channel: 'usage:refresh', kind: 'invoke' },
  'usage.onUpdate': { channel: 'usage:update', kind: 'event' },
  'stt.transcribe': { channel: 'stt:transcribe', kind: 'invoke' },
  'stt.status': { channel: 'stt:status', kind: 'invoke' },
};
```

**Осторожно с двумя методами.** `tabs.chooseFolder` открывает системный диалог на ПК —
по сети он бесполезен и до появления файлового обзора (следующий план) с макбука просто
не сработает. `screenshot.paste` читает буфер обмена ПК, а не макбука; исправлять это в
рамках плана не нужно, но знать про расхождение стоит.

- [ ] **Шаг 7: Написать тест на совпадение формы с preload**

```js
// добавить в test/net-api.test.js
const fs = require('node:fs');
const path = require('node:path');

test('форма api совпадает с preload — иначе метод молча отсутствует в браузере', async () => {
  const { API_SHAPE } = await import('../src/renderer/js/api-shape.js');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'preload.js'), 'utf8');
  const channels = new Set([...preload.matchAll(/ipcRenderer\.\w+\(\s*'([^']+)'/g)].map((m) => m[1]));
  const inShape = new Set(Object.values(API_SHAPE).map((s) => s.channel));
  const missing = [...channels].filter((c) => !inShape.has(c));
  assert.deepStrictEqual(missing, [], `каналы есть в preload, но не в форме: ${missing.join(', ')}`);
});
```

- [ ] **Шаг 8: Прогон и коммит**

Выполнить: `npm test` — ожидается `fail 0`

```bash
git add src/renderer/js/net-api.js src/renderer/js/api-boot.js src/renderer/js/api-shape.js src/renderer/index.html test/net-api.test.js
git commit -m "feat: window.api поверх WebSocket — renderer работает в браузере"
```

---

### Задача 7: Поднять сервер из кокпита и проверить с макбука

**Файлы:**
- Изменить: `src/main/ipc.js` (создание и запуск сервера)
- Изменить: `src/main/main.js` (остановка при выходе)

**Интерфейсы:**
- Потребляет: всё из задач 1–6.

- [ ] **Шаг 1: Поднять сервер при старте кокпита**

В `src/main/ipc.js`, рядом с созданием реестра и рассылки:

```js
const { createNetServer } = require('./net-server');
const netServer = createNetServer({
  registry,
  broadcast,
  outputBuffer,
  staticRoots: {
    '/node_modules': path.join(appRoot(), 'node_modules'),
    '/assets': path.join(appRoot(), 'assets'),
    '/': path.join(appRoot(), 'src', 'renderer'),
  },
  port: 48300,
  // Слушаем ТОЛЬКО адрес Tailscale: на 0.0.0.0 кокпит был бы виден любому
  // в чужом вайфае, а это выполнение произвольных команд на машине.
  host: '100.120.245.85',
});
netServer.start().catch((err) => console.log(`[net] сервер не поднялся: ${err.message}`));
```

- [ ] **Шаг 2: Остановить сервер при выходе**

В `src/main/main.js`, там же, где `disposeSessions()`, добавить `netServer.stop()`.
Экспортировать `netServer` из `registerIpc` рядом с прочими.

- [ ] **Шаг 3: Проверить, что локальный кокпит цел**

Выполнить: `npm test` — ожидается `fail 0`
Выполнить: `npm run smoke -- --user-data-dir=C:\Users\Lunev\AppData\Roaming\cockpit-net-data` — ожидается `[smoke] renderer-errors=0`

- [ ] **Шаг 4: Живой запуск дубликата**

```bash
npm start -- --user-data-dir=C:\Users\Lunev\AppData\Roaming\cockpit-net-data
```

Проверить в браузере ПК: `http://100.120.245.85:48300/` — должен открыться кокпит с
рабочим терминалом.

- [ ] **Шаг 5: Живая приёмка с макбука**

Открыть `http://100.120.245.85:48300/` на макбуке. Проверить по пунктам:
терминал печатает и отвечает; вывод `claude` виден целиком, включая работу агентов;
слэш-команды открывают своё меню; вкладки переключаются по `Ctrl+1..9`; палитра
открывается по `Ctrl+P`; перезагрузка страницы возвращает историю вкладки из буфера.

Это приёмка руками — тестами она не закрывается.

- [ ] **Шаг 6: Коммит**

```bash
git add src/main/ipc.js src/main/main.js
git commit -m "feat: кокпит поднимает сетевой сервер на интерфейсе Tailscale"
```

---

## Что этот план НЕ делает

Эти части описаны в спеке и вынесены в следующие планы: трей и автозапуск (без них
нельзя уходить от ПК), эстафета управления между машинами, файловый обзор для выбора
директории, токен и проверка происхождения запроса. До их появления сервер поднимается
без аутентификации — **на этом этапе не оставлять кокпит запущенным без присмотра**.
