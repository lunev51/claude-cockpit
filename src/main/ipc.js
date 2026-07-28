'use strict';
// Все IPC-каналы. PTY-парк живёт в sessions.js; ipc — тонкий адаптер.

const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const { execFile } = require('child_process');
const { ipcMain, shell, dialog, app, clipboard } = require('electron');
const { getConfig, setConfig } = require('./config');
const { createPty } = require('./pty');
const { createSessionManager } = require('./sessions');
const { createHookBridge } = require('./hook-bridge');
const { connectProject, isConnected } = require('./connector');
const { createWorkspaceStore } = require('./workspace');
const { createWorkspaceSync } = require('./workspace-sync');
const { saveClipboardImage } = require('./screenshot');
const { appRoot } = require('./paths');
const { createUsagePoller } = require('./usage-oauth');
const { createCcusage } = require('./usage-ccusage');

let manager = null;
let smokeOutput = '';
let bridge = null;       // текущий инстанс моста (может пересоздаваться при fallback на эфемерный порт)
let stuckTimer = null;
let store = null;        // стор манифеста воркспейса (workspace.js)
let wsync = null;        // гейт синхронизации манифеста (workspace-sync.js) — FIX 1/2 ревью
let activeTabId = null;  // последний tabId, о котором сообщил renderer через workspace:setActive
let usagePoller = null;  // поллер официальных лимитов (usage-oauth.js) — слой A
let ccusage = null;      // слой расходов ccusage (usage-ccusage.js) — слой B
let usageMonitorTimer = null; // лёгкий сторож (только snapshot(), без сети) — рассылает usage:update
let lastBroadcastFetchedAt = 0; // fetchedAt последнего разосланного usage:update — детектор «случился успешный refresh»
let lastCcusageResult = null;   // последний известный ответ ccusage.get() — уходит и в usage:get/usage:refresh, и в usage:update

function getSmokeOutput() {
  return smokeOutput;
}

// Task 2 фазы 4: активная вкладка (по мнению renderer, workspace:setActive) —
// toasts.js получает этот геттер как getActiveTabId() при создании тостера в
// main.js. Замыкание, а не снимок значения: main.js создаёт тостер один раз
// на старте, а activeTabId дальше живёт и меняется здесь же, в ipc.js.
function getActiveTabId() {
  return activeTabId;
}

// Путь к файлу с фактическим портом моста (читает scripts/cockpit-hook.js).
function bridgePortFile() {
  return path.join(app.getPath('userData'), 'bridge-port');
}

// Путь к ghost-файлу вкладки (Task 5) — снимок скроллбека для мгновенного
// восстановления «вчерашнего вывода» до подъёма живого pty.
function ghostDir() {
  return path.join(app.getPath('userData'), 'ghosts');
}

function ghostFile(ghostId) {
  return path.join(ghostDir(), `${ghostId}.txt`);
}

const GHOST_MAX_BYTES = 512 * 1024;

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

// --- Проводка слоёв usage (Task 3 фазы 5): usage-oauth.js/usage-ccusage.js —
// готовые ЧИСТЫЕ модули (readToken/httpGet/cache/run — только инжектируемые
// зависимости), здесь только реальные реализации этих зависимостей.

function usageOauthCacheFile() {
  return path.join(app.getPath('userData'), 'usage-oauth.json');
}

function usageCcusageCacheFile() {
  return path.join(app.getPath('userData'), 'usage-ccusage.json');
}

// JSON-файл кэша: read/write в try/catch (битый/отсутствующий файл → null,
// ошибка записи — не критична, просто предупреждение). Оба слоя используют
// эту же фабрику, каждый со своим путём.
function createJsonFileCache(file) {
  return {
    read() {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        return null; // нет файла или битый — трактуем как «нет кэша», не бросаем
      }
    },
    write(obj) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(obj), 'utf8');
      } catch (err) {
        console.warn(`[usage] не удалось записать кэш ${path.basename(file)}: ${err.message}`);
      }
    },
  };
}

