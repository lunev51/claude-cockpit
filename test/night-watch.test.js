'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createNightWatch } = require('../src/main/night-watch');

// --- фейковые зависимости (все таймеры дёргаются руками, никаких реальных ожиданий) ---

function makeClock(start = 0) {
  let t = start;
  return { now: () => t, set(v) { t = v; } };
}

// setTimer/clearTimer — фейк без реального времени: setTimer кладёт колбэк
// (и заказанную задержку ms) в реестр, fire(id) вызывает его руками.
// Important 4 (ревью раунд 1): раньше фейк ИГНОРИРОВАЛ ms — опечатка вроде
// cfg.retryMs вместо cfg.staggerMs в стаггер-цепочке прошла бы зелёной.
// lastMs()/log хранят задержку КАЖДОГО запланированного таймера — тесты
// ассертят её явно там, где перепутать staggerMs/retryMs легко и незаметно.
function fakeTimers() {
  let seq = 0;
  const live = new Map(); // id -> {fn, ms}, живые (не снятые и ещё не выстрелившие)
  const log = []; // {id, ms} в порядке планирования (включая уже снятые/выстрелившие) — для lastId()/lastMs()
  return {
    setTimer(fn, ms) {
      const id = ++seq;
      live.set(id, { fn, ms });
      log.push({ id, ms });
      return id;
    },
    clearTimer(id) {
      live.delete(id);
    },
    fire(id) {
      const entry = live.get(id);
      if (!entry) throw new Error(`таймер #${id} не запланирован или уже снят`);
      live.delete(id);
      return entry.fn();
    },
    lastId() {
      return log.length ? log[log.length - 1].id : null;
    },
    lastMs() {
      return log.length ? log[log.length - 1].ms : null;
    },
    liveCount() {
      return live.size;
    },
    // Живые таймеры в порядке планирования — тестам сна нужно стрелять
    // конкретным (будильник против сторожа), а не «последним запланированным».
    liveIds() {
      return [...live.keys()];
    },
    msOf(id) {
      const entry = live.get(id);
      return entry ? entry.ms : null;
    },
  };
}

// Ожидание сброса стоит на ДВУХ таймерах: длинный будильник на сам срок и
// короткий сторож, который переживёт сон машины (см. блок тестов про сон).
// Опознаём их по заказанной задержке, а не по порядку планирования.
const WATCHDOG_MS = 60000;
const watchdogId = (timers) => timers.liveIds().find((id) => timers.msOf(id) === WATCHDOG_MS);
const alarmId = (timers) => timers.liveIds().find((id) => timers.msOf(id) !== WATCHDOG_MS);

function fakeJournal() {
  let entries = [];
  return {
    append(e) { entries.push(e); },
    readAll() { return entries; },
    reset() { entries = []; },
    get entries() { return entries; }, // удобный доступ в тестах, не часть контракта ядра
  };
}

function fakePowerBlocker() {
  return {
    startCount: 0,
    stopCount: 0,
    start() { this.startCount += 1; },
    stop() { this.stopCount += 1; },
  };
}

function fakeEmit() {
  const calls = [];
  const fn = (event, payload) => calls.push({ event, payload });
  fn.calls = calls;
  return fn;
}

function fakeWriteToTab() {
  const calls = [];
  const fn = (tabId, text) => calls.push({ tabId, text });
  fn.calls = calls;
  return fn;
}

// Снапшот usage-oauth в упрощённом виде — только то, что нужно night-watch.
function usageOk({ fiveHourPercent = 0, resetsAt = null, sevenDayPercent = 0 } = {}) {
  return {
    ok: true,
    fiveHour: { percent: fiveHourPercent, resetsAt },
    sevenDay: { percent: sevenDayPercent },
  };
}

// Фейк refreshUsage с явным переключением фазы «детект (лимит исчерпан) →
// пробуждение (окно сброшено)» — вместо хрупкого счёта вызовов (который
// ломается, как только детектов больше одного до самого пробуждения, см.
// разные вкладки в одном pending). markReset() зовётся тестом РОВНО в
// момент, когда по сценарию сервер должен начать отдавать сброшенное окно.
function makeUsageToggle({ resetsAt, belowPercent = 10, abovePercent = 95, sevenDayPercent = 0 } = {}) {
  let reset = false;
  const fn = async () => (reset
    ? usageOk({ fiveHourPercent: belowPercent, sevenDayPercent })
    : usageOk({ fiveHourPercent: abovePercent, resetsAt, sevenDayPercent }));
  fn.markReset = () => { reset = true; };
  return fn;
}

function setup(overrides = {}) {
  const clock = overrides.clock || makeClock(0);
  const timers = overrides.timers || fakeTimers();
  const journal = overrides.journal || fakeJournal();
  const blocker = overrides.blocker || fakePowerBlocker();
  const emit = overrides.emit || fakeEmit();
  const write = overrides.write || fakeWriteToTab();
  const statuses = overrides.statuses || new Map();
  const getTabStatus = overrides.getTabStatus
    || ((tabId) => (statuses.has(tabId) ? statuses.get(tabId) : null));
  const refreshUsage = overrides.refreshUsage || (async () => usageOk());
  const config = overrides.config || {};
  // M2 (ревью финальной волны): getTabGen — НЕОБЯЗАТЕЛЬНАЯ зависимость, по
  // умолчанию не передаётся вовсе (undefined) — тесты, которым gen-проверка
  // не нужна, ведут себя ровно как раньше (Task 1/раунд 1), не зная об M2.
  const getTabGen = overrides.getTabGen;

  const nw = createNightWatch({
    now: clock.now,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    refreshUsage,
    getTabStatus,
    writeToTab: write,
    emit,
    powerBlocker: blocker,
    journal,
    config,
    getTabGen,
  });

  return {
    nw, clock, timers, journal, blocker, emit, write, statuses, getTabStatus,
  };
}

function lastEntry(ctx) {
  return ctx.journal.entries[ctx.journal.entries.length - 1];
}

// === детект (onTabStop) ===

test('детект: working + Stop + fiveHour>=95% → pending, планируется таймер, запись limit-stop', async () => {
  const resetsAt = 100000;
  const ctx = setup({ refreshUsage: async () => usageOk({ fiveHourPercent: 95, resetsAt }) });
  ctx.nw.arm();

  await ctx.nw.onTabStop('tab1', 'working');

  const snap = ctx.nw.snapshot();
  assert.strictEqual(snap.pendingCount, 1);
  assert.strictEqual(snap.wakeAt, resetsAt + 60000); // wakeMarginMs по умолчанию
  const last = lastEntry(ctx);
  assert.strictEqual(last.type, 'limit-stop');
  assert.strictEqual(last.tabId, 'tab1');
  assert.strictEqual(last.detail, String(resetsAt));
  // Таймеров ДВА: длинный будильник на сам срок и короткий сторож, который
  // подстрахует, если машина уснёт и длинный таймер не переживёт resume
  // (см. блок тестов про сон).
  assert.strictEqual(ctx.timers.liveCount(), 2);
  assert.ok(watchdogId(ctx.timers), 'сторож обязан стоять рядом с будильником');
});

test('prevStatus !== working (например done) → тишина, refreshUsage не вызывается', async () => {
  const ctx = setup({ refreshUsage: async () => { throw new Error('refreshUsage не должен вызываться'); } });
  ctx.nw.arm();
  const before = ctx.journal.entries.length;

  await ctx.nw.onTabStop('tab1', 'done');

  assert.strictEqual(ctx.journal.entries.length, before);
  assert.strictEqual(ctx.nw.snapshot().pendingCount, 0);
});

test('fiveHour.percent ниже порога → обычное завершение задачи, тишина', async () => {
  const ctx = setup({ refreshUsage: async () => usageOk({ fiveHourPercent: 50 }) });
  ctx.nw.arm();
  const before = ctx.journal.entries.length;

  await ctx.nw.onTabStop('tab1', 'working');

  assert.strictEqual(ctx.journal.entries.length, before);
  assert.strictEqual(ctx.nw.snapshot().pendingCount, 0);
});

test('refreshUsage вернул ok:false → no-usage-data, вкладка не в pending', async () => {
  const ctx = setup({ refreshUsage: async () => ({ ok: false }) });
  ctx.nw.arm();

  await ctx.nw.onTabStop('tab1', 'working');

  const last = lastEntry(ctx);
  assert.strictEqual(last.type, 'no-usage-data');
  assert.strictEqual(last.tabId, 'tab1');
  assert.strictEqual(ctx.nw.snapshot().pendingCount, 0);
});

// Critical 2 (ревью раунд 1): stale:true (поллер поднял дисковый кэш, пока
// токен обновлялся) — данные МОГУТ быть уже совсем не актуальны. Трактуем
// так же консервативно, как ok:false: не заводим pending по устаревшим
// цифрам, даже если percent в кэше формально >= порога.
test('Critical 2: stale:true → трактуется как no-usage-data, pending по кэшу не заводится', async () => {
  const ctx = setup({
    refreshUsage: async () => ({
      ok: true, stale: true, fiveHour: { percent: 96, resetsAt: -1000 }, sevenDay: { percent: 5 },
    }),
  });
  ctx.nw.arm();

  await ctx.nw.onTabStop('tab1', 'working');

  const last = lastEntry(ctx);
  assert.strictEqual(last.type, 'no-usage-data');
  assert.strictEqual(ctx.nw.snapshot().pendingCount, 0);
  assert.strictEqual(ctx.timers.liveCount(), 0); // будильник НЕ поставлен
});

