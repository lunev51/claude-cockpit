'use strict';
// Все IPC-каналы. PTY-парк живёт в sessions.js; ipc — тонкий адаптер.

const path = require('path');
const { ipcMain, shell, dialog, app } = require('electron');
const { getConfig, setConfig } = require('./config');
const { createPty } = require('./pty');
const { createSessionManager } = require('./sessions');
const { createHookBridge } = require('./hook-bridge');
const { connectProject, isConnected } = require('./connector');
const { createWorkspaceStore } = require('./workspace');
const { appRoot } = require('./paths');

let manager = null;
let smokeOutput = '';
let bridge = null;       // текущий инстанс моста (может пересоздаваться при fallback на эфемерный порт)
let stuckTimer = null;
let store = null;        // стор манифеста воркспейса (workspace.js)
let activeTabId = null;  // последний tabId, о котором сообщил renderer через workspace:setActive
let smokeMode = false;   // копия флага smoke на уровне модуля — нужна flushWorkspace() снаружи registerIpc

function getSmokeOutput() {
  return smokeOutput;
}

// Путь к файлу с фактическим портом моста (читает scripts/cockpit-hook.js).
function bridgePortFile() {
  return path.join(app.getPath('userData'), 'bridge-port');
}

// Стартует мост на сконфигурированном порту; если порт занят (EADDRINUSE
// или что угодно другое) — пересоздаёт мост с эфемерным портом (0).
// portFile в любом случае получает фактический порт того инстанса,
// который в итоге успешно заслушал сокет.
function startBridge(sessions, smoke = false) {
  const desiredPort = getConfig().bridge?.port ?? 48200;
  // В smoke-режиме НЕ пишем файл с портом, чтобы параллельный smoke run
  // не перезаписывал port-файл живого инстанса умирающим эфемерным портом.
  const portFile = smoke ? null : bridgePortFile();
  bridge = createHookBridge({ sessions, port: desiredPort, portFile });
  return bridge.start().catch((err) => {
    console.warn(`[hook-bridge] порт ${desiredPort} занят, пробую эфемерный: ${err.message}`);
    bridge = createHookBridge({ sessions, port: 0, portFile });
    return bridge.start();
  }).catch((err) => {
    console.warn(`[hook-bridge] не удалось запустить мост даже на эфемерном порту: ${err.message}`);
  });
}

// Проверка размеров терминала: целое в диапазоне 2..500.
function validDim(n) {
  return Number.isInteger(n) && n >= 2 && n <= 500;
}