// Токен НИКУДА, кроме заголовка запроса, не уходит — не логируется даже здесь.
function readOauthToken() {
  try {
    const file = path.join(os.homedir(), '.claude', '.credentials.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const oauth = data && data.claudeAiOauth;
    if (!oauth || typeof oauth.accessToken !== 'string' || !oauth.accessToken) return null;
    return { accessToken: oauth.accessToken, expiresAt: oauth.expiresAt || null };
  } catch {
    return null; // файла нет / битый JSON / нет полей — трактуем как «не залогинен»
  }
}

// httpGet(url, headers) → {status, body}; НЕ бросает на не-200 (usage-oauth.js
// сам разбирает 401/403/429 по status) — бросает (reject) только на реальный
// сетевой сбой/таймаут, ЭТО ловит usage-oauth.js как error:'network'.
// Таймаут 20с (бриф) — и на весь запрос (req.on('timeout')), и как safety-net
// на уровне https.get options.
function usageHttpGet(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: 20000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => {
      req.destroy(new Error('usage httpGet: таймаут 20с'));
    });
    req.on('error', reject);
  });
}

// run(args) для ccusage: execFile('npx', ...) БЕЗ shell:true падает на Windows
// с ENOENT (npx — это .cmd-шим, не бинарник); execFile('npx.cmd', ...) БЕЗ
// shell:true падает с ENOENT/EINVAL — известная особенность обработки .cmd в
// child_process на Windows (проверено фактически на этой машине: npx.cmd без
// shell → 'spawn EINVAL'). Рабочий вариант — execFile('npx', args, {shell:true})
// (проверено: реальный вызов `ccusage claude daily --json` вернулся за ~1.5с
// с валидным JSON). args — фиксированные литералы вида ['claude','daily','--json'],
// без пользовательского ввода — риск инъекции через DEP0190 (аргументы не
// экранируются под shell:true) отсутствует.
function runCcusage(args) {
  return new Promise((resolve) => {
    execFile('npx', ['--yes', 'ccusage@latest', ...args], {
      timeout: 60000,
      windowsHide: true,
      shell: true,
      maxBuffer: 16 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code || 1) : 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

function registerIpc(win, opts = {}) {
  const { smoke = false, attention = null, toaster = null } = opts;

  // Слои usage (Task 3 фазы 5): инстансы создаются ВСЕГДА (конструктор — это
  // просто замыкания над зависимостями, никакого I/O до первого refresh()/get()),
  // а вот сама автономная жизнь поллера (start()) — ТОЛЬКО не в smoke, ниже.
  usagePoller = createUsagePoller({
    readToken: readOauthToken,
    httpGet: usageHttpGet,
    cache: createJsonFileCache(usageOauthCacheFile()),
    log: (msg) => console.warn(msg),
  });
  ccusage = createCcusage({
    run: runCcusage,
    cache: createJsonFileCache(usageCcusageCacheFile()),
  });
  lastBroadcastFetchedAt = 0;
  lastCcusageResult = null;

  // Стор манифеста создаётся один раз на регистрацию — независимо от smoke,
  // чтобы workspace:get всегда мог отдать хоть что-то (в smoke он просто
  // никогда не пишется, см. wsync ниже).
  store = createWorkspaceStore({ file: path.join(app.getPath('userData'), 'workspace.json') });
  // wsync — гейт поверх store (workspace-sync.js): sync() инертен, пока
  // renderer не отрапортует workspace:ready (FIX 2, восстановление ещё не
  // завершено), и НАВСЕГДА инертен после markQuitting() (FIX 1, критический
  // баг ревью — см. подробный разбор в workspace-sync.js). listTabs — ленивая
  // ссылка на manager, который будет присвоен чуть ниже в этой же функции.
  wsync = createWorkspaceSync({ store, listTabs: () => manager.list(), smoke });

  // Разовая уборка ghost-файлов-сирот (Task 5, ревью finding 1b). До фикса
  // finding 1a восстановление минтило новый ghostId на каждый запуск —
  // старый файл предыдущей жизни вкладки становился недостижим навсегда
  // (никто его больше не читает/не перезаписывает/не удаляет). Теперь
  // ghostId стабилен через restore, но старые сироты от прошлых запусков
  // до фикса всё ещё могут лежать на диске — сверяем userData/ghosts/ с
  // текущим манифестом и удаляем всё лишнее. smoke — не трогаем userData.
  if (!smoke) {
    try {
      // Task 6, защита от потери данных: если манифест не читается вообще
      // (битый workspace.json И битый .bak — store.load() вернул null), мы
      // НЕ знаем, какие ghost-файлы сироты, а какие — актуальные вкладки
      // вчерашней сессии. Раньше `store.load()?.tabs || []` в этом случае
      // давал known = пустой Set, и уборка сносила АБСОЛЮТНО ВСЕ ghost-файлы
      // как «сирот» — то есть терялся весь вчерашний контекст всех вкладок
      // из-за одной повреждённой пары файлов манифеста. Пропускаем уборку
      // целиком, пока манифест не прочитается успешно.
      const manifest = store.load();
      if (manifest) {
        const dir = ghostDir();
        const known = new Set((manifest.tabs || []).map((t) => t.ghostId).filter(Boolean));
        if (fs.existsSync(dir)) {
          for (const file of fs.readdirSync(dir)) {
            if (!file.endsWith('.txt')) continue;
            const id = file.slice(0, -'.txt'.length);
            if (!known.has(id)) {
              try { fs.unlinkSync(path.join(dir, file)); } catch { /* не критично */ }
            }
          }
        }
      }
    } catch (err) {
      console.warn(`[ghost] уборка файлов-сирот не удалась: ${err.message}`);
    }
  }

  // Пересобирает манифест из живого состояния manager'а — тонкая обёртка над
  // wsync.sync(), которая сама решает, писать ли вообще (smoke/не-ready/quitting,
  // см. workspace-sync.js). activeTabId — последний tabId, о котором сообщил
  // renderer через workspace:setActive; не найден/ещё не сообщён → 0.
  function syncWorkspace() {
    wsync.sync(activeTabId);
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
      // Task 2 фазы 4: тот же поток, что шлёт tab:status в renderer, — тостер
      // (toasts.js, чистый модуль) сам решает, показывать ли уведомление
      // Windows, по правилу «не уведомлять о том, на что смотришь». Имя
      // вкладки берём из manager.list() — payload статуса его не несёт.
      // smoke: headless-прогон никогда не должен показывать тосты.
      if (!smoke && channel === 'tab:status' && toaster) {
        const tab = manager.list().find((t) => t.tabId === payload.tabId);
        toaster.onStatus({
          tabId: payload.tabId,
          tabName: tab ? tab.name : payload.tabId,
          status: payload.status,
          waitingText: payload.waitingText,
        });
      }
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

  // Task 3 фазы 5 (кольца лимитов): поллер официальных лимитов стартует ТОЛЬКО
  // не в smoke — headless-прогон не должен трогать сеть. usagePoller.start()
  // сам вызывает немедленный refresh() и дальше живёт по своему расписанию
  // (с бэкоффом при 401/403/429, см. usage-oauth.js) — этот цикл ЕДИНСТВЕННЫЙ
  // источник реальных сетевых обращений к слою A.
  //
  // usage-oauth.js не даёт колбэка «после refresh» (контракт модуля — только
  // start/stop/snapshot/refresh, переписывать не в объёме этой задачи) — вместо
  // повторного собственного планировщика (который задвоил бы сетевые вызовы
  // параллельно с внутренним таймером поллера) здесь лёгкий сторож: раз в 5с
  // читает ТОЛЬКО snapshot() (синхронно, без сети) и сравнивает fetchedAt с
  // последним разосланным — смена fetchedAt означает, что где-то между
  // проверками случился успешный refresh (живьём или восстановлением из кэша),
  // и тогда шлём usage:update. Гранулярность обнаружения — до 5с, сети это не
  // стоит ничего (snapshot() — синхронное чтение из памяти).
  if (!smoke) {
    usagePoller.start();
    usageMonitorTimer = setInterval(() => {
      const snap = usagePoller.snapshot();
      if (snap.fetchedAt !== lastBroadcastFetchedAt) {
        lastBroadcastFetchedAt = snap.fetchedAt;
        if (!win.isDestroyed()) {
          win.webContents.send('usage:update', { limits: snap, spend: lastCcusageResult });
        }
      }
    }, 5000);
    usageMonitorTimer.unref?.();
  }

  ipcMain.handle('config:get', () => getConfig());

  ipcMain.handle('config:set', (_e, partial) => {
    if (!partial || typeof partial !== 'object' || Array.isArray(partial)) {
      throw new TypeError('config:set ожидает plain-object');
    }
    return setConfig(partial);
  });

  // Task 3 фазы 5 (кольца лимитов): usagePoller.snapshot() — синхронный, без
  // сети. ccusage.get() — лениво: первый usage:get и есть тот самый «первый
  // запуск», дальше TTL-кэш внутри usage-ccusage.js сам не даёт бить по npx
  // чаще ttlMs (проводить свой отдельный троттлинг здесь не нужно — это уже
  // сделано в модуле). smoke: НИ сети, НИ npx — spend всегда null, ccusage.get()
  // не зовётся вовсе.
  ipcMain.handle('usage:get', async () => {
    const limits = usagePoller.snapshot();
    if (smoke) return { limits, spend: null };
    lastCcusageResult = await ccusage.get({ force: false });
    return { limits, spend: lastCcusageResult };
  });

  // Принудительное обновление ОБОИХ слоёв (кнопка/клик по кольцам, дашборд
  // Task 4). smoke — тот же гейт, что и usage:get.
  ipcMain.handle('usage:refresh', async () => {
    if (smoke) return { limits: usagePoller.snapshot(), spend: null };
    const [, spend] = await Promise.all([usagePoller.refresh(), ccusage.get({ force: true })]);
    lastCcusageResult = spend;
    return { limits: usagePoller.snapshot(), spend };
  });

  ipcMain.handle('shell:openExternal', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  // Task 4 фазы 4 (палитра команд): «Открыть DevTools» — то же самое, что
  // делает F12 (см. main.js/before-input-event), просто доступное и из палитры.
  ipcMain.handle('app:devtools', () => {
    if (!win.isDestroyed()) win.webContents.toggleDevTools();
  });

  // Task 1 фазы 4: renderer шлёт агрегат «сколько вкладок ждут» + готовую
  // PNG-иконку бейджа (канвас рисует badge.js, main про canvas не знает).
  // attention — чистый модуль (attention.js), инстанс создаётся в main.js
  // (там же живут nativeImage и win.setOverlayIcon) и прокидывается сюда
  // через opts — ipc.js только маршрутизирует IPC-пейлоад.
  ipcMain.on('attention:update', (_e, payload) => {
    if (!attention || !payload || typeof payload !== 'object') return;
    const { count, dataUrl } = payload;
    // Fix (ревью): typeof count !== 'number' пропускал NaN (typeof NaN ===
    // 'number') — NaN ломает дедупликацию в attention.js (NaN !== NaN всегда
    // true, обновление никогда не гасится) и даёт заголовок окна вида
    // «Cockpit — NaN ждут». count — количество вкладок, только целое ≥ 0.
    if (!Number.isInteger(count) || count < 0) return;
    attention.update({ count, dataUrl: typeof dataUrl === 'string' ? dataUrl : null });
  });

  // Регистрация вкладки. cwd обязателен — renderer берёт его из диалога
  // или из конфига; smoke-режим подменяет команду в sessions.js.
  // command/args — прозрачный проброс: явный оверрайд конкретного спавна
  // (используется, например, Ctrl+Shift+R-подобными сценариями расширений).
  // Восстановление воркспейса (FIX 3, ревью) command/args больше НЕ шлёт —
  // вместо этого передаёт sessionId, а sessions.js сам решает, как резюмить,
  // не теряя при этом конфигурационные args (--model и т.п.) и не игнорируя
  // config.terminal.command. Тайпчек здесь, а не в sessions.js — renderer
  // недоверенный источник IPC-пейлоада.
  // ghostId (Task 5, ревью finding 1a) — восстановление передаёт исходный id
  // вкладки из манифеста, чтобы не заводить новый ghost-файл при каждом
  // restore и не осиротить старый.
  ipcMain.handle('tabs:open', (_e, {
    cwd, command, args, ghostId, sessionId,
  } = {}) => {
    if (typeof cwd !== 'string' || !cwd) return null;
    const cmd = typeof command === 'string' ? command : undefined;
    const a = Array.isArray(args) && args.every((x) => typeof x === 'string') ? args : undefined;
    const gid = typeof ghostId === 'string' && ghostId ? ghostId : undefined;
    const sid = typeof sessionId === 'string' && sessionId ? sessionId : undefined;
    return manager.open({
      cwd, smoke, command: cmd, args: a, ghostId: gid, sessionId: sid,
    });
  });

  ipcMain.handle('tabs:close', (_e, tabId) => {
    if (typeof tabId !== 'string') return;
    // Резолвим ghostId ДО manager.close (Task 5) — close() удаляет вкладку
    // из менеджера, и list() её больше не найдёт; отдельного ghost:delete
    // IPC не заводим — подчистка ghost-файла естественно живёт здесь же,
    // рядом с самим закрытием вкладки.
    const tab = manager.list().find((t) => t.tabId === tabId);
    manager.close(tabId);
    if (!smoke && tab && tab.ghostId) {
      try {
        fs.unlinkSync(ghostFile(tab.ghostId));
      } catch { /* файла могло не быть — не страшно */ }
    }
  });

  // Ghost-буферы (Task 5): снимок скроллбека вкладки на диск, чтобы при
  // восстановлении показать «вчерашний вывод» мгновенно, пока живой pty ещё
  // поднимается. Best-effort — ошибка записи не должна ронять приложение.
  // smoke: no-op — headless-прогон не должен трогать userData.
  ipcMain.handle('ghost:save', (_e, payload) => {
    if (smoke) return;
    if (!payload || typeof payload !== 'object') return;
    const { tabId, text } = payload;
    if (typeof tabId !== 'string' || typeof text !== 'string') return;
    const tab = manager.list().find((t) => t.tabId === tabId);
    if (!tab || !tab.ghostId) return;
    try {
      fs.mkdirSync(ghostDir(), { recursive: true });
      // Ограничиваем размер: длинный скроллбек режем с конца — хвост
      // (последний вывод) ценнее шапки. FIX 7 (ревью): режем не строго по
      // байту точки среза, а по ближайшему '\n' ПОСЛЕ неё — иначе prelude
      // может начаться с середины многобайтового UTF-8 символа или с обрывка
      // escape-последовательности (терминал получит мусорные байты первой
      // же строкой). Если после точки среза переноса строки не нашлось —
      // строка длиннее лимита сама по себе, режем по байту как раньше.
      let out = text;
      if (Buffer.byteLength(out, 'utf8') > GHOST_MAX_BYTES) {
        const buf = Buffer.from(out, 'utf8');
        const cut = buf.length - GHOST_MAX_BYTES;
        const nl = buf.indexOf(0x0A, cut); // '\n' — единственный байт даже внутри UTF-8
        out = buf.subarray(nl === -1 ? cut : nl + 1).toString('utf8');
      }
      fs.writeFileSync(ghostFile(tab.ghostId), out, 'utf8');
    } catch (err) {
      console.warn(`[ghost] не удалось сохранить буфер вкладки ${tabId}: ${err.message}`);
    }
  });

  ipcMain.handle('ghost:load', (_e, ghostId) => {
    // smoke-гейт для консистентности с ghost:save (ревью, finding 2) —
    // headless-прогон не должен трогать userData.
    if (smoke) return null;
    if (typeof ghostId !== 'string' || !ghostId) return null;
    try {
      return fs.readFileSync(ghostFile(ghostId), 'utf8');
    } catch {
      return null;
    }
  });

  // Живой манифест воркспейса (Task 3): renderer читает его на старте (Task 4)
  // и репортит активную вкладку при каждом переключении.
  // smoke-изоляция: headless-прогон не должен видеть оверлей restore — иначе
  // он завис бы до таймаута (никто не жмёт Enter/Esc в smoke).
  ipcMain.handle('workspace:get', () => (smoke ? null : store.load()));

  ipcMain.on('workspace:setActive', (_e, p) => {
    if (p && typeof p.tabId === 'string') {
      activeTabId = p.tabId;
      syncWorkspace();
    }
  });

  // FIX 2 (ревью 2b): renderer шлёт это, когда восстановление воркспейса на
  // старте полностью завершено (либо решено начать пусто) — до этого момента
  // wsync.sync() молчит, так что промежуточные (неполные) составы вкладок
  // из стаггера restoreFlow никогда не попадают в манифест. См. app.js —
  // места вызова window.api.workspace.ready().
  //
  // FIX 1 (carryover 3) + ARCHITECTURE Fix 13 (ревью): markReady() зовём
  // ВСЕГДА, а немедленный sync() — ТОЛЬКО если в manager уже есть хоть одна
  // вкладка. Раньше eager-sync звался безусловно: на ветках отказа («начать
  // пусто» / Esc / пустой выбор чекбоксов) в этот момент manager.list() пуст,
  // и sync писал в workspace.json валидно-пустой манифест — .bak переставал
  // быть нужен для восстановления, а следующий запуск считал known-набор
  // ghost-вкладок пустым и сметал уборкой сирот ВСЕ ghost-файлы. Комментарий
  // в app.js (startEmpty) обещает «манифест НЕ трогаем» — теперь это
  // действительно так: manager.list().length === 0 → sync не зовём, старый
  // workspace.json (вчерашний состав) остаётся на диске нетронутым до первого
  // РЕАЛЬНОГО изменения состава вкладок (открытия/закрытия), которое само
  // придёт через tabs:changed → syncWorkspace().
  //
  // Сама логика (markReady + условный sync) вынесена в wsync.readyAndSync —
  // это чистый (без Electron) код workspace-sync.js, покрытый test/workspace-sync.test.js;
  // ipc.js больше не содержит непокрытой тестами ветки этого хотфикса.
  ipcMain.on('workspace:ready', () => {
    wsync.readyAndSync(activeTabId);
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

  // Task 4 фазы 4 (вставка скриншотов): cwd вкладки резолвим тем же путём,
  // что project:connect/status — tabCwd (manager.list()). saveClipboardImage —
  // чистый модуль (screenshot.js), clipboard.readImage() инжектируется отсюда.
  // Любая ошибка (в т.ч. пустой буфер, недоступный clipboard) → null — renderer
  // (terminal.js) сам падает на обычную текстовую вставку в этом случае.
  ipcMain.handle('screenshot:paste', (_e, tabId) => {
    if (typeof tabId !== 'string') return null;
    const cwd = tabCwd(tabId);
    if (!cwd) return null;
    try {
      return saveClipboardImage({ readImage: () => clipboard.readImage(), dir: cwd, now: Date.now() });
    } catch (err) {
      console.warn(`[screenshot] не удалось сохранить скриншот: ${err.message}`);
      return null;
    }
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
// не успеть до выхода процесса) и НАВСЕГДА глушит дальнейшую синхронизацию —
// FIX 1 (КРИТИЧЕСКИЙ, ревью). main.js зовёт flushWorkspace() дважды за один
// выход (window-all-closed, потом before-quit), а между этими двумя вызовами
// disposeSessions() закрывает все вкладки одну за другой — каждое закрытие
// шлёт tabs:changed, который раньше писал в pending уже опустевший список.
// Порядок здесь важен: сначала flush() коммитит на диск последнее ХОРОШЕЕ
// состояние (то, что успел собрать sync() до этого момента), и ТОЛЬКО ПОТОМ
// markQuitting() отрезает любые дальнейшие sync() — так закрытие вкладок
// внутри disposeSessions(), которое происходит СРАЗУ вслед за этим вызовом,
// уже не может затереть pending пустым списком к моменту второго flush().
function flushWorkspace() {
  if (!wsync) return;
  wsync.flush();
  wsync.markQuitting();
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
  // Task 3 фазы 5: гасим сторож usage:update и сам поллер лимитов — симметрично
  // usagePoller.start() в registerIpc (в smoke оба всё равно no-op: сторож не
  // создавался, start() не звался, а stop() на незапущенном поллере безопасен).
  if (usageMonitorTimer) {
    clearInterval(usageMonitorTimer);
    usageMonitorTimer = null;
  }
  if (usagePoller) usagePoller.stop();
  stopBridge();
  if (manager) manager.disposeAll();
}

module.exports = {
  registerIpc, disposeSessions, stopBridge, getSmokeOutput, flushWorkspace, getActiveTabId,
};
