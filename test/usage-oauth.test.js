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

// C20 (ревью 09.08, раздел C): кэш писался на диск на КАЖДЫЙ удачный опрос
// (~480 раз в сутки), даже когда цифры не менялись. «Изменилось» — по данным,
// а не по fetchedAt. Форма ответа — с живого кэша 05.11: сроки окон
// five_hour/seven_day приходят с плавающими долями секунды (два опроса подряд
// дали 16:09:59.855 и 16:10:00.086 — один и тот же срок), а у weekly_scoped
// срок ровный.
function liveBody({
  fivePct = 28, fiveReset = '2026-11-05T16:09:59.855000+00:00',
  sevenPct = 52, sevenReset = '2026-11-09T20:59:59.855000+00:00',
  scoped = [{ label: 'Fable', percent: 0 }],
} = {}) {
  return {
    five_hour: {
      utilization: fivePct, resets_at: fiveReset, limit_dollars: null, used_dollars: null, remaining_dollars: null,
    },
    seven_day: {
      utilization: sevenPct, resets_at: sevenReset, limit_dollars: null, used_dollars: null, remaining_dollars: null,
    },
    seven_day_opus: null,
    limits: [
      {
        kind: 'session', group: 'session', percent: fivePct, severity: 'normal', resets_at: fiveReset, scope: null, is_active: true,
      },
      ...scoped.map((s) => ({
        kind: 'weekly_scoped',
        group: 'weekly',
        percent: s.percent,
        severity: 'normal',
        resets_at: '2026-11-09T21:00:00+00:00',
        scope: { model: { id: null, display_name: s.label }, surface: null },
        is_active: false,
      })),
    ],
    member_dashboard_available: false,
  };
}

// write() отдаёт true — так настоящий кэш (ipc.js/createJsonFileCache)
// сообщает, что запись легла на диск.
function recordingCache() {
  const writes = [];
  return { read: () => null, write: (v) => { writes.push(v); return true; }, writes };
}

// Поллер, которому тест подсовывает ответ и время на каждый опрос.
function scriptedPoller(cache) {
  const ctl = { body: liveBody(), time: 1000 };
  const poller = createUsagePoller({
    readToken: () => TOKEN,
    httpGet: async () => ({ status: 200, body: ctl.body }),
    cache,
    now: () => ctl.time,
  });
  return { poller, ctl };
}

test('C20: тот же ответ второй раз — кэш на диск не пишется, а снапшот в памяти свежий', async () => {
  const cache = recordingCache();
  const { poller, ctl } = scriptedPoller(cache);

  await poller.refresh();
  assert.strictEqual(cache.writes.length, 1, 'первый удачный опрос обязан записаться');

  ctl.time = 181000; // следующий тик таймера
  const snap = await poller.refresh();
  assert.strictEqual(cache.writes.length, 1, 'цифры те же — писать нечего');
  // Ночная смена меряет свежесть по fetchedAt снапшота (isSnapshotFreshEnough):
  // пропуск записи на диск не должен его состарить.
  assert.strictEqual(snap.fetchedAt, 181000);
  assert.strictEqual(snap.stale, false);
});

test('C20: дрожь долей секунды в resets_at между опросами — не изменение', async () => {
  const cache = recordingCache();
  const { poller, ctl } = scriptedPoller(cache);

  await poller.refresh();
  ctl.body = liveBody({
    fiveReset: '2026-11-05T16:10:00.086000+00:00',
    sevenReset: '2026-11-09T21:00:00.086000+00:00',
  });
  ctl.time = 181000;
  await poller.refresh();

  assert.strictEqual(cache.writes.length, 1);
});

test('C20: проваленная запись (диск занят, ошибка проглочена кэшем) повторяется на следующем опросе', async () => {
  const attempts = [];
  let failNext = true;
  const cache = {
    read: () => null,
    write: (v) => {
      attempts.push(v);
      if (failNext) { failNext = false; return false; }
      return true;
    },
  };
  const { poller, ctl } = scriptedPoller(cache);

  await poller.refresh(); // запись не легла
  ctl.time += 180000;
  await poller.refresh(); // цифры те же, но на диске их нет
  assert.strictEqual(attempts.length, 2, 'после проваленной записи кэш на диске остался бы старым');

  ctl.time += 180000;
  await poller.refresh();
  assert.strictEqual(attempts.length, 2, 'после удачной записи — снова без записи');
});

test('C20: те же цифры дописываются раз в 30 минут — fetchedAt на диске не стареет на часы', async () => {
  const cache = recordingCache();
  const { poller, ctl } = scriptedPoller(cache);
  const start = ctl.time;
  await poller.refresh();

  ctl.time = start + 30 * 60 * 1000 - 1;
  await poller.refresh();
  assert.strictEqual(cache.writes.length, 1, 'раньше 30 минут переписывать незачем');

  ctl.time = start + 30 * 60 * 1000;
  await poller.refresh();
  assert.strictEqual(cache.writes.length, 2, 'прошло 30 минут — кэш дописан');
  assert.strictEqual(cache.writes[1].fetchedAt, ctl.time);

  ctl.time += 180000;
  await poller.refresh();
  assert.strictEqual(cache.writes.length, 2, 'отсчёт 30 минут — от последней записи');
});