// Critical 2, доп. санити-гард: resetsAt уже в прошлом относительно now() —
// планировать пробуждение «назад во времени» нельзя (иначе будильник
// стрельнул бы немедленно). Трактуем как «нечем планировать».
// N2 (ре-ревью раунда 1) уточнил границу: отбрасывается только resetsAt,
// у которого МОМЕНТ ПРОБУЖДЕНИЯ (resetsAt + wakeMarginMs) уже в прошлом —
// ровно граница (равенство) сюда входит. resetsAt «чуть в прошлом» при ещё
// будущем моменте пробуждения — честный детект, см. тест N2 ниже.
test('Critical 2/N2: момент пробуждения (resetsAt+margin) в прошлом → no-resets-at, будильник не планируется', async () => {
  // clock=0, resetsAt=-60000: resetsAt + wakeMarginMs(60000) = 0 <= now(0) — граница включительно.
  const ctx = setup({ refreshUsage: async () => usageOk({ fiveHourPercent: 95, resetsAt: -60000 }) });
  ctx.nw.arm();

  await ctx.nw.onTabStop('tab1', 'working');

  const last = lastEntry(ctx);
  assert.strictEqual(last.type, 'no-resets-at');
  assert.strictEqual(ctx.nw.snapshot().pendingCount, 0);
  assert.strictEqual(ctx.timers.liveCount(), 0);
});

test('refreshUsage реджектит → usage-error, ядро не бросает наружу', async () => {
  const ctx = setup({ refreshUsage: async () => { throw new Error('сеть недоступна'); } });
  ctx.nw.arm();

  await assert.doesNotReject(ctx.nw.onTabStop('tab1', 'working'));

  const last = lastEntry(ctx);
  assert.strictEqual(last.type, 'usage-error');
  assert.strictEqual(last.tabId, 'tab1');
});

test('sevenDay.percent >= 99 И fiveHour>=порога → weekly-limit, планирования нет', async () => {
  const ctx = setup({
    refreshUsage: async () => usageOk({ fiveHourPercent: 95, resetsAt: 5000, sevenDayPercent: 99 }),
  });
  ctx.nw.arm();

  await ctx.nw.onTabStop('tab1', 'working');

  const last = lastEntry(ctx);
  assert.strictEqual(last.type, 'weekly-limit');
  assert.strictEqual(ctx.nw.snapshot().pendingCount, 0);
  assert.strictEqual(ctx.timers.liveCount(), 0);
});

// Minor 1 (ревью раунд 1): недельный лимит проверяется ТОЛЬКО ВНУТРИ ветки
// «пятичасовой тоже упёрся в порог» — раньше проверка стояла независимо от
// fiveHour и писала weekly-limit на КАЖДОМ обычном завершении задачи, если
// sevenDay случайно был >= 99 (например, под конец недели).
test('Minor 1: sevenDay>=99, но fiveHour ниже порога → тишина (weekly не проверяется вне ветки лимита)', async () => {
  const ctx = setup({ refreshUsage: async () => usageOk({ fiveHourPercent: 20, sevenDayPercent: 99 }) });
  ctx.nw.arm();
  const before = ctx.journal.entries.length;

  await ctx.nw.onTabStop('tab1', 'working');

  assert.strictEqual(ctx.journal.entries.length, before); // никакой записи вообще
});

test('fiveHour >= порога, но resetsAt null → no-resets-at, планировать нечем', async () => {
  const ctx = setup({ refreshUsage: async () => usageOk({ fiveHourPercent: 95, resetsAt: null }) });
  ctx.nw.arm();

  await ctx.nw.onTabStop('tab1', 'working');

  const last = lastEntry(ctx);
  assert.strictEqual(last.type, 'no-resets-at');
  assert.strictEqual(ctx.nw.snapshot().pendingCount, 0);
});

test('дубль tabId в pending не плодится: второй Stop той же вкладки — no-op без повторного refreshUsage', async () => {
  let calls = 0;
  const ctx = setup({
    refreshUsage: async () => { calls += 1; return usageOk({ fiveHourPercent: 95, resetsAt: 1000 }); },
  });
  ctx.nw.arm();

  await ctx.nw.onTabStop('tab1', 'working');
  assert.strictEqual(ctx.nw.snapshot().pendingCount, 1);
  const journalLenAfterFirst = ctx.journal.entries.length;

  await ctx.nw.onTabStop('tab1', 'working');

  assert.strictEqual(ctx.nw.snapshot().pendingCount, 1);
  assert.strictEqual(ctx.journal.entries.length, journalLenAfterFirst);
  assert.strictEqual(calls, 1);
});

// Important 1 (ревью раунд 1): исходный дубль-гард стоял ТОЛЬКО до await —
// два конкурентных Stop одной вкладки, оба начатых ДО того, как первый из
// них успел дописать pending, оба проходят этот ранний гард (видят pending
// пустым/без tabId) и, если не перепроверить дубль ПОСЛЕ await, оба
// допишут pending → на пробуждении "продолжай" ушло бы ДВАЖДЫ.
test('Important 1: два конкурентных Stop одной вкладки (гонка до резолва) не задваивают pending', async () => {
  const resolvers = [];
  const refreshUsage = () => new Promise((res) => { resolvers.push(res); });
  const ctx = setup({ refreshUsage });
  ctx.nw.arm();

  const p1 = ctx.nw.onTabStop('tab1', 'working'); // первый Stop, повис на await
  const p2 = ctx.nw.onTabStop('tab1', 'working'); // второй Stop той же вкладки — ДО резолва первого

  resolvers[0](usageOk({ fiveHourPercent: 95, resetsAt: 1000 }));
  resolvers[1](usageOk({ fiveHourPercent: 95, resetsAt: 1000 }));
  await Promise.all([p1, p2]);

  assert.strictEqual(ctx.nw.snapshot().pendingCount, 1); // не задвоилось
  const limitStops = ctx.journal.entries.filter((e) => e.type === 'limit-stop');
  assert.strictEqual(limitStops.length, 1);
});

test('disarm() во время подвисшего await refreshUsage → после резолва ничего не происходит', async () => {
  let resolveUsage;
  const usagePromise = new Promise((res) => { resolveUsage = res; });
  const ctx = setup({ refreshUsage: () => usagePromise });
  ctx.nw.arm();

  const stopPromise = ctx.nw.onTabStop('tab1', 'working'); // подвисает на await refreshUsage()
  ctx.nw.disarm(); // выключаем режим, пока промис ещё не резолвнут
  const journalLenAfterDisarm = ctx.journal.entries.length;

  resolveUsage(usageOk({ fiveHourPercent: 95, resetsAt: 1000 })); // резолвим уже ПОСЛЕ disarm
  await stopPromise;

  assert.strictEqual(ctx.journal.entries.length, journalLenAfterDisarm); // ничего нового не добавилось
  assert.strictEqual(ctx.nw.snapshot().pendingCount, 0);
});

// Critical 1 (ревью раунд 1): disarm() ЗА КОТОРЫМ следует arm() ДО того, как
// стейл-await старого взвода резолвится, — armed на момент проверки СНОВА
// true (это уже новый взвод), поэтому простой `if (!armed) return` пропускал
// бы эту проверку и стейл-limit-stop старого взвода утекал бы в журнал
// НОВОГО (только что сброшенный journal.reset()). generation ловит это:
// gen, зафиксированный ДО await, не совпадает с текущим generation, даже
// если armed сейчас снова true.
test('Critical 1: disarm→arm во время висящего refreshUsage — стейл-результат СТАРОГО взвода не попадает в НОВЫЙ журнал', async () => {
  let resolveUsage;
  const usagePromise = new Promise((res) => { resolveUsage = res; });
  const ctx = setup({ refreshUsage: () => usagePromise });
  ctx.nw.arm();

  const stopPromise = ctx.nw.onTabStop('tab1', 'working'); // повис на await, поколение старого взвода
  ctx.nw.disarm();
  ctx.nw.arm(); // новый взвод — journal.reset(), armed снова true
  const journalLenAfterRearm = ctx.journal.entries.length; // ровно одна запись 'armed'

  resolveUsage(usageOk({ fiveHourPercent: 95, resetsAt: 1000 })); // стейл-результат СТАРОГО вызова
  await stopPromise;

  assert.strictEqual(ctx.journal.entries.length, journalLenAfterRearm); // в новый журнал ничего не добавилось
  assert.strictEqual(ctx.nw.snapshot().pendingCount, 0);
});

// === пробуждение ===

test('пробуждение: окно сбросилось → в живую вкладку уходит ровно "продолжай"', async () => {
  const resetsAt = 1000;
  const refreshUsage = makeUsageToggle({ resetsAt });
  const ctx = setup({ refreshUsage });
  ctx.statuses.set('tab1', 'working');
  ctx.nw.arm();
  await ctx.nw.onTabStop('tab1', 'working');

  refreshUsage.markReset();
  ctx.clock.set(resetsAt + 60000);
  await ctx.timers.fire(ctx.timers.lastId());

  assert.strictEqual(ctx.write.calls.length, 1);
  assert.strictEqual(ctx.write.calls[0].tabId, 'tab1');
  assert.strictEqual(ctx.write.calls[0].text, 'продолжай');
  const last = lastEntry(ctx);
  assert.strictEqual(last.type, 'wake-complete');
  assert.strictEqual(last.detail, '1 of 1');
  assert.strictEqual(ctx.nw.snapshot().pendingCount, 0);
});

test('пробуждение: waiting/dead/несуществующая вкладка → skipped со статусом, "продолжай" не уходит', async () => {
  const resetsAt = 1000;
  const refreshUsage = makeUsageToggle({ resetsAt });
  const ctx = setup({ refreshUsage });
  ctx.statuses.set('tabWaiting', 'waiting');
  ctx.statuses.set('tabDead', 'dead');
  // tabGone намеренно без статуса — getTabStatus вернёт null
  ctx.nw.arm();
  await ctx.nw.onTabStop('tabWaiting', 'working');
  await ctx.nw.onTabStop('tabDead', 'working');
  await ctx.nw.onTabStop('tabGone', 'working');

  refreshUsage.markReset();
  ctx.clock.set(resetsAt + 60000);
  await ctx.timers.fire(ctx.timers.lastId()); // tabWaiting — сразу
  await ctx.timers.fire(ctx.timers.lastId()); // tabDead — после стаггер-тика
  await ctx.timers.fire(ctx.timers.lastId()); // tabGone

  const skipped = ctx.journal.entries.filter((e) => e.type === 'skipped');
  assert.strictEqual(skipped.length, 3);
  assert.strictEqual(skipped[0].detail, 'status:waiting');
  assert.strictEqual(skipped[1].detail, 'status:dead');
  assert.strictEqual(skipped[2].detail, 'status:null');
  assert.strictEqual(ctx.write.calls.length, 0);
  const last = lastEntry(ctx);
  assert.strictEqual(last.type, 'wake-complete');
  assert.strictEqual(last.detail, '0 of 3');
});

