'use strict';
// Точка входа main-процесса Cockpit.

const fs = require('fs');
const path = require('path');
const {
  app, BrowserWindow, screen, Menu, Tray, shell, nativeImage, Notification,
} = require('electron');
const {
  registerIpc, disposeSessions, getSmokeOutput, flushWorkspace, getActiveTabId,
} = require('./ipc');
const { getConfig, isRootConfigCorrupt } = require('./config');
const { appRoot } = require('./paths');
const { setBroadcast, notify } = require('./notify');
const { buildTrayModel } = require('./tray-menu');
const { buildLoginItem, isAutostartOn } = require('./autostart');
const { createAttention } = require('./attention');
const { createToaster } = require('./toasts');

const SMOKE = process.argv.includes('--smoke');

// Задача 7 фазы «кокпит по сети»: ссылка на сетевой сервер (net-server.js),
// который registerIpc() создаёт и стартует внутри app.whenReady() ниже.
// Объявлена здесь, НА УРОВНЕ МОДУЛЯ (а не внутри whenReady, как broadcast
// чуть ниже по файлу) — обработчики выхода (window-all-closed/before-quit/
// uncaughtException) объявлены СНАРУЖИ whenReady().then() и должны видеть
// эту переменную, чтобы остановить сервер и освободить порт при закрытии
// кокпита. null до первого успешного registerIpc() — эти же обработчики
// теоретически могут сработать раньше (например, uncaughtException в самом
// начале старта), гард `if (netServer)` ниже на этот случай.
let netServer = null;

// План 2 фазы «кокпит по сети»: трей и намерение выйти. Крестик теперь ПРЯЧЕТ
// окно — кокпит обязан пережить уход от компьютера, иначе с макбука не к чему
// подключаться. Настоящий выход возможен только через меню трея и отличается
// ровно этим флагом; он же взводится в before-quit, чтобы любой другой путь
// выхода (app.quit() откуда угодно) не упёрся в preventDefault на close.
let tray = null;
let quitting = false;
// Первое скрытие окна объясняем один раз за запуск: без этого пропажа окна из
// панели задач и Alt+Tab выглядит как «приложение закрылось само».
let hideExplained = false;
// Показ окна умеет только замыкание внутри whenReady (ему нужны и win, и
// ownership), а звать его надо и снаружи — из обработчика second-instance,
// объявленного здесь, на уровне модуля. Ссылка присваивается там же, где
// функция создаётся; null до этого момента.
let revealWindow = null;
// Minor 2 (ре-ревью): revealWindow пуст первые секунды старта (пока не
// отработал app.whenReady()). Вторая копия, запущенная в это окно, раньше
// молча ничего не делала — second-instance стреляет сразу, revealWindow ещё
// null, `if (revealWindow) revealWindow();` пропускал вызов без следа, и
// человек, нажавший ярлык второй раз, не видел вообще ничего. Взводим флаг
// «окно попросили показать» и разбираем его сразу же, как revealWindow
// станет доступен (см. присваивание revealWindow ниже, внутри whenReady).
let pendingReveal = false;