function registerIpc(win, opts = {}) {
  const { smoke = false } = opts;
  smokeMode = smoke;

  // Стор манифеста создаётся один раз на регистрацию — независимо от smoke,
  // чтобы workspace:get всегда мог отдать хоть что-то (в smoke он просто
  // никогда не пишется, см. syncWorkspace ниже).
  store = createWorkspaceStore({ file: path.join(app.getPath('userData'), 'workspace.json') });

  // Пересобирает манифест из живого состояния manager'а. activeIndex — позиция
  // activeTabId в manager.list() (renderer сообщает её через workspace:setActive);
  // не найдена/ещё не сообщена → 0 (совпадает со стартовой вкладкой).
  // В smoke-режиме — no-op: параллельный smoke run не должен затирать
  // манифест живого инстанса (тот же урок, что и с bridge-port-файлом).
  function syncWorkspace() {
    if (smoke) return;
    const list = manager.list();
    const idx = list.findIndex((t) => t.tabId === activeTabId);
    store.set({
      version: 1,
      activeIndex: idx === -1 ? 0 : idx,
      tabs: list.map(({ cwd, name, sessionId, ghostId }) => ({ cwd, name, sessionId, ghostId })),
    });
  }

  manager = createSessionManager({
    ptyFactory: createPty,
    getTermConfig: () => getConfig().terminal,
    // Ленивая: к моменту первого реального спавна мост почти наверняка уже
    // слушает (start() кикнут чуть ниже), а если ещё нет — просто без env,
    // хук-скрипт тогда шлёт события мимо (см. cockpit-hook.js, Task 3).
    getExtraEnv: () => (bridge && bridge.port() ? { COCKPIT_BRIDGE_PORT: String(bridge.port()) } : {}),
    onEvent: (channel, payload) => {
      if (smoke && channel === 'term:data') smokeOutput += payload.data;
      if (channel === 'tabs:changed') syncWorkspace();
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    },
  });

  // Мост создаётся ПОСЛЕ manager — маршрутизация по tabId из env pty,
  // session_id — fallback (findBySessionId/applyHookEvent).
  // startBridge сама ловит все ошибки старта (в т.ч. фолбэк на эфемерный
  // порт) — не роняем приложение из-за моста хуков.
  startBridge(manager, smoke);

  // Детект зависших вкладок (working без вывода дольше порога) — раз в 30с.
  // unref — таймер не держит event loop живым сам по себе.
  stuckTimer = setInterval(() => manager.checkStuck(), 30000);
  stuckTimer.unref?.();

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
  // command/args — прозрачный проброс (Task 4): staggered-resume шлёт
  // 'claude' + ['--resume', sessionId] на восстановлении вкладки. Тайпчек
  // здесь, а не в sessions.js — renderer недоверенный источник IPC-пейлоада.
  ipcMain.handle('tabs:open', (_e, { cwd, command, args } = {}) => {
    if (typeof cwd !== 'string' || !cwd) return null;
    const cmd = typeof command === 'string' ? command : undefined;
    const a = Array.isArray(args) && args.every((x) => typeof x === 'string') ? args : undefined;
    return manager.open({ cwd, smoke, command: cmd, args: a });
  });

  ipcMain.handle('tabs:close', (_e, tabId) => {
    if (typeof tabId === 'string') manager.close(tabId);
  });

  // Живой манифест воркспейса (Task 3): renderer читает его на старте (Task 4)
  // и репортит активную вкладку при каждом переключении.
  // smoke-изоляция: headless-прогон не должен видеть оверлей restore — иначе
  // он завис бы до таймаута (никто не жмёт Enter/Esc в smoke).
  ipcMain.handle('workspace:get', () => (smoke ? null : store.load()));

  ipcMain.on('workspace:setActive', (_e, p) => {
    if (p && typeof p.tabId === 'string') {
      activeTabId = p.tabId;
      if (!smoke) syncWorkspace();
    }
  });

  ipcMain.handle('tabs:chooseFolder', async () => {
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Папка проекта для Claude',
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  // Хуки Cockpit для проекта: прописываются в .claude/settings.json вкладки.
  const hookOpts = () => ({
    scriptPath: path.join(appRoot(), 'scripts', 'cockpit-hook.js'),
    portFile: path.join(app.getPath('userData'), 'bridge-port'),
  });
  const tabCwd = (tabId) => manager.list().find((t) => t.tabId === tabId)?.cwd || null;

  ipcMain.handle('project:connect', (_e, tabId) => {
    const cwd = tabCwd(tabId);
    if (!cwd) return { connected: false, error: 'вкладка не найдена' };
    return connectProject(cwd, hookOpts());
  });

  ipcMain.handle('project:status', (_e, tabId) => {
    const cwd = tabCwd(tabId);
    return { connected: cwd ? isConnected(cwd) : false };
  });

  ipcMain.on('term:start', (_e, payload) => {
    // Payload может прийти не объектом (null и т.п.) — деструктуризация упала
    // бы через uncaughtException прямо в app.exit(1). Отсекаем заранее.
    if (!payload || typeof payload !== 'object') return;
    const { tabId, cols, rows } = payload;
    if (typeof tabId !== 'string') return;
    if (!validDim(cols) || !validDim(rows)) return;
    manager.start(tabId, cols, rows);
  });

  ipcMain.on('term:restart', (_e, payload) => {
    if (!payload || typeof payload !== 'object') return;
    const { tabId } = payload;
    if (typeof tabId === 'string') manager.restart(tabId);
  });

  ipcMain.on('term:write', (_e, payload) => {
    if (!payload || typeof payload !== 'object') return;
    const { tabId, data } = payload;
    if (typeof tabId !== 'string' || typeof data !== 'string') return;
    manager.write(tabId, data);
  });

  ipcMain.on('term:resize', (_e, payload) => {
    if (!payload || typeof payload !== 'object') return;
    const { tabId, cols, rows } = payload;
    if (typeof tabId !== 'string') return;
    if (!validDim(cols) || !validDim(rows)) return;
    manager.resize(tabId, cols, rows);
  });
}

// Форсирует немедленную запись манифеста (debounce workspace.js иначе может
// не успеть до выхода процесса). Зовётся ДО disposeSessions — иначе к моменту
// flush() список вкладок уже опустеет из-за disposeAll() внутри неё.
// В smoke — no-op: манифест там и так никогда не писался (см. syncWorkspace).
function flushWorkspace() {
  if (smokeMode) return;
  if (store) store.flush();
}

// Идемпотентно гасит мост хуков (безопасно звать повторно — например,
// window-all-closed и before-quit оба доходят до disposeSessions).
function stopBridge() {
  if (bridge) {
    bridge.stop();
    bridge = null;
  }
}

function disposeSessions() {
  if (stuckTimer) {
    clearInterval(stuckTimer);
    stuckTimer = null;
  }
  stopBridge();
  if (manager) manager.disposeAll();
}

module.exports = { registerIpc, disposeSessions, stopBridge, getSmokeOutput, flushWorkspace };
