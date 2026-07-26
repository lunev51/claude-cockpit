# Cockpit Phase 2a — Хуки и статусы (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Живые статусы вкладок из хуков Claude Code: hook-bridge (HTTP-приёмник), connector (автопрописывание хуков в проект), машина статусов working/waiting/done/stuck/dead и сайдбар с группировкой по срочности.

**Architecture:** Хук-скрипт (чистый node, без зависимостей) POST-ит события SessionStart/UserPromptSubmit/PreToolUse/Notification/Stop на локальный HTTP-мост; мост маршрутизирует по `session_id` (fallback — cwd среди непривязанных вкладок) в sessions.js, который держит машину статусов и шлёт `tab:status` в renderer. Никакого парсинга ANSI. Порт моста хук-скрипт берёт из env `COCKPIT_BRIDGE_PORT` (хуки — потомки pty кокпита) с fallback на port-файл (для сессий, запущенных вне кокпита).

**Tech Stack:** как Фаза 1 (Electron 29.4.6, node:test, ванильный JS). Новых npm-зависимостей НЕТ (http из stdlib).

**Спека:** `docs/superpowers/specs/2026-07-26-cockpit-design.md` (§4.1 hook-bridge/connector, §5.2 машина статусов, фаза 2 из §9). **Carryover:** `docs/superpowers/plans/2026-07-26-phase2-carryover-notes.md` — пункты 1 (command/args), 2 (нейминг stuck/dead), 4 (сосед при закрытии), 5 (generation-counter), 6 (statusFont) закрываются здесь; пункт 3 (dispose) — в 2b вместе с ghost buffers.

## Global Constraints

- Electron `29.4.6`, postinstall не трогать; `npm install` не запускать (зависимостей не добавляем).
- pty.js не менять. Терминал — «глупое стекло»: статусы ТОЛЬКО из хуков и жизненного цикла pty.
- Палитра — токены из tokens.css; холодных серых нет. Статусы: waiting — терракотовый пульс `--accent`, working `--working`, done `--ok`, stuck `--warn`, dead `--err`.
- Все новые IPC-payload'ы несут `tabId`; hook-bridge слушает ТОЛЬКО 127.0.0.1.
- Хук-скрипт обязан всегда выходить с кодом 0 и укладываться в ~500 мс (никогда не мешать работе CLI).
- Каждая задача: `npm test` зелёный + `npm run smoke` exit 0 → commit. Комментарии по-русски.

---

### Task 1: Машина статусов + generation guard + per-tab command/args (sessions.js, TDD)

**Files:**
- Modify: `src/main/sessions.js` (полная замена), `test/sessions.test.js` (полная замена: 11 старых тестов адаптируются, +9 новых)

**Interfaces:**
- Consumes: ptyFactory/getTermConfig/onEvent как раньше; новая опция `now` (клок для тестов, деф. `Date.now`), `stuckAfterMs` (деф. 300000), `getExtraEnv()` (деф. `() => ({})` — Task 2 передаст порт моста).
- Produces (для Task 2-4 и Фазы 2b):
  - `open({cwd, command, args, smoke})` — command/args переопределяют config (для `claude --resume <id>` в 2b)
  - `bindSession(tabId, sessionId)`, `findBySessionId(sessionId) → tabId|null`, `findUnboundByCwd(cwd) → tabId|null`
  - `applyHookEvent(tabId, event, data)` — переходы: SessionStart→bind+working('сессия запущена'); UserPromptSubmit→working('думает…'); PreToolUse→working(tool_name); Notification→waiting(message, waitingText сохраняется); Stop→done('')
  - `checkStuck()` — вызывать таймером; working и нет вывода > stuckAfterMs → stuck('нет вывода Xм')
  - `noteOutput(tabId)` — зовётся из onData; stuck→working
  - статусы: `'working'|'waiting'|'done'|'stuck'|'dead'`; каждое изменение → `onEvent('tab:status', {tabId, status, subtitle, waitingText})`
  - pty exit (не superseded) → dead(`процесс завершён (код N)`)
  - generation guard: `tab.gen`, инкремент в начале КАЖДОГО spawn (до вызова фабрики); все колбэки сверяют захваченный `myGen === tab.gen` — закрывает и рестарт-гонки, и синхронный exit из фабрики (carryover 5)

- [ ] **Step 1: Переписать `test/sessions.test.js`** — полное содержимое:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createSessionManager } = require('../src/main/sessions');

// Фейковая фабрика pty: записывает вызовы, отдаёт управляемый инстанс.
function makeFakePtyFactory() {
  const spawned = [];
  const factory = (opts) => {
    const proc = {
      opts,
      written: [],
      killed: false,
      pid: 1000 + spawned.length,
      write(d) { this.written.push(d); },
      resize(c, r) { this.cols = c; this.rows = r; },
      kill() { this.killed = true; },
    };
    spawned.push(proc);
    return proc;
  };
  factory.spawned = spawned;
  return factory;
}

function makeManager(factory, opts = {}) {
  const events = [];
  let nowMs = 0;
  const mgr = createSessionManager({
    ptyFactory: factory,
    getTermConfig: () => ({ command: 'claude', args: [], useConpty: true, useConptyDll: true }),
    onEvent: (channel, payload) => events.push({ channel, payload }),
    now: () => nowMs,
    stuckAfterMs: 1000,
    ...opts,
  });
  return { mgr, events, tick: (ms) => { nowMs += ms; } };
}

const statusOf = (events, tabId) => {
  const st = events.filter((e) => e.channel === 'tab:status' && e.payload.tabId === tabId);
  return st.length ? st[st.length - 1].payload : null;
};

test('open регистрирует вкладку без спавна pty', () => {
  const factory = makeFakePtyFactory();
  const { mgr } = makeManager(factory);
  const tab = mgr.open({ cwd: 'C:\\proj\\alpha' });
  assert.ok(tab.tabId);
  assert.strictEqual(tab.name, 'alpha');
  assert.strictEqual(factory.spawned.length, 0);
});

test('start спавнит pty с cwd вкладки, write/resize маршрутизируются по tabId', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  const b = mgr.open({ cwd: 'C:\\proj\\beta' });
  mgr.start(a.tabId, 80, 24);
  mgr.start(b.tabId, 100, 30);
  assert.strictEqual(factory.spawned.length, 2);
  assert.strictEqual(factory.spawned[0].opts.cwd, 'C:\\proj\\alpha');
  assert.strictEqual(factory.spawned[1].opts.cwd, 'C:\\proj\\beta');
  mgr.write(b.tabId, 'hello');
  assert.deepStrictEqual(factory.spawned[1].written, ['hello']);
  assert.deepStrictEqual(factory.spawned[0].written, []);
  const started = events.filter((e) => e.channel === 'term:started');
  assert.strictEqual(started.length, 2);
});

