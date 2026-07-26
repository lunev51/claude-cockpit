# Cockpit Phase 2b — Манифест, авто-resume, ghost buffers (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** «Как в браузере»: при запуске кокпит восстанавливает все вчерашние вкладки, каждая продолжает свою сессию (`--resume <id>`), с мгновенным вчерашним скроллбеком (ghost buffers) — плюс хвосты carryover 2a.

**Architecture:** Main держит манифест воркспейса (чистый модуль `workspace.js`, атомарная запись temp+rename с .bak-страховкой, дебаунс 500 мс) и обновляет его на каждое событие менеджера сессий. При старте renderer спрашивает манифест: есть вкладки → экран restore (чекбоксы, по умолчанию все) → поочерёдный спавн `claude --resume <id>` со стаггером; ghost-текст вливается в терминал до старта pty. session-id приходит из SessionStart-хука (2a) и живёт в манифесте.

**Tech Stack:** как раньше + `@xterm/addon-serialize` (чистый JS; ставить с `--ignore-scripts`, чтобы postinstall не трогал pty-пребилды, затем проверить их целостность).

**Спека:** §3.1-3.3, §5.1, §6 (манифест: упрощаю «5 снапшотов» до `file + file.bak` — двух поколений достаточно, меньше кода; фиксирую как осознанное отклонение). **Carryover:** `docs/superpowers/plans/2026-07-26-phase2b-carryover-notes.md` — пункты 2,3,4 (Task 1), 5-идея idle (Task 6); пункт 1 (bind-on-fallback) устарел — cwd-fallback удалён hotfix'ом de4f84f (маршрутизация по tabId).

## Global Constraints

- Electron 29.4.6; pty.js не трогать; после `npm install @xterm/addon-serialize --ignore-scripts` обязательная проверка `Test-Path node_modules\@homebridge\node-pty-prebuilt-multiarch\prebuilds` и `npm run smoke`.
- Хук-скрипт: контракт «всегда exit 0» безусловный.
- Манифест пишется атомарно (temp+rename) на КАЖДОЕ значимое изменение (дебаунс 500 мс) + flush при quit; битый файл → .bak → пустой воркспейс (не падать).
- Restore НИКОГДА не использует `--continue`; известный sessionId → `--resume <id>`, неизвестный → чистый спавн.
- Стаггер restore-спавнов: 1.5 с между вкладками (не душить систему).
- Все новые IPC несут tabId/ghostId; комментарии по-русски; каждая задача: `npm test` + `npm run smoke` → commit.

---

### Task 1: Хвосты 2a — hook hardening + housekeeping (TDD для spawn-теста)

**Files:**
- Modify: `scripts/cockpit-hook.js`, `src/main/hook-bridge.js`, `src/main/ipc.js` (комментарий)
- Create: `test/cockpit-hook.spawn.test.js`

**Interfaces:** без изменений контрактов; только надёжность.

- [ ] **Step 1: `test/cockpit-hook.spawn.test.js`** — спавн-тест реального скрипта (фиксирует wire-контракт, единственный компонент без автотеста):

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const { execFile } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'cockpit-hook.js');

// Запуск скрипта с given env/args/stdin → {code, stdout, stderr}
function runHook({ args = [], env = {}, stdin = '' }) {
  return new Promise((resolve) => {
    const child = execFile('node', [SCRIPT, ...args], {
      env: { ...process.env, COCKPIT_BRIDGE_PORT: '', ...env },
      timeout: 5000,
    }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
    child.stdin.end(stdin);
  });
}

// Одноразовый стаб-сервер: принимает один POST, отдаёт 200.
function stubServer() {
  return new Promise((resolve) => {
    const received = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, received, port: server.address().port }));
  });
}

test('happy path: POST {event,data,tabId} с application/json, exit 0', async () => {
  const { server, received, port } = await stubServer();
  const res = await runHook({
    args: ['Stop'],
    env: { COCKPIT_BRIDGE_PORT: String(port), COCKPIT_TAB_ID: 'tab-42' },
    stdin: '{"session_id":"s-1","cwd":"C:\\\\p"}',
  });
  server.close();
  assert.strictEqual(res.code, 0);
  assert.strictEqual(received.length, 1);
  assert.ok(received[0].headers['content-type'].startsWith('application/json'));
  const payload = JSON.parse(received[0].body);
  assert.strictEqual(payload.event, 'Stop');
  assert.strictEqual(payload.tabId, 'tab-42');
  assert.strictEqual(payload.data.session_id, 's-1');
});

