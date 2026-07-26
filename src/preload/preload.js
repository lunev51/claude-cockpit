'use strict';
// Мост renderer ↔ main: только узкое API, без прямого доступа к Node.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    set: (partial) => ipcRenderer.invoke('config:set', partial),
  },
  term: {
    start: (cols, rows) => ipcRenderer.send('term:start', { cols, rows }),
    write: (data) => ipcRenderer.send('term:write', data),
    resize: (cols, rows) => ipcRenderer.send('term:resize', { cols, rows }),
    restart: () => ipcRenderer.send('term:restart'),
    onData: (cb) => ipcRenderer.on('term:data', (_e, d) => cb(d)),
    onExit: (cb) => ipcRenderer.on('term:exit', (_e, info) => cb(info)),
    onStarted: (cb) => ipcRenderer.on('term:started', (_e, info) => cb(info)),
  },
  shell: {
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  },
  app: {
    onNotice: (cb) => ipcRenderer.on('app:notice', (_e, n) => cb(n)),
  },
});