// Вторая копия дерётся за манифест воркспейса — разрешаем одну.
// В smoke-режиме блокировку не берём (гоняется параллельно с dev-окном).
//
// C2 (ревью): `return` здесь обязателен. app.quit() НЕ прерывает выполнение
// модуля — он лишь ставит выход в очередь, а до неё вторая копия успевала
// пройти app.whenReady() ЦЕЛИКОМ: поднимала свои pty, лезла в общий манифест
// воркспейса и пыталась занять тот же порт (в её логе ревьюер видел
// `[net] сервер не поднялся ... (EADDRINUSE) — повтор 1/6`). CommonJS
// оборачивает файл в функцию, поэтому возврат на верхнем уровне легален и
// обрывает инициализацию на первой же строке: вторая копия только шлёт
// сигнал первой (его обрабатывает second-instance ниже) и умирает.
if (!SMOKE && !app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

app.on('second-instance', () => {
  // C2: раньше здесь были только restore()+focus(). С тех пор как крестик
  // ПРЯЧЕТ окно (задача 6), спрятанное окно не является свёрнутым — restore()
  // его не возвращает, focus() невидимому окну ничего не даёт, и самый
  // естественный жест «кокпит пропал, запущу ярлык ещё раз» не делал ровным
  // счётом ничего. Зовём тот же showWindow, что и клик по трею: он и
  // показывает окно, и забирает управление обратно на локальную машину.
  //
  // Minor 2: если это случилось раньше app.whenReady() (revealWindow ещё
  // null), не теряем запрос — откладываем его флагом и разбираем сразу после
  // присваивания revealWindow ниже.
  if (revealWindow) revealWindow();
  else pendingReveal = true;
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
    // --hidden ставит автозапуск: при входе в Windows кокпит поднимается в
    // трей и восстанавливает вкладки, но на экран не лезет.
    show: !process.argv.includes('--hidden'),
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0F0F0F',
    title: 'Cockpit',
    // Иконка окна/таскбара (01.08): своя, вместо дефолтного атома Electron —
    // тот же файл, что у ярлыка на рабочем столе (assets/cockpit.ico,
    // генератор — тёмный скруглённый квадрат + акцентный шеврон «❯_»).
    icon: path.join(appRoot(), 'assets', 'cockpit.ico'),
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

  // Ревью Task 3 фазы 9 (C1, M1 ре-ревью): микрофон ВЕРНУЛСЯ в фазе 9
  // (голосовой ввод, push-to-talk — src/renderer/js/voice/recorder.js зовёт
  // getUserMedia({audio:true})). Этот хендлер раньше запрещал ЛЮБОЕ
  // разрешение безусловно — реликт зачистки голосового стека Companion в
  // фазе 0 («микрофона больше нет»), из-за которого getUserMedia падал с
  // NotAllowedError на КАЖДОЕ нажатие Shift, и фича была мертва целиком (тост
  // «Микрофон недоступен» всегда).
  // M1 (ре-ревью раунда 1): в Electron 29 разрешение 'media' покрывает И
  // микрофон, И камеру одним именем — проверки одного `permission==='media'`
  // недостаточно, чтобы честно утверждать «камера по-прежнему запрещена».
  // details.mediaTypes — массив запрошенных типов ('audio'/'video') для
  // media-запросов; recorder.js просит только audio, так что легитимный
  // запрос кокпита никогда не попадёт в mediaTypes.includes('video') — а вот
  // гипотетическая веб-страница/будущий код, попросившие видео, получат
  // отказ, даже если permission по имени совпал с 'media'.
  win.webContents.session.setPermissionRequestHandler(
    (_wc, permission, cb, details) => cb(
      permission === 'media' && !details?.mediaTypes?.includes('video'),
    ),
  );

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
  win.on('close', (e) => {
    if (saveTimer) clearTimeout(saveTimer);
    saveState();
    // Выход — только из меню трея (или любым путём, который прошёл через
    // before-quit). Всё остальное прячет окно: закрытый крестиком кокпит
    // оставил бы удалённого клиента без единой живой вкладки.
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });

  // --- Безопасность: терминал рендерит недоверенный вывод ---
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Carryover 1 (ревью): Menu.setApplicationMenu(null) ниже нужен ради Ctrl+R
  // (Housekeeping #14), но заодно срубает стандартный F12-хоткей Electron —
  // возвращаем его точечно через before-input-event. Фильтр на keyDown
  // обязателен: событие приходит и на keyDown, и на keyUp — без фильтра
  // toggleDevTools() дёрнулся бы дважды подряд (открыл и тут же закрыл).
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      // Fix (ревью): без preventDefault нажатие F12 не только открывает
      // DevTools, но и беспрепятственно долетает до фокусной textarea xterm —
      // ConPTY получает управляющую escape-последовательность F12 в живой pty
      // (мусор перед курсором Claude Code), а не только открывает окно.
      e.preventDefault();
      win.webContents.toggleDevTools();
      return;
    }

    // FIX 3 (ревью, phase5 final wave): ЗДЕСЬ РАНЬШЕ был гард, глушивший
    // голый Ctrl+R и F5 через preventDefault на before-input-event — якобы
    // против reload'а renderer'а поверх живых вкладок, когда открыт DevTools
    // (carryover task 5 фазы 5). Гард убран целиком по итогам живой проверки
    // ниже — он не решал заявленную проблему и ломал реальную.
    //
    // Что было не так:
    //  1. Гард висел на `win.webContents.on('before-input-event', ...)` и
    //     проверял `win.webContents.isDevToolsOpened()` — но `before-input-
    //     event` есть событие именно ЭТОГО webContents (страницы Cockpit), а
    //     не webContents самой панели DevTools (Electron: `contents.
    //     devToolsWebContents` — ОТДЕЛЬНый инстанс). preventDefault здесь
    //     вообще не даёт renderer'у увидеть keydown (документация Electron:
    //     «Calling event.preventDefault will prevent the page keydown/keyup
    //     events from being emitted»), поэтому он гасил Ctrl+R/F5 для нашей
    //     страницы — но был бессилен ровно в том случае, ради которого его
    //     писали: когда фокус клавиатуры реально находится ВНУТРИ панели
    //     DevTools, и клавиша рождается в её собственном webContents.
    //  2. Изначально (до этой правки) гард вообще не проверял DevTools —
    //     глушил Ctrl+R/F5 БЕЗУСЛОВНО. Во вкладках работает Claude Code, где
    //     Ctrl+R — рабочий хоткей (reverse history search и т.п.), а F5
    //     нужен любому TUI внутри pty — оба НИКОГДА не доходили ни до
    //     renderer, ни тем более до pty активной вкладки, даже когда DevTools
    //     вообще не был открыт. Промежуточная правка этой волны добавила
    //     `isDevToolsOpened()` — но живая проверка ниже показала, что
    //     условие излишне: тот путь, ради которого его писали, гард закрыть
    //     не может (см. пункт 1), а без DevTools он и не требовался никогда.
    //
    // Живая проверка (CDP, --user-data-dir изолирован от прод-профиля,
    // терминал подменён на PowerShell-эхо сырых клавиш вместо claude, гард
    // временно отключён совсем — `if (false && ...)` — чтобы проверить факт,
    // а не мнение):
    //   (A) DevTools ЗАКРЫТ, Ctrl+R, БЕЗ всякого гарда → «KEY=R MOD=Control»
    //       появилась в логе эха (клавиша дошла до pty), window.
    //       __cockpitTestMarker пережил нажатие (страница не
    //       перезагрузилась). Голый Ctrl+R/F5 не перезагружает окно сам по
    //       себе — акселератора на них давно нет (Menu.setApplicationMenu(null)
    //       ниже), так что гард здесь никогда и не требовался.
    //   (B) DevTools ОТКРЫТ (F12), клавиша отправлена в webContents ГЛАВНОЙ
    //       страницы (фокус не переводился вручную в панель DevTools — после
    //       открытия DevTools фокус либо остаётся в textarea терминала, либо
    //       уходит на случайный элемент страницы, но НЕ в DevTools), БЕЗ
    //       гарда → та же картина: клавиша дошла до pty, маркер пережил
    //       нажатие, reload НЕ случился. То есть открытие DevTools само по
    //       себе никогда не приводило к перезагрузке через ЭТОТ путь —
    //       ни разу, ни с гардом, ни без него.
    //   (C) Ctrl+R отправлен НАПРЯМУЮ в собственный CDP-таргет DevTools
    //       (devtools://devtools/bundled/devtools_app.html — он реально
    //       существует как отдельный inspectable target, `Target.getTargets`
    //       это подтвердил) — вот тут window.__cockpitTestMarker стал
    //       undefined: страница ДЕЙСТВИТЕЛЬНО перезагрузилась. Это и есть
    //       настоящий источник бага из carryover-заметки — reload происходит,
    //       только когда клавиша рождается в собственном документе DevTools
    //       (пользователь кликнул туда мышью), и `before-input-event` на
    //       `win.webContents` этот путь принципиально не видит — ни с
    //       гардом, ни с каким угодно другим условием внутри него.
    //
    // Итог: гард (в любом виде — безусловный или условный на
    // isDevToolsOpened()) не закрывает реальный путь reload'а (C) и ломает
    // Ctrl+R/F5 в терминале без всякой пользы. Убран целиком. Если сценарий
    // (C) когда-нибудь станет реальной жалобой пользователя — решать его
    // придётся на уровне `contents.on('will-navigate'|'did-start-navigation')`
    // самого DevTools webContents (доступен как `win.webContents.
    // devToolsWebContents` в новых Electron) или явным запретом через
    // `win.webContents.setDevToolsWebContents`/аналог, а не через
    // `before-input-event` окна — здесь это тупик.
  });

  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  return win;
}

