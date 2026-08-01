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

test('open с явным ghostId переиспользует его; без него — минтит новый (ревью Task 5, finding 1a)', () => {
  const factory = makeFakePtyFactory();
  const { mgr } = makeManager(factory);

  const fixed = mgr.open({ cwd: 'C:\\proj\\alpha', ghostId: 'g-fixed' });
  const fixedGhostId = mgr.list().find((t) => t.tabId === fixed.tabId).ghostId;
  assert.strictEqual(fixedGhostId, 'g-fixed');

  const fresh = mgr.open({ cwd: 'C:\\proj\\beta' });
  const freshGhostId = mgr.list().find((t) => t.tabId === fresh.tabId).ghostId;
  assert.strictEqual(typeof freshGhostId, 'string');
  assert.strictEqual(freshGhostId.length, 36); // UUID
  assert.notStrictEqual(freshGhostId, 'g-fixed');
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
  const { mgr, events, tick } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  mgr.restart(a.tabId);
  factory.spawned[0].opts.onExit(1);
  assert.strictEqual(events.filter((e) => e.channel === 'term:exit').length, 0);
  mgr.write(a.tabId, 'ok');
  assert.ok(factory.spawned[1].written.includes('ok'));
  // Долгоживущий процесс (дольше окна авто-восстановления, спека §6) — этот
  // тест про gen-guard плумбинг, а не про авто-восстановление провала резюма;
  // tick разводит два механизма, чтобы не путать один с другим.
  tick(20000);
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

// ---------- C1 (Critical, ревью финальной волны фазы 8): классификация Notification ----------
// Claude Code шлёт хук Notification и на idle_prompt («жду вашего ввода» —
// раз в ~60с без фокуса терминала), и на permission_prompt («нужно
// разрешение») — connector.js регистрирует ОБА как одно и то же событие без
// matcher'а. tab.waitingKind различает их по содержимому message; list()
// отдаёт его наружу для обвязки ipc.js (resumableTabStatus).

test('Notification с idle-текстом ("waiting for your input") → waitingKind "idle"', () => {
  const factory = makeFakePtyFactory();
  const { mgr } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  mgr.applyHookEvent(a.tabId, 'Notification', { message: 'Claude is waiting for your input' });
  const tab = mgr.list().find((t) => t.tabId === a.tabId);
  assert.strictEqual(tab.status, 'waiting');
  assert.strictEqual(tab.waitingKind, 'idle');
});

test('Notification с permission-текстом ("needs your permission") → waitingKind "permission"', () => {
  const factory = makeFakePtyFactory();
  const { mgr } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  mgr.applyHookEvent(a.tabId, 'Notification', { message: 'Claude needs your permission to use Bash' });
  const tab = mgr.list().find((t) => t.tabId === a.tabId);
  assert.strictEqual(tab.waitingKind, 'permission');
});

test('Notification с мусорным/неизвестным текстом → waitingKind "permission" (консервативный дефолт)', () => {
  const factory = makeFakePtyFactory();
  const { mgr } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  mgr.applyHookEvent(a.tabId, 'Notification', { message: 'Разрешить запуск npm install?' });
  const tab = mgr.list().find((t) => t.tabId === a.tabId);
  assert.strictEqual(tab.waitingKind, 'permission');
});

test('waitingKind чистится вместе с waitingText при уходе из waiting (UserPromptSubmit после Notification)', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  mgr.applyHookEvent(a.tabId, 'Notification', { message: 'Claude is waiting for your input' });
  assert.strictEqual(mgr.list().find((t) => t.tabId === a.tabId).waitingKind, 'idle');
  mgr.applyHookEvent(a.tabId, 'UserPromptSubmit', {});
  // list() не отдаёт waitingText вовсе (никогда не отдавал, это не регрессия
  // этого фикса) — проверяем его через emitted 'tab:status' (statusOf), тот
  // же приём, что остальные тесты этого файла.
  assert.strictEqual(statusOf(events, a.tabId).waitingText, '');
  assert.strictEqual(mgr.list().find((t) => t.tabId === a.tabId).waitingKind, '');
});

// ---------- C2 (Critical, ревью финальной волны фазы 9): waitingKind в payload 'tab:status' ----------
// waitingKind уже считался (classifyNotification выше) и уже уходит наружу
// через list() (для ipc.js/ночной смены), но раньше НИКОГДА не попадал в сам
// payload 'tab:status' — renderer (Task 3 фазы 9, голосовой ввод) не мог
// отличить «ждёт idle_prompt» (пишущий статус) от «ждёт диалога разрешения»
// (блокирующий) и блокировал ЛЮБОЙ 'waiting'.

test('C2: waitingKind прокинут в payload tab:status — idle_prompt', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  mgr.applyHookEvent(a.tabId, 'Notification', {
    message: 'Claude is waiting for your input', notification_type: 'idle_prompt',
  });
  const st = statusOf(events, a.tabId);
  assert.strictEqual(st.status, 'waiting');
  assert.strictEqual(st.waitingKind, 'idle');
});

test('C2: waitingKind прокинут в payload tab:status — permission_prompt', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  mgr.applyHookEvent(a.tabId, 'Notification', {
    message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt',
  });
  const st = statusOf(events, a.tabId);
  assert.strictEqual(st.status, 'waiting');
  assert.strictEqual(st.waitingKind, 'permission');
});

test('C2: waitingKind в payload очищается при уходе из waiting — та же судьба, что waitingText', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  mgr.applyHookEvent(a.tabId, 'Notification', {
    message: 'Claude is waiting for your input', notification_type: 'idle_prompt',
  });
  mgr.applyHookEvent(a.tabId, 'UserPromptSubmit', {});
  const st = statusOf(events, a.tabId);
  assert.strictEqual(st.status, 'working');
  assert.strictEqual(st.waitingKind, '');
});

// ---------- Task 2 фазы 6: PostToolUse → git:changed, статус не трогает ----------

test('applyHookEvent: PostToolUse НЕ меняет статус вкладки, но эмитит git:changed с tabId', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  mgr.applyHookEvent(a.tabId, 'PreToolUse', { tool_name: 'Bash' });
  const statusBefore = statusOf(events, a.tabId);
  assert.strictEqual(statusBefore.status, 'working');

  const gitChangedBefore = events.filter((e) => e.channel === 'git:changed').length;
  mgr.applyHookEvent(a.tabId, 'PostToolUse', { tool_name: 'Bash' });

  // Статус — тот же самый объект, что и до PostToolUse: ни новый tab:status
  // не пришёл с другим статусом, ни существующий не изменился.
  const statusAfter = statusOf(events, a.tabId);
  assert.strictEqual(statusAfter.status, 'working');
  assert.deepStrictEqual(statusAfter, statusBefore);

  const gitChanged = events.filter((e) => e.channel === 'git:changed');
  assert.strictEqual(gitChanged.length, gitChangedBefore + 1);
  assert.deepStrictEqual(gitChanged[gitChanged.length - 1].payload, { tabId: a.tabId });
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

test('checkStuck: working без вывода дольше порога (hookActive=true после хук-события) → stuck; вывод возвращает working', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events, tick } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  // Армируем hookActive хук-событием — иначе checkStuck честно пропустит
  // вкладку (см. тесты idle-арминга ниже).
  mgr.applyHookEvent(a.tabId, 'SessionStart', { session_id: 'sess-1' });
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

// ---------- хотфикс: restart резюмит ту же сессию (спека §3.14) ----------

test('restart с привязанным session_id — второй спавн получает --resume <id> поверх базовых args', () => {
  const factory = makeFakePtyFactory();
  const { mgr } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha', args: ['--foo', 'bar'] });
  mgr.start(a.tabId, 80, 24);
  mgr.applyHookEvent(a.tabId, 'SessionStart', { session_id: 'sess-1' });
  mgr.restart(a.tabId);
  assert.strictEqual(factory.spawned.length, 2);
  assert.deepStrictEqual(factory.spawned[1].opts.args, ['--foo', 'bar', '--resume', 'sess-1']);
});

test('restart без session_id — второй спавн открывает голый --resume (пикер сессий)', () => {
  const factory = makeFakePtyFactory();
  const { mgr } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  mgr.restart(a.tabId);
  assert.strictEqual(factory.spawned.length, 2);
  assert.deepStrictEqual(factory.spawned[1].opts.args, ['--resume']);
});

test('restart: НАСТОЯЩИЙ провал (спавн с оверрайдом умер естественной смертью, SessionStart не пришёл) — авто-восстановление подхватывает немедленно, ручной рестарт поверх него всё ещё не зацикливается', () => {
  const factory = makeFakePtyFactory();
  const { mgr } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  mgr.restart(a.tabId); // спавн #2: голый --resume, пикер (session_id ещё не привязан)
  assert.deepStrictEqual(factory.spawned[1].opts.args, ['--resume']);
  // Естественная смерть спавна #2 (gen совпадает — это НЕ хвост убитого рестартом
  // процесса): SessionStart за время его жизни так и не пришёл (пикер брошен/провалился).
  // Спека §6: это тоже провал оверрайда (usedOverride && !sessionBound) —
  // авто-восстановление срабатывает ТУТ ЖЕ, спавн #3 уже с голыми args, без
  // участия пользователя.
  factory.spawned[1].opts.onExit(1);
  assert.strictEqual(factory.spawned.length, 3);
  assert.deepStrictEqual(factory.spawned[2].opts.args, []);
  // Ручной рестарт поверх уже авто-восстановленной вкладки тоже не должен
  // деградировать в бесконечный цикл пикера.
  mgr.restart(a.tabId); // спавн #4
  assert.strictEqual(factory.spawned.length, 4);
  assert.deepStrictEqual(factory.spawned[3].opts.args, []);
});

test('restart: восстановление после неудачи — SessionStart привязал id, следующий рестарт снова резюмит', () => {
  const factory = makeFakePtyFactory();
  const { mgr } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  mgr.restart(a.tabId); // спавн #2: голый --resume, пикер
  assert.deepStrictEqual(factory.spawned[1].opts.args, ['--resume']);
  mgr.applyHookEvent(a.tabId, 'SessionStart', { session_id: 'sess-9' });
  mgr.restart(a.tabId); // спавн #3: теперь есть id — резюмим именно его
  assert.strictEqual(factory.spawned.length, 3);
  assert.deepStrictEqual(factory.spawned[2].opts.args, ['--resume', 'sess-9']);
});

test('restart: разрыв с хуками (proc жив, SessionStart не приходит) — второй рестарт подряд ТОЖЕ получает голый --resume, не голые args (регрессия чередования)', () => {
  const factory = makeFakePtyFactory();
  const { mgr } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24); // спавн #1
  mgr.restart(a.tabId); // спавн #2: голый --resume (пикер)
  assert.deepStrictEqual(factory.spawned[1].opts.args, ['--resume']);
  // Процесс #2 остаётся ЖИВЫМ — onExit не зовём, SessionStart тоже не приходит
  // (хуки не подключены к проекту, либо пикер ещё открыт). Это не провал, это
  // устойчивое «пока без хуков».
  mgr.restart(a.tabId); // спавн #3: должен снова получить голый --resume, а не откат
  assert.strictEqual(factory.spawned.length, 3);
  assert.deepStrictEqual(factory.spawned[2].opts.args, ['--resume']);
});