test('C20: каждая настоящая смена данных записывается', async () => {
  const cache = recordingCache();
  const { poller, ctl } = scriptedPoller(cache);
  const step = async (body, why) => {
    const before = cache.writes.length;
    ctl.body = body;
    ctl.time += 180000;
    await poller.refresh();
    assert.strictEqual(cache.writes.length, before + 1, why);
  };

  await poller.refresh();
  await step(liveBody({ fivePct: 30 }), 'процент 5-часового окна');
  await step(liveBody({ fivePct: 30, fiveReset: '2026-11-05T21:09:59.855000+00:00' }), 'новое 5-часовое окно');
  await step(liveBody({ fivePct: 30, fiveReset: '2026-11-05T21:09:59.855000+00:00', sevenPct: 53 }), 'процент недели');
  const newWindow = { fivePct: 30, fiveReset: '2026-11-05T21:09:59.855000+00:00', sevenPct: 53 };
  await step(liveBody({ ...newWindow, sevenReset: '2026-11-16T20:59:59.855000+00:00' }), 'новая неделя');
  const newWeek = { ...newWindow, sevenReset: '2026-11-16T20:59:59.855000+00:00' };
  await step(liveBody({ ...newWeek, scoped: [{ label: 'Fable', percent: 4 }] }), 'процент лимита модели');
  await step(liveBody({ ...newWeek, scoped: [{ label: 'Opus', percent: 4 }] }), 'другая модель с тем же процентом');
  await step(
    liveBody({ ...newWeek, scoped: [{ label: 'Opus', percent: 4 }, { label: 'Fable', percent: 0 }] }),
    'появился ещё один лимит модели',
  );
  await step(liveBody({ ...newWeek, scoped: [{ label: 'Opus', percent: 4 }] }), 'лимит модели пропал');

  // Записывается полный снапшот с fetchedAt — форма кэша прежняя.
  const last = cache.writes[cache.writes.length - 1];
  assert.strictEqual(last.fetchedAt, ctl.time);
  assert.strictEqual(last.fiveHour.percent, 30);
});

// C22 (ревью 09.08, раздел C): к refresh() ведут три пути — таймер поллера,
// ночная смена и ручное обновление, — и у каждого был свой single-flight (или
// никакого). Параллельные запросы к эндпоинту, который отвечает 429 и гасит
// поллер на 10 минут, были возможны. Рубеж теперь один — в самом refresh().
function deferredHttp() {
  const calls = [];
  const httpGet = () => new Promise((resolve) => { calls.push(resolve); });
  return { httpGet, calls };
}

test('C22: два параллельных refresh() — ОДИН HTTP-запрос, оба получают его результат', async () => {
  const http = deferredHttp();
  const poller = createUsagePoller({
    readToken: () => TOKEN, httpGet: http.httpGet, cache: noopCache(), now: () => 5000,
  });

  const p1 = poller.refresh();
  const p2 = poller.refresh();
  await Promise.resolve();
  assert.strictEqual(http.calls.length, 1, 'второй вызов не должен был открыть свой запрос');

  http.calls[0]({ status: 200, body: liveBody() });
  const [s1, s2] = await Promise.all([p1, p2]);
  assert.strictEqual(http.calls.length, 1);
  for (const s of [s1, s2]) {
    assert.strictEqual(s.ok, true);
    assert.strictEqual(s.fetchedAt, 5000);
    assert.strictEqual(s.fiveHour.percent, 28);
  }
});

test('C22: тик таймера и ручной вызов во время него делят один запрос', async () => {
  const http = deferredHttp();
  const poller = createUsagePoller({
    readToken: () => TOKEN, httpGet: http.httpGet, cache: noopCache(), now: () => 5000, intervalMs: 100000,
  });

  poller.start(); // немедленный тик уже в сети
  const manual = poller.refresh();
  await Promise.resolve();
  assert.strictEqual(http.calls.length, 1);

  http.calls[0]({ status: 200, body: liveBody({ fivePct: 41 }) });
  const snap = await manual;
  poller.stop();
  assert.strictEqual(snap.fiveHour.percent, 41, 'ручной вызов получает свежий ответ общего запроса');
  assert.strictEqual(http.calls.length, 1);
});

test('C22: после завершения запроса следующий refresh() снова идёт в сеть', async () => {
  const http = deferredHttp();
  const poller = createUsagePoller({
    readToken: () => TOKEN, httpGet: http.httpGet, cache: noopCache(), now: () => 5000,
  });

  const first = poller.refresh();
  await Promise.resolve();
  http.calls[0]({ status: 200, body: liveBody() });
  await first;

  const second = poller.refresh();
  await Promise.resolve();
  assert.strictEqual(http.calls.length, 2, 'рубеж держит только ОДНОВРЕМЕННЫЕ вызовы');
  http.calls[1]({ status: 200, body: liveBody() });
  await second;
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
