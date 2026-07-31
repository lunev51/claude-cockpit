'use strict';
// Загрузка config.json с дефолтами. Конфиг лежит в корне проекта
// (рядом с package.json); при упаковке asar — читается оттуда же.

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { appRoot } = require('./paths');

const DEFAULTS = {
  terminal: {
    command: 'claude',
    args: [],
    cwd: '',
    fontSize: 14,
    fontFamily: '"JetBrainsMono NF", "Cascadia Mono", Consolas, monospace',
    scrollback: 5000,
    copyOnSelect: true,
    rightClickPaste: true,
    webgl: false,
    useConpty: true,
    useConptyDll: true,
  },
  bridge: { port: 48200 },
  // Task 2 фазы 6 (панель диффа): открыта/закрыта панель — переживает
  // перезапуск приложения (config:set пишет сюда при каждом Ctrl+G/клике).
  ui: { diffPanelOpen: false },
  actionBar: {
    commands: [
      { label: '/remote-control', command: '/remote-control' },
      { label: '/compact', command: '/compact' },
      { label: '/usage', command: '/usage' },
    ],
  },
  // Task 2 фазы 8 («Ночная смена»): дефолты ядра night-watch.js (спека
  // docs/superpowers/specs/2026-07-29-night-watch-design.md) — мержатся
  // с пользовательским оверлеем тем же deepMerge, что и остальные секции
  // ниже; ipc.js передаёт getConfig().nightWatch в createNightWatch({config}).
  nightWatch: {
    fiveHourThreshold: 95,
    wakeMarginMs: 60000,
    staggerMs: 10000,
    maxResets: 4,
    retryMs: 300000,
    maxRetries: 3,
  },
  // Task 2 фазы 9 (голосовой ввод): дефолты для createStt (stt.js, Task 1,
  // спека docs/superpowers/specs/2026-07-29-voice-input-design.md). БЕЗ
  // stackRoots — DEFAULTS этого файла статичны (никакого require('electron')
  // на этапе объявления объекта), а корень appRoot() резолвится только в
  // рантайме Electron; дефолт stackRoots подставляется в момент создания
  // инстанса в ipc.js (getOrCreateStt()) — минимально инвазивный способ,
  // тот же приём, что terminal.cwd ниже (app.getPath('home') после merge).
  stt: {
    model: 'large-v3-turbo-q5_0',
    language: 'ru',
    threads: 6,
    serverPort: 48753,
    holdKey: 'ShiftRight',
    minHoldMs: 300,
  },
};

let cached = null;
// Флаг: корневой config.json есть, но не распарсился (битый JSON, не ENOENT).
// main.js после создания окна показывает уведомление, если флаг взведён.
let rootConfigCorrupt = false;
function isRootConfigCorrupt() {
  return rootConfigCorrupt;
}

// Ключи, через которые возможно загрязнение прототипа (prototype pollution).
// Конфиг теперь пишется из renderer, поэтому отсекаем их при слиянии.
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function deepMerge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    if (DANGEROUS_KEYS.has(k)) continue;
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(base[k] || {}, v) : v;
  }
  return out;
}

// Путь к пользовательскому оверлею (поверх config.json из корня проекта).
function overlayPath() {
  return path.join(app.getPath('userData'), 'config.user.json');
}

// isRoot — отмечать ли rootConfigCorrupt при ошибке парсинга (только для
// корневого config.json; для оверлея флаг не взводим).
function readJson(file, isRoot = false) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (isRoot) rootConfigCorrupt = false;
    return data;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[config] не удалось прочитать ${file}: ${err.message}`);
      // Файл есть, но JSON битый — отличаем от отсутствия файла.
      if (isRoot) rootConfigCorrupt = true;
    }
    return {};
  }
}

function getConfig() {
  if (cached) return cached;
  // Трёхслойная загрузка: DEFAULTS ← config.json (корень) ← оверлей userData.
  const projectFile = readJson(path.join(appRoot(), 'config.json'), true);
  const overlay = readJson(overlayPath());
  cached = deepMerge(deepMerge(DEFAULTS, projectFile), overlay);
  if (!cached.terminal.cwd) cached.terminal.cwd = app.getPath('home');
  // Minor-4/5 (ревью Task 2 фазы 9): вычисляемые/восстановительные патчи
  // секции stt ПОСЛЕ merge — тем же приёмом, что terminal.cwd выше.
  // (5) `"stt": null` у пользователя: deepMerge заменяет секцию целиком —
  // без восстановления cfg.model стал бы undefined и стек «не находился бы»
  // на полностью исправной машине (ggml-undefined.bin).
  if (!cached.stt || typeof cached.stt !== 'object') cached.stt = deepMerge(DEFAULTS.stt, {});
  // (4) stackRoots — вычисляемый дефолт: appRoot() доступен только в
  // рантайме. Патч здесь (а не в ipc.js) кладёт ключ в эффективный конфиг —
  // тост «см. stt.stackRoots в конфиге» ссылается на то, что пользователь
  // реально может увидеть через config:get.
  if (!Array.isArray(cached.stt.stackRoots) || !cached.stt.stackRoots.length) {
    cached.stt.stackRoots = [appRoot(), 'C:\\Users\\Lunev\\AssistClaude\\claude-companion'];
  }
  return cached;
}

// Deep-merge partial в текущий оверлей, записать оверлей-файл, сбросить кэш.
function setConfig(partial) {
  const overlay = readJson(overlayPath());
  const merged = deepMerge(overlay, partial || {});
  fs.writeFileSync(overlayPath(), JSON.stringify(merged, null, 2), 'utf8');
  cached = null;
  return getConfig();
}

module.exports = { getConfig, setConfig, isRootConfigCorrupt };