// Housekeeping #14: без этого Ctrl+R перезагружает renderer прямо поверх
// живых вкладок main-процесса — второй оверлей restore и дубликаты вкладок.
// DevTools этим не отрезаны: при необходимости открываются программно через
// win.webContents.openDevTools().
Menu.setApplicationMenu(null);

// Fix (ревью): без явного AUMID Windows не всегда сопоставляет тосты
// (Task 2 фазы 4, Notification) именно с этим portable-приложением —
// доставка в центр уведомлений не гарантирована. Тот же id, что build.appId
// в package.json. Должен быть выставлен ДО whenReady().
app.setAppUserModelId('com.lunev.claude-cockpit');

app.whenReady().then(() => {
  let rendererErrors = 0;

  const win = createWindow();

  // Рассылка (broadcast.js) появляется только из registerIpc() ниже — до
  // этого момента переменная нужна как forward-declaration: focusTab
  // объявляется прямо под этим комментарием (внутри toaster), но реально
  // зовётся только позже, асинхронно, по клику на Windows-тост — к тому
  // моменту registerIpc() уже отработает и присвоит сюда настоящий объект.
  let broadcast = null;

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
      // Ре-ревью задачи 3 (Important 1): раньше был прямой
      // win.webContents.send — клик по тосту переключал вкладку локально,
      // но браузерный клиент об этом никогда не узнавал. broadcast к
      // моменту реального клика уже присвоен (см. комментарий выше про
      // forward-declaration); null-гард — на случай клика в узком окне до
      // первого registerIpc() (теоретический, но дешёвый).
      if (broadcast) broadcast.emit('tab:activate', { tabId });
    },
  });

  if (!SMOKE) {
    win.webContents.once('did-finish-load', () => {
      if (isRootConfigCorrupt()) {
        notify('config.json повреждён — работаю на дефолтах', 'error');
      }
    });
  }

  // --- Эстафета и трей (план 2) ---
  // Владение управлением приезжает из registerIpc ниже; функции объявлены до
  // него, потому что onOwnerChange ссылается на них в момент вызова.
  let ownership = null;
  // I7 (ревью): «сервер ещё имеет право подняться». Взводится сразу, гаснет,
  // когда адрес появился или когда ждать больше нечего (см. probeNetAddress
  // ниже) — до тех пор трей не выдаёт нормальный старт за отказ сети.
  let netStarting = true;

  // I6 (ревью): любое исключение внутри обработчика события Electron (клик по
  // значку трея, пункт меню, смена владельца управления) не остаётся внутри
  // обработчика — оно улетает наверх, в process.on('uncaughtException') в
  // конце этого файла, а тот делает app.exit(1). То есть один сбой в
  // побочных эффектах (например, ownership.claim() внутри showWindow) молча
  // убивал бы весь кокпит вместе с живыми pty — от клика по значку в трее.
  // Оборачиваем все точки входа со своей стороны: сбой попадает в лог и
  // остаётся сбоем одного действия, а не концом процесса.
  const guarded = (label, fn) => (...args) => {
    try {
      const result = fn(...args);
      // Minor 1 (ре-ревью): trayClick('address') зовёт shell.openExternal(),
      // который возвращает промис. Его reject раньше уходил мимо этого
      // try/catch в unhandledRejection — в Node >=15 это uncaughtException
      // (см. process.on('uncaughtException') в конце файла) -> app.exit(1).
      // Клик по пункту меню трея молча убивал всё приложение вместе с живыми
      // pty — ровно то, от чего guarded должен был защищать. Ловим и промис,
      // не только синхронные исключения; fn при этом обязана вернуть промис
      // наружу (см. trayClick ниже), иначе здесь ловить нечего.
      if (result && typeof result.then === 'function') {
        result.catch((err) => {
          console.error(`[tray] сбой (${label}): ${(err && err.stack) || err}`);
        });
      }
      return result;
    } catch (err) {
      console.error(`[tray] сбой (${label}): ${(err && err.stack) || err}`);
      return undefined;
    }
  };

  const showWindow = guarded('показ окна', () => {
    if (win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    // Показ окна = возврат управления. Захватываем ПРЯМО здесь, а не просьбой
    // к renderer: событие ушло бы через broadcast всем клиентам сразу (прямой
    // webContents.send в обход broadcast запрещён и стережётся тестом), и
    // браузер на макбуке отобрал бы управление обратно тем же кадром.
    // Размер не передаём — ownership помнит его по владельцу, а renderer
    // уточнит своим term:resize сразу после показа окна.
    if (ownership) ownership.claim('local');
  });
  // Тот же показ окна нужен обработчику second-instance на уровне модуля
  // (повторный запуск ярлыка) — см. комментарий у revealWindow выше.
  revealWindow = showWindow;
  // Minor 2: запрос на показ мог прийти ДО этой строки (вторая копия
  // стартовала в первую же секунду после первой) — pendingReveal его
  // запомнил, разбираем немедленно, как только revealWindow стал рабочим.
  if (pendingReveal) {
    pendingReveal = false;
    revealWindow();
  }

  const hideWindow = guarded('скрытие окна', () => {
    if (win.isDestroyed() || !win.isVisible()) return;
    win.hide();
    if (hideExplained || !Notification.isSupported()) return;
    hideExplained = true;
    new Notification({
      title: 'Cockpit свёрнут в трей',
      body: 'Управление ушло на другую машину. Значок в трее вернёт окно.',
    }).show();
  });

  const toggleAutostart = guarded('переключение автозапуска', () => {
    // C3 (ревью): читать app.getLoginItemSettings().openAtLogin НАПРЯМУЮ
    // нельзя — на Windows он равен false даже при живой записи в реестре (см.
    // разбор в autostart.js). Из-за этого toggleAutostart каждый раз видел
    // «выключено» и каждый раз ВКЛЮЧАЛ: выключить автозапуск из меню трея
    // было невозможно в принципе, а галочка всегда выглядела снятой.
    const enabled = isAutostartOn(app.getLoginItemSettings());
    app.setLoginItemSettings({
      openAtLogin: !enabled,
      ...buildLoginItem({
        packaged: app.isPackaged, execPath: process.execPath, appRoot: appRoot(),
      }),
    });
    refreshTray();
  });

  const trayClick = guarded('пункт меню трея', (id) => {
    if (id === 'show') showWindow();
    else if (id === 'address') {
      const address = netServer ? netServer.address() : null;
      // Minor 1: возвращаем промис shell.openExternal() наружу, чтобы guarded
      // выше мог поймать его reject — если fn его не вернёт, ловить нечего.
      if (address) return shell.openExternal(address);
    } else if (id === 'autostart') toggleAutostart();
    else if (id === 'quit') { quitting = true; app.quit(); }
    return undefined;
  });

  const refreshTray = guarded('перерисовка трея', () => {
    if (!tray || tray.isDestroyed()) return;
    const model = buildTrayModel({
      owner: ownership ? ownership.owner() : 'local',
      online: ownership ? ownership.ownerOnline() : true,
      // Адрес спрашиваем у самого сервера каждый раз: при port:0 он эфемерный,
      // а после неудачного старта сервер может подняться позже, с повторной
      // попытки (startNetServerWithRetries в ipc.js).
      address: netServer ? netServer.address() : null,
      netStarting,
      autostart: isAutostartOn(app.getLoginItemSettings()),
    });
    tray.setImage(path.join(appRoot(), 'assets', model.icon));
    tray.setToolTip(model.tooltip);
    tray.setContextMenu(Menu.buildFromTemplate(model.items.map((item) => {
      if (item.type === 'separator') return { type: 'separator' };
      const entry = { label: item.label, enabled: item.enabled !== false };
      if (item.type === 'checkbox') { entry.type = 'checkbox'; entry.checked = item.checked; }
      entry.click = () => trayClick(item.id);
      return entry;
    })));
  });

  // Деструктуризация в скобки: без них `({ broadcast } = ...)` на верхнем
  // уровне statement распарсился бы как блок кода, не присваивание —
  // переносим ЗДЕСЬ, а не в объявление, потому что broadcast — уже
  // объявленная выше переменная (нужна раньше, в focusTab), а не новая.
  ({ broadcast, netServer, ownership } = registerIpc(win, {
    smoke: SMOKE,
    attention,
    toaster,
    onOwnerChange: (owner) => {
      if (owner === 'local') showWindow(); else hideWindow();
      refreshTray();
    },
  }));
  setBroadcast(broadcast);

  // Трей создаём ПОСЛЕ registerIpc: refreshTray спрашивает и владельца, и
  // адрес сервера, а оба рождаются там.
  tray = new Tray(nativeImage.createFromPath(path.join(appRoot(), 'assets', 'tray-local.ico')));
  tray.on('click', () => showWindow());
  refreshTray();

  // I7 (ревью): здесь стоял ОДИН setTimeout(refreshTray, 3000). А сетевой
  // сервер поднимается с повторами — 6 попыток по 5с (startNetServerWithRetries
  // в ipc.js), то есть штатно встаёт на 5-25-й секунде, если проиграл гонку с
  // поднятием интерфейса Tailscale. Всё это время в трее висело «Сеть
  // недоступна», и чинилось это только следующей перерисовкой — то есть когда
  // кто-нибудь заберёт управление. Для фичи, весь смысл которой «набери этот
  // адрес на другом устройстве», это и есть отказ.
  //
  // Ждём ровно столько, сколько сервер вправе подниматься (плюс запас), и
  // прекращаем сразу, как адрес появился: это трей, а не монитор — вечного
  // поллинга здесь нет. Проба сама по себе дешёвая (server.listening), тяжёлый
  // refreshTray с чтением реестра зовётся только на реальном изменении.
  const NET_PROBE_MS = 2000;
  const netWaitUntil = Date.now() + 70000; // 6 повторов * 5с + запас на сам listen
  function probeNetAddress() {
    if (!tray || tray.isDestroyed()) return;
    const address = netServer ? netServer.address() : null;
    if (!address && Date.now() < netWaitUntil) {
      setTimeout(probeNetAddress, NET_PROBE_MS).unref();
      return;
    }
    // Либо адрес появился, либо ждать больше нечего: и то, и другое — конец
    // ожидания, дальше строка адреса честна без всякого опроса.
    netStarting = false;
    refreshTray();
  }
  setTimeout(probeNetAddress, NET_PROBE_MS).unref();

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
    setTimeout(async () => {
      const ptyOutput = getSmokeOutput();
      console.log(`[smoke] pty=${ptyOutput.slice(0, 80)}`);
      // Живая приёмка 01.08 («Наготове»): сайдбар — единственная часть, у
      // которой нет юнит-тестов (DOM без jsdom), а правка была именно в нём.
      // Спрашиваем настоящее окно: секция на месте, и вкладка без единого
      // хук-события лежит ИМЕННО в ней, а не в «Работают».
      let sidebar = '{"error":"не опрошен"}';
      try {
        sidebar = await win.webContents.executeJavaScript(`(() => {
          const head = document.querySelector('[data-group="ready"]');
          const count = (g) => {
            const b = document.querySelector('[data-body="' + g + '"]');
            return b ? b.children.length : -1;
          };
          return JSON.stringify({
            section: head ? head.textContent.replace(/\\s+/g, ' ').trim() : null,
            waiting: count('waiting'), working: count('working'),
            done: count('done'), trouble: count('trouble'), ready: count('ready'),
            rows: document.querySelectorAll('#tab-groups .tab-row').length,
          });
        })()`);
      } catch (err) {
        sidebar = `{"error":${JSON.stringify(String(err && err.message))}}`;
      }
      console.log(`[smoke] sidebar=${sidebar}`);
      console.log(`[smoke] renderer-errors=${rendererErrors}`);
      flushWorkspace();
      disposeSessions();
      let sidebarOk = false;
      try {
        const s = JSON.parse(sidebar);
        // Строка в сайдбаре при smoke РОВНО ОДНА: воркспейс не
        // восстанавливается, но boot() открывает вкладку на config.terminal.cwd
        // — это и есть тот pty, что печатает PTY_OK выше. Её процесс
        // (cmd.exe /c echo) завершается сразу, значит к моменту опроса она
        // обязана лежать в «Проблемах» — и это живая проверка всей цепочки
        // groupOf → placeRow → refreshGroups на настоящем DOM, а не только
        // наличия разметки.
        //
        // Первая версия этой проверки (Important 3 ревью) утверждала
        // «working === 0» и объясняла это тем, что строк нет вовсе. Строка
        // есть, а «Работают» пуста по совсем другой причине — вкладка успела
        // умереть; проверка была зелёной при любой раскладке, включая
        // сломанную.
        sidebarOk = typeof s.section === 'string' && s.section.startsWith('Наготове')
          && s.rows === 1 && s.trouble === 1
          && s.working === 0 && s.ready === 0 && s.waiting === 0 && s.done === 0;
      } catch { sidebarOk = false; }
      const ok = rendererErrors === 0 && ptyOutput.includes('PTY_OK') && sidebarOk;
      app.exit(ok ? 0 : 1);
    }, 8000);
  }
});

