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

// Найдено живой проверкой фикс-волны финального ревью (не регресс ветки —
// баг базового продукта). Гард в spare-ветке spawn() — `tab.status !== 'dead'`
// — задумывался против СИНХРОННОГО exit из самой фабрики («не воскрешаем
// только что умерший процесс»). Но статус 'dead' остаётся на вкладке и ПОСЛЕ
// естественной смерти процесса, а restart() его не сбрасывает: значит рестарт
// УЖЕ мёртвой вкладки — то есть ровно тот Ctrl+Shift+R, который сам кокпит
// печатает в терминал строкой «процесс завершён (код N) — Ctrl+Shift+R для
// перезапуска», — спавнил pty и тут же от него отрекался.
//
// Живьём (браузер, вкладка после /exit): процесс claude поднялся и печатал в
// терминал, но manager.list() отдавал alive:false, term:started не приходил,
// а term.write уходил в никуда — ввод мёртв навсегда. Хуже того, proc не
// принадлежит вкладке: close()/restart() его не убьют, и каждый следующий
// Ctrl+Shift+R добавлял бы ещё один осиротевший процесс.
test('рестарт УЖЕ мёртвой вкладки отдаёт ей новый pty (а не спавнит осиротевший процесс)', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 120, 40);
  // Естественная смерть процесса: вкладка уезжает в 'dead'.
  factory.spawned[0].opts.onExit(0);
  assert.strictEqual(statusOf(events, a.tabId).status, 'dead');
  assert.strictEqual(mgr.list()[0].alive, false);

  const startedBefore = events.filter((e) => e.channel === 'term:started').length;
  mgr.restart(a.tabId);

  assert.strictEqual(factory.spawned.length, 2, 'рестарт обязан спавнить новый pty');
  assert.strictEqual(mgr.list()[0].alive, true, 'новый pty должен принадлежать вкладке, иначе ввод мёртв, а процесс осиротел');
  assert.strictEqual(
    events.filter((e) => e.channel === 'term:started').length,
    startedBefore + 1,
    'без term:started renderer навсегда держит ввод заблокированным',
  );
  // Ввод реально доходит до НОВОГО процесса.
  mgr.write(a.tabId, 'после рестарта');
  assert.deepStrictEqual(factory.spawned[1].written, ['после рестарта']);
  // И вкладка снова управляема: закрытие убивает именно этот процесс.
  mgr.close(a.tabId);
  assert.ok(factory.spawned[1].killed, 'закрытие вкладки обязано убить её процесс, а не оставить осиротевшим');
});

// Important 1 (ре-ревью фикс-волны): собственный фикс ветки не был покрыт —
// диверсия «убрать переизлучение term:started для уже живого процесса»
// оставляла все 866 тестов зелёными, хотя живьём без неё ввод в подключённом
// терминале мёртв навсегда: terminal.js поднимает флаг alive ТОЛЬКО по этому
// событию, а живой процесс своё единственное term:started отправил задолго до
// подключения клиента.
test('повторный start на ЖИВОМ процессе переизлучает term:started с тем же pid и не спавнит второй pty', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  const pid = factory.spawned[0].pid;
  const startedBefore = events.filter((e) => e.channel === 'term:started').length;
  assert.strictEqual(startedBefore, 1);

  // Ровно то, что делает подключившийся клиент: свой initTerminal со своими
  // размерами зовёт term.start на вкладке, которая уже работает.
  mgr.start(a.tabId, 100, 40);

  assert.strictEqual(factory.spawned.length, 1, 'второй pty на живой вкладке — это и есть дублирование сессии');
  const started = events.filter((e) => e.channel === 'term:started');
  assert.strictEqual(started.length, startedBefore + 1, 'без повторного term:started подключённый терминал навсегда остаётся «запускается…» и глотает ввод');
  assert.deepStrictEqual(started[started.length - 1].payload, { tabId: a.tabId, pid });
  // Размер живого pty повторный start не трогает — согласование размеров это
  // эстафета, отдельный план (см. комментарий у start()).
  assert.strictEqual(factory.spawned[0].cols, undefined, 'resize живого pty из повторного start не вызывается');
  // И ввод по-прежнему доходит до ТОГО ЖЕ процесса.
  mgr.write(a.tabId, 'после подключения');
  assert.deepStrictEqual(factory.spawned[0].written, ['после подключения']);
});

// Important 2 (ре-ревью фикс-волны): разрушительная половина бага жила слоем
// ниже renderer-гарда. Мёртвая вкладка с ПРИВЯЗАННОЙ сессией + прямой вызов
// start() (старый закешированный renderer, будущий вызывающий, тест) давал
// спавн БЕЗ --resume — сессия терялась. restart() в том же положении резюмит.
test('start для вкладки без процесса, но с привязанной сессией, ПРОДОЛЖАЕТ её (--resume), а не заводит новую', () => {
  const factory = makeFakePtyFactory();
  const { mgr } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  mgr.bindSession(a.tabId, 'sess-живая');
  factory.spawned[0].opts.onExit(0); // процесс умер сам — вкладка мертва, сессия известна
  assert.strictEqual(mgr.list()[0].alive, false);
  assert.strictEqual(mgr.list()[0].sessionId, 'sess-живая');

  mgr.start(a.tabId, 80, 24); // прямой запуск МИМО renderer-гарда

  assert.strictEqual(factory.spawned.length, 2);
  assert.deepStrictEqual(
    factory.spawned[1].opts.args,
    ['--resume', 'sess-живая'],
    'спавн без --resume поднимает чистую сессию, а прежняя работа остаётся только в транскрипте',
  );
});

test('start НЕ подменяет решение, которое уже принял restart() (pendingExtraArgs не перетирается)', () => {
  const factory = makeFakePtyFactory();
  const { mgr } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  mgr.bindSession(a.tabId, 'sess-первая');
  // Провал резюма: спавн с оверрайдом умер, SessionStart не пришёл → sessionId
  // обнуляется, restart() сознательно уходит на голые args (не зацикливаемся).
  mgr.restart(a.tabId); // спавн #2 с --resume sess-первая
  assert.deepStrictEqual(factory.spawned[1].opts.args, ['--resume', 'sess-первая']);
});

test('start на восстановленной вкладке не дублирует --resume (флаг первого спавна остаётся за spawn())', () => {
  const factory = makeFakePtyFactory();
  const { mgr } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha', sessionId: 'sess-из-манифеста' });
  mgr.start(a.tabId, 80, 24);
  assert.deepStrictEqual(
    factory.spawned[0].opts.args,
    ['--resume', 'sess-из-манифеста'],
    'ровно один --resume, а не два подряд',
  );
});