test('мёртвый порт, битый stdin, отсутствующий port-file — всегда exit 0', async () => {
  for (const opts of [
    { args: ['Stop'], env: { COCKPIT_BRIDGE_PORT: '1' }, stdin: '{}' },        // connection refused
    { args: ['Stop'], env: { COCKPIT_BRIDGE_PORT: '48333' }, stdin: '{oops' }, // битый JSON
    { args: ['Stop', '--port-file', 'C:\\nonexistent\\pf'], stdin: '{}' },     // нет файла и env
    { args: [], stdin: '{}' },                                                  // нет события
  ]) {
    const res = await runHook(opts);
    assert.strictEqual(res.code, 0, JSON.stringify(opts));
  }
});
```

- [ ] **Step 2: RED** (второй тест упадёт, если exit≠0; happy-path упадёт до правок? — happy уже должен проходить; RED цель — новые гарантии Step 3). Прогнать, зафиксировать фактический вывод.

- [ ] **Step 3: `scripts/cockpit-hook.js`** — в самое начало `main()` (до чтения stdin) добавить безусловную страховку:

```js
  // Контракт абсолютен: НИКОГДА не мешать CLI. Любая непойманная ошибка — тихий выход 0.
  process.on('uncaughtException', () => process.exit(0));
  process.on('unhandledRejection', () => process.exit(0));
  process.stdin.on('error', () => process.exit(0));
```

- [ ] **Step 4: `src/main/hook-bridge.js` — удалять port-file при stop()** (после выхода кокпита хуки не должны слать промпты на порт, который может занять чужой процесс):

```js
  function stop() {
    if (server) {
      try { server.close(); } catch { /* уже */ }
      server = null;
    }
    if (portFile) {
      try { fs.unlinkSync(portFile); } catch { /* нет файла — ок */ }
    }
  }
```

Тест в `test/hook-bridge.test.js`: в существующем portFile-тесте после `bridge.stop()` добавить `assert.strictEqual(fs.existsSync(pf), false);`.

- [ ] **Step 5: `src/main/ipc.js`** — поправить устаревший комментарий у создания моста (упоминание findUnboundByCwd → «маршрутизация по tabId из env pty, session_id — fallback»).

- [ ] **Step 6:** `npm test` (43/43: 41 + 2 spawn) + `npm run smoke` → commit `fix: unconditional hook exit-0 guard, port-file cleanup on stop, spawn-level hook test`.

---

### Task 2: workspace.js — манифест воркспейса (TDD, чистый модуль)

**Files:**
- Create: `src/main/workspace.js`, `test/workspace.test.js`

**Interfaces:**
- Produces: `createWorkspaceStore({ file, debounceMs = 500 })`:
  - `load() → {version:1, activeIndex:number, tabs:[{cwd,name,sessionId,ghostId}]} | null` — читает file; битый/невалидный → file.bak; битый оба → null. Валидность: object, version===1, Array tabs, каждый tab имеет string cwd.
  - `set(state)` — запоминает состояние, планирует запись через debounceMs (сброс таймера при каждом set).
  - `flush()` — немедленная запись, если есть несохранённое (звать при quit).
  - Запись: перед rename текущий file (если есть) копируется в file.bak; затем temp+rename. Никогда не бросает наружу (console.warn).
  - `_writeNow()` не экспортировать; тесты используют flush().

- [ ] **Step 1: `test/workspace.test.js`:**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createWorkspaceStore } = require('../src/main/workspace');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-ws-'));
  return path.join(dir, 'workspace.json');
}

const STATE = {
  version: 1,
  activeIndex: 1,
  tabs: [
    { cwd: 'C:\\p\\alpha', name: 'alpha', sessionId: 's-1', ghostId: 'g-1' },
    { cwd: 'C:\\p\\beta', name: 'beta', sessionId: null, ghostId: 'g-2' },
  ],
};

test('set+flush пишет файл; load возвращает то же состояние', () => {
  const file = tmpFile();
  const store = createWorkspaceStore({ file, debounceMs: 10000 });
  store.set(STATE);
  store.flush();
  assert.deepStrictEqual(createWorkspaceStore({ file }).load(), STATE);
});

test('load без файла → null', () => {
  assert.strictEqual(createWorkspaceStore({ file: tmpFile() }).load(), null);
});

test('битый файл → падаем на .bak', () => {
  const file = tmpFile();
  const store = createWorkspaceStore({ file, debounceMs: 10 });
  store.set(STATE);
  store.flush();
  const next = { ...STATE, activeIndex: 0 };
  store.set(next);
  store.flush(); // при второй записи прежний файл ушёл в .bak
  fs.writeFileSync(file, '{broken', 'utf8');
  const loaded = createWorkspaceStore({ file }).load();
  assert.deepStrictEqual(loaded, STATE); // .bak хранит ПРЕДЫДУЩЕЕ валидное
});

test('битый файл и битый .bak → null, не бросает', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{broken', 'utf8');
  fs.writeFileSync(`${file}.bak`, 'also broken', 'utf8');
  assert.strictEqual(createWorkspaceStore({ file }).load(), null);
});

test('невалидная схема (tabs не массив) отвергается → .bak/null', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ version: 1, activeIndex: 0, tabs: 'nope' }), 'utf8');
  assert.strictEqual(createWorkspaceStore({ file }).load(), null);
});

test('дебаунс: серия set → одна запись после паузы', async () => {
  const file = tmpFile();
  const store = createWorkspaceStore({ file, debounceMs: 50 });
  for (let i = 0; i < 10; i++) store.set({ ...STATE, activeIndex: i % 2 });
  assert.strictEqual(fs.existsSync(file), false); // ещё не писали
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(fs.existsSync(file));
  assert.strictEqual(createWorkspaceStore({ file }).load().activeIndex, 1);
});

test('flush без set — no-op, файла нет', () => {
  const file = tmpFile();
  createWorkspaceStore({ file }).flush();
  assert.strictEqual(fs.existsSync(file), false);
});
```

