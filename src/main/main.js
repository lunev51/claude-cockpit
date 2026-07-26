'use strict';
// Точка входа main-процесса Cockpit.

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, screen } = require('electron');
const { registerIpc, disposeSessions, getSmokeOutput } = require('./ipc');
const { getConfig, isRootConfigCorrupt } = require('./config');
const { setWindow, notify } = require('./notify');

const SMOKE = process.argv.includes('--smoke');

// Вторая копия дерётся за манифест воркспейса — разрешаем одну.
// В smoke-режиме блокировку не берём (гоняется параллельно с dev-окном).
if (!SMOKE && !app.requestSingleInstanceLock()) {
  app.quit();
}
app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

// --- Персист состояния окна (userData/window-state.json) ---
function stateFile() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function readWindowState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    return {};
  }
}

// Координаты валидны, только если попадают хотя бы в один дисплей.
function positionVisible(x, y, width, height) {
  if (typeof x !== 'number' || typeof y !== 'number') return false;
  return screen.getAllDisplays().some((d) => {
    const b = d.bounds;
    return x >= b.x && y >= b.y && x + width <= b.x + b.width && y + height <= b.y + b.height;
  });
}

function createWindow() {
  const saved = readWindowState();
  const width = saved.width || 1400;
  const height = saved.height || 900;

  const winOpts = {
    width,
    height,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#141413',
    title: 'Cockpit',
    // Системный тайтлбар скрыт — своя drag-полоса в renderer (#titlebar),
    // кнопки окна рисует Windows поверх (overlay).
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#141413', symbolColor: '#A09D96', height: 36 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Статусы и таймеры должны жить и у неактивного окна.
      backgroundThrottling: false,
    },
  };
  if (positionVisible(saved.x, saved.y, width, height)) {
    winOpts.x = saved.x;
    winOpts.y = saved.y;
  }

  const win = new BrowserWindow(winOpts);
  if (saved.isMaximized) win.maximize();

  // Кокпиту не нужны браузерные разрешения (микрофона больше нет).
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));

  // --- Сохранение состояния с debounce 500мс ---
  let saveTimer = null;
  function saveState() {
    if (win.isDestroyed()) return;
    const isMaximized = win.isMaximized();
    const b = win.getNormalBounds ? win.getNormalBounds() : win.getBounds();
    const data = { x: b.x, y: b.y, width: b.width, height: b.height, isMaximized };
    try {
      fs.writeFileSync(stateFile(), JSON.stringify(data, null, 2), 'utf8');
    } catch { /* запись не критична */ }
  }
  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveState, 500);
  }
  win.on('resize', scheduleSave);
  win.on('move', scheduleSave);
  win.on('close', () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveState();
  });

  // --- Безопасность: терминал рендерит недоверенный вывод ---
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  return win;
}

app.whenReady().then(() => {
  let rendererErrors = 0;

  const win = createWindow();
  setWindow(win);

  if (!SMOKE) {
    win.webContents.once('did-finish-load', () => {
      if (isRootConfigCorrupt()) {
        notify('config.json повреждён — работаю на дефолтах', 'error');
      }
    });
  }

  registerIpc(win, { smoke: SMOKE });

  // Ошибки renderer всегда дублируем в stdout — иначе их не видно при фоновом запуске.
  win.webContents.on('console-message', (eventOrDetails, level, message) => {
    const lvl = typeof level === 'undefined' ? eventOrDetails.level : level;
    const msg = typeof message === 'undefined' ? eventOrDetails.message : message;
    if (lvl === 'error' || lvl === 3) {
      rendererErrors += 1;
      console.log(`[renderer-error] ${msg}`);
    }
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[renderer-gone] reason=${details.reason} exitCode=${details.exitCode}`);
  });

  if (SMOKE) {
    win.webContents.on('did-finish-load', () => {
      console.log('[smoke] window=OK');
    });
    win.webContents.on('did-fail-load', () => {
      rendererErrors += 1;
    });
    setTimeout(() => {
      const ptyOutput = getSmokeOutput();
      console.log(`[smoke] pty=${ptyOutput.slice(0, 80)}`);
      console.log(`[smoke] renderer-errors=${rendererErrors}`);
      disposeSessions();
      const ok = rendererErrors === 0 && ptyOutput.includes('PTY_OK');
      app.exit(ok ? 0 : 1);
    }, 8000);
  }
});

app.on('window-all-closed', () => {
  disposeSessions();
  app.quit();
});

app.on('before-quit', () => {
  disposeSessions();
});

process.on('uncaughtException', (e) => {
  console.error(e);
  disposeSessions();
  app.exit(1);
});