test('ввод ПОСЛЕ detectedAt → skipped user-took-over, "продолжай" не уходит', async () => {
  const resetsAt = 1000;
  const refreshUsage = makeUsageToggle({ resetsAt });
  const ctx = setup({ refreshUsage });
  ctx.statuses.set('tab1', 'working');
  ctx.nw.arm();
  ctx.clock.set(500);
  await ctx.nw.onTabStop('tab1', 'working'); // detectedAt = 500

  ctx.clock.set(600);
  ctx.nw.onUserInput('tab1'); // ввод ПОСЛЕ детекта — перехват вкладки пользователем

  refreshUsage.markReset();
  ctx.clock.set(resetsAt + 60000);
  await ctx.timers.fire(ctx.timers.lastId());

  assert.strictEqual(ctx.write.calls.length, 0);
  const skipped = ctx.journal.entries.find((e) => e.type === 'skipped');
  assert.strictEqual(skipped.detail, 'user-took-over');
  assert.strictEqual(lastEntry(ctx).detail, '0 of 1');
});

test('ввод ДО detectedAt (обычная работа до остановки) — НЕ причина пропуска, продолжаем', async () => {
  const resetsAt = 1000;
  const refreshUsage = makeUsageToggle({ resetsAt });
  const ctx = setup({ refreshUsage });
  ctx.statuses.set('tab1', 'working');
  ctx.nw.arm();

  ctx.clock.set(100);
  ctx.nw.onUserInput('tab1'); // ввод задолго до остановки — обычная работа

  ctx.clock.set(500);
  await ctx.nw.onTabStop('tab1', 'working'); // detectedAt = 500 > 100

  refreshUsage.markReset();
  ctx.clock.set(resetsAt + 60000);
  await ctx.timers.fire(ctx.timers.lastId());

  assert.strictEqual(ctx.write.calls.length, 1);
  assert.strictEqual(ctx.write.calls[0].text, 'продолжай');
  assert.strictEqual(lastEntry(ctx).detail, '1 of 1');
});

test('стаггер: первая вкладка сразу, вторая — только после отдельного ручного тика staggerMs', async () => {
  const resetsAt = 1000;
  const refreshUsage = makeUsageToggle({ resetsAt });
  const ctx = setup({ refreshUsage });
  ctx.statuses.set('tab1', 'working');
  ctx.statuses.set('tab2', 'working');
  ctx.nw.arm();
  await ctx.nw.onTabStop('tab1', 'working');
  await ctx.nw.onTabStop('tab2', 'working');

  refreshUsage.markReset();
  ctx.clock.set(resetsAt + 60000);
  await ctx.timers.fire(ctx.timers.lastId()); // выстрел будильника

  assert.strictEqual(ctx.write.calls.length, 1);
  assert.strictEqual(ctx.write.calls[0].tabId, 'tab1');
  assert.strictEqual(ctx.timers.liveCount(), 1); // хвост запланирован, но не выстрелен
  // Important 4 (ревью раунд 1): хвост обязан быть заказан именно на
  // cfg.staggerMs — фейк таймера раньше игнорировал ms, и опечатка вроде
  // cfg.retryMs (5 минут) вместо cfg.staggerMs (10с) прошла бы незамеченной.
  assert.strictEqual(ctx.timers.lastMs(), 10000);

  await ctx.timers.fire(ctx.timers.lastId()); // ручной тик стаггера

  assert.strictEqual(ctx.write.calls.length, 2);
  assert.strictEqual(ctx.write.calls[1].tabId, 'tab2');
});

// Important 5а (ревью раунд 1): NO_RESUME_STATUSES — список ИСКЛЮЧЕНИЙ, не
// вайтлист. В бою вкладка после реального Stop-хука стоит в 'done'
// (sessions.js: setStatus(tab,'done','')), а во всех предыдущих тестах
// резюма статус был искусственно 'working' — если бы кто-то по ошибке
// переписал NO_RESUME_STATUSES в вайтлист (`['working']`), тесты остались
// бы зелёными, а ночью ВСЕ вкладки молча пропускались бы.
test('Important 5а: статус done (реальный статус после Stop-хука) на пробуждении — считается живой, продолжаем', async () => {
  const resetsAt = 1000;
  const refreshUsage = makeUsageToggle({ resetsAt });
  const ctx = setup({ refreshUsage });
  ctx.statuses.set('tab1', 'done');
  ctx.nw.arm();
  await ctx.nw.onTabStop('tab1', 'working');

  refreshUsage.markReset();
  ctx.clock.set(resetsAt + 60000);
  await ctx.timers.fire(ctx.timers.lastId());

  assert.strictEqual(ctx.write.calls.length, 1);
  assert.strictEqual(lastEntry(ctx).detail, '1 of 1');
});

test('Important 5а: статус stuck на пробуждении — тоже считается живой, продолжаем', async () => {
  const resetsAt = 1000;
  const refreshUsage = makeUsageToggle({ resetsAt });
  const ctx = setup({ refreshUsage });
  ctx.statuses.set('tab1', 'stuck');
  ctx.nw.arm();
  await ctx.nw.onTabStop('tab1', 'working');

  refreshUsage.markReset();
  ctx.clock.set(resetsAt + 60000);
  await ctx.timers.fire(ctx.timers.lastId());

  assert.strictEqual(ctx.write.calls.length, 1);
  assert.strictEqual(lastEntry(ctx).detail, '1 of 1');
});

// Important 5б (ревью раунд 1): бриф явно требовал ассерт wakeAt на
// MAX(resetsAt) среди pending — до этого раунда покрыт не был. Обе стороны:
// более поздний resetsAt у второй вкладки должен ПЕРЕПЛАНИРОВАТЬ таймер
// вперёд; более ранний — НЕ должен сдвинуть уже запланированный max назад.
test('Important 5б: более поздний resetsAt у второй вкладки перепланирует будильник на MAX', async () => {
  const queue = [
    usageOk({ fiveHourPercent: 95, resetsAt: 1000 }),
    usageOk({ fiveHourPercent: 95, resetsAt: 5000 }),
  ];
  const refreshUsage = async () => queue.shift();
  const ctx = setup({ refreshUsage });
  ctx.nw.arm();

  await ctx.nw.onTabStop('tab1', 'working');
  assert.strictEqual(ctx.nw.snapshot().wakeAt, 1000 + 60000);

  await ctx.nw.onTabStop('tab2', 'working'); // resetsAt позже — двигает max вперёд
  assert.strictEqual(ctx.nw.snapshot().wakeAt, 5000 + 60000);
  assert.strictEqual(ctx.nw.snapshot().pendingCount, 2);
});

test('Important 5б: более ранний resetsAt у второй вкладки НЕ уменьшает уже запланированный MAX', async () => {
  const queue = [
    usageOk({ fiveHourPercent: 95, resetsAt: 5000 }),
    usageOk({ fiveHourPercent: 95, resetsAt: 1000 }),
  ];
  const refreshUsage = async () => queue.shift();
  const ctx = setup({ refreshUsage });
  ctx.nw.arm();

  await ctx.nw.onTabStop('tab1', 'working');
  await ctx.nw.onTabStop('tab2', 'working'); // resetsAt раньше первого — max не должен сдвинуться назад

  assert.strictEqual(ctx.nw.snapshot().wakeAt, 5000 + 60000);
});

test('disarm() посреди стаггер-цепочки → aborted, хвост не стреляет', async () => {
  const resetsAt = 1000;
  const refreshUsage = makeUsageToggle({ resetsAt });
  const ctx = setup({ refreshUsage });
  ctx.statuses.set('tab1', 'working');
  ctx.statuses.set('tab2', 'working');
  ctx.nw.arm();
  await ctx.nw.onTabStop('tab1', 'working');
  await ctx.nw.onTabStop('tab2', 'working');

  refreshUsage.markReset();
  ctx.clock.set(resetsAt + 60000);
  await ctx.timers.fire(ctx.timers.lastId()); // tab1 продолжена, хвост для tab2 запланирован

  const tailTimerId = ctx.timers.lastId();
  ctx.nw.disarm(); // выключаем ПОСРЕДИ цепочки

  await ctx.timers.fire(tailTimerId); // ручной тик хвоста — должен оборваться

  assert.strictEqual(ctx.write.calls.length, 1); // tab2 "продолжай" не получила
  assert.strictEqual(lastEntry(ctx).type, 'aborted');
});

