'use strict';
// usage:get отвечает сразу, расходы досчитываются в фоне (U1, живой кокпит
// владельца 05.11).
//
// Было: обработчик ждал ccusage.get() — npx по гигабайтам транскриптов, — и
// браузер получил ответ через >90 с, хотя лимиты у main были сразу
// (snapshot(): 5ч 3%, неделя 59%). Всё это время кольца «5Ч» и «НЕДЕЛЯ» стояли
// в прочерках, и так — после КАЖДОГО переподключения: браузер на обрыве
// перезагружает страницу и спрашивает заново.
//
// Проверяем createUsageGetHandler — тот же обработчик, что регистрирует
// registerIpc (страж внизу держит проводку), — с НАСТОЯЩИМ createCcusage:
// его кэш, TTL и single-flight не подменяются, фейк только у run (npx) и
// у снапшота лимитов.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createUsageGetHandler } = require('../src/main/ipc');
const { createCcusage } = require('../src/main/usage-ccusage');

const NOW = 1762300000000;
const TTL = 600000;

// Форма — как у usage-oauth.js snapshot(): живые цифры владельца 05.11.
const LIMITS = {
  ok: true,
  stale: false,
  fetchedAt: NOW - 60000,
  fiveHour: { percent: 3, resetsAt: NOW + 3 * 3600000 },
  sevenDay: { percent: 59, resetsAt: NOW + 3 * 86400000 },
  scoped: [],
  error: null,
};

// Кэш расходов на диске (форма — как пишет usage-ccusage.js), протух по TTL.
const DISK_CACHE = {
  totals: { costUsd: 3400, tokens: 4100000000, sessions: 3 },
  byProject: [{ name: 'C:\\Users\\Lunev\\AssistClaude', costUsd: 3400, tokens: 4100000000, lastActive: NOW - 7200000 }],
  byDay: [{ date: '2026-11-04', costUsd: 120, tokens: 90000000 }],
  byModel: [{ model: 'claude-opus-5-5', costUsd: 3400, tokens: 4100000000 }],
  fetchedAt: NOW - TTL - 60000,
};

// Ответы npx ccusage (форма — как у ccusage 20.0.19, см. usage-ccusage.test.js).
const DAILY = {
  daily: [{ date: '2026-11-05', totalCost: 97, totalTokens: 80000000, modelBreakdowns: [] }],
  totals: { totalCost: 3497, totalTokens: 4180000000 },
};
const SESSION = {
  sessions: [
    { projectPath: 'C:\\Users\\Lunev\\AssistClaude', totalCost: 3497, totalTokens: 4180000000, lastActivity: '2026-11-05T10:00:00Z' },
  ],
};

const WAITS = 'ждёт npx';
const raceTimeout = (p) => Promise.race([
  p, new Promise((resolve) => { setTimeout(() => resolve(WAITS), 200); }),
]);

// npx, который «считает», пока тест не отпустит gate.
function setup({ bootStorm = false, initialSpend = null } = {}) {
  const runs = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const run = async (args) => {
    runs.push(args[1]);
    await gate;
    const body = args[1] === 'daily' ? DAILY : SESSION;
    return { code: 0, stdout: JSON.stringify(body), stderr: '' };
  };
  const ccusage = createCcusage({
    run, cache: { read: () => DISK_CACHE, write: () => {} }, now: () => NOW, ttlMs: TTL,
  });
  const emits = [];
  const broadcast = { emit: (channel, payload) => emits.push({ channel, payload }) };
  let last = initialSpend;
  const spend = { get: () => last, set: (v) => { last = v; } };
  const usageGet = createUsageGetHandler({
    smoke: false,
    usagePoller: { snapshot: () => ({ ...LIMITS }) },
    ccusage,
    broadcast,
    inBootStorm: () => bootStorm,
    spend,
  });
  return { usageGet, runs, release, emits, spend };
}