// Обратная сторона того же гарда: синхронный exit ИЗ САМОЙ ФАБРИКИ (процесс
// умер, не успев родиться) по-прежнему не должен «воскрешать» вкладку.
test('синхронный exit из фабрики не воскрешает вкладку — гард сохраняет исходный смысл', () => {
  const events = [];
  let nowMs = 0;
  const spawned = [];
  const factory = (opts) => {
    const proc = {
      opts, written: [], killed: false, pid: 1000 + spawned.length, write() {}, resize() {}, kill() { this.killed = true; },
    };
    spawned.push(proc);
    opts.onExit(1); // умер прямо внутри фабрики, ДО возврата инстанса
    return proc;
  };
  const mgr = createSessionManager({
    ptyFactory: factory,
    getTermConfig: () => ({ command: 'claude', args: [], useConpty: true, useConptyDll: true }),
    onEvent: (channel, payload) => events.push({ channel, payload }),
    now: () => nowMs,
    stuckAfterMs: 1000,
  });
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  assert.strictEqual(mgr.list()[0].alive, false, 'умерший внутри фабрики процесс не должен считаться живым');
  assert.strictEqual(statusOf(events, a.tabId).status, 'dead');
  assert.strictEqual(events.filter((e) => e.channel === 'term:started').length, 0);
});

// Стык, который трогает правка сброса устаревшего 'dead': вкладка УЖЕ мертва,
// и новый процесс тоже умирает прямо внутри фабрики. Сброс статуса не должен
// превратиться в «воскрешение» — гард обязан сработать на смерти ЭТОГО
// спавна, а не на памяти о прошлой.
//
// Путь именно через start(), а не restart(): restart() всегда уходит с
// оверрайдом (--resume), а мертворождённый оверрайд — это штатный провал
// резюма, на который отвечает АВТО-ВОССТАНОВЛЕНИЕ (спавн чистой сессии
// немедленно, см. тесты ниже). Смешивать два механизма в одном тесте значит
// проверять не то: здесь нужен голый спавн без оверрайда.
test('запуск мёртвой вкладки, когда новый процесс умирает ПРЯМО В ФАБРИКЕ, вкладку не воскрешает', () => {
  const events = [];
  const spawned = [];
  const factory = (opts) => {
    const proc = {
      opts, written: [], killed: false, pid: 1000 + spawned.length, write() {}, resize() {}, kill() { this.killed = true; },
    };
    spawned.push(proc);
    // Первый спавн живёт, второй умирает внутри фабрики.
    if (spawned.length === 2) opts.onExit(1);
    return proc;
  };
  const mgr = createSessionManager({
    ptyFactory: factory,
    getTermConfig: () => ({ command: 'claude', args: [], useConpty: true, useConptyDll: true }),
    onEvent: (channel, payload) => events.push({ channel, payload }),
    now: () => 0,
    stuckAfterMs: 1000,
  });
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' }); // сессии нет — start() пойдёт голыми args
  mgr.start(a.tabId, 80, 24);
  spawned[0].opts.onExit(0); // естественная смерть — вкладка 'dead'
  assert.strictEqual(statusOf(events, a.tabId).status, 'dead');

  const startedBefore = events.filter((e) => e.channel === 'term:started').length;
  mgr.start(a.tabId, 80, 24); // спавн #2 умирает внутри фабрики

  assert.strictEqual(spawned.length, 2, 'без оверрайда авто-восстановление не при чём — третьего спавна быть не должно');
  assert.strictEqual(mgr.list()[0].alive, false, 'процесс умер внутри фабрики — вкладка не может считаться живой');
  assert.strictEqual(statusOf(events, a.tabId).status, 'dead');
  assert.strictEqual(
    events.filter((e) => e.channel === 'term:started').length,
    startedBefore,
    'term:started на мертворождённый процесс разблокировал бы ввод в никуда',
  );
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

test('spawn ставит статус ready; естественный exit — dead с кодом', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  // Процесс поднят, но ещё ничего не делает — «Наготове» (живая приёмка 01.08).
  assert.strictEqual(statusOf(events, a.tabId).status, 'ready');
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

test('checkStuck: working без вывода дольше порога → stuck; вывод возвращает working', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events, tick } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  // Армируем детект ПОРУЧЕНИЕМ, а не фактом запуска сессии: раньше здесь
  // стоял SessionStart, и тест закреплял ровно тот баг, на который пожаловался
  // пользователь 01.08 — нетронутая вкладка уезжала в «Проблемы».
  mgr.applyHookEvent(a.tabId, 'SessionStart', { session_id: 'sess-1' });
  mgr.applyHookEvent(a.tabId, 'UserPromptSubmit', { prompt: 'почини тесты' });
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

test('checkStuck: без хук-событий (hookActive=false) stuck НЕ наступает даже после порога', () => {
  // Раньше тест утверждал «останется working» — то есть закреплял вечное
  // «Работают» у проекта без хуков. Утверждение теста то же самое (порог не
  // делает вкладку зависшей), но ожидание теперь честное: она «Наготове».
  const factory = makeFakePtyFactory();
  const { mgr, events, tick } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  tick(1500); // дольше stuckAfterMs
  mgr.checkStuck();
  assert.strictEqual(statusOf(events, a.tabId).status, 'ready');
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

// ---------- Живая приёмка 01.08: ложное «зависание» у нетронутых вкладок ----------
// Отзыв пользователя: «после запуска кокпита во вкладках, в которых я ещё
// ничего не писал, сначала пишет "нет вывода 5м", потом отправляются в раздел
// "проблемы". Если нажать на них, они снова переезжают в "работают", хотя я
// ничего не писал, и потом опять уезжают в "проблемы"».
//
// «Нет вывода» — обещание про КОНКРЕТНОЕ поручение: я спросил, а ответа нет.
// Сессия, которой никто ничего не поручал, зависнуть не может, сколько бы она
// ни молчала.

test('stuck: восстановленная вкладка, которой ничего не писали, НЕ уезжает в «проблемы»', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events, tick } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha', sessionId: 'S1' });
  mgr.start(a.tabId, 80, 24);
  mgr.applyHookEvent(a.tabId, 'SessionStart', { session_id: 'S1' }); // резюм подтверждён
  factory.spawned[0].opts.onData('CLI отрисовал восстановленную переписку');

  tick(1500); // дольше порога
  mgr.checkStuck();

  assert.notStrictEqual(statusOf(events, a.tabId).status, 'stuck', 'поручения не было — зависать нечему');
});

test('stuck: ожившая вкладка перестаёт уверять, что вывода нет', () => {
  // Вкладка вернулась в «Работают» ровно потому, что вывод ПРИШЁЛ, — держать
  // на ней надпись «нет вывода 5м» абсурдно. Возвращаем ту подпись, с которой
  // она в зависание ушла.
  const factory = makeFakePtyFactory();
  const { mgr, events, tick } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  mgr.applyHookEvent(a.tabId, 'PreToolUse', { tool_name: 'Bash' });
  assert.strictEqual(statusOf(events, a.tabId).subtitle, 'Bash…');

  tick(1500);
  mgr.checkStuck();
  assert.strictEqual(statusOf(events, a.tabId).status, 'stuck');

  factory.spawned[0].opts.onData('вывод пошёл');
  const after = statusOf(events, a.tabId);
  assert.strictEqual(after.status, 'working');
  assert.strictEqual(after.subtitle, 'Bash…', 'вернулась подпись работы, а не "нет вывода"');
});

test('stuck: клик по нетронутой вкладке не гоняет её между разделами', () => {
  // Клик наводит фокус и рефит → CLI перерисовывает экран → приходит вывод.
  // Раньше вывод возвращал вкладку из stuck в working, и через порог она
  // уезжала обратно — бесконечная качель, ровно как в отзыве.
  const factory = makeFakePtyFactory();
  const { mgr, events, tick } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha', sessionId: 'S1' });
  mgr.start(a.tabId, 80, 24);
  mgr.applyHookEvent(a.tabId, 'SessionStart', { session_id: 'S1' });

  for (let i = 0; i < 3; i += 1) {
    tick(1500);
    mgr.checkStuck();
    // Проверяем ДО перерисовки: она сама возвращает статус, и проверка после
    // неё прошла бы вхолостую, ничего не измерив.
    assert.notStrictEqual(statusOf(events, a.tabId).status, 'stuck', `круг ${i + 1}`);
    factory.spawned[0].opts.onData('перерисовка после клика');
  }
});

test('stuck: после реального промпта молчание дольше порога — по-прежнему «нет вывода»', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events, tick } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  mgr.applyHookEvent(a.tabId, 'SessionStart', { session_id: 'S1' });
  mgr.applyHookEvent(a.tabId, 'UserPromptSubmit', { prompt: 'почини тесты' });

  tick(1500);
  mgr.checkStuck();

  assert.strictEqual(statusOf(events, a.tabId).status, 'stuck', 'поручение есть, ответа нет — это и есть зависание');
});

test('stuck: сжатие контекста посреди поручения НЕ снимает ожидание ответа', () => {
  // SessionStart — не только «сессия поднялась»: контракт хука допускает
  // source:'compact', а сжатие случается ПОСРЕДИ работы. Установленный CLI
  // 2.1.220 такого события не шлёт (проверено по бинарнику, см. комментарий в
  // sessions.js), но если пришлёт — детект не должен ослепнуть.
  const factory = makeFakePtyFactory();
  const { mgr, events, tick } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  mgr.applyHookEvent(a.tabId, 'SessionStart', { session_id: 'S1', source: 'startup' });
  mgr.applyHookEvent(a.tabId, 'UserPromptSubmit', { prompt: 'большая задача' });
  mgr.applyHookEvent(a.tabId, 'PreToolUse', { tool_name: 'Bash' });
  factory.spawned[0].opts.onData('идёт работа');

  mgr.applyHookEvent(a.tabId, 'SessionStart', { session_id: 'S1', source: 'compact' });
  tick(1500);
  mgr.checkStuck();

  assert.strictEqual(statusOf(events, a.tabId).status, 'stuck', 'поручение всё ещё в работе');
});

test('stuck: обычный SessionStart (startup/resume) ожидание снимает', () => {
  // Обратная половина той же развилки — чтобы страховка выше не превратилась
  // в «никогда не снимаем».
  const factory = makeFakePtyFactory();
  const { mgr, events, tick } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  mgr.applyHookEvent(a.tabId, 'UserPromptSubmit', { prompt: 'задача' });
  mgr.applyHookEvent(a.tabId, 'SessionStart', { session_id: 'S2', source: 'startup' });

  tick(1500);
  mgr.checkStuck();

  assert.notStrictEqual(statusOf(events, a.tabId).status, 'stuck');
});

// Следующие два теста НИЧЕГО не измеряют про awaitingReply (Minor 2 ревью):
// защищает их гард статуса в checkStuck ('working'), а из 'done'/'waiting'
// детект и так не срабатывает. Они зелёные и до фикса — оставлены как
// регрессионные на саму машину статусов, а снятие флага в Stop/Notification
// сегодня страховочное: значимым оно станет, если кто-то добавит новый
// переход обратно в 'working'.

test('stuck: ответ получен (Stop) — следующее молчание уже не «зависание»', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events, tick } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  mgr.applyHookEvent(a.tabId, 'UserPromptSubmit', { prompt: 'почини тесты' });
  mgr.applyHookEvent(a.tabId, 'Stop', {});
  // Stop → 'done'. Вывод после ответа (перерисовка, клик) не должен
  // возвращать вкладку в «работает» с последующим ложным зависанием.
  factory.spawned[0].opts.onData('перерисовка');
  tick(1500);
  mgr.checkStuck();

  assert.notStrictEqual(statusOf(events, a.tabId).status, 'stuck');
});

