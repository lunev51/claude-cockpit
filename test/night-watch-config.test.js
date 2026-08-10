'use strict';
// Сверка дефолтов ночной смены: ядро (night-watch.js) против конфига
// приложения (config.js).
//
// Ревью фикса A7 нашло дыру, которую не мог поймать ни один юнит-тест ядра.
// Ядро мержит переданный конфиг ПОВЕРХ своих дефолтов:
//     cfg = { ...DEFAULT_CONFIG, ...(config || {}) }
// а ipc.js передаёт туда getConfig().nightWatch целиком. Значит любой ключ,
// присутствующий в config.js, ЗАТИРАЕТ значение ядра — и когда в ядре подняли
// maxRetries с 3 до 5 (окно ретраев ~16 мин → ~1.5 часа), в бою по-прежнему
// действовала тройка из config.js. Тесты ядра этого не видели: они передают
// конфиг без maxRetries и работают с дефолтом ядра.
//
// config.js напрямую не импортируется (он зовёт require('electron') на
// верхнем уровне и под node --test не грузится), поэтому дефолты читаются из
// исходника — тот же приём, что у стражей broadcast/registry.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_CONFIG } = require('../src/main/night-watch');

const CONFIG_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'main', 'config.js'),
  'utf8',
);

// Секция nightWatch из DEFAULTS config.js → { ключ: число }.
function nightWatchDefaultsFromConfig() {
  const start = CONFIG_SRC.indexOf('nightWatch: {');
  assert.notStrictEqual(start, -1, 'в config.js не найдена секция nightWatch — страж разъехался с исходником');
  const end = CONFIG_SRC.indexOf('}', start);
  const body = CONFIG_SRC.slice(start, end);
  const out = {};
  for (const m of body.matchAll(/(\w+):\s*(\d+)/g)) out[m[1]] = Number(m[2]);
  return out;
}

test('дефолты ночной смены в config.js совпадают с ядром', () => {
  const fromConfig = nightWatchDefaultsFromConfig();
  assert.ok(Object.keys(fromConfig).length > 0, 'из config.js не разобрался ни один ключ');

  const mismatched = [];
  for (const [key, value] of Object.entries(fromConfig)) {
    if (!(key in DEFAULT_CONFIG)) {
      mismatched.push(`${key}: есть в config.js, но ядро о нём не знает`);
      continue;
    }
    if (DEFAULT_CONFIG[key] !== value) {
      mismatched.push(`${key}: config.js=${value}, ядро=${DEFAULT_CONFIG[key]} — в бою победит config.js`);
    }
  }

  assert.deepStrictEqual(
    mismatched, [],
    `дефолты разошлись, и правка ядра до боя не доедет:\n${mismatched.join('\n')}`,
  );
});

test('окно ретраев в боевых настройках переживает ночной отвал сети', () => {
  // Смысловая проверка поверх формальной сверки: считаем то же, что считает
  // ядро (delay = min(retryMs * 2^(n-1), retryMaxMs)), и требуем, чтобы суммы
  // хватало на транзиент длиннее собственных бэкоффов авторизации (401 — 15
  // минут, 429 — 10). Было 3 × 5 мин = 15 минут, то есть ровно на границе.
  const cfg = { ...DEFAULT_CONFIG, ...nightWatchDefaultsFromConfig() };
  let total = 0;
  for (let n = 1; n <= cfg.maxRetries; n += 1) {
    total += Math.min(cfg.retryMs * (2 ** (n - 1)), cfg.retryMaxMs);
  }
  const minutes = total / 60000;
  assert.ok(minutes >= 90, `окно ретраев всего ${minutes} мин — ночной отвал сети снова съест всю ночь`);
});
