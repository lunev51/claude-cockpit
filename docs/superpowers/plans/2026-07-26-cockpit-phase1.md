# Cockpit Phase 1 — Чистка + каркас (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Превратить дубликат Claude Companion в многовкладочный каркас Cockpit: без голоса/аватара, с адресным IPC (tabId), пулом терминалов, сайдбаром-скелетом и дизайн-системой Claude-dark.

**Architecture:** Гибрид: настоящий Claude CLI в xterm.js-вкладках, GUI-обвязка вокруг. Main-процесс держит `sessions.js` (Map tabId → pty) с DI-фабрикой pty для тестов; renderer держит пул xterm-вью и сайдбар. Никакого парсинга ANSI — терминал «глупое стекло».

**Tech Stack:** Electron 29.4.6 (пиннут — пребилды node-pty), @homebridge/node-pty-prebuilt-multiarch, @xterm/xterm 6 + fit/search/web-links/unicode11/webgl, ванильный JS (ES-модули в renderer, CJS в main), node:test.

**Спека:** `docs/superpowers/specs/2026-07-26-cockpit-design.md` (фаза 1 из §9).

## Global Constraints

- Electron остаётся `29.4.6`; `postinstall` с prebuild-install не трогать.
- В `createPty` не менять: `useConpty + useConptyDll` (фикс кириллических глифов), resolveCommand через where.exe.
- В xterm НЕ включать `windowsPty`; unicode11/webgl — только по флагу конфига (дефолт off, артефакты ConPTY).
- Палитра — только тёплые серые из спеки §7: окно `#141413`, панели `#1F1E1B`, карточки `#262624`, hover `#30302E`, бордеры `#3A3733`, текст `#FAF9F5`/`#A09D96`/`#8F8D83`, терракота `#D97757` (hover `#A9583E`), success `#5DB872`, working `#5DB8A6`, warning `#E8A55A`, error `#C64545`. Холодных серых нет нигде.
- Все IPC-payload'ы терминала несут `tabId` (string UUID).
- Каждая задача заканчивается: `npm run smoke` → exit 0, затем commit.
- Комментарии в коде — по-русски, в стиле существующих файлов (объясняют «почему», не «что»).

---

### Task 1: Зачистка до минимального одно-терминального приложения

Удалить голос/аватар/Telegram/ассистентские скрипты; переписать `main.js`, `ipc.js`, `preload.js`, `index.html`, `app.js` до минимума «один терминал на всё окно». Логика терминала (`terminal.js`, `pty.js`) не меняется.

**Files:**
- Delete: `src/main/stt.js`, `src/main/speak-server.js`, `src/main/tts/` (вся папка), `src/main/ptt-hook.js`, `src/main/tg-remote.js`, `src/main/translit-dict.js`, `src/main/session-cleanup.js`, `src/main/workdir.js`, `src/renderer/js/avatar/` (вся), `src/renderer/js/voice/` (вся), `sidecar/` (вся), `templates/` (вся), `harness.html`, `test.vrm`, `scripts/` — все файлы КРОМЕ… (папку удалить целиком: gcal-*, spotify-*, tg_*, launch-game, drive-claude, claude-stop-hook, test-port-fallback, test-wakenames, __pycache__)
- Modify: `src/main/main.js` (переписать), `src/main/ipc.js` (переписать), `src/preload/preload.js` (переписать), `src/renderer/index.html` (переписать), `src/renderer/js/app.js` (переписать), `src/main/config.js` (урезать DEFAULTS), `package.json` (deps + build)
- Keep untouched: `src/main/pty.js`, `src/main/notify.js`, `src/main/paths.js`, `src/renderer/js/terminal.js`, `src/renderer/css/app.css` (заменится в Task 2)

**Interfaces:**
- Consumes: `createPty` из `pty.js` (как есть), `notify/setWindow` из `notify.js`, `getConfig/setConfig` из `config.js`.
- Produces (для Task 2-4): main-процесс без голосовых модулей; preload API `{config, shell, term, app}` (одно-терминальный — Task 3 заменит на адресный).

- [ ] **Step 1: Удалить файлы**

```powershell
cd C:\Users\Lunev\AssistClaude\claude-cockpit
git rm -r src/main/stt.js src/main/speak-server.js src/main/tts src/main/ptt-hook.js `
  src/main/tg-remote.js src/main/translit-dict.js src/main/session-cleanup.js src/main/workdir.js `
  src/renderer/js/avatar src/renderer/js/voice sidecar templates harness.html scripts
git rm --cached test.vrm 2>$null; if (Test-Path test.vrm) { Remove-Item test.vrm }
```

- [ ] **Step 2: Переписать `src/main/main.js`**

Полное содержимое (сохранены: single-instance, window-state c debounce, security-хендлеры, лог ошибок renderer, smoke-каркас; удалено: голос, PTT, speak-server, tg, workdir, globalShortcut, permission handler для media):

```js
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
```

- [ ] **Step 3: Переписать `src/main/ipc.js`** (одно-терминальный, как раньше, но без stt/speak/workdir; smoke-вывод собирается внутри)

```js
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
```

- [ ] **Step 4: Переписать `src/preload/preload.js`**

