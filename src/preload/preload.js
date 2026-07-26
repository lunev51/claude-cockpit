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
  stt: {
    transcribe: (buf) => ipcRenderer.invoke('stt:transcribe', buf),
    onPttToggle: (cb) => ipcRenderer.on('stt:ptt-toggle', () => cb()),
    onPttDown: (cb) => ipcRenderer.on('stt:ptt-down', () => cb()),
    onPttUp: (cb) => ipcRenderer.on('stt:ptt-up', () => cb()),
    onPttHook: (cb) => ipcRenderer.on('stt:ptt-hook', (_e, info) => cb(info)),
  },
  tts: {
    onSpeak: (cb) => ipcRenderer.on('tts:speak', (_e, p) => cb(p)),
  },
  cmd: {
    onInject: (cb) => ipcRenderer.on('cmd:inject', (_e, p) => cb(p)),
  },
  app: {
    onNotice: (cb) => ipcRenderer.on('app:notice', (_e, n) => cb(n)),
  },
  workdir: {
    choose: () => ipcRenderer.invoke('workdir:choose'),
  },
});