// ---------- Phase 2b Task 3: живой манифест воркспейса ----------

test('open→close эмитят tabs:changed (лёгкий сигнал «пересобери манифест»)', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.close(a.tabId);
  const changed = events.filter((e) => e.channel === 'tabs:changed');
  assert.strictEqual(changed.length, 2);
});

test('restart эмитит tabs:changed — манифест пересобирается даже при проваленном резюме (не зацикливаемся на протухшем session_id)', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24); // спавн #1
  const beforeFirstRestart = events.filter((e) => e.channel === 'tabs:changed').length;

  mgr.restart(a.tabId); // спавн #2: session_id ещё не привязан — голый --resume (пикер)
  const afterFirstRestart = events.filter((e) => e.channel === 'tabs:changed').length;
  assert.strictEqual(afterFirstRestart, beforeFirstRestart + 1);

  // Проваленное резюме: спавн #2 умирает естественной смертью, SessionStart за
  // время его жизни так и не пришёл — onExit помечает tab.overrideFailed=true
  // И (FIX 4, carryover 3) сам эмитит tabs:changed НЕМЕДЛЕННО здесь же, не
  // дожидаясь следующего restart() — манифест узнаёт о протухшем sessionId
  // сразу, а не спустя произвольное время до следующего restart/open/close.
  //
  // ВАЖНО (ревью после первого прохода фикса §6): этот же onExit ТЕПЕРЬ ещё и
  // короткоживущий провал оверрайда (livedMs=0 на клоке этого теста, tick()
  // тут не звался) — авто-восстановление (спека §6) срабатывает СИНХРОННО
  // прямо внутри этого вызова и само спавнит спавн #3 (голые args), не
  // дожидаясь explicit mgr.restart() ниже. Без явной проверки длины
  // factory.spawned здесь explicit restart() ниже тихо стал бы спавном #4
  // вместо ожидаемого #3, а assert на .args прошёл бы «случайно» (голые args
  // совпадают что у авто-спавна, что у ручного рестарта) — ровно то, на что
  // указало ревью. Фиксируем длину явно, чтобы это никогда больше не
  // проскочило незамеченным.
  factory.spawned[1].opts.onExit(1);
  const afterFailedExit = events.filter((e) => e.channel === 'tabs:changed').length;
  assert.strictEqual(afterFailedExit, afterFirstRestart + 1);
  assert.strictEqual(factory.spawned.length, 3, 'onExit уже произвёл авто-спавн #3 (голые args)');
  assert.deepStrictEqual(factory.spawned[2].opts.args, []);

  // Ручной restart() ЗДЕСЬ — это спавн #4, ПОВЕРХ уже авто-восстановленной
  // вкладки (не #3, как было до §6). tab.overrideFailed всё ещё true (его
  // сбрасывает только restart()/успешный SessionStart, авто-восстановление
  // его не трогает) — поэтому restart() опять идёт на голые args, без
  // отката на пикер.
  mgr.restart(a.tabId); // спавн #4: overrideFailed=true → голые args (без цикла на пикере)
  assert.strictEqual(factory.spawned.length, 4, 'ручной restart() — это спавн #4, а не #3');
  assert.deepStrictEqual(factory.spawned[3].opts.args, []);
  const afterSecondRestart = events.filter((e) => e.channel === 'tabs:changed').length;
  // Именно это и было целью теста: манифест пересобирается СНОВА даже на
  // рестарте, вызванном провалом резюма, — иначе следующий запуск приложения
  // продолжал бы пытаться резюмить уже протухший session_id. Двойная
  // подстраховка (немедленный emit из FIX 4 + explicit emit из restart())
  // не страшна — sync в ipc.js идемпотентен относительно повторных вызовов.
  assert.strictEqual(afterSecondRestart, afterFailedExit + 1);
});

test('restart: kill() фабрики синхронно зовёт свой onExit — гард по поколению не путает это с провалом resume/continue', () => {
  // Некоторые реализации pty (в т.ч. реальный node-pty) могут вызвать onExit
  // синхронно прямо из kill(). restart() бампает tab.gen ДО kill() именно чтобы
  // такой exit был отсечён гардом и не портил overrideFailed/статус.
  const spawned = [];
  const factory = (opts) => {
    const proc = {
      opts,
      written: [],
      killed: false,
      pid: 1000 + spawned.length,
      write(d) { this.written.push(d); },
      resize(c, r) { this.cols = c; this.rows = r; },
      kill() {
        this.killed = true;
        opts.onExit(0); // намеренный kill сам синхронно роняет onExit
      },
    };
    spawned.push(proc);
    return proc;
  };
  factory.spawned = spawned;
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24); // спавн #1
  mgr.restart(a.tabId); // kill() спавна #1 синхронно зовёт onExit — должен быть отсечён
  assert.deepStrictEqual(spawned[1].opts.args, ['--resume']);
  assert.strictEqual(
    events.some((e) => e.channel === 'tab:status' && e.payload.status === 'dead'),
    false,
  );
  mgr.restart(a.tabId); // тот же гард — снова голый --resume, не откат на голые args
  assert.strictEqual(spawned.length, 3);
  assert.deepStrictEqual(spawned[2].opts.args, ['--resume']);
});

// ---------- Phase 2b Task 6: idle-арминг stuck-детекта ----------

test('checkStuck: без хук-событий (hookActive=false) stuck НЕ наступает даже после порога — без хуков "working" значит лишь "терминал открыт"', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events, tick } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  tick(1500); // дольше stuckAfterMs
  mgr.checkStuck();
  assert.strictEqual(statusOf(events, a.tabId).status, 'working');
});

test('checkStuck: после первого хук-события (hookActive=true) stuck наступает по порогу как раньше', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events, tick } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  mgr.applyHookEvent(a.tabId, 'PreToolUse', { tool_name: 'Bash' }); // любое хук-событие армирует
  tick(1500);
  mgr.checkStuck();
  assert.strictEqual(statusOf(events, a.tabId).status, 'stuck');
});