```js
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
```

- [ ] **Step 5: Переписать `src/renderer/index.html`** (без three/importmap/аватара/голоса; CSP без inline-хэша)

```html
<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'" />
  <title>Cockpit</title>
  <link rel="stylesheet" href="../../node_modules/@xterm/xterm/css/xterm.css" />
  <link rel="stylesheet" href="./css/app.css" />
  <!-- xterm.js — UMD-сборки, глобали window.Terminal, window.FitAddon,
       window.WebLinksAddon, window.SearchAddon, window.Unicode11Addon, window.WebglAddon -->
  <script src="../../node_modules/@xterm/xterm/lib/xterm.js"></script>
  <script src="../../node_modules/@xterm/addon-fit/lib/addon-fit.js"></script>
  <script src="../../node_modules/@xterm/addon-web-links/lib/addon-web-links.js"></script>
  <script src="../../node_modules/@xterm/addon-search/lib/addon-search.js"></script>
  <script src="../../node_modules/@xterm/addon-unicode11/lib/addon-unicode11.js"></script>
  <script src="../../node_modules/@xterm/addon-webgl/lib/addon-webgl.js"></script>
</head>
<body>
  <div id="titlebar"><span class="dot"></span><span id="titlebar-text">Cockpit</span></div>
  <div id="app">
    <div id="terminal-pane">
      <div id="terminal"></div>
    </div>
  </div>
  <div id="status-bar">
    <span id="status-pty">⌨ запуск…</span>
    <span id="status-font">A —</span>
  </div>
  <script type="module" src="./js/app.js"></script>
</body>
</html>
```

- [ ] **Step 6: Переписать `src/renderer/js/app.js`** (минимальный бутстрап: конфиг → терминал → статус-бар)

```js
'use strict';
// Бутстрап renderer: конфиг → один терминал на всё окно.
// Task 3-4 фазы 1 заменят это на пул вкладок.

import { initTerminal } from './terminal.js';

const $ = (id) => document.getElementById(id);

async function boot() {
  const config = await window.api.config.get();

  const statusPty = $('status-pty');
  const statusFont = $('status-font');

  initTerminal($('terminal'), config, {
    onPtyStatus: (s) => { statusPty.textContent = `⌨ ${s}`; },
    onFontSize: (px) => { statusFont.textContent = `A ${px}`; },
  });
  statusFont.textContent = `A ${config.terminal.fontSize}`;

  // Тосты из main (например, битый config.json).
  window.api.app.onNotice(({ text }) => {
    console.warn(`[notice] ${text}`);
  });
}

boot();
```

Примечание: `terminal.js` в этой задаче не меняется — его текущий API (`initTerminal(container, config, {onPtyStatus, onFontSize})`) совместим.

- [ ] **Step 7: Урезать `src/main/config.js` DEFAULTS** — заменить объект `DEFAULTS` целиком на:

```js
const DEFAULTS = {
  terminal: {
    command: 'claude',
    args: [],
    cwd: '',
    fontSize: 14,
    fontFamily: '"JetBrainsMono NF", "Cascadia Mono", Consolas, monospace',
    scrollback: 5000,
    copyOnSelect: true,
    rightClickPaste: true,
    webgl: false,
    useConpty: true,
    useConptyDll: true,
  },
};
```

Остальной файл (deepMerge, оверлей, rootConfigCorrupt) не трогать.

- [ ] **Step 8: `package.json`** — удалить зависимости `three` и `@pixiv/three-vrm`; сменить идентичность; вычистить extraResources. Итоговые поля (остальное не трогать):

```json
{
  "name": "claude-cockpit",
  "version": "0.1.0",
  "description": "Cockpit для Claude Code: вкладки-проекты, авто-resume, дашборд лимитов",
  "main": "src/main/main.js",
  "scripts": {
    "start": "electron .",
    "smoke": "electron . --smoke",
    "test": "node --test test/",
    "postinstall": "cd node_modules/@homebridge/node-pty-prebuilt-multiarch && npx prebuild-install --runtime electron --target 29.4.6",
    "dist": "electron-builder --win --x64"
  },
  "dependencies": {
    "@homebridge/node-pty-prebuilt-multiarch": "^0.13.1",
    "@xterm/addon-fit": "^0.11.0",
    "@xterm/addon-search": "^0.16.0",
    "@xterm/addon-unicode11": "^0.9.0",
    "@xterm/addon-web-links": "^0.12.0",
    "@xterm/addon-webgl": "^0.19.0",
    "@xterm/xterm": "^6.0.0"
  },
  "build": {
    "appId": "com.lunev.claude-cockpit",
    "productName": "Cockpit",
    "asar": false,
    "compression": "store",
    "npmRebuild": false,
    "directories": { "output": "dist" },
    "files": ["src/**", "assets/**", "config.json", "node_modules/**"],
    "win": { "target": "portable" },
    "electronVersion": "29.4.6"
  }
}
```

`config.json` в корне: оставить только ключ `terminal` (удалить avatar/stt/tts/telegram, если есть).

- [ ] **Step 9: Проверка**

