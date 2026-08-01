'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createCcusage } = require('../src/main/usage-ccusage');

// Реальные образцы вывода (сняты контролёром 28.07 на этой машине,
// ccusage 20.0.19): `npx ccusage@latest claude daily --json` и
// `npx ccusage@latest claude session --json`, урезаны до нескольких
// записей. totals намеренно НЕ равны сумме по урезанному массиву daily —
// это отдельное поле реального ответа (за всю историю), и модуль обязан
// брать costUsd/tokens из body.totals напрямую, а не пересчитывать их по
// (в проде — полному, а здесь урезанному) массиву daily.
const DAILY_SAMPLE = {
  daily: [
    {
      date: '2026-07-26',
      totalCost: 151.41965985000004,
      totalTokens: 108959254,
      modelBreakdowns: [
        { modelName: 'claude-fable-5', cost: 134.53325950000018, cacheCreationTokens: 2782804, cacheReadTokens: 61502692, inputTokens: 10539, outputTokens: 427466 },
        { modelName: 'claude-sonnet-5', cost: 14.329763299999989, cacheCreationTokens: 1772936, cacheReadTokens: 29447769, inputTokens: 5121, outputTokens: 395499 },
        { modelName: 'claude-haiku-4-5-20251001', cost: 2.55663705, cacheCreationTokens: 691955, cacheReadTokens: 11819213, inputTokens: 1632, outputTokens: 101628 },
      ],
    },
    {
      date: '2026-07-27',
      totalCost: 163.03675820000007,
      totalTokens: 275280318,
      modelBreakdowns: [
        { modelName: 'claude-opus-5', cost: 72.53593724999996, cacheCreationTokens: 2350593, cacheReadTokens: 86883082, inputTokens: 10946, outputTokens: 305361 },
        { modelName: 'claude-sonnet-5', cost: 52.77387729999997, cacheCreationTokens: 4682294, cacheReadTokens: 151557029, inputTokens: 14101, outputTokens: 1066013 },
        { modelName: 'claude-fable-5', cost: 36.382249, cacheCreationTokens: 523550, cacheReadTokens: 23267449, inputTokens: 90, outputTokens: 52858 },
        { modelName: 'claude-haiku-4-5-20251001', cost: 1.3446946499999999, cacheCreationTokens: 446463, cacheReadTokens: 4043219, inputTokens: 1014, outputTokens: 76256 },
      ],
    },
    {
      date: '2026-07-28',
      totalCost: 26.7257021,
      totalTokens: 45366832,
      modelBreakdowns: [
        { modelName: 'claude-opus-5', cost: 16.855635000000003, cacheCreationTokens: 747076, cacheReadTokens: 17297890, inputTokens: 46, outputTokens: 29428 },
        { modelName: 'claude-sonnet-5', cost: 9.804390900000003, cacheCreationTokens: 1052745, cacheReadTokens: 25979112, inputTokens: 403, outputTokens: 197590 },
        { modelName: 'claude-haiku-4-5-20251001', cost: 0.0656762, cacheCreationTokens: 36676, cacheReadTokens: 22332, inputTokens: 18, outputTokens: 3516 },
      ],
    },
  ],
  totals: {
    totalCost: 3497.0001703000003,
    totalTokens: 3259839320,
  },
};

const SESSION_SAMPLE = {
  sessions: [
    {
      sessionId: '9b7ec29c-53ae-4311-a1d1-652d4250a9fe',
      projectPath: 'C--Users-Lunev-helper',
      totalCost: 692.0787967499992,
      totalTokens: 774938313,
      lastActivity: '2026-07-23T23:40:04.493Z',
    },
    {
      sessionId: 'f09fe98a-dc3d-46b1-8878-22f9a103de20',
      projectPath: 'C--Users-Lunev-helper',
      totalCost: 348.2683375000005,
      totalTokens: 387800673,
      lastActivity: '2026-07-24T22:10:09.913Z',
    },
    {
      sessionId: '35ea3390-6aa7-4cfb-b20f-9ae5835b5a7f',
      projectPath: 'C--Users-Lunev-akto',
      totalCost: 683.3693207499987,
      totalTokens: 531470253,
      lastActivity: '2026-07-16T11:50:29.331Z',
    },
    {
      sessionId: 'b233b475-2b53-49ff-bb24-5860c3328a07',
      projectPath: 'C--Users-Lunev-akto-akto-smm-bot',
      totalCost: 0.3116525,
      totalTokens: 73038,
      lastActivity: '2026-07-14T13:59:04.168Z',
    },
  ],
};