// Critical 1 (ревью раунд 1): disarm() СРАЗУ ЗА КОТОРЫМ следует arm() ДО
// того, как выстрелит хвост стаггера, — простая проверка `!armed` внутри
// runStagger не сработала бы (armed уже снова true, это НОВЫЙ взвод), хвост
// СТАРОГО взвода отправил бы "продолжай" в вкладку, которую пользователь
// только что отменил, и записал бы resumed/wake-complete в журнал НОВОГО,
// только что взведённого режима. generation ловит это через delta>=2
// (disarm + arm — минимум два перехода с момента старта этого прохода):
// молчим полностью, не пишем даже 'aborted' (это событие СТАРОГО, уже
// забытого журнала).
test('Critical 1: disarm→arm посреди стаггер-цепочки — хвост СТАРОГО взвода не пишет "продолжай" и не трогает НОВЫЙ журнал', async () => {
  const resetsAt = 1000;
  const refreshUsage = makeUsageToggle({ resetsAt });
  const ctx = setup({ refreshUsage });
  ctx.statuses.set('tab1', 'working');
  ctx.statuses.set('tab2', 'working');
  ctx.nw.arm();
  await ctx.nw.onTabStop('tab1', 'working');
  await ctx.nw.onTabStop('tab2', 'working');

  refreshUsage.markReset();
  ctx.clock.set(resetsAt + 60000);
  await ctx.timers.fire(ctx.timers.lastId()); // tab1 продолжена (старое поколение), хвост для tab2 запланирован

  const tailTimerId = ctx.timers.lastId();
  ctx.nw.disarm();
  ctx.nw.arm(); // ре-арм ДО того, как выстрелит хвост старого прохода
  const journalLenAfterRearm = ctx.journal.entries.length; // только 'armed'

  await ctx.timers.fire(tailTimerId); // хвост СТАРОГО поколения стреляет

  assert.strictEqual(ctx.write.calls.length, 1); // tab2 старого взвода "продолжай" не получила
  assert.strictEqual(ctx.journal.entries.length, journalLenAfterRearm); // журнал НОВОГО взвода не тронут вообще ничем
});

// Important 2 (ревью раунд 1): исключение внутри стаггер-прохода (например,
// writeToTab бросил — мёртвый pty) раньше только логировалось, но НЕ гасило
// wakePassInFlight — power-blocker залипал бы включённым навсегда (ноутбук
// не уснёт до утра), хотя pending и таймеры уже пусты.
test('Important 2: исключение в стаггер-проходе (writeToTab бросил) не залипает power-blocker навсегда', async () => {
  const resetsAt = 1000;
  const refreshUsage = makeUsageToggle({ resetsAt });
  const throwingWrite = () => { throw new Error('pty мёртв'); };
  const ctx = setup({ refreshUsage, write: throwingWrite });
  ctx.statuses.set('tab1', 'working');
  ctx.nw.arm();
  await ctx.nw.onTabStop('tab1', 'working');

  refreshUsage.markReset();
  ctx.clock.set(resetsAt + 60000);
  await ctx.timers.fire(ctx.timers.lastId());

  assert.strictEqual(lastEntry(ctx).type, 'internal-error');
  assert.strictEqual(ctx.blocker.stopCount, 1); // блокер снят, несмотря на исключение
});

// Critical 2 (ревью раунд 1), зеркальная сторона: на пробуждении stale:true
// НЕ считается подтверждённым сбросом окна, даже если percent в кэше уже
// ниже порога, — это цифры из прошлого. Раньше это съедало все ретраи за
// 15 минут (gave-up), хотя окно реально уже могло не сброситься; теперь —
// обычный ретрай, как при любом другом «ещё не сброшено».
test('Critical 2: на пробуждении stale:true не считается подтверждённым сбросом — уходит в ретрай, не в wake-complete', async () => {
  const resetsAt = 1000;
  let staleMode = false;
  const refreshUsage = async () => {
    if (!staleMode) return usageOk({ fiveHourPercent: 95, resetsAt });
    return { ok: true, stale: true, fiveHour: { percent: 10, resetsAt: null }, sevenDay: { percent: 0 } };
  };
  const ctx = setup({ config: { maxRetries: 1 }, refreshUsage });
  ctx.nw.arm();
  await ctx.nw.onTabStop('tab1', 'working');

  staleMode = true;
  ctx.clock.set(resetsAt + 60000);
  await ctx.timers.fire(ctx.timers.lastId());

  assert.strictEqual(lastEntry(ctx).type, 'retry'); // не wake-complete, несмотря на percent<threshold — потому что stale
  assert.strictEqual(ctx.nw.snapshot().pendingCount, 1); // всё ещё ждём
});

test('окно не сбросилось: ретраи до maxRetries, затем gave-up', async () => {
  const resetsAt = 1000;
  const ctx = setup({
    config: { maxRetries: 2, retryMs: 500 },
    refreshUsage: async () => usageOk({ fiveHourPercent: 95, resetsAt }), // всегда «ещё не сброшено»
  });
  ctx.nw.arm();
  await ctx.nw.onTabStop('tab1', 'working');

  ctx.clock.set(resetsAt + 60000);
  await ctx.timers.fire(ctx.timers.lastId()); // попытка 1 → retry 1
  assert.strictEqual(lastEntry(ctx).type, 'retry');
  // Minor 2: detail теперь содержит и номер попытки, и список зависших
  // tabId (утренний отчёт должен показывать, КАКИЕ вкладки ждут).
  assert.ok(lastEntry(ctx).detail.startsWith('1'));
  assert.ok(lastEntry(ctx).detail.includes('tab1'));
  // Important 4: ретрай обязан планироваться именно на cfg.retryMs.
  assert.strictEqual(ctx.timers.lastMs(), 500);

  await ctx.timers.fire(ctx.timers.lastId()); // попытка 2 → retry 2
  assert.strictEqual(lastEntry(ctx).type, 'retry');
  assert.ok(lastEntry(ctx).detail.startsWith('2'));

  await ctx.timers.fire(ctx.timers.lastId()); // попытка 3 → maxRetries исчерпаны → gave-up
  assert.strictEqual(lastEntry(ctx).type, 'gave-up');
  assert.ok(lastEntry(ctx).detail.includes('tab1')); // Minor 2: gave-up тоже называет вкладки
  assert.strictEqual(ctx.nw.snapshot().pendingCount, 0);
});

// Important 5г (ревью раунд 1): обнуление retries при переходе pending
// пусто→непусто раньше не было зафиксировано тестом — строку можно было
// удалить, и все тесты остались бы зелёными. Без неё счётчик ретраев
// «утекал» бы из предыдущего (уже сдавшегося) цикла в следующий, и новый
// цикл мог бы мгновенно сдаться, унаследовав чужой большой счётчик.
test('Important 5г: retries обнуляется в новом цикле ожидания — не наследуется от предыдущего сдавшегося цикла', async () => {
  let phase = 'limit1'; // 'limit1' → 'notreset' (ретраи цикла1) → 'limit2' → 'notreset2'
  const refreshUsage = async () => {
    if (phase === 'limit1' || phase === 'notreset') return usageOk({ fiveHourPercent: 95, resetsAt: 1000 });
    return usageOk({ fiveHourPercent: 95, resetsAt: 999999999 }); // 'limit2'/'notreset2' — далеко в будущем
  };
  const ctx = setup({ config: { maxRetries: 1 }, refreshUsage });
  ctx.nw.arm();

  await ctx.nw.onTabStop('tab1', 'working'); // цикл 1: limit-stop, resetsAt=1000
  phase = 'notreset';
  ctx.clock.set(1000 + 60000);
  await ctx.timers.fire(ctx.timers.lastId()); // попытка1 → retry(1)
  await ctx.timers.fire(ctx.timers.lastId()); // попытка2 → maxRetries(1) исчерпан → gave-up
  assert.strictEqual(lastEntry(ctx).type, 'gave-up');

  phase = 'limit2';
  await ctx.nw.onTabStop('tab2', 'working'); // цикл 2: новый детект, pending был пуст → retries должен обнулиться
  phase = 'notreset2';
  ctx.clock.set(999999999 + 60000);
  await ctx.timers.fire(ctx.timers.lastId());

  // Если бы retries НЕ обнулился (унаследовал 2 из цикла 1), первая же
  // попытка цикла 2 сразу сдалась бы (2 > maxRetries=1). С фиксом — это
  // ЕЩЁ retry (счётчик начал с нуля).
  assert.strictEqual(lastEntry(ctx).type, 'retry');
  assert.ok(lastEntry(ctx).detail.startsWith('1'));
});

test('потолок maxResets: после исчерпания пробуждений новый детект → cap-reached без опроса', async () => {
  const resetsAt = 1000;
  let refreshCalls = 0;
  const toggle = makeUsageToggle({ resetsAt });
  const refreshUsage = async () => { refreshCalls += 1; return toggle(); };
  const ctx = setup({ config: { maxResets: 1 }, refreshUsage });
  ctx.statuses.set('tab1', 'working');
  ctx.nw.arm();
  await ctx.nw.onTabStop('tab1', 'working'); // limit-stop
  toggle.markReset();
  ctx.clock.set(resetsAt + 60000);
  await ctx.timers.fire(ctx.timers.lastId()); // пробуждение №1 — успешное, resetsHandled=1=maxResets

  assert.strictEqual(ctx.nw.snapshot().resetsHandled, 1);

  const callsBefore = refreshCalls;
  await ctx.nw.onTabStop('tab2', 'working'); // новый детект после исчерпания потолка

  assert.strictEqual(refreshCalls, callsBefore); // refreshUsage даже не вызывался
  assert.strictEqual(lastEntry(ctx).type, 'cap-reached');
  assert.strictEqual(lastEntry(ctx).tabId, 'tab2');
  assert.strictEqual(ctx.nw.snapshot().pendingCount, 0);
});