test('per-tab command/args переопределяют конфиг', () => {
  const factory = makeFakePtyFactory();
  const { mgr } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha', command: 'claude', args: ['--resume', 'abc-123'] });
  mgr.start(a.tabId, 80, 24);
  assert.strictEqual(factory.spawned[0].opts.command, 'claude');
  assert.deepStrictEqual(factory.spawned[0].opts.args, ['--resume', 'abc-123']);
});

test('onData/onExit пробрасываются с tabId; exit не убивает соседнюю вкладку', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  const b = mgr.open({ cwd: 'C:\\proj\\beta' });
  mgr.start(a.tabId, 80, 24);
  mgr.start(b.tabId, 80, 24);
  factory.spawned[0].opts.onData('output-a');
  factory.spawned[1].opts.onExit(0);
  const data = events.find((e) => e.channel === 'term:data');
  assert.deepStrictEqual(data.payload, { tabId: a.tabId, data: 'output-a' });
  const exit = events.find((e) => e.channel === 'term:exit');
  assert.strictEqual(exit.payload.tabId, b.tabId);
  mgr.write(a.tabId, 'still-alive');
  assert.ok(factory.spawned[0].written.includes('still-alive'));
});

test('restart убивает старый pty и спавнит новый с теми же размерами', () => {
  const factory = makeFakePtyFactory();
  const { mgr } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 120, 40);
  mgr.restart(a.tabId);
  assert.strictEqual(factory.spawned.length, 2);
  assert.ok(factory.spawned[0].killed);
  assert.strictEqual(factory.spawned[1].opts.cols, 120);
  assert.strictEqual(factory.spawned[1].opts.rows, 40);
});

test('close убивает pty и удаляет вкладку; disposeAll убивает всё', () => {
  const factory = makeFakePtyFactory();
  const { mgr } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  const b = mgr.open({ cwd: 'C:\\proj\\beta' });
  mgr.start(a.tabId, 80, 24);
  mgr.start(b.tabId, 80, 24);
  mgr.close(a.tabId);
  assert.ok(factory.spawned[0].killed);
  assert.strictEqual(mgr.list().length, 1);
  mgr.disposeAll();
  assert.ok(factory.spawned[1].killed);
  assert.strictEqual(mgr.list().length, 0);
});

test('smoke-вкладка спавнит cmd.exe с echo PTY_OK', () => {
  const factory = makeFakePtyFactory();
  const { mgr } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\', smoke: true });
  mgr.start(a.tabId, 80, 24);
  assert.strictEqual(factory.spawned[0].opts.command, 'cmd.exe');
  assert.deepStrictEqual(factory.spawned[0].opts.args, ['/c', 'echo PTY_OK']);
});

test('restart: опоздавший onData старого pty не порождает term:data', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  mgr.restart(a.tabId);
  const before = events.filter((e) => e.channel === 'term:data').length;
  factory.spawned[0].opts.onData('stale-output');
  assert.strictEqual(events.filter((e) => e.channel === 'term:data').length, before);
  factory.spawned[1].opts.onData('fresh');
  assert.strictEqual(events.filter((e) => e.channel === 'term:data').length, before + 1);
});

test('restart: опоздавший onExit старого pty не эмитит term:exit, естественный exit нового — ровно один', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  mgr.restart(a.tabId);
  factory.spawned[0].opts.onExit(1);
  assert.strictEqual(events.filter((e) => e.channel === 'term:exit').length, 0);
  mgr.write(a.tabId, 'ok');
  assert.ok(factory.spawned[1].written.includes('ok'));
  factory.spawned[1].opts.onExit(0);
  assert.strictEqual(events.filter((e) => e.channel === 'term:exit').length, 1);
});

test('spawn: фабрика бросает исключение — term:data с сообщением об ошибке + term:exit(-1), tab.alive остаётся false', () => {
  const factory = () => { throw new Error('нет бинарника'); };
  const events = [];
  const mgr = createSessionManager({
    ptyFactory: factory,
    getTermConfig: () => ({ command: 'claude', args: [] }),
    onEvent: (channel, payload) => events.push({ channel, payload }),
  });
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  const data = events.find((e) => e.channel === 'term:data');
  assert.ok(data.payload.data.includes('не удалось запустить'));
  const exit = events.find((e) => e.channel === 'term:exit');
  assert.strictEqual(exit.payload.exitCode, -1);
  assert.strictEqual(mgr.list()[0].alive, false);
});

test('двойной start() на одной вкладке — no-op, фабрика вызывается один раз', () => {
  const factory = makeFakePtyFactory();
  const { mgr } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  mgr.start(a.tabId, 100, 30);
  assert.strictEqual(factory.spawned.length, 1);
  assert.strictEqual(factory.spawned[0].opts.cols, 80);
});

// ---------- новые тесты фазы 2a ----------

test('spawn ставит статус working; естественный exit — dead с кодом', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  assert.strictEqual(statusOf(events, a.tabId).status, 'working');
  factory.spawned[0].opts.onExit(3);
  const st = statusOf(events, a.tabId);
  assert.strictEqual(st.status, 'dead');
  assert.ok(st.subtitle.includes('3'));
});

test('applyHookEvent: SessionStart биндит session_id и находится через findBySessionId', () => {
  const factory = makeFakePtyFactory();
  const { mgr } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  mgr.applyHookEvent(a.tabId, 'SessionStart', { session_id: 'sess-1' });
  assert.strictEqual(mgr.findBySessionId('sess-1'), a.tabId);
  assert.strictEqual(mgr.findBySessionId('nope'), null);
});

test('findUnboundByCwd находит вкладку без session_id по cwd, привязанную — нет', () => {
  const factory = makeFakePtyFactory();
  const { mgr } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  const b = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  mgr.start(b.tabId, 80, 24);
  mgr.applyHookEvent(a.tabId, 'SessionStart', { session_id: 'sess-1' });
  assert.strictEqual(mgr.findUnboundByCwd('C:\\proj\\alpha'), b.tabId);
  mgr.applyHookEvent(b.tabId, 'SessionStart', { session_id: 'sess-2' });
  assert.strictEqual(mgr.findUnboundByCwd('C:\\proj\\alpha'), null);
});

test('переходы: PreToolUse→working с tool_name, Notification→waiting с текстом, Stop→done', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  mgr.applyHookEvent(a.tabId, 'PreToolUse', { tool_name: 'Bash' });
  let st = statusOf(events, a.tabId);
  assert.strictEqual(st.status, 'working');
  assert.ok(st.subtitle.includes('Bash'));
  mgr.applyHookEvent(a.tabId, 'Notification', { message: 'Разрешить запуск npm install?' });
  st = statusOf(events, a.tabId);
  assert.strictEqual(st.status, 'waiting');
  assert.ok(st.waitingText.includes('npm install'));
  mgr.applyHookEvent(a.tabId, 'Stop', {});
  st = statusOf(events, a.tabId);
  assert.strictEqual(st.status, 'done');
});