function ok(body) {
  return { code: 0, stdout: JSON.stringify(body), stderr: '' };
}

function noopCache() {
  return { read: () => null, write: () => {} };
}

function runFixture({ dailyBody = DAILY_SAMPLE, sessionBody = SESSION_SAMPLE, calls } = {}) {
  return async (args) => {
    if (calls) calls.push(args);
    if (args[0] === 'claude' && args[1] === 'daily') return ok(dailyBody);
    if (args[0] === 'claude' && args[1] === 'session') return ok(sessionBody);
    throw new Error(`неожиданные args в run(): ${JSON.stringify(args)}`);
  };
}

test('успешный разбор реального образца: totals из body.totals, byModel/byProject/byDay агрегированы и отсортированы', async () => {
  const calls = [];
  const ccusage = createCcusage({ run: runFixture({ calls }), cache: noopCache(), now: () => 1000 });

  const snap = await ccusage.get();

  assert.strictEqual(snap.ok, true);
  assert.strictEqual(snap.stale, false);
  assert.strictEqual(snap.error, null);
  assert.strictEqual(snap.fetchedAt, 1000);

  // totals — напрямую из body.totals обоих вызовов, не пересчитаны по урезанному daily[].
  assert.strictEqual(snap.totals.costUsd, 3497);
  assert.strictEqual(snap.totals.tokens, 3259839320);
  assert.strictEqual(snap.totals.sessions, 4);

  // byDay: 3 дня, по возрастанию даты, суммы округлены до центов.
  assert.deepStrictEqual(snap.byDay, [
    { date: '2026-07-26', costUsd: 151.42, tokens: 108959254 },
    { date: '2026-07-27', costUsd: 163.04, tokens: 275280318 },
    { date: '2026-07-28', costUsd: 26.73, tokens: 45366832 },
  ]);

  // byModel: агрегировано по modelName через все дни, отсортировано по costUsd убыв.
  assert.deepStrictEqual(snap.byModel, [
    { model: 'claude-fable-5', costUsd: 170.92, tokens: 88567448 },
    { model: 'claude-opus-5', costUsd: 89.39, tokens: 107624422 },
    { model: 'claude-sonnet-5', costUsd: 76.91, tokens: 216170612 },
    { model: 'claude-haiku-4-5-20251001', costUsd: 3.97, tokens: 17243922 },
  ]);

  // byProject: сессии одного projectPath объединены (сумма cost/tokens, lastActive = max lastActivity).
  assert.deepStrictEqual(snap.byProject, [
    { name: 'C--Users-Lunev-helper', costUsd: 1040.35, tokens: 1162738986, lastActive: Date.parse('2026-07-24T22:10:09.913Z') },
    { name: 'C--Users-Lunev-akto', costUsd: 683.37, tokens: 531470253, lastActive: Date.parse('2026-07-16T11:50:29.331Z') },
    { name: 'C--Users-Lunev-akto-akto-smm-bot', costUsd: 0.31, tokens: 73038, lastActive: Date.parse('2026-07-14T13:59:04.168Z') },
  ]);

  assert.strictEqual(calls.length, 2);
  // Инцидент 8ГБ: к базовым args добавились --since <окно 40д> и --offline —
  // точные значения проверяет отдельный тест ниже, здесь фиксируем префикс.
  assert.deepStrictEqual(calls.find((a) => a[1] === 'daily').slice(0, 3), ['claude', 'daily', '--json']);
  assert.deepStrictEqual(calls.find((a) => a[1] === 'session').slice(0, 3), ['claude', 'session', '--json']);
});