Run: `cd C:\Users\Lunev\AssistClaude\claude-cockpit; npm run smoke`
Expected: `[smoke] window=OK`, `[smoke] pty=PTY_OK...`, `[smoke] renderer-errors=0`, exit 0.

- [ ] **Step 10: Commit**

```powershell
git add -A
git commit -m "feat: strip voice/avatar/telegram, minimal single-terminal shell"
```

---

### Task 2: Дизайн-система tokens.css + каркас окна (титлбар, сайдбар, статус-бар)

Новая оболочка по мокапу `layout-b-refined.html`: тёплый тёмный каркас, левый сайдбар-скелет с секциями, кастомный титлбар, тёплая xterm-палитра. Функциональность вкладок появится в Task 3-4 — здесь сайдбар статичен (один ряд-заглушка «терминал»).

**Files:**
- Create: `src/renderer/css/tokens.css`
- Modify: `src/renderer/css/app.css` (переписать), `src/renderer/index.html` (каркас), `src/renderer/js/terminal.js` (только константа THEME)

**Interfaces:**
- Produces: CSS-переменные `--bg-window`, `--bg-panel`, `--bg-card`, `--bg-hover`, `--border`, `--text`, `--text-muted`, `--text-dim`, `--accent`, `--accent-hover`, `--ok`, `--working`, `--warn`, `--err`, `--radius-s/m/l`; DOM-структура `#sidebar`, `#main`, `#terminal-host`, `#titlebar`, `#status-bar` — Task 4 наполняет сайдбар рядами `.tab-row`.

- [ ] **Step 1: Создать `src/renderer/css/tokens.css`**

```css
/* Дизайн-токены Cockpit — «Claude, но темнее» (спека §7).
   Вся серая шкала тёплая (hue 40-70); холодных серых в проекте нет. */
:root {
  --bg-window: #141413;
  --bg-panel:  #1F1E1B;
  --bg-card:   #262624;
  --bg-hover:  #30302E;
  --bg-wait:   #2e2320; /* подложка «ждёт тебя» */

  --border:      #3A3733;
  --border-soft: #403D38;
  --border-wait: #4a3227;

  --text:       #FAF9F5;
  --text-muted: #A09D96;
  --text-dim:   #8F8D83;

  --accent:        #D97757; /* терракота: ТОЛЬКО «ждёт тебя» и главные CTA */
  --accent-hover:  #A9583E;
  --accent-soft:   #CC785C;
  --ok:            #5DB872;
  --working:       #5DB8A6;
  --warn:          #E8A55A;
  --err:           #C64545;

  --radius-s: 8px;
  --radius-m: 12px;
  --radius-l: 16px;

  --font-ui: 'Inter', 'Segoe UI', sans-serif;
  --font-serif: 'Lora', Georgia, 'Times New Roman', serif;
  --font-mono: 'JetBrainsMono NF', 'Cascadia Mono', Consolas, monospace;
}
```