- [ ] **Step 2: RED** (`Cannot find module`). **Step 3: `src/main/workspace.js`:**

```js
'use strict';
// Манифест воркспейса: какие вкладки открыты, их session-id и ghost-файлы.
// Пишется атомарно (temp+rename) с дебаунсом на каждое изменение — урок из
// жалоб на официальный клиент, где раскладка «не доживает» до перезапуска.
// Предыдущее валидное состояние хранится в .bak (упрощение спеки §6:
// двух поколений достаточно вместо пяти).

const fs = require('fs');

function isValid(state) {
  return !!state
    && typeof state === 'object'
    && state.version === 1
    && Number.isInteger(state.activeIndex)
    && Array.isArray(state.tabs)
    && state.tabs.every((t) => t && typeof t.cwd === 'string');
}

function readValid(file) {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isValid(state) ? state : null;
  } catch {
    return null;
  }
}

function createWorkspaceStore({ file, debounceMs = 500 }) {
  let pending = null;   // несохранённое состояние
  let timer = null;

  function load() {
    return readValid(file) || readValid(`${file}.bak`);
  }

  function writeNow() {
    if (pending === null) return;
    const state = pending;
    pending = null;
    try {
      // Текущий валидный файл становится страховкой перед перезаписью.
      if (fs.existsSync(file)) {
        try { fs.copyFileSync(file, `${file}.bak`); } catch { /* не критично */ }
      }
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(tmp, file);
    } catch (err) {
      console.warn(`[workspace] запись манифеста не удалась: ${err.message}`);
    }
  }

  function set(state) {
    pending = state;
    if (timer) clearTimeout(timer);
    timer = setTimeout(writeNow, debounceMs);
    if (timer.unref) timer.unref();
  }

  function flush() {
    if (timer) clearTimeout(timer);
    timer = null;
    writeNow();
  }

  return { load, set, flush };
}

module.exports = { createWorkspaceStore };
```

- [ ] **Step 4:** `npm test` (50/50) → **Step 5:** commit `feat: workspace manifest store with atomic writes and bak fallback`.

---

### Task 3: Живое обновление манифеста + IPC

**Files:**
- Modify: `src/main/sessions.js` (ghostId + событие смены состава), `src/main/ipc.js` (store-интеграция), `src/main/main.js` (flush при quit), `src/preload/preload.js` (api.workspace), `src/renderer/js/app.js` (setActive репорт)
- Test: `test/sessions.test.js` (+1)