test('get() запускает daily и session ПАРАЛЛЕЛЬНО (Promise.all), а не по очереди', async () => {
  let sessionStarted = false;
  let dailyObservedSessionStarted = false;
  const run = async (args) => {
    if (args[1] === 'daily') {
      await new Promise((r) => setTimeout(r, 20));
      dailyObservedSessionStarted = sessionStarted; // к моменту завершения daily session уже должен был стартовать
      return ok(DAILY_SAMPLE);
    }
    if (args[1] === 'session') {
      sessionStarted = true;
      return ok(SESSION_SAMPLE);
    }
    throw new Error('unreachable');
  };
  const ccusage = createCcusage({ run, cache: noopCache(), now: () => 1 });

  await ccusage.get();

  assert.strictEqual(dailyObservedSessionStarted, true, 'session должен был стартовать до завершения daily — вызовы не последовательны');
});

test('byDay: даты приходят не по порядку → сортируем по возрастанию сами, не полагаемся на порядок ccusage', async () => {
  const shuffledDaily = {
    daily: [
      { date: '2026-07-15', totalCost: 3, totalTokens: 300, modelBreakdowns: [] },
      { date: '2026-07-10', totalCost: 1, totalTokens: 100, modelBreakdowns: [] },
      { date: '2026-07-12', totalCost: 2, totalTokens: 200, modelBreakdowns: [] },
    ],
    totals: { totalCost: 6, totalTokens: 600 },
  };
  const ccusage = createCcusage({
    run: runFixture({ dailyBody: shuffledDaily, sessionBody: { sessions: [] } }),
    cache: noopCache(),
    now: () => 1,
  });

  const snap = await ccusage.get();

  assert.deepStrictEqual(snap.byDay.map((d) => d.date), ['2026-07-10', '2026-07-12', '2026-07-15']);
});

test('byDay: больше 30 дней в ответе → оставляем последние 30 по дате', async () => {
  const days = [];
  for (let i = 0; i < 35; i++) {
    const d = new Date(Date.UTC(2026, 0, 1 + i));
    days.push({ date: d.toISOString().slice(0, 10), totalCost: i, totalTokens: i * 1000, modelBreakdowns: [] });
  }
  const dailyBody = { daily: days, totals: { totalCost: 999, totalTokens: 999000 } };
  const ccusage = createCcusage({
    run: runFixture({ dailyBody, sessionBody: { sessions: [] } }),
    cache: noopCache(),
    now: () => 1,
  });

  const snap = await ccusage.get();

  assert.strictEqual(snap.byDay.length, 30);
  assert.strictEqual(snap.byDay[0].date, days[5].date); // первые 5 дней отброшены
  assert.strictEqual(snap.byDay[29].date, days[34].date);
});

test('валидный JSON без нужных секций (daily/sessions отсутствуют) → ok:true, пустые массивы, нули', async () => {
  const ccusage = createCcusage({
    run: runFixture({ dailyBody: {}, sessionBody: {} }),
    cache: noopCache(),
    now: () => 1,
  });

  const snap = await ccusage.get();

  assert.strictEqual(snap.ok, true);
  assert.strictEqual(snap.error, null);
  assert.deepStrictEqual(snap.totals, { costUsd: 0, tokens: 0, sessions: 0 });
  assert.deepStrictEqual(snap.byProject, []);
  assert.deepStrictEqual(snap.byDay, []);
  assert.deepStrictEqual(snap.byModel, []);
});