(Шрифты Lora/Inter пока через системные fallback'и; локальные woff2 — фаза 6.)

- [ ] **Step 2: Переписать `src/renderer/css/app.css`**

```css
/* Каркас Cockpit: титлбар / сайдбар / терминал / статус-бар. */
@import url('./tokens.css');

* { margin: 0; padding: 0; box-sizing: border-box; }

html, body {
  height: 100%;
  overflow: hidden;
  background: var(--bg-window);
  color: var(--text);
  font-family: var(--font-ui);
}

/* --- Титлбар: drag-полоса, кнопки окна рисует Windows (overlay) --- */
#titlebar {
  height: 36px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 12px;
  background: var(--bg-window);
  border-bottom: 1px solid var(--border);
  -webkit-app-region: drag;
  user-select: none;
}
#titlebar .dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--accent);
}
#titlebar-text {
  font-family: var(--font-serif);
  font-size: 14px;
  letter-spacing: -0.3px;
}
#titlebar-sub { color: var(--text-dim); font-size: 11px; }

/* --- Основная сетка --- */
#app {
  display: flex;
  height: calc(100% - 36px - 26px); /* минус титлбар и статус-бар */
}

/* --- Сайдбар --- */
#sidebar {
  width: 240px;
  flex: none;
  background: var(--bg-panel);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  padding: 8px 6px;
  gap: 2px;
  overflow-y: auto;
}
.sidebar-section {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  color: var(--text-dim);
  padding: 6px 6px 4px;
}
.sidebar-section.wait { color: var(--accent); }

.tab-row {
  display: flex;
  gap: 8px;
  padding: 7px 8px;
  border-radius: var(--radius-s);
  cursor: pointer;
  align-items: flex-start;
}
.tab-row:hover { background: var(--bg-hover); }
.tab-row.active { background: var(--bg-card); }
.tab-row.waiting { background: var(--bg-wait); border: 1px solid var(--border-wait); }

.tab-dot {
  width: 8px; height: 8px; border-radius: 50%;
  margin-top: 4px;
  flex: none;
  background: var(--text-dim);
}
.tab-dot.working { background: var(--working); }
.tab-dot.waiting { background: var(--accent); box-shadow: 0 0 6px var(--accent); animation: pulse 1.6s ease-in-out infinite; }
.tab-dot.done    { background: var(--ok); }
.tab-dot.error   { background: var(--err); }

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}

.tab-info { min-width: 0; flex: 1; }
.tab-name {
  font-size: 13px;
  font-weight: 500;
  display: flex;
  gap: 6px;
  align-items: baseline;
}
.tab-name .meta { font-size: 10px; color: var(--text-dim); font-weight: 400; }
.tab-sub {
  font-size: 11px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tab-close {
  border: none; background: none; color: var(--text-dim);
  cursor: pointer; font-size: 12px; padding: 0 2px;
  visibility: hidden;
}
.tab-row:hover .tab-close { visibility: visible; }
.tab-close:hover { color: var(--text); }

.sidebar-footer {
  margin-top: auto;
  border-top: 1px solid var(--border);
  padding-top: 8px;
  display: flex;
  gap: 6px;
}
.sidebar-btn {
  flex: 1;
  background: var(--bg-card);
  border: none;
  border-radius: var(--radius-s);
  color: var(--text-muted);
  font-family: var(--font-ui);
  font-size: 12px;
  padding: 7px 4px;
  cursor: pointer;
}
.sidebar-btn:hover { background: var(--bg-hover); color: var(--text); }

/* --- Главная область --- */
#main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
#terminal-host { flex: 1; min-height: 0; position: relative; }
/* Контейнеры терминалов вкладок (Task 4 создаёт .term-view на вкладку) */
.term-view { position: absolute; inset: 0; padding: 4px 0 0 8px; }
.term-view.hidden { display: none; }

/* --- Статус-бар --- */
#status-bar {
  height: 26px;
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 0 12px;
  background: var(--bg-panel);
  border-top: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-muted);
  user-select: none;
}
```

- [ ] **Step 3: Обновить `src/renderer/index.html`** — заменить блок `<body>` на:

```html
<body>
  <div id="titlebar">
    <span class="dot"></span>
    <span id="titlebar-text">Cockpit</span>
    <span id="titlebar-sub"></span>
  </div>
  <div id="app">
    <div id="sidebar">
      <div class="sidebar-section">Сессии</div>
      <div id="tab-list"></div>
      <div class="sidebar-footer">
        <button class="sidebar-btn" id="btn-new-tab">+ Проект</button>
      </div>
    </div>
    <div id="main">
      <div id="terminal-host">
        <div id="terminal" class="term-view"></div>
      </div>
    </div>
  </div>
  <div id="status-bar">
    <span id="status-pty">⌨ запуск…</span>
    <span id="status-font">A —</span>
  </div>
  <script type="module" src="./js/app.js"></script>
</body>
```

(`#terminal` пока живёт как единственный `.term-view`; `#tab-list` и `#btn-new-tab` оживут в Task 4 — до тех пор кнопка без обработчика, это нормально.)

- [ ] **Step 4: Тёплая палитра xterm** — в `src/renderer/js/terminal.js` заменить константу `THEME` целиком:

```js
// Тёплая тёмная палитра Cockpit (спека §7): фон окна, кремовый текст,
// терракотовый курсор. ANSI-цвета подогнаны под тёплую гамму.
const THEME = {
  background: '#141413',
  foreground: '#E8E6E1',
  cursor: '#D97757',
  cursorAccent: '#141413',
  selectionBackground: '#3A3733',
  black: '#1F1E1B',
  red: '#C64545',
  green: '#5DB872',
  yellow: '#E8A55A',
  blue: '#8CA8C8',
  magenta: '#B08BBF',
  cyan: '#5DB8A6',
  white: '#A09D96',
  brightBlack: '#57544E',
  brightRed: '#D97781',
  brightGreen: '#7BC98F',
  brightYellow: '#EFBE7E',
  brightBlue: '#A6BDD8',
  brightMagenta: '#C5A3D1',
  brightCyan: '#7FCDBD',
  brightWhite: '#FAF9F5',
};
```

- [ ] **Step 5: Проверка**

Run: `npm run smoke` → exit 0. Затем `npm start` вручную: окно в тёплой тёмной гамме, слева сайдбар с заголовком «Сессии» и кнопкой «+ Проект», терминал работает, Ctrl+колесо меняет шрифт.

- [ ] **Step 6: Commit**

```powershell
git add -A
git commit -m "feat: Claude-dark design tokens, window shell with sidebar skeleton"
```

---

### Task 3: sessions.js — мульти-PTY с адресным IPC (main-процесс)

Менеджер сессий с DI-фабрикой pty (тестируется без Electron), адресные IPC-каналы, диалог выбора папки. Renderer в этой задаче переводится на новый API с одной вкладкой, создаваемой при старте (мульти-вкладочный UI — Task 4).

**Files:**
- Create: `src/main/sessions.js`, `test/sessions.test.js`
- Modify: `src/main/ipc.js` (переписать на sessions), `src/preload/preload.js` (адресное API), `src/renderer/js/app.js` (открытие стартовой вкладки), `src/renderer/js/terminal.js` (адресация tabId)

**Interfaces:**
- Consumes: `createPty(opts)` из `pty.js` (передаётся фабрикой), `getConfig` из `config.js`.
- Produces (контракт для Task 4 и фазы 2):
  - `createSessionManager({ ptyFactory, getTermConfig, onEvent }) → manager`
  - `manager.open({ cwd, command, args, smoke }) → { tabId, cwd, name }` — регистрирует вкладку, pty ещё не спавнится
  - `manager.start(tabId, cols, rows)` / `write(tabId, data)` / `resize(tabId, cols, rows)` / `restart(tabId)` / `close(tabId)` / `list()` / `disposeAll()`
  - `onEvent(channel, payload)`: `'term:started' {tabId, pid}`, `'term:data' {tabId, data}`, `'term:exit' {tabId, exitCode}`
  - preload: `api.tabs.open({cwd}) → {tabId, cwd, name}`, `api.tabs.close(tabId)`, `api.tabs.chooseFolder() → path|null`, `api.term.start(tabId, cols, rows)`, `api.term.write(tabId, data)`, `api.term.resize(tabId, cols, rows)`, `api.term.restart(tabId)`, `api.term.onData(cb({tabId, data}))`, `api.term.onExit(cb({tabId, exitCode}))`, `api.term.onStarted(cb({tabId, pid}))`

- [ ] **Step 1: Написать падающий тест `test/sessions.test.js`**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createSessionManager } = require('../src/main/sessions');