test('stuck: вкладка ждёт РАЗРЕШЕНИЯ — это не зависание, сколько бы ни ждала', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events, tick } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  mgr.applyHookEvent(a.tabId, 'UserPromptSubmit', { prompt: 'снеси папку' });
  mgr.applyHookEvent(a.tabId, 'Notification', { message: 'Claude needs your permission to use Bash' });
  factory.spawned[0].opts.onData('перерисовка окна разрешения');
  tick(1500);
  mgr.checkStuck();

  assert.strictEqual(statusOf(events, a.tabId).status, 'waiting', 'ждёт человека, а не молчит в работе');
});

test('stuck: перезапуск вкладки снимает ожидание ответа — новый процесс никто ни о чём не просил', () => {
  // Резюм может и не подтвердиться (SessionStart не придёт вовсе), поэтому
  // рассчитывать на его сброс нельзя — снимаем на самом спавне.
  const factory = makeFakePtyFactory();
  const { mgr, events, tick } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  mgr.applyHookEvent(a.tabId, 'UserPromptSubmit', { prompt: 'почини тесты' });

  mgr.restart(a.tabId);
  tick(1500);
  mgr.checkStuck();

  assert.notStrictEqual(statusOf(events, a.tabId).status, 'stuck');
});

// ---------- Живая приёмка 01.08: раздел «Наготове» ----------
// Отзыв пользователя: «а что насчёт того, что они возвращались именно во
// вкладку "работают", если по сути они просто открыты без дела?»
//
// «Работают» должно значить «Claude сейчас думает, не трогай». Поднявшаяся,
// но нетронутая сессия не работает — она стоит наготове. При десяти
// восстановленных вкладках счётчик «Работают · 10» выглядел так, будто десять
// сессий жгут лимит.
//
// «Готово» пользователь выбрал списком НЕПРОЧИТАННОГО: посмотрел результат —
// вкладка уходит в «Наготове».

