'use strict';
// Точка входа main-процесса Electron.

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, screen, globalShortcut } = require('electron');
const { registerIpc, disposePty } = require('./ipc');
const { getConfig, setConfig, isRootConfigCorrupt } = require('./config');
const { startSpeakServer, stopSpeakServer } = require('./speak-server');
const { ensureWorkdir, seedWorkdir } = require('./workdir');
const { startPttHook } = require('./ptt-hook');
const { setWindow, notify } = require('./notify');
const { setNotifier } = require('./tts');
const { appRoot } = require('./paths');

// Health-check голосового стека: для каждого отсутствующего ресурса — тост.
// Неблокирующий, вызывается после создания окна (вне smoke).
function checkVoiceStack() {
  const root = appRoot();
  const cfg = getConfig();
  const p = (...s) => path.join(root, ...s);

  const checks = [
    [p('vendor', 'whisper', 'whisper-server.exe'), 'whisper-server.exe', 'распознавание'],
    [p('models', 'whisper', `ggml-${cfg.stt?.model}.bin`), `ggml-${cfg.stt?.model}.bin`, 'распознавание'],
    [p('vendor', 'piper', 'piper.exe'), 'piper.exe', 'озвучка'],
    [p('models', 'tts', 'ru_RU-irina-medium.onnx'), 'ru_RU-irina-medium.onnx', 'русская озвучка'],
    [p('models', 'tts', `${cfg.tts?.piperVoiceEn || 'en_US-amy-medium'}.onnx`), `${cfg.tts?.piperVoiceEn || 'en_US-amy-medium'}.onnx`, 'английская озвучка'],
    [p('models', 'tts', 'v4_ru.pt'), 'v4_ru.pt', 'Silero'],
    [p('assets', 'avatar.vrm'), 'avatar.vrm', 'аватар'],
    [p('sidecar', 'rshift-hook.ps1'), 'rshift-hook.ps1', 'push-to-talk'],
  ];
  for (const [file, name, consequence] of checks) {
    if (!fs.existsSync(file)) notify(`не найден: ${name} — ${consequence}`, 'warn');
  }

  // venv python: bundled или из конфига (tts.venvPython).
  const bundledVenv = p('sidecar', 'venv', 'Scripts', 'python.exe');
  const venvPython = fs.existsSync(bundledVenv) ? bundledVenv : (cfg.tts?.venvPython || '');
  const venvOk = venvPython && fs.existsSync(venvPython);
  if (!venvOk) {
    notify('не найден: python venv — Silero', 'warn');
    if (cfg.tts?.engine === 'silero') {
      notify('Silero недоступен — голос будет Piper (Ирина)', 'warn');
    }
  }
}

const SMOKE = process.argv.includes('--smoke');

