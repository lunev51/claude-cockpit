'use strict';
// Точка входа main-процесса Cockpit.

const fs = require('fs');
const path = require('path');
const {
  app, BrowserWindow, screen, Menu, nativeImage, Notification,
} = require('electron');
const {
  registerIpc, disposeSessions, getSmokeOutput, flushWorkspace, getActiveTabId,
} = require('./ipc');
const { getConfig, isRootConfigCorrupt } = require('./config');
const { setWindow, notify } = require('./notify');
const { createAttention } = require('./attention');
const { createToaster } = require('./toasts');

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
    backgroundColor: '#0F0F0F',
    title: 'Cockpit',
    // Системный тайтлбар скрыт — своя drag-полоса в renderer (#titlebar),
    // кнопки окна рисует Windows поверх (overlay).
    titleBarStyle: 'hidden',
    // Fix 1 (ревью): было '#141414' — светлее, чем #titlebar (var(--bg-window)
    // = #0F0F0F), из-за чего под кнопками окна был виден шов-прямоугольник.
    titleBarOverlay: { color: '#0F0F0F', symbolColor: '#9E9E9E', height: 36 },
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

  // Carryover 1 (ревью): Menu.setApplicationMenu(null) ниже нужен ради Ctrl+R
  // (Housekeeping #14), но заодно срубает стандартный F12-хоткей Electron —
  // возвращаем его точечно через before-input-event. Фильтр на keyDown
  // обязателен: событие приходит и на keyDown, и на keyUp — без фильтра
  // toggleDevTools() дёрнулся бы дважды подряд (открыл и тут же закрыл).
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      win.webContents.toggleDevTools();
    }
  });

  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  return win;
}

// Housekeeping #14: без этого Ctrl+R перезагружает renderer прямо поверх
// живых вкладок main-процесса — второй оверлей restore и дубликаты вкладок.
// DevTools этим не отрезаны: при необходимости открываются программно через
// win.webContents.openDevTools().
Menu.setApplicationMenu(null);

app.whenReady().then(() => {
  let rendererErrors = 0;

  const win = createWindow();
  setWindow(win);

  // Task 1 фазы 4: агрегат «сколько вкладок ждут» → overlay-иконка таскбара +
  // заголовок окна. attention.js — чистый модуль без Electron (тестируется
  // node --test), setOverlay/getWindow — единственные Electron-зависимые
  // точки, инжектируются здесь. dataUrl рисует renderer (badge.js) —
  // main про canvas ничего не знает, только ставит готовую иконку.
  const attention = createAttention({
    getWindow: () => win,
    setOverlay: (img, desc) => {
      win.setOverlayIcon(img ? nativeImage.createFromDataURL(img) : null, desc);
    },
  });

  // Task 2 фазы 4: Windows-тосты «не про то, на что смотришь» — toasts.js
  // чистый (без Electron), решает ТОЛЬКО «показывать или нет», а сами
  // Electron-зависимые точки (Notification, фокус окна, переключение вкладки)
  // инжектируются здесь же, рядом с attention (тот же паттерн). Проводка
  // (вызов toaster.onStatus из потока tab:status, имя вкладки из manager.list())
  // живёт в ipc.js — сюда только сборка зависимостей.
  const toaster = createToaster({
    isWindowFocused: () => win.isFocused(),
    // activeTabId — состояние ipc.js (workspace:setActive из renderer);
    // getActiveTabId — замыкание над ним, а не снимок на момент сборки.
    getActiveTabId,
    showNotification: ({ title, body, onClick }) => {
      // Notification.isSupported() гардит редкие среды без центра уведомлений
      // Windows (например, урезанный WORKGROUP-сервер) — тост тогда просто не
      // показывается, приложение не падает.
      if (!Notification.isSupported()) return;
      const n = new Notification({ title, body });
      n.on('click', onClick);
      n.show();
    },
    focusTab: (tabId) => {
      if (win.isDestroyed()) return;
      // Свёрнутое окно — самый вероятный случай клика по тосту (ревью, finding 2):
      // одного show() недостаточно, нужен restore() (та же идиома, что уже
      // используется в обработчике 'second-instance' чуть выше).
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      win.webContents.send('tab:activate', { tabId });
    },
  });

  if (!SMOKE) {
    win.webContents.once('did-finish-load', () => {
      if (isRootConfigCorrupt()) {
        notify('config.json повреждён — работаю на дефолтах', 'error');
      }
    });
  }

  registerIpc(win, { smoke: SMOKE, attention, toaster });

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
      flushWorkspace();
      disposeSessions();
      const ok = rendererErrors === 0 && ptyOutput.includes('PTY_OK');
      app.exit(ok ? 0 : 1);
    }, 8000);
  }
});

app.on('window-all-closed', () => {
  flushWorkspace();
  disposeSessions();
  app.quit();
});

app.on('before-quit', () => {
  flushWorkspace();
  disposeSessions();
});

process.on('uncaughtException', (e) => {
  console.error(e);
  flushWorkspace();
  disposeSessions();
  app.exit(1);
});