test('ready: проект БЕЗ хуков Cockpit не висит вечно в «Работают»', () => {
  // Хуки — штатно необязательны (кнопка ⚡ в сайдбаре их предлагает, но жить
  // без них можно). Тогда SessionStart не придёт НИКОГДА, и статус, который
  // поставил сам spawn(), остаётся навсегда. Пока это было 'working', ровно
  // такая вкладка и порождала жалобу «работают, хотя я в них ничего не писал».
  const factory = makeFakePtyFactory();
  const { mgr, events, tick } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\no-hooks' });
  mgr.start(a.tabId, 80, 24);

  assert.strictEqual(statusOf(events, a.tabId).status, 'ready', 'сразу после спавна');

  tick(60 * 60 * 1000);
  mgr.checkStuck();
  assert.strictEqual(statusOf(events, a.tabId).status, 'ready', 'и через час тоже');
});

test('ready: восстановленная вкладка не мигает через «Работают» до прихода SessionStart', () => {
  // Восстановление идёт со стаггером, вкладок бывает десяток — счётчик
  // «Работают · N» прыгал бы всё восстановление.
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha', sessionId: 'S-old' });
  mgr.start(a.tabId, 80, 24);

  assert.strictEqual(statusOf(events, a.tabId).status, 'ready');
});

test('ready: запуск сессии — это «наготове», а не «работает»', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);

  mgr.applyHookEvent(a.tabId, 'SessionStart', { session_id: 'S1', source: 'startup' });

  assert.strictEqual(statusOf(events, a.tabId).status, 'ready');
});

test('ready: поручение переводит в «работают»', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  mgr.applyHookEvent(a.tabId, 'SessionStart', { session_id: 'S1' });

  mgr.applyHookEvent(a.tabId, 'UserPromptSubmit', { prompt: 'почини тесты' });

  assert.strictEqual(statusOf(events, a.tabId).status, 'working');
});

test('ready: markSeen переводит прочитанный результат из «готово» в «наготове»', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  mgr.applyHookEvent(a.tabId, 'UserPromptSubmit', { prompt: 'почини тесты' });
  mgr.applyHookEvent(a.tabId, 'Stop', {});
  assert.strictEqual(statusOf(events, a.tabId).status, 'done');

  mgr.markSeen(a.tabId);

  const after = statusOf(events, a.tabId);
  assert.strictEqual(after.status, 'ready');
  assert.strictEqual(after.subtitle, '', 'подпись завершённой задачи не тащим в «наготове»');
});

test('ready: markSeen трогает ТОЛЬКО «готово» — работающую вкладку не сбивает', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  mgr.applyHookEvent(a.tabId, 'UserPromptSubmit', { prompt: 'почини тесты' });

  mgr.markSeen(a.tabId); // пользователь смотрит на вкладку, а она ещё думает

  assert.strictEqual(statusOf(events, a.tabId).status, 'working');
});

test('ready: markSeen не будит ждущую и мёртвую вкладку', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  mgr.applyHookEvent(a.tabId, 'Notification', { message: 'Claude needs your permission to use Bash' });

  mgr.markSeen(a.tabId);

  assert.strictEqual(statusOf(events, a.tabId).status, 'waiting', 'смотреть на диалог не значит ответить на него');
});

test('ready: markSeen на неизвестной вкладке молчит и не бросает', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const before = events.length;
  mgr.markSeen('нет-такой-вкладки');
  assert.strictEqual(events.length, before);
});

test('ready: повторный markSeen на уже прочитанной вкладке не шлёт лишних событий', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  mgr.applyHookEvent(a.tabId, 'UserPromptSubmit', { prompt: 'почини' });
  mgr.applyHookEvent(a.tabId, 'Stop', {});
  mgr.markSeen(a.tabId);
  const after = events.filter((e) => e.channel === 'tab:status').length;

  mgr.markSeen(a.tabId);

  assert.strictEqual(events.filter((e) => e.channel === 'tab:status').length, after);
});

test('ready: «наготове» не считается зависанием, сколько бы ни стояла', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events, tick } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  mgr.applyHookEvent(a.tabId, 'SessionStart', { session_id: 'S1' });

  tick(1500);
  mgr.checkStuck();

  assert.strictEqual(statusOf(events, a.tabId).status, 'ready');
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

test('провал резюма (короткоживущий процесс, SessionStart не пришёл) → авто-восстановление одной чистой попыткой, вкладка жива', () => {
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
  assert.strictEqual(st.status, 'ready', 'вкладка должна остаться живой, а не dead');

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
  assert.strictEqual(statusOf(events, a.tabId).status, 'ready', 'свежий процесс поднят и ждёт поручения');
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
  assert.strictEqual(statusOf(events, a.tabId).status, 'ready', 'свежий процесс поднят и ждёт поручения');
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
// различить». Источник — НАСТОЯЩИЙ заголовок сессии (запись ai-title в
// транскрипте, читается асинхронно через инжектируемый readSessionTitle);
// фолбэк — текст первого промпта, пока заголовка ещё нет.
//
// ВАЖНО (ревью 01.08 опровергло первую версию фичи): поле session_title из
// payload хука НЕ используется — оно отдаёт только имя из /rename, а не
// автозаголовок, и у ~94% реальных сессий пользователя отсутствует.

// Ждём, пока осядут промисы асинхронного чтения заголовка.
async function flushAsync(times = 5) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

test('sessionLabel: ai-title из транскрипта подписывает вкладку (главный сценарий --resume)', async () => {
  const factory = makeFakePtyFactory();
  const readCalls = [];
  const { mgr, events } = makeManager(factory, {
    readSessionTitle: (p) => { readCalls.push(p); return Promise.resolve('Организовать папку Акто'); },
  });
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);

  mgr.applyHookEvent(a.tabId, 'SessionStart', {
    session_id: 'S1', transcript_path: 'C:\\t\\S1.jsonl',
  });
  await flushAsync();

  assert.deepStrictEqual(readCalls, ['C:\\t\\S1.jsonl']);
  assert.strictEqual(statusOf(events, a.tabId).sessionLabel, 'Организовать папку Акто');
});

test('sessionLabel: SessionStart БЕЗ заголовка в транскрипте — метки нет, вкладка не врёт', async () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory, {
    readSessionTitle: () => Promise.resolve(''), // ai-title ещё не сгенерирован
  });
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);

  mgr.applyHookEvent(a.tabId, 'SessionStart', {
    session_id: 'S1', transcript_path: 'C:\\t\\S1.jsonl',
  });
  await flushAsync();

  assert.strictEqual(statusOf(events, a.tabId).sessionLabel, '');
});

