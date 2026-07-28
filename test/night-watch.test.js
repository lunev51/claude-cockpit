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
  };
}

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
  assert.strictEqual(ctx.timers.liveCount(), 1);
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
test('Critical 2: resetsAt уже в прошлом → no-resets-at, будильник не планируется в прошлое', async () => {
  const ctx = setup({ refreshUsage: async () => usageOk({ fiveHourPercent: 95, resetsAt: -5000 }) });
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
  assert.strictEqual(ctx.timers.liveCount(), 1);
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
