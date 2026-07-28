'use strict';
// Все IPC-каналы. PTY-парк живёт в sessions.js; ipc — тонкий адаптер.

const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const readline = require('readline');
const { execFile } = require('child_process');
const {
  ipcMain, shell, dialog, app, clipboard, powerSaveBlocker,
} = require('electron');
const { getConfig, setConfig } = require('./config');
const { createPty } = require('./pty');
const { createSessionManager } = require('./sessions');
const { createHookBridge } = require('./hook-bridge');
const { connectProject, isConnected } = require('./connector');
const { notify } = require('./notify');
const { createNightWatch } = require('./night-watch');
const { createNightJournal } = require('./night-journal');
const { createWorkspaceStore } = require('./workspace');
const { createWorkspaceSync } = require('./workspace-sync');
const { saveClipboardImage } = require('./screenshot');
const { appRoot } = require('./paths');
const { createUsagePoller } = require('./usage-oauth');
const { createCcusage } = require('./usage-ccusage');
const { createGitInfo } = require('./git-info');
const { createGhInfo } = require('./gh-info');
const { createRunners } = require('./runners');
const { createHistoryIndex } = require('./history-index');
const {
  createRecipeStore, extractPlaceholders, fillPrompt, normalizeForPty,
} = require('./recipes');

let manager = null;
let smokeOutput = '';
let bridge = null;       // текущий инстанс моста (может пересоздаваться при fallback на эфемерный порт)
let stuckTimer = null;
let store = null;        // стор манифеста воркспейса (workspace.js)
let wsync = null;        // гейт синхронизации манифеста (workspace-sync.js) — FIX 1/2 ревью
let activeTabId = null;  // последний tabId, о котором сообщил renderer через workspace:setActive
let usagePoller = null;  // поллер официальных лимитов (usage-oauth.js) — слой A
let ccusage = null;      // слой расходов ccusage (usage-ccusage.js) — слой B
let gitInfo = null;      // Task 2 фазы 6 (панель диффа): git-info.js, чистое ядро + реальный run()
let ghInfo = null;       // Task 4 фазы 6 (панель GitHub): gh-info.js, чистое ядро + реальный run()
let runners = null;      // Task 5 carryover фазы 6 (задача 5 фазы 7): runners.js, реестр процессов + раннеры npx/git/gh
let recipeStore = null;       // Task 4 фазы 7 (рецепты + именованные воркспейсы): recipes.js, чистое ядро + реальные пути в userData
let historyIndex = null;      // Task 3 фазы 7 (поиск истории): history-index.js, чистое ядро + реальные зависимости
// I5 (ревью финальной волны фазы 7): состояние ленивого индекса истории —
// единый мутируемый объект (createHistoryIndexState(), см. ниже) вместо
// россыпи независимых let-переменных. builtAt (было historyIndexBuilt —
// boolean, взводимый РОВНО ОДИН РАЗ за жизнь окна) заменён на timestamp: 0 —
// «индекс ещё ни разу не строился», иначе — момент последнего успешного
// refresh(). Кокпит держат открытым сутками (обычный день, не край) — сессии,
// созданные ПОСЛЕ первого поиска, не искались до перезапуска кокпита вовсе.
// Подробности TTL — у HISTORY_INDEX_TTL_MS/historySearchHandler() ниже.
let historyIndexState = null;
let usageMonitorTimer = null; // лёгкий сторож (только snapshot(), без сети) — рассылает usage:update
let lastBroadcastKey = null;    // `fetchedAt|stale|error` последнего разосланного usage:update — см. usageBroadcastKey()
let lastCcusageResult = null;   // последний известный ответ ccusage.get() — уходит и в usage:get/usage:refresh, и в usage:update
let manualRefreshInFlight = null; // Promise текущего usage:refresh, если уже выполняется (single-flight, FINDING 2 ревью)
let lastManualRefreshAt = 0;       // Date.now() последнего РЕАЛЬНО выполненного (не отбитого троттлингом) usage:refresh
let nightWatch = null;   // Task 2 фазы 8 («Ночная смена»): инстанс createNightWatch (night-watch.js), см. регистрацию ниже
// Task 2 фазы 8, КРИТИЧЕСКАЯ ЛОВУШКА (найдена на ревью Task 1, зафиксирована в
// брифе Task 2): sessions.js на Stop-хуке СИНХРОННО ставит статус 'done' и
// наружу отдаёт ТОЛЬКО событие 'tab:status' с уже НОВЫМ статусом (см.
// sessions.js/applyHookEvent, case 'Stop' → setStatus(tab,'done','') —
// единственное место во всём коде, где статус вкладки переходит именно
// working→done, других путей в 'done' нет). Если бы обвязка читала prevStatus
// ПОСЛЕ обновления этой карты, prev всегда совпадал бы с уже новым статусом
// ('done'), nightWatch.onTabStop никогда не увидел бы условие
// prevStatus==='working' — детект остановки по лимиту превратился бы в
// мёртвый код НАВСЕГДА. Карта хранит статус ДО применения текущего события —
// см. обработчик 'tab:status' в onEvent ниже, где prev читается ИЗ карты
// СТРОГО ДО set(). Запись чистится на tabs:close (вкладки больше нет).
let lastStatusByTab = new Map();

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

// FINDING 2 (ревью, fix round 1): минимальный интервал между РЕАЛЬНЫМИ ручными
// usage:refresh — двойной клик или зажатый Enter/Space (автоповтор клавиши) по
// #limits не должен бомбить сеть/npx на каждое срабатывание (в пределе —
// поймать настоящий 429 от Anthropic, который сам себя гасит на 10 минут).
const MANUAL_REFRESH_MIN_INTERVAL_MS = 10000;

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

// Task 3 фазы 7 (поиск истории): тот же файл-кэш, что и у слоёв usage выше —
// createJsonFileCache ниже используется третий раз, каждый со своим путём.
function historyIndexCacheFile() {
  return path.join(app.getPath('userData'), 'history-index.json');
}

// Task 4 фазы 7 (рецепты + именованные воркспейсы): два независимых файла в
// userData — recipes.js сам про app.getPath() ничего не знает (чистое ядро),
// пути резолвит только этот файл, тот же приём, что historyIndexCacheFile выше.
function promptsFile() {
  return path.join(app.getPath('userData'), 'prompts.json');
}

function workspacesLibraryFile() {
  // Имя НЕ workspace.json — тот файл уже занят манифестом текущего состава
  // вкладок (workspace.js/createWorkspaceStore, переменная store выше); это
  // отдельная библиотека ИМЕНОВАННЫХ, явно сохранённых пользователем профилей.
  return path.join(app.getPath('userData'), 'workspaces-library.json');
}