test('sessionLabel: пока заголовка нет — фолбэк на текст первого промпта', async () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory, { readSessionTitle: () => Promise.resolve('') });
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);

  mgr.applyHookEvent(a.tabId, 'UserPromptSubmit', { prompt: 'почини тесты в модуле оплаты' });
  await flushAsync();

  assert.strictEqual(statusOf(events, a.tabId).sessionLabel, 'почини тесты в модуле оплаты');
});

test('sessionLabel: настоящий заголовок ПЕРЕБИВАЕТ фолбэк-промпт, когда появляется', async () => {
  const factory = makeFakePtyFactory();
  let title = '';
  const { mgr, events } = makeManager(factory, { readSessionTitle: () => Promise.resolve(title) });
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);

  mgr.applyHookEvent(a.tabId, 'UserPromptSubmit', { prompt: 'почини тесты', transcript_path: 'C:\\t\\S1.jsonl' });
  await flushAsync();
  assert.strictEqual(statusOf(events, a.tabId).sessionLabel, 'почини тесты');

  title = 'Починка тестов оплаты'; // CLI сгенерировал заголовок
  mgr.applyHookEvent(a.tabId, 'UserPromptSubmit', { prompt: 'теперь линтер', transcript_path: 'C:\\t\\S1.jsonl' });
  await flushAsync();
  assert.strictEqual(statusOf(events, a.tabId).sessionLabel, 'Починка тестов оплаты');
});

test('sessionLabel: второй промпт НЕ перезаписывает фолбэк (метка стабильна)', async () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory, { readSessionTitle: () => Promise.resolve('') });
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);

  mgr.applyHookEvent(a.tabId, 'UserPromptSubmit', { prompt: 'первый промпт' });
  mgr.applyHookEvent(a.tabId, 'UserPromptSubmit', { prompt: 'второй промпт' });
  await flushAsync();

  assert.strictEqual(statusOf(events, a.tabId).sessionLabel, 'первый промпт');
});

test('sessionLabel: заголовок читается ОДИН раз — второй промпт не плодит чтений', async () => {
  const factory = makeFakePtyFactory();
  let reads = 0;
  const { mgr } = makeManager(factory, {
    readSessionTitle: () => { reads += 1; return Promise.resolve('Заголовок'); },
  });
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);

  mgr.applyHookEvent(a.tabId, 'SessionStart', { session_id: 'S1', transcript_path: 'C:\\t\\S1.jsonl' });
  await flushAsync();
  mgr.applyHookEvent(a.tabId, 'UserPromptSubmit', { prompt: 'ещё', transcript_path: 'C:\\t\\S1.jsonl' });
  mgr.applyHookEvent(a.tabId, 'UserPromptSubmit', { prompt: 'и ещё', transcript_path: 'C:\\t\\S1.jsonl' });
  await flushAsync();

  assert.strictEqual(reads, 1, 'настоящий заголовок получен — перечитывать незачем');
});

test('sessionLabel: ответ чтения ПОСЛЕ restart не применяется (гонка поколений)', async () => {
  const factory = makeFakePtyFactory();
  let release;
  const pending = new Promise((r) => { release = r; });
  const { mgr, events } = makeManager(factory, { readSessionTitle: () => pending });
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);

  mgr.applyHookEvent(a.tabId, 'SessionStart', { session_id: 'S1', transcript_path: 'C:\\t\\S1.jsonl' });
  mgr.restart(a.tabId); // поколение сменилось, пока чтение висело
  release('Заголовок протухшей сессии');
  await flushAsync();

  const st = statusOf(events, a.tabId);
  assert.notStrictEqual(st && st.sessionLabel, 'Заголовок протухшей сессии');
});

test('sessionLabel: restart с ТОЙ ЖЕ сессией (--resume id) метку сохраняет', async () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory, { readSessionTitle: () => Promise.resolve('Рефакторинг оплаты') });
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  mgr.applyHookEvent(a.tabId, 'SessionStart', { session_id: 'S1', transcript_path: 'C:\\t\\S1.jsonl' });
  await flushAsync();
  assert.strictEqual(statusOf(events, a.tabId).sessionLabel, 'Рефакторинг оплаты');

  mgr.restart(a.tabId); // sessionId известен — спавнится --resume S1, сессия ТА ЖЕ
  const after = mgr.list().find((t) => t.tabId === a.tabId);
  assert.strictEqual(after.sessionLabel, 'Рефакторинг оплаты', 'та же сессия — та же метка');
});

test('sessionLabel: restart БЕЗ известной сессии (пикер) метку гасит — она стала бы чужой', async () => {
  const factory = makeFakePtyFactory();
  const { mgr } = makeManager(factory, { readSessionTitle: () => Promise.resolve('') });
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);
  mgr.applyHookEvent(a.tabId, 'UserPromptSubmit', { prompt: 'старая тема' });
  await flushAsync();
  assert.strictEqual(mgr.list().find((t) => t.tabId === a.tabId).sessionLabel, 'старая тема');

  mgr.restart(a.tabId); // sessionId нет — голый --resume (интерактивный пикер)
  assert.strictEqual(mgr.list().find((t) => t.tabId === a.tabId).sessionLabel, '');
});

test('sessionLabel: метка из манифеста подхватывается при open (восстановление)', () => {
  const factory = makeFakePtyFactory();
  const { mgr } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha', sessionLabel: 'Вчерашняя тема' });

  assert.strictEqual(a.sessionLabel, 'Вчерашняя тема', 'open() возвращает метку renderer-у');
  assert.strictEqual(mgr.list().find((t) => t.tabId === a.tabId).sessionLabel, 'Вчерашняя тема');
});

test('sessionLabel: длинный многострочный промпт схлопывается и режется многоточием', async () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory, { readSessionTitle: () => Promise.resolve('') });
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);

  mgr.applyHookEvent(a.tabId, 'UserPromptSubmit', {
    prompt: 'первая строка\nвторая строка   с   лишними пробелами и очень длинным хвостом до упора',
  });
  await flushAsync();

  const label = statusOf(events, a.tabId).sessionLabel;
  assert.ok(!label.includes('\n'), 'переводов строк быть не должно');
  assert.ok(!/\s{2,}/.test(label), 'кратных пробелов быть не должно');
  assert.strictEqual(label.length, 48);
  assert.ok(label.endsWith('…'));
});

