'use strict';
// Все IPC-каналы. PTY-парк живёт в sessions.js; ipc — тонкий адаптер.

const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');
const readline = require('readline');
const { execFile, spawn } = require('child_process');
const { EventEmitter } = require('events');
const {
  ipcMain, shell, dialog, app, clipboard, powerSaveBlocker,
} = require('electron');
const { createCommandRegistry } = require('./command-registry');
const { createBroadcast } = require('./broadcast');
const { createOutputBuffer } = require('./output-buffer');
const { createNetServer } = require('./net-server');
const { createOwnership } = require('./ownership');
const { listDir, listDrives } = require('./fs-browse');
const { isWriteChannel } = require('./write-channels');
const { getConfig, setConfig } = require('./config');
const { createPty } = require('./pty');
const { createSessionManager } = require('./sessions');
const { createHookBridge } = require('./hook-bridge');
const { connectProject, isConnected } = require('./connector');
const { notify } = require('./notify');
const { createNightWatch } = require('./night-watch');
const { createSessionTitleReader, createFsReadParts } = require('./session-title');
const { createNightJournal, NIGHT_JOURNAL_MAX_ENTRIES } = require('./night-journal');
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
const { createStt } = require('./stt');

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
let ipcBootAt = 0;                 // Date.now() момента registerIpc — окно cacheOnly для ccusage (инцидент 8ГБ, см. usage:get)
const CCUSAGE_BOOT_DEFER_MS = 90000;
let deferredSpendTimer = null;     // отложенный пересчёт расходов на границе boot-окна (N1 ре-ревью: гасится в disposeSessions, как usageMonitorTimer)
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
// Task 2 фазы 9 (голосовой ввод): инстанс createStt (stt.js, Task 1) —
// создаётся при ПЕРВОМ реальном обращении к stt:transcribe/status
// (getOrCreateStt() ниже), НЕ при registerIpc.
// M2 (ревью финальной волны): «ленивый» здесь описывает конструктор JS-
// объекта, а НЕ подъём whisper-server.exe — Task 3 (renderer) зовёт
// stt:status() уже в boot() (см. app.js/refreshSttStatus), так что ЭТОТ
// инстанс на практике создаётся почти сразу при старте кокпита, а не
// «только если голосом воспользовались». Единственное, что остаётся
// по-настоящему ленивым — сам СЕРВЕРНЫЙ ПРОЦЕСС (ensureServer() внутри
// stt.js): резолв корней стека/спавн whisper-server.exe откладывается до
// первого РЕАЛЬНОГО transcribeWav(), status() его не трогает вовсе.
let stt = null;

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

// I2 (ревью финальной волны фазы 8): взведённый ДНЁМ режим ночной смены —
// пачка Stop'ов (200+ ходов за рабочий день) звала бы usagePoller.refresh()
// на КАЖДЫЙ, мимо уже существующей MANUAL_REFRESH_MIN_INTERVAL_MS (та
// защищает только ручной IPC-путь 'usage:refresh') — риск 429 → 10-минутный
// stale-бэкофф поллера → настоящий лимит-стоп посреди ночи получает
// no-usage-data и не продолжается. 60с — заметно короче, чем «пользователь
// упирается в лимит снова» (обычно часы), но с запасом переживает несколько
// Stop подряд за секунды (типичная работа нескольких вкладок).
const USAGE_SNAPSHOT_FRESH_MS = 60000;

// Решает, можно ли обойтись уже имеющимся снапшотом поллера вместо похода в
// сеть — чистая функция ради тестируемости (ipc.js целиком не тестируется).
// Свежий снапшот — это ok:true, НЕ stale, и не старше USAGE_SNAPSHOT_FRESH_MS
// (fetchedAt). Критичный момент (тот же довод, что Critical 2 у night-watch.js
// про stale:true): протухший/битый снапшот НИКОГДА не считается «достаточно
// свежим», даже если formально не старше по времени, — иначе консервативный
// принцип «ложное продолжай хуже пропущенного» получил бы дыру именно там,
// где его больше всего ждут (детект лимита).
function isSnapshotFreshEnough(snapshot, nowMs) {
  return !!snapshot && snapshot.ok === true && snapshot.stale !== true
    && typeof snapshot.fetchedAt === 'number'
    && (nowMs - snapshot.fetchedAt) < USAGE_SNAPSHOT_FRESH_MS;
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
// I1(а) (ревью финальной волны фазы 8): тот же кольцевой потолок, что у
// реального night-journal.js (NIGHT_JOURNAL_MAX_ENTRIES) — арминг в smoke
// вообще недостижим (nightToggleHandler гейтит `if (smoke) return null;`
// раньше, чем коснётся nightWatch), но нет смысла заводить ДВА разных
// поведения на случай, если это когда-нибудь изменится.
function createInMemoryNightJournal() {
  let entries = [];
  return {
    append(e) {
      entries.push(e);
      if (entries.length > NIGHT_JOURNAL_MAX_ENTRIES) entries = entries.slice(-NIGHT_JOURNAL_MAX_ENTRIES);
    },
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

// M4 финального ревью (обязательно, п.3 брифа этой волны): детект-замыкание
// в onEvent — раньше жило прямо инлайном внутри createSessionManager({onEvent})
// и было непокрыто тестами (ipc.js целиком не тестируется). Вынесено в чистую
// функцию с явными параметрами: prev — значение ИЗ КАРТЫ lastStatusByTab ДО
// её обновления (см. комментарий у объявления карты выше), payload — объект
// события 'tab:status' целиком (несёт status и genProven, см. sessions.js/
// applyHookEvent/case 'Stop').
//
// Minor 1 (ревью фикс-раунда 1): 'stuck' считается наравне с 'working' — ядро
// (night-watch.js/NO_RESUME_STATUSES) уже трактует 'stuck' как полностью
// резюмируемый статус на пробуждении, детект обязан быть симметричен:
// вкладку могло пометить checkStuck() (>5 мин без вывода — типичная картина,
// пока Claude висит на исчерпанном лимите) НЕПОСРЕДСТВЕННО перед самим
// Stop-хуком, она всё ещё реально «работала».
//
// Important 1 (ревью фикс-раунда 1): genProven===true — единственное
// доказательство, что working→done принадлежит СВОЕЙ (кокпитной) сессии, а
// не стороннему процессу той же сессии вне кокпита (маршрутизация по
// session_id без COCKPIT_TAB_GEN, заявленная фича port-file — см. I4 фазы 7).
function shouldDetectLimitStop(prev, payload) {
  if (!payload || payload.status !== 'done') return false;
  if (payload.genProven !== true) return false;
  return prev === 'working' || prev === 'stuck';
}

// C1 (Critical, ревью финальной волны фазы 8): getTabStatus-адаптер для
// createNightWatch({getTabStatus}) — маппинг «сырого» пятистатусного статуса
// sessions.js в то, что ядро понимает как «резюмируемо». Claude Code шлёт хук
// Notification и на idle_prompt («жду вашего ввода», раз в ~60с без фокуса
// терминала), и на permission_prompt («нужно разрешение») — ОБА приходят как
// статус 'waiting' (sessions.js их не различал вовсе до этого фикса, см.
// classifyNotification() в sessions.js). Без различения ЛЮБОЙ 'waiting' на
// пробуждении считался бы непродолжаемым диалогом (NO_RESUME_STATUSES
// ядра) — вкладка, простоявшая ночь в idle_prompt (терминал не в фокусе),
// НИКОГДА не продолжилась бы, хотя ждать там было нечего, кроме
// собственного idle-пинга CLI. waitingKind==='idle' → мапим в 'done'
// (резюмируемый статус, симметричный обычному завершению задачи); permission
// (или что угодно иное) — статус остаётся как есть, 'waiting' по-прежнему в
// NO_RESUME_STATUSES ядра.
function resumableTabStatus(rawStatus, waitingKind) {
  if (rawStatus === 'waiting' && waitingKind === 'idle') return 'done';
  return rawStatus;
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
            // «вкладок продолжено: N» — формулировка без склонения по числу:
            // pluralTabs живёт в renderer (ESM format.js) и в main не
            // импортируется, а «продолжил 1 вкладок» неграмотно (тот же
            // класс, что M5 ревью Task 3, только в main-процессе).
            if (n > 0) notify(`Ночная смена: вкладок продолжено — ${n}`, 'info');
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

// --- Task 2 фазы 9 (голосовой ввод): реальные зависимости для createStt
// (stt.js, Task 1, чистое ядро — spawnProc/httpGet/httpPost/registerProcess
// только инжектируются, сам модуль ни child_process, ни http не видит).
// Контракты каждой зависимости — блок в шапке createStt (src/main/stt.js,
// «=== Контракты инжектируемых эффектов ===») — реализации ниже сверены с
// ними построчно (явное наблюдение ревьюера Task 1, леджер фазы).

// spawnProc(exe, args) → child-подобный объект, НЕ бросает наружу (ни
// синхронно, ни необработанным асинхронным 'error'). stdio:'ignore' —
// ОБЯЗАТЕЛЬНО контрактом ядра: непрочитанный пайп (дефолтный stdio:'pipe')
// переполняется через сотни запросов (буфер ~64КБ) и вешает whisper-server
// посреди инференса — нам нечего читать из stdout/stderr сервера, поэтому
// просто игнорируем оба потока целиком. windowsHide — не мелькать консольным
// окном. Провал старта (ENOENT — нет такого бинарника, бекенд не собран)
// приходит АСИНХРОННО как событие 'error' — без подписки это необработанное
// исключение уронило бы весь main-процесс; ядро (stt.js) само 'error' не
// слушает по контракту, обработка целиком здесь. Молчаливое поглощение (лог
// и всё) — так и задумано: провал старта проявится ядру как таймаут
// готовности (READY_TIMEOUT_MS), это штатный путь перебора бекендов CUDA→CPU.
// Кольцевой буфер последних строк вывода whisper-server (боевой инцидент
// живой приёмки фазы 9 + бэклог Minor-6 Task 2): со stdio:'ignore' сервер
// умирал молча, и «read ECONNRESET» было единственной уликой. Пайпим оба
// потока и ДРЕНИРУЕМ построчно в кольцо (контракт ядра требует именно «не
// оставлять непрочитанных пайпов» — дренаж явно разрешён наравне с ignore).
// Хвост кольца печатается в консоль при провале распознавания.
const STT_LOG_RING_MAX = 40;
const sttServerLog = [];
function pushSttServerLine(line) {
  const t = String(line).trimEnd();
  if (!t) return;
  sttServerLog.push(t);
  if (sttServerLog.length > STT_LOG_RING_MAX) sttServerLog.splice(0, sttServerLog.length - STT_LOG_RING_MAX);
}
function sttServerLogTail(n = 15) {
  return sttServerLog.slice(-n);
}

function sttSpawnProc(exe, args) {
  const isServer = /whisper-server\.exe$/i.test(exe);
  let child;
  try {
    // Для whisper-server — пайпы под кольцо диагностики; для taskkill и
    // прочей мелочи — ignore, как раньше (их вывод не нужен, а пайпы там
    // никто не дренировал бы).
    child = spawn(exe, args, {
      stdio: isServer ? ['ignore', 'pipe', 'pipe'] : 'ignore',
      windowsHide: true,
    });
  } catch (err) {
    // Синхронный бросок — на практике недостижимо для фиксированных путей и
    // литеральных args этого модуля (ENOENT у spawn всегда асинхронный), но
    // контракт ядра требует «НЕ бросает наружу» безусловно — возвращаем
    // НЕМУЮ EventEmitter-заглушку.
    //
    // Important-1 (ревью Task 2): НИКАКОГО emit('error') на заглушке —
    // ядро по контракту 'error' не слушает, а EventEmitter при emit('error')
    // БЕЗ слушателя бросает → uncaughtException → main.js гасит весь кокпит
    // со всеми вкладками (живая проба ревьюера). Немая заглушка → ядро
    // дойдёт до таймаута готовности и переберёт следующий бекенд — ровно
    // штатный путь провала старта. Ошибку логируем здесь и сразу.
    console.warn(`[stt] spawn ${exe} бросил синхронно: ${err.message}`);
    const stub = new EventEmitter();
    stub.pid = 0; // String(0) в контрольном taskkill даёт мгновенный отказ, а не «/PID undefined»
    stub.kill = () => {};
    return stub;
  }
  child.on('error', (err) => {
    console.warn(`[stt] spawn ${exe} упал: ${err.message}`);
  });
  if (isServer) {
    // Дренаж обоих потоков в кольцо: построчно, с добивкой хвоста без \n.
    const wire = (stream) => {
      if (!stream) return;
      let acc = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        acc += chunk;
        // Одиночный \r тоже разделитель (Minor-2 ревью инцидент-фикса):
        // прогресс-строки whisper идут через \r без \n — без этого acc
        // копил мегабайты, а кольцо оставалось пустым.
        const lines = acc.split(/\r\n|\n|\r/);
        acc = lines.pop();
        for (const line of lines) pushSttServerLine(line);
        // Потолок на недобитую строку: поток вообще без разделителей не
        // должен раздувать память — сбрасываем как строку.
        if (acc.length > 8192) {
          pushSttServerLine(acc);
          acc = '';
        }
      });
      stream.on('end', () => pushSttServerLine(acc));
      stream.on('error', () => {});
    };
    wire(child.stdout);
    wire(child.stderr);
    child.on('exit', (code, signal) => {
      pushSttServerLine(`[exit] code=${code} signal=${signal}`);
    });
  }
  return child;
}

// httpGet(port, path, timeoutMs) → Promise<{status}> — РЕЗОЛВ на ЛЮБОЙ
// завершённый HTTP-ответ (даже 404/500 — whisper-server на некоторых сборках
// отвечает не-200 на голый GET /, критерий готовности «порт слушает», а не
// «ответил 200»), REJECT ТОЛЬКО на сетевой сбой/таймаут (Important-3, ревью
// Task 1 — расхождение здесь молча ломает ready-поллинг на части сборок).
// Тело ответа не нужно — res.resume() сливает поток, чтобы сокет освободился
// сразу, а не висел до собственного таймаута незаконченного потока.
function sttHttpGet(port, urlPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: '127.0.0.1', port, path: urlPath, timeout: timeoutMs,
    }, (res) => {
      res.resume();
      // Minor-2 (ревью Task 2): обрыв сокета ПОСЛЕ резолва — ошибка уже
      // никому не нужна, но без слушателя на res она может стать
      // необработанной (симметрия с POST-веткой ниже).
      res.on('error', () => {});
      resolve({ status: res.statusCode });
    });
    req.on('timeout', () => {
      req.destroy(new Error(`stt httpGet: таймаут ${timeoutMs}мс`));
    });
    req.on('error', reject);
  });
}