// ---------- Phase 2b Task 6: зачистка унаследованных маркеров Claude Code ----------

// ---------- FIX 3 (ревью): sessionId восстановления не теряется, конфигурационные args сохраняются ----------

test('open с sessionId — list() отдаёт его сразу; первый spawn получает [...configArgs, "--resume", id], конфигурационные args СОХРАНЕНЫ', () => {
  const factory = makeFakePtyFactory();
  const { mgr } = makeManager(factory, {
    // getTermConfig с пользовательскими args (--model sonnet) — ключевая
    // проверка: раньше restoreFlow слал args:['--resume', id], который
    // ПОДМЕНЯЛ конфигурационные args вкладки, и пользователь молча получал
    // другую модель на восстановленной вкладке.
    getTermConfig: () => ({ command: 'claude', args: ['--model', 'sonnet'], useConpty: true, useConptyDll: true }),
  });
  const a = mgr.open({ cwd: 'C:\\proj\\alpha', sessionId: 'sess-restored' });
  // sessionId виден в list() ДО первого спавна и до какого-либо SessionStart —
  // манифест не должен ждать хук-события, чтобы узнать восстанавливаемый id.
  assert.strictEqual(mgr.list().find((t) => t.tabId === a.tabId).sessionId, 'sess-restored');

  mgr.start(a.tabId, 80, 24);
  assert.strictEqual(factory.spawned[0].opts.command, 'claude');
  assert.deepStrictEqual(factory.spawned[0].opts.args, ['--model', 'sonnet', '--resume', 'sess-restored']);
});

test('после restore-спавна restart() даёт РОВНО один --resume (резюм-флаги больше не живут в tab.args)', () => {
  const factory = makeFakePtyFactory();
  const { mgr } = makeManager(factory, {
    getTermConfig: () => ({ command: 'claude', args: ['--model', 'sonnet'], useConpty: true, useConptyDll: true }),
  });
  const a = mgr.open({ cwd: 'C:\\proj\\alpha', sessionId: 'sess-restored' });
  mgr.start(a.tabId, 80, 24); // спавн #1: ['--model','sonnet','--resume','sess-restored']
  assert.deepStrictEqual(factory.spawned[0].opts.args, ['--model', 'sonnet', '--resume', 'sess-restored']);

  // Хук подтверждает привязку той же сессии (обычный путь для успешного resume).
  mgr.applyHookEvent(a.tabId, 'SessionStart', { session_id: 'sess-restored' });

  // Ctrl+Shift+R на восстановленной вкладке — раньше tab.args УЖЕ содержал
  // '--resume sess-restored' (если бы restoreFlow клал его в args), и restart()
  // дописывал бы ещё один '--resume', давая дубль ['--resume','s','--resume','s'].
  // Теперь tab.args — это только конфигурационные args, дубля нет.
  mgr.restart(a.tabId); // спавн #2
  assert.strictEqual(factory.spawned.length, 2);
  assert.deepStrictEqual(factory.spawned[1].opts.args, ['--model', 'sonnet', '--resume', 'sess-restored']);
  const resumeCount = factory.spawned[1].opts.args.filter((x) => x === '--resume').length;
  assert.strictEqual(resumeCount, 1);
});

test('провал restore-резюма (естественный onExit без SessionStart) — sessionId обнуляется в list(), авто-восстановление уже даёт чистые args, ручной restart поверх него тоже без цикла', () => {
  const factory = makeFakePtyFactory();
  const { mgr } = makeManager(factory, {
    getTermConfig: () => ({ command: 'claude', args: ['--model', 'sonnet'], useConpty: true, useConptyDll: true }),
  });
  const a = mgr.open({ cwd: 'C:\\proj\\alpha', sessionId: 'stale-session' });
  mgr.start(a.tabId, 80, 24); // спавн #1: пытается резюмить stale-session
  assert.deepStrictEqual(factory.spawned[0].opts.args, ['--model', 'sonnet', '--resume', 'stale-session']);

  // Естественная смерть без единого SessionStart за время жизни процесса —
  // resume реально не удался (сессия протухла/не существует). Это ровно баг
  // пользователя ("No conversation found...", спека §6) — авто-восстановление
  // срабатывает НЕМЕДЛЕННО: спавн #2 уже идёт на чистых конфигурационных args,
  // без ожидания ручного restart().
  factory.spawned[0].opts.onExit(1);
  assert.strictEqual(mgr.list().find((t) => t.tabId === a.tabId).sessionId, null);
  assert.strictEqual(factory.spawned.length, 2);
  assert.deepStrictEqual(factory.spawned[1].opts.args, ['--model', 'sonnet']);

  mgr.restart(a.tabId); // спавн #3: ручной рестарт поверх авто-восстановленной — тоже без цикла
  assert.strictEqual(factory.spawned.length, 3);
  assert.deepStrictEqual(factory.spawned[2].opts.args, ['--model', 'sonnet']);
});

// ---------- FIX 4 (carryover 3): протухший sessionId должен долетать до манифеста немедленно ----------

test('FIX 4: onExit без SessionStart (первый спавн restore, ДО какого-либо restart) эмитит tabs:changed сразу — манифест узнаёт о протухшем sessionId, не дожидаясь следующего restart/open/close', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha', sessionId: 'stale-session' });
  mgr.start(a.tabId, 80, 24); // спавн #1: пытается резюмить stale-session

  const beforeLen = events.length;
  // Естественная смерть без единого SessionStart за время жизни процесса —
  // resume реально не удался. До FIX 4 sessionId зануляется ТОЛЬКО в памяти
  // тут же (onExit), а onEvent('tabs:changed', ...) не звался — syncWorkspace
  // (который слушает исключительно 'tabs:changed') не пересобрал бы манифест
  // до следующего restart()/open()/close(), и протухший id мог уехать на диск
  // при выходе приложения ПРЯМО СЕЙЧАС (между этим onExit и любым restart).
  //
  // Аудит после ревью фикса §6: этот onExit (livedMs=0, tick() тут не звался)
  // ТОЖЕ запускает авто-восстановление (спавн #2, голые args) — но assertions
  // ниже намеренно НЕ зависят от того, какой именно спавн проверяется: `.some()`
  // по каналу события (а не по индексу конкретного спавна) и sessionId в
  // list() (auto-восстановление его не перепривязывает). Это ровно тот
  // случай из ревью, когда тест НЕ проходит «случайно» — его утверждения
  // остаются истинными независимо от появления авто-спавна, поэтому явная
  // проверка длины factory.spawned здесь не нужна (в отличие от теста
  // «restart эмитит tabs:changed…» выше, где assert индексировал ИМЕННО
  // спавн — там разбор длины был обязателен).
  factory.spawned[0].opts.onExit(1);

  const added = events.slice(beforeLen);
  assert.ok(
    added.some((e) => e.channel === 'tabs:changed'),
    'onExit должен эмитить tabs:changed синхронно с обнулением sessionId',
  );
  // sessionId уже null К МОМЕНТУ этого tabs:changed — гипотетический sync,
  // подписанный на событие, увидел бы актуальное (обнулённое) состояние.
  assert.strictEqual(mgr.list().find((t) => t.tabId === a.tabId).sessionId, null);
});

test('spawn: унаследованные CLAUDE_CODE_*/CLAUDECODE вычищены из env pty — кокпит, запущенный из-под другого Claude Code, не должен передавать вкладке чужую сессию', () => {
  const originalChildSession = process.env.CLAUDE_CODE_CHILD_SESSION;
  const originalClaudecode = process.env.CLAUDECODE;
  try {
    process.env.CLAUDE_CODE_CHILD_SESSION = '1';
    process.env.CLAUDECODE = '1';
    const factory = makeFakePtyFactory();
    const { mgr } = makeManager(factory);
    const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
    mgr.start(a.tabId, 80, 24);
    const env = factory.spawned[0].opts.env;
    assert.strictEqual('CLAUDE_CODE_CHILD_SESSION' in env, false);
    assert.strictEqual('CLAUDECODE' in env, false);
    assert.strictEqual(env.COCKPIT_TAB_ID, a.tabId);
  } finally {
    if (originalChildSession === undefined) delete process.env.CLAUDE_CODE_CHILD_SESSION;
    else process.env.CLAUDE_CODE_CHILD_SESSION = originalChildSession;
    if (originalClaudecode === undefined) delete process.env.CLAUDECODE;
    else process.env.CLAUDECODE = originalClaudecode;
  }
});