**Interfaces:**
- sessions.js: `open()` присваивает `tab.ghostId = crypto.randomUUID()`; включить ghostId и sessionId в `list()`; после КАЖДОГО из: open, close, bindSession — `onEvent('tabs:changed', {})` (лёгкий сигнал «пересобери манифест»). Тест: open→close порождает события tabs:changed.
- ipc.js: создать store (`file: path.join(app.getPath('userData'), 'workspace.json')`); функция `syncWorkspace()` = `store.set({version:1, activeIndex, tabs: manager.list().map(({cwd,name,sessionId,ghostId}) => ({cwd,name,sessionId,ghostId}))})`; вызывать на tabs:changed (внутри onEvent-обёртки) и на `workspace:setActive`; `activeIndex` держать в переменной ipc (индекс в manager.list() по tabId; -1 → 0). IPC: `workspace:get` (handle → store.load()), `workspace:setActive` (on, {tabId}). Экспорт `flushWorkspace()`; main.js зовёт его в disposeAll-путях ПЕРЕД disposeSessions.
- preload: `workspace: { get: () => invoke('workspace:get'), setActive: (tabId) => send('workspace:setActive', {tabId}) }`.
- app.js: в `activateTab` после `tabStore.setActive` → `window.api.workspace.setActive(tabId)`.
- ВАЖНО: smoke-режим НЕ пишет манифест (store.set пропускать при smoke) — параллельный smoke не должен затирать воркспейс пользователя (урок port-файла).

- [ ] Шаги: тест на tabs:changed → RED → sessions.js правки → GREEN → ipc/main/preload/app.js правки → `npm test` (51/51) + smoke → commit `feat: live workspace manifest sync + IPC`.

---

### Task 4: Экран restore + авто-resume со стаггером

**Files:**
- Modify: `src/renderer/index.html` (оверлей), `src/renderer/css/app.css` (стили), `src/renderer/js/app.js` (boot-ветвление, restoreFlow)

**Interfaces:**
- Consumes: `api.workspace.get()`, `openTab(cwd, {activate, command, args})` — расширить openTab: прокидывать `command/args` в `api.tabs.open({cwd, command, args})`; ipc `tabs:open` уже передаёт их в `manager.open` (проверить: 2a-версия принимает `{cwd}` — добавить прозрачный проброс `command/args`).
- Поведение boot: `manifest = await api.workspace.get()`; null или tabs.length===0 → старая ветка (стартовая вкладка из config). Иначе — оверлей `#restore-overlay`:

```html
  <div id="restore-overlay" class="hidden">
    <div class="restore-card">
      <div class="restore-title">Восстановить воркспейс?</div>
      <div id="restore-list"></div>
      <div class="restore-actions">
        <button class="sidebar-btn" id="btn-restore-all">Восстановить (Enter)</button>
        <button class="sidebar-btn" id="btn-restore-none">Начать пусто (Esc)</button>
      </div>
    </div>
  </div>
```

CSS: оверлей на весь `#terminal-host`, карточка `--bg-panel`, радиус `--radius-l`, заголовок серифом; строка списка: чекбокс (default checked) + имя + cwd (muted) + пометка «сессия сохранена» если sessionId ≠ null.
- restoreFlow: собрать отмеченные; для каждой последовательно: `openTab(t.cwd, { activate: false, command: 'claude', args: t.sessionId ? ['--resume', t.sessionId] : null, ghostId: t.ghostId })` → между вкладками `await sleep(1500)`; активировать вкладку `manifest.activeIndex` (если восстановлена, иначе первую); скрыть оверлей после запуска первой (не ждать все); Enter/Esc — глобальные горячие на время оверлея.
- Если пользователь снял все галки/Esc → пустой воркспейс: показать «нет вкладок», «+ Проект» работает; манифест НЕ затирать до первого нового изменения состава (открытие/закрытие вкладки перезапишет естественно).

- [ ] Шаги: правки → `npm test` (без регрессий) + smoke (манифеста в smoke нет → старая ветка, PTY_OK как раньше) → ручная проверка: открыть 2-3 вкладки, закрыть приложение, открыть — оверлей со списком, Enter → вкладки поднимаются по очереди с `--resume` → commit `feat: restore overlay with staggered session resume`.

---

### Task 5: Ghost buffers — вчерашний скроллбек мгновенно

**Files:**
- Modify: `package.json` (+ @xterm/addon-serialize), `src/renderer/index.html` (script-тег аддона), `src/renderer/js/terminal.js` (SerializeAddon + serialize()), `src/renderer/js/app.js` (циклы сохранения, инжект при restore), `src/main/ipc.js` (ghost:save/load/delete), `src/preload/preload.js` (api.ghost)

