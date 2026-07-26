'use strict';
// Менеджер сессий: tabId → pty. Чистый Node-модуль без Electron —
// фабрика pty и конфиг терминала инжектятся (тестируется node:test).

const path = require('path');
const crypto = require('crypto');

// ptyFactory(opts) → {write, resize, kill, pid} — в проде это createPty из pty.js.
// getTermConfig() → {command, args, useConpty, useConptyDll} из config.terminal.
// onEvent(channel, payload) — доставка событий (в проде: win.webContents.send).
function createSessionManager({ ptyFactory, getTermConfig, onEvent }) {
  const tabs = new Map(); // tabId → {tabId, cwd, name, smoke, proc, cols, rows, alive}

  function open({ cwd, smoke = false }) {
    const tabId = crypto.randomUUID();
    const name = path.basename(cwd) || cwd;
    tabs.set(tabId, { tabId, cwd, name, smoke, proc: null, cols: 80, rows: 24, alive: false });
    return { tabId, cwd, name };
  }

  function spawn(tab) {
    const t = getTermConfig();
    const spec = tab.smoke
      ? { command: 'cmd.exe', args: ['/c', 'echo PTY_OK'] }
      : { command: t.command, args: t.args };
    try {
      let myProc;
      myProc = ptyFactory({
        ...spec,
        cwd: tab.cwd,
        cols: tab.cols,
        rows: tab.rows,
        useConpty: t.useConpty !== false,
        useConptyDll: t.useConptyDll !== false,
        env: { ...process.env, COCKPIT: '1', COCKPIT_TAB_ID: tab.tabId },
        onData: (data) => {
          // Гасим "осиротевший" вывод процесса, которого рестарт уже подменил
          // (тот же принцип, что и в onExit ниже). tab.proc в момент вызова
          // может ещё быть null — если ptyFactory успевает синхронно отдать
          // первые данные ДО того, как строка "tab.proc = myProc" ниже
          // выполнится. Сравниваем только когда tab.proc уже назначен —
          // иначе легитимный первый вывод свежего процесса был бы проглочен.
          if (tab.proc && tab.proc !== myProc) return;
          onEvent('term:data', { tabId: tab.tabId, data });
        },
        onExit: (exitCode) => {
          // Обнуляем только свой процесс: рестарт мог уже подменить proc.
          if (tab.proc === myProc) {
            tab.proc = null;
            tab.alive = false;
          }
          onEvent('term:exit', { tabId: tab.tabId, exitCode });
        },
      });
      tab.proc = myProc;
      tab.alive = true;
      onEvent('term:started', { tabId: tab.tabId, pid: myProc.pid });
    } catch (err) {
      tab.proc = null;
      tab.alive = false;
      onEvent('term:data', {
        tabId: tab.tabId,
        data: `\x1b[31m[не удалось запустить ${spec.command}: ${err.message}]\x1b[0m\r\n`,
      });
      onEvent('term:exit', { tabId: tab.tabId, exitCode: -1 });
    }
  }

  function start(tabId, cols, rows) {
    const tab = tabs.get(tabId);
    if (!tab || tab.proc) return;
    tab.cols = cols;
    tab.rows = rows;
    spawn(tab);
  }

  function write(tabId, data) {
    const tab = tabs.get(tabId);
    if (tab && tab.proc) tab.proc.write(data);
  }

  function resize(tabId, cols, rows) {
    const tab = tabs.get(tabId);
    if (!tab) return;
    tab.cols = cols;
    tab.rows = rows;
    if (tab.proc) tab.proc.resize(cols, rows);
  }

  function restart(tabId) {
    const tab = tabs.get(tabId);
    if (!tab) return;
    if (tab.proc) {
      try { tab.proc.kill(); } catch { /* мог уже завершиться */ }
      tab.proc = null;
      tab.alive = false;
    }
    spawn(tab);
  }

  function close(tabId) {
    const tab = tabs.get(tabId);
    if (!tab) return;
    if (tab.proc) {
      try { tab.proc.kill(); } catch { /* мог уже завершиться */ }
    }
    tabs.delete(tabId);
  }

  function list() {
    return [...tabs.values()].map(({ tabId, cwd, name, alive }) => ({ tabId, cwd, name, alive }));
  }

  function disposeAll() {
    for (const tabId of [...tabs.keys()]) close(tabId);
  }

  return { open, start, write, resize, restart, close, list, disposeAll };
}

module.exports = { createSessionManager };
