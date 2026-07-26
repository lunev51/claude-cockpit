'use strict';
// Удалённое управление компаньоном через Telegram (Pyrogram).
// Спавнит долгоживущий Python-сайдкар scripts/tg_listen.py, который:
//   - команды из Избранного → POST /command speak-сервера → терминал Юки;
//   - личку посторонних → авто-ответ через изолированную песочницу claude.
// Сессия/креды берутся из companion-home (созданы заранее tg_login.py).

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { appRoot } = require('./paths');

const RESTART_COOLDOWN_MS = 30000; // не перезапускать чаще раза в 30с

let proc = null;
let lastSpawnAt = 0;
let disposed = false;
let getConfigRef = null;
let speakPortRef = 0;

const DEFAULT_PYTHON = 'C:\\Users\\Lunev\\akto\\.venv\\Scripts\\python.exe';

// Рабочая папка Telegram = фактический terminal.cwd (там лежат .tg.json,
// tg_user.session, .tg-sessions.json). НЕ вычислять относительно appRoot —
// в упакованном exe это указывает мимо. Фоллбэк — companion-home рядом.
function companionHome() {
  const cwd = getConfigRef && getConfigRef().terminal && getConfigRef().terminal.cwd;
  if (cwd && fs.existsSync(cwd)) return cwd;
  return path.join(appRoot(), '..', 'companion-home');
}

function killProc() {
  if (proc) {
    const pid = proc.pid;
    try { proc.kill(); } catch { /* */ }
    // На Windows kill() может не добить python — контрольный taskkill дерева.
    try {
      require('child_process').execFile('taskkill', ['/PID', String(pid), '/T', '/F'],
        { windowsHide: true }, () => {});
    } catch { /* */ }
  }
  proc = null;
}

// startTgRemote(getConfig, speakPort): запускает слушатель, если включён и залогинен.
function startTgRemote(getConfig, speakPort) {
  disposed = false;
  getConfigRef = getConfig;
  if (typeof speakPort === 'number' && speakPort > 0) speakPortRef = speakPort;

  const cfg = getConfig() || {};
  const tg = cfg.telegram || {};
  if (tg.remote === false) {
    console.log('[tg-remote] выключен в конфиге (telegram.remote=false)');
    return;
  }

  // Без сессии Pyrogram стартовать нечего.
  const sessionFile = path.join(companionHome(), 'tg_user.session');
  if (!fs.existsSync(sessionFile)) {
    console.log('[tg-remote] Telegram не залогинен (нет tg_user.session) — слушатель не запущен');
    return;
  }

  const python = tg.python || DEFAULT_PYTHON;
  if (!fs.existsSync(python)) {
    console.log(`[tg-remote] не найден python: ${python} — слушатель не запущен`);
    return;
  }

  const script = path.join(appRoot(), 'scripts', 'tg_listen.py');
  // Порт speak-сервера: явный аргумент → конфиг tts.port → дефолт.
  const port = speakPortRef || (cfg.tts && cfg.tts.port) || 48751;

  if (proc) return; // уже запущен

  // Троттлинг рестартов: не чаще раза в 30с.
  const since = Date.now() - lastSpawnAt;
  if (lastSpawnAt && since < RESTART_COOLDOWN_MS) {
    setTimeout(() => { if (!disposed && !proc) startTgRemote(getConfigRef, speakPortRef); },
      RESTART_COOLDOWN_MS - since);
    return;
  }
  lastSpawnAt = Date.now();

  try {
    proc = spawn(python, [script], {
      windowsHide: true,
      env: {
        ...process.env,
        CC_SPEAK_PORT: String(port),
        CC_TG_COMMANDS: tg.commands !== false ? '1' : '0',
        CC_TG_AUTOREPLY: tg.autoReply !== false ? '1' : '0',
        CC_TG_WORKDIR: companionHome(), // абсолютный путь к рабочей папке Telegram
        PYTHONIOENCODING: 'utf-8',
        PYTHONWARNINGS: 'ignore',
      },
    });
  } catch (err) {
    console.warn(`[tg-remote] не удалось запустить: ${err.message}`);
    proc = null;
    return;
  }

  proc.stdout.on('data', (d) => {
    const t = d.toString().trim();
    if (t) console.log(`[tg-listen] ${t}`);
  });
  proc.stderr.on('data', (d) => {
    const t = d.toString().trim();
    if (t) console.log(`[tg-listen] ${t}`);
  });

  proc.on('error', (err) => {
    console.warn(`[tg-remote] процесс упал: ${err.message}`);
    proc = null;
  });
  proc.on('close', (code) => {
    console.log(`[tg-remote] слушатель завершился (код ${code})`);
    proc = null;
    // Авто-перезапуск при падении (не чаще раза в 30с), если не dispose.
    if (!disposed) {
      setTimeout(() => { if (!disposed && !proc) startTgRemote(getConfigRef, speakPortRef); },
        RESTART_COOLDOWN_MS);
    }
  });
}

function disposeTgRemote() {
  disposed = true;
  killProc();
}

module.exports = { startTgRemote, disposeTgRemote };
