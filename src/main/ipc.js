'use strict';
// Все IPC-каналы регистрируются здесь. Task 3 фазы 1 заменит одиночный pty
// на sessions.js с адресацией по tabId — пока сохраняем поведение Companion.

const { ipcMain, shell } = require('electron');
const { getConfig, setConfig } = require('./config');
const { createPty } = require('./pty');

let ptyProc = null;
let lastCols = 80;
let lastRows = 24;
let smokeOutput = '';

function getSmokeOutput() {
  return smokeOutput;
}

// Проверка размеров терминала: целое в диапазоне 2..500.
function validDim(n) {
  return Number.isInteger(n) && n >= 2 && n <= 500;
}

function registerIpc(win, opts = {}) {
  const { smoke = false } = opts;

  function buildSpec() {
    const t = getConfig().terminal;
    return smoke
      ? { command: 'cmd.exe', args: ['/c', 'echo PTY_OK'], cwd: t.cwd }
      : { command: t.command, args: t.args, cwd: t.cwd };
  }

  function spawnPty(cols, rows) {
    const spec = buildSpec();
    try {
      let myProc;
      myProc = createPty({
        ...spec,
        cols,
        rows,
        useConpty: getConfig().terminal.useConpty !== false,
        useConptyDll: getConfig().terminal.useConptyDll !== false,
        env: { ...process.env, COCKPIT: '1' },
        onData: (data) => {
          if (smoke) smokeOutput += data;
          if (!win.isDestroyed()) win.webContents.send('term:data', data);
        },
        onExit: (exitCode) => {
          if (ptyProc === myProc) ptyProc = null;
          if (!win.isDestroyed()) win.webContents.send('term:exit', { exitCode });
        },
      });
      ptyProc = myProc;
      if (!win.isDestroyed()) win.webContents.send('term:started', { pid: ptyProc.pid });
    } catch (err) {
      ptyProc = null;
      if (!win.isDestroyed()) {
        win.webContents.send(
          'term:data',
          `\x1b[31m[не удалось запустить ${spec.command}: ${err.message}]\x1b[0m\r\n`,
        );
        win.webContents.send('term:exit', { exitCode: -1 });
      }
    }
  }

  ipcMain.handle('config:get', () => getConfig());

  ipcMain.handle('config:set', (_e, partial) => {
    if (!partial || typeof partial !== 'object' || Array.isArray(partial)) {
      throw new TypeError('config:set ожидает plain-object');
    }
    return setConfig(partial);
  });

  ipcMain.handle('shell:openExternal', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  ipcMain.on('term:start', (_e, { cols, rows } = {}) => {
    if (ptyProc) return;
    if (!validDim(cols) || !validDim(rows)) return;
    lastCols = cols;
    lastRows = rows;
    spawnPty(cols, rows);
  });

  ipcMain.on('term:restart', () => {
    if (ptyProc) {
      try { ptyProc.kill(); } catch { /* мог уже завершиться */ }
      ptyProc = null;
    }
    spawnPty(lastCols, lastRows);
  });

  ipcMain.on('term:write', (_e, data) => {
    if (typeof data !== 'string') return;
    if (ptyProc) ptyProc.write(data);
  });

  ipcMain.on('term:resize', (_e, { cols, rows } = {}) => {
    if (!validDim(cols) || !validDim(rows)) return;
    lastCols = cols;
    lastRows = rows;
    if (ptyProc) ptyProc.resize(cols, rows);
  });
}

function disposeSessions() {
  if (!ptyProc) return;
  try { ptyProc.kill(); } catch { /* процесс мог уже завершиться */ }
  ptyProc = null;
}

module.exports = { registerIpc, disposeSessions, getSmokeOutput };
