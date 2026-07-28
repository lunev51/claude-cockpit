'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createUsagePoller } = require('../src/main/usage-oauth');

// Реальный образец ответа эндпоинта (снят контролёром 28.07) — используем как фикстуру.
const SAMPLE_BODY = {
  five_hour: {
    utilization: 12.0,
    resets_at: '2026-07-28T03:39:59.893453+00:00',
    limit_dollars: null,
    used_dollars: null,
    remaining_dollars: null,
  },
  seven_day: {
    utilization: 2.0,
    resets_at: '2026-08-03T20:59:59.893477+00:00',
    limit_dollars: null,
    used_dollars: null,
    remaining_dollars: null,
  },
  seven_day_opus: null,
  limits: [
    {
      kind: 'session', group: 'session', percent: 12, severity: 'normal',
      resets_at: '2026-07-28T03:39:59.893453+00:00', scope: null, is_active: true,
    },
    {
      kind: 'weekly_all', group: 'weekly', percent: 2, severity: 'normal',
      resets_at: '2026-08-03T20:59:59.893477+00:00', scope: null, is_active: false,
    },
    {
      kind: 'weekly_scoped', group: 'weekly', percent: 0, severity: 'normal',
      resets_at: null, scope: { model: { id: null, display_name: 'Fable' }, surface: null }, is_active: false,
    },
  ],
  spend: { used: { amount_minor: 0, currency: 'USD', exponent: 2 }, limit: null, percent: 0, severity: 'normal', enabled: false },
  member_dashboard_available: false,
};

const TOKEN = { accessToken: 'sk-ant-oat01-SUPER-SECRET-DO-NOT-LOG-VALUE' };

function noopCache() {
  return { read: () => null, write: () => {} };
}

test('успешный разбор реального образца ответа: five_hour/seven_day/weekly_scoped(Fable)', async () => {
  const calls = [];
  const poller = createUsagePoller({
    readToken: () => TOKEN,
    httpGet: async (url, headers) => { calls.push({ url, headers }); return { status: 200, body: SAMPLE_BODY }; },
    cache: noopCache(),
    now: () => 1000,
  });

  const snap = await poller.refresh();

  assert.strictEqual(snap.ok, true);
  assert.strictEqual(snap.stale, false);
  assert.strictEqual(snap.error, null);
  assert.strictEqual(snap.fetchedAt, 1000);
  assert.strictEqual(snap.fiveHour.percent, 12);
  assert.strictEqual(snap.fiveHour.resetsAt, Date.parse('2026-07-28T03:39:59.893453+00:00'));
  assert.strictEqual(snap.sevenDay.percent, 2);
  assert.strictEqual(snap.sevenDay.resetsAt, Date.parse('2026-08-03T20:59:59.893477+00:00'));
  assert.deepStrictEqual(snap.scoped, [{ label: 'Fable', percent: 0, resetsAt: null }]);

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, 'https://api.anthropic.com/api/oauth/usage');
  assert.strictEqual(calls[0].headers.Authorization, `Bearer ${TOKEN.accessToken}`);
  assert.strictEqual(calls[0].headers['anthropic-beta'], 'oauth-2025-04-20');
  assert.strictEqual(calls[0].headers['User-Agent'], 'claude-code/2.1.220');
});

test('scoped: берём только kind=weekly_scoped с непустым label, остальные пропускаем', async () => {
  const body = {
    five_hour: { utilization: 5, resets_at: null },
    seven_day: { utilization: 1, resets_at: null },
    limits: [
      { kind: 'session', percent: 5, resets_at: null, scope: null },
      { kind: 'weekly_all', percent: 3, resets_at: null, scope: null },
      { kind: 'weekly_scoped', percent: 7, resets_at: null, scope: { model: { display_name: null } } },
      { kind: 'weekly_scoped', percent: 9, resets_at: '2026-01-01T00:00:00Z', scope: { model: { display_name: 'Haiku' } } },
    ],
  };
  const poller = createUsagePoller({
    readToken: () => TOKEN,
    httpGet: async () => ({ status: 200, body }),
    cache: noopCache(),
    now: () => 1,
  });

  const snap = await poller.refresh();

  assert.deepStrictEqual(snap.scoped, [{ label: 'Haiku', percent: 9, resetsAt: Date.parse('2026-01-01T00:00:00Z') }]);
});

test('отсутствие токена → ok:false, error:auth, запрос НЕ отправлен', async () => {
  let called = false;
  const poller = createUsagePoller({
    readToken: () => null,
    httpGet: async () => { called = true; return { status: 200, body: SAMPLE_BODY }; },
    cache: noopCache(),
    now: () => 1,
  });

  const snap = await poller.refresh();

  assert.strictEqual(called, false);
  assert.strictEqual(snap.ok, false);
  assert.strictEqual(snap.error, 'auth');
});