// httpPost(port, path, headers, bodyBuffer, timeoutMs) → Promise<{status,
// body:Buffer}> — тот же принцип: резолв на ЛЮБОЙ код (код разбирает
// postInference() внутри stt.js), reject только сеть/таймаут.
function sttHttpPost(port, urlPath, headers, bodyBuffer, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: urlPath, method: 'POST', headers, timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => {
      req.destroy(new Error(`stt httpPost: таймаут ${timeoutMs}мс`));
    });
    req.on('error', reject);
    req.write(bodyBuffer);
    req.end();
  });
}

// Живая приёмка 01.08: чтение начала и конца транскрипта (два источника
// «названия» сессии — ai-title в начале, custom-title от `/rename` в конце)
// переехало в session-title.js с инжектируемым fs. Minor 1 ревью: здесь эта
// функция была недостижима для тестов — все они ходили через стаб — и именно
// в ней пряталась дыра «мёртвого окна» размеров (Critical 1). Там она теперь
// покрыта тестами на настоящем временном файле.
const sessionTitleReader = createSessionTitleReader({ readParts: createFsReadParts(fs) });

// Геттер инстанса createStt — создаёт JS-объект при ПЕРВОМ реальном
// обращении к stt:transcribe/status (через sttTranscribeHandler/
// sttStatusHandler ниже), НЕ при registerIpc. M2 (ревью финальной волны):
// см. подробное уточнение у `let stt = null;` выше — этот геттер выполняется
// уже в рамках boot() (Task 3 зовёт stt:status() сразу при старте окна), так
// что «лениво» здесь — ТОЛЬКО про резолв корней стека/спавн сервера внутри
// самого createStt (ensureServer()), не про момент создания этого объекта.
function getOrCreateStt() {
  if (stt) return stt;
  // Minor-4/5 (ревью Task 2): восстановление секции при `"stt": null` и
  // вычисляемый дефолт stackRoots теперь живут в config.js (пост-merge патчи
  // рядом с terminal.cwd) — ключ виден пользователю через config:get, и тост
  // «см. stt.stackRoots в конфиге» ссылается на реально существующее поле.
  // `|| {}` остаётся последним ремнём на случай будущих правок config.js.
  const config = getConfig().stt || {};
  stt = createStt({
    spawnProc: sttSpawnProc,
    httpGet: sttHttpGet,
    httpPost: sttHttpPost,
    fs,
    now: Date.now,
    // unref — тот же приём, что у nightWatch/usageMonitorTimer выше: таймеры
    // ready-поллинга не должны сами по себе держать процесс живым.
    setTimer: (fn, ms) => {
      const id = setTimeout(fn, ms);
      if (id.unref) id.unref();
      return id;
    },
    clearTimer: (id) => clearTimeout(id),
    // Реестр процессов runners.js (Task 5 carryover фазы 6) — тот же, что для
    // npx/git/gh: trackChild() вешает СВОЙ once('exit') для уборки
    // liveChildren (killProcessTree/killAllTracked на выходе кокпита), ядро
    // (stt.js/killProc, B3 ревью Task 1) снимает точечно только СВОЙ
    // exit-хендлер и гарантированно переживает это (реестр — тот же самый,
    // не отдельная копия).
    // M5 (ревью финальной волны): trackChild() сам проверяет только
    // `typeof child.pid === 'number'` — pid:0 (falsy, но typeof 'number')
    // прошёл бы эту проверку и лёг бы в liveChildren по ключу 0, засоряя
    // реестр записью, которую killAllTracked не сможет осмысленно убить
    // (taskkill /PID 0 бьёт не по тому процессу). Гард здесь, а не в самом
    // runners.js — trackChild общий для gh/git/npx, трогать его контракт
    // ради одного вызывающего лишнее.
    registerProcess: (child) => {
      if (child && child.pid) runners.trackChild(child);
    },
    config,
    log: (msg) => console.warn(msg),
  });
  return stt;
}