// ---------- Мягкая деградация провала резюма (спека §6) ----------
// Фантомная сессия: SessionStart отдал id, но транскрипт так и не создался
// (claude был закрыт до первого сообщения) — следующий запуск резюмит
// несуществующий id, claude падает с exit 1 сразу. Раньше вкладка так и
// оставалась dead — пользователь чинил её руками (Ctrl+Shift+R). Теперь
// кокпит сам один раз перезапускает вкладку с чистыми (голыми) args.

test('провал резюма (короткоживущий процесс, SessionStart не пришёл) → авто-восстановление одной чистой попыткой, статус working', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events, tick } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha', sessionId: 'ghost-session' });
  mgr.start(a.tabId, 80, 24); // спавн #1: --resume ghost-session
  assert.deepStrictEqual(factory.spawned[0].opts.args, ['--resume', 'ghost-session']);

  tick(2000); // процесс прожил недолго — меньше порога 15с
  factory.spawned[0].opts.onExit(1); // SessionStart так и не пришёл — резюм провалился

  assert.strictEqual(factory.spawned.length, 2, 'должен произойти ровно один авто-спавн');
  assert.deepStrictEqual(
    factory.spawned[1].opts.args,
    [],
    'авто-спавн идёт БЕЗ --resume — чистая новая сессия',
  );

  const st = statusOf(events, a.tabId);
  assert.strictEqual(st.status, 'working', 'вкладка должна остаться working, а не dead');

  const notice = events.find(
    (e) => e.channel === 'term:data' && e.payload.data.includes('сессия не найдена'),
  );
  assert.ok(notice, 'должно быть term:data сообщение о фолбэке перед чистым спавном');
  assert.strictEqual(notice.payload.tabId, a.tabId);
});

// I3 (ревью финальной волны фазы 7): очередь переживала авто-респавн и
// вбрасывалась в НОВУЮ, контекстно ПУСТУЮ сессию — restart() (Ctrl+Shift+R)
// чистит очередь перед новым spawn, а этот, отдельный путь автоматического
// перезапуска (провал резюма протухшего sessionId) — не чистил. Сценарий из
// ревью: вкладка с протухшим sessionId → спавн #1 --resume DEAD → пользователь
// кладёт в очередь «удали ветку feature/x» → resume падает → авто-
// восстановление спавнит #2 с голыми args → первый Stop новой сессии
// (поколение УЖЕ корректное — гард Task 5/Important 1 тут бессилен по
// построению, событие СВОЁ, не чужое) вбрасывал бы «удали ветку feature/x»
// в процесс без единого представления об этом контексте.
test('I3: авто-восстановление чистит очередь протухшей сессии — Stop НОВОГО (доказанного) поколения не вбрасывает контекст, которого новая сессия не видела', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events, tick } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha', sessionId: 'ghost-session' });
  mgr.start(a.tabId, 80, 24); // спавн #1: --resume ghost-session

  // Пользователь кладёт промпт в очередь ДО того, как узнаёт о провале резюма.
  mgr.enqueue(a.tabId, 'удали ветку feature/x');

  tick(2000); // короткоживущий — резюм провалился (порог 15с, спека §6)
  factory.spawned[0].opts.onExit(1); // SessionStart не пришёл → авто-восстановление

  assert.strictEqual(factory.spawned.length, 2, 'авто-спавн #2 должен был произойти');

  // Очередь должна быть очищена авто-восстановлением — новая сессия ничего
  // не знает о контексте старой.
  const changed = queueChangedFor(events, a.tabId);
  assert.deepStrictEqual(
    changed[changed.length - 1].queue,
    [],
    'авто-восстановление должно было очистить очередь протухшей сессии (I3)',
  );

  // Контрольная проверка: первый Stop НОВОГО (доказанного) поколения ничего
  // не вбрасывает — очередь пуста, а не потому что gen не совпал.
  const genAfterAutoRecover = Number(factory.spawned[1].opts.env.COCKPIT_TAB_GEN);
  mgr.applyHookEvent(a.tabId, 'Stop', {}, genAfterAutoRecover);
  assert.deepStrictEqual(factory.spawned[1].written, []);
});

test('долгоживущий процесс с оверрайдом (прожил дольше 15с), умерший сам — НЕ авто-восстанавливается, остаётся dead', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events, tick } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha', sessionId: 'ghost-session' });
  mgr.start(a.tabId, 80, 24); // спавн #1: --resume ghost-session

  tick(60000); // прожил долго — дольше порога
  factory.spawned[0].opts.onExit(1);

  assert.strictEqual(
    factory.spawned.length,
    1,
    'долгоживущий процесс не должен триггерить авто-восстановление',
  );
  assert.strictEqual(statusOf(events, a.tabId).status, 'dead');
});

test('авто-восстановление срабатывает не более одного раза на вкладку — без петли', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events, tick } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha', sessionId: 'ghost-session' });
  mgr.start(a.tabId, 80, 24); // спавн #1: --resume ghost-session

  tick(2000);
  factory.spawned[0].opts.onExit(1); // провал → авто-спавн #2
  assert.strictEqual(factory.spawned.length, 2);

  tick(2000);
  factory.spawned[1].opts.onExit(1); // авто-спавн #2 тоже умирает быстро

  assert.strictEqual(
    factory.spawned.length,
    2,
    'третьего (авто-)спавна быть не должно — одна попытка на вкладку',
  );
  assert.strictEqual(statusOf(events, a.tabId).status, 'dead');
});

test('успешная привязка сессии и/или ручной restart() сбрасывают флаг — авто-восстановление может сработать снова', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events, tick } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha', sessionId: 'ghost-session' });
  mgr.start(a.tabId, 80, 24); // спавн #1: --resume ghost-session

  tick(2000);
  factory.spawned[0].opts.onExit(1); // провал → авто-спавн #2 (флаг взведён)
  assert.strictEqual(factory.spawned.length, 2);
  assert.deepStrictEqual(factory.spawned[1].opts.args, []);

  // Авто-спавн #2 прижился по-настоящему: SessionStart реально привязал сессию.
  mgr.applyHookEvent(a.tabId, 'SessionStart', { session_id: 'sess-real' });

  // Ручной рестарт резюмит уже привязанную сессию (спавн #3, снова с оверрайдом).
  mgr.restart(a.tabId);
  assert.strictEqual(factory.spawned.length, 3);
  assert.deepStrictEqual(factory.spawned[2].opts.args, ['--resume', 'sess-real']);

  // Этот резюм тоже проваливается быстро без SessionStart — раз флаг был
  // сброшен (успешной привязкой и/или ручным restart()), авто-восстановление
  // должно сработать СНОВА, а не молчать из-за «уже использованной» попытки.
  tick(2000);
  factory.spawned[2].opts.onExit(1);

  assert.strictEqual(
    factory.spawned.length,
    4,
    'авто-восстановление должно снова сработать после сброса флага',
  );
  assert.deepStrictEqual(factory.spawned[3].opts.args, []);
  assert.strictEqual(statusOf(events, a.tabId).status, 'working');
});

test('ручной restart() САМ ПО СЕБЕ сбрасывает autoRecovered — без единого bindSession/SessionStart за весь тест', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events, tick } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha', sessionId: 'ghost-session' });
  mgr.start(a.tabId, 80, 24); // спавн #1: --resume ghost-session

  tick(2000);
  factory.spawned[0].opts.onExit(1); // провал → авто-спавн #2 (autoRecovered=true, overrideFailed=true)
  assert.strictEqual(factory.spawned.length, 2);
  assert.deepStrictEqual(factory.spawned[1].opts.args, []);

  // Ручной рестарт БЕЗ какой-либо привязки сессии: tab.overrideFailed всё ещё
  // true (никто его не снимал через SessionStart) — restart() уходит в ветку
  // «голые args» и попутно сбрасывает и overrideFailed, и autoRecovered.
  mgr.restart(a.tabId); // спавн #3: голые args (overrideFailed=true → сброс)
  assert.strictEqual(factory.spawned.length, 3);
  assert.deepStrictEqual(factory.spawned[2].opts.args, []);

  // Второй ручной рестарт подряд: overrideFailed теперь false (сброшен выше),
  // sessionId по-прежнему не известен — restart() уходит в ветку голого
  // --resume (пикер), это снова оверрайд.
  mgr.restart(a.tabId); // спавн #4: голый --resume (пикер)
  assert.strictEqual(factory.spawned.length, 4);
  assert.deepStrictEqual(factory.spawned[3].opts.args, ['--resume']);

  // Этот пикер тоже проваливается быстро — SessionStart за весь тест НИ РАЗУ
  // не звался, значит единственный, кто мог снять autoRecovered к этому
  // моменту, — сам restart() выше (а не успешная привязка сессии). Если бы
  // restart() не сбрасывал флаг сам по себе, эта попытка молчала бы (флаг
  // всё ещё true с самого первого провала), и пятого спавна не было бы.
  tick(2000);
  factory.spawned[3].opts.onExit(1);

  assert.strictEqual(
    factory.spawned.length,
    5,
    'restart() один сбросил autoRecovered — авто-восстановление сработало снова без единого SessionStart',
  );
  assert.deepStrictEqual(factory.spawned[4].opts.args, []);
  assert.strictEqual(statusOf(events, a.tabId).status, 'working');
});