test('UserPromptSubmit переводит done в working', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  mgr.applyHookEvent(a.tabId, 'Stop', {});
  mgr.applyHookEvent(a.tabId, 'UserPromptSubmit', {});
  assert.strictEqual(statusOf(events, a.tabId).status, 'working');
});

test('checkStuck: working без вывода дольше порога → stuck; вывод возвращает working', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events, tick } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  tick(1500);
  mgr.checkStuck();
  assert.strictEqual(statusOf(events, a.tabId).status, 'stuck');
  factory.spawned[0].opts.onData('alive again');
  assert.strictEqual(statusOf(events, a.tabId).status, 'working');
});

test('checkStuck не трогает waiting/done/dead', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events, tick } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  mgr.applyHookEvent(a.tabId, 'Notification', { message: 'вопрос' });
  tick(5000);
  mgr.checkStuck();
  assert.strictEqual(statusOf(events, a.tabId).status, 'waiting');
});

test('generation guard: синхронный onExit из фабрики учитывается (не воскресает как alive)', () => {
  // Фабрика зовёт onExit СИНХРОННО до возврата — легитимный exit текущего поколения.
  const events = [];
  const factory = (opts) => {
    opts.onExit(7);
    return { write() {}, resize() {}, kill() {}, pid: 1 };
  };
  const mgr = createSessionManager({
    ptyFactory: factory,
    getTermConfig: () => ({ command: 'claude', args: [] }),
    onEvent: (channel, payload) => events.push({ channel, payload }),
  });
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  assert.strictEqual(events.filter((e) => e.channel === 'term:exit').length, 1);
  assert.strictEqual(mgr.list()[0].alive, false);
});

test('extraEnv попадает в env pty', () => {
  const factory = makeFakePtyFactory();
  const { mgr } = makeManager(factory, { getExtraEnv: () => ({ COCKPIT_BRIDGE_PORT: '48200' }) });
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  assert.strictEqual(factory.spawned[0].opts.env.COCKPIT_BRIDGE_PORT, '48200');
});
```

- [ ] **Step 2: Прогнать — убедиться в падении** — `npm test`: старые тесты частично зелёные, новые FAIL (`applyHookEvent is not a function` и т.п.).

- [ ] **Step 3: Переписать `src/main/sessions.js`** — полное содержимое:

```js
'use strict';
// Менеджер сессий: tabId → pty + машина статусов (спека §5.2).
// Чистый Node-модуль без Electron: фабрика pty, конфиг, клок и env инжектятся.
// Статусы приходят ТОЛЬКО из хуков Claude Code и жизненного цикла pty —
// вывод терминала не парсится никогда (хрупко, ломается о каждый релиз CLI).

const path = require('path');
const crypto = require('crypto');

const STATUSES = ['working', 'waiting', 'done', 'stuck', 'dead'];

// ptyFactory(opts) → {write, resize, kill, pid} — в проде createPty из pty.js.
// getTermConfig() → config.terminal; onEvent(channel, payload) → webContents.send.
// now() — клок (тестам нужен управляемый); stuckAfterMs — порог зависания;
// getExtraEnv() — доп. env для pty (порт hook-bridge, Task 2).
function createSessionManager({
  ptyFactory,
  getTermConfig,
  onEvent,
  now = Date.now,
  stuckAfterMs = 5 * 60 * 1000,
  getExtraEnv = () => ({}),
}) {
  const tabs = new Map();

  function open({ cwd, command = null, args = null, smoke = false }) {
    const tabId = crypto.randomUUID();
    const name = path.basename(cwd) || cwd;
    tabs.set(tabId, {
      tabId, cwd, name, smoke,
      command, args,           // per-tab переопределение (claude --resume <id> в фазе 2b)
      proc: null, cols: 80, rows: 24, alive: false,
      gen: 0,                  // поколение спавна: гардит все колбэки от гонок
      sessionId: null,         // session_id Claude Code из SessionStart-хука
      status: null, subtitle: '', waitingText: '',
      lastOutputAt: now(),
    });
    return { tabId, cwd, name };
  }

  function setStatus(tab, status, subtitle) {
    tab.status = status;
    if (typeof subtitle === 'string') tab.subtitle = subtitle;
    if (status !== 'waiting') tab.waitingText = '';
    onEvent('tab:status', {
      tabId: tab.tabId, status, subtitle: tab.subtitle, waitingText: tab.waitingText,
    });
  }

  function spawn(tab) {
    const t = getTermConfig();
    const spec = tab.smoke
      ? { command: 'cmd.exe', args: ['/c', 'echo PTY_OK'] }
      : { command: tab.command || t.command, args: tab.args || t.args };
    // Поколение растёт ДО вызова фабрики: синхронные колбэки нового процесса
    // проходят гард, а все колбэки предыдущего поколения — отсекаются.
    tab.gen += 1;
    const myGen = tab.gen;
    try {
      const proc = ptyFactory({
        ...spec,
        cwd: tab.cwd,
        cols: tab.cols,
        rows: tab.rows,
        useConpty: t.useConpty !== false,
        useConptyDll: t.useConptyDll !== false,
        env: {
          ...process.env,
          COCKPIT: '1',
          COCKPIT_TAB_ID: tab.tabId,
          ...getExtraEnv(),
        },
        onData: (data) => {
          if (myGen !== tab.gen) return; // хвост убитого процесса
          tab.lastOutputAt = now();
          if (tab.status === 'stuck') setStatus(tab, 'working', tab.subtitle);
          onEvent('term:data', { tabId: tab.tabId, data });
        },
        onExit: (exitCode) => {
          if (myGen !== tab.gen) return; // stale exit после рестарта
          tab.proc = null;
          tab.alive = false;
          setStatus(tab, 'dead', `процесс завершён (код ${exitCode})`);
          onEvent('term:exit', { tabId: tab.tabId, exitCode });
        },
      });
      // Синхронный exit из фабрики мог уже пометить смерть — не воскрешаем.
      if (myGen === tab.gen && tab.status !== 'dead') {
        tab.proc = proc;
        tab.alive = true;
        setStatus(tab, 'working', 'сессия запущена');
        onEvent('term:started', { tabId: tab.tabId, pid: proc.pid });
      }
    } catch (err) {
      tab.proc = null;
      tab.alive = false;
      setStatus(tab, 'dead', 'не запустился');
      onEvent('term:data', {
        tabId: tab.tabId,
        data: `\x1b[31m[не удалось запустить ${spec.command}: ${err.message}]\x1b[0m\r\n`,
      });
      onEvent('term:exit', { tabId: tab.tabId, exitCode: -1 });
    }
  }

  function start(tabId, cols, rows) {
    const tab = tabs.get(tabId);
    if (!tab || tab.proc) return;
    tab.cols = cols;
    tab.rows = rows;
    spawn(tab);
  }

  function write(tabId, data) {
    const tab = tabs.get(tabId);
    if (tab && tab.proc) tab.proc.write(data);
  }

  function resize(tabId, cols, rows) {
    const tab = tabs.get(tabId);
    if (!tab) return;
    tab.cols = cols;
    tab.rows = rows;
    if (tab.proc) tab.proc.resize(cols, rows);
  }

  function restart(tabId) {
    const tab = tabs.get(tabId);
    if (!tab) return;
    if (tab.proc) {
      try { tab.proc.kill(); } catch { /* мог уже завершиться */ }
      tab.proc = null;
      tab.alive = false;
    }
    tab.sessionId = null; // новая жизнь — новый SessionStart перебиндит
    spawn(tab);
  }

  function close(tabId) {
    const tab = tabs.get(tabId);
    if (!tab) return;
    tab.gen += 1; // отсекаем любые будущие колбэки процесса
    if (tab.proc) {
      try { tab.proc.kill(); } catch { /* мог уже завершиться */ }
    }
    tabs.delete(tabId);
  }

  // --- привязка session_id и события хуков ---

  function bindSession(tabId, sessionId) {
    const tab = tabs.get(tabId);
    if (tab) tab.sessionId = sessionId;
  }

  function findBySessionId(sessionId) {
    for (const tab of tabs.values()) {
      if (tab.sessionId === sessionId) return tab.tabId;
    }
    return null;
  }

  function findUnboundByCwd(cwd) {
    for (const tab of tabs.values()) {
      if (!tab.sessionId && tab.cwd === cwd) return tab.tabId;
    }
    return null;
  }

  // Переходы машины статусов по событиям хуков (спека §5.2).
  function applyHookEvent(tabId, event, data = {}) {
    const tab = tabs.get(tabId);
    if (!tab) return;
    switch (event) {
      case 'SessionStart':
        if (data.session_id) bindSession(tabId, data.session_id);
        setStatus(tab, 'working', 'сессия запущена');
        break;
      case 'UserPromptSubmit':
        setStatus(tab, 'working', 'думает…');
        break;
      case 'PreToolUse':
        setStatus(tab, 'working', data.tool_name ? `${data.tool_name}…` : 'работает…');
        break;
      case 'Notification':
        tab.waitingText = String(data.message || '');
        tab.status = 'waiting';
        tab.subtitle = tab.waitingText.slice(0, 120);
        onEvent('tab:status', {
          tabId: tab.tabId, status: 'waiting', subtitle: tab.subtitle, waitingText: tab.waitingText,
        });
        break;
      case 'Stop':
        setStatus(tab, 'done', '');
        break;
      default:
        break; // незнакомые события молча игнорируем — контракт CLI может расти
    }
  }

  // Детект зависания: working без вывода дольше порога. Зовётся таймером main.
  function checkStuck() {
    const ts = now();
    for (const tab of tabs.values()) {
      if (tab.status === 'working' && tab.proc && ts - tab.lastOutputAt > stuckAfterMs) {
        const min = Math.max(1, Math.round((ts - tab.lastOutputAt) / 60000));
        setStatus(tab, 'stuck', `нет вывода ${min}м`);
      }
    }
  }

  function list() {
    return [...tabs.values()].map(({ tabId, cwd, name, alive, status, subtitle, sessionId }) => (
      { tabId, cwd, name, alive, status, subtitle, sessionId }
    ));
  }

  function disposeAll() {
    for (const tabId of [...tabs.keys()]) close(tabId);
  }

  return {
    open, start, write, resize, restart, close, list, disposeAll,
    bindSession, findBySessionId, findUnboundByCwd, applyHookEvent, checkStuck,
  };
}

