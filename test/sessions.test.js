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

function makeManager(factory) {
  const events = [];
  const mgr = createSessionManager({
    ptyFactory: factory,
    getTermConfig: () => ({ command: 'claude', args: [], useConpty: true, useConptyDll: true }),
    onEvent: (channel, payload) => events.push({ channel, payload }),
  });
  return { mgr, events };
}

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
  assert.strictEqual(started[0].payload.tabId, a.tabId);
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

  // pty вкладки A жив: write продолжает работать
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

test('restart: опоздавший onExit старого pty не убивает новый процесс вкладки', () => {
  const factory = makeFakePtyFactory();
  const { mgr } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  mgr.restart(a.tabId);
  assert.strictEqual(factory.spawned.length, 2);

  // Старый (уже убитый рестартом) pty шлёт onExit с опозданием.
  factory.spawned[0].opts.onExit(0);

  // Вкладка должна остаться живой с НОВЫМ процессом: write доходит до него.
  assert.strictEqual(mgr.list().find((x) => x.tabId === a.tabId).alive, true);
  mgr.write(a.tabId, 'ping');
  assert.deepStrictEqual(factory.spawned[1].written, ['ping']);
  assert.deepStrictEqual(factory.spawned[0].written, []);
});

test('restart: опоздавший onData старого pty не порождает term:data', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  mgr.restart(a.tabId);

  const countData = () => events.filter((e) => e.channel === 'term:data').length;
  const before = countData();

  // Старый (уже убитый рестартом) pty шлёт данные с опозданием — должны быть проглочены.
  factory.spawned[0].opts.onData('stale-output');
  assert.strictEqual(countData(), before);

  // Новый pty продолжает нормально слать данные.
  factory.spawned[1].opts.onData('fresh-output');
  assert.strictEqual(countData(), before + 1);
  const last = events.filter((e) => e.channel === 'term:data').pop();
  assert.deepStrictEqual(last.payload, { tabId: a.tabId, data: 'fresh-output' });
});

test('restart: опоздавший onExit старого pty не эмитит term:exit, естественный exit нового — ровно один', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  mgr.restart(a.tabId);

  const countExit = () => events.filter((e) => e.channel === 'term:exit').length;
  const before = countExit();

  // Старый (убитый рестартом) pty шлёт onExit с опозданием — событие наружу не идёт.
  factory.spawned[0].opts.onExit(0);
  assert.strictEqual(countExit(), before);

  // Естественный exit НОВОГО (текущего) процесса вкладки эмитится ровно один раз.
  factory.spawned[1].opts.onExit(0);
  assert.strictEqual(countExit(), before + 1);
  const last = events.filter((e) => e.channel === 'term:exit').pop();
  assert.deepStrictEqual(last.payload, { tabId: a.tabId, exitCode: 0 });
});

test('spawn: фабрика бросает исключение — term:data с сообщением об ошибке + term:exit(-1), tab.alive остаётся false', () => {
  const throwingFactory = () => { throw new Error('boom'); };
  const { mgr, events } = makeManager(throwingFactory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);

  const dataEvents = events.filter((e) => e.channel === 'term:data');
  assert.strictEqual(dataEvents.length, 1);
  assert.ok(dataEvents[0].payload.data.includes('не удалось запустить'));

  const exitEvents = events.filter((e) => e.channel === 'term:exit');
  assert.strictEqual(exitEvents.length, 1);
  assert.strictEqual(exitEvents[0].payload.exitCode, -1);

  assert.strictEqual(mgr.list().find((x) => x.tabId === a.tabId).alive, false);
});

test('двойной start() на одной вкладке — no-op, фабрика вызывается один раз', () => {
  const factory = makeFakePtyFactory();
  const { mgr } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  mgr.start(a.tabId, 100, 30);
  assert.strictEqual(factory.spawned.length, 1);
  assert.strictEqual(factory.spawned[0].opts.cols, 80);
  assert.strictEqual(factory.spawned[0].opts.rows, 24);
});