// ---------- Phase 7 Task 1: очередь промптов ----------

const queueChangedFor = (events, tabId) => events
  .filter((e) => e.channel === 'queue:changed' && e.payload.tabId === tabId)
  .map((e) => e.payload);

test('enqueue добавляет текст в конец очереди и эмитит queue:changed', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.enqueue(a.tabId, 'первый промпт');
  mgr.enqueue(a.tabId, 'второй промпт');
  const changed = queueChangedFor(events, a.tabId);
  assert.strictEqual(changed.length, 2);
  assert.deepStrictEqual(changed[1].queue, ['первый промпт', 'второй промпт']);
});

test('enqueue игнорирует пустой/пробельный текст — очередь не меняется, событие не эмитится', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.enqueue(a.tabId, '');
  mgr.enqueue(a.tabId, '   ');
  mgr.enqueue(a.tabId, '\t\n');
  assert.strictEqual(queueChangedFor(events, a.tabId).length, 0);
});

// M2 (ревью финальной волны фазы 7): enqueue кладёт текст КАК ЕСТЬ, путь
// рецептов (app.js/runRecipe) прогоняет текст через normalizeForPty ПЕРЕД
// записью в pty — два пути должны быть захардены одинаково: внутренний
// перенос строки в тексте очереди ушёл бы отдельным Enter в момент вброса
// (injectQueuedOnStop пишет `${text}\r` одной командой) точно так же, как
// это уже было починено у рецептов (Minor 8, ревью раунд 1).
test('enqueue нормализует текст через normalizeForPty (M2) — многострочный текст приходит в pty ОДНОЙ строкой при вбросе', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  const gen = Number(factory.spawned[0].opts.env.COCKPIT_TAB_GEN);
  mgr.enqueue(a.tabId, 'первая строка\nвторая строка\r\nтретья');
  const changed = queueChangedFor(events, a.tabId);
  assert.deepStrictEqual(changed[changed.length - 1].queue, ['первая строка вторая строка третья']);
  mgr.applyHookEvent(a.tabId, 'Stop', {}, gen);
  assert.deepStrictEqual(factory.spawned[0].written, ['первая строка вторая строка третья\r']);
});

test('removeFromQueue убирает элемент по индексу и эмитит queue:changed', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.enqueue(a.tabId, 'a');
  mgr.enqueue(a.tabId, 'b');
  mgr.enqueue(a.tabId, 'c');
  mgr.removeFromQueue(a.tabId, 1);
  const changed = queueChangedFor(events, a.tabId);
  assert.deepStrictEqual(changed[changed.length - 1].queue, ['a', 'c']);
});

test('removeFromQueue с некорректным индексом — no-op, событие не эмитится', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.enqueue(a.tabId, 'a');
  const before = queueChangedFor(events, a.tabId).length;
  mgr.removeFromQueue(a.tabId, 5);
  mgr.removeFromQueue(a.tabId, -1);
  assert.strictEqual(queueChangedFor(events, a.tabId).length, before);
});

test('clearQueue опустошает очередь и эмитит queue:changed с пустым массивом', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.enqueue(a.tabId, 'a');
  mgr.enqueue(a.tabId, 'b');
  mgr.clearQueue(a.tabId);
  const changed = queueChangedFor(events, a.tabId);
  assert.deepStrictEqual(changed[changed.length - 1].queue, []);
});

test('clearQueue на уже пустой очереди — no-op, лишнего события нет', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.clearQueue(a.tabId);
  assert.strictEqual(queueChangedFor(events, a.tabId).length, 0);
});

test('dequeueAll возвращает всю очередь и опустошает её, эмитит queue:changed', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.enqueue(a.tabId, 'a');
  mgr.enqueue(a.tabId, 'b');
  const drained = mgr.dequeueAll(a.tabId);
  assert.deepStrictEqual(drained, ['a', 'b']);
  const changed = queueChangedFor(events, a.tabId);
  assert.deepStrictEqual(changed[changed.length - 1].queue, []);
});

// I4 (ревью финальной волны фазы 7): injectQueuedOnStop требует ДОКАЗАННОГО
// поколения (см. applyHookEvent в sessions.js) — все тесты ниже, где Stop
// ДОЛЖЕН реально вбросить элемент очереди, теперь передают ТЕКУЩИЙ (доказанный)
// gen явно, тем же приёмом, что и гард-тесты Task 5 (COCKPIT_TAB_GEN из
// env спавна). Это не искусственная подгонка под фикс: в проде hook-bridge.js
// ВСЕГДА получает такой gen для кокпит-вкладки (COCKPIT_TAB_GEN есть у любого
// pty, которое спавнит сам sessions.js) — тесты просто перестали занижать
// требования к самим себе, изображая маршрут «без gen вообще», которым Stop
// СВОЕЙ ЖЕ вкладки в реальности никогда не приходит.

test('Stop вбрасывает ПЕРВЫЙ элемент очереди в pty (text + \\r) и укорачивает очередь; статус не подделывается', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  const gen = Number(factory.spawned[0].opts.env.COCKPIT_TAB_GEN);
  mgr.enqueue(a.tabId, 'первый');
  mgr.enqueue(a.tabId, 'второй');
  mgr.applyHookEvent(a.tabId, 'Stop', {}, gen);
  assert.deepStrictEqual(factory.spawned[0].written, ['первый\r']);
  const changed = queueChangedFor(events, a.tabId);
  assert.deepStrictEqual(changed[changed.length - 1].queue, ['второй']);
  // Статус остаётся 'done' от самого Stop — вброс НЕ подделывает 'working',
  // это придёт следующим хуком (UserPromptSubmit/PreToolUse) от реального CLI.
  assert.strictEqual(statusOf(events, a.tabId).status, 'done');
});

// ---------- I3 (ревью финальной волны фазы 8, шов с фазой 7): holdQueueFor ----------
// Вкладка, которая ждёт сброса ночного лимита (в pending night-watch.js), не
// должна получать очередной элемент очереди на КАЖДЫЙ Stop — CLI на
// исчерпанном лимите отбивает вброс мгновенно, следующий Stop вбрасывает
// СЛЕДУЮЩИЙ элемент, и вся очередь сгорает в стену за секунды до самого
// пробуждения.

test('holdQueueFor(tabId)===true → Stop НЕ вбрасывает элемент очереди, очередь остаётся цела', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory, { holdQueueFor: () => true });
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  const gen = Number(factory.spawned[0].opts.env.COCKPIT_TAB_GEN);
  mgr.enqueue(a.tabId, 'первый');
  mgr.enqueue(a.tabId, 'второй');

  const queueChangedBeforeStop = queueChangedFor(events, a.tabId).length; // 2 — по одному на каждый enqueue()

  mgr.applyHookEvent(a.tabId, 'Stop', {}, gen);

  assert.deepStrictEqual(factory.spawned[0].written, [], 'вброс НЕ должен был произойти — вкладка удержана предикатом');
  const changed = queueChangedFor(events, a.tabId);
  assert.strictEqual(changed.length, queueChangedBeforeStop, 'Stop не должен был эмитить ЕЩЁ queue:changed — вброса не было вовсе');
  assert.deepStrictEqual(changed[changed.length - 1].queue, ['первый', 'второй'], 'очередь цела — ни один элемент не снят');
  // Статус ВСЁ РАВНО двигается в 'done' — held гейтит только вброс очереди,
  // не сам переход статуса (тот же принцип, что genProven чуть выше).
  assert.strictEqual(statusOf(events, a.tabId).status, 'done');
});

test('holdQueueFor(tabId)===false → Stop вбрасывает как обычно (предикат передан, но не удерживает)', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory, { holdQueueFor: () => false });
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  const gen = Number(factory.spawned[0].opts.env.COCKPIT_TAB_GEN);
  mgr.enqueue(a.tabId, 'первый');

  mgr.applyHookEvent(a.tabId, 'Stop', {}, gen);

  assert.deepStrictEqual(factory.spawned[0].written, ['первый\r']);
  assert.deepStrictEqual(queueChangedFor(events, a.tabId).pop().queue, []);
});