// Minor (ревью): tray.destroy() не звался ни на одном пути выхода. На Windows
// значок мёртвого процесса остаётся в трее призраком до тех пор, пока по нему
// не проведут мышью — оболочка убирает такие значки лениво. Идемпотентно:
// зовётся из всех трёх обработчиков выхода ниже, любой из которых может
// сработать первым (и не сработать вовсе — например, при app.exit() в смоуке,
// где трея и нет).
function destroyTray() {
  if (!tray) return;
  try {
    if (!tray.isDestroyed()) tray.destroy();
  } catch { /* значок уже снят — не повод падать на выходе */ }
  tray = null;
}

app.on('window-all-closed', () => {
  destroyTray();
  flushWorkspace();
  disposeSessions();
  // Задача 7: гасим сетевой сервер здесь же, рядом с disposeSessions() —
  // без этого порт (48300 по умолчанию) остаётся занятым процессом Electron
  // до его полного завершения, и повторный npm start до этого момента падал
  // бы на EADDRINUSE. Гард на случай, если выход случился раньше, чем
  // registerIpc() успел создать сервер.
  if (netServer) netServer.stop();
  app.quit();
});

app.on('before-quit', () => {
  // Любой путь выхода (меню трея, app.quit() из чужого кода, завершение
  // сеанса Windows) обязан пройти мимо preventDefault в win.on('close') —
  // иначе приложение просто не закроется и человек будет снимать его
  // диспетчером задач.
  quitting = true;
  destroyTray();
  flushWorkspace();
  disposeSessions();
  if (netServer) netServer.stop();
});

process.on('uncaughtException', (e) => {
  console.error(e);
  destroyTray();
  flushWorkspace();
  disposeSessions();
  if (netServer) netServer.stop();
  app.exit(1);
});
