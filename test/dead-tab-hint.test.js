'use strict';
// Подпись мёртвой вкладки говорит, что на деле сделает Ctrl+Shift+R (T1,
// вопрос владельцу из отчёта по ревью 09.08).
//
// Было: «— процесс не запущен · Ctrl+Shift+R продолжит сессию —» всегда. А
// restart() в sessions.js продолжает сессию, только когда знает её id; без
// него открывает пикер сессий (голый --resume), а после провала резюма —
// поднимает чистую новую сессию. Подпись обещала то, чего не будет.
//
// Вкладки здесь — настоящие: менеджер сессий доводит каждую до мёртвого
// состояния живыми событиями pty/хуков, подпись считается по элементу
// list() — ровно тому, что получает attachTab из tabs:list. Потом restart()
// показывает, что подпись не соврала.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createSessionManager } = require('../src/main/sessions');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer', 'js');
const guardsUrl = pathToFileURL(path.join(RENDERER, 'attach-guards.js')).href;

function makeManager() {
  const spawned = [];
  const factory = (opts) => {
    const proc = { opts, pid: 1000 + spawned.length, write() {}, resize() {}, kill() {} };
    spawned.push(proc);
    return proc;
  };
  let nowMs = 0;
  const mgr = createSessionManager({
    ptyFactory: factory,
    getTermConfig: () => ({ command: 'claude', args: [], useConpty: true, useConptyDll: true }),
    onEvent: () => {},
    now: () => nowMs,
    stuckAfterMs: 1000,
  });
  return { mgr, spawned, tick: (ms) => { nowMs += ms; } };
}

const listed = (mgr, tabId) => mgr.list().find((t) => t.tabId === tabId);

// Сессия привязалась хуком, потом процесс вышел сам (пятичасовой лимит,
// /exit) — id известен.
function deadWithSession() {
  const m = makeManager();
  const a = m.mgr.open({ cwd: 'C:\\proj\\alpha' });
  m.mgr.start(a.tabId, 80, 24);
  m.mgr.applyHookEvent(a.tabId, 'SessionStart', { session_id: 'S-alpha' }, m.mgr.get(a.tabId).gen);
  m.tick(3600000);
  m.spawned[0].opts.onExit(0);
  return { ...m, tabId: a.tabId };
}

// Хук SessionStart так и не пришёл (вкладка без хуков) — id неизвестен.
function deadWithoutSession() {
  const m = makeManager();
  const a = m.mgr.open({ cwd: 'C:\\proj\\beta' });
  m.mgr.start(a.tabId, 80, 24);
  m.tick(3600000);
  m.spawned[0].opts.onExit(0);
  return { ...m, tabId: a.tabId };
}

// Утренняя вкладка с протухшим id: резюм упал, авто-восстановление подняло
// чистую сессию, и та тоже вышла — прошлый оверрайд провалился.
function deadAfterFailedResume() {
  const m = makeManager();
  const a = m.mgr.open({ cwd: 'C:\\proj\\gamma', sessionId: 'S-ghost' });
  m.mgr.start(a.tabId, 80, 24);
  m.tick(2000);
  m.spawned[0].opts.onExit(1); // резюм провалился → авто-спавн с голыми args
  m.tick(2000);
  m.spawned[1].opts.onExit(1); // и он вышел — второго авто-восстановления нет
  return { ...m, tabId: a.tabId };
}

test('мёртвая вкладка с известной сессией: «продолжит сессию» — и restart() её резюмирует', async () => {
  const { deadTabHint } = await import(guardsUrl);
  const { mgr, spawned, tabId } = deadWithSession();
  const t = listed(mgr, tabId);
  assert.strictEqual(t.alive, false, 'фикстура не довела вкладку до смерти');
  assert.strictEqual(deadTabHint(t), 'процесс не запущен · Ctrl+Shift+R продолжит сессию');
  mgr.restart(tabId);
  assert.deepStrictEqual(spawned.at(-1).opts.args, ['--resume', 'S-alpha']);
});

test('мёртвая вкладка без известной сессии: «откроет выбор сессии» — и restart() открывает пикер', async () => {
  const { deadTabHint } = await import(guardsUrl);
  const { mgr, spawned, tabId } = deadWithoutSession();
  const t = listed(mgr, tabId);
  assert.strictEqual(t.alive, false);
  assert.strictEqual(t.sessionId, null);
  assert.strictEqual(deadTabHint(t), 'процесс не запущен · Ctrl+Shift+R откроет выбор сессии',
    'подпись обещает продолжить сессию, которой вкладка не знает');
  mgr.restart(tabId);
  assert.deepStrictEqual(spawned.at(-1).opts.args, ['--resume']);
});

test('мёртвая вкладка после провала резюма: «начнёт новую сессию» — и restart() поднимает чистую', async () => {
  const { deadTabHint } = await import(guardsUrl);
  const { mgr, spawned, tabId } = deadAfterFailedResume();
  const t = listed(mgr, tabId);
  assert.strictEqual(t.alive, false);
  assert.strictEqual(t.sessionId, null);
  assert.strictEqual(spawned.length, 2, 'фикстура: ровно одно авто-восстановление');
  assert.strictEqual(deadTabHint(t), 'процесс не запущен · Ctrl+Shift+R начнёт новую сессию',
    'после провала резюма restart() не открывает пикер, а поднимает чистую сессию');
  mgr.restart(tabId);
  assert.deepStrictEqual(spawned.at(-1).opts.args, []);
});

test('поле не доехало (вкладка не из list()) — подпись не обещает ничего конкретного', async () => {
  const { deadTabHint } = await import(guardsUrl);
  assert.strictEqual(deadTabHint({ tabId: 'T1', alive: false }), 'процесс не запущен · Ctrl+Shift+R перезапустит вкладку');
  assert.strictEqual(deadTabHint(null), 'процесс не запущен · Ctrl+Shift+R перезапустит вкладку');
});

// --- проводка: attachTab пишет в терминал именно эту подпись ---

const codeOnly = (source) => source
  .split(/\r?\n/)
  .filter((line) => !/^\s*\/\//.test(line))
  .map((line) => line.replace(/\s\/\/\s.*$/, ''))
  .join('\n');

test('attachTab пишет мёртвой вкладке deadTabHint(t), а не зашитый текст', () => {
  const app = codeOnly(fs.readFileSync(path.join(RENDERER, 'app.js'), 'utf8'));
  assert.match(app, /import\s+\{\s*deadTabHint\s*\}\s+from\s+'\.\/attach-guards\.js'/, 'deadTabHint не импортируется в app.js');
  assert.match(
    app,
    /if \(!shouldStartPty\(t\)\) \{\s*\n\s*views\.get\(t\.tabId\)\?\.view\.term\.write\(`\\r\\n\\x1b\[2m— \$\{deadTabHint\(t\)\} —\\x1b\[0m\\r\\n`\);/,
    'attachTab пишет мёртвой вкладке не deadTabHint(t)',
  );
  assert.ok(!/продолжит сессию/.test(app), 'в app.js остался зашитый текст «продолжит сессию»');
});