test('holdQueueFor не передан (по умолчанию null) — поведение прежнее, вброс происходит', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory); // без holdQueueFor вовсе
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  const gen = Number(factory.spawned[0].opts.env.COCKPIT_TAB_GEN);
  mgr.enqueue(a.tabId, 'первый');

  mgr.applyHookEvent(a.tabId, 'Stop', {}, gen);

  assert.deepStrictEqual(factory.spawned[0].written, ['первый\r']);
  assert.deepStrictEqual(queueChangedFor(events, a.tabId).pop().queue, []);
});

test('holdQueueFor(tabId)===true, но genProven===false (недоказанное поколение) — предикат вообще не должен вызываться, вброса и так не было бы', () => {
  const factory = makeFakePtyFactory();
  let calls = 0;
  const { mgr, events } = makeManager(factory, { holdQueueFor: () => { calls += 1; return true; } });
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  mgr.enqueue(a.tabId, 'первый');

  mgr.applyHookEvent(a.tabId, 'Stop', {}); // gen не передан — недоказанное поколение

  assert.strictEqual(calls, 0, 'holdQueueFor не должен зваться, если genProven уже false');
  assert.deepStrictEqual(factory.spawned[0].written, []);
  assert.strictEqual(statusOf(events, a.tabId).status, 'done');
});

test('Stop при пустой очереди ничего не пишет в pty и не эмитит queue:changed', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  const gen = Number(factory.spawned[0].opts.env.COCKPIT_TAB_GEN);
  mgr.applyHookEvent(a.tabId, 'Stop', {}, gen);
  assert.deepStrictEqual(factory.spawned[0].written, []);
  assert.strictEqual(queueChangedFor(events, a.tabId).length, 0);
});

test('Stop не вбрасывает, если pty мёртв — очередь не трогается (текст не теряется)', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  const gen = Number(factory.spawned[0].opts.env.COCKPIT_TAB_GEN);
  mgr.enqueue(a.tabId, 'висит в очереди');
  factory.spawned[0].opts.onExit(0); // proc умирает — tab.proc становится null (gen не меняется — обычная смерть, не авто-восстановление)
  const before = queueChangedFor(events, a.tabId).length;
  mgr.applyHookEvent(a.tabId, 'Stop', {}, gen); // хук всё равно долетел уже после смерти pty
  assert.deepStrictEqual(factory.spawned[0].written, []);
  assert.strictEqual(queueChangedFor(events, a.tabId).length, before);
});

test('несколько Stop подряд вбрасывают элементы очереди строго по одному за раз', () => {
  const factory = makeFakePtyFactory();
  const { mgr } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  const gen = Number(factory.spawned[0].opts.env.COCKPIT_TAB_GEN);
  mgr.enqueue(a.tabId, 'one');
  mgr.enqueue(a.tabId, 'two');
  mgr.enqueue(a.tabId, 'three');
  mgr.applyHookEvent(a.tabId, 'Stop', {}, gen);
  assert.deepStrictEqual(factory.spawned[0].written, ['one\r']);
  mgr.applyHookEvent(a.tabId, 'Stop', {}, gen);
  assert.deepStrictEqual(factory.spawned[0].written, ['one\r', 'two\r']);
  mgr.applyHookEvent(a.tabId, 'Stop', {}, gen);
  assert.deepStrictEqual(factory.spawned[0].written, ['one\r', 'two\r', 'three\r']);
  // Очередь исчерпана — четвёртый Stop подряд больше ничего не пишет.
  mgr.applyHookEvent(a.tabId, 'Stop', {}, gen);
  assert.deepStrictEqual(factory.spawned[0].written, ['one\r', 'two\r', 'three\r']);
});

test('close чистит очередь вкладки (queue:changed с пустым массивом до удаления)', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.enqueue(a.tabId, 'x');
  mgr.close(a.tabId);
  const changed = queueChangedFor(events, a.tabId);
  assert.deepStrictEqual(changed[changed.length - 1].queue, []);
});

test('restart чистит очередь вкладки — новая сессия не наследует чужой недоотправленный ввод', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  mgr.enqueue(a.tabId, 'x');
  mgr.restart(a.tabId);
  const changed = queueChangedFor(events, a.tabId);
  assert.deepStrictEqual(changed[changed.length - 1].queue, []);
  // Подтверждаем и функционально: следующий Stop НОВОГО (доказанного)
  // поколения ничего больше не вбрасывает — очередь пуста именно потому, что
  // restart() её почистил, а НЕ потому, что gen не совпал (I4: без явного
  // текущего gen здесь эта проверка была бы неспособна заметить регрессию,
  // если бы clearQueue() внутри restart() вдруг сломался, — assert остался
  // бы «случайно зелёным» по ДРУГОЙ причине).
  const genAfterRestart = Number(factory.spawned[1].opts.env.COCKPIT_TAB_GEN);
  mgr.applyHookEvent(a.tabId, 'Stop', {}, genAfterRestart);
  assert.deepStrictEqual(factory.spawned[1].written, []);
});

// ---------- Доп. находка ревью Task 1 фазы 7 (задача 5): гард поколения хук-событий ----------
// Маршрутизация хуков (hook-bridge.js) раньше не была привязана к поколению
// pty — опоздавший Stop уже убитого/перезапущенного процесса мог долететь
// ПОСЛЕ того, как в этой же вкладке поднялась новая сессия, и произвести
// побочный эффект (вброс очереди промптов) уже в чужом, свежем поколении.
// gen каждого спавна виден тестам через env.COCKPIT_TAB_GEN — тот же канал,
// которым в проде реальный cockpit-hook.js получает его и кладёт в payload,
// а hook-bridge.js прокидывает в applyHookEvent() (см. sessions.js/spawn()).

test('applyHookEvent с устаревшим (не текущим) поколением игнорируется ЦЕЛИКОМ — опоздавший Stop убитого рестартом процесса не вбрасывает чужой элемент очереди в новую сессию и не трогает статус', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24); // спавн #1 — старое поколение
  const staleGen = Number(factory.spawned[0].opts.env.COCKPIT_TAB_GEN);

  mgr.restart(a.tabId); // спавн #2 — новое поколение (restart уже почистил очередь сам)
  const currentGen = Number(factory.spawned[1].opts.env.COCKPIT_TAB_GEN);
  assert.notStrictEqual(staleGen, currentGen, 'restart() должен был сменить поколение вкладки');

  // Новая сессия получает СВОЙ собственный элемент очереди.
  mgr.enqueue(a.tabId, 'для новой сессии');
  const statusBefore = statusOf(events, a.tabId);

  // Опоздавший Stop убитого спавна #1 долетает только сейчас, помеченный
  // СВОИМ (устаревшим) поколением — не должен произвести НИКАКОГО побочного
  // эффекта в текущем состоянии вкладки: ни вброса очереди, ни смены статуса.
  mgr.applyHookEvent(a.tabId, 'Stop', {}, staleGen);
  assert.deepStrictEqual(factory.spawned[1].written, [], 'опоздавший Stop не должен был писать в НОВЫЙ pty');
  const changedAfterStale = queueChangedFor(events, a.tabId);
  assert.deepStrictEqual(
    changedAfterStale[changedAfterStale.length - 1].queue,
    ['для новой сессии'],
    'очередь новой сессии не должна была тронуться устаревшим событием',
  );
  assert.deepStrictEqual(statusOf(events, a.tabId), statusBefore, 'статус не должен был измениться устаревшим событием');

  // Контрольная проверка: Stop с ПРАВИЛЬНЫМ (текущим) поколением по-прежнему
  // работает как обычно — гард не сломал обычный путь, отсекает именно
  // устаревшие события.
  mgr.applyHookEvent(a.tabId, 'Stop', {}, currentGen);
  assert.deepStrictEqual(factory.spawned[1].written, ['для новой сессии\r']);
});