// I1(б) (ревью финальной волны): 'cap-reached' пишется РОВНО ОДИН РАЗ за
// взвод — проба ревьюера (200 Stop подряд после исчерпания потолка) не
// должна штамповать 200 отдельных записей+emit.
test('I1(б): cap-reached логируется ОДИН раз за взвод — второй/третий детект после потолка молчат', async () => {
  const resetsAt = 1000;
  const toggle = makeUsageToggle({ resetsAt });
  const ctx = setup({ config: { maxResets: 1 }, refreshUsage: toggle });
  ctx.statuses.set('tab1', 'working');
  ctx.nw.arm();
  await ctx.nw.onTabStop('tab1', 'working');
  toggle.markReset();
  ctx.clock.set(resetsAt + 60000);
  await ctx.timers.fire(ctx.timers.lastId()); // resetsHandled=1=maxResets

  const lenAfterFirstCap = ctx.journal.entries.length;
  await ctx.nw.onTabStop('tab2', 'working'); // первый детект после потолка → cap-reached
  const capEntries1 = ctx.journal.entries.filter((e) => e.type === 'cap-reached').length;
  assert.strictEqual(capEntries1, 1);
  assert.ok(ctx.journal.entries.length > lenAfterFirstCap);

  const lenAfterSecondAttempt = ctx.journal.entries.length;
  await ctx.nw.onTabStop('tab3', 'working'); // второй детект после потолка → МОЛЧА
  await ctx.nw.onTabStop('tab4', 'working'); // третий — тоже молча
  assert.strictEqual(ctx.journal.entries.length, lenAfterSecondAttempt, 'после первого cap-reached журнал больше не растёт на повторных детектах');
  const capEntriesTotal = ctx.journal.entries.filter((e) => e.type === 'cap-reached').length;
  assert.strictEqual(capEntriesTotal, 1, 'за весь взвод — ровно одна запись cap-reached');
});

test('I1(б): новый взвод (arm() после disarm()) снова может залогировать cap-reached', async () => {
  // Фаза-переключатель вручную (а не makeUsageToggle — её markReset()
  // необратим, а этому тесту нужно ДВА независимых цикла лимит→сброс подряд,
  // один на взвод) — тот же приём, что N1/N3 тесты выше по файлу.
  let phase = 'limit';
  let resetsAtRef = 1000;
  const refreshUsage = async () => (phase === 'limit'
    ? usageOk({ fiveHourPercent: 96, resetsAt: resetsAtRef })
    : usageOk({ fiveHourPercent: 10 }));
  const ctx = setup({ config: { maxResets: 1 }, refreshUsage });

  // Взвод №1: исчерпываем потолок, получаем ровно одну cap-reached запись.
  ctx.statuses.set('tab1', 'working');
  ctx.nw.arm();
  await ctx.nw.onTabStop('tab1', 'working');
  phase = 'reset';
  ctx.clock.set(resetsAtRef + 60000);
  await ctx.timers.fire(ctx.timers.lastId()); // resetsHandled=1=maxResets
  phase = 'limit';
  await ctx.nw.onTabStop('tab2', 'working'); // cap-reached #1 взвода №1
  assert.strictEqual(ctx.journal.entries.filter((e) => e.type === 'cap-reached').length, 1);

  // Новый взвод: arm() сбрасывает journal.reset() (журнал пуст) И
  // capReachedLogged — потолок ЭТОГО взвода должен снова залогироваться
  // один раз, независимо от прошлого взвода.
  ctx.nw.disarm();
  ctx.nw.arm();
  ctx.statuses.set('tab3', 'working');
  resetsAtRef = 2000;
  await ctx.nw.onTabStop('tab3', 'working');
  phase = 'reset';
  ctx.clock.set(resetsAtRef + 60000);
  await ctx.timers.fire(ctx.timers.lastId()); // resetsHandled=1=maxResets взвода №2
  phase = 'limit';
  await ctx.nw.onTabStop('tab4', 'working'); // cap-reached #1 взвода №2
  await ctx.nw.onTabStop('tab5', 'working'); // повтор — молча, как и в первом взводе

  const capEntries = ctx.journal.entries.filter((e) => e.type === 'cap-reached');
  assert.strictEqual(capEntries.length, 1, 'journal.reset() в arm() уже очистил журнал прошлого взвода — здесь только записи НОВОГО взвода');
  assert.strictEqual(capEntries[0].tabId, 'tab4');
});

// === power-blocker (инвариант) ===

test('power-blocker: start() при первом pending, stop() после wake-complete, идемпотентно', async () => {
  const resetsAt = 1000;
  const refreshUsage = makeUsageToggle({ resetsAt });
  const ctx = setup({ refreshUsage });
  ctx.statuses.set('tab1', 'working');
  ctx.nw.arm();
  assert.strictEqual(ctx.blocker.startCount, 0);

  await ctx.nw.onTabStop('tab1', 'working');
  assert.strictEqual(ctx.blocker.startCount, 1);
  assert.strictEqual(ctx.blocker.stopCount, 0);

  refreshUsage.markReset();
  ctx.clock.set(resetsAt + 60000);
  await ctx.timers.fire(ctx.timers.lastId()); // wake-complete → stop

  assert.strictEqual(ctx.blocker.startCount, 1); // не задвоилось
  assert.strictEqual(ctx.blocker.stopCount, 1);
});

test('power-blocker: stop() после disarm(), даже если pending был непуст', async () => {
  const ctx = setup({ refreshUsage: async () => usageOk({ fiveHourPercent: 95, resetsAt: 1000 }) });
  ctx.nw.arm();
  await ctx.nw.onTabStop('tab1', 'working');
  assert.strictEqual(ctx.blocker.startCount, 1);

  ctx.nw.disarm();

  assert.strictEqual(ctx.blocker.stopCount, 1);
});

test('power-blocker: stop() после gave-up', async () => {
  const resetsAt = 1000;
  const ctx = setup({
    config: { maxRetries: 0 },
    refreshUsage: async () => usageOk({ fiveHourPercent: 95, resetsAt }),
  });
  ctx.nw.arm();
  await ctx.nw.onTabStop('tab1', 'working');
  assert.strictEqual(ctx.blocker.startCount, 1);

  ctx.clock.set(resetsAt + 60000);
  await ctx.timers.fire(ctx.timers.lastId()); // maxRetries=0 → сразу gave-up

  assert.strictEqual(ctx.blocker.stopCount, 1);
});

// === I3 (ревью финальной волны): isPending() — синхронный предикат ===
// sessions.js прокидывает его как holdQueueFor(tabId) — Stop на вкладке,
// которая ждёт сброса окна, не должен вбрасывать элемент очереди Ctrl+Q
// (CLI на исчерпанном лимите отбивает вброс мгновенно, и вся очередь сгорела
// бы за секунды до самого пробуждения).

test('isPending: true для вкладки в pending, false для любой другой и для несуществующей', async () => {
  const ctx = setup({ refreshUsage: async () => usageOk({ fiveHourPercent: 95, resetsAt: 1000 }) });
  ctx.nw.arm();
  assert.strictEqual(ctx.nw.isPending('tab1'), false, 'до детекта — ещё не pending');

  await ctx.nw.onTabStop('tab1', 'working');

  assert.strictEqual(ctx.nw.isPending('tab1'), true);
  assert.strictEqual(ctx.nw.isPending('tab2'), false, 'другая вкладка не в pending');
  assert.strictEqual(ctx.nw.isPending('ghost'), false, 'несуществующий tabId — false, не бросает');
});

test('isPending: не armed вовсе — всегда false (pending пуст по построению)', () => {
  const ctx = setup({});
  assert.strictEqual(ctx.nw.isPending('tab1'), false);
});

// === M1+M3 (ревью финальной волны): forget(tabId) — уборка при закрытии вкладки ===

test('forget: закрытие ЕДИНСТВЕННОЙ pending-вкладки снимает блокер и таймер ожидания, пишет tab-closed', async () => {
  const ctx = setup({ refreshUsage: async () => usageOk({ fiveHourPercent: 95, resetsAt: 1000 }) });
  ctx.nw.arm();
  await ctx.nw.onTabStop('tab1', 'working');
  assert.strictEqual(ctx.blocker.startCount, 1);
  assert.strictEqual(ctx.timers.liveCount(), 2, 'ожидание держится на будильнике и стороже');

  ctx.nw.forget('tab1');

  const snap = ctx.nw.snapshot();
  assert.strictEqual(snap.pendingCount, 0);
  assert.strictEqual(snap.wakeAt, null, 'будильник снят — ждать больше нечего');
  assert.strictEqual(ctx.timers.liveCount(), 0, 'таймер ожидания снят');
  assert.strictEqual(ctx.blocker.stopCount, 1, 'блокер снят — pending опустел');
  assert.strictEqual(lastEntry(ctx).type, 'tab-closed');
  assert.strictEqual(lastEntry(ctx).tabId, 'tab1');
});

test('forget: закрытие ОДНОЙ из ДВУХ pending-вкладок НЕ снимает блокер/таймер — вторая всё ещё ждёт', async () => {
  const ctx = setup({ refreshUsage: async () => usageOk({ fiveHourPercent: 95, resetsAt: 1000 }) });
  ctx.nw.arm();
  await ctx.nw.onTabStop('tab1', 'working');
  await ctx.nw.onTabStop('tab2', 'working');
  assert.strictEqual(ctx.nw.snapshot().pendingCount, 2);
  const liveBefore = ctx.timers.liveCount();

  ctx.nw.forget('tab1');

  const snap = ctx.nw.snapshot();
  assert.strictEqual(snap.pendingCount, 1, 'осталась вторая вкладка');
  assert.strictEqual(ctx.nw.isPending('tab2'), true);
  assert.strictEqual(ctx.nw.isPending('tab1'), false);
  assert.strictEqual(ctx.blocker.stopCount, 0, 'блокер НЕ снят — вторая вкладка ещё ждёт');
  assert.strictEqual(ctx.timers.liveCount(), liveBefore, 'таймер ожидания (общий на все pending) не тронут');
  assert.strictEqual(lastEntry(ctx).type, 'tab-closed');
  assert.strictEqual(lastEntry(ctx).tabId, 'tab1');
});