// Дать фоновому пересчёту доработать после release().
async function settle(emits) {
  for (let i = 0; i < 50 && emits.length === 0; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => { setImmediate(resolve); });
  }
}

test('npx ещё считает — usage:get всё равно отвечает сразу: лимиты и расходы из кэша', async () => {
  const s = setup();
  try {
    const res = await raceTimeout(s.usageGet());
    assert.notStrictEqual(res, WAITS, 'usage:get ждёт npx — кольца в браузере стоят в прочерках');
    assert.deepStrictEqual(res.limits, LIMITS, 'лимиты не те, что в снапшоте');
    assert.strictEqual(res.spend.ok, true);
    assert.strictEqual(res.spend.totals.costUsd, 3400, 'расходы не из кэша');
    assert.strictEqual(res.spend.stale, true, 'протухший кэш выдан за свежий');
    assert.deepStrictEqual(s.runs, ['daily'], 'пересчёт в фоне не запущен');
  } finally {
    s.release();
  }
});

test('два параллельных usage:get — один прогон npx и одна рассылка usage:update со свежими расходами', async () => {
  const s = setup();
  let answers;
  try {
    answers = await raceTimeout(Promise.all([s.usageGet(), s.usageGet()]));
    assert.notStrictEqual(answers, WAITS, 'usage:get ждёт npx');
    assert.deepStrictEqual(s.emits, [], 'рассылка раньше, чем пересчёт закончился');
  } finally {
    s.release();
  }
  await settle(s.emits);

  assert.deepStrictEqual(s.runs, ['daily', 'session'], 'клиентов двое — прогонов npx должно быть всё равно один');
  assert.strictEqual(s.emits.length, 1, `рассылок ${s.emits.length}, а пересчёт был один`);
  const [{ channel, payload }] = s.emits;
  assert.strictEqual(channel, 'usage:update');
  assert.deepStrictEqual(payload.limits, LIMITS);
  assert.strictEqual(payload.spend.totals.costUsd, 3497, 'в рассылке не свежие расходы');
  assert.strictEqual(payload.spend.stale, false);
  assert.strictEqual(s.spend.get(), payload.spend, 'свежие расходы не запомнены — следующий usage:get отдаст старые');

  // Следующий клиент: свежее сразу, без нового npx (TTL ccusage) и без
  // повторной рассылки того же самого.
  const next = await raceTimeout(s.usageGet());
  assert.notStrictEqual(next, WAITS);
  assert.strictEqual(next.spend.totals.costUsd, 3497);
  await settle([]);
  assert.deepStrictEqual(s.runs, ['daily', 'session'], 'свежий по TTL кэш всё равно погнал npx');
  assert.strictEqual(s.emits.length, 1, 'ничего не изменилось, а usage:update разослан снова');
});

test('окно старта (инцидент 8 ГБ): ни одного npx, ответ из кэша', async () => {
  const s = setup({ bootStorm: true });
  try {
    const res = await raceTimeout(s.usageGet());
    assert.notStrictEqual(res, WAITS);
    assert.strictEqual(res.spend.totals.costUsd, 3400);
    assert.strictEqual(res.spend.error, 'deferred');
    await settle([]);
    assert.deepStrictEqual(s.runs, [], 'в окно старта запущен npx');
    assert.deepStrictEqual(s.emits, []);
  } finally {
    s.release();
  }
});