test('sessionLabel: без зависимости readSessionTitle всё работает на одном фолбэке', async () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory); // readSessionTitle не передан вовсе
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);

  mgr.applyHookEvent(a.tabId, 'SessionStart', { session_id: 'S1', transcript_path: 'C:\\t\\S1.jsonl' });
  mgr.applyHookEvent(a.tabId, 'UserPromptSubmit', { prompt: 'работает без чтения' });
  await flushAsync();

  assert.strictEqual(statusOf(events, a.tabId).sessionLabel, 'работает без чтения');
});

test('sessionLabel: сбой чтения транскрипта не роняет вкладку', async () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory, {
    readSessionTitle: () => Promise.reject(new Error('нет файла')),
  });
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);

  mgr.applyHookEvent(a.tabId, 'SessionStart', { session_id: 'S1', transcript_path: 'C:\\t\\S1.jsonl' });
  mgr.applyHookEvent(a.tabId, 'UserPromptSubmit', { prompt: 'фолбэк выжил' });
  await flushAsync();

  assert.strictEqual(statusOf(events, a.tabId).sessionLabel, 'фолбэк выжил');
});

// --- C1/I1/M1 (ре-ревью 01.08): смена сессии БЕЗ смены pty и защёлки ---

test('sessionLabel C1: /clear (новый session_id в том же pty) сбрасывает метку — вкладка не зовётся старой темой', async () => {
  const factory = makeFakePtyFactory();
  let title = 'Рефакторинг оплаты';
  const { mgr, events } = makeManager(factory, { readSessionTitle: () => Promise.resolve(title) });
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);

  mgr.applyHookEvent(a.tabId, 'SessionStart', { session_id: 'S1', transcript_path: 'C:\\t\\S1.jsonl' });
  await flushAsync();
  assert.strictEqual(statusOf(events, a.tabId).sessionLabel, 'Рефакторинг оплаты');

  // /clear: тот же pty (gen не меняется), но сессия НОВАЯ.
  title = 'Черновик релиз-ноутов';
  mgr.applyHookEvent(a.tabId, 'SessionStart', { session_id: 'S2', transcript_path: 'C:\\t\\S2.jsonl' });
  await flushAsync();

  assert.strictEqual(statusOf(events, a.tabId).sessionLabel, 'Черновик релиз-ноутов');
});

test('sessionLabel C1: фолбэк-метка тоже сбрасывается при смене сессии в том же pty', async () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory, { readSessionTitle: () => Promise.resolve('') });
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);

  mgr.applyHookEvent(a.tabId, 'SessionStart', { session_id: 'S1' });
  mgr.applyHookEvent(a.tabId, 'UserPromptSubmit', { prompt: 'почини тесты оплаты' });
  await flushAsync();
  assert.strictEqual(statusOf(events, a.tabId).sessionLabel, 'почини тесты оплаты');

  mgr.applyHookEvent(a.tabId, 'SessionStart', { session_id: 'S2' }); // /clear
  mgr.applyHookEvent(a.tabId, 'UserPromptSubmit', { prompt: 'теперь напиши доки' });
  await flushAsync();

  assert.strictEqual(statusOf(events, a.tabId).sessionLabel, 'теперь напиши доки');
});

test('sessionLabel C1: висящее чтение СТАРОЙ сессии не приземляется на новую (gen тот же!)', async () => {
  const factory = makeFakePtyFactory();
  let release;
  const pending = new Promise((r) => { release = r; });
  let call = 0;
  const { mgr, events } = makeManager(factory, {
    readSessionTitle: () => { call += 1; return call === 1 ? pending : Promise.resolve(''); },
  });
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);

  mgr.applyHookEvent(a.tabId, 'SessionStart', { session_id: 'S1', transcript_path: 'C:\\t\\S1.jsonl' });
  // Пока чтение S1 висит — пришёл /clear с новой сессией (pty НЕ менялся).
  mgr.applyHookEvent(a.tabId, 'SessionStart', { session_id: 'S2', transcript_path: 'C:\\t\\S2.jsonl' });
  release('Заголовок ПРОШЛОЙ сессии');
  await flushAsync();

  const st = statusOf(events, a.tabId);
  assert.notStrictEqual(st && st.sessionLabel, 'Заголовок ПРОШЛОЙ сессии');
});

test('sessionLabel I1: метка из манифеста РАВНА ai-title — чтение всё равно происходит РОВНО раз', async () => {
  const factory = makeFakePtyFactory();
  let reads = 0;
  const { mgr } = makeManager(factory, {
    readSessionTitle: () => { reads += 1; return Promise.resolve('Вчерашняя тема'); },
  });
  // Главный сценарий (б): вкладка восстановлена с меткой из манифеста, и
  // заголовок в транскрипте ТОТ ЖЕ — раньше это не считалось «заголовок
  // получен», и чтение повторялось на каждом промпте до конца сессии.
  const a = mgr.open({ cwd: 'C:\\proj\\alpha', sessionLabel: 'Вчерашняя тема' });
  mgr.start(a.tabId, 80, 24);

  mgr.applyHookEvent(a.tabId, 'SessionStart', { session_id: 'S1', transcript_path: 'C:\\t\\S1.jsonl' });
  await flushAsync();
  mgr.applyHookEvent(a.tabId, 'UserPromptSubmit', { prompt: 'раз', transcript_path: 'C:\\t\\S1.jsonl' });
  mgr.applyHookEvent(a.tabId, 'UserPromptSubmit', { prompt: 'два', transcript_path: 'C:\\t\\S1.jsonl' });
  mgr.applyHookEvent(a.tabId, 'UserPromptSubmit', { prompt: 'три', transcript_path: 'C:\\t\\S1.jsonl' });
  await flushAsync();

  assert.strictEqual(reads, 1, 'совпадение метки с заголовком — тоже «заголовок получен»');
});



// D1 (ре-ревью раунда 2): ТРЕТИЙ путь смены сессии — авто-восстановление
// после провала резюма. Ключ к воспроизведению: заголовок должен быть УЖЕ
// прочитан (sessionLabelFromTitle=true), а следующий спавн — уйти с
// оверрайдом `--resume` и умереть, НЕ привязав сессию. Тогда onExit обнуляет
// sessionId ДО прихода нового SessionStart, и гарда bindSession (сравнение
// старого id с новым) сработать уже не может.