// Фейковая фабрика pty: записывает вызовы, отдаёт управляемый инстанс.
function makeFakePtyFactory() {
  const spawned = [];
  const factory = (opts) => {
    const proc = {
      opts,
      written: [],
      killed: false,
      pid: 1000 + spawned.length,
      write(d) { this.written.push(d); },
      resize(c, r) { this.cols = c; this.rows = r; },
      kill() { this.killed = true; },
    };
    spawned.push(proc);
    return proc;
  };
  factory.spawned = spawned;
  return factory;
}

function makeManager(factory) {
  const events = [];
  const mgr = createSessionManager({
    ptyFactory: factory,
    getTermConfig: () => ({ command: 'claude', args: [], useConpty: true, useConptyDll: true }),
    onEvent: (channel, payload) => events.push({ channel, payload }),
  });
  return { mgr, events };
}

test('open регистрирует вкладку без спавна pty', () => {
  const factory = makeFakePtyFactory();
  const { mgr } = makeManager(factory);
  const tab = mgr.open({ cwd: 'C:\\proj\\alpha' });
  assert.ok(tab.tabId);
  assert.strictEqual(tab.name, 'alpha');
  assert.strictEqual(factory.spawned.length, 0);
});

test('start спавнит pty с cwd вкладки, write/resize маршрутизируются по tabId', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  const b = mgr.open({ cwd: 'C:\\proj\\beta' });
  mgr.start(a.tabId, 80, 24);
  mgr.start(b.tabId, 100, 30);
  assert.strictEqual(factory.spawned.length, 2);
  assert.strictEqual(factory.spawned[0].opts.cwd, 'C:\\proj\\alpha');
  assert.strictEqual(factory.spawned[1].opts.cwd, 'C:\\proj\\beta');

  mgr.write(b.tabId, 'hello');
  assert.deepStrictEqual(factory.spawned[1].written, ['hello']);
  assert.deepStrictEqual(factory.spawned[0].written, []);

  const started = events.filter((e) => e.channel === 'term:started');
  assert.strictEqual(started.length, 2);
  assert.strictEqual(started[0].payload.tabId, a.tabId);
});

test('onData/onExit пробрасываются с tabId; exit не убивает соседнюю вкладку', () => {
  const factory = makeFakePtyFactory();
  const { mgr, events } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  const b = mgr.open({ cwd: 'C:\\proj\\beta' });
  mgr.start(a.tabId, 80, 24);
  mgr.start(b.tabId, 80, 24);

  factory.spawned[0].opts.onData('output-a');
  factory.spawned[1].opts.onExit(0);

  const data = events.find((e) => e.channel === 'term:data');
  assert.deepStrictEqual(data.payload, { tabId: a.tabId, data: 'output-a' });
  const exit = events.find((e) => e.channel === 'term:exit');
  assert.strictEqual(exit.payload.tabId, b.tabId);

  // pty вкладки A жив: write продолжает работать
  mgr.write(a.tabId, 'still-alive');
  assert.ok(factory.spawned[0].written.includes('still-alive'));
});

test('restart убивает старый pty и спавнит новый с теми же размерами', () => {
  const factory = makeFakePtyFactory();
  const { mgr } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  mgr.start(a.tabId, 120, 40);
  mgr.restart(a.tabId);
  assert.strictEqual(factory.spawned.length, 2);
  assert.ok(factory.spawned[0].killed);
  assert.strictEqual(factory.spawned[1].opts.cols, 120);
  assert.strictEqual(factory.spawned[1].opts.rows, 40);
});

test('close убивает pty и удаляет вкладку; disposeAll убивает всё', () => {
  const factory = makeFakePtyFactory();
  const { mgr } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\proj\\alpha' });
  const b = mgr.open({ cwd: 'C:\\proj\\beta' });
  mgr.start(a.tabId, 80, 24);
  mgr.start(b.tabId, 80, 24);
  mgr.close(a.tabId);
  assert.ok(factory.spawned[0].killed);
  assert.strictEqual(mgr.list().length, 1);
  mgr.disposeAll();
  assert.ok(factory.spawned[1].killed);
  assert.strictEqual(mgr.list().length, 0);
});