// stt:transcribe — ArrayBuffer/Uint8Array WAV → Buffer → stt.transcribeWav() →
// {text} при успехе, {error: string} при ЛЮБОМ провале (невалидный формат
// входа, отказ ядра — стек не найден/оба бекенда не поднялись/двойной провал
// /inference) — НИКОГДА reject: renderer (Task 3) показывает тост по полю
// error, а не оборачивает invoke() в try/catch. Смоук-гейт — ДО обращения к
// getStt() вообще, тем же приёмом, что gitGetHandler/nightToggleHandler выше:
// headless-прогон не должен резолвить корни стека/трогать fs ради голоса.
// Экспортирована ради test/ipc-smoke-gate.test.js (паттерн gitGetHandler).
async function sttTranscribeHandler({ smoke, wav, getStt }) {
  if (smoke) return { error: 'smoke' };
  let buf;
  if (wav instanceof ArrayBuffer) {
    buf = Buffer.from(wav);
  } else if (ArrayBuffer.isView(wav)) {
    // Uint8Array (Buffer — тоже Uint8Array) — байты как есть, без
    // копирования лишнего диапазона (учитываем byteOffset/byteLength).
    buf = Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength);
  } else {
    return { error: 'stt: неверный формат WAV (ожидался ArrayBuffer/Uint8Array)' };
  }
  try {
    const text = await getStt().transcribeWav(buf);
    return { text };
  } catch (err) {
    // Боевой инцидент фазы 9: до кольцевого буфера сервер умирал молча —
    // печатаем его последние строки, диагноз виден прямо в консоли запуска.
    const tail = sttServerLogTail();
    if (tail.length) {
      console.warn(`[stt] распознавание упало; последние строки whisper-server:\n  ${tail.join('\n  ')}`);
    }
    return { error: err && err.message ? err.message : String(err) };
  }
}

// stt:status — просто snapshot ядра {available, backend, warm}. НИКАКОГО
// ensureServer()/прогрева отсюда намеренно не зовём (наблюдение ревьюера
// Task 1, леджер фазы: pendingReject/pollTimerId — одиночные слоты в ядре;
// отдельный прогревающий вызов мимо transcribeWav — риск, которого ни бриф,
// ни спека не просят). Смоук-гейт отдаёт ту же форму ответа, что дал бы
// реальный status() при отсутствующем стеке, но БЕЗ создания инстанса —
// getStt() в smoke не зовётся вовсе.
function sttStatusHandler({ smoke, getStt }) {
  if (smoke) return { available: false, backend: null, warm: false };
  // Minor-3 (ревью Task 2): getStt()/status() вне try раньше могли реджектнуть
  // IPC-канал вопреки правилу «наружу не бросаем» — деградируем к «недоступен».
  try {
    return getStt().status();
  } catch (err) {
    console.warn(`[stt] status упал: ${err && err.message}`);
    return { available: false, backend: null, warm: false };
  }
}

// Important 1 (ревью задачи 4): наполнение output-buffer.js на term:data и
// очистка на tabs:close жили ИНЛАЙНОМ прямо внутри onEvent/tabs:close —
// ревьюер вырезал обе строки и прогнал полный набор: 784 теста, 0 падений.
// Смысл задачи 4 — не модуль output-buffer.js сам по себе (он покрыт), а
// именно эти две точки проводки: без них подключившийся клиент видит пустой
// терминал, и НИЧТО в тестах этого не замечает. Та же причина, что у
// gitGetHandler/nightToggleHandler/sttStatusHandler и т.д. выше (ipc.js
// целиком/registerIpc не тестируется под node --test — require('electron')
// вне настоящего рантайма не даёт объект): логика вынесена в отдельные
// функции с явными зависимостями, registerIpc() ниже просто зовёт их с
// реальным outputBuffer — это ТА ЖЕ функция, что исполняется в проде, не
// копия для теста. См. test/ipc-output-buffer-wiring.test.js.
function bufferTermData({ channel, payload, outputBuffer }) {
  if (channel === 'term:data' && payload) outputBuffer.push(payload.tabId, payload.data);
}

function dropTabOutputBuffer({ tabId, outputBuffer }) {
  outputBuffer.drop(tabId);
}

// Эстафета: у pty один размер на всех, поэтому терминал подгоняется под того,
// кто сейчас за рулём, — один раз, в момент пересадки. Все вкладки рисуются в
// одну и ту же область окна, значит и размер у них общий: подогнать только
// активную — оставить остальные в чужой раскладке.
//
// Кривой размер ХУЖЕ прежнего: ConPTY на нулевых колонках ломает перерисовку
// Claude Code. Вынесена наружу ради собственного теста (тот же приём, что у
// bufferTermData выше) — см. test/ipc-handoff-wiring.test.js.
// Поле называется tabId — так его отдаёт manager.list() (sessions.js). Здесь
// стояло tab.id, то есть undefined на каждой вкладке: переразмер при пересадке
// не срабатывал НИ РАЗУ с самого появления эстафеты, и держалось это на тесте,
// который кормил функцию фикстурой {id: 'T1'} — формой, которой в проде нет.
// Живой замер (09.08): фоновая вкладка после возврата руля оставалась в
// размере ушедшего клиента (140 колонок при окне на 105), чинилась только
// переключением на неё — ResizeObserver в terminal.js слал term:resize сам.
function applyHandoffSize({ manager, size }) {
  if (!size || !(size.cols > 0) || !(size.rows > 0)) return;
  for (const tab of manager.list()) manager.resize(tab.tabId, size.cols, size.rows);
}

// Вся проводка эстафеты одним куском: владение + гард записи. Вынесена из
// registerIpc НЕ ради красоты — ревью показало, что непокрытая проводка
// исчезает бесследно: семь мутаций подряд (гард пускает всех, переразмер
// убран, события не рассылаются, ownership не доезжает до сетевого сервера)
// оставляли все 918 тестов зелёными. Здесь она зовётся тем же кодом, что и в
// проде, и проверяется напрямую — см. test/ipc-handoff-wiring.test.js.
//
// Побочные эффекты обёрнуты поштучно: на локальном пути claim прилетает из
// обработчика клика по значку в трее, и любое исключение оттуда попадает в
// process.on('uncaughtException') → app.exit(1). Клик по трею не имеет права
// убивать приложение, а сбой одного эффекта — глушить остальные.
function createHandoffWiring({ manager, broadcast, onOwnerChange }) {
  const safely = (what, fn) => {
    try {
      fn();
    } catch (err) {
      console.warn(`[эстафета] ${what}: ${err && err.message}`);
    }
  };

  const ownership = createOwnership({
    onChange: ({ owner, size }) => {
      safely('переразмер терминала', () => applyHandoffSize({ manager, size }));
      safely('рассылка смены владельца', () => broadcast.emit('owner:changed', { owner, online: ownership.ownerOnline() }));
      safely('уведомление окна', () => {
        if (typeof onOwnerChange === 'function') onOwnerChange(owner);
      });
    },
    // Пропал со связи или вернулся — владельца не меняем, окно не трогаем,
    // но клиенты и трей обязаны это показать.
    onPresence: ({ owner, online }) => {
      safely('рассылка присутствия', () => broadcast.emit('owner:changed', { owner, online }));
    },
  });

  // Чтение доступно всем — иначе заглушка на неактивной машине была бы слепой.
  // Запись только владельцу. Оба транспорта приходят сюда, путей в обход нет.
  const guard = ({ channel, who }) => !isWriteChannel(channel) || ownership.canWrite(who);

  return { ownership, guard };
}

// M1 (ревью раунда 2 задачи 7, Important 1): без аутентификации в этой фазе
// адрес прослушивания сетевого сервера — ЕДИНСТВЕННАЯ линия обороны кокпита
// (иначе сервер видел бы любой человек в том же вайфае и мог бы выполнять
// произвольные команды через реестр — запись в терминал в том числе). Разбор
// секции net вынесен из инлайна в registerIpc() в отдельную чистую функцию
// той же причиной, что у bufferTermData/dropTabOutputBuffer выше: до этого
// фикса живая проверка ревьюера подменила дефолт host на '0.0.0.0' ПРЯМО В
// ИСТОЧНИКЕ (`typeof netCfg.host === 'string' && netCfg.host ? netCfg.host :
// '0.0.0.0'`) и весь набор — 828 тестов — остался зелёным: ни один тест не
// трогал именно эту строку. Дефолты — константы модуля, а не литералы
// внутри функции: тест на пустой конфиг (см. test/ipc-net-boot.test.js)
// сравнивает результат с ЛИТЕРАЛОМ '127.0.0.1'/48300, а не с этой
// константой — иначе изменение константы и тест сдвинулись бы синхронно, и
// красноты не было бы никогда.
const NET_DEFAULT_HOST = '127.0.0.1';
const NET_DEFAULT_PORT = 48300;

// Корни статики сетевого сервера: URL-префикс → каталог на диске. Вынесено из
// registerIpc() отдельной чистой функцией (root — параметр, а не appRoot()
// внутри) РАДИ ТЕСТА: appRoot() требует живого Electron, а
// test/renderer-boot-guard.test.js поднимает настоящий сервер на этой самой
// карте и дёргает каждую ссылку разметки — так «корень /node_modules убрали»
// и «.js отдают как text/plain» становятся красными, а не зелёными (I1
// финального ревью: обе диверсии проходили мимо 856 тестов).
//
// Состав ровно такой, потому что разметка renderer НЕ правится под сеть:
// index.html ссылается на ../../node_modules/@xterm/..., css/fonts.css — на
// ../../../assets/fonts/... Браузер схлопывает '..' сам ещё до отправки, и на
// провод уходят /node_modules/... и /assets/... — эти два префикса и корень
// '/' на src/renderer покрывают всё дерево страницы.
function rendererStaticRoots(root) {
  return {
    '/node_modules': path.join(root, 'node_modules'),
    '/assets': path.join(root, 'assets'),
    '/': path.join(root, 'src', 'renderer'),
  };
}

// M3 (ревью раунда 2, Minor): порт в диапазоне 1..65535, целое число.
function validPort(n) {
  return Number.isInteger(n) && n > 0 && n < 65536;
}