// I4 (ревью финальной волны фазы 7): этот тест ДО фикса I4 фиксировал дыру
// как ожидаемое поведение — утверждал, что Stop без gen (сторонняя claude-
// сессия вне кокпита, найденная мостом по session_id — см. hook-bridge.js —
// либо гипотетический старый хук-скрипт) вбрасывает очередь как обычно. Это
// и было находкой I4: сторонняя сессия НЕ должна иметь возможность писать в
// pty чужой (кокпитной) вкладки, даже если статусы ей двигать можно
// (заявленная фича port-file). Переписан: статус применяется, вброса нет.
test('applyHookEvent: gen не передан (I4 — сторонняя сессия/старый хук-скрипт БЕЗ доказанного поколения) — статус применяется как обычно, но вброс очереди НЕ происходит', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  mgr.enqueue(a.tabId, 'текст');
  mgr.applyHookEvent(a.tabId, 'Stop', {}); // gen не передан вовсе — недоказанное поколение
  // Статус НЕ заблокирован — недоказанное поколение не значит «чужое», это
  // ЗАЯВЛЕННАЯ фича port-file (сторонние claude-сессии тоже двигают статус
  // вкладки, которой принадлежит их session_id).
  assert.strictEqual(statusOf(events, a.tabId).status, 'done');
  // НО живой побочный эффект (запись в pty) требует ДОКАЗАННОГО поколения —
  // недоказанное (gen:null) не даёт права писать в pty ЭТОЙ вкладки: иначе
  // Stop СТОРОННЕГО процесса той же сессии мог бы вбросить чужой элемент
  // очереди в pty вкладки кокпита (I4, сценарий ревью).
  assert.deepStrictEqual(factory.spawned[0].written, []);
  // Очередь остаётся нетронутой — текст не потерян, ждёт следующего
  // ДОКАЗАННОГО (своего) Stop.
  const changed = queueChangedFor(events, a.tabId);
  assert.deepStrictEqual(changed[changed.length - 1].queue, ['текст']);
});

// ---------- Important 1 (ревью Task 2 фазы 8, «Ночная смена»): genProven в payload 'tab:status' ----------
// Ночная смена (main/ipc.js) детектит остановку по лимиту на переходе
// working→done, беря сигнал из 'tab:status' — она НЕ имеет доступа к
// gen/tab.gen напрямую (это внутреннее состояние sessions.js). Без genProven
// в payload обвязка не могла бы отличить «наша собственная вкладка
// действительно встала» от «сторонний процесс той же сессии просто закончил
// СВОЮ задачу» (I4 — маршрутизация по session_id без COCKPIT_TAB_GEN,
// заявленная фича port-file). genProven — тот же флаг, что уже гейтит
// injectQueuedOnStop, теперь виден и снаружи функции.

test('Stop с ДОКАЗАННЫМ (текущим) поколением → tab:status несёт genProven:true', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  const gen = Number(factory.spawned[0].opts.env.COCKPIT_TAB_GEN);
  mgr.applyHookEvent(a.tabId, 'Stop', {}, gen);
  const st = statusOf(events, a.tabId);
  assert.strictEqual(st.status, 'done');
  assert.strictEqual(st.genProven, true);
});

test('Stop от session_id-маршрута БЕЗ доказанного поколения (I4 — сторонний процесс) → статус двигается, но genProven:false', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  mgr.applyHookEvent(a.tabId, 'Stop', {}); // gen не передан вовсе — недоказанное поколение
  const st = statusOf(events, a.tabId);
  assert.strictEqual(st.status, 'done', 'статус ДОЛЖЕН двигаться — заявленная фича port-file');
  assert.strictEqual(st.genProven, false, 'но флаг доказанности обязан быть ложным — ночная смена не должна детектить это как «свою» остановку');
});

test('Stop с УСТАРЕВШИМ (не текущим) поколением → событие отбрасывается ЦЕЛИКОМ, genProven не при чём (событие не приходит вовсе)', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  const staleGen = Number(factory.spawned[0].opts.env.COCKPIT_TAB_GEN);
  mgr.restart(a.tabId);
  const before = statusOf(events, a.tabId);
  mgr.applyHookEvent(a.tabId, 'Stop', {}, staleGen); // чужое (устаревшее) поколение — гард отсекает ВСЁ событие
  assert.deepStrictEqual(statusOf(events, a.tabId), before, 'устаревшее поколение не должно было произвести вообще никакого tab:status');
});

test('остальные ветки applyHookEvent (SessionStart/PreToolUse/UserPromptSubmit) НЕ получают genProven в payload — форма события не изменилась', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  mgr.applyHookEvent(a.tabId, 'SessionStart', { session_id: 'sess-1' });
  assert.ok(!Object.prototype.hasOwnProperty.call(statusOf(events, a.tabId), 'genProven'));
  mgr.applyHookEvent(a.tabId, 'PreToolUse', { tool_name: 'Bash' });
  assert.ok(!Object.prototype.hasOwnProperty.call(statusOf(events, a.tabId), 'genProven'));
  mgr.applyHookEvent(a.tabId, 'UserPromptSubmit', {});
  assert.ok(!Object.prototype.hasOwnProperty.call(statusOf(events, a.tabId), 'genProven'));
});

// ---------- Important 1 (ревью раунд 1, обязательная правка): gen должен быть глобальным, а не по вкладке ----------

test('genSeq глобален: первые спавны РАЗНЫХ вкладок получают РАЗНЫЕ поколения, а не одинаковый gen:1 у каждой', () => {
  const factory = makeFakePtyFactory();
  const { mgr } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  const b = mgr.open({ cwd: 'C:\\proj\\beta' });
  mgr.start(a.tabId, 80, 24); // первый спавн A
  mgr.start(b.tabId, 80, 24); // первый спавн B
  const genA = Number(factory.spawned[0].opts.env.COCKPIT_TAB_GEN);
  const genB = Number(factory.spawned[1].opts.env.COCKPIT_TAB_GEN);
  assert.notStrictEqual(genA, genB, 'до фикса Important 1 оба были бы gen:1 (счётчик по вкладке, а не по менеджеру)');
});

test('Important 1: закрытая вкладка A и НОВАЯ вкладка B с ТОЙ ЖЕ сессией не делят совпадающий gen — опоздавший Stop вкладки A (маршрутизированный по session_id уже в B) не производит побочного эффекта в B', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);

  // Вкладка A: спавн #1, SessionStart привязывает сессию 'S'.
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  const staleGenFromA = Number(factory.spawned[0].opts.env.COCKPIT_TAB_GEN);
  mgr.applyHookEvent(a.tabId, 'SessionStart', { session_id: 'S' });

  // Пользователь закрывает A ровно в момент, когда её Stop-хук уже запущен,
  // но POST ещё не долетел до моста — close() удаляет вкладку из tabs.
  mgr.close(a.tabId);

  // Открывается НОВАЯ вкладка B с ТОЙ ЖЕ сессией 'S' (Ctrl+Shift+H/«Открыть
  // воркспейс»). До фикса её первый спавн ТОЖЕ получил бы gen:1 (счётчик по
  // вкладке начинался бы с нуля заново) — ровно та коллизия, которую чинит
  // Important 1.
  const b = mgr.open({ cwd: 'C:\\proj\\beta', sessionId: 'S' });
  mgr.start(b.tabId, 80, 24);
  const bSpawnIndex = factory.spawned.length - 1;
  const currentGenOfB = Number(factory.spawned[bSpawnIndex].opts.env.COCKPIT_TAB_GEN);
  assert.notStrictEqual(
    currentGenOfB,
    staleGenFromA,
    'поколения РАЗНЫХ вкладок не должны совпадать даже после закрытия одной из них',
  );

  // Новая сессия B получает СВОЙ собственный элемент очереди.
  mgr.enqueue(b.tabId, 'для B');
  const statusBeforeStale = statusOf(events, b.tabId);

  // Опоздавший Stop вкладки A мосту уже неизвестен по tabId (A удалена из
  // tabs), маршрутизируется по session_id 'S' — а на неё теперь отвечает B
  // (findBySessionId в hook-bridge.js). Эмулируем результат этой маршрутизации
  // напрямую: applyHookEvent для tabId B, но со СТАРЫМ (устаревшим) gen'ом A.
  mgr.applyHookEvent(b.tabId, 'Stop', {}, staleGenFromA);
  assert.deepStrictEqual(
    factory.spawned[bSpawnIndex].written,
    [],
    'опоздавший Stop вкладки A не должен был писать в pty вкладки B',
  );
  assert.deepStrictEqual(
    statusOf(events, b.tabId),
    statusBeforeStale,
    'статус B не должен был измениться опоздавшим событием A',
  );

  // Контрольная проверка: Stop с ПРАВИЛЬНЫМ (текущим) поколением B по-прежнему
  // работает как обычно — гард не сломан, отсекает именно чужие поколения.
  mgr.applyHookEvent(b.tabId, 'Stop', {}, currentGenOfB);
  assert.deepStrictEqual(factory.spawned[bSpawnIndex].written, ['для B\r']);
});

// Minor 5 (ревью раунд 1): отдельный тест "gen ТЕКУЩЕГО поколения применяется
// как обычно" отсюда убран — он дублировал контрольный шаг в конце теста
// «applyHookEvent с устаревшим... поколением игнорируется ЦЕЛИКОМ» выше
// (строки 1019-1023: applyHookEvent с currentGen после restart() и проверка,
// что вброс всё же произошёл) — тот же случай «текущий gen работает как
// обычно», без собственного отдельного режима падения.

