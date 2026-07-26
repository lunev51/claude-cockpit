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

test('restart: НАСТОЯЩИЙ провал (спавн с оверрайдом умер естественной смертью, SessionStart не пришёл) — следующий рестарт спавнит голые args', () => {
  const factory = makeFakePtyFactory();
  const { mgr } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  mgr.restart(a.tabId); // спавн #2: голый --resume, пикер (session_id ещё не привязан)
  assert.deepStrictEqual(factory.spawned[1].opts.args, ['--resume']);
  // Естественная смерть спавна #2 (gen совпадает — это НЕ хвост убитого рестартом
  // процесса): SessionStart за время его жизни так и не пришёл (пикер брошен/провалился).
  factory.spawned[1].opts.onExit(1);
  mgr.restart(a.tabId); // спавн #3: без деградации в бесконечный цикл пикера
  assert.strictEqual(factory.spawned.length, 3);
  assert.deepStrictEqual(factory.spawned[2].opts.args, []);
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