test('sessionLabel D1: провал резюма + авто-респавн — новая сессия получает СВОЁ имя, не прошлое', async () => {
  const factory = makeFakePtyFactory();
  let title = 'Рефакторинг оплаты';
  const { mgr, events } = makeManager(factory, { readSessionTitle: () => Promise.resolve(title) });
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);

  // Живая сессия S1 с прочитанным заголовком.
  mgr.applyHookEvent(a.tabId, 'SessionStart', { session_id: 'S1', transcript_path: 'C:\\t\\S1.jsonl' });
  await flushAsync();
  assert.strictEqual(statusOf(events, a.tabId).sessionLabel, 'Рефакторинг оплаты');

  // Ctrl+Shift+R: sessionId известен → спавн #2 уходит с `--resume S1`
  // (метка при этом СОХРАНЯЕТСЯ — сессия та же, см. отдельный тест выше).
  mgr.restart(a.tabId);
  assert.strictEqual(mgr.list().find((t) => t.tabId === a.tabId).sessionLabel, 'Рефакторинг оплаты');

  // Резюм провалился: процесс умер, SessionStart так и не пришёл →
  // авто-восстановление синхронно поднимает ЧИСТУЮ новую сессию.
  factory.spawned[1].opts.onExit(1);
  assert.strictEqual(factory.spawned.length, 3, 'авто-восстановление подняло новый процесс');

  title = 'Свежая задача';
  mgr.applyHookEvent(a.tabId, 'SessionStart', { session_id: 'S9', transcript_path: 'C:\\t\\S9.jsonl' });
  await flushAsync();

  assert.strictEqual(statusOf(events, a.tabId).sessionLabel, 'Свежая задача');
  assert.strictEqual(
    mgr.list().find((t) => t.tabId === a.tabId).sessionLabel,
    'Свежая задача',
    'в манифест не должно уехать имя сессии, которой в этой вкладке больше нет',
  );
});

test('sessionLabel D1: провал резюма снимает защёлку — транскрипт новой сессии реально читается', async () => {
  const factory = makeFakePtyFactory();
  const reads = [];
  const { mgr } = makeManager(factory, {
    readSessionTitle: (p) => { reads.push(p); return Promise.resolve(`Заголовок ${p}`); },
  });
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);

  mgr.applyHookEvent(a.tabId, 'SessionStart', { session_id: 'S1', transcript_path: 'C:\\t\\S1.jsonl' });
  await flushAsync();
  assert.deepStrictEqual(reads, ['C:\\t\\S1.jsonl']);

  mgr.restart(a.tabId);              // --resume S1
  factory.spawned[1].opts.onExit(1); // провал → авто-респавн чистой сессии

  mgr.applyHookEvent(a.tabId, 'SessionStart', { session_id: 'S2', transcript_path: 'C:\\t\\S2.jsonl' });
  await flushAsync();

  // Без сброса sessionLabelFromTitle этот путь навсегда остался бы с одним
  // чтением — вкладка никогда не узнала бы имя своей текущей сессии.
  assert.deepStrictEqual(reads, ['C:\\t\\S1.jsonl', 'C:\\t\\S2.jsonl']);
});

test('sessionLabel M3: tabs:changed эмитится именно АСИНХРОННЫМ применением метки', async () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory, { readSessionTitle: () => Promise.resolve('Заголовок') });
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);

  mgr.applyHookEvent(a.tabId, 'SessionStart', { session_id: 'S1', transcript_path: 'C:\\t\\S1.jsonl' });
  // Снимок ПОСЛЕ синхронной части (bindSession уже отправил свой tabs:changed) —
  // рост дальше может дать только применение метки из асинхронного чтения.
  const afterSync = events.filter((e) => e.channel === 'tabs:changed').length;
  await flushAsync();

  const afterAsync = events.filter((e) => e.channel === 'tabs:changed').length;
  assert.strictEqual(afterAsync, afterSync + 1, 'применение метки обязано само уведомить манифест');
});

// Запрос пользователя 01.08: переименовал сессию через `/rename` → новое имя
// подхватывается при перезапуске вкладки (Ctrl+Shift+R), а не на каждом
// промпте. Сессия при этом ТА ЖЕ (--resume того же id), поэтому метку не
// гасим (сайдбар не мигает), но заголовок обязаны перечитать.

test('sessionLabel: Ctrl+Shift+R перечитывает имя сессии — /rename подхватывается', async () => {
  const factory = makeFakePtyFactory();
  let title = 'Организовать папку Акто';   // сначала автозаголовок
  const reads = [];
  const { mgr, events } = makeManager(factory, {
    readSessionTitle: (p, sid) => { reads.push({ p, sid }); return Promise.resolve(title); },
  });
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);

  mgr.applyHookEvent(a.tabId, 'SessionStart', { session_id: 'S1', transcript_path: 'C:\\t\\S1.jsonl' });
  await flushAsync();
  assert.strictEqual(statusOf(events, a.tabId).sessionLabel, 'Организовать папку Акто');
  assert.strictEqual(reads.length, 1);
  assert.strictEqual(reads[0].sid, 'S1', 'sessionId прокидывается — чужие записи в файле отсеиваются');

  // Пользователь сделал /rename прямо в этой сессии...
  title = 'RZ paper';
  mgr.applyHookEvent(a.tabId, 'UserPromptSubmit', { prompt: 'ещё', transcript_path: 'C:\\t\\S1.jsonl' });
  await flushAsync();
  assert.strictEqual(
    statusOf(events, a.tabId).sessionLabel,
    'Организовать папку Акто',
    'на обычном промпте НЕ перечитываем — так выбрал пользователь',
  );

  // ...и нажал Ctrl+Shift+R — вот момент подхвата.
  mgr.restart(a.tabId);
  assert.strictEqual(
    mgr.list().find((t) => t.tabId === a.tabId).sessionLabel,
    'Организовать папку Акто',
    'метка не гаснет на время перезапуска — сайдбар не мигает пустотой',
  );
  mgr.applyHookEvent(a.tabId, 'SessionStart', { session_id: 'S1', transcript_path: 'C:\\t\\S1.jsonl' });
  await flushAsync();

  assert.strictEqual(statusOf(events, a.tabId).sessionLabel, 'RZ paper');
  assert.strictEqual(reads.length, 2, 'ровно одно дополнительное чтение — на рестарте');
});