test('forget: вкладка НЕ в pending — no-op, журнал/блокер не трогаются', async () => {
  const ctx = setup({ refreshUsage: async () => usageOk({ fiveHourPercent: 95, resetsAt: 1000 }) });
  ctx.nw.arm();
  await ctx.nw.onTabStop('tab1', 'working');
  const lenBefore = ctx.journal.entries.length;
  const emitCallsBefore = ctx.emit.calls.length;

  ctx.nw.forget('unrelated-tab'); // никогда не была в pending

  assert.strictEqual(ctx.journal.entries.length, lenBefore, 'no-op не пишет в журнал');
  assert.strictEqual(ctx.emit.calls.length, emitCallsBefore, 'no-op не эмитит night:changed');
  assert.strictEqual(ctx.nw.snapshot().pendingCount, 1, 'реальный pending не тронут');
});

test('forget: не armed вовсе, pending пуст — не бросает', () => {
  const ctx = setup({});
  assert.doesNotThrow(() => ctx.nw.forget('tab1'));
});

// === M2 (ревью финальной волны): getTabGen — pty вкладки мог смениться между детектом и пробуждением ===
// Авто-респавн (провал резюма) или ручной Ctrl+Shift+R без sessionId
// (интерактивный ПИКЕР сессий, где голый Enter выбирает произвольную строку)
// — резюм в НЕ ТУ сессию хуже пропущенного.

test('M2: getTabGen не передан вовсе (зависимость не инжектирована) — поведение прежнее, резюм проходит даже если вызывающий передал gen', async () => {
  const statuses = new Map([['tab1', 'done']]);
  const refreshUsage = makeUsageToggle({ resetsAt: 1000 });
  const ctx = setup({ statuses, refreshUsage }); // getTabGen не передан в setup() — undefined
  ctx.nw.arm();
  await ctx.nw.onTabStop('tab1', 'working', 7); // gen=7 от вызывающего, но проверять его нечем без getTabGen
  refreshUsage.markReset();
  ctx.clock.set(1000 + 60000);
  await ctx.timers.fire(ctx.timers.lastId());

  assert.deepStrictEqual(ctx.write.calls, [{ tabId: 'tab1', text: 'продолжай' }]);
});

test('M2: getTabGen передан, entry.gen совпадает с текущим (pty не менялся) → резюм проходит как обычно', async () => {
  const statuses = new Map([['tab1', 'done']]);
  const tabGens = new Map([['tab1', 7]]);
  const getTabGen = (tabId) => tabGens.get(tabId);
  const refreshUsage = makeUsageToggle({ resetsAt: 1000 });
  const ctx = setup({
    statuses, getTabGen, refreshUsage,
  });
  ctx.nw.arm();
  await ctx.nw.onTabStop('tab1', 'working', 7); // gen на момент детекта — 7, совпадает
  refreshUsage.markReset();
  ctx.clock.set(1000 + 60000);
  await ctx.timers.fire(ctx.timers.lastId());

  assert.deepStrictEqual(ctx.write.calls, [{ tabId: 'tab1', text: 'продолжай' }]);
  assert.strictEqual(lastEntry(ctx).type, 'wake-complete');
});

test('M2: getTabGen передан, entry.gen НЕ совпадает с текущим (pty перезапущен между детектом и пробуждением) → skipped pty-restarted, "продолжай" не уходит', async () => {
  const statuses = new Map([['tab1', 'done']]); // формально резюмируемый статус — но gen решает раньше
  const tabGens = new Map([['tab1', 7]]);
  const getTabGen = (tabId) => tabGens.get(tabId);
  const refreshUsage = makeUsageToggle({ resetsAt: 1000 });
  const ctx = setup({
    statuses, getTabGen, refreshUsage,
  });
  ctx.nw.arm();
  await ctx.nw.onTabStop('tab1', 'working', 7); // gen детекта — 7

  // Между детектом и пробуждением вкладка перезапустилась (авто-респавн
  // провала резюма ИЛИ ручной Ctrl+Shift+R) — текущий gen стал другим.
  tabGens.set('tab1', 8);

  refreshUsage.markReset();
  ctx.clock.set(1000 + 60000);
  await ctx.timers.fire(ctx.timers.lastId());

  assert.deepStrictEqual(ctx.write.calls, [], '"продолжай" НЕ должен был уйти — pty уже другой сессии/ПИКЕРА');
  // lastEntry() здесь — 'wake-complete' (единственная вкладка в стаггере,
  // 'wake-complete' пишется СРАЗУ следом за 'skipped' — тот же порядок, что и
  // у остальных skip-сценариев в этом файле, см. тест «waiting/dead/
  // несуществующая вкладка» выше): ищем именно 'skipped' в журнале явно.
  const skipped = ctx.journal.entries.filter((e) => e.type === 'skipped');
  assert.strictEqual(skipped.length, 1);
  assert.strictEqual(skipped[0].tabId, 'tab1');
  assert.strictEqual(skipped[0].detail, 'pty-restarted');
  assert.strictEqual(lastEntry(ctx).type, 'wake-complete');
  assert.strictEqual(lastEntry(ctx).detail, '0 of 1');
});

test('M2: onTabStop без gen (entry.gen===undefined), но getTabGen ИНЖЕКТИРОВАН — проверка пропускается (нечего сравнивать), резюм проходит', async () => {
  const statuses = new Map([['tab1', 'done']]);
  const getTabGen = () => { throw new Error('getTabGen не должен был вызваться — entry.gen===undefined'); };
  const refreshUsage = makeUsageToggle({ resetsAt: 1000 });
  const ctx = setup({
    statuses, getTabGen, refreshUsage,
  });
  ctx.nw.arm();
  await ctx.nw.onTabStop('tab1', 'working'); // gen не передан — third arg отсутствует
  refreshUsage.markReset();
  ctx.clock.set(1000 + 60000);
  await ctx.timers.fire(ctx.timers.lastId());

  assert.deepStrictEqual(ctx.write.calls, [{ tabId: 'tab1', text: 'продолжай' }]);
});

// === dispose() (Important 3, ревью раунд 1 — до этого раунда не покрыт вообще) ===
// Раньше dispose() снимал только таймеры и блокер, но НЕ armed/pending —
// isArmed()/snapshot() продолжали врать «взведено» после закрытия
// приложения, а повисший на await onTabStop, резолвнувшись уже ПОСЛЕ
// dispose(), поднимал НОВЫЙ таймер и НОВЫЙ powerSaveBlocker на выходе из
// процесса ("ядро оживает после dispose()").

test('dispose(): гасит armed/pending синхронно — ядро не оживает после', async () => {
  const ctx = setup({ refreshUsage: async () => usageOk({ fiveHourPercent: 95, resetsAt: 1000 }) });
  ctx.nw.arm();
  await ctx.nw.onTabStop('tab1', 'working');
  assert.strictEqual(ctx.nw.isArmed(), true);
  assert.strictEqual(ctx.timers.liveCount(), 2, 'будильник и сторож');
  assert.strictEqual(ctx.blocker.startCount, 1);

  ctx.nw.dispose();

  assert.strictEqual(ctx.nw.isArmed(), false);
  assert.strictEqual(ctx.nw.snapshot().pendingCount, 0);
  assert.strictEqual(ctx.timers.liveCount(), 0); // таймер ожидания снят
  assert.strictEqual(ctx.blocker.stopCount, 1);
});

test('dispose(): onTabStop, повисший на refreshUsage в момент dispose(), после резолва не создаёт новый таймер/pending', async () => {
  let resolveUsage;
  const usagePromise = new Promise((res) => { resolveUsage = res; });
  const ctx = setup({ refreshUsage: () => usagePromise });
  ctx.nw.arm();

  const stopPromise = ctx.nw.onTabStop('tab1', 'working'); // повис на await
  ctx.nw.dispose();

  resolveUsage(usageOk({ fiveHourPercent: 95, resetsAt: 1000 })); // резолвим уже ПОСЛЕ dispose
  await stopPromise;

  assert.strictEqual(ctx.nw.snapshot().pendingCount, 0);
  assert.strictEqual(ctx.timers.liveCount(), 0); // никакого нового таймера не появилось
});

// === arm/disarm общие свойства ===

test('arm() вызывает journal.reset() перед записью armed', () => {
  const ctx = setup();
  ctx.journal.append({ ts: 0, type: 'stale-from-previous-session' });

  ctx.nw.arm();

  assert.strictEqual(ctx.journal.entries.length, 1);
  assert.strictEqual(ctx.journal.entries[0].type, 'armed');
});

test('повторный arm() — no-op (не сбрасывает журнал заново)', () => {
  const ctx = setup();
  ctx.nw.arm();
  const lenAfterFirst = ctx.journal.entries.length;

  ctx.nw.arm();

  assert.strictEqual(ctx.journal.entries.length, lenAfterFirst);
});

test('isArmed() отражает текущее состояние', () => {
  const ctx = setup();
  assert.strictEqual(ctx.nw.isArmed(), false);
  ctx.nw.arm();
  assert.strictEqual(ctx.nw.isArmed(), true);
  ctx.nw.disarm();
  assert.strictEqual(ctx.nw.isArmed(), false);
});

test('каждый значимый переход эмитит night:changed со свежим снапшотом', async () => {
  const ctx = setup({ refreshUsage: async () => usageOk({ fiveHourPercent: 95, resetsAt: 1000 }) });

  ctx.nw.arm();
  assert.strictEqual(ctx.emit.calls.length, 1);
  assert.strictEqual(ctx.emit.calls[0].event, 'night:changed');
  assert.strictEqual(ctx.emit.calls[0].payload.armed, true);

  await ctx.nw.onTabStop('tab1', 'working');
  assert.ok(ctx.emit.calls.length >= 2);
  assert.strictEqual(ctx.emit.calls[ctx.emit.calls.length - 1].payload.pendingCount, 1);

  ctx.nw.disarm();
  assert.strictEqual(ctx.emit.calls[ctx.emit.calls.length - 1].payload.armed, false);
});

// === снапшот — копии, не ссылки ===

