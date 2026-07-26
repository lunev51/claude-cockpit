'use strict';
// Глобальный push-to-talk на ПРАВЫЙ Shift через PowerShell-сайдкар с
// низкоуровневым клавиатурным хуком (WH_KEYBOARD_LL). Сайдкар построчно пишет
// в stdout RSHIFT_DOWN / RSHIFT_UP / HOOK_READY; мы транслируем это в renderer.

const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { appRoot } = require('./paths');

const RESTART_COOLDOWN_MS = 30000; // рестарт при падении не чаще раза в 30с

let proc = null;
let lastSpawnAt = 0;

function scriptPath() {
  return path.join(appRoot(), 'sidecar', 'rshift-hook.ps1');
}

function startPttHook(win, getConfig) {
  // Глобальный хук можно выключить из конфига.
  if (getConfig().stt?.globalPushToTalk === false) return;
  if (proc) return;

  // Троттлинг рестартов: не чаще раза в 30с.
  const since = Date.now() - lastSpawnAt;
  if (lastSpawnAt && since < RESTART_COOLDOWN_MS) return;
  lastSpawnAt = Date.now();

  let myProc;
  try {
    myProc = spawn('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath()],
      { windowsHide: true });
  } catch (err) {
    console.warn(`[ptt] не удалось запустить сайдкар: ${err.message}`);
    return;
  }
  proc = myProc;

  const rl = readline.createInterface({ input: myProc.stdout });
  rl.on('line', (line) => {
    const s = line.trim();
    if (!s) return;
    if (win.isDestroyed()) return;
    if (s === 'RSHIFT_DOWN') {
      win.webContents.send('stt:ptt-down');
    } else if (s === 'RSHIFT_UP') {
      win.webContents.send('stt:ptt-up');
    } else if (s === 'HOOK_READY') {
      console.log('[ptt] хук активен');
      win.webContents.send('stt:ptt-hook', { active: true });
    }
  });

  myProc.stderr.on('data', (d) => {
    const t = d.toString().trim();
    if (t) console.warn(`[ptt] ${t}`);
  });

  myProc.on('close', (code) => {
    if (proc === myProc) proc = null;
    if (!win.isDestroyed()) win.webContents.send('stt:ptt-hook', { active: false });
    console.warn(`[ptt] сайдкар завершился (код ${code})`);
    // Рестарт (троттлинг внутри startPttHook не даст частить).
    setTimeout(() => {
      if (!win.isDestroyed()) startPttHook(win, getConfig);
    }, RESTART_COOLDOWN_MS);
  });

  myProc.on('error', (err) => {
    if (proc === myProc) proc = null;
    console.warn(`[ptt] ошибка сайдкара: ${err.message}`);
  });
}

function disposePttHook() {
  if (!proc) return;
  const pid = proc.pid;
  try { proc.kill(); } catch { /* мог уже завершиться */ }
  // На Windows kill() может не добить powershell — контрольный taskkill.
  try {
    require('child_process').execFile('taskkill', ['/PID', String(pid), '/T', '/F'],
      { windowsHide: true }, () => {});
  } catch { /* */ }
  proc = null;
}

module.exports = { startPttHook, disposePttHook };
