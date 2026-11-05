'use strict';
// Отказ запроса при открытии дашборда не затирает уже известные данные
// (ревью 09.08, C17).
//
// Было: .catch у usage:get безусловно писал в lastUsage синтетический
// ok:false — и кольца «5Ч»/«НЕДЕЛЯ» вместе с дашбордом показывали прочерки,
// хотя валидные цифры были на руках секунду назад. Синтетика нужна только
// там, где не было ничего: иначе раздел висит в «загружаю…» навсегда (FIX
// задачи 4 фазы 6). У gh — та же беда и то же правило.
//
// Тест зовёт ту же fetchOnDashboardOpen, что app.js (страж ниже держит
// проводку), с фейковым window.api.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer', 'js');
const modUrl = pathToFileURL(path.join(RENDERER, 'dashboard-fetch.js')).href;

// Форма — как её отдаёт main на usage:get: limits — snapshot() usage-oauth.js,
// spend — ответ ccusage.get() из usage-ccusage.js.
const KNOWN_USAGE = {
  limits: {
    ok: true,
    stale: false,
    fetchedAt: 1762300000000,
    fiveHour: { percent: 3, resetsAt: 1762310000000 },
    sevenDay: { percent: 59, resetsAt: 1762700000000 },
    scoped: [],
    error: null,
  },
  spend: {
    ok: true,
    stale: false,
    fetchedAt: 1762299000000,
    error: null,
    totals: { costUsd: 3497, tokens: 4200000000, sessions: 4 },
    byProject: [],
    byDay: [],
    byModel: [],
  },
};

// Форма — как её отдаёт gh-info.js на gh:global.
const KNOWN_GH = {
  ok: true, error: null, prs: [{ title: 'PR' }], issues: [], notifications: 2, fetchedAt: 1762300000000,
};

function ref(initial) {
  let value = initial;
  return { get: () => value, set: (v) => { value = v; } };
}

function failingApi() {
  return {
    usage: { get: () => Promise.reject(new Error('мост оборвался')) },
    gh: { global: () => Promise.reject(new Error('мост оборвался')) },
  };
}

// console.warn из .catch — ожидаемый шум, в выводе теста он не нужен.
async function quietly(fn) {
  const warn = console.warn;
  console.warn = () => {};
  try { return await fn(); } finally { console.warn = warn; }
}

test('отказ usage:get не затирает уже известные лимиты и расходы', async () => {
  const { fetchOnDashboardOpen } = await import(modUrl);
  const usage = ref(KNOWN_USAGE);
  const gh = ref(KNOWN_GH);
  let redraws = 0;
  await quietly(() => fetchOnDashboardOpen({
    api: failingApi(), usage, gh, redraw: () => { redraws += 1; },
  }));
  assert.strictEqual(usage.get(), KNOWN_USAGE, 'известные лимиты затёрты синтетикой — кольца покажут прочерки');
  assert.strictEqual(gh.get(), KNOWN_GH, 'известная сводка GitHub затёрта синтетикой');
  assert.ok(redraws >= 1, 'после отказа нет перерисовки');
});

test('отказ без известных данных — синтетика ok:false, раздел не висит в «загружаю…»', async () => {
  const { fetchOnDashboardOpen } = await import(modUrl);
  const usage = ref(null);
  const gh = ref(null);
  let redraws = 0;
  await quietly(() => fetchOnDashboardOpen({
    api: failingApi(), usage, gh, redraw: () => { redraws += 1; },
  }));
  assert.deepStrictEqual(usage.get(), {
    limits: { ok: false, error: 'failed', fetchedAt: 0 },
    spend: { ok: false, error: 'failed' },
  });
  assert.deepStrictEqual(gh.get(), {
    ok: false, error: 'failed', prs: [], issues: [], notifications: 0,
  });
  assert.strictEqual(redraws, 2, 'каждый источник перерисовывает сам по своему ответу');
});

test('успешный ответ заменяет известные данные', async () => {
  const { fetchOnDashboardOpen } = await import(modUrl);
  const usage = ref(KNOWN_USAGE);
  const gh = ref(KNOWN_GH);
  const fresh = { ...KNOWN_USAGE, limits: { ...KNOWN_USAGE.limits, fetchedAt: 1762300300000 } };
  const freshGh = { ...KNOWN_GH, notifications: 0 };
  await fetchOnDashboardOpen({
    api: { usage: { get: async () => fresh }, gh: { global: async () => freshGh } },
    usage,
    gh,
    redraw: () => {},
  });
  assert.strictEqual(usage.get(), fresh);
  assert.strictEqual(gh.get(), freshGh);
});

// --- проводка: app.js зовёт именно эту функцию со своими переменными ---

const codeOnly = (source) => source
  .split(/\r?\n/)
  .filter((line) => !/^\s*\/\//.test(line))
  .map((line) => line.replace(/\s\/\/\s.*$/, ''))
  .join('\n');

test('app.js при открытии дашборда зовёт fetchOnDashboardOpen со своими lastUsage/lastGh', () => {
  const app = codeOnly(fs.readFileSync(path.join(RENDERER, 'app.js'), 'utf8'));
  assert.match(
    app,
    /import\s+\{\s*fetchOnDashboardOpen\s*\}\s+from\s+'\.\/dashboard-fetch\.js'/,
    'app.js не импортирует fetchOnDashboardOpen — тест проверяет не тот код, что работает',
  );
  const start = app.indexOf('function fetchUsageOnDashboardOpen() {');
  assert.notStrictEqual(start, -1, 'не найдена fetchUsageOnDashboardOpen — страж разъехался с app.js');
  const body = app.slice(start, app.indexOf('\n}', start));
  assert.match(body, /fetchOnDashboardOpen\(\{/, 'fetchUsageOnDashboardOpen больше не зовёт fetchOnDashboardOpen');
  assert.match(body, /usage:\s*\{\s*get:\s*\(\)\s*=>\s*lastUsage,\s*set:\s*\(v\)\s*=>\s*\{\s*lastUsage = v;\s*\}\s*\}/,
    'в fetchOnDashboardOpen уходит не lastUsage');
  assert.match(body, /gh:\s*\{\s*get:\s*\(\)\s*=>\s*lastGh,\s*set:\s*\(v\)\s*=>\s*\{\s*lastGh = v;\s*\}\s*\}/,
    'в fetchOnDashboardOpen уходит не lastGh');
  assert.match(app, /onOpen:\s*fetchUsageOnDashboardOpen\b/, 'дашборд больше не зовёт fetchUsageOnDashboardOpen при открытии');
});
