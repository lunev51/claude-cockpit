'use strict';
// Мост renderer ↔ main: только узкое API, без прямого доступа к Node.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    set: (partial) => ipcRenderer.invoke('config:set', partial),
  },
  tabs: {
    open: (opts) => ipcRenderer.invoke('tabs:open', opts),
    close: (tabId) => ipcRenderer.invoke('tabs:close', tabId),
    chooseFolder: () => ipcRenderer.invoke('tabs:chooseFolder'),
  },
  term: {
    start: (tabId, cols, rows) => ipcRenderer.send('term:start', { tabId, cols, rows }),
    write: (tabId, data) => ipcRenderer.send('term:write', { tabId, data }),
    resize: (tabId, cols, rows) => ipcRenderer.send('term:resize', { tabId, cols, rows }),
    restart: (tabId) => ipcRenderer.send('term:restart', { tabId }),
    onData: (cb) => ipcRenderer.on('term:data', (_e, p) => cb(p)),
    onExit: (cb) => ipcRenderer.on('term:exit', (_e, p) => cb(p)),
    onStarted: (cb) => ipcRenderer.on('term:started', (_e, p) => cb(p)),
  },
  shell: {
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  },
  app: {
    onNotice: (cb) => ipcRenderer.on('app:notice', (_e, n) => cb(n)),
  },
  project: {
    connect: (tabId) => ipcRenderer.invoke('project:connect', tabId),
    status: (tabId) => ipcRenderer.invoke('project:status', tabId),
  },
  tab: {
    onStatus: (cb) => ipcRenderer.on('tab:status', (_e, p) => cb(p)),
  },
  workspace: {
    get: () => ipcRenderer.invoke('workspace:get'),
    setActive: (tabId) => ipcRenderer.send('workspace:setActive', { tabId }),
    // FIX 2 (ревью): сигнал main'у, что восстановление воркспейса на старте
    // завершено (или решено начать пусто) — до этого момента синхронизация
    // манифеста заблокирована (см. workspace-sync.js, main/ipc.js).
    ready: () => ipcRenderer.send('workspace:ready'),
  },
  ghost: {
    save: (tabId, text) => ipcRenderer.invoke('ghost:save', { tabId, text }),
    load: (ghostId) => ipcRenderer.invoke('ghost:load', ghostId),
  },
});