module.exports = { createSessionManager, STATUSES };
```

- [ ] **Step 4: `npm test`** — все 20 тестов PASS. **Step 5: `npm run smoke`** — exit 0. **Step 6: Commit** `feat: status machine, generation guard, per-tab args in session manager`.

---

### Task 2: hook-bridge.js — HTTP-приёмник событий хуков (TDD)

**Files:**
- Create: `src/main/hook-bridge.js`, `test/hook-bridge.test.js`
- Modify: `src/main/ipc.js` (создание моста + getExtraEnv + таймер stuck), `src/main/main.js` (порт-файл, останов моста)

**Interfaces:**
- Consumes: sessions manager Task 1 (`findBySessionId/findUnboundByCwd/applyHookEvent`).
- Produces:
  - `createHookBridge({ sessions, port = 0, portFile = null }) → { start() → Promise<number>, stop(), port() }` — слушает ТОЛЬКО 127.0.0.1; `port: 0` → эфемерный (тесты), в проде из `config.bridge.port` (деф. 48200, при занятости - fallback на 0 с записью фактического в portFile)
  - HTTP: `POST /event`, тело `{event: string, data: object}` (data = stdin-JSON хука: session_id, cwd, tool_name, message…). Ответы: 200 routed, 202 ignored (вкладка не найдена), 400 мусор. Тело ответа `{ok:true}` / `{ok:false}`.
  - Маршрутизация: `data.session_id → findBySessionId`; промах → `findUnboundByCwd(data.cwd)` (+ при SessionStart это сразу биндит); промах → 202.
  - `portFile` (userData/bridge-port) перезаписывается фактическим портом при start().
  - В `ipc.js`: `getExtraEnv: () => ({ COCKPIT_BRIDGE_PORT: String(bridge.port() || '') })`; `setInterval(sessions.checkStuck, 30000)` (unref); IPC `tab:onStatus` → канал `tab:status` уже эмитится sessions'ом через onEvent — ничего дополнительно не нужно, преload добавит слушатель в Task 4.
- Config: в `config.js` DEFAULTS добавить `bridge: { port: 48200 }`.

- [ ] **Step 1: Написать `test/hook-bridge.test.js`**:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createHookBridge } = require('../src/main/hook-bridge');

function makeFakeSessions() {
  const calls = [];
  const bySession = new Map();
  const byCwd = new Map();
  return {
    calls,
    bySession,
    byCwd,
    findBySessionId: (sid) => bySession.get(sid) || null,
    findUnboundByCwd: (cwd) => byCwd.get(cwd) || null,
    applyHookEvent: (tabId, event, data) => calls.push({ tabId, event, data }),
  };
}

function post(port, body) {
  return new Promise((resolve, reject) => {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, path: '/event', method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

test('маршрутизация по session_id доставляет applyHookEvent', async () => {
  const sessions = makeFakeSessions();
  sessions.bySession.set('sess-1', 'tab-1');
  const bridge = createHookBridge({ sessions, port: 0 });
  const port = await bridge.start();
  const res = await post(port, { event: 'Stop', data: { session_id: 'sess-1' } });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(sessions.calls[0], { tabId: 'tab-1', event: 'Stop', data: { session_id: 'sess-1' } });
  bridge.stop();
});

test('fallback по cwd для непривязанной вкладки', async () => {
  const sessions = makeFakeSessions();
  sessions.byCwd.set('C:\\proj\\alpha', 'tab-2');
  const bridge = createHookBridge({ sessions, port: 0 });
  const port = await bridge.start();
  const res = await post(port, { event: 'SessionStart', data: { session_id: 'new-sess', cwd: 'C:\\proj\\alpha' } });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(sessions.calls[0].tabId, 'tab-2');
  assert.strictEqual(sessions.calls[0].event, 'SessionStart');
  bridge.stop();
});

test('незнакомая сессия без cwd-совпадения → 202, applyHookEvent не зовётся', async () => {
  const sessions = makeFakeSessions();
  const bridge = createHookBridge({ sessions, port: 0 });
  const port = await bridge.start();
  const res = await post(port, { event: 'Stop', data: { session_id: 'ghost', cwd: 'C:\\nowhere' } });
  assert.strictEqual(res.status, 202);
  assert.strictEqual(sessions.calls.length, 0);
  bridge.stop();
});

test('битый JSON и не-POST → 400/404, сервер не падает', async () => {
  const sessions = makeFakeSessions();
  const bridge = createHookBridge({ sessions, port: 0 });
  const port = await bridge.start();
  const bad = await post(port, '{oops');
  assert.strictEqual(bad.status, 400);
  const res2 = await post(port, { event: 42 });
  assert.strictEqual(res2.status, 400);
  // сервер жив после мусора
  sessions.bySession.set('s', 't');
  const ok = await post(port, { event: 'Stop', data: { session_id: 's' } });
  assert.strictEqual(ok.status, 200);
  bridge.stop();
});

test('portFile получает фактический порт', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const pf = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-test-')), 'bridge-port');
  const sessions = makeFakeSessions();
  const bridge = createHookBridge({ sessions, port: 0, portFile: pf });
  const port = await bridge.start();
  assert.strictEqual(Number(fs.readFileSync(pf, 'utf8').trim()), port);
  bridge.stop();
});
```