// N2 (ре-ревью инцидент-фикса): ответ «только кэш» (error 'deferred') не
// затирает настоящий. Живая последовательность: кэша на диске нет, npx упал
// (ccusage снесён, нет сети) — известен честный 'unavailable'. Затри его
// usage:get кэшевым 'deferred', и дашборд пообещал бы «расходы ещё не
// посчитаны — появятся сами» вместо «ccusage не запустился — попробуйте
// «Обновить»», а сами они не появятся.
test('известный настоящий ответ не подменяется кэшевым «deferred»', async () => {
  let failNext = true;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const run = async (args) => {
    if (failNext) { failNext = false; return { code: 1, stdout: '', stderr: 'npx: ccusage не найден' }; }
    await gate;
    return { code: 0, stdout: JSON.stringify(args[1] === 'daily' ? DAILY : SESSION), stderr: '' };
  };
  const ccusage = createCcusage({ run, cache: { read: () => null, write: () => {} }, now: () => NOW, ttlMs: TTL });
  let last = await ccusage.get(); // тот самый провал — так его и получает usage:refresh
  assert.strictEqual(last.error, 'unavailable', 'фикстура не дала провала npx');
  const usageGet = createUsageGetHandler({
    smoke: false,
    usagePoller: { snapshot: () => ({ ...LIMITS }) },
    ccusage,
    broadcast: { emit: () => {} },
    inBootStorm: () => false,
    spend: { get: () => last, set: (v) => { last = v; } },
  });
  try {
    const res = await raceTimeout(usageGet());
    assert.notStrictEqual(res, WAITS);
    assert.strictEqual(res.spend.error, 'unavailable', `настоящий провал подменён на «${res.spend.error}»`);
  } finally {
    release();
  }
});

test('smoke: ни ccusage, ни npx — spend:null, лимиты из снапшота', async () => {
  const boom = () => { throw new Error('ccusage.get НЕ должен был вызваться в smoke'); };
  const usageGet = createUsageGetHandler({
    smoke: true,
    usagePoller: { snapshot: () => ({ ...LIMITS }) },
    ccusage: { get: boom },
    broadcast: { emit: boom },
    inBootStorm: () => false,
    spend: { get: () => null, set: boom },
  });
  assert.deepStrictEqual(await usageGet(), { limits: LIMITS, spend: null });
});

// --- проводка: registerIpc регистрирует именно этот обработчик ---

const codeOnly = (source) => source
  .split(/\r?\n/)
  .filter((line) => !/^\s*\/\//.test(line))
  .map((line) => line.replace(/\s\/\/\s.*$/, ''))
  .join('\n');

test('registerIpc отдаёт usage:get обработчику createUsageGetHandler с настоящими зависимостями', () => {
  const code = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ipc.js'), 'utf8'));
  const reg = code.indexOf('function registerIpc(');
  assert.notStrictEqual(reg, -1, 'не найдена registerIpc — страж разъехался с ipc.js');
  const body = code.slice(reg);

  const handles = body.match(/registry\.handle\('usage:get',[^\n]*/g) || [];
  assert.deepStrictEqual(handles, ["registry.handle('usage:get', () => usageGet());"],
    'usage:get зарегистрирован не на usageGet() — тест проверяет не тот код, что работает');

  const start = body.indexOf('const usageGet = createUsageGetHandler({');
  assert.notStrictEqual(start, -1, 'usageGet собирается не из createUsageGetHandler');
  const wiring = body.slice(start, body.indexOf('});', start));
  for (const dep of ['smoke,', 'usagePoller,', 'ccusage,', 'broadcast,']) {
    assert.ok(wiring.includes(dep), `в createUsageGetHandler не передан ${dep.slice(0, -1)}`);
  }
  assert.match(wiring, /inBootStorm:\s*\(\)\s*=>\s*Date\.now\(\)\s*-\s*ipcBootAt\s*<\s*CCUSAGE_BOOT_DEFER_MS,/,
    'окно старта (cacheOnly, инцидент 8 ГБ) считается не от ipcBootAt/CCUSAGE_BOOT_DEFER_MS');
  assert.match(wiring, /spend:\s*\{\s*get:\s*\(\)\s*=>\s*lastCcusageResult,\s*set:\s*\(v\)\s*=>\s*\{\s*lastCcusageResult = v;\s*\}\s*\}/,
    'расходы хранятся не в lastCcusageResult — usage:update и usage:refresh их не увидят');
});