test('свежий кэш (моложе ttlMs) → run() вообще не вызывается', async () => {
  const cached = {
    totals: { costUsd: 10, tokens: 100, sessions: 1 },
    byProject: [{ name: 'p', costUsd: 10, tokens: 100, lastActive: 500 }],
    byDay: [{ date: '2026-07-01', costUsd: 10, tokens: 100 }],
    byModel: [{ model: 'm', costUsd: 10, tokens: 100 }],
    fetchedAt: 1000,
  };
  const run = async () => { throw new Error('run НЕ должен вызываться при свежем кэше'); };
  const ccusage = createCcusage({
    run,
    cache: { read: () => cached, write: () => { throw new Error('write не должен вызываться, если данные не менялись'); } },
    now: () => 1000 + 599999, // moложе ttl по умолчанию (600000)
  });

  const snap = await ccusage.get();

  assert.strictEqual(snap.ok, true);
  assert.strictEqual(snap.stale, false);
  assert.strictEqual(snap.error, null);
  assert.strictEqual(snap.fetchedAt, 1000);
  assert.deepStrictEqual(snap.totals, cached.totals);
  assert.deepStrictEqual(snap.byProject, cached.byProject);
});

test('устаревший кэш (старше ttlMs) → run() вызывается заново, кэш перезаписывается', async () => {
  const cached = {
    totals: { costUsd: 10, tokens: 100, sessions: 1 },
    byProject: [],
    byDay: [],
    byModel: [],
    fetchedAt: 1000,
  };
  let written = null;
  const ccusage = createCcusage({
    run: runFixture({}),
    cache: { read: () => cached, write: (v) => { written = v; } },
    now: () => 1000 + 600001, // строго старше ttl по умолчанию
  });

  const snap = await ccusage.get();

  assert.strictEqual(snap.ok, true);
  assert.strictEqual(snap.stale, false);
  assert.strictEqual(snap.fetchedAt, 1000 + 600001);
  assert.strictEqual(snap.totals.costUsd, 3497);
  assert.ok(written, 'ожидали cache.write() с новыми данными');
  assert.strictEqual(written.fetchedAt, 1000 + 600001);
});

test('force:true игнорирует свежесть кэша и всё равно бьёт по run()', async () => {
  const cached = {
    totals: { costUsd: 10, tokens: 100, sessions: 1 },
    byProject: [], byDay: [], byModel: [],
    fetchedAt: 1000,
  };
  let calls = 0;
  const ccusage = createCcusage({
    run: async (args) => { calls++; return runFixture({})(args); },
    cache: { read: () => cached, write: () => {} },
    now: () => 1000 + 1, // моложе ttl
  });

  const snap = await ccusage.get({ force: true });

  assert.strictEqual(calls, 2); // daily + session
  assert.strictEqual(snap.totals.costUsd, 3497);
});

test('дефолтный ttlMs = 600000: ровно на границе (600000) кэш уже НЕ свежий', async () => {
  const cached = { totals: { costUsd: 1, tokens: 1, sessions: 0 }, byProject: [], byDay: [], byModel: [], fetchedAt: 1000 };
  let ran = false;
  const ccusage = createCcusage({
    run: async (args) => { ran = true; return runFixture({})(args); },
    cache: { read: () => cached, write: () => {} },
    now: () => 1000 + 600000,
  });

  await ccusage.get();

  assert.strictEqual(ran, true, 'age === ttlMs должен считаться уже НЕ свежим');
});

test('run() бросает исключение, кэша нет → ok:false, error:unavailable, не бросает наружу', async () => {
  const ccusage = createCcusage({
    run: async () => { throw new Error('ENOENT: npx not found'); },
    cache: noopCache(),
    now: () => 1,
  });

  const snap = await ccusage.get();

  assert.strictEqual(snap.ok, false);
  assert.strictEqual(snap.stale, false);
  assert.strictEqual(snap.error, 'unavailable');
  assert.deepStrictEqual(snap.totals, { costUsd: 0, tokens: 0, sessions: 0 });
  assert.deepStrictEqual(snap.byProject, []);
});

test('run() возвращает code!=0, кэша нет → ok:false, error:unavailable', async () => {
  const ccusage = createCcusage({
    run: async () => ({ code: 1, stdout: '', stderr: 'boom' }),
    cache: noopCache(),
    now: () => 1,
  });

  const snap = await ccusage.get();

  assert.strictEqual(snap.ok, false);
  assert.strictEqual(snap.error, 'unavailable');
});