// Task 2 фазы 8 («Ночная смена»): файл журнала взводов — night-journal.js
// само про app.getPath() ничего не знает (чистый модуль, тот же приём, что
// promptsFile()/workspacesLibraryFile() выше), путь резолвит только этот файл.
function nightJournalFile() {
  return path.join(app.getPath('userData'), 'night-journal.json');
}

// --- Task 2 фазы 8 («Ночная смена»): реальные зависимости для createNightWatch
// (night-watch.js, Task 1, чистое ядро) — powerBlocker/journal здесь, единственном
// месте, где ipc.js касается require('electron').powerSaveBlocker и диска ради
// ночной смены.

// Обёртка над electron.powerSaveBlocker: идемпотентна через id-гард (бриф) —
// start() второй раз без предшествующего stop() не плодит второй системный
// блокер (id !== null → no-op), stop() без активного id — тоже no-op. Само
// ядро (night-watch.js/updateBlocker) уже не зовёт start()/stop() на каждый
// чих благодаря собственному blockerOn, но гард здесь — дополнительный
// рубеж, а не дублирование: чужой код мог бы дёрнуть powerBlocker напрямую.
function createRealPowerBlocker() {
  let id = null;
  return {
    start() {
      if (id === null) id = powerSaveBlocker.start('prevent-app-suspension');
    },
    stop() {
      if (id !== null) {
        try {
          if (powerSaveBlocker.isStarted(id)) powerSaveBlocker.stop(id);
        } catch { /* блокер мог уже быть снят системой — не критично */ }
        id = null;
      }
    },
  };
}

// Глобальное ограничение (бриф/спека): в smoke НИКОГДА не стартовать
// powerSaveBlocker — headless-прогон не должен трогать системное состояние
// энергосбережения. no-op объект вместо реальной обёртки.
function createNoopPowerBlocker() {
  return { start() {}, stop() {} };
}

// In-memory фейк журнала для smoke (бриф): append/readAll/reset на простом
// массиве в памяти процесса — headless-прогон не должен писать в userData
// ничего нового, но ядру (night-watch.js) всё равно нужен рабочий journal.
function createInMemoryNightJournal() {
  let entries = [];
  return {
    append(e) { entries.push(e); },
    readAll() { return entries; },
    reset() { entries = []; },
  };
}