**Interfaces:**
- Установка: `npm install @xterm/addon-serialize --ignore-scripts`; затем проверить пребилды pty (`Test-Path ...prebuilds`) и `npm run smoke`; script-тег `addon-serialize.js` рядом с остальными UMD.
- terminal.js: загрузить SerializeAddon (безусловно, лёгкий); в возврат добавить `serialize: () => serializeAddon.serialize({ scrollback: 2000 })`.
- main ipc: `ghost:save (tabId, text)` → ищет ghostId вкладки через manager.list(), пишет `userData/ghosts/<ghostId>.txt` (mkdir -p; запись best-effort); `ghost:load (ghostId)` → текст|null; `ghost:delete (ghostId)`; закрытие вкладки (`tabs:close`) удаляет её ghost-файл.
- app.js:
  - Сохранение: setInterval 30 с — serialize ТОЛЬКО активной вкладки (фоновые не меняются визуально? меняются — вывод идёт; но serialize всех каждые 30 с дорого при 6 вкладках → компромисс: активную каждые 30 с, любую вкладку при переходе её статуса в done/waiting (момент «Claude закончил ход» — самый ценный кадр). Подписка уже есть в onStatus-хендлере.
  - Инжект: в restoreFlow перед `api.term.start` (start зовёт initTerminal — ВНИМАНИЕ: initTerminal сам вызывает term.start; для ghost-инжекта передать в openTab/initTerminal опцию `preludeText` — initTerminal пишет её в term ДО window.api.term.start): приглушённый вывод + разделитель:

```js
  if (preludeText) {
    term.write('\x1b[2m');           // dim
    term.write(preludeText);
    term.write('\x1b[0m\r\n\x1b[2m— вчерашний вывод · сессия поднимается —\x1b[0m\r\n');
  }
```

  - openTab прокидывает preludeText, который restoreFlow получил через `api.ghost.load(t.ghostId)`.
- preload: `ghost: { save, load, delete }`.

- [ ] Шаги: установка аддона с проверкой pty → правки → `npm test` + smoke → ручная: наработать вывод, закрыть, открыть → вчерашний текст виден сразу приглушённым, живой вывод продолжает ниже → commit `feat: ghost buffers — instant dimmed scrollback on restore`.

---

### Task 6: Idle-арминг stuck-детекта + dispose терминала (carryover)

**Files:**
- Modify: `src/main/sessions.js` (+ тест), `src/renderer/js/terminal.js`, `src/renderer/js/app.js`
- Test: `test/sessions.test.js` (+2)

**Interfaces:**
- sessions.js: `tab.hookActive = false`; ставится true в `applyHookEvent` (любое событие). `checkStuck` пропускает вкладки с `hookActive === false` (без хуков «working» — это просто «терминал открыт», зависание не детектируемо честно). Тесты: (1) без hook-событий stuck не наступает; (2) после первого события — наступает по порогу.
- terminal.js: в возврат добавить `dispose()` — `observer.disconnect(); term.dispose();`; app.js `closeTab` зовёт `entry.view.dispose()` вместо `entry.view.term.dispose()`.
- app.js: убрать оставшуюся избыточную запись statusFont в boot() (если ещё есть).

- [ ] Шаги: TDD → правки → `npm test` (53/53) + smoke → commit `fix: stuck detection armed by hook activity; terminal dispose plugs observer leak`.

---

## Приёмка фазы (руками, после всех задач)

1. Открыть 3 вкладки (helper + 2 других), подключить хуки, поработать в каждой.
2. Закрыть кокпит. Открыть: оверлей со списком трёх, Enter.
3. Вкладки поднимаются по очереди (стаггер), в каждой мгновенно виден приглушённый вчерашний вывод, затем живая сессия продолжает ТУ ЖЕ беседу (проверить контекст вопросом «о чём мы говорили?»).
4. Активная вкладка — та, что была активной при закрытии.
5. Убить одну сессию (exit) → вкладка dead; перезапуск компа не требуется для проверки — достаточно закрыть/открыть приложение ещё раз.

## Self-Review (выполнен)

1. **Coverage:** манифест ✓ (T2-3), restore+resume ✓ (T4), ghost ✓ (T5), carryover 2/3/4 ✓ (T1), 5 ✓ (T6); pin вкладок и «Завершённые» из §5.1 — НЕ входят (объявляю: следующая фаза, вместе с очередью промптов).
2. **Placeholders:** нет; renderer-детали заданы поведенчески с ключевыми фрагментами кода — паттерны установлены фазами 1-2a.
3. **Consistency:** ghostId живёт в sessions.open → list() → манифест → restoreFlow → ghost:load; tabs:changed эмитится из sessions и слушается в ipc onEvent-обёртке; preludeText: restoreFlow → openTab → initTerminal. smoke не пишет манифест (изоляция как у port-файла).