test('401: error=auth, поллинг не останавливается, но интервал увеличивается (не долбит каждые intervalMs)', async () => {
  let callCount = 0;
  const poller = createUsagePoller({
    readToken: () => TOKEN,
    httpGet: async () => { callCount++; return { status: 401, body: {} }; },
    cache: noopCache(),
    now: () => Date.now(),
    intervalMs: 20,
  });

  poller.start();
  await new Promise((r) => setTimeout(r, 150)); // 150мс >> 20мс интервала — при обычном темпе тиков было бы много
  poller.stop();

  assert.strictEqual(callCount, 1);
  assert.strictEqual(poller.snapshot().error, 'auth');
});

test('403 тоже трактуется как error=auth', async () => {
  const poller = createUsagePoller({
    readToken: () => TOKEN,
    httpGet: async () => ({ status: 403, body: {} }),
    cache: noopCache(),
    now: () => 1,
  });

  const snap = await poller.refresh();
  assert.strictEqual(snap.error, 'auth');
});

test('429: error=rate; повторный запрос раньше 10 минут не бьёт по сети снова', async () => {
  let callCount = 0;
  let currentTime = 1_000_000;
  const poller = createUsagePoller({
    readToken: () => TOKEN,
    httpGet: async () => { callCount++; return { status: 429, body: {} }; },
    cache: noopCache(),
    now: () => currentTime,
  });

  const snap1 = await poller.refresh();
  assert.strictEqual(snap1.error, 'rate');
  assert.strictEqual(callCount, 1);

  currentTime += 5 * 60 * 1000; // +5 мин — всё ещё внутри 10-минутного бэкоффа
  const snap2 = await poller.refresh();
  assert.strictEqual(callCount, 1); // сеть не тронута повторно
  assert.strictEqual(snap2.error, 'rate');

  currentTime += 6 * 60 * 1000; // суммарно +11 мин от первого запроса — бэкофф истёк
  await poller.refresh();
  assert.strictEqual(callCount, 2); // теперь запрос прошёл
});

test('сетевой сбой при наличии кэша: stale:true, прежние проценты сохраняются', async () => {
  const cachedGood = {
    fiveHour: { percent: 33, resetsAt: 5000 },
    sevenDay: { percent: 44, resetsAt: 6000 },
    scoped: [{ label: 'Fable', percent: 10, resetsAt: null }],
    fetchedAt: 999,
  };
  const poller = createUsagePoller({
    readToken: () => TOKEN,
    httpGet: async () => { throw new Error('ECONNRESET'); },
    cache: { read: () => cachedGood, write: () => {} },
    now: () => 123456,
  });

  const snap = await poller.refresh();

  assert.strictEqual(snap.error, 'network');
  assert.strictEqual(snap.stale, true);
  assert.strictEqual(snap.ok, true);
  assert.strictEqual(snap.fiveHour.percent, 33);
  assert.strictEqual(snap.sevenDay.percent, 44);
  assert.deepStrictEqual(snap.scoped, cachedGood.scoped);
});

test('сетевой сбой без кэша: ok:false, нули', async () => {
  const poller = createUsagePoller({
    readToken: () => TOKEN,
    httpGet: async () => { throw new Error('ETIMEDOUT'); },
    cache: noopCache(),
    now: () => 1,
  });

  const snap = await poller.refresh();

  assert.strictEqual(snap.ok, false);
  assert.strictEqual(snap.stale, false);
  assert.strictEqual(snap.error, 'network');
  assert.strictEqual(snap.fiveHour.percent, 0);
  assert.strictEqual(snap.sevenDay.percent, 0);
  assert.deepStrictEqual(snap.scoped, []);
});

test('snapshot() синхронный и не бросает до первого refresh — возвращает нули', () => {
  const poller = createUsagePoller({
    readToken: () => null,
    httpGet: async () => { throw new Error('httpGet не должен вызываться до refresh()'); },
    cache: noopCache(),
    now: () => 1,
  });

  const snap = poller.snapshot();

  assert.deepStrictEqual(snap, {
    ok: false,
    stale: false,
    fetchedAt: 0,
    fiveHour: { percent: 0, resetsAt: null },
    sevenDay: { percent: 0, resetsAt: null },
    scoped: [],
    error: null,
  });
});

test('stop() снимает таймер: после stop() новых запросов не происходит', async () => {
  let callCount = 0;
  const poller = createUsagePoller({
    readToken: () => TOKEN,
    httpGet: async () => { callCount++; return { status: 200, body: SAMPLE_BODY }; },
    cache: noopCache(),
    now: () => Date.now(),
    intervalMs: 20,
  });

  poller.start();
  await new Promise((r) => setTimeout(r, 5));
  poller.stop();
  const countAfterStop = callCount;
  assert.ok(countAfterStop >= 1);

  await new Promise((r) => setTimeout(r, 150));
  assert.strictEqual(callCount, countAfterStop);
});