test('run() вернул code:0, но stdout не парсится как JSON → error:parse', async () => {
  const ccusage = createCcusage({
    run: async () => ({ code: 0, stdout: 'not json at all', stderr: '' }),
    cache: noopCache(),
    now: () => 1,
  });

  const snap = await ccusage.get();

  assert.strictEqual(snap.ok, false);
  assert.strictEqual(snap.error, 'parse');
});

test('сбой при наличии кэша: stale:true, прежние данные сохраняются, error проставлен', async () => {
  const cached = {
    totals: { costUsd: 55, tokens: 5000, sessions: 2 },
    byProject: [{ name: 'p', costUsd: 55, tokens: 5000, lastActive: 10 }],
    byDay: [{ date: '2026-07-01', costUsd: 55, tokens: 5000 }],
    byModel: [{ model: 'm', costUsd: 55, tokens: 5000 }],
    fetchedAt: 999,
  };
  const ccusage = createCcusage({
    run: async () => { throw new Error('ECONNRESET'); },
    cache: { read: () => cached, write: () => {} },
    now: () => 999 + 700000, // старше ttl — попробуем перезапросить, упадём, откатимся на кэш
  });

  const snap = await ccusage.get();

  assert.strictEqual(snap.ok, true);
  assert.strictEqual(snap.stale, true);
  assert.strictEqual(snap.error, 'unavailable');
  assert.strictEqual(snap.fetchedAt, 999);
  assert.deepStrictEqual(snap.totals, cached.totals);
  assert.deepStrictEqual(snap.byProject, cached.byProject);
});

test('кэш с некорректной формой (totals.costUsd не число) отвергается — трактуем как отсутствие кэша', async () => {
  const badCache = { totals: { costUsd: 'oops', tokens: 1, sessions: 0 }, byProject: [], byDay: [], byModel: [], fetchedAt: 1000 };
  const ccusage = createCcusage({
    run: async () => { throw new Error('ECONNRESET'); },
    cache: { read: () => badCache, write: () => {} },
    now: () => 1000 + 1, // формально "свежий" по времени, но форма кэша битая
  });

  const snap = await ccusage.get();

  assert.strictEqual(snap.ok, false);
  assert.strictEqual(snap.stale, false);
});

test('cache.read()/cache.write() бросают исключения — get() всё равно не падает', async () => {
  const ccusage = createCcusage({
    run: runFixture({}),
    cache: {
      read: () => { throw new Error('disk error'); },
      write: () => { throw new Error('disk full'); },
    },
    now: () => 1,
  });

  const snap = await ccusage.get();

  assert.strictEqual(snap.ok, true);
  assert.strictEqual(snap.totals.costUsd, 3497);
});

test('single-flight: два одновременных get({force:true}) шарят ОДИН запрос — run() вызывается ровно раз (daily+session), а не дважды, и оба вызова получают идентичный результат', async () => {
  const calls = [];
  const baseRun = runFixture({ calls });
  // Небольшая асинхронная задержка — имитирует реальный npx (не мгновенный
  // resolve), чтобы окно гонки было заведомо шире одного микротика.
  const run = async (args) => {
    await new Promise((r) => setTimeout(r, 5));
    return baseRun(args);
  };
  const ccusage = createCcusage({ run, cache: noopCache(), now: () => 42 });

  const [a, b] = await Promise.all([
    ccusage.get({ force: true }),
    ccusage.get({ force: true }),
  ]);

  assert.strictEqual(calls.length, 2, 'ожидали ровно одну пару run() (daily+session), а не две');
  assert.strictEqual(a, b, 'оба вызова должны получить один и тот же объект результата — single-flight, а не два независимых запроса');
  assert.strictEqual(a.totals.costUsd, 3497);
});