// Вторая копия приложения дерётся за порты 48751/48752 (озвучка/распознавание)
// и микрофон — поведение становится непредсказуемым. Разрешаем одну копию.
// В smoke-режиме блокировку не берём (smoke гоняется параллельно с dev-окном).
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
    backgroundColor: '#0e0e13',
    title: `Claude Companion — ${getConfig().terminal.cwd}`,
    // Системный тайтлбар скрыт — своя drag-полоса в renderer (#titlebar),
    // кнопки окна рисует Windows поверх (overlay).
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0e0e13', symbolColor: '#6b6f7b', height: 34 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Голос должен работать и в фоне: без этого таймеры renderer
      // (статусы, ожидание команды) замирают у неактивного окна.
      backgroundThrottling: false,
    },
  };
  // Восстанавливаем позицию, только если она видна на текущих дисплеях.
  if (positionVisible(saved.x, saved.y, width, height)) {
    winOpts.x = saved.x;
    winOpts.y = saved.y;
  }

  const win = new BrowserWindow(winOpts);
  if (saved.isMaximized) win.maximize();

  // Разрешаем только доступ к микрофону/медиа, остальное запрещаем.
  win.webContents.session.setPermissionRequestHandler((wc, permission, cb) => {
    cb(permission === 'media');
  });

  // --- Сохранение состояния с debounce 500мс ---
  let saveTimer = null;
  function saveState() {
    if (win.isDestroyed()) return;
    const isMaximized = win.isMaximized();
    // В развёрнутом состоянии getBounds() даёт максимальные размеры —
    // сохраняем «нормальные» границы через getNormalBounds().
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

app.whenReady().then(async () => {
  // --- smoke-режим: проверка запуска без GUI-взаимодействия ---
  let ptyOutput = '';
  let rendererErrors = 0;

  const win = createWindow();

  // Регистрируем окно как получателя уведомлений и подключаем notify к TTS.
  setWindow(win);
  setNotifier(notify);

  // Вне smoke-режима — убеждаемся в рабочей папке и засеваем её шаблонами.
  if (!SMOKE) {
    const cwd = await ensureWorkdir(win, getConfig, setConfig);
    seedWorkdir(cwd);
    win.setTitle(`Claude Companion — ${cwd}`);

    // Глобальная клавиша записи (работает без фокуса окна): toggle-режим —
    // нажал: запись, нажал ещё раз: распознать и отправить.
    const hotkey = getConfig().stt?.globalHotkey || 'F8';
    try {
      const ok = globalShortcut.register(hotkey, () => {
        if (!win.isDestroyed()) win.webContents.send('stt:ptt-toggle');
      });
      if (!ok) console.warn(`[stt] глобальная клавиша ${hotkey} занята другим приложением`);
    } catch (err) {
      console.warn(`[stt] не удалось зарегистрировать ${hotkey}: ${err.message}`);
    }

    // Глобальный push-to-talk на правый Shift через низкоуровневый хук.
    startPttHook(win, getConfig);

    // Health-check и уведомление о битом конфиге — после загрузки renderer,
    // иначе тосты уйдут раньше, чем renderer подпишется на 'app:notice'.
    win.webContents.once('did-finish-load', () => {
      if (isRootConfigCorrupt()) {
        notify('config.json повреждён — работаю на дефолтах', 'error');
      }
      checkVoiceStack();
    });
  }

  registerIpc(win, {
    smoke: SMOKE,
    onPtyData: SMOKE ? (data) => { ptyOutput += data; } : null,
  });

  // Speak-сервер для озвучки ответов (вне smoke-режима, если включён).
  if (!SMOKE && getConfig().tts && getConfig().tts.enabled) {
    startSpeakServer(win, getConfig);
  }

  // Удалённое управление через Telegram (вне smoke-режима). Стартуем с
  // небольшой задержкой, чтобы speak-сервер успел занять фактический порт —
  // его передаём слушателю для инъекции команд (POST /command).
  if (!SMOKE) {
    // Авто-очистка накопившихся транскриптов сессий (основные >7д, суб-агенты >3д).
    try { require('./session-cleanup').cleanupSessions(getConfig); } catch (e) {
      console.warn(`[session-cleanup] не запущен: ${e.message}`);
    }
    setTimeout(() => {
      try {
        const { getActualPort } = require('./speak-server');
        const port = getActualPort() || getConfig().tts?.port || 48751;
        require('./tg-remote').startTgRemote(getConfig, port);
      } catch (err) {
        console.warn(`[tg-remote] старт не удался: ${err.message}`);
      }
    }, 1500);
  }

  // Ошибки renderer всегда дублируем в stdout — иначе их не видно при фоновом запуске.
  win.webContents.on('console-message', (eventOrDetails, level, message) => {
    const lvl = typeof level === 'undefined' ? eventOrDetails.level : level;
    const msg = typeof message === 'undefined' ? eventOrDetails.message : message;
    if (lvl === 'error' || lvl === 3) {
      // Отладочные каналы ([wake-text], [dbg]) — не ошибки, в счётчик smoke не идут.
      const isDebug = typeof msg === 'string' && /^\[(wake-text|dbg)/.test(msg);
      if (!isDebug) rendererErrors += 1;
      console.log(`[renderer-error] ${msg}`);
    }
  });
  // Краш renderer-процесса — частая причина «тихого» падения приложения.
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
      console.log(`[smoke] pty=${ptyOutput.slice(0, 80)}`);
      console.log(`[smoke] renderer-errors=${rendererErrors}`);
      disposePty();
      // Код выхода: 1 при ошибках renderer или если pty не выдал PTY_OK.
      const ok = rendererErrors === 0 && ptyOutput.includes('PTY_OK');
      app.exit(ok ? 0 : 1);
    }, 8000);
  }
});

// Освобождение всех сайдкаров/серверов. Идемпотентно — безопасно вызывать
// повторно (все dispose-функции уже идемпотентны), поэтому дёргаем её из
// всех путей выхода.
function disposeAll() {
  try { disposePty(); } catch (e) { console.error(e); }
  try { stopSpeakServer(); } catch (e) { console.error(e); }
  // Убиваем Python-сайдкар Silero, иначе процесс не даёт приложению выйти чисто.
  try { require('./tts/silero').dispose(); } catch { /* не запускался */ }
  // Убиваем долгоживущий whisper-server, иначе процесс держит порт/приложение.
  try { require('./stt').disposeStt(); } catch { /* не запускался */ }
  // Убиваем PowerShell-сайдкар глобального push-to-talk.
  try { require('./ptt-hook').disposePttHook(); } catch { /* не запускался */ }
  // Убиваем Python-сайдкар Telegram-слушателя.
  try { require('./tg-remote').disposeTgRemote(); } catch { /* не запускался */ }
}

app.on('window-all-closed', () => {
  disposeAll();
  app.quit();
});

app.on('before-quit', () => {
  globalShortcut.unregisterAll();
  disposeAll();
});

// Любое необработанное исключение не должно оставлять висящие сайдкары.
process.on('uncaughtException', (e) => {
  console.error(e);
  disposeAll();
  app.exit(1);
});