test('sessionLabel Minor 2: запоздавший ответ старой сессии не снимает занятость нового чтения', async () => {
  // `/clear` во время висящего чтения — путь, где поколение pty НЕ меняется
  // (та же труба), поэтому сверкой gen тут ничего не защитить: чтение старой
  // сессии выглядит «своим» и гасит занятость, принадлежащую уже чтению
  // новой. Следующий промпт после этого запускает третье чтение параллельно
  // второму. Токен чтения различает их, gen — нет.
  const factory = makeFakePtyFactory();
  const resolvers = [];
  const { mgr } = makeManager(factory, {
    readSessionTitle: () => new Promise((resolve) => { resolvers.push(resolve); }),
  });
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);

  mgr.applyHookEvent(a.tabId, 'SessionStart', { session_id: 'S1', transcript_path: 'C:\\t\\S1.jsonl' });
  await flushAsync();
  assert.strictEqual(resolvers.length, 1, 'чтение сессии S1 стартовало и висит');

  // /clear: тот же pty, новая сессия — занятость сбрасывается, gen прежний.
  mgr.applyHookEvent(a.tabId, 'SessionStart', { session_id: 'S2', transcript_path: 'C:\\t\\S2.jsonl' });
  await flushAsync();
  assert.strictEqual(resolvers.length, 2, 'для новой сессии открыто своё чтение');

  resolvers[0]('Заголовок сессии S1'); // отвечает ПЕРВОЕ, второе ещё висит
  await flushAsync();

  mgr.applyHookEvent(a.tabId, 'UserPromptSubmit', { prompt: 'ещё', transcript_path: 'C:\\t\\S2.jsonl' });
  await flushAsync();
  assert.strictEqual(resolvers.length, 2, 'третьего чтения нет — занятость второго цела');

  // И занятость не залипла навсегда: второе чтение доводит дело до метки.
  resolvers[1]('RZ paper');
  await flushAsync();
  assert.strictEqual(mgr.list().find((t) => t.tabId === a.tabId).sessionLabel, 'RZ paper');
});

// === B6: провал резюма из start() детектится так же, как из restart() ======
//
// Ревью 09.08. start() при живом sessionId достраивает `--resume <id>` (см.
// Important 2 в самом ядре), но, в отличие от restart(), не сбрасывал
// sessionBound. А onExit считает провал как `usedOverride && !sessionBound` —
// то есть у вкладки, которая УЖЕ жила и была привязана, флаг оставался true с
// прошлой жизни, и провал резюма не детектился вовсе: не обнулялся протухший
// sessionId, не срабатывало авто-восстановление, мёртвый id уезжал в манифест,
// и следующий запуск кокпита снова резюмил мертвеца.

test('start: провал резюма протухшей сессии подхватывается авто-восстановлением', () => {
  const factory = makeFakePtyFactory();
  const { mgr } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });

  mgr.start(a.tabId, 80, 24); // спавн #1
  mgr.applyHookEvent(a.tabId, 'SessionStart', { session_id: 'sess-1' }); // привязались
  factory.spawned[0].opts.onExit(0); // процесс завершился, вкладка мертва

  mgr.start(a.tabId, 80, 24); // спавн #2: ядро само достраивает --resume sess-1
  assert.deepStrictEqual(factory.spawned[1].opts.args, ['--resume', 'sess-1']);

  // Резюм провалился: процесс умер, SessionStart за его жизнь не пришёл.
  factory.spawned[1].opts.onExit(1);

  assert.strictEqual(
    factory.spawned.length, 3,
    'провал резюма из start() не детектится — авто-восстановление не сработало',
  );
  assert.deepStrictEqual(
    factory.spawned[2].opts.args, [],
    'авто-восстановление обязано поднять ЧИСТУЮ сессию, без протухшего id',
  );
  const tab = mgr.list().find((t) => t.tabId === a.tabId);
  assert.strictEqual(tab.sessionId, null, 'протухший sessionId уедет в манифест и переживёт перезапуск кокпита');
});

test('авто-восстановление доступно снова после того, как вкладка ожила', () => {
  // Гард одноразовости (autoRecovered) не переживает целую жизнь вкладки:
  // его гасит bindSession — «резюм действительно удался». Сценарий: вкладку
  // уже спасали авто-восстановлением, она привязалась к новой сессии,
  // поработала и умерла; следующий резюм тоже провалился — спасать обязаны
  // снова, иначе вкладка останется мёртвой с протухшим id.
  //
  // Тест написан, когда я добавил в start() симметричный сброс этого флага:
  // мутация показала, что удаление той строки не ловится ничем, потому что
  // флаг к тому моменту уже false. Строку убрал, а проверку инварианта
  // оставил — она стережёт настоящее место сброса.
  const factory = makeFakePtyFactory();
  const { mgr } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });

  // Жизнь первая: провал резюма → авто-восстановление (спавн #3).
  mgr.start(a.tabId, 80, 24);
  mgr.applyHookEvent(a.tabId, 'SessionStart', { session_id: 'sess-1' });
  factory.spawned[0].opts.onExit(0);
  mgr.start(a.tabId, 80, 24);
  factory.spawned[1].opts.onExit(1);
  assert.strictEqual(factory.spawned.length, 3, 'первое авто-восстановление не сработало');

  // Вкладка ожила и привязалась к новой сессии, поработала, завершилась.
  mgr.applyHookEvent(a.tabId, 'SessionStart', { session_id: 'sess-2' });
  factory.spawned[2].opts.onExit(0);

  // Жизнь вторая: снова резюмим и снова проваливаемся.
  mgr.start(a.tabId, 80, 24);
  assert.deepStrictEqual(factory.spawned[3].opts.args, ['--resume', 'sess-2']);
  factory.spawned[3].opts.onExit(1);

  assert.strictEqual(
    factory.spawned.length, 5,
    'второй провал резюма никто не подхватил — гард одноразовости пережил жизнь вкладки',
  );
  assert.deepStrictEqual(factory.spawned[4].opts.args, [], 'спасать надо чистой сессией, без протухшего id');
});

// === B9: очередь промптов видна тому, кто подключился к живым вкладкам =====

test('list отдаёт очередь промптов — иначе подключившийся клиент её не увидит', () => {
  const factory = makeFakePtyFactory();
  const { mgr } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 80, 24);

  mgr.enqueue(a.tabId, 'сначала это');
  mgr.enqueue(a.tabId, 'потом это');

  const tab = mgr.list().find((t) => t.tabId === a.tabId);
  assert.deepStrictEqual(
    tab.queue.map((s) => s.trim()),
    ['сначала это', 'потом это'],
    'очередь не попала в list — клиент после перезагрузки страницы покажет пустую строку чипов',
  );

  // Копия, а не сам массив: снаружи его нельзя менять мимо ядра.
  tab.queue.push('чужой элемент');
  const снова = mgr.list().find((t) => t.tabId === a.tabId);
  assert.strictEqual(снова.queue.length, 2, 'list отдал внутренний массив наружу — очередь можно испортить извне');
});