- [ ] **Step 2: убедиться в падении** (`Cannot find module`). **Step 3: Реализовать `src/main/hook-bridge.js`**:

```js
'use strict';
// HTTP-приёмник событий хуков Claude Code. Слушает только 127.0.0.1.
// Хук-скрипт (scripts/cockpit-hook.js) POST-ит {event, data} на /event;
// data — это stdin-JSON хука (session_id, cwd, tool_name, message, …).
// Единственный источник правды о статусах — эти события (спека §4.1).

const http = require('http');
const fs = require('fs');

function createHookBridge({ sessions, port = 0, portFile = null }) {
  let server = null;
  let actualPort = 0;

  function route(event, data) {
    let tabId = data.session_id ? sessions.findBySessionId(data.session_id) : null;
    // До первого SessionStart вкладка ещё не привязана — ищем по cwd
    // среди непривязанных (двух непривязанных вкладок одного cwd мост
    // различить не может — привяжется первая, вторая дождётся своего события).
    if (!tabId && data.cwd) tabId = sessions.findUnboundByCwd(data.cwd);
    if (!tabId) return false;
    sessions.applyHookEvent(tabId, event, data);
    return true;
  }

  function handler(req, res) {
    if (req.method !== 'POST' || req.url !== '/event') {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 256 * 1024) req.destroy(); // защита от мусора
    });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* мусор */ }
      if (!parsed || typeof parsed.event !== 'string') {
        res.writeHead(400, { 'content-type': 'application/json' }).end('{"ok":false}');
        return;
      }
      const data = (parsed.data && typeof parsed.data === 'object') ? parsed.data : {};
      let routed = false;
      try { routed = route(parsed.event, data); } catch (err) {
        console.warn(`[hook-bridge] ошибка маршрутизации: ${err.message}`);
      }
      res.writeHead(routed ? 200 : 202, { 'content-type': 'application/json' }).end('{"ok":true}');
    });
  }

  function start() {
    return new Promise((resolve, reject) => {
      server = http.createServer(handler);
      server.on('error', reject);
      server.listen(port, '127.0.0.1', () => {
        actualPort = server.address().port;
        if (portFile) {
          try { fs.writeFileSync(portFile, String(actualPort), 'utf8'); } catch (err) {
            console.warn(`[hook-bridge] не записал port-файл: ${err.message}`);
          }
        }
        resolve(actualPort);
      });
    });
  }

  function stop() {
    if (server) {
      try { server.close(); } catch { /* уже */ }
      server = null;
    }
  }

  return { start, stop, port: () => actualPort };
}

module.exports = { createHookBridge };
```

- [ ] **Step 4: `npm test`** — PASS (25). **Step 5: интеграция в `ipc.js` и `main.js`.**

`config.js`: в DEFAULTS добавить ключ `bridge: { port: 48200 },` после `terminal`.

`ipc.js` — изменения (registerIpc становится async-инициализирующим мост; главное — порядок: мост стартует ДО первого spawn, чтобы env был готов):

```js
// вверху:
const path = require('path');
const { app } = require('electron');
const { createHookBridge } = require('./hook-bridge');

// в registerIpc, ПЕРЕД созданием manager:
  const bridge = createHookBridge({
    sessions: null, // sessions ещё нет — свяжем ниже через late-bind
    port: getConfig().bridge?.port ?? 48200,
    portFile: path.join(app.getPath('userData'), 'bridge-port'),
  });

// manager создаётся с getExtraEnv:
  manager = createSessionManager({
    ptyFactory: createPty,
    getTermConfig: () => getConfig().terminal,
    getExtraEnv: () => (bridge.port() ? { COCKPIT_BRIDGE_PORT: String(bridge.port()) } : {}),
    onEvent: (channel, payload) => {
      if (smoke && channel === 'term:data') smokeOutput += payload.data;
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    },
  });
```