test('smoke-вкладка спавнит cmd.exe с echo PTY_OK', () => {
  const factory = makeFakePtyFactory();
  const { mgr } = makeManager(factory);
  const a = mgr.open({ cwd: 'C:\\', smoke: true });
  mgr.start(a.tabId, 80, 24);
  assert.strictEqual(factory.spawned[0].opts.command, 'cmd.exe');
  assert.deepStrictEqual(factory.spawned[0].opts.args, ['/c', 'echo PTY_OK']);
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `node --test test/`
Expected: FAIL — `Cannot find module '../src/main/sessions'`.

- [ ] **Step 3: Реализовать `src/main/sessions.js`**

```js
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
        onData: (data) => onEvent('term:data', { tabId: tab.tabId, data }),
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
```

- [ ] **Step 4: Прогнать тесты**

Run: `node --test test/`
Expected: 6 tests PASS.

- [ ] **Step 5: Переписать `src/main/ipc.js` на sessions**

```js
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
```

- [ ] **Step 6: Переписать `src/preload/preload.js`**

```js
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
});
```

- [ ] **Step 7: Адаптировать renderer (`terminal.js` + `app.js`) к адресному API**

В `src/renderer/js/terminal.js`:

1. Сигнатуру сменить на `export function initTerminal(container, config, { tabId, onPtyStatus, onFontSize = () => {} })` — `tabId` обязателен.
2. Все вызовы `window.api.term.*` дополнить первым аргументом `tabId`: `window.api.term.resize(tabId, term.cols, term.rows)` (2 места: setFontSize и ResizeObserver), `window.api.term.restart(tabId)` (Ctrl+Shift+R), `window.api.term.start(tabId, term.cols, term.rows)`, `term.onData((data) => { if (alive) window.api.term.write(tabId, data); })`.
3. Подписки `window.api.term.onData/onStarted/onExit` УДАЛИТЬ из terminal.js — события теперь маршрутизирует app.js (один глобальный слушатель на канал, диспатч по tabId). Вместо них initTerminal возвращает обработчики:

```js
  // Приём маршрутизированных событий (диспатч по tabId делает app.js).
  const handlers = {
    onData: (data) => term.write(data),
    onStarted: ({ pid }) => {
      alive = true;
      onPtyStatus(`работает · pid ${pid}`);
    },
    onExit: ({ exitCode }) => {
      alive = false;
      onPtyStatus(`процесс завершён (код ${exitCode})`);
      term.write(`\r\n\x1b[31m[процесс завершён (код ${exitCode}) — Ctrl+Shift+R для перезапуска]\x1b[0m\r\n`);
    },
  };
  term.focus();
  return { term, search, setFontSize, focus: () => term.focus(), openSearch, handlers };
```

В `src/renderer/js/app.js` (полное новое содержимое):

```js
'use strict';
// Бутстрап renderer: одна стартовая вкладка через адресное API.
// Мульти-вкладочный UI — задача 4.

import { initTerminal } from './terminal.js';

const $ = (id) => document.getElementById(id);
const views = new Map(); // tabId → view из initTerminal

async function boot() {
  const config = await window.api.config.get();
  const statusPty = $('status-pty');
  const statusFont = $('status-font');

  // Глобальный диспатч событий терминалов по tabId.
  window.api.term.onData(({ tabId, data }) => views.get(tabId)?.handlers.onData(data));
  window.api.term.onStarted((p) => views.get(p.tabId)?.handlers.onStarted(p));
  window.api.term.onExit((p) => views.get(p.tabId)?.handlers.onExit(p));

  // Стартовая вкладка: cwd из конфига (пустой → домашняя папка подставится в main).
  const cwd = config.terminal.cwd || '.';
  const tab = await window.api.tabs.open({ cwd });
  if (!tab) return;

  const view = initTerminal($('terminal'), config, {
    tabId: tab.tabId,
    onPtyStatus: (s) => { statusPty.textContent = `⌨ ${s}`; },
    onFontSize: (px) => { statusFont.textContent = `A ${px}`; },
  });
  views.set(tab.tabId, view);
  statusFont.textContent = `A ${config.terminal.fontSize}`;

  window.api.app.onNotice(({ text }) => console.warn(`[notice] ${text}`));
}

boot();
```

Примечание: в `initTerminal` вызов `window.api.term.start(tabId, ...)` остаётся на своём месте (после `fit.fit()`), как в текущем коде.

- [ ] **Step 8: Проверка**

Run: `node --test test/` → PASS; `npm run smoke` → exit 0 (renderer открывает вкладку, sessions спавнит cmd echo PTY_OK, вывод дошёл через smokeOutput).

- [ ] **Step 9: Commit**

```powershell
git add -A
git commit -m "feat: session manager with tabId-addressed IPC, DI-tested"
```

---

### Task 4: Пул терминалов + вкладки в сайдбаре (renderer)

Полноценные вкладки: «+ Проект» открывает диалог папки и новую сессию, ряды в сайдбаре переключают видимый терминал, close-кнопка, хоткеи Ctrl+1..9 / Ctrl+Tab. Статус-точки пока два состояния: alive (working-цвет) / dead (error-цвет) — настоящая машина статусов приедет с хуками в фазе 2.

**Files:**
- Create: `src/renderer/js/tabs.js`
- Modify: `src/renderer/js/app.js` (переписать), `src/renderer/index.html` (убрать статичный `#terminal`)

**Interfaces:**
- Consumes: preload API из Task 3; `initTerminal(container, config, {tabId, onPtyStatus, onFontSize})` и `view.handlers` из Task 3; CSS-классы `.tab-row`, `.tab-dot`, `.tab-name`, `.tab-sub`, `.tab-close`, `.term-view` из Task 2.
- Produces (для фазы 2): `createTabStore({ container, onActivate, onClose }) → store`; `store.add({tabId, name, cwd})`, `store.remove(tabId)`, `store.setActive(tabId)`, `store.setStatus(tabId, status, subtitle)` (status: `'working'|'waiting'|'done'|'error'|'idle'`), `store.order() → [tabId]`, `store.activeId`.

- [ ] **Step 1: Убрать статичный терминал из `index.html`** — внутри `#terminal-host` удалить `<div id="terminal" class="term-view"></div>` (контейнеры создаёт tabs-модуль динамически).

- [ ] **Step 2: Создать `src/renderer/js/tabs.js`**

```js
'use strict';
// Стор вкладок + рендер рядов сайдбара. Чистый DOM, без фреймворков.
// Статусы: working / waiting / done / error / idle (фаза 1 использует
// working и error; остальные готовы для машины статусов фазы 2).

export function createTabStore({ container, onActivate, onClose }) {
  const rows = new Map(); // tabId → {row, dot, sub, name, cwd, status}
  const order = [];       // порядок вкладок для Ctrl+1..9
  let activeId = null;

  function add({ tabId, name, cwd }) {
    const row = document.createElement('div');
    row.className = 'tab-row';

    const dot = document.createElement('span');
    dot.className = 'tab-dot working';

    const info = document.createElement('div');
    info.className = 'tab-info';

    const nameEl = document.createElement('div');
    nameEl.className = 'tab-name';
    nameEl.textContent = name;

    const sub = document.createElement('div');
    sub.className = 'tab-sub';
    sub.textContent = cwd;
    sub.title = cwd;

    info.append(nameEl, sub);

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.textContent = '✕';
    close.title = 'Закрыть вкладку';
    close.addEventListener('click', (ev) => {
      ev.stopPropagation();
      onClose(tabId);
    });

    row.append(dot, info, close);
    row.addEventListener('click', () => onActivate(tabId));
    container.appendChild(row);

    rows.set(tabId, { row, dot, sub, name, cwd, status: 'working' });
    order.push(tabId);
  }

  function remove(tabId) {
    const r = rows.get(tabId);
    if (!r) return;
    r.row.remove();
    rows.delete(tabId);
    const i = order.indexOf(tabId);
    if (i !== -1) order.splice(i, 1);
    if (activeId === tabId) activeId = null;
  }

  function setActive(tabId) {
    for (const [id, r] of rows) r.row.classList.toggle('active', id === tabId);
    activeId = tabId;
  }

  function setStatus(tabId, status, subtitle) {
    const r = rows.get(tabId);
    if (!r) return;
    r.status = status;
    r.dot.className = `tab-dot ${status === 'idle' ? '' : status}`.trim();
    r.row.classList.toggle('waiting', status === 'waiting');
    if (typeof subtitle === 'string') {
      r.sub.textContent = subtitle;
      r.sub.title = subtitle;
    }
  }

  return {
    add,
    remove,
    setActive,
    setStatus,
    order: () => [...order],
    get activeId() { return activeId; },
  };
}
```

- [ ] **Step 3: Переписать `src/renderer/js/app.js` на мульти-вкладки**

```js
'use strict';
// Оркестрация renderer: вкладки ↔ пул терминалов ↔ адресный IPC.

import { initTerminal } from './terminal.js';
import { createTabStore } from './tabs.js';

const $ = (id) => document.getElementById(id);

const views = new Map(); // tabId → {view, container}
let config = null;
let tabStore = null;

const statusPty = () => $('status-pty');
const statusFont = () => $('status-font');

// Создать вкладку: контейнер + xterm + запись в стор. activate — переключиться сразу.
async function openTab(cwd, { activate = true } = {}) {
  const tab = await window.api.tabs.open({ cwd });
  if (!tab) return null;

  const container = document.createElement('div');
  container.className = 'term-view hidden';
  $('terminal-host').appendChild(container);

  const view = initTerminal(container, config, {
    tabId: tab.tabId,
    onPtyStatus: (s) => {
      if (tabStore.activeId === tab.tabId) statusPty().textContent = `⌨ ${s}`;
    },
    onFontSize: (px) => { statusFont().textContent = `A ${px}`; },
  });

  views.set(tab.tabId, { view, container });
  tabStore.add(tab);
  if (activate) activateTab(tab.tabId);
  return tab;
}

function activateTab(tabId) {
  const entry = views.get(tabId);
  if (!entry) return;
  for (const [id, v] of views) v.container.classList.toggle('hidden', id !== tabId);
  tabStore.setActive(tabId);
  // fit после показа: скрытый контейнер имеет нулевые размеры.
  requestAnimationFrame(() => {
    entry.view.term.focus();
    window.dispatchEvent(new Event('resize'));
  });
}

async function closeTab(tabId) {
  const entry = views.get(tabId);
  if (!entry) return;
  await window.api.tabs.close(tabId);
  entry.view.term.dispose();
  entry.container.remove();
  views.delete(tabId);
  tabStore.remove(tabId);
  // Переключаемся на соседнюю вкладку, если закрыли активную.
  const rest = tabStore.order();
  if (rest.length) activateTab(rest[rest.length - 1]);
  else statusPty().textContent = '⌨ нет вкладок';
}

function bindHotkeys() {
  window.addEventListener('keydown', (ev) => {
    // Ctrl+1..9 — вкладка по индексу.
    if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && ev.key >= '1' && ev.key <= '9') {
      const idx = Number(ev.key) - 1;
      const ids = tabStore.order();
      if (ids[idx]) {
        ev.preventDefault();
        activateTab(ids[idx]);
      }
      return;
    }
    // Ctrl+Tab / Ctrl+Shift+Tab — циклическое переключение.
    if (ev.ctrlKey && ev.key === 'Tab') {
      ev.preventDefault();
      const ids = tabStore.order();
      if (!ids.length) return;
      const cur = ids.indexOf(tabStore.activeId);
      const next = ev.shiftKey
        ? (cur - 1 + ids.length) % ids.length
        : (cur + 1) % ids.length;
      activateTab(ids[next]);
    }
  }, { capture: true });
}

async function boot() {
  config = await window.api.config.get();

  tabStore = createTabStore({
    container: $('tab-list'),
    onActivate: activateTab,
    onClose: closeTab,
  });

  // Глобальный диспатч событий терминалов по tabId.
  window.api.term.onData(({ tabId, data }) => views.get(tabId)?.view.handlers.onData(data));
  window.api.term.onStarted((p) => {
    views.get(p.tabId)?.view.handlers.onStarted(p);
    tabStore.setStatus(p.tabId, 'working');
  });
  window.api.term.onExit((p) => {
    views.get(p.tabId)?.view.handlers.onExit(p);
    tabStore.setStatus(p.tabId, 'error', `процесс завершён (код ${p.exitCode})`);
  });

  $('btn-new-tab').addEventListener('click', async () => {
    const folder = await window.api.tabs.chooseFolder();
    if (folder) openTab(folder);
  });

  bindHotkeys();

  // Стартовая вкладка: cwd из конфига.
  await openTab(config.terminal.cwd || '.');

  statusFont().textContent = `A ${config.terminal.fontSize}`;
  window.api.app.onNotice(({ text }) => console.warn(`[notice] ${text}`));
}

boot();
```

- [ ] **Step 4: Проверка юнитов и smoke**

Run: `node --test test/` → PASS. `npm run smoke` → exit 0.

- [ ] **Step 5: Ручная приёмка Phase 1**

Run: `npm start`. Проверить: (1) стартовая вкладка открылась с claude в cwd из конфига; (2) «+ Проект» → выбрать `C:\Users\Lunev\helper` → вторая вкладка с claude; (3) переключение кликом и Ctrl+1/Ctrl+2/Ctrl+Tab, ввод идёт в правильный терминал; (4) ✕ закрывает вкладку, соседняя активируется; (5) exit в терминале красит точку в error-цвет; (6) Ctrl+Shift+R в этой вкладке перезапускает claude; (7) ресайз окна подгоняет активный терминал.

- [ ] **Step 6: Commit**

```powershell
git add -A
git commit -m "feat: terminal pool with sidebar tabs, hotkeys, per-tab lifecycle"
```

---

## Self-Review (выполнен)

1. **Spec coverage (фаза 1 из §9):** «удалить голос/аватар» — Task 1; «IPC с tabId» — Task 3; «пул терминалов» — Task 3-4; «сайдбар-скелет» — Task 2 + 4; «tokens.css» — Task 2. Ghost buffers, манифест, хуки, статусы waiting/done — фаза 2 (следующий план), не дыра.
2. **Placeholder scan:** чисто — весь код полный, «аналогично N» нет.
3. **Type consistency:** `createSessionManager` API совпадает между Task 3 реализацией, тестами и ipc.js; `initTerminal` возвращает `handlers` — используется в app.js Task 3 и Task 4; `createTabStore.setStatus` сигнатура совпадает с вызовами в app.js; каналы `term:*`/`tabs:*` согласованы preload ↔ ipc.
4. Известный компромисс: в Task 4 ресайз скрытых вкладок не доставляется до их активации (fit дёргается на показе через synthetic resize) — приемлемо для фазы 1; WebGL-свап на активную вкладку отложен, т.к. дефолт `webgl:false` (артефакты ConPTY важнее скорости).