// Important 2 (ревью фикс-раунд 1, Task 2 фазы 8): term:write несёт не
// только реальные клавиши пользователя, но и АВТООТВЕТЫ эмулятора xterm.js —
// focus in/out (\x1b[I / \x1b[O — режим 1004 у нас реально включён, виден в
// smoke-выводе), ответ на DSR (\x1b[24;80R), ответ на DA (\x1b[?1;2c). Без
// фильтра простое перемещение окна кокпита (focus out/in) или ответ
// терминала на запрос самого приложения внутри pty засчитывались бы как
// «пользователь перехватил вкладку» — nightWatch.onUserInput() отменил бы
// продолжение ночной смены МОЛЧА, и в журнале запись 'skipped user-took-over'
// выглядела бы совершенно легитимно, хотя пользователь вкладку не трогал.
// Вынесена в отдельную чистую функцию ради тестируемости (ipc.js целиком не
// тестируется под node --test, require('electron') вне настоящего рантайма
// не даёт объект). Стрелки (\x1b[A..D), голый Esc (\x1b без хвоста), Enter
// (\r) — НАСТОЯЩИЙ пользовательский ввод, под регэксп не попадают (regex
// требует \x1b[ + I/O/цифры;цифрыR/?цифры;c — одиночная буква A-D после
// \x1b[ ни под одну из веток не подходит).
function hasRealUserInput(data) {
  const withoutReports = data.replace(/\x1b\[(?:I|O|\d+;\d+R|\?[\d;]+c)/g, '');
  return withoutReports.length > 0;
}

// HH:MM из ms-таймстампа (локальное время) — брифом заказан именно этот
// формат для тоста «Лимит: продолжу в HH:MM». Нечисловой/некорректный вход
// (защита от неожиданной формы entry.detail) → '?', тост всё равно не падает.
function formatHHMM(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return '?';
  const d = new Date(n);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

// Тосты ключевых моментов (бриф): journal.append() — ЕДИНСТВЕННАЯ точка, куда
// night-watch.js стекает АБСОЛЮТНО ВСЕ свои события (см. appendJournal() в
// night-watch.js — она вызывается на каждый переход состояния). Оборачиваем
// append() реального/in-memory журнала: для конкретных типов записи
// дополнительно шлём notify() (существующий канал app:notice) человеческим
// текстом. journal.append(entry) вызывается ВСЕГДА, независимо от исхода
// тоста — запись в журнал первична, тост — побочный эффект поверх неё,
// обёрнутый в try/catch, чтобы сбой форматирования не проглотил саму запись.
//
// wakeMarginMs — Minor 3 (ревью фикс-раунд 1): тост «продолжу в HH:MM» обязан
// показывать момент РЕАЛЬНОГО продолжения (resetsAt + wakeMarginMs — см.
// scheduleWaitAt() в night-watch.js), а не сам resetsAt (окно сброса), иначе
// он систематически врёт на wakeMarginMs раньше настоящего момента вброса.
//
// Обращение к `nightWatch` (Minor 2 ниже) — ссылка на МОДУЛЬНУЮ let-переменную
// (объявлена в начале файла, присваивается чуть позже, в registerIpc(), сразу
// после createNightWatch()) — сама функция append() выполняется только
// АСИНХРОННО, много позже полного создания nightWatch (по-настоящему первый
// append произойдёт не раньше первого реального onTabStop/arm() из IPC), так
// что к моменту вызова nightWatch уже гарантированно присвоен; отдельная
// «ref-переменная» не нужна — closure и так видит актуальное значение.
function withNightToasts(journal, wakeMarginMs) {
  return {
    ...journal,
    append(entry) {
      journal.append(entry);
      try {
        if (!entry) return;
        switch (entry.type) {
          case 'limit-stop': {
            // Minor 2 (ревью фикс-раунд 1): тостим ТОЛЬКО первый лимит-стоп
            // цикла ожидания — при мульти-детекте (несколько вкладок встают
            // по лимиту одна за другой, окно общее на аккаунт) N одинаковых
            // тостов подряд не несут новой информации. pendingCount===1 в
            // МОМЕНТ этой записи означает, что именно ОНА впервые открыла
            // цикл (night-watch.js/onTabStop делает pending.push() ДО
            // appendJournal({type:'limit-stop'}) — снапшот, снятый прямо
            // здесь, синхронно внутри той же цепочки вызовов, уже видит
            // свежий pending).
            if (!nightWatch || nightWatch.snapshot().pendingCount !== 1) break;
            notify(`Лимит: продолжу в ${formatHHMM(Number(entry.detail) + wakeMarginMs)}`, 'info');
            break;
          }
          case 'wake-complete': {
            // detail — вида "N of M" (см. night-watch.js/runStagger) — тосту
            // нужно только N (сколько РЕАЛЬНО продолжили).
            const m = /^(\d+)/.exec(String(entry.detail || ''));
            const n = m ? Number(m[1]) : 0;
            // Minor 4 (ревью фикс-раунд 1): «продолжил 0 вкладок» (случай
            // '0 of 0' — будильник выстрелил, продолжать было некого) — шум,
            // не несёт пользы; запись в журнале остаётся, тоста не будет.
            if (n > 0) notify(`Ночная смена: продолжил ${n} вкладок`, 'info');
            break;
          }
          case 'weekly-limit':
            notify('Недельный лимит — продолжение невозможно', 'warn');
            break;
          case 'gave-up':
            notify('Окно не сбросилось — сдаюсь', 'warn');
            break;
          default:
            break;
        }
      } catch { /* тост не должен ронять запись в журнал */ }
    },
  };
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

// Раннеры внешних CLI (npx/git/gh) + реестр процессов + watchdog принудительной
// уборки дерева (runCcusage/gitRun/ghRun/killProcessTree/armKillWatchdog) —
// вынесены в runners.js (Task 5 carryover фазы 6, задача 5 фазы 7): execFile
// там инжектируется, что впервые даёт покрыть реестр/killProcessTree/
// armKillWatchdog тестами (test/runners.test.js) — раньше эта логика жила
// прямо здесь вперемешку с require('electron'), а ipc.js целиком не
// тестируется. Инстанс создаётся ниже, в registerIpc() (runners = createRunners({execFile})),
// тем же приёмом, что gitInfo/ghInfo — конструктор безопасно создавать
// безусловно, I/O он сам по себе не делает.

// --- Task 3 фазы 7 (глобальный поиск истории): реальные зависимости для
// createHistoryIndex (history-index.js, Task 2, чистое ядро — listProjects/
// readFileLines/stat/cache только инжектируются, сам модуль ни fs, ни path,
// ни electron не видит).

function historyProjectsRoot() {
  return path.join(os.homedir(), '.claude', 'projects');
}

// listProjects() → массив {projectDir, sessionId, filePath} — ТОЛЬКО файлы
// ПЕРВОГО уровня <project>/<sessionId>.jsonl, БЕЗ рекурсии. ВАЖНО (ревью
// задачи 2): вложенные транскрипты субагентов живут в
// <project>/<sessionId>/subagents/agent-*.jsonl — рекурсивный обход захватил
// бы их как «сессии» и замусорил индекс тем, что вне контракта history-index.js.
// withFileTypes+isFile() — тот же фильтр, что временная живая проверка задачи 2
// (task-2-report.md) уже подтвердила на реальных данных этой машины (47
// сессий, ровно столько же, сколько верхнеуровневых .jsonl файлов).
async function listHistoryProjects() {
  const base = historyProjectsRoot();
  let projectDirs;
  try {
    projectDirs = await fs.promises.readdir(base, { withFileTypes: true });
  } catch {
    return []; // ~/.claude/projects ещё нет (свежая машина/чистый профиль) — истории нет
  }
  const out = [];
  for (const pd of projectDirs) {
    if (!pd.isDirectory()) continue;
    const projectDir = path.join(base, pd.name);
    let files;
    try {
      files = await fs.promises.readdir(projectDir, { withFileTypes: true });
    } catch {
      continue; // папка проекта исчезла между двумя readdir — пропустить
    }
    for (const f of files) {
      if (!f.isFile() || !f.name.toLowerCase().endsWith('.jsonl')) continue;
      out.push({
        projectDir,
        sessionId: f.name.slice(0, -'.jsonl'.length),
        filePath: path.join(projectDir, f.name),
      });
    }
  }
  return out;
}

// stat(filePath) → {mtimeMs, size} — совпадает по именам полей с fs.Stats.
async function statHistoryFile(filePath) {
  const st = await fs.promises.stat(filePath);
  return { mtimeMs: st.mtimeMs, size: st.size };
}

// readFileLines(filePath) → асинхронный генератор строк — потоково, ЧЕРЕЗ
// fs.createReadStream+readline, файл НИКОГДА не читается целиком (транскрипты
// бывают десятками МБ). Ошибка потока (файл исчез между stat() и этим вызовом)
// доходит до history-index.js как reject внутри `for await` — readline
// пробрасывает 'error' входного стрима в асинхронный итератор (проверено
// живьём: ENOENT на несуществующем файле ловится именно так, не проглатывается).
async function* readHistoryJsonlLines(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      yield line;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

// FINDING 1 (ревью, fix round 1): usage-oauth.js/applyError() при сбое
// оставляет fetchedAt ПРЕЖНИМ (берёт из lastGood) — сторож, сравнивавший
// только fetchedAt, никогда не замечал переход в stale (истёк токен → 15-мин
// бэкофф) и renderer вечно показывал бы старые проценты без приглушения.
// Ключ теперь — связка (fetchedAt, stale, error): смена ЛЮБОЙ из трёх частей
// (включая переход ok:true→stale:true при том же fetchedAt) считается
// «состояние изменилось» и рассылается.
function usageBroadcastKey(snap) {
  return `${snap.fetchedAt}|${snap.stale}|${snap.error}`;
}

// Task 5 carryover фазы 6 (задача 5 фазы 7, п.4 брифа): смоук-гейт git:get/
// gh:repo/gh:global вынесен в отдельные функции с явными зависимостями.
// ПРИЧИНА: ipc.js целиком не тестируется — модуль на верхнем уровне зовёт
// require('electron'), который вне настоящего Electron-рантайма отдаёт не
// объект, а строку пути к бинарнику (ipcMain/app/dialog там undefined), так
// что registerIpc() нельзя вызвать под node --test. Раньше это означало, что
// удаление `if (smoke) return null;` внутри ipcMain.handle прошло бы зелёным —
// ни один тест бы не заметил (находка 3, ревью carryover фазы 6). Экспортируем
// эти три функции (см. module.exports внизу файла) — test/ipc-smoke-gate.test.js
// зовёт их напрямую с фейковым gitInfo/ghInfo, минуя Electron целиком; это
// ТА ЖЕ логика, что реально исполняется в проде (registerIpc() ниже просто
// прокидывает сюда своё замыкание), а не отдельная параллельная реализация.
function gitGetHandler({
  smoke, tabId, opts, tabCwd, gitInfo,
}) {
  if (smoke) return null;
  if (typeof tabId !== 'string') return null;
  const cwd = tabCwd(tabId);
  if (!cwd) return null;
  const force = !!(opts && opts.force);
  return gitInfo.get(cwd, { force });
}

function ghRepoHandler({
  smoke, tabId, opts, tabCwd, ghInfo,
}) {
  if (smoke) return null;
  if (typeof tabId !== 'string') return null;
  const cwd = tabCwd(tabId);
  if (!cwd) return null;
  const force = !!(opts && opts.force);
  return ghInfo.getRepo(cwd, { force });
}

function ghGlobalHandler({ smoke, opts, ghInfo }) {
  if (smoke) return null;
  const force = !!(opts && opts.force);
  return ghInfo.getGlobal({ force });
}

// I5 (ревью финальной волны фазы 7): раньше индекс истории собирался лениво
// РОВНО ОДИН РАЗ за жизнь окна (historyIndexBuilt — boolean, взводился и
// больше никогда не сбрасывался) — сессии, созданные ПОСЛЕ первого поиска,
// не попадали в индекс до перезапуска кокпита вообще. Кокпит держат открытым
// сутками — это обычный рабочий день, не крайний случай (сценарий ревью:
// кокпит открыт с 9:00, новая вкладка в 11:00, первый поиск в 12:00, повторный
// поиск в 17:00 — «ничего не найдено», хотя строка есть в транскрипте).
//
// Фикс — TTL, а не «refresh при каждом открытии оверлея поиска» (тоже
// предлагался): поиск — редкое, ручное действие (Ctrl+Shift+H от случая к
// случаю), а historyIndex.refresh() БЕЗ force уже сам инкрементален
// (history-index.js перечитывает содержимое ТОЛЬКО файлов, чьи mtime/size
// изменились) — но даже так стоит заметное время (1.5-2.2с на 47 сессиях этой
// машины, задача 2 фазы 7): перечисление ~/.claude/projects целиком и
// stat() КАЖДОГО файла — не бесплатны сами по себе, даже без единого чтения
// содержимого. search.js дебаунсит ввод на 350мс, но пользователь может
// уточнять запрос НЕСКОЛЬКО раз подряд, продолжая печатать, — TTL короче,
// чем «кокпит открыт весь рабочий день» (часы), но заметно ДОЛЬШЕ типичной
// паузы между такими уточнениями (секунды-десятки секунд), чтобы каждое
// уточнение одного запроса не било повторным refresh(). 5 минут:
// гарантированно ловит сценарий ревью (любой разрыв между поисками дольше
// пяти минут — а час между 11:00 и 12:00 кратно больше — форсирует
// пересбор), и с большим запасом переживает типичную серию правок одного
// запроса в открытом оверлее.
const HISTORY_INDEX_TTL_MS = 5 * 60 * 1000;

// builtAt: 0 — индекс ещё ни разу не строился, иначе — now() на момент
// последнего успешного refresh(). buildInFlight — Promise текущей сборки,
// если уже выполняется (single-flight, см. historySearchHandler ниже).
function createHistoryIndexState() {
  return { builtAt: 0, size: 0, buildInFlight: null };
}

// Task 3 фазы 7 (глобальный поиск истории): смотри search.js (renderer) —
// оверлей с дебаунсом/отменой устаревших запросов, эта функция — только
// проводка + ленивая сборка индекса. Вынесена в отдельную функцию с явными
// зависимостями по ТОЙ ЖЕ причине, что gitGetHandler/ghRepoHandler/
// ghGlobalHandler выше (см. комментарий там) — ipc.js целиком не
// тестируется, а history:search добавлен в ЭТОЙ ЖЕ ветке фазы 7 с тем же
// классом гейта, но без единого теста на него (находка «дыра тестов №1»,
// ревью финальной волны).
//
// state — createHistoryIndexState() (mutable, по ссылке — см. регистрацию в
// registerIpc()); historyIndex — createHistoryIndex() (history-index.js);
// now — инжектируемый клок, тестам нужен управляемый (TTL иначе нельзя было
// бы проверить без реального ожидания 5 минут).
//
// FINDING (ревью Task 3, Important, всё ещё в силе): ipcMain.handle НЕ
// сериализует параллельные invoke одного канала, а дебаунс в renderer
// (search.js) отменяет только ЕЩЁ НЕ ОТПРАВЛЕННЫЙ таймер — уже улетевший
// запрос летит независимо от следующего. Single-flight по тому же образцу,
// что manualRefreshInFlight у usage:refresh: пока сборка не разрешилась, все
// параллельные вызовы ждут ОДИН и тот же промис, второго refresh() не
// запускается вовсе — TTL (I5) лишь РАСШИРЯЕТ множество случаев, когда мы
// решаем «пересбор нужен», сам механизм single-flight не тронут ни строкой.
async function historySearchHandler({
  smoke, query, opts, state, historyIndex, now = Date.now,
}) {
  if (smoke) return null;
  const stale = state.builtAt === 0 || (now() - state.builtAt) > HISTORY_INDEX_TTL_MS;
  if (stale) {
    if (!state.buildInFlight) {
      state.buildInFlight = (async () => {
        const entries = await historyIndex.refresh({});
        state.builtAt = now();
        state.size = entries.length;
      })();
    }
    try {
      await state.buildInFlight;
    } finally {
      state.buildInFlight = null;
    }
  }
  const o = opts && typeof opts === 'object' ? opts : {};
  const results = await historyIndex.search(query, o);
  return { results, indexSize: state.size };
}

// Явный пересбор индекса ({force:true} игнорирует mtime/size-эвристику
// history-index.js целиком). Канал существует по брифу задачи 3 — текущий
// UI (search.js) им не пользуется напрямую (полагается на встроенный
// ленивый пересбор внутри historySearchHandler выше), задел на будущую
// кнопку «Обновить индекс». Вынесена по той же причине, что historySearchHandler.
async function historyRefreshHandler({
  smoke, opts, state, historyIndex, now = Date.now,
}) {
  if (smoke) return null;
  const force = !!(opts && opts.force);
  const entries = await historyIndex.refresh({ force });
  state.builtAt = now();
  state.size = entries.length;
  return entries;
}

// Дыра тестов №1 (ревью финальной волны фазы 7): recipes:* добавлены в ЭТОЙ
// ЖЕ ветке (Task 4 фазы 7) с тем же классом смоук-гейта, что git:get/gh:repo/
// gh:global, но остались без единого теста на него. Вынесены по тому же
// приёму — явные зависимости, экспорт только ради теста (см. module.exports
// внизу файла), registerIpc() ниже просто прокидывает реальные замыкания.
function recipesListHandler({ smoke, recipeStore }) {
  if (smoke) return [];
  return recipeStore.listPrompts().map((p) => ({ ...p, placeholders: extractPlaceholders(p.text) }));
}

function recipesSavePromptHandler({ smoke, recipe, recipeStore }) {
  if (smoke) return null;
  return recipeStore.savePrompt(recipe);
}

function recipesDeletePromptHandler({ smoke, id, recipeStore }) {
  if (smoke) return;
  if (typeof id === 'string') recipeStore.deletePrompt(id);
}

function recipesListWorkspacesHandler({ smoke, recipeStore }) {
  if (smoke) return [];
  return recipeStore.listWorkspaces();
}

function recipesSaveWorkspaceHandler({
  smoke, name, tabs, recipeStore,
}) {
  if (smoke) return null;
  return recipeStore.saveWorkspace(name, tabs);
}

function recipesDeleteWorkspaceHandler({ smoke, id, recipeStore }) {
  if (smoke) return;
  if (typeof id === 'string') recipeStore.deleteWorkspace(id);
}

// Task 2 фазы 8 («Ночная смена»): night:toggle/night:get вынесены в отдельные
// функции с явными зависимостями — та же причина, что у gitGetHandler/
// ghRepoHandler/recipesListHandler и т.д. выше (ipc.js целиком не
// тестируется под node --test, require('electron') вне настоящего рантайма
// не даёт объект). smoke-гейт здесь ОСОБЕННО важен: nightWatch, созданный в
// smoke (см. registerIpc ниже), уже сам по себе получает in-memory журнал и
// no-op powerBlocker — но `if (smoke) return null;` ДО обращения к nightWatch
// вообще (а не полагание только на его безопасные зависимости) — тот же
// защитный рубеж, что у всех остальных смоук-гейтов проекта: headless-прогон
// не должен трогать ЖУРНАЛ ядра ночной смены вовсе, даже in-memory.
function nightToggleHandler({ smoke, nightWatch: nw }) {
  if (smoke) return null;
  if (nw.isArmed()) nw.disarm();
  else nw.arm();
  return nw.snapshot();
}

function nightGetHandler({ smoke, nightWatch: nw }) {
  if (smoke) return null;
  return nw.snapshot();
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
  // Task 5 carryover фазы 6 (задача 5 фазы 7): runners.js — реестр процессов
  // + раннеры npx/git/gh, execFile — реальный child_process.execFile (см.
  // require в шапке файла). Конструктор не делает I/O сам по себе — безопасно
  // создавать безусловно, даже в smoke (сами runCcusage/gitRun/ghRun ничего
  // не запускают, пока их не позовут IPC-хендлеры ниже, а те в smoke этого не делают).
  runners = createRunners({ execFile });
  ccusage = createCcusage({
    run: runners.runCcusage,
    cache: createJsonFileCache(usageCcusageCacheFile()),
  });
  // Task 2 фазы 6 (панель диффа): gitInfo — чистое ядро (git-info.js) +
  // реальный run() (runners.gitRun). Конструктор не делает I/O сам по себе —
  // безопасно создавать безусловно, даже в smoke (сам IPC-хендлер ниже
  // просто не зовёт .get() в smoke — см. 'git:get').
  gitInfo = createGitInfo({ run: runners.gitRun });
  // Task 4 фазы 6 (панель GitHub): ghInfo — чистое ядро (gh-info.js) + реальный
  // run() (runners.ghRun). Тот же приём, что gitInfo прямо над этим — конструктор
  // не делает I/O сам по себе, безопасно создавать безусловно даже в smoke (сам
  // IPC-хендлер ниже просто не зовёт .getRepo()/.getGlobal() в smoke).
  ghInfo = createGhInfo({ run: runners.ghRun });
  // Task 3 фазы 7 (глобальный поиск истории): historyIndex — чистое ядро
  // (history-index.js) + реальные зависимости выше (обход ~/.claude/projects,
  // потоковое чтение JSONL, fs.stat, JSON-кэш в userData). Конструктор не
  // делает I/O сам по себе — безопасно создавать всегда, даже в smoke (сам
  // IPC-хендлер 'history:search'/'history:refresh' ниже просто не зовёт
  // .refresh()/.search() в smoke). Сборка индекса — ЛЕНИВАЯ, при первом
  // РЕАЛЬНОМ history:search (см. хендлер ниже), не здесь и не на старте.
  historyIndex = createHistoryIndex({
    listProjects: listHistoryProjects,
    readFileLines: readHistoryJsonlLines,
    stat: statHistoryFile,
    cache: createJsonFileCache(historyIndexCacheFile()),
  });
  historyIndexState = createHistoryIndexState();
  lastBroadcastKey = null;
  lastCcusageResult = null;
  manualRefreshInFlight = null;
  lastManualRefreshAt = 0;

  // Task 4 фазы 7 (рецепты + именованные воркспейсы): recipeStore — чистое
  // ядро (recipes.js) + реальные пути в userData выше. Конструктор не делает
  // I/O сам по себе (тот же приём, что historyIndex/gitInfo/ghInfo выше) —
  // безопасно создавать всегда, даже в smoke. Дефолтные рецепты первого
  // запуска (бриф) сеются здесь, но ТОЛЬКО не в smoke — headless-прогон не
  // должен писать в userData ничего нового при каждом запуске.
  recipeStore = createRecipeStore({
    promptsFile: promptsFile(),
    workspacesFile: workspacesLibraryFile(),
  });
  if (!smoke) recipeStore.ensureDefaultPrompts();

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
      // Task 2 фазы 8 («Ночная смена») — детект остановки по лимиту. См.
      // подробный комментарий у объявления lastStatusByTab выше по файлу:
      // prevStatus ОБЯЗАН читаться из карты ДО её обновления новым значением
      // из payload — иначе prev всегда совпадёт с уже применённым Stop'ом
      // статусом 'done', и переход working→done никогда не будет замечен.
      if (channel === 'tab:status') {
        const prev = lastStatusByTab.get(payload.tabId);
        lastStatusByTab.set(payload.tabId, payload.status);
        // Minor 1 (ревью фикс-раунд 1): ядро (night-watch.js/processResumeTab,
        // NO_RESUME_STATUSES) считает 'stuck' ПОЛНОСТЬЮ резюмируемым статусом
        // на пробуждении — детект должен быть симметричен: вкладку могло
        // пометить checkStuck() (>5 мин без вывода — типичная картина, пока
        // Claude висит на исчерпанном лимите) НЕПОСРЕДСТВЕННО перед самим
        // Stop-хуком, она всё ещё реально «работала». night-watch.js/onTabStop
        // (уже отревьюженное ядро Task 1) требует ЛИТЕРАЛЬНО prevStatus==='working'
        // (спека) — не трогаем ядро, нормализуем здесь, в обвязке, которая и
        // владеет знанием о пятистатусной модели статусов sessions.js.
        const wasWorking = prev === 'working' || prev === 'stuck';
        // Important 1 (ревью фикс-раунд 1): детект теперь ТАКЖЕ требует
        // ДОКАЗАННОГО поколения (payload.genProven, см. sessions.js/applyHookEvent,
        // ветка 'Stop') — без этого гарда сторонний процесс ТОЙ ЖЕ сессии вне
        // кокпита (маршрутизация по session_id, gen:null — заявленная фича
        // port-file, см. I4 фазы 7) мог бы завершить СВОЮ задачу и подложить
        // working→done вкладке кокпита, которая в это время реально работала
        // над своей — ночная смена восприняла бы это как остановку по лимиту
        // и позже вбросила бы «продолжай» в живой ввод чужой (в смысле не
        // связанной с этим событием) сессии.
        if (nightWatch && payload.status === 'done' && wasWorking && payload.genProven === true) {
          nightWatch.onTabStop(payload.tabId, 'working');
        }
      }
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

  // Task 2 фазы 8 («Ночная смена»): инстанс СРАЗУ после manager/usagePoller
  // (бриф) — все реальные зависимости ядра собраны в одном месте. journal/
  // powerBlocker — smoke-безопасные варианты в headless-прогоне (глобальное
  // ограничение: в smoke не трогать userData и не стартовать powerSaveBlocker),
  // withNightToasts() оборачивает ОБА варианта журнала одинаково — сам тост
  // безвреден и в smoke (арминг там всё равно недостижим — см. nightToggleHandler
  // с гейтом `if (smoke) return null;` до обращения к nightWatch вообще).
  lastStatusByTab = new Map();
  const nightCfg = getConfig().nightWatch;
  // Minor 5 (ревью фикс-раунд 1): пачка Stop'ов в разных вкладках (окно
  // общее на аккаунт — вполне реалистично, если несколько сессий упёрлись в
  // лимит примерно одновременно) звала бы usagePoller.refresh() параллельно,
  // мимо уже существующей single-flight защиты manualRefreshInFlight (та
  // покрывает только IPC-путь 'usage:refresh') — риск словить 429 от
  // Anthropic и уйти в 10-минутный stale-бэкофф поллера, из-за которого
  // СЛЕДУЮЩИЙ настоящий лимит-стоп получил бы no-usage-data и не продолжился
  // бы ночью вовсе. Конкурентные детекты теперь делят ОДИН сетевой запрос.
  let usageRefreshInFlight = null;
  const refreshUsage = () => usageRefreshInFlight
    || (usageRefreshInFlight = Promise.resolve(usagePoller.refresh())
      .finally(() => { usageRefreshInFlight = null; }));
  nightWatch = createNightWatch({
    now: Date.now,
    // unref — так же, как stuckTimer/usageMonitorTimer ниже: таймеры ночной
    // смены (ожидание сброса окна, стаггер резюма, ретраи) не должны сами по
    // себе держать процесс живым.
    setTimer: (fn, ms) => {
      const id = setTimeout(fn, ms);
      if (id.unref) id.unref();
      return id;
    },
    clearTimer: (id) => clearTimeout(id),
    refreshUsage,
    getTabStatus: (tabId) => {
      const tab = manager.list().find((t) => t.tabId === tabId);
      return tab ? tab.status : null;
    },
    // Гард непустого текста + '\r' (бриф) — тот же приём, что normalizeForPty/
    // injectQueuedOnStop, только текст здесь всегда буквальное «продолжай»
    // (решение пользователя, брейншторм 28.07), нормализовывать нечего.
    writeToTab: (tabId, text) => {
      const t = String(text || '').trim();
      if (t) manager.write(tabId, `${t}\r`);
    },
    emit: (event, payload) => {
      if (!win.isDestroyed()) win.webContents.send(event, payload);
    },
    powerBlocker: smoke ? createNoopPowerBlocker() : createRealPowerBlocker(),
    journal: withNightToasts(
      smoke ? createInMemoryNightJournal() : createNightJournal({ file: nightJournalFile() }),
      nightCfg.wakeMarginMs,
    ),
    config: nightCfg,
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
  // читает ТОЛЬКО snapshot() (синхронно, без сети) и сравнивает КЛЮЧ
  // usageBroadcastKey (fetchedAt+stale+error) с последним разосланным — смена
  // ЛЮБОЙ из трёх частей означает «состояние изменилось» (успешный refresh,
  // ИЛИ переход в stale/error при том же fetchedAt — FINDING 1, ревью fix
  // round 1: applyError() в usage-oauth.js оставляет fetchedAt прежним, чистое
  // сравнение по fetchedAt никогда не заметило бы протухание при сбое) — и
  // тогда шлём usage:update. Гранулярность обнаружения — до 5с, сети это не
  // стоит ничего (snapshot() — синхронное чтение из памяти).
  if (!smoke) {
    usagePoller.start();
    usageMonitorTimer = setInterval(() => {
      const snap = usagePoller.snapshot();
      const key = usageBroadcastKey(snap);
      if (key !== lastBroadcastKey) {
        lastBroadcastKey = key;
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

  // Task 2 фазы 8 («Ночная смена»): кнопка 🌙/действие палитры дёргают toggle,
  // дашборд читает снапшот через get(); push-обновления между ними — событие
  // 'night:changed', которое зовёт сам nightWatch (emit-зависимость выше) на
  // КАЖДОЕ изменение состояния, отдельного IPC для него не требуется. Логика
  // смоук-гейта — в nightToggleHandler()/nightGetHandler() выше по файлу (та
  // же причина, что и у остальных вынесенных хендлеров — см. комментарий там).
  ipcMain.handle('night:toggle', () => nightToggleHandler({ smoke, nightWatch }));

  ipcMain.handle('night:get', () => nightGetHandler({ smoke, nightWatch }));

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
  //
  // FINDING 2 (ревью, fix round 1): без защиты двойной клик / зажатый
  // Enter-Space (автоповтор клавиши) на #limits плодил параллельные прогоны
  // npx на каждое срабатывание, а при достаточном спаме мог словить настоящий
  // 429 от Anthropic (поллер тогда сам гасит себя на 10 минут). Два независимых
  // барьера:
  // (а) single-flight — пока предыдущий usage:refresh не разрешился,
  //     повторный вызов получает ТОТ ЖЕ промис, второго refresh()/ccusage.get()
  //     не запускается вовсе;
  // (б) минимальный интервал MANUAL_REFRESH_MIN_INTERVAL_MS (10с) между
  //     РЕАЛЬНО выполненными обновлениями — вызов внутри окна получает текущий
  //     снапшот без единой сетевой/npx операции.
  ipcMain.handle('usage:refresh', async () => {
    if (smoke) return { limits: usagePoller.snapshot(), spend: null };
    if (manualRefreshInFlight) return manualRefreshInFlight;

    const nowMs = Date.now();
    if (nowMs - lastManualRefreshAt < MANUAL_REFRESH_MIN_INTERVAL_MS) {
      return { limits: usagePoller.snapshot(), spend: lastCcusageResult };
    }
    lastManualRefreshAt = nowMs;

    manualRefreshInFlight = (async () => {
      const [, spend] = await Promise.all([usagePoller.refresh(), ccusage.get({ force: true })]);
      lastCcusageResult = spend;
      return { limits: usagePoller.snapshot(), spend };
    })();
    try {
      return await manualRefreshInFlight;
    } finally {
      manualRefreshInFlight = null;
    }
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
    // Task 5 carryover фазы 4/5 (утечка карт в toasts.js): manager.close()
    // инкрементит generation ДО kill() pty — закрытая (а не естественно
    // умершая) вкладка не гарантированно эмитит статус 'dead' в этот тостер,
    // так что без явного forget() записи workingSince/lastStatus по её tabId
    // копились бы в памяти навсегда. Симметрично с уборкой ghost-файла ниже —
    // обе чистки естественно живут рядом с самим закрытием вкладки.
    if (toaster) toaster.forget(tabId);
    // Task 2 фазы 8: вкладки больше нет — запись в карте статусов ночной
    // смены (lastStatusByTab) больше никому не нужна и не должна копиться в
    // памяти навсегда, тот же приём, что toaster.forget()/ghost-файл выше.
    lastStatusByTab.delete(tabId);
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

  // Находка 4б (ревью фазы 6): раньше клик по ⚡ гасил кнопку сразу же после
  // успешного connectProject() — но ТЕКУЩАЯ сессия CLI внутри уже запущенного
  // pty не перечитывает .claude/settings.json на лету, поэтому она не начнёт
  // слать новое событие (PostToolUse) до перезапуска — панель диффа молча
  // не обновлялась бы сама, а пользователь не узнал бы, что нужно сделать.
  // notify() — тот же канал app:notice, что main уже использует для других
  // уведомлений (см. main.js) — renderer показывает его тостом (app.js).
  ipcMain.handle('project:connect', (_e, tabId) => {
    const cwd = tabCwd(tabId);
    if (!cwd) return { connected: false, error: 'вкладка не найдена' };
    const res = connectProject(cwd, hookOpts());
    if (res && res.connected) {
      notify('Хуки обновлены — перезапустите сессию (Ctrl+Shift+R), чтобы панель диффа обновлялась сама', 'info');
    }
    return res;
  });

  ipcMain.handle('project:status', (_e, tabId) => {
    const cwd = tabCwd(tabId);
    return { connected: cwd ? isConnected(cwd) : false };
  });

  // Task 2 фазы 6 (панель диффа): cwd вкладки — тот же tabCwd(), что и
  // project:connect/status выше. smoke: НЕ дёргаем git вообще — headless-
  // прогон не должен спавнить внешние процессы сверх PTY_OK-смоука (см.
  // task-2-brief.md, шаг 3: «в smoke НЕ вызывать»). force — явный ручной
  // повтор (кнопка «Обновить» панели), опрокидывает TTL-кэш gitInfo.
  // Сама логика — в gitGetHandler() (см. выше по файлу, п.4 брифа задачи 5
  // фазы 7): вынесена, чтобы смоук-гейт был протестирован без Electron.
  ipcMain.handle('git:get', async (_e, tabId, opts) => gitGetHandler({
    smoke, tabId, opts, tabCwd, gitInfo,
  }));

  // Task 4 фазы 6 (панель GitHub): cwd вкладки — тот же tabCwd(), что и git:get
  // выше. smoke: НЕ дёргаем gh вообще — headless-прогон не должен спавнить
  // внешние процессы сверх PTY_OK-смоука. force — ручной повтор, опрокидывает
  // TTL-кэш ghInfo. Логика — в ghRepoHandler() выше по файлу (та же причина,
  // что у git:get).
  ipcMain.handle('gh:repo', async (_e, tabId, opts) => ghRepoHandler({
    smoke, tabId, opts, tabCwd, ghInfo,
  }));

  // gh:global — сводка по ВСЕМ открытым PR/issues пользователя + число
  // непрочитанных уведомлений, без привязки к конкретной вкладке (дашборд,
  // Task 4 фазы 6). smoke — тот же гейт, что и gh:repo выше. Логика —
  // в ghGlobalHandler() выше по файлу.
  ipcMain.handle('gh:global', async (_e, opts) => ghGlobalHandler({ smoke, opts, ghInfo }));

  // Task 3 фазы 7 (глобальный поиск истории, Ctrl+Shift+H) + I5 (ревью
  // финальной волны, TTL индекса): смотри search.js (renderer) — оверлей с
  // дебаунсом/отменой устаревших запросов, здесь только проводка. Логика —
  // в historySearchHandler()/historyRefreshHandler() выше по файлу (вынесены
  // ради тестируемости смоук-гейта — «дыра тестов №1», ревью финальной
  // волны — и TTL-фикса I5, см. подробные комментарии там).
  ipcMain.handle('history:search', async (_e, query, opts) => historySearchHandler({
    smoke, query, opts, state: historyIndexState, historyIndex,
  }));

  ipcMain.handle('history:refresh', async (_e, opts) => historyRefreshHandler({
    smoke, opts, state: historyIndexState, historyIndex,
  }));

  // Task 4 фазы 7 (библиотека рецептов промптов): recipes:list отдаёт КАЖДЫЙ
  // рецепт УЖЕ с посчитанными placeholders (extractPlaceholders — чистая
  // функция recipes.js, здесь вызывается один раз на рецепт) — renderer
  // (app.js/buildPaletteActions) решает, показывать ли мини-форму, ПО этому
  // полю, не таща отдельно текст плейсхолдера через второй IPC-вызов на
  // каждый рецепт. smoke: не читаем userData вовсе — тот же гейт, что history/
  // usage/gh выше.
  // Дыра тестов №1 (ревью финальной волны): логика — в recipesListHandler()
  // выше по файлу (та же причина, что historySearchHandler/gitGetHandler —
  // ipc.js целиком не тестируется, а этот канал добавлен в ЭТОЙ ЖЕ ветке
  // фазы 7 с тем же классом смоук-гейта, но остался без единого теста).
  ipcMain.handle('recipes:list', () => recipesListHandler({ smoke, recipeStore }));

  // Сохранение/удаление рецепта — CRUD-контракт recipes.js целиком (бриф),
  // текущий UI (палитра) сам новые рецепты не создаёт и не удаляет (только
  // читает дефолты + то, что уже лежит в prompts.json) — задел на будущую
  // форму редактирования библиотеки, тот же приём, что history:refresh выше.
  // Логика — в recipesSavePromptHandler()/recipesDeletePromptHandler() выше.
  ipcMain.handle('recipes:savePrompt', (_e, p) => recipesSavePromptHandler({ smoke, recipe: p, recipeStore }));

  ipcMain.handle('recipes:deletePrompt', (_e, id) => recipesDeletePromptHandler({ smoke, id, recipeStore }));

  // fillPrompt — чистая текстовая подстановка без единого обращения к диску,
  // смысла гейтить smoke'ом нет (тот же довод, что config:get/shell.openExternal
  // выше по файлу не гейтятся) — просто безвредный no-op на пустых values.
  ipcMain.handle('recipes:fillPrompt', (_e, text, values) => fillPrompt(text, values));

  // Minor 8 (ревью раунд 1): нормализация переносов строк перед записью в pty —
  // тоже чистая функция без диска, тот же довод, что recipes:fillPrompt выше,
  // не гейтим smoke'ом. Зовётся app.js/runRecipe БЕЗУСЛОВНО (даже без
  // плейсхолдеров), чтобы внутренний \n текста рецепта не ушёл в терминал
  // отдельным Enter (в т.ч. молчаливым подтверждением диалога разрешения).
  ipcMain.handle('recipes:normalizeForPty', (_e, text) => normalizeForPty(text));

  // Именованные воркспейсы (Task 4 фазы 7): listWorkspaces/saveWorkspace —
  // палитра читает и пишет их напрямую (действия «Открыть воркспейс: <name>»/
  // «Сохранить воркспейс…», см. app.js). deleteWorkspace (ревью раунд 1,
  // Minor 6) — теперь тоже за действием палитры «Удалить воркспейс: <name>»
  // (без него накопленный дублями/устаревший мусор в workspaces-library.json
  // можно было почистить только руками через файл).
  // Дыра тестов №1 (ревью финальной волны): логика — в
  // recipesListWorkspacesHandler()/recipesSaveWorkspaceHandler()/
  // recipesDeleteWorkspaceHandler() выше по файлу (та же причина).
  ipcMain.handle('recipes:listWorkspaces', () => recipesListWorkspacesHandler({ smoke, recipeStore }));

  ipcMain.handle('recipes:saveWorkspace', (_e, name, tabs) => recipesSaveWorkspaceHandler({
    smoke, name, tabs, recipeStore,
  }));

  ipcMain.handle('recipes:deleteWorkspace', (_e, id) => recipesDeleteWorkspaceHandler({ smoke, id, recipeStore }));

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
    // Task 2 фазы 8 («Ночная смена»): term:write — основной путь клавиатуры
    // пользователя в pty (спека, раздел «Точки интеграции»), но не ЕДИНСТВЕННЫЙ
    // по содержимому — вперемешку с реальными клавишами сюда же прилетают
    // автоответы эмулятора xterm.js (см. hasRealUserInput() выше, Important 2
    // ревью фикс-раунда 1). Если пользователь сам перехватил вкладку после
    // остановки по лимиту, ядро не должно позже вбросить туда «продолжай»
    // поверх его ручного ввода (processResumeTab в night-watch.js сверяет
    // lastInputAt с моментом детекта) — но голый автоответ терминала не
    // должен считаться таким перехватом.
    if (nightWatch && hasRealUserInput(data)) nightWatch.onUserInput(tabId);
  });

  ipcMain.on('term:resize', (_e, payload) => {
    if (!payload || typeof payload !== 'object') return;
    const { tabId, cols, rows } = payload;
    if (typeof tabId !== 'string') return;
    if (!validDim(cols) || !validDim(rows)) return;
    manager.resize(tabId, cols, rows);
  });

  // Task 1 фазы 7 (очередь промптов): fire-and-forget, тот же приём, что
  // term:write/term:restart выше — состояние возвращается отдельным событием
  // (queue:changed, генерируется sessions.js и уходит через generic onEvent
  // в начале registerIpc), синхронный ответ invoke() здесь не нужен.
  ipcMain.on('queue:add', (_e, payload) => {
    if (!payload || typeof payload !== 'object') return;
    const { tabId, text } = payload;
    if (typeof tabId !== 'string' || typeof text !== 'string') return;
    manager.enqueue(tabId, text);
  });

  ipcMain.on('queue:remove', (_e, payload) => {
    if (!payload || typeof payload !== 'object') return;
    const { tabId, index } = payload;
    if (typeof tabId !== 'string' || !Number.isInteger(index)) return;
    manager.removeFromQueue(tabId, index);
  });

  ipcMain.on('queue:clear', (_e, payload) => {
    if (!payload || typeof payload !== 'object') return;
    const { tabId } = payload;
    if (typeof tabId !== 'string') return;
    manager.clearQueue(tabId);
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
  // Task 2 фазы 8 («Ночная смена»): dispose() снимает ВСЕ таймеры ядра
  // (ожидание/ретрай + хвост стаггера) и гасит powerSaveBlocker, если он был
  // включён, — без этого приложение могло бы выйти с реально удерживаемым
  // системным блокером энергосбережения (см. night-watch.js/dispose()).
  // Идемпотентно (как и остальные вызовы этой функции) — disposeSessions()
  // зовётся несколько раз за один выход (window-all-closed, потом before-quit).
  if (nightWatch) nightWatch.dispose();
  stopBridge();
  if (manager) manager.disposeAll();
  // Задача 5 фазы 6 (carryover): если приложение закрывается, пока
  // runCcusage/gitRun/ghRun ещё выполняются (npx/git/gh), реестр процессов
  // runners.js всё ещё держит их — killAllTracked() добивает ДЕРЕВО
  // принудительно (/T /F — headless-помощники без состояния, не сам кокпит;
  // подробное обоснование /F и снимка ключей в массив ДО цикла — в runners.js).
  if (runners) runners.killAllTracked();
}

module.exports = {
  registerIpc, disposeSessions, stopBridge, getSmokeOutput, flushWorkspace, getActiveTabId,
  // Экспортированы ТОЛЬКО ради test/ipc-smoke-gate.test.js (п.4 брифа задачи 5
  // фазы 7 + «дыра тестов №1», ревью финальной волны, см. комментарии у их
  // определения выше) — не часть публичного API модуля для остального кода.
  gitGetHandler, ghRepoHandler, ghGlobalHandler,
  historySearchHandler, historyRefreshHandler, createHistoryIndexState, HISTORY_INDEX_TTL_MS,
  recipesListHandler, recipesSavePromptHandler, recipesDeletePromptHandler,
  recipesListWorkspacesHandler, recipesSaveWorkspaceHandler, recipesDeleteWorkspaceHandler,
  // Task 2 фазы 8 («Ночная смена»): та же причина — см. комментарий у их
  // определения выше.
  nightToggleHandler, nightGetHandler,
  // Important 2 (ревью фикс-раунд 1, Task 2 фазы 8): чистая функция без
  // Electron — экспортирована ради собственного юнит-теста (см. комментарий
  // у определения выше).
  hasRealUserInput,
};