// netCfg — сырая секция getConfig().net (может отсутствовать, быть null,
// нести мусор — пользователь правит config.user.json руками). warn —
// инжектируемый логгер (по умолчанию console.warn), тем же приёмом, что
// usagePoller/ccusage выше по файлу — тесты подставляют свой сборщик вместо
// реального console.warn.
//
// M3 (ревью раунда 2, Minor): port принимается и числом (обычный путь из
// config:set/JSON.parse), и строкой — `"port": "48377"` в config.json,
// написанное рукой, раньше молча откатывалось к дефолту, а стучаться
// пытались бы в порт, который сервер не слушает. Строка приводится к числу,
// если результат — целое в допустимом диапазоне (с предупреждением, что
// применили именно так); иначе — предупреждение и дефолт. host обязан быть
// непустой строкой; любое другое значение (число, объект, пустая строка) —
// тоже предупреждение и дефолт, без падения (кокпит обязан подняться на
// дефолте, а не рухнуть на TypeError из-за опечатки в чужом конфиге).
function resolveNetConfig(netCfg, warn = (msg) => console.warn(msg)) {
  const cfg = netCfg && typeof netCfg === 'object' ? netCfg : {};

  let host = NET_DEFAULT_HOST;
  if (cfg.host !== undefined) {
    if (typeof cfg.host === 'string' && cfg.host.trim()) {
      host = cfg.host;
    } else {
      warn(`[net] host в конфиге некорректен (${JSON.stringify(cfg.host)}), использую ${NET_DEFAULT_HOST}`);
    }
  }

  let port = NET_DEFAULT_PORT;
  if (cfg.port !== undefined) {
    if (validPort(cfg.port)) {
      port = cfg.port;
    } else if (typeof cfg.port === 'string' && validPort(Number(cfg.port))) {
      port = Number(cfg.port);
      warn(`[net] port в конфиге задан строкой ("${cfg.port}"), использую как число ${port}`);
    } else {
      warn(`[net] port в конфиге некорректен (${JSON.stringify(cfg.port)}), использую ${NET_DEFAULT_PORT}`);
    }
  }

  // allowedHosts (соседняя задача, фикс DNS-rebinding в net-server.js,
  // раунд 4): доп. имена для белого списка Host — к машине приходят и по
  // адресу, и по DNS-имени тайлнета одновременно, а host выше хранит
  // обычно только одно из двух. Разбор не мягче, чем у host/port выше: не
  // массив — откат к пустому с предупреждением; элементы не строки или
  // пустые строки — отбрасываются по одному, тоже с предупреждением
  // (называющим конкретный отброшенный элемент, не просто «что-то не так»).
  // Валидные элементы не проверяются на формат имени/IP — net-server.js сам
  // сравнивает их с заголовком Host регистронезависимо, лишний формальный
  // барьер здесь просто отсеивал бы легитимные варианты записи.
  let allowedHosts = [];
  if (cfg.allowedHosts !== undefined) {
    if (Array.isArray(cfg.allowedHosts)) {
      const clean = [];
      for (const item of cfg.allowedHosts) {
        if (typeof item === 'string' && item.trim()) {
          clean.push(item);
        } else {
          warn(`[net] allowedHosts содержит некорректный элемент (${JSON.stringify(item)}) — отброшен`);
        }
      }
      allowedHosts = clean;
    } else {
      warn(`[net] allowedHosts в конфиге некорректен (${JSON.stringify(cfg.allowedHosts)}), использую []`);
    }
  }

  return { host, port, allowedHosts };
}

// M2 (ревью раунда 2, Important 2): раньше сбой netServer.start() ТОЛЬКО
// логировался в консоль, которую никто не видит при автозапуске ярлыком —
// самый вероятный сценарий живой приёмки: кокпит стартует РАНЬШЕ, чем
// Tailscale поднял свой интерфейс на этом ПК, адрес из конфига физически ещё
// не существует, start() падает с EADDRNOTAVAIL, и без повторов сервер не
// слушает уже НИКОГДА за всю жизнь процесса — с макбука это выглядит как
// «сайт не открывается», а на ПК ничем не выражено. Ограниченные повторы
// дают интерфейсу время подняться (типичный boot-race), но НЕ лечат
// постоянную недоступность порта (EADDRINUSE — задача 6 уже сделала его
// безопасным для процесса, но повтором его не решить: порт останется занят
// и после паузы, кокпит доберёт лимит попыток и всё равно уведомит).
//
// setTimer — инжектируемая обёртка над setTimeout, тот же приём, что у
// createNightWatch({setTimer}) в этом же файле (см. registerIpc ниже) —
// test/ipc-net-boot.test.js использует фейковый реестр таймеров вместо
// реального времени, той же формы, что уже применена в night-watch.test.js.
const NET_START_RETRY_MS = 5000;
const NET_START_MAX_RETRIES = 6; // ~30с суммарно — с запасом переживает типичный boot-race с поднятием интерфейса Tailscale

function startNetServerWithRetries({
  start, host, port, notify: notifyFn, setTimer = setTimeout,
  retryMs = NET_START_RETRY_MS, maxRetries = NET_START_MAX_RETRIES, attempt = 0,
}) {
  return start().then(
    () => {
      // M4 (ревью раунда 2, Minor): для фичи, весь смысл которой «набери
      // этот адрес на другом устройстве», адрес обязан появиться в логе —
      // это первое, что человек будет искать. Печатается ТОЛЬКО на успех.
      console.log(`[net] слушаю http://${host}:${port}`);
      return true;
    },
    (err) => {
      if (attempt < maxRetries) {
        console.log(`[net] сервер не поднялся на ${host}:${port} (${err.message}) — повтор ${attempt + 1}/${maxRetries} через ${Math.round(retryMs / 1000)}с`);
        return new Promise((resolve) => {
          const id = setTimer(() => {
            resolve(startNetServerWithRetries({
              start, host, port, notify: notifyFn, setTimer, retryMs, maxRetries, attempt: attempt + 1,
            }));
          }, retryMs);
          if (id && typeof id.unref === 'function') id.unref();
        });
      }
      // Тем же каналом, что «config.json повреждён — работаю на дефолтах» в
      // main.js: человек должен узнать о проблеме ОТ КОКПИТА, а не по
      // неоткрывающейся странице на другом устройстве.
      console.log(`[net] сдаюсь после ${maxRetries + 1} попыток: ${err.message}`);
      notifyFn(`Сетевой сервер кокпита не поднялся на ${host}:${port} (${err.message}). Локальное окно работает, удалённый доступ недоступен.`, 'error');
      return false;
    },
  );
}