test('snapshot() возвращает копию журнала — мутация снаружи не портит внутреннее состояние', () => {
  const ctx = setup();
  ctx.nw.arm();

  const snap1 = ctx.nw.snapshot();
  snap1.journal.push({ ts: 0, type: 'подделка' });
  snap1.journal[0].type = 'испорчено';

  const snap2 = ctx.nw.snapshot();
  assert.strictEqual(snap2.journal.length, 1);
  assert.strictEqual(snap2.journal[0].type, 'armed');
});

// === ядро никогда не бросает наружу ===

test('внутренняя ошибка (getTabStatus бросает) на пробуждении не выходит наружу — internal-error в журнал', async () => {
  const resetsAt = 1000;
  const refreshUsage = makeUsageToggle({ resetsAt });
  const ctx = setup({
    getTabStatus: () => { throw new Error('бум'); },
    refreshUsage,
  });
  ctx.nw.arm();
  await ctx.nw.onTabStop('tab1', 'working');

  refreshUsage.markReset();
  ctx.clock.set(resetsAt + 60000);
  await assert.doesNotReject(async () => { await ctx.timers.fire(ctx.timers.lastId()); });

  assert.strictEqual(lastEntry(ctx).type, 'internal-error');
});

test('дефолты конфига применяются, если config не передан явно', async () => {
  const ctx = setup({ refreshUsage: async () => usageOk({ fiveHourPercent: 94 }) });
  ctx.nw.arm();
  await ctx.nw.onTabStop('tab1', 'working'); // 94 < дефолтных 95 → тишина
  assert.strictEqual(ctx.nw.snapshot().pendingCount, 0);

  const ctx2 = setup({ refreshUsage: async () => usageOk({ fiveHourPercent: 95, resetsAt: 1 }) });
  ctx2.nw.arm();
  await ctx2.nw.onTabStop('tab1', 'working'); // 95 >= дефолтных 95 → limit-stop
  assert.strictEqual(ctx2.nw.snapshot().pendingCount, 1);
});

test('переданный config переопределяет дефолт (fiveHourThreshold)', async () => {
  const ctx = setup({
    config: { fiveHourThreshold: 50 },
    refreshUsage: async () => usageOk({ fiveHourPercent: 60, resetsAt: 1 }),
  });
  ctx.nw.arm();
  await ctx.nw.onTabStop('tab1', 'working');
  assert.strictEqual(ctx.nw.snapshot().pendingCount, 1);
});

// === ре-ревью раунда 1: N1/N2/N3 ===

// N2: resetsAt «только что в прошлом» (секундное расхождение часов клиент/
// сервер) — детект НЕ выбрасывается: момент пробуждения resetsAt+margin ещё
// в будущем, будильник полностью рабочий. Раньше гард сравнивал сам resetsAt
// с now() и молча ронял честный детект — вкладка не продолжалась за ночь.
test('N2: resetsAt чуть в прошлом (часы разошлись) → детект живёт, будильник на resetsAt+margin', async () => {
  const clock = makeClock(10000);
  const resetsAt = 7000; // на 3 секунды «в прошлом»
  const ctx = setup({
    clock,
    refreshUsage: async () => usageOk({ fiveHourPercent: 96, resetsAt }),
  });
  ctx.nw.arm();

  await ctx.nw.onTabStop('tab1', 'working');

  const snap = ctx.nw.snapshot();
  assert.strictEqual(snap.pendingCount, 1, 'детект не должен быть отброшен');
  assert.strictEqual(snap.wakeAt, resetsAt + 60000); // 67000 > now=10000 — в будущем
  assert.strictEqual(lastEntry(ctx).type, 'limit-stop');
});

// N1: хвост стаггера ПРОШЛОГО взвода (переживший disarm→arm) не должен
// затирать живой дескриптор таймера нового прохода — иначе dispose() его
// не снимет и «прервано» напишется уже после выхода из приложения.
test('N1: выстрел хвоста старого взвода не обнуляет staggerTimer нового прохода', async () => {
  // staggerMs больше wakeMarginMs — единственная конфигурация, где хвост
  // старого прохода может дожить до стаггера нового (см. коммент N1 в ядре).
  const cfg = { staggerMs: 100000, wakeMarginMs: 1000, retryMs: 500 };
  const clock = makeClock(0);
  const timers = fakeTimers();
  const statuses = new Map([['a', 'done'], ['b', 'done'], ['c', 'done'], ['d', 'done']]);
  const refreshUsage = makeUsageToggle({ resetsAt: 5000 });
  const ctx = setup({ clock, timers, statuses, refreshUsage, config: cfg });
  ctx.nw.arm();

  // Взвод №1: две вкладки → пробуждение → первая сразу, хвост для второй запланирован.
  await ctx.nw.onTabStop('a', 'working');
  await ctx.nw.onTabStop('b', 'working');
  refreshUsage.markReset();
  clock.set(7000);
  const wait1 = ctx.timers.lastId();
  await ctx.timers.fire(wait1); // doWake: резюм 'a', хвост 'b' на +staggerMs
  const oldTail = ctx.timers.lastId();

  // Перевзвод: хвост старого прохода ещё жив (staggerMs=100000 больше
  // wakeMarginMs=1000, см. комментарий у cfg выше). Новый детект тут не
  // нужен — для N1 достаточно, что выстрел хвоста не трогает чужое
  // состояние И что после него dispose() снимает всё живое.
  ctx.nw.disarm();
  ctx.nw.arm();
  const before = ctx.nw.snapshot();
  await ctx.timers.fire(oldTail); // хвост старого взвода (delta >= 2 — молчание)
  const after = ctx.nw.snapshot();
  assert.deepStrictEqual(
    { armed: after.armed, pendingCount: after.pendingCount, journalLen: after.journal.length },
    { armed: before.armed, pendingCount: before.pendingCount, journalLen: before.journal.length },
    'хвост старого взвода не должен менять состояние нового',
  );
  // Ключевой ассерт N1: dispose снимает ВСЕ живые таймеры — ничего не переживает его.
  ctx.nw.dispose();
  assert.strictEqual(ctx.timers.liveCount(), 0, 'после dispose живых таймеров быть не должно');
});

// N3: детект, дорезолвившийся во время await пробуждения, ставил СВОЙ
// waitTimer, который ветка windowReset не снимала: он стрелял позже с пустым
// pending, сжигал слот maxResets и писал фантомный «wake-complete: 0 of 0».
test('N3: windowReset снимает будильник конкурентного детекта — фантомного пробуждения нет', async () => {
  const clock = makeClock(0);
  const timers = fakeTimers();
  const statuses = new Map([['a', 'done'], ['b', 'done']]);
  let phase = 'limit'; // 'limit' → детекты видят 96%; 'reset' → пробуждение видит 10%
  let releaseWake = null;
  const refreshUsage = () => {
    if (phase === 'limit') return Promise.resolve(usageOk({ fiveHourPercent: 96, resetsAt: 5000 }));
    // Пробуждение: подвешиваем промис, чтобы тест успел вклинить конкурентный детект.
    return new Promise((resolve) => {
      releaseWake = () => resolve(usageOk({ fiveHourPercent: 10 }));
    });
  };
  const ctx = setup({ clock, timers, statuses, refreshUsage });
  ctx.nw.arm();

  await ctx.nw.onTabStop('a', 'working');
  const wait1 = ctx.timers.lastId();

  phase = 'reset';
  clock.set(66000);
  const wakePromise = ctx.timers.fire(wait1); // doWake повис на refreshUsage

  // Конкурентный детект во время await: пока doWake ждёт сеть, вкладка b
  // упирается в лимит (детект идёт по СВОЕЙ фазе — подсовываем через
  // прямой резолв: phase уже 'reset', поэтому шлём Stop руками с limit-фазой).
  phase = 'limit';
  const detectPromise = ctx.nw.onTabStop('b', 'working');
  phase = 'reset';
  await detectPromise; // b в pending, у него СВОЙ waitTimer
  releaseWake();
  await wakePromise;

  // Ветка windowReset обязана была снять будильник конкурентного детекта:
  // после завершения стаггер-прохода живых waitTimer'ов не остаётся.
  // (Хвост стаггера для 'b' — часть текущего прохода, добиваем его.)
  while (ctx.timers.liveCount() > 0) {
    await ctx.timers.fire(ctx.timers.lastId());
  }
  const wakeCompletes = ctx.journal.entries.filter((e) => e.type === 'wake-complete');
  assert.strictEqual(wakeCompletes.length, 1, 'ровно одно настоящее пробуждение');
  assert.strictEqual(ctx.nw.snapshot().resetsHandled, 1, 'фантом не сжёг слот maxResets');
});

// N1 (ре-ревью финальной волны): forget() опустошает pending, пока doWake
// висит на await refreshUsage (пользователь закрыл последнюю ждущую вкладку
// во время сетевого запроса) — ни ретраев при пустом pending, ни сожжённого
// слота maxResets, будильник и блокер сняты.
test('N1: forget последней pending-вкладки во время await пробуждения → ни ретрая, ни слота, таймер снят', async () => {
  const clock = makeClock(0);
  const timers = fakeTimers();
  const statuses = new Map([['a', 'done']]);
  let phase = 'limit';
  let releaseWake = null;
  const refreshUsage = () => {
    if (phase === 'limit') return Promise.resolve(usageOk({ fiveHourPercent: 96, resetsAt: 5000 }));
    return new Promise((resolve) => {
      releaseWake = () => resolve(usageOk({ fiveHourPercent: 10 }));
    });
  };
  const ctx = setup({ clock, timers, statuses, refreshUsage });
  ctx.nw.arm();

  await ctx.nw.onTabStop('a', 'working');
  assert.strictEqual(ctx.nw.snapshot().pendingCount, 1);

  phase = 'reset';
  clock.set(66000);
  const wakePromise = ctx.timers.fire(ctx.timers.lastId()); // doWake повис на refreshUsage

  ctx.nw.forget('a'); // закрытие последней ждущей вкладки
  releaseWake();
  await wakePromise;

  const snap = ctx.nw.snapshot();
  assert.strictEqual(snap.resetsHandled, 0, 'слот maxResets не сожжён');
  assert.strictEqual(snap.wakeAt, null, 'фантомный будильник не запланирован');
  assert.strictEqual(ctx.timers.liveCount(), 0, 'живых таймеров нет');
  const types = ctx.journal.entries.map((e) => e.type);
  assert.ok(!types.includes('retry'), 'ретраев при пустом pending нет');
  assert.ok(!types.includes('wake-complete'), 'фантомного пробуждения нет');
  assert.strictEqual(ctx.blocker.startCount, ctx.blocker.stopCount, 'блокер снят');
});