Late-bind решить проще: конструировать мост ПОСЛЕ manager и передать `sessions: manager` (bridge не нужен manager'у на старте — только getExtraEnv, а он ленивый). Итоговый порядок в registerIpc: (1) создать manager (getExtraEnv замыкается на переменную bridge через `bridgeRef.port()`), (2) создать bridge с sessions: manager, (3) `bridge.start().catch(err => { console.warn('[hook-bridge] порт занят, пробую эфемерный:', err.message); /* пересоздать с port:0 и стартовать */ })`, (4) `const stuckTimer = setInterval(() => manager.checkStuck(), 30000); stuckTimer.unref?.();`. Экспортировать `stopBridge()` для main (звать в disposeAll-путях). Точная форма — на усмотрение имплементера, но: порт занят → fallback на эфемерный порт обязателен, portFile всегда содержит фактический.

- [ ] **Step 6: `npm test` + `npm run smoke`** → зелёные. **Step 7: Commit** `feat: hook-bridge HTTP receiver wired into sessions`.

---

### Task 3: cockpit-hook.js + connector.js — прописывание хуков в проект (TDD)

**Files:**
- Create: `scripts/cockpit-hook.js`, `src/main/connector.js`, `test/connector.test.js`
- Modify: `src/main/ipc.js` (IPC `project:connect`/`project:status`), `src/preload/preload.js` (api.project)

**Interfaces:**
- Produces:
  - `scripts/cockpit-hook.js` — `node cockpit-hook.js <EventName> --port-file "<path>"`: читает stdin-JSON, порт из env `COCKPIT_BRIDGE_PORT` или port-файла, POST на /event с таймаутом 400 мс, ЛЮБАЯ ошибка глотается, exit 0 всегда. Без npm-зависимостей.
  - `connector.js`: `hookCommand(event, {scriptPath, portFile}) → string`; `connectProject(projectDir, {scriptPath, portFile}) → {connected: true, settingsPath}`; `isConnected(projectDir, {scriptPath}) → boolean`. Merge в `<projectDir>/.claude/settings.json`: события SessionStart, UserPromptSubmit, PreToolUse (matcher "*"), Notification, Stop; свои записи узнаём по подстроке `cockpit-hook.js`; чужие хуки не трогаем; повторный connect идемпотентен (замена своих записей); атомарная запись temp+rename; битый settings.json → НЕ трогаем файл, возвращаем `{connected: false, error}`.
  - IPC: `project:connect (tabId)` → connector с cwd вкладки; `project:status (tabId)` → {connected: bool}. preload: `api.project.connect(tabId)`, `api.project.status(tabId)`.
- Consumes: `manager.list()` для cwd вкладки; `app.getPath('userData')` для portFile; `appRoot()` из paths.js для scriptPath.

- [ ] **Step 1: `test/connector.test.js`** (фикстуры во временной папке):

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { connectProject, isConnected, hookCommand } = require('../src/main/connector');

const OPTS = { scriptPath: 'C:\\cockpit\\scripts\\cockpit-hook.js', portFile: 'C:\\cockpit\\bridge-port' };

function tmpProject(settings) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-conn-'));
  if (settings !== undefined) {
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), settings, 'utf8');
  }
  return dir;
}

const readSettings = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));

test('connect в проект без settings.json создаёт файл со всеми пятью событиями', () => {
  const dir = tmpProject();
  const res = connectProject(dir, OPTS);
  assert.strictEqual(res.connected, true);
  const s = readSettings(dir);
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Notification', 'Stop']) {
    assert.ok(Array.isArray(s.hooks[ev]), `нет ${ev}`);
    const cmds = JSON.stringify(s.hooks[ev]);
    assert.ok(cmds.includes('cockpit-hook.js'), `нет нашей команды в ${ev}`);
  }
  // PreToolUse — с matcher
  assert.strictEqual(s.hooks.PreToolUse[0].matcher, '*');
  assert.strictEqual(isConnected(dir, OPTS), true);
});

test('чужие хуки и прочие ключи сохраняются', () => {
  const dir = tmpProject(JSON.stringify({
    permissions: { allow: ['Bash(npm test)'] },
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node my-own-hook.js' }] }] },
  }));
  connectProject(dir, OPTS);
  const s = readSettings(dir);
  assert.deepStrictEqual(s.permissions, { allow: ['Bash(npm test)'] });
  const stopCmds = JSON.stringify(s.hooks.Stop);
  assert.ok(stopCmds.includes('my-own-hook.js'));
  assert.ok(stopCmds.includes('cockpit-hook.js'));
});

test('повторный connect идемпотентен (наши записи не дублируются)', () => {
  const dir = tmpProject();
  connectProject(dir, OPTS);
  connectProject(dir, OPTS);
  const s = readSettings(dir);
  const count = (JSON.stringify(s.hooks.Stop).match(/cockpit-hook\.js/g) || []).length;
  assert.strictEqual(count, 1);
});

test('битый settings.json не перезаписывается', () => {
  const dir = tmpProject('{broken');
  const res = connectProject(dir, OPTS);
  assert.strictEqual(res.connected, false);
  assert.ok(res.error);
  assert.strictEqual(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'), '{broken');
});

test('isConnected: false без файла и без наших записей', () => {
  assert.strictEqual(isConnected(tmpProject(), OPTS), false);
  const dir = tmpProject(JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] } }));
  assert.strictEqual(isConnected(dir, OPTS), false);
});

test('hookCommand содержит node, скрипт в кавычках, имя события и port-file', () => {
  const cmd = hookCommand('Stop', OPTS);
  assert.ok(cmd.startsWith('node "'));
  assert.ok(cmd.includes('cockpit-hook.js" Stop'));
  assert.ok(cmd.includes('--port-file "C:\\cockpit\\bridge-port"'));
});
```

- [ ] **Step 2: падение подтверждено. Step 3: `scripts/cockpit-hook.js`:**

```js
#!/usr/bin/env node
'use strict';
// Хук Claude Code → POST в Cockpit hook-bridge. КОНТРАКТ: никогда не мешать
// работе CLI — любая ошибка глотается, exit 0 всегда, таймаут 400 мс.
// Использование: node cockpit-hook.js <EventName> --port-file "<path>"
// Порт: env COCKPIT_BRIDGE_PORT (хуки — потомки pty кокпита), иначе port-файл
// (сессии, запущенные вне кокпита, пока кокпит открыт).

const http = require('http');
const fs = require('fs');

function resolvePort(argv) {
  if (process.env.COCKPIT_BRIDGE_PORT) return Number(process.env.COCKPIT_BRIDGE_PORT);
  const i = argv.indexOf('--port-file');
  if (i !== -1 && argv[i + 1]) {
    try { return Number(fs.readFileSync(argv[i + 1], 'utf8').trim()); } catch { /* нет файла */ }
  }
  return 0;
}

function main() {
  const event = process.argv[2];
  const port = resolvePort(process.argv);
  if (!event || !port) process.exit(0);

  let stdin = '';
  process.stdin.on('data', (c) => { stdin += c; });
  process.stdin.on('end', () => {
    let data = {};
    try { data = JSON.parse(stdin); } catch { /* хук без JSON — шлём пустой */ }
    const payload = JSON.stringify({ event, data });
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/event',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      timeout: 400,
    }, (res) => { res.resume(); res.on('end', () => process.exit(0)); });
    req.on('timeout', () => { req.destroy(); process.exit(0); });
    req.on('error', () => process.exit(0));
    req.end(payload);
  });
  // Стража: даже если stdin не закроется — выходим.
  setTimeout(() => process.exit(0), 1500).unref();
}