function registerIpc(win, opts = {}) {
  const {
    smoke = false, attention = null, toaster = null,
    // Смена владельца управления: main.js прячет и показывает по нему окно и
    // перерисовывает трей. Необязателен — без него эстафета работает, просто
    // окно никуда не девается (так ведут себя тесты и smoke).
    onOwnerChange = null,
  } = opts;
  ipcBootAt = Date.now(); // окно cacheOnly для ccusage — см. usage:get (инцидент 8ГБ)

  // Рассылка исходящих событий (broadcast.js) — симметричная половина
  // реестра команд ниже: реестр сводит ВХОДЯЩИЕ команды в одну точку,
  // broadcast — ИСХОДЯЩИЕ события. Объявлена здесь, В САМОМ НАЧАЛЕ функции
  // (ре-ревью задачи 3, мелочь): manager/nightWatch чуть ниже уже держат
  // замыкания, которые зовут broadcast.emit — при объявлении константы
  // ближе к концу функции любой будущий СИНХРОННЫЙ вызов такого замыкания
  // между их созданием и этой строкой поймал бы ReferenceError (TDZ) на
  // старте всего приложения. getWindow — функция, а не сам win, потому что
  // win передаётся в registerIpc() уже готовым, но объявлять зависимость
  // через геттер дешевле, чем помнить, что где-то выше это единственное
  // место, которое обязано звать закрытие, а не значение.
  const broadcast = createBroadcast({ getWindow: () => win });

  // Хвост вывода по вкладкам (output-buffer.js) — то, что отдаётся клиенту
  // сразу при подключении: сетевой сервер сам xterm не видит, а история живёт
  // только внутри окна ПК. Наполняется в onEvent менеджера сессий (ниже, там
  // же, где term:data уходит в broadcast.emit), чистится на tabs:close.
  //
  // Объявлен ЗДЕСЬ, рядом с broadcast, и ровно по той же причине (ревью 09.08):
  // замыкание onEvent, которое его зовёт, создаётся на сотни строк выше, чем
  // стояло это объявление. Сегодня спасает только то, что ни одно событие не
  // приходит синхронно в этом промежутке — то есть корректность держится на
  // тайминге, а не на коде. Любая будущая правка, эмитящая term:data синхронно
  // при создании менеджера, ловила бы ReferenceError (TDZ) на старте всего
  // приложения, причём только в проде: registerIpc под node --test не
  // запускается. Зависимостей у конструктора нет, переносить безопасно.
  const outputBuffer = createOutputBuffer({});

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
  // Task 2 фазы 9 (голосовой ввод): stt остаётся null здесь (НЕ создаём
  // createStt заранее — см. getOrCreateStt() выше), но сбрасываем ссылку на
  // случай повторного registerIpc() в рамках одного процесса: без сброса
  // getOrCreateStt() вернул бы уже disposed-инстанс прошлой регистрации
  // (disposeSessions() зовёт stt.dispose() ниже, но не обнуляет переменную).
  stt = null;

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
    // I3 (ревью финальной волны фазы 8, шов с фазой 7): вкладка, ждущая
    // сброса ночного лимита (в pending night-watch.js), не должна получать
    // очередной элемент очереди Ctrl+Q на каждый Stop — иначе вся очередь
    // сгорает в стену за секунды (CLI на исчерпанном лимите отбивает вброс
    // мгновенно, следующий Stop вбрасывает следующий элемент). nightWatch
    // здесь — та же модульная let-переменная, что и everywhere в файле:
    // на момент ЭТОГО замыкания (создание manager, до создания nightWatch
    // чуть ниже) она ещё null, но вызывается это замыкание не раньше первого
    // реального Stop-хука — то есть уже после того, как nightWatch присвоен.
    holdQueueFor: (tabId) => !!(nightWatch && nightWatch.isPending(tabId)),
    // Живая приёмка 01.08: «название» сессии из транскрипта — имя из
    // `/rename`, а если его нет, автозаголовок Claude. Читаются НАЧАЛО и
    // КОНЕЦ файла (источники лежат в разных концах, а транскрипт бывает
    // 226 МБ); sessionId — страховка от чужих записей. Обоснование выбора
    // источников, мест и размеров чтения — в шапке session-title.js.
    readSessionTitle: (transcriptPath, sessionId) => sessionTitleReader.read(transcriptPath, sessionId),
    onEvent: (channel, payload) => {
      if (smoke && channel === 'term:data') smokeOutput += payload.data;
      // Задача 4 (буфер вывода): наполняем ТУТ ЖЕ, в том самом месте, где
      // событие term:data уходит в broadcast.emit ниже, — подключившийся
      // клиент получает то же самое, что видит окно на ПК, ни байтом меньше.
      // bufferTermData вынесена выше (Important 1 ревью) ради собственного
      // юнит-теста — эта строка зовёт РОВНО её, не копию.
      bufferTermData({ channel, payload, outputBuffer });
      if (channel === 'tabs:changed') syncWorkspace();
      // Task 2 фазы 8 («Ночная смена») — детект остановки по лимиту. См.
      // подробный комментарий у объявления lastStatusByTab выше по файлу:
      // prevStatus ОБЯЗАН читаться из карты ДО её обновления новым значением
      // из payload — иначе prev всегда совпадёт с уже применённым Stop'ом
      // статусом 'done', и переход working→done никогда не будет замечен.
      if (channel === 'tab:status') {
        const prev = lastStatusByTab.get(payload.tabId);
        lastStatusByTab.set(payload.tabId, payload.status);
        // M4 финального ревью: логика вынесена в shouldDetectLimitStop()
        // (чистая функция выше по файлу) — см. её комментарий за подробным
        // обоснованием Minor 1 (stuck) и Important 1 (genProven).
        if (nightWatch && shouldDetectLimitStop(prev, payload)) {
          // M2 (ревью финальной волны): текущее поколение pty вкладки НА
          // МОМЕНТ детекта — ядро сравнит его с актуальным на пробуждении
          // (getTabGen ниже), чтобы не резюмить в pty, который успел
          // смениться (авто-респавн/ручной рестарт в пикер сессий) между
          // детектом и пробуждением.
          const tab = manager.list().find((t) => t.tabId === payload.tabId);
          nightWatch.onTabStop(payload.tabId, 'working', tab ? tab.gen : undefined);
        }
      }
      // Task 2 фазы 4: тот же поток, что шлёт tab:status в renderer, — тостер
      // (toasts.js, чистый модуль) сам решает, показывать ли уведомление
      // Windows, по правилу «не уведомлять о том, на что смотришь». Имя
      // вкладки берём из manager.list() — payload статуса его не несёт.
      // smoke: headless-прогон никогда не должен показывать тосты.
      // I2 (ре-ревью 01.08): labelOnly — событие, у которого изменилась ТОЛЬКО
      // метка сессии (заголовок дочитался из транскрипта), статус тот же.
      // Тостер обязан его пропустить: у 'done'/'waiting' нет дедупа по
      // предыдущему статусу, и пользователь получил бы повторный Windows-тост
      // «готово»/«ждёт ответа» ни с того ни с сего.
      // `manager &&` — тот же класс, что перенос outputBuffer выше, только
      // переносом не лечится: это самореференс, замыкание принадлежит самому
      // менеджеру и создаётся ДО того, как переменная получит значение.
      // Синхронный tab:status во время createSessionManager дал бы здесь
      // TypeError на старте всего приложения; сегодня спасает лишь то, что
      // фабрика sessions.js до return ничего не эмитит.
      if (!smoke && channel === 'tab:status' && toaster && manager && !payload.labelOnly) {
        const tab = manager.list().find((t) => t.tabId === payload.tabId);
        toaster.onStatus({
          tabId: payload.tabId,
          tabName: tab ? tab.name : payload.tabId,
          status: payload.status,
          waitingText: payload.waitingText,
        });
      }
      broadcast.emit(channel, payload);
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
  // `|| {}` (нит ре-ревью фикс-раунда 1): пользовательский `"nightWatch": null`
  // в config.json пережил бы deepMerge как null и уронил бы registerIpc()
  // TypeError'ом на старте всего приложения — ядро свой config гардит
  // спредом, а вот чтение wakeMarginMs для тостов ниже не гардил никто.
  const nightCfg = getConfig().nightWatch || {};
  // Minor 5 (ревью фикс-раунд 1) + I2 (ревью финальной волны): пачка Stop'ов
  // в разных вкладках (окно общее на аккаунт — вполне реалистично, если
  // несколько сессий упёрлись в лимит примерно одновременно, или взведённый
  // ДНЁМ режим — 200+ обычных Stop за рабочий день) звала бы
  // usagePoller.refresh() на КАЖДЫЙ, мимо уже существующей single-flight
  // защиты manualRefreshInFlight (та покрывает только IPC-путь
  // 'usage:refresh') — риск словить 429 от Anthropic и уйти в 10-минутный
  // stale-бэкофф поллера, из-за которого СЛЕДУЮЩИЙ настоящий лимит-стоп
  // получил бы no-usage-data и не продолжился бы ночью вовсе. Два независимых
  // барьера теперь: (I2) если snapshot() уже свежий (ok, не stale, младше
  // USAGE_SNAPSHOT_FRESH_MS) — отдаём его синхронно, БЕЗ похода в сеть вовсе;
  // (Minor 5) иначе — single-flight, конкурентные детекты делят ОДИН запрос.
  let usageRefreshInFlight = null;
  const refreshUsage = () => {
    const snap = usagePoller.snapshot();
    if (isSnapshotFreshEnough(snap, Date.now())) return Promise.resolve(snap);
    return usageRefreshInFlight
      || (usageRefreshInFlight = Promise.resolve(usagePoller.refresh())
        .finally(() => { usageRefreshInFlight = null; }));
  };
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
    // C1 (Critical, ревью финальной волны): resumableTabStatus() (см. выше по
    // файлу) маппит idle_prompt ('waiting'+waitingKind:'idle') в 'done' —
    // без этого маппинга вкладка, простоявшая ночь в idle_prompt (терминал
    // не в фокусе), никогда не продолжилась бы: ЛЮБОЙ 'waiting' считался бы
    // непродолжаемым диалогом (NO_RESUME_STATUSES ядра).
    getTabStatus: (tabId) => {
      const tab = manager.list().find((t) => t.tabId === tabId);
      return tab ? resumableTabStatus(tab.status, tab.waitingKind) : null;
    },
    // M2 (ревью финальной волны): текущее поколение pty вкладки — ядро
    // сравнивает его с тем, что было зафиксировано в момент детекта (см.
    // onTabStop(tabId, prevStatus, gen) в onEvent выше), чтобы не резюмить в
    // pty, который успел смениться между детектом и пробуждением.
    getTabGen: (tabId) => {
      const tab = manager.list().find((t) => t.tabId === tabId);
      return tab ? tab.gen : undefined;
    },
    // Гард непустого текста + '\r' (бриф) — тот же приём, что normalizeForPty/
    // injectQueuedOnStop, только текст здесь всегда буквальное «продолжай»
    // (решение пользователя, брейншторм 28.07), нормализовывать нечего.
    writeToTab: (tabId, text) => {
      const t = String(text || '').trim();
      if (t) manager.write(tabId, `${t}\r`);
    },
    emit: (event, payload) => {
      broadcast.emit(event, payload);
    },
    powerBlocker: smoke ? createNoopPowerBlocker() : createRealPowerBlocker(),
    journal: withNightToasts(
      smoke ? createInMemoryNightJournal() : createNightJournal({ file: nightJournalFile() }),
      // Дефолт дублируется здесь осознанно (тот же нит, что `|| {}` выше):
      // при nightWatch:null у пользователя nightCfg пуст, и без запаски время
      // в тосте стало бы «NaN:NaN» — ядро свои дефолты спредит само, а тост
      // считает время сам по себе.
      typeof nightCfg.wakeMarginMs === 'number' ? nightCfg.wakeMarginMs : 60000,
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
        broadcast.emit('usage:update', { limits: snap, spend: lastCcusageResult });
      }
    }, 5000);
    usageMonitorTimer.unref?.();

    // Important-3 (ревью инцидент-фикса 8ГБ): обещание «подсчёт начнётся
    // через минуту» кто-то должен ВЫПОЛНИТЬ — boot()-ный usage:get всегда
    // попадает в 90-секундное cacheOnly-окно, а больше реальный ccusage.get()
    // ниоткуда не приходит (30с-таймер renderer только перерисовывает кэш).
    // Один отложенный настоящий пересчёт по истечении окна + push свежего
    // результата тем же каналом usage:update.
    deferredSpendTimer = setTimeout(async () => {
      deferredSpendTimer = null;
      try {
        const spend = await ccusage.get();
        // N2 ре-ревью: не даём протухшему ответу перезаписать более свежий
        // (гонка с параллельным usage:refresh) — deferred никогда не
        // затирает настоящие данные.
        if (!(spend && spend.error === 'deferred')) lastCcusageResult = spend;
        broadcast.emit('usage:update', {
          limits: usagePoller.snapshot(), spend: lastCcusageResult,
        });
      } catch { /* ccusage.get сам не бросает; ремень на чужие сбои */ }
    }, CCUSAGE_BOOT_DEFER_MS + 2000);
    deferredSpendTimer.unref?.();
  }

  // Реестр команд (command-registry.js): каждый обработчик кладётся СРАЗУ в
  // ipcMain (локальный renderer работает как раньше) и в карту имён (сетевой
  // транспорт фазы «кокпит по сети» зовёт их по имени канала). Задача 1
  // перевела на реестр только группу tabs:*, задача 2 — все остальные каналы
  // без исключения (см. test/command-registry.coverage.test.js: в файле не
  // должно остаться ни одной прямой регистрации на ipcMain). Создаётся один
  // раз, здесь же, ДО первой регистрации — раньше объявление жило ниже, перед
  // tabs:open, единственной группой, которая тогда его использовала.
  // Эстафета: один хозяин в каждый момент (спека «Кокпит по сети»). Владение
  // живёт в чистом модуле ownership.js, проводка — в createHandoffWiring выше
  // (она же под тестом). Создаётся ПОСЛЕ manager (onChange его дёргает) и ДО
  // реестра (гард нужен реестру уже при сборке).
  const { ownership, guard: handoffGuard } = createHandoffWiring({
    manager, broadcast, onOwnerChange,
  });

  const registry = createCommandRegistry({ ipcMain, guard: handoffGuard });

  // Задача 7 фазы «кокпит по сети»: сам сетевой сервер (net-server.js,
  // задача 6) — HTTP-статика renderer + WebSocket-мост к реестру команд.
  // Создаётся здесь, сразу после registry (outputBuffer объявлен ещё выше, в
  // начале функции — см. комментарий у него), стартует безусловно, тем же
  // приёмом, что startBridge() выше:
  // сервер поднимается и в smoke (иначе сетевой транспорт вообще не
  // затрагивается прогоном), просто без внешнего наблюдателя за ним.
  // Слушаем ТОЛЬКО адрес из конфига, а не 0.0.0.0: на всех интерфейсах
  // кокпит был бы виден любому в чужом вайфае, а это выполнение произвольных
  // команд на машине (аутентификации в этой фазе ещё нет, она отдельным
  // планом). Адрес — из конфига, а не прошит в коде: он принадлежит МАШИНЕ
  // (конкретный адрес Tailscale этого ПК), а не программе, и меняется при
  // перевыпуске ключа Tailscale. Дефолт '127.0.0.1' безопасен сам по себе:
  // не настроив ничего, пользователь получает сервер, доступный только с
  // этого же ПК. Разбор секции — через resolveNetConfig() (см. её
  // комментарий выше по файлу) — единая точка, которую покрывает
  // test/ipc-net-boot.test.js, а не инлайн-тернарники, которые ревью раунда
  // 2 подменило дефолтом '0.0.0.0' без единого красного теста. allowedHosts
  // — доп. имена для белого списка Host внутри net-server.js (фикс
  // DNS-rebinding, соседняя задача, раунд 4): к машине приходят и по
  // адресу, и по DNS-имени тайлнета одновременно, а host выше хранит
  // обычно только одно из двух.
  const netCfg = resolveNetConfig(getConfig().net);
  const netServer = createNetServer({
    registry,
    broadcast,
    outputBuffer,
    // Эстафета: сервер помечает каждый кадр именем сокета и обслуживает захват
    // управления — реестр получил бы кадр без личности и не отличил бы макбук
    // от локального окна.
    ownership,
    staticRoots: rendererStaticRoots(appRoot()),
    port: netCfg.port,
    host: netCfg.host,
    allowedHosts: netCfg.allowedHosts,
  });
  // startBridge() выше сама ловит ошибки старта и делает фолбэк на эфемерный
  // порт — у сетевого сервера такого фолбэка нет (адрес важен пользователю
  // буквально, порт согласован заранее). Вместо голого console.log —
  // startNetServerWithRetries() (см. её комментарий выше по файлу): не
  // роняет остальной кокпит при неудаче (локальное окно обязано работать,
  // даже если сетевой сервер не поднялся), даёт ограниченное число повторов
  // на случай boot-race с интерфейсом Tailscale и уведомляет notify(), если
  // сдался — тем же каналом, что «config.json повреждён» в main.js.
  startNetServerWithRetries({
    start: () => netServer.start(), host: netCfg.host, port: netCfg.port, notify,
  });

  registry.handle('config:get', () => getConfig());

  registry.handle('config:set', (partial) => {
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
  registry.handle('night:toggle', () => nightToggleHandler({ smoke, nightWatch }));

  registry.handle('night:get', () => nightGetHandler({ smoke, nightWatch }));

  // Task 3 фазы 5 (кольца лимитов): usagePoller.snapshot() — синхронный, без
  // сети. ccusage.get() — лениво: первый usage:get и есть тот самый «первый
  // запуск», дальше TTL-кэш внутри usage-ccusage.js сам не даёт бить по npx
  // чаще ttlMs (проводить свой отдельный троттлинг здесь не нужно — это уже
  // сделано в модуле). smoke: НИ сети, НИ npx — spend всегда null, ccusage.get()
  // не зовётся вовсе.
  registry.handle('usage:get', async () => {
    const limits = usagePoller.snapshot();
    if (smoke) return { limits, spend: null };
    // Инцидент 8ГБ (01.08): первые 90с после старта — шторм спавна сессий
    // restore; npx-прогоны ccusage по транскриптам в это окно складывались с
    // ним и вгоняли машину в своп намертво. cacheOnly до истечения окна.
    const bootStorm = Date.now() - ipcBootAt < CCUSAGE_BOOT_DEFER_MS;
    lastCcusageResult = await ccusage.get({ force: false, cacheOnly: bootStorm });
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
  registry.handle('usage:refresh', async () => {
    if (smoke) return { limits: usagePoller.snapshot(), spend: null };
    if (manualRefreshInFlight) return manualRefreshInFlight;

    const nowMs = Date.now();
    if (nowMs - lastManualRefreshAt < MANUAL_REFRESH_MIN_INTERVAL_MS) {
      return { limits: usagePoller.snapshot(), spend: lastCcusageResult };
    }
    lastManualRefreshAt = nowMs;

    manualRefreshInFlight = (async () => {
      // Инцидент 8ГБ (01.08): кольца показывают ЛИМИТЫ — их и обновляем
      // принудительно (дешёвый HTTP). force:true у ccusage прогонял два
      // параллельных npx по 1.7ГБ транскриптов (~15с диска, ~190МБ пиковое
      // дерево) НА КАЖДЫЙ клик мимо 10-минутного кэша — на задыхающейся
      // машине это и был «клик по кольцам вешает комп». Расходы обновляются
      // по своему TTL (10 мин) — для карточки «$ за день» этого достаточно.
      // Important-4 (ревью инцидент-фикса): клик в первые 90с после старта
      // не должен запускать npx одновременно со штормом restore — тот же
      // cacheOnly-гейт, что у usage:get.
      const bootStorm = Date.now() - ipcBootAt < CCUSAGE_BOOT_DEFER_MS;
      const [, spend] = await Promise.all([
        usagePoller.refresh(),
        ccusage.get({ cacheOnly: bootStorm }),
      ]);
      lastCcusageResult = spend;
      return { limits: usagePoller.snapshot(), spend };
    })();
    try {
      return await manualRefreshInFlight;
    } finally {
      manualRefreshInFlight = null;
    }
  });

  registry.handle('shell:openExternal', (url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  // Task 4 фазы 4 (палитра команд): «Открыть DevTools» — то же самое, что
  // делает F12 (см. main.js/before-input-event), просто доступное и из палитры.
  registry.handle('app:devtools', () => {
    if (!win.isDestroyed()) win.webContents.toggleDevTools();
  });

  // Task 1 фазы 4: renderer шлёт агрегат «сколько вкладок ждут» + готовую
  // PNG-иконку бейджа (канвас рисует badge.js, main про canvas не знает).
  // attention — чистый модуль (attention.js), инстанс создаётся в main.js
  // (там же живут nativeImage и win.setOverlayIcon) и прокидывается сюда
  // через opts — ipc.js только маршрутизирует IPC-пейлоад.
  registry.on('attention:update', (payload) => {
    if (!attention || !payload || typeof payload !== 'object') return;
    const { count, dataUrl } = payload;
    // Fix (ревью): typeof count !== 'number' пропускал NaN (typeof NaN ===
    // 'number') — NaN ломает дедупликацию в attention.js (NaN !== NaN всегда
    // true, обновление никогда не гасится) и даёт заголовок окна вида
    // «Cockpit — NaN ждут». count — количество вкладок, только целое ≥ 0.
    if (!Number.isInteger(count) || count < 0) return;
    attention.update({ count, dataUrl: typeof dataUrl === 'string' ? dataUrl : null });
  });

  // Список ЖИВЫХ вкладок менеджера (C1 финального ревью ветки). До него в
  // реестре не было НИ ОДНОГО канала, отдающего наружу tabId работающих
  // сессий: клиент, открывший страницу, знал только манифест воркспейса (что
  // было ВЧЕРА) и потому мог лишь звать tabs:open — а тот на каждый вызов
  // минтит НОВЫЙ tabId. Живьём это давало второй `claude --resume <тот же
  // sessionId>` на каждую вкладку: два процесса на один транскрипт и один
  // ghost-файл, удвоенный манифест, переживающий перезапуск, и ×4 на
  // следующем подключении. Срабатывало и на 127.0.0.1, то есть при простом
  // открытии адреса кокпита на самом ПК.
  //
  // Отдаём manager.list() как есть (тот же снимок, что уже уходит в манифест
  // воркспейса): renderer'у нужны tabId/cwd/name для строки сайдбара и
  // status/subtitle/waitingKind/waitingText/sessionLabel, чтобы подключённая
  // вкладка сразу встала в правильную секцию, а не ждала следующего хука.
  registry.handle('tabs:list', () => manager.list());

  // История вывода вкладки — хвост из output-buffer.js (задача 4). C2
  // финального ревью: канал существовал ТОЛЬКО внутри net-server.js, в форме
  // window.api его не было вовсе, и ни app.js, ни terminal.js его не звали —
  // то есть пункт спеки «подключившийся клиент видит, на чём остановилась
  // работа» не работал, а весь буфер копился в стол.
  //
  // Почему обработчик есть И здесь, и отдельной веткой в net-server.js:
  // сетевой сервер перехватывает net:buffer ДО реестра (история — свойство
  // соединения, см. комментарий там), а этот обработчик обслуживает ЛОКАЛЬНЫЙ
  // путь — перезагрузку renderer (Ctrl+R) при живом main, когда вкладки уже
  // работают, а xterm в окне только что создан с нуля. Оба читают ОДИН И ТОТ
  // ЖЕ экземпляр outputBuffer, разойтись им нечем.
  //
  // Пустой хвост (вкладка только создана, вывода ещё не было) — нормальный
  // ответ, а не ошибка: отдаём пустую строку.
  registry.handle('net:buffer', (tabId) => (typeof tabId === 'string' ? outputBuffer.get(tabId) : ''));

  // Эстафета, локальная половина. Окно ПК захватывает управление своим
  // размером терминала — тот же путь, что у браузера, отличается только
  // личность ('local' против имени сокета). Сетевую половину обслуживает
  // net-server.js: только он знает, ЧЕЙ пришёл кадр.
  registry.handle('owner:claim', (size) => {
    ownership.claim('local', size);
    return { owner: ownership.owner(), self: 'local', online: ownership.ownerOnline() };
  });
  registry.handle('owner:get', () => (
    { owner: ownership.owner(), self: 'local', online: ownership.ownerOnline() }
  ));

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
  registry.handle('tabs:open', ({
    cwd, command, args, ghostId, sessionId, sessionLabel,
  } = {}) => {
    if (typeof cwd !== 'string' || !cwd) return null;
    const cmd = typeof command === 'string' ? command : undefined;
    const a = Array.isArray(args) && args.every((x) => typeof x === 'string') ? args : undefined;
    const gid = typeof ghostId === 'string' && ghostId ? ghostId : undefined;
    const sid = typeof sessionId === 'string' && sessionId ? sessionId : undefined;
    // I3 (ревью 01.08): метка из манифеста — восстановление передаёт её сюда,
    // вкладка подписана с первой отрисовки (см. sessions.js/open).
    const label = typeof sessionLabel === 'string' && sessionLabel ? sessionLabel : undefined;
    return manager.open({
      cwd, smoke, command: cmd, args: a, ghostId: gid, sessionId: sid, sessionLabel: label,
    });
  });

  registry.handle('tabs:close', (tabId) => {
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
    // Задача 4 (буфер вывода): без drop() буфер закрытой вкладки копится в
    // памяти до перезапуска кокпита — тот же приём, что toaster.forget()/
    // lastStatusByTab.delete() выше, только для output-buffer.js.
    // dropTabOutputBuffer вынесена выше (Important 1 ревью) ради собственного
    // юнит-теста — эта строка зовёт РОВНО её, не копию.
    dropTabOutputBuffer({ tabId, outputBuffer });
    // M1+M3 (ревью финальной волны): если вкладка ждала сброса ночного лимита
    // (в pending night-watch.js), закрытие должно освободить будильник/блокер
    // немедленно, а не после впустую потраченного цикла ретраев — nightWatch.
    // forget() сама решает, было ли что забывать (no-op, если вкладка не
    // была в pending — не спамим журнал на КАЖДОЕ обычное закрытие).
    if (nightWatch) nightWatch.forget(tabId);
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
  registry.handle('ghost:save', (payload) => {
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

  registry.handle('ghost:load', (ghostId) => {
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
  registry.handle('workspace:get', () => (smoke ? null : store.load()));

  registry.on('workspace:setActive', (p) => {
    if (p && typeof p.tabId === 'string') {
      activeTabId = p.tabId;
      syncWorkspace();
    }
  });

  // «Прочитано» (живая приёмка 01.08): renderer сообщает, что пользователь
  // реально смотрит на эту вкладку — она уезжает из «Готово» в «Наготове».
  // Гард узкий и живёт в ядре (manager.markSeen): двигаем только 'done', так
  // что лишнее или запоздавшее сообщение безвредно.
  registry.on('tabs:seen', (p) => {
    if (p && typeof p.tabId === 'string') manager.markSeen(p.tabId);
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
  registry.on('workspace:ready', () => {
    wsync.readyAndSync(activeTabId);
  });

  // Файловый обзор (план 3): свой экран выбора папки, общий для окна на ПК и
  // браузера на макбуке. Ограничение в 1000 записей, сортировка и тексты
  // ошибок живут в fs-browse.js под тестами — здесь только проводка.
  registry.handle('fs:list', (dirPath) => listDir(dirPath));
  registry.handle('fs:drives', () => listDrives());

  registry.handle('tabs:chooseFolder', async () => {
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
  registry.handle('project:connect', (tabId) => {
    const cwd = tabCwd(tabId);
    if (!cwd) return { connected: false, error: 'вкладка не найдена' };
    const res = connectProject(cwd, hookOpts());
    if (res && res.connected) {
      notify('Хуки обновлены — перезапустите сессию (Ctrl+Shift+R), чтобы панель диффа обновлялась сама', 'info');
    }
    return res;
  });

  registry.handle('project:status', (tabId) => {
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
  registry.handle('git:get', async (tabId, opts) => gitGetHandler({
    smoke, tabId, opts, tabCwd, gitInfo,
  }));

  // Task 4 фазы 6 (панель GitHub): cwd вкладки — тот же tabCwd(), что и git:get
  // выше. smoke: НЕ дёргаем gh вообще — headless-прогон не должен спавнить
  // внешние процессы сверх PTY_OK-смоука. force — ручной повтор, опрокидывает
  // TTL-кэш ghInfo. Логика — в ghRepoHandler() выше по файлу (та же причина,
  // что у git:get).
  registry.handle('gh:repo', async (tabId, opts) => ghRepoHandler({
    smoke, tabId, opts, tabCwd, ghInfo,
  }));

  // gh:global — сводка по ВСЕМ открытым PR/issues пользователя + число
  // непрочитанных уведомлений, без привязки к конкретной вкладке (дашборд,
  // Task 4 фазы 6). smoke — тот же гейт, что и gh:repo выше. Логика —
  // в ghGlobalHandler() выше по файлу.
  registry.handle('gh:global', async (opts) => ghGlobalHandler({ smoke, opts, ghInfo }));

  // Task 3 фазы 7 (глобальный поиск истории, Ctrl+Shift+H) + I5 (ревью
  // финальной волны, TTL индекса): смотри search.js (renderer) — оверлей с
  // дебаунсом/отменой устаревших запросов, здесь только проводка. Логика —
  // в historySearchHandler()/historyRefreshHandler() выше по файлу (вынесены
  // ради тестируемости смоук-гейта — «дыра тестов №1», ревью финальной
  // волны — и TTL-фикса I5, см. подробные комментарии там).
  registry.handle('history:search', async (query, opts) => historySearchHandler({
    smoke, query, opts, state: historyIndexState, historyIndex,
  }));

  registry.handle('history:refresh', async (opts) => historyRefreshHandler({
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
  registry.handle('recipes:list', () => recipesListHandler({ smoke, recipeStore }));

  // Сохранение/удаление рецепта — CRUD-контракт recipes.js целиком (бриф),
  // текущий UI (палитра) сам новые рецепты не создаёт и не удаляет (только
  // читает дефолты + то, что уже лежит в prompts.json) — задел на будущую
  // форму редактирования библиотеки, тот же приём, что history:refresh выше.
  // Логика — в recipesSavePromptHandler()/recipesDeletePromptHandler() выше.
  registry.handle('recipes:savePrompt', (p) => recipesSavePromptHandler({ smoke, recipe: p, recipeStore }));

  registry.handle('recipes:deletePrompt', (id) => recipesDeletePromptHandler({ smoke, id, recipeStore }));

  // fillPrompt — чистая текстовая подстановка без единого обращения к диску,
  // смысла гейтить smoke'ом нет (тот же довод, что config:get/shell.openExternal
  // выше по файлу не гейтятся) — просто безвредный no-op на пустых values.
  registry.handle('recipes:fillPrompt', (text, values) => fillPrompt(text, values));

  // Minor 8 (ревью раунд 1): нормализация переносов строк перед записью в pty —
  // тоже чистая функция без диска, тот же довод, что recipes:fillPrompt выше,
  // не гейтим smoke'ом. Зовётся app.js/runRecipe БЕЗУСЛОВНО (даже без
  // плейсхолдеров), чтобы внутренний \n текста рецепта не ушёл в терминал
  // отдельным Enter (в т.ч. молчаливым подтверждением диалога разрешения).
  registry.handle('recipes:normalizeForPty', (text) => normalizeForPty(text));

  // Именованные воркспейсы (Task 4 фазы 7): listWorkspaces/saveWorkspace —
  // палитра читает и пишет их напрямую (действия «Открыть воркспейс: <name>»/
  // «Сохранить воркспейс…», см. app.js). deleteWorkspace (ревью раунд 1,
  // Minor 6) — теперь тоже за действием палитры «Удалить воркспейс: <name>»
  // (без него накопленный дублями/устаревший мусор в workspaces-library.json
  // можно было почистить только руками через файл).
  // Дыра тестов №1 (ревью финальной волны): логика — в
  // recipesListWorkspacesHandler()/recipesSaveWorkspaceHandler()/
  // recipesDeleteWorkspaceHandler() выше по файлу (та же причина).
  registry.handle('recipes:listWorkspaces', () => recipesListWorkspacesHandler({ smoke, recipeStore }));

  registry.handle('recipes:saveWorkspace', (name, tabs) => recipesSaveWorkspaceHandler({
    smoke, name, tabs, recipeStore,
  }));

  registry.handle('recipes:deleteWorkspace', (id) => recipesDeleteWorkspaceHandler({ smoke, id, recipeStore }));

  // Task 4 фазы 4 (вставка скриншотов): cwd вкладки резолвим тем же путём,
  // что project:connect/status — tabCwd (manager.list()). saveClipboardImage —
  // чистый модуль (screenshot.js), clipboard.readImage() инжектируется отсюда.
  // Любая ошибка (в т.ч. пустой буфер, недоступный clipboard) → null — renderer
  // (terminal.js) сам падает на обычную текстовую вставку в этом случае.
  registry.handle('screenshot:paste', (tabId) => {
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

  registry.on('term:start', (payload) => {
    // Payload может прийти не объектом (null и т.п.) — деструктуризация упала
    // бы через uncaughtException прямо в app.exit(1). Отсекаем заранее.
    if (!payload || typeof payload !== 'object') return;
    const { tabId, cols, rows } = payload;
    if (typeof tabId !== 'string') return;
    if (!validDim(cols) || !validDim(rows)) return;
    manager.start(tabId, cols, rows);
  });

  registry.on('term:restart', (payload) => {
    if (!payload || typeof payload !== 'object') return;
    const { tabId } = payload;
    if (typeof tabId === 'string') manager.restart(tabId);
  });

  registry.on('term:write', (payload) => {
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

  registry.on('term:resize', (payload) => {
    if (!payload || typeof payload !== 'object') return;
    const { tabId, cols, rows } = payload;
    if (typeof tabId !== 'string') return;
    if (!validDim(cols) || !validDim(rows)) return;
    manager.resize(tabId, cols, rows);
    // Запоминаем размер за текущим владельцем: сюда доходят ТОЛЬКО его
    // ресайзы (term:resize — пишущий канал, чужие отсеял гард эстафеты), а
    // без этого владение знало размер лишь с момента захвата. Живая жалоба:
    // «при возврате на ПК размер ломается, приходится дёргать окно» — возврат
    // ставил pty в размер, снятый при загрузке страницы, и Claude Code
    // перерисовывался под чужую ширину.
    ownership.noteSize({ cols, rows });
  });

  // Task 1 фазы 7 (очередь промптов): fire-and-forget, тот же приём, что
  // term:write/term:restart выше — состояние возвращается отдельным событием
  // (queue:changed, генерируется sessions.js и уходит через generic onEvent
  // в начале registerIpc), синхронный ответ invoke() здесь не нужен.
  registry.on('queue:add', (payload) => {
    if (!payload || typeof payload !== 'object') return;
    const { tabId, text } = payload;
    if (typeof tabId !== 'string' || typeof text !== 'string') return;
    manager.enqueue(tabId, text);
  });

  registry.on('queue:remove', (payload) => {
    if (!payload || typeof payload !== 'object') return;
    const { tabId, index } = payload;
    if (typeof tabId !== 'string' || !Number.isInteger(index)) return;
    manager.removeFromQueue(tabId, index);
  });

  registry.on('queue:clear', (payload) => {
    if (!payload || typeof payload !== 'object') return;
    const { tabId } = payload;
    if (typeof tabId !== 'string') return;
    manager.clearQueue(tabId);
  });

  // Task 2 фазы 9 (голосовой ввод): stt:transcribe/status — Task 3 (renderer,
  // push-to-talk на правом Shift) дёргает их напрямую через preload. Здесь
  // только проводка каналов, вся смоук-логика и создание инстанса (M2,
  // ревью финальной волны: подъём JS-объекта, НЕ сервера — см. getOrCreateStt
  // выше) — внутри самих хендлеров.
  registry.handle('stt:transcribe', (wav) => sttTranscribeHandler({ smoke, wav, getStt: getOrCreateStt }));

  registry.handle('stt:status', () => sttStatusHandler({ smoke, getStt: getOrCreateStt }));

  // Задачам 5 и 7 (сетевой сервер + мост window.api в браузере) реестр и
  // рассылка нужны снаружи этой функции — до правки задачи 2 реестр жил
  // только внутри registerIpc() и был недостижим (см. progress.md, Task 1,
  // отложенный minor). broadcast добавлен ре-ревью задачи 3 (Important 1):
  // notify.js/main.js шлют события в обход единой точки, потому что им было
  // неоткуда её взять — net-server.js (задача 6) уже принимает broadcast
  // параметром, ждал только этого возврата. Расширение возврата ничего не
  // ломает: единственный вызывающий (main.js) раньше использовал только
  // сам факт вызова, не деструктурировал результат вовсе.
  //
  // netServer добавлен задачей 7: main.js должен уметь остановить сервер при
  // выходе (иначе порт остаётся занятым между перезапусками кокпита) — тем
  // же приёмом, что и broadcast выше, единственный способ отдать наружу
  // объект, созданный ВНУТРИ этой функции.
  // ownership добавлен планом 2: main.js спрашивает у него владельца и статус
  // связи, когда перерисовывает меню трея.
  return {
    registry, broadcast, netServer, ownership,
  };
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
  // N1 ре-ревью инцидент-фикса: отложенный пересчёт расходов не должен
  // пережить teardown (иначе npx для уничтоженного окна после killAllTracked).
  if (deferredSpendTimer) {
    clearTimeout(deferredSpendTimer);
    deferredSpendTimer = null;
  }
  if (usagePoller) usagePoller.stop();
  // Task 2 фазы 8 («Ночная смена»): dispose() снимает ВСЕ таймеры ядра
  // (ожидание/ретрай + хвост стаггера) и гасит powerSaveBlocker, если он был
  // включён, — без этого приложение могло бы выйти с реально удерживаемым
  // системным блокером энергосбережения (см. night-watch.js/dispose()).
  // Идемпотентно (как и остальные вызовы этой функции) — disposeSessions()
  // зовётся несколько раз за один выход (window-all-closed, потом before-quit).
  if (nightWatch) nightWatch.dispose();
  // Task 2 фазы 9 (голосовой ввод): dispose() убивает живой whisper-server
  // (если был запущен) и снимает таймеры ready-поллинга — рядом с
  // nightWatch.dispose() выше. Гард «если создавался» (см. getOrCreateStt()):
  // если голосом за сессию ни разу не воспользовались, stt остаётся null, и
  // дизпоузить нечего.
  if (stt) stt.dispose();
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
  // Important 1 (ревью задачи 4): проводка буфера вывода — см. комментарий у
  // их определения выше и test/ipc-output-buffer-wiring.test.js.
  bufferTermData, dropTabOutputBuffer,
  // План 2: переразмер pty при пересадке управления и вся проводка эстафеты
  // (владение + гард записи) — см. test/ipc-handoff-wiring.test.js. Проводка
  // экспортируется не для чужого кода, а чтобы её вообще можно было проверить:
  // непокрытой она бесследно исчезала под мутациями.
  applyHandoffSize, createHandoffWiring,
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
  // M4 финального ревью (обязательно) + C1 (Critical) + I2 — чистые функции
  // без Electron, экспортированы ради собственных юнит-тестов (см. комментарии
  // у их определения выше).
  shouldDetectLimitStop, resumableTabStatus, isSnapshotFreshEnough, USAGE_SNAPSHOT_FRESH_MS,
  // I1 финального ревью ветки: карта корней статики — чистая функция от корня
  // приложения, экспортирована ради test/renderer-boot-guard.test.js (он
  // поднимает НАСТОЯЩИЙ сервер ровно на ней и проверяет каждую ссылку
  // разметки, а не на копии, разъезжающейся с продом).
  rendererStaticRoots,
  // Task 2 фазы 9 (голосовой ввод): та же причина — см. комментарий у их
  // определения выше (смоук-гейт тестируется напрямую, без Electron).
  sttTranscribeHandler, sttStatusHandler,
  // Minor-1 (ревью Task 2 фазы 9): HTTP-обёртки — самая рискованная часть
  // обвязки (их контракт с ядром сверялся ревью дословно) — экспортированы
  // ради теста против ЛОКАЛЬНОГО http-сервера (loopback, не сеть).
  sttHttpGet, sttHttpPost,
  // M1/M2 (ревью раунда 2 задачи 7): разбор net-конфига и повторы старта
  // сетевого сервера — чистые функции без Electron, экспортированы ради
  // собственных юнит-тестов (см. комментарии у их определения выше и
  // test/ipc-net-boot.test.js).
  resolveNetConfig, startNetServerWithRetries,
};