test('повторный start() не плодит лишние таймеры/запросы', async () => {
  let callCount = 0;
  const poller = createUsagePoller({
    readToken: () => TOKEN,
    httpGet: async () => { callCount++; return { status: 200, body: SAMPLE_BODY }; },
    cache: noopCache(),
    now: () => Date.now(),
    intervalMs: 100000,
  });

  poller.start();
  poller.start();
  await new Promise((r) => setTimeout(r, 20));
  poller.stop();

  assert.strictEqual(callCount, 1);
});

test('токен никогда не появляется ни в одном аргументе log', async () => {
  const logs = [];
  const log = (...args) => { logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };

  await createUsagePoller({
    readToken: () => TOKEN, httpGet: async () => ({ status: 200, body: SAMPLE_BODY }),
    cache: noopCache(), now: () => 1, log,
  }).refresh();

  await createUsagePoller({
    readToken: () => TOKEN, httpGet: async () => { throw new Error('ECONNRESET'); },
    cache: noopCache(), now: () => 1, log,
  }).refresh();

  await createUsagePoller({
    readToken: () => TOKEN, httpGet: async () => ({ status: 401, body: {} }),
    cache: noopCache(), now: () => 1, log,
  }).refresh();

  await createUsagePoller({
    readToken: () => TOKEN, httpGet: async () => ({ status: 429, body: {} }),
    cache: noopCache(), now: () => 1, log,
  }).refresh();

  await createUsagePoller({
    readToken: () => null, httpGet: async () => ({ status: 200, body: SAMPLE_BODY }),
    cache: noopCache(), now: () => 1, log,
  }).refresh();

  for (const line of logs) {
    assert.ok(!line.includes(TOKEN.accessToken), `log содержит токен: ${line}`);
  }
});

// FINDING 1 (ревью): чужая ошибка (httpGet/net) может сама содержать токен в
// тексте (например, если реализация echo'ит заголовки запроса в message).
// Модуль обязан вырезать токен из ЛЮБОГО текста перед логированием, а не
// полагаться на то, что сторонние ошибки его никогда не содержат.
test('АДВЕРСАРИАЛЬНО: сообщение ошибки САМО содержит токен — санитайзер вырезает его перед log', async () => {
  const logs = [];
  const log = (...args) => { logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
  const poller = createUsagePoller({
    readToken: () => TOKEN,
    httpGet: async () => { throw new Error(`connect ECONNREFUSED, headers: Authorization: Bearer ${TOKEN.accessToken}`); },
    cache: noopCache(),
    now: () => 1,
    log,
  });

  await poller.refresh();

  assert.ok(logs.length > 0, 'ожидали хотя бы одну запись в log');
  for (const line of logs) {
    assert.ok(!line.includes(TOKEN.accessToken), `log содержит токен: ${line}`);
  }
  assert.ok(logs.some((l) => l.includes('***')), 'ожидали маску *** вместо вырезанного токена');
});

// FINDING 2 (ревью, minor): мусорная дата не должна давать NaN.
test('resets_at — мусорная строка (не дата) → resetsAt:null, не NaN', async () => {
  const body = {
    five_hour: { utilization: 1, resets_at: 'not-a-date' },
    seven_day: { utilization: 1, resets_at: null },
    limits: [],
  };
  const poller = createUsagePoller({
    readToken: () => TOKEN,
    httpGet: async () => ({ status: 200, body }),
    cache: noopCache(),
    now: () => 1,
  });

  const snap = await poller.refresh();

  assert.strictEqual(snap.fiveHour.resetsAt, null);
  assert.strictEqual(snap.sevenDay.resetsAt, null);
});

// FINDING 3 (ревью, minor): кэш проверялся только на наличие полей, не на их
// форму — «percent: undefined» проходил бы как валидный кэш. Ужесточаем.
test('кэш с некорректной формой (percent не число) отвергается — трактуем как отсутствие кэша', async () => {
  const badCache = {
    fiveHour: { percent: undefined, resetsAt: null },
    sevenDay: { percent: 5, resetsAt: 1 },
    scoped: [],
    fetchedAt: 1,
  };
  const poller = createUsagePoller({
    readToken: () => TOKEN,
    httpGet: async () => { throw new Error('ECONNRESET'); },
    cache: { read: () => badCache, write: () => {} },
    now: () => 1,
  });

  const snap = await poller.refresh();

  assert.strictEqual(snap.ok, false);
  assert.strictEqual(snap.stale, false);
  assert.strictEqual(snap.fiveHour.percent, 0);
  assert.strictEqual(snap.sevenDay.percent, 0);
});