main();
```

- [ ] **Step 4: `src/main/connector.js`:**

```js
'use strict';
// «Подключить проект»: прописывает хуки Cockpit в .claude/settings.json проекта.
// Merge аккуратный: чужие хуки и ключи сохраняются, свои записи (узнаём по
// подстроке cockpit-hook.js) заменяются идемпотентно. Битый JSON не трогаем.

const fs = require('fs');
const path = require('path');

const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Notification', 'Stop'];
const MARKER = 'cockpit-hook.js';

function hookCommand(event, { scriptPath, portFile }) {
  return `node "${scriptPath}" ${event} --port-file "${portFile}"`;
}

function settingsPath(projectDir) {
  return path.join(projectDir, '.claude', 'settings.json');
}

// Наша ли это запись события (ищем маркер в командах).
function isOurs(entry) {
  return JSON.stringify(entry).includes(MARKER);
}

function connectProject(projectDir, opts) {
  const file = settingsPath(projectDir);
  let settings = {};
  if (fs.existsSync(file)) {
    try {
      settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      return { connected: false, error: `settings.json повреждён: ${err.message}` };
    }
  }
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};

  for (const event of EVENTS) {
    const entry = { hooks: [{ type: 'command', command: hookCommand(event, opts) }] };
    if (event === 'PreToolUse') entry.matcher = '*';
    const existing = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    settings.hooks[event] = [...existing.filter((e) => !isOurs(e)), entry];
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return { connected: true, settingsPath: file };
}

function isConnected(projectDir) {
  const file = settingsPath(projectDir);
  try {
    return fs.readFileSync(file, 'utf8').includes(MARKER);
  } catch {
    return false;
  }
}

module.exports = { connectProject, isConnected, hookCommand, EVENTS };
```

- [ ] **Step 5: `npm test`** — PASS (31). **Step 6: IPC + preload.**

`ipc.js` добавить (рядом с tabs:*; `appRoot` из `./paths`):

```js
  const { connectProject, isConnected } = require('./connector');
  const hookOpts = () => ({
    scriptPath: path.join(appRoot(), 'scripts', 'cockpit-hook.js'),
    portFile: path.join(app.getPath('userData'), 'bridge-port'),
  });
  const tabCwd = (tabId) => manager.list().find((t) => t.tabId === tabId)?.cwd || null;

  ipcMain.handle('project:connect', (_e, tabId) => {
    const cwd = tabCwd(tabId);
    if (!cwd) return { connected: false, error: 'вкладка не найдена' };
    return connectProject(cwd, hookOpts());
  });

  ipcMain.handle('project:status', (_e, tabId) => {
    const cwd = tabCwd(tabId);
    return { connected: cwd ? isConnected(cwd) : false };
  });
```

`preload.js` добавить секцию:

```js
  project: {
    connect: (tabId) => ipcRenderer.invoke('project:connect', tabId),
    status: (tabId) => ipcRenderer.invoke('project:status', tabId),
  },
  tab: {
    onStatus: (cb) => ipcRenderer.on('tab:status', (_e, p) => cb(p)),
  },
```

- [ ] **Step 7: `npm test` + `npm run smoke`** → зелёные. **Step 8: Commit** `feat: cockpit hook script + project connector with settings merge`.

---

### Task 4: Сайдбар v2 — группировка по срочности, статусы, «подключить проект»

**Files:**
- Modify: `src/renderer/js/tabs.js` (полная замена), `src/renderer/js/app.js` (статусы + connect), `src/renderer/index.html` (секции сайдбара), `src/renderer/css/app.css` (стили секций/кнопки ⚡/статуса stuck)

**Interfaces:**
- Consumes: `api.tab.onStatus(cb({tabId,status,subtitle,waitingText}))`, `api.project.connect/status`, стор из Фазы 1.
- Produces (для 2b): `createTabStore` тот же контракт + `setStatus(tabId, status, subtitle)` со статусами `working|waiting|done|stuck|dead|idle`; группировка: секции Ждут тебя / Работают / Готово / Проблемы (stuck+dead); пустые секции скрыты; порядок `order()` = порядок создания (для Ctrl+1..9), группировка — только визуальная; фикс carryover 4: фолбэк при закрытии активной = сосед по order (предыдущий, иначе следующий); carryover 6: убрать лишнюю строку statusFont в boot().

- [ ] **Step 1: `index.html`** — заменить содержимое `#sidebar` на:

```html
    <div id="sidebar">
      <div id="tab-groups">
        <div class="sidebar-section wait hidden" data-group="waiting">Ждут тебя · <span class="count"></span></div>
        <div class="group-body" data-body="waiting"></div>
        <div class="sidebar-section hidden" data-group="working">Работают · <span class="count"></span></div>
        <div class="group-body" data-body="working"></div>
        <div class="sidebar-section hidden" data-group="done">Готово · <span class="count"></span></div>
        <div class="group-body" data-body="done"></div>
        <div class="sidebar-section hidden" data-group="trouble">Проблемы · <span class="count"></span></div>
        <div class="group-body" data-body="trouble"></div>
      </div>
      <div class="sidebar-footer">
        <button class="sidebar-btn" id="btn-new-tab">+ Проект</button>
      </div>
    </div>
```

(`#tab-list` больше нет — Ctrl+1..9 работает по `order()`, не по DOM.)

- [ ] **Step 2: `app.css`** — добавить:

```css
.hidden { display: none !important; }
.tab-dot.stuck { background: var(--warn); }
.tab-dot.dead  { background: var(--err); }
.tab-connect {
  border: none; background: none; color: var(--warn);
  cursor: pointer; font-size: 12px; padding: 0 2px;
}
.tab-connect:hover { color: var(--text); }
.group-body { display: flex; flex-direction: column; gap: 2px; }
```

(Классы `.tab-dot.working/.waiting/.done` и пульс уже есть из Фазы 1; `.tab-dot.error` в CSS остаётся — не используется, вычистим в фазе 6.)

- [ ] **Step 3: `tabs.js`** — полная замена:

```js
'use strict';
// Стор вкладок + рендер сайдбара с группировкой по срочности (спека, мокап B):
// Ждут тебя → Работают → Готово → Проблемы (stuck+dead). Пустые секции скрыты.
// Порядок вкладок для Ctrl+1..9 — порядок создания, группировка чисто визуальная.

const GROUP_OF = {
  waiting: 'waiting',
  working: 'working',
  done: 'done',
  stuck: 'trouble',
  dead: 'trouble',
  idle: 'working', // idle пока живёт в «Работают» (реальный idle появится в 2b)
};

export function createTabStore({ root, onActivate, onClose, onConnect }) {
  const rows = new Map(); // tabId → {row, dot, sub, connectBtn, name, cwd, status}
  const order = [];
  let activeId = null;

  const bodyOf = (group) => root.querySelector(`[data-body="${group}"]`);
  const headOf = (group) => root.querySelector(`[data-group="${group}"]`);

  function refreshGroups() {
    for (const group of ['waiting', 'working', 'done', 'trouble']) {
      const body = bodyOf(group);
      const head = headOf(group);
      const n = body.children.length;
      head.classList.toggle('hidden', n === 0);
      head.querySelector('.count').textContent = String(n);
    }
  }

  function placeRow(r) {
    bodyOf(GROUP_OF[r.status] || 'working').appendChild(r.row);
    refreshGroups();
  }

  function add({ tabId, name, cwd }) {
    const row = document.createElement('div');
    row.className = 'tab-row';

    const dot = document.createElement('span');
    dot.className = 'tab-dot working';

    const info = document.createElement('div');
    info.className = 'tab-info';
    const nameEl = document.createElement('div');
    nameEl.className = 'tab-name';
    nameEl.textContent = name;
    const sub = document.createElement('div');
    sub.className = 'tab-sub';
    sub.textContent = cwd;
    sub.title = cwd;
    info.append(nameEl, sub);

    // ⚡ — проект не подключён к хукам (статусы «молчат»); клик прописывает их.
    const connectBtn = document.createElement('button');
    connectBtn.className = 'tab-connect hidden';
    connectBtn.textContent = '⚡';
    connectBtn.title = 'Статусы молчат: подключить хуки Cockpit к проекту';
    connectBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      onConnect(tabId);
    });

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.textContent = '✕';
    close.title = 'Закрыть вкладку';
    close.addEventListener('click', (ev) => {
      ev.stopPropagation();
      onClose(tabId);
    });

    row.append(dot, info, connectBtn, close);
    row.addEventListener('click', () => onActivate(tabId));

    const r = { row, dot, sub, connectBtn, name, cwd, status: 'working' };
    rows.set(tabId, r);
    order.push(tabId);
    placeRow(r);
  }

  function remove(tabId) {
    const r = rows.get(tabId);
    if (!r) return;
    r.row.remove();
    rows.delete(tabId);
    const i = order.indexOf(tabId);
    if (i !== -1) order.splice(i, 1);
    if (activeId === tabId) activeId = null;
    refreshGroups();
  }

  function setActive(tabId) {
    for (const [id, r] of rows) r.row.classList.toggle('active', id === tabId);
    activeId = tabId;
  }

  function setStatus(tabId, status, subtitle) {
    const r = rows.get(tabId);
    if (!r) return;
    const regroup = GROUP_OF[r.status] !== GROUP_OF[status];
    r.status = status;
    r.dot.className = `tab-dot ${status}`;
    r.row.classList.toggle('waiting', status === 'waiting');
    if (typeof subtitle === 'string' && subtitle !== '') {
      r.sub.textContent = subtitle;
      r.sub.title = subtitle;
    } else if (typeof subtitle === 'string') {
      r.sub.textContent = r.cwd;
      r.sub.title = r.cwd;
    }
    if (regroup) placeRow(r);
  }

  function setConnectVisible(tabId, visible) {
    const r = rows.get(tabId);
    if (r) r.connectBtn.classList.toggle('hidden', !visible);
  }

  // Сосед по порядку создания: предыдущий, иначе следующий (carryover 4).
  function neighborOf(tabId) {
    const i = order.indexOf(tabId);
    if (i === -1) return null;
    return order[i - 1] || order[i + 1] || null;
  }

  return {
    add,
    remove,
    setActive,
    setStatus,
    setConnectVisible,
    neighborOf,
    order: () => [...order],
    get activeId() { return activeId; },
  };
}
```

- [ ] **Step 4: `app.js`** — изменения:

1. `createTabStore({ root: $('tab-groups'), onActivate: activateTab, onClose: closeTab, onConnect: connectProject })`.
2. Новая функция:

```js
async function connectProject(tabId) {
  const res = await window.api.project.connect(tabId);
  if (res && res.connected) tabStore.setConnectVisible(tabId, false);
  else console.warn(`[connect] не удалось: ${res && res.error}`);
}

async function refreshConnectBadge(tabId) {
  const { connected } = await window.api.project.status(tabId);
  tabStore.setConnectVisible(tabId, !connected);
}
```

3. В `openTab` после `tabStore.add(tab)`: `refreshConnectBadge(tab.tabId);`
4. В `boot()` подписка на статусы (после трёх term-подписок):

```js
  window.api.tab.onStatus(({ tabId, status, subtitle }) => {
    tabStore.setStatus(tabId, status, subtitle);
  });
```

5. `closeTab`: фолбэк-вкладка = `tabStore.neighborOf(tabId)` (вычислить ДО `tabStore.remove`), при null — прежняя ветка «нет вкладок». Условие wasActive остаётся.
6. Обработчик `term:exit` больше НЕ зовёт `tabStore.setStatus(..., 'error', ...)` — dead придёт каналом `tab:status` из sessions (двойной источник статуса убрать). Обработчик `term:started` больше не зовёт setStatus (working придёт из sessions).
7. Убрать лишнюю строку `statusFont().textContent = ...` в конце boot() (carryover 6) — activateTab уже выставляет.

- [ ] **Step 5: `npm test` + `npm run smoke`** → зелёные. Ручная проверка: `npm start`, открыть helper — на вкладке ⚡ (проект ещё не подключён); клик → в `helper\.claude\settings.json` появились 5 событий cockpit-hook; перезапустить сессию вкладки (Ctrl+Shift+R), написать Claude что-нибудь — точка зелёная working «думает…»/имя тулзы, по окончании — done «Готово», при permission-вопросе — терракотовый пульс в секции «Ждут тебя».

- [ ] **Step 6: Commit** `feat: urgency-grouped sidebar with live hook statuses and project connect`.

---

## Self-Review (выполнен)

1. **Coverage фазы 2a:** hook-bridge ✓ (Task 2), connector ✓ (Task 3), статусы ✓ (Task 1+4), carryover 1/2/4/5/6 ✓; манифест/resume/ghost — фаза 2b (следующий план), не дыра.
2. **Placeholders:** нет; единственное место «на усмотрение имплементера» (точная форма fallback занятого порта в ipc.js) ограничено твёрдым контрактом: фактический порт в portFile, эфемерный fallback обязателен.
3. **Type consistency:** `applyHookEvent(tabId, event, data)` совпадает в sessions/bridge/тестах; `tab:status {tabId,status,subtitle,waitingText}` совпадает sessions ↔ preload ↔ app.js ↔ tabs.setStatus; `createTabStore({root,...})` — app.js передаёт root, не container (переименование учтено в обоих местах); `hookCommand(event,{scriptPath,portFile})` совпадает connector ↔ тесты.
4. Известные компромиссы: два непривязанных таба одного cwd мост различает только после первых SessionStart (задокументировано в коде); PostToolUse не подключаем до Фазы 5 (diff-обновление); toast-уведомления — Фаза 4.