// === сон машины: будильник обязан пережить его (ревью 09.08, находка A7) ===
//
// Вся фича держалась на ОДНОМ длинном setTimeout до момента сброса лимита.
// powerSaveBlocker удерживает систему от АВТОсна, но не от ручного «Сон»,
// закрытой крышки, гибернации по разряду и отказа самого блокера. Поведение
// длинных таймеров Node/Electron после resume на Windows недетерминировано:
// таймер может «доспать» остаток уже после пробуждения машины (то есть
// выстрелить на часы позже срока) или не выстрелить до утра.
//
// Отказ при этом тихий: в журнале останется armed + limit-stop и больше
// ничего, а фича именно ради этого момента и существует. Поэтому в ядре есть
// сторож: короткий повторяющийся таймер, который сам замечает, что срок
// вышел, и будит. Короткие таймеры переживают resume несравнимо надёжнее.

test('сон: длинный таймер не выстрелил, сторож будит сам', async () => {
  const resetsAt = 100000;
  const usage = makeUsageToggle({ resetsAt });
  const ctx = setup({ refreshUsage: usage, statuses: new Map([['tab1', 'done']]) });
  ctx.nw.arm();
  await ctx.nw.onTabStop('tab1', 'working');

  const wakeAt = ctx.nw.snapshot().wakeAt;
  const guard = watchdogId(ctx.timers);
  assert.ok(guard, 'сторож не запланирован — будильник остался без страховки на случай сна');

  // Машина спала: время ушло далеко за срок, а основной таймер не выстрелил.
  usage.markReset();
  ctx.clock.set(wakeAt + 3600000);

  await ctx.timers.fire(guard);
  await Promise.resolve();

  const types = ctx.journal.entries.map((e) => e.type);
  assert.ok(types.includes('wake-complete'), `пробуждения не случилось: ${types.join(', ')}`);
  assert.strictEqual(ctx.write.calls.length, 1, 'вкладке не отправили «продолжай»');
  // Живых таймеров не остаётся — в том числе того самого длинного будильника,
  // который в этот момент ещё не выстрелил. Ревью фикса показало цену
  // осиротевшего хендла: он доспит своё часы спустя, посреди СЛЕДУЮЩЕГО цикла
  // ожидания, собьёт его wakeAt, снимет его сторожа и уведёт ночь в ретраи до
  // gave-up — то есть тихий отказ, против которого весь фикс и писался.
  assert.strictEqual(ctx.timers.liveCount(), 0, 'после пробуждения через сторожа остался живой таймер');
});

test('сторож не будит раньше срока, а ждёт дальше', async () => {
  const resetsAt = 100000;
  const ctx = setup({
    refreshUsage: makeUsageToggle({ resetsAt }),
    statuses: new Map([['tab1', 'done']]),
  });
  ctx.nw.arm();
  await ctx.nw.onTabStop('tab1', 'working');

  const guard = watchdogId(ctx.timers);
  ctx.clock.set(50000); // до срока ещё далеко

  await ctx.timers.fire(guard);
  await Promise.resolve();

  const types = ctx.journal.entries.map((e) => e.type);
  assert.ok(!types.includes('wake-complete'), 'сторож разбудил раньше времени');
  assert.ok(watchdogId(ctx.timers), 'сторож обязан перепланировать себя, а не умолкнуть до утра');
  assert.strictEqual(ctx.nw.snapshot().wakeAt, resetsAt + 60000, 'срок будильника не должен меняться');
});

test('первый вошедший в пробуждение снимает таймер конкурента', async () => {
  // Оба пути ведут в одну функцию, и после сна машины могут сработать почти
  // одновременно. Раньше вход в пробуждение просто обнулял хендл будильника,
  // не снимая его, — конкурент оставался жив. Теперь первый вошедший снимает
  // его явно, и второго входа не существует в принципе.
  //
  // Ревью фикса показало, почему это важнее «двойного продолжай»: в
  // ретрай-ветке (окно ещё не сброшено) pending НЕ очищается, и два прохода
  // нарастили бы retries вдвое, спалив окно ожидания в два раза быстрее.
  const resetsAt = 100000;
  const usage = makeUsageToggle({ resetsAt });
  const ctx = setup({ refreshUsage: usage, statuses: new Map([['tab1', 'done']]) });
  ctx.nw.arm();
  await ctx.nw.onTabStop('tab1', 'working');

  const guard = watchdogId(ctx.timers);
  const alarm = alarmId(ctx.timers);
  usage.markReset();
  ctx.clock.set(resetsAt + 60000);

  await ctx.timers.fire(guard); // будит сторож — будильник ещё жив
  await Promise.resolve();

  assert.throws(
    () => ctx.timers.fire(alarm),
    /не запланирован|уже снят/,
    'будильник пережил пробуждение через сторожа и выстрелит сиротой посреди следующего цикла',
  );

  const completes = ctx.journal.entries.filter((e) => e.type === 'wake-complete');
  assert.strictEqual(completes.length, 1, 'пробуждение обязано случиться ровно один раз');
  assert.strictEqual(ctx.write.calls.length, 1, '«продолжай» отправлено дважды');
});

test('ретрай-ветка: сторожевое пробуждение не сжигает окно вдвое', async () => {
  // Самый дорогой случай двойного прохода: окно ещё не сброшено, pending не
  // очищается, и второй проход нарастил бы retries второй раз.
  const resetsAt = 100000;
  const ctx = setup({
    refreshUsage: async () => usageOk({ fiveHourPercent: 99, resetsAt }),
    statuses: new Map([['tab1', 'done']]),
  });
  ctx.nw.arm();
  await ctx.nw.onTabStop('tab1', 'working');

  ctx.clock.set(resetsAt + 60000);
  await ctx.timers.fire(watchdogId(ctx.timers));
  await Promise.resolve();
  await Promise.resolve();

  const retriesLogged = ctx.journal.entries.filter((e) => e.type === 'retry');
  assert.strictEqual(retriesLogged.length, 1, `окно сгорело за один заход: ${retriesLogged.length} ретраев`);
  assert.strictEqual(retriesLogged[0].detail, '1 (tab1)', 'счётчик ретраев ушёл вперёд');
});

test('сторож снимается вместе со взводом', async () => {
  const ctx = setup({
    refreshUsage: makeUsageToggle({ resetsAt: 100000 }),
    statuses: new Map([['tab1', 'done']]),
  });
  ctx.nw.arm();
  await ctx.nw.onTabStop('tab1', 'working');
  assert.ok(ctx.timers.liveCount() >= 2, 'ожидались будильник и сторож');

  ctx.nw.disarm();
  assert.strictEqual(ctx.timers.liveCount(), 0, 'после disarm не должно остаться живых таймеров');
});

// === окно ретраев: ночной отвал сети не должен съедать всю ночь ===

test('ретраи расходятся по времени, а не долбят с одним интервалом', async () => {
  // Было: 3 попытки по 5 минут — всего ~16 минут. Любой ночной транзиент
  // длиннее (Wi-Fi на USB-адаптере, 401 до обновления токена с его
  // 15-минутным бэкоффом, 429 с десятиминутным) съедал всю ночь: после
  // gave-up pending чистится, блокер снимается, и машина засыпает.
  const resetsAt = 100000;
  const ctx = setup({
    // Окно так и не сбросилось: каждый опрос возвращает «лимит всё ещё выбран».
    refreshUsage: async () => usageOk({ fiveHourPercent: 99, resetsAt }),
    statuses: new Map([['tab1', 'done']]),
  });
  ctx.nw.arm();
  await ctx.nw.onTabStop('tab1', 'working');

  // Гоняем цикл «дождались срока → опросили → снова не сброшено» и смотрим,
  // какую задержку ядро закладывает в следующий будильник. Задержку берём у
  // самого таймера (он планируется последним, см. scheduleWaitAt), а не
  // вычисляем из снапшота — так тест не зависит от того, как двигается клок.
  const delays = [];
  for (let i = 0; i < 4; i += 1) {
    const alarm = alarmId(ctx.timers);
    if (!alarm) break;
    const due = ctx.nw.snapshot().wakeAt;
    if (due === null) break;
    // Считаем ретраи ДО и ПОСЛЕ: иначе «пробуждение молча не случилось»
    // (например, залип внутренний флаг) выглядело бы как успешный ретрай с
    // прежней задержкой — на этом тест уже один раз меня обманул.
    const before = ctx.journal.entries.filter((e) => e.type === 'retry').length;
    ctx.clock.set(due);
    await ctx.timers.fire(alarm);
    await Promise.resolve();
    await Promise.resolve();
    const after = ctx.journal.entries.filter((e) => e.type === 'retry').length;
    if (after !== before + 1) break; // нового ретрая не случилось — дальше смотреть нечего
    delays.push(ctx.timers.lastMs());
  }

  // Точные значения, а не только «растёт»: удвоение и потолок — это и есть
  // обещанное окно ожидания, и молчаливая замена формулы (скажем, +1 минута
  // за шаг) прошла бы проверку на монотонность незамеченной.
  assert.deepStrictEqual(
    delays.slice(0, 4),
    [300000, 600000, 1200000, 1800000],
    `ожидались 5, 10, 20 и 30 минут (последняя — по потолку), получили ${delays.join(', ')}`,
  );
});