test('spawn: env несёт COCKPIT_TAB_GEN как строку текущего поколения, растущего с каждым спавном', () => {
  const factory = makeFakePtyFactory();
  const { mgr } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24); // спавн #1
  mgr.restart(a.tabId); // спавн #2
  const gen1 = Number(factory.spawned[0].opts.env.COCKPIT_TAB_GEN);
  const gen2 = Number(factory.spawned[1].opts.env.COCKPIT_TAB_GEN);
  assert.ok(Number.isInteger(gen1) && gen1 > 0);
  assert.ok(Number.isInteger(gen2) && gen2 > gen1, 'поколение второго спавна должно быть строго больше первого');
});

// ---------- N2 (ре-ревью финальной волны): notification_type первым сигналом + липкий permission ----------

test('N2: notification_type "idle_prompt" даёт idle даже при НЕЗНАКОМОМ тексте (локализация не ломает C1)', () => {
  const factory = makeFakePtyFactory();
  const { mgr } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\proj\alpha' });
  mgr.start(a.tabId, 80, 24);
  mgr.applyHookEvent(a.tabId, 'Notification', {
    message: 'Клод ждёт вашего ввода', notification_type: 'idle_prompt',
  });
  const tab = mgr.list().find((t) => t.tabId === a.tabId);
  assert.strictEqual(tab.waitingKind, 'idle');
});

test('N2: notification_type "permission_prompt" побеждает idle-похожий текст', () => {
  const factory = makeFakePtyFactory();
  const { mgr } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\proj\alpha' });
  mgr.start(a.tabId, 80, 24);
  mgr.applyHookEvent(a.tabId, 'Notification', {
    message: 'waiting for your input to approve Bash', notification_type: 'permission_prompt',
  });
  const tab = mgr.list().find((t) => t.tabId === a.tabId);
  assert.strictEqual(tab.waitingKind, 'permission');
});

test('N2: липкий permission — idle-пинг ПОВЕРХ открытого диалога не понижает waitingKind', () => {
  const factory = makeFakePtyFactory();
  const { mgr } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\proj\alpha' });
  mgr.start(a.tabId, 80, 24);
  mgr.applyHookEvent(a.tabId, 'Notification', { message: 'Claude needs your permission to use Bash' });
  // Диалог всё ещё открыт (статус waiting), прилетает idle-пинг:
  mgr.applyHookEvent(a.tabId, 'Notification', {
    message: 'Claude is waiting for your input', notification_type: 'idle_prompt',
  });
  const tab = mgr.list().find((t) => t.tabId === a.tabId);
  assert.strictEqual(tab.waitingKind, 'permission', 'ночное «продолжай» не должно уметь попасть в диалог');
});

test('N2: после ВЫХОДА из waiting понижение разрешено — новый idle после working даёт idle', () => {
  const factory = makeFakePtyFactory();
  const { mgr } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\proj\alpha' });
  mgr.start(a.tabId, 80, 24);
  mgr.applyHookEvent(a.tabId, 'Notification', { message: 'Claude needs your permission to use Bash' });
  mgr.applyHookEvent(a.tabId, 'UserPromptSubmit', {}); // пользователь ответил, вкладка снова работает
  mgr.applyHookEvent(a.tabId, 'Notification', {
    message: 'Claude is waiting for your input', notification_type: 'idle_prompt',
  });
  const tab = mgr.list().find((t) => t.tabId === a.tabId);
  assert.strictEqual(tab.waitingKind, 'idle');
});

// ---------- «Название» сессии в сайдбаре (живая приёмка 01.08) ----------
// Пользователь: «в одной папке может быть несколько сессий, чтобы их
// различить». Источник — ГОТОВОЕ поле session_title из payload хуков
// (сверено с бинарём CLI 2.1.220: оно есть у SessionStart и UserPromptSubmit),
// фолбэк — текст первого промпта, пока CLI ещё не сгенерировал заголовок.

test('sessionLabel: SessionStart с session_title (случай --resume) подписывает вкладку сразу', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\proj\alpha' });
  mgr.start(a.tabId, 80, 24);

  mgr.applyHookEvent(a.tabId, 'SessionStart', {
    session_id: 'S1', session_title: 'Рефакторинг платёжного модуля',
  });

  assert.strictEqual(statusOf(events, a.tabId).sessionLabel, 'Рефакторинг платёжного модуля');
});

test('sessionLabel: пока session_title пуст — фолбэк на текст первого промпта', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\proj\alpha' });
  mgr.start(a.tabId, 80, 24);

  mgr.applyHookEvent(a.tabId, 'SessionStart', { session_id: 'S1' }); // заголовка ещё нет
  mgr.applyHookEvent(a.tabId, 'UserPromptSubmit', { prompt: 'почини тесты в модуле оплаты' });

  assert.strictEqual(statusOf(events, a.tabId).sessionLabel, 'почини тесты в модуле оплаты');
});

test('sessionLabel: настоящий session_title ПЕРЕБИВАЕТ фолбэк-промпт, когда наконец приходит', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\proj\alpha' });
  mgr.start(a.tabId, 80, 24);

  mgr.applyHookEvent(a.tabId, 'UserPromptSubmit', { prompt: 'почини тесты' });
  assert.strictEqual(statusOf(events, a.tabId).sessionLabel, 'почини тесты');

  mgr.applyHookEvent(a.tabId, 'UserPromptSubmit', {
    prompt: 'а теперь прогони линтер', session_title: 'Починка тестов оплаты',
  });
  assert.strictEqual(statusOf(events, a.tabId).sessionLabel, 'Починка тестов оплаты');
});

test('sessionLabel: второй промпт НЕ перезаписывает фолбэк (метка стабильна)', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\proj\alpha' });
  mgr.start(a.tabId, 80, 24);

  mgr.applyHookEvent(a.tabId, 'UserPromptSubmit', { prompt: 'первый промпт' });
  mgr.applyHookEvent(a.tabId, 'UserPromptSubmit', { prompt: 'второй промпт' });

  assert.strictEqual(statusOf(events, a.tabId).sessionLabel, 'первый промпт');
});

test('sessionLabel: пустой session_title НЕ затирает уже показанную метку', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\proj\alpha' });
  mgr.start(a.tabId, 80, 24);

  mgr.applyHookEvent(a.tabId, 'SessionStart', { session_id: 'S1', session_title: 'Живой заголовок' });
  mgr.applyHookEvent(a.tabId, 'UserPromptSubmit', { prompt: 'что-то', session_title: '' });

  assert.strictEqual(statusOf(events, a.tabId).sessionLabel, 'Живой заголовок');
});

test('sessionLabel: многострочный промпт схлопывается в одну строку и режется многоточием', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\proj\alpha' });
  mgr.start(a.tabId, 80, 24);

  mgr.applyHookEvent(a.tabId, 'UserPromptSubmit', {
    prompt: 'первая строка\nвторая строка   с   лишними пробелами и очень длинным хвостом до упора',
  });

  const label = statusOf(events, a.tabId).sessionLabel;
  assert.ok(!label.includes('\n'), 'переводов строк быть не должно');
  assert.ok(!/\s{2,}/.test(label), 'кратных пробелов быть не должно');
  assert.strictEqual(label.length, 48, 'ровно SESSION_LABEL_MAX символов');
  assert.ok(label.endsWith('…'), 'обрезка помечена многоточием');
});

test('sessionLabel: restart сбрасывает метку — новая жизнь вкладки, новое название', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\proj\alpha' });
  mgr.start(a.tabId, 80, 24);
  mgr.applyHookEvent(a.tabId, 'SessionStart', { session_id: 'S1', session_title: 'Старая сессия' });
  assert.strictEqual(statusOf(events, a.tabId).sessionLabel, 'Старая сессия');

  mgr.restart(a.tabId);
  mgr.applyHookEvent(a.tabId, 'SessionStart', { session_id: 'S2', session_title: 'Новая сессия' });

  assert.strictEqual(statusOf(events, a.tabId).sessionLabel, 'Новая сессия');
});

test('sessionLabel: событие без полей метки не роняет и не портит payload прочих статусов', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\proj\alpha' });
  mgr.start(a.tabId, 80, 24);

  mgr.applyHookEvent(a.tabId, 'SessionStart', { session_id: 'S1' });
  mgr.applyHookEvent(a.tabId, 'PreToolUse', { tool_name: 'Bash' });

  const st = statusOf(events, a.tabId);
  assert.strictEqual(st.status, 'working');
  assert.strictEqual(st.sessionLabel, '');
});