test('single-flight: после разрешения предыдущего get() следующий вызов запускает НОВЫЙ запрос', async () => {
  let calls = 0;
  const run = async (args) => { calls++; return runFixture({})(args); };
  const ccusage = createCcusage({ run, cache: noopCache(), now: () => 1000 });

  await ccusage.get({ force: true });
  await ccusage.get({ force: true });

  assert.strictEqual(calls, 4, 'inFlight должен сбрасываться после каждого завершения — второй вызов не должен молча схлопнуться с первым');
});

test('rounding: дробные центы округляются до 2 знаков, токены — до целых', async () => {
  const dailyBody = {
    daily: [
      { date: '2026-07-01', totalCost: 1.005, totalTokens: 10.6, modelBreakdowns: [] },
    ],
    totals: { totalCost: 1.005, totalTokens: 10.6 },
  };
  const ccusage = createCcusage({
    run: runFixture({ dailyBody, sessionBody: { sessions: [] } }),
    cache: noopCache(),
    now: () => 1,
  });

  const snap = await ccusage.get();

  assert.strictEqual(snap.byDay[0].tokens, 11);
  assert.strictEqual(Number.isInteger(snap.byDay[0].tokens), true);
  assert.strictEqual(Number.isInteger(snap.totals.tokens), true);
});

// ============= инцидент 8ГБ (01.08): окно дат, офлайн-прайсинг, cacheOnly =====

test('инцидент 8ГБ: run() получает --since (окно 40 дней от now) и --offline в ОБОИХ прогонах', async () => {
  const calls = [];
  // now = 2026-08-01 00:00 локального времени; 40 дней назад = 2026-06-22.
  const nowMs = new Date(2026, 7, 1).getTime();
  const ccusage = createCcusage({ run: runFixture({ calls }), cache: noopCache(), now: () => nowMs });

  await ccusage.get();

  assert.strictEqual(calls.length, 2);
  for (const args of calls) {
    const i = args.indexOf('--since');
    assert.ok(i !== -1, `нет --since: ${JSON.stringify(args)}`);
    assert.strictEqual(args[i + 1], '20260622');
    assert.ok(args.includes('--offline'), `нет --offline: ${JSON.stringify(args)}`);
  }
});

test('инцидент 8ГБ: cacheOnly при протухшем кэше — отдаёт кэш со stale+deferred, НЕ спавнит', async () => {
  const calls = [];
  const run = runFixture({ calls });
  let t = 1000;
  const ccusage = createCcusage({ run, cache: noopCache(), now: () => t, ttlMs: 500 });

  await ccusage.get(); // прогрев кэша (2 вызова run)
  t = 10000; // TTL истёк
  const snap = await ccusage.get({ cacheOnly: true });

  assert.strictEqual(calls.length, 2, 'cacheOnly не должен спавнить новые прогоны');
  assert.strictEqual(snap.ok, true);
  assert.strictEqual(snap.stale, true);
  assert.strictEqual(snap.error, 'deferred');
});

test('инцидент 8ГБ: cacheOnly без какого-либо кэша — ok:false, kind deferred, ноль прогонов', async () => {
  const calls = [];
  const ccusage = createCcusage({ run: runFixture({ calls }), cache: noopCache(), now: () => 1000 });

  const snap = await ccusage.get({ cacheOnly: true });

  assert.strictEqual(calls.length, 0);
  assert.strictEqual(snap.ok, false);
  assert.strictEqual(snap.error, 'deferred');
});

test('инцидент 8ГБ: cacheOnly при СВЕЖЕМ кэше — обычный свежий ответ без deferred', async () => {
  const calls = [];
  const ccusage = createCcusage({ run: runFixture({ calls }), cache: noopCache(), now: () => 1000, ttlMs: 600000 });

  await ccusage.get();
  const snap = await ccusage.get({ cacheOnly: true });

  assert.strictEqual(calls.length, 2);
  assert.strictEqual(snap.ok, true);
  assert.strictEqual(snap.stale, false);
  assert.strictEqual(snap.error, null);
});
