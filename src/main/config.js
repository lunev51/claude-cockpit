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
  avatar: {
    visible: true,
    vrmPath: 'assets/avatar.vrm',
    side: 'right',
    widthPercent: 36,
    cameraFov: 22,
    lookAtCamera: true,
  },
  stt: {
    engine: 'whisper.cpp', model: 'large-v3-turbo-q5_0', language: 'ru',
    prompt: 'Юки, привет. Юки, открой проект и запусти тесты. Окей, сделай коммит.',
    hotkey: 'ShiftRight', globalHotkey: 'F8', globalPushToTalk: true, autoSubmit: true,
    mode: 'push',
    wakeWords: ['юки', 'yuki', 'юкия', 'йоки', 'йокия', 'еки', 'юка', 'уки', 'иоки', 'uk', 'uki', 'юке'],
    sleepWords: ['спи', 'усни', 'отключись'],
    vadThreshold: 0.02, silenceMs: 400, minSegmentMs: 500, debug: false,
    threads: 6, serverPort: 48752, micDeviceLabel: '',
  },
  tts: { engine: 'silero', speaker: 'baya', sampleRate: 48000, enabled: true, port: 48751, maxChars: 600, volume: 0.9, fallback: 'piper', piperVoiceEn: 'en_US-amy-medium' },
  telegram: { remote: true, commands: true, autoReply: true, python: 'C:\\Users\\Lunev\\akto\\.venv\\Scripts\\python.exe' },
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
