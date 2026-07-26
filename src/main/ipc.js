'use strict';
// Все IPC-каналы. PTY-парк живёт в sessions.js; ipc — тонкий адаптер.

const { ipcMain, shell, dialog } = require('electron');
const { getConfig, setConfig } = require('./config');
const { createPty } = require('./pty');
const { createSessionManager } = require('./sessions');

let manager = null;
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

  manager = createSessionManager({
    ptyFactory: createPty,
    getTermConfig: () => getConfig().terminal,
    onEvent: (channel, payload) => {
      if (smoke && channel === 'term:data') smokeOutput += payload.data;
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    },
  });

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

  // Регистрация вкладки. cwd обязателен — renderer берёт его из диалога
  // или из конфига; smoke-режим подменяет команду в sessions.js.
  ipcMain.handle('tabs:open', (_e, { cwd } = {}) => {
    if (typeof cwd !== 'string' || !cwd) return null;
    return manager.open({ cwd, smoke });
  });

  ipcMain.handle('tabs:close', (_e, tabId) => {
    if (typeof tabId === 'string') manager.close(tabId);
  });

  ipcMain.handle('tabs:chooseFolder', async () => {
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Папка проекта для Claude',
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  ipcMain.on('term:start', (_e, { tabId, cols, rows } = {}) => {
    if (typeof tabId !== 'string') return;
    if (!validDim(cols) || !validDim(rows)) return;
    manager.start(tabId, cols, rows);
  });

  ipcMain.on('term:restart', (_e, { tabId } = {}) => {
    if (typeof tabId === 'string') manager.restart(tabId);
  });

  ipcMain.on('term:write', (_e, { tabId, data } = {}) => {
    if (typeof tabId !== 'string' || typeof data !== 'string') return;
    manager.write(tabId, data);
  });

  ipcMain.on('term:resize', (_e, { tabId, cols, rows } = {}) => {
    if (typeof tabId !== 'string') return;
    if (!validDim(cols) || !validDim(rows)) return;
    manager.resize(tabId, cols, rows);
  });
}

function disposeSessions() {
  if (manager) manager.disposeAll();
}

module.exports = { registerIpc, disposeSessions, getSmokeOutput };
