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
    // Живые вкладки менеджера (C1 финального ревью ветки): renderer при
    // загрузке спрашивает их ПЕРВЫМИ и, если они есть, ПОДКЛЮЧАЕТСЯ к ним
    // вместо оверлея восстановления — иначе каждое подключение (браузер с
    // макбука, второе окно, Ctrl+R при живом main) звало tabs:open и плодило
    // вторую вкладку с новым tabId на ту же самую сессию Claude.
    list: () => ipcRenderer.invoke('tabs:list'),
    close: (tabId) => ipcRenderer.invoke('tabs:close', tabId),
    chooseFolder: () => ipcRenderer.invoke('tabs:chooseFolder'),
    // «Я это увидел»: вкладка из «Готово» уезжает в «Наготове» (живая приёмка
    // 01.08 — «Готово» стало списком непрочитанного). Решает renderer, потому
    // что только он знает, что показано на экране и есть ли у окна фокус;
    // ядро на этом сообщении лишь двигает статус и гардит его (markSeen).
    markSeen: (tabId) => ipcRenderer.send('tabs:seen', { tabId }),
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
  net: {
    // История вывода вкладки (C2 финального ревью ветки): хвост из
    // output-buffer.js, который подключившийся клиент печатает в свежий xterm
    // ДО первого живого term:data. В Electron этот путь тоже настоящий:
    // перезагрузка renderer (Ctrl+R) при живом main оставляет вкладки
    // работающими, а окно получает пустой терминал.
    buffer: (tabId) => ipcRenderer.invoke('net:buffer', tabId),
  },
  fs: {
    // Файловый обзор (план 3): свой экран выбора папки вместо системного
    // диалога — тот при удалённой работе открылся бы на ПК, где никого нет,
    // да ещё поверх окна, спрятанного в трей. Каталоги читает main
    // (fs-browse.js), renderer только рисует.
    list: (dirPath) => ipcRenderer.invoke('fs:list', dirPath),
    drives: () => ipcRenderer.invoke('fs:drives'),
  },
  owner: {
    // Эстафета (план 2 фазы «кокпит по сети»): управление в каждый момент у
    // одного клиента — окна ПК или одного браузера. Захват без подтверждений:
    // показал окно / открыл страницу — забрал.
    //
    // claim шлёт ОДИН объект {cols,rows}: сетевая половина (api-shape.js) для
    // этого канала помечена pack:['cols','rows'], иначе по сети уехал бы
    // позиционный список и main получил бы число вместо размера.
    claim: (cols, rows) => ipcRenderer.invoke('owner:claim', { cols, rows }),
    get: () => ipcRenderer.invoke('owner:get'),
    onChanged: (cb) => ipcRenderer.on('owner:changed', (_e, p) => cb(p)),
    // net:hello бывает только у сетевого клиента — окно ПК своё имя знает
    // заранее ('local'). Подписка тем не менее настоящая, а не заглушка:
    // форма api сверяется с этим файлом построчно (test/net-api.test.js), и
    // метод без ipcRenderer выглядел бы для сверки отсутствующим. Событие в
    // Electron просто никогда не приходит.
    onHello: (cb) => ipcRenderer.on('net:hello', (_e, p) => cb(p)),
  },
  app: {
    onNotice: (cb) => ipcRenderer.on('app:notice', (_e, n) => cb(n)),
    // Task 4 фазы 4 (палитра команд): «Открыть DevTools» — main зовёт
    // win.webContents.toggleDevTools() (то же самое, что F12 в main.js).
    devtools: () => ipcRenderer.invoke('app:devtools'),
  },
  project: {
    connect: (tabId) => ipcRenderer.invoke('project:connect', tabId),
    status: (tabId) => ipcRenderer.invoke('project:status', tabId),
  },
  git: {
    // Task 2 фазы 6 (панель диффа): {tabId, {force}} → main резолвит cwd
    // вкладки и зовёт gitInfo.get() (git-info.js, TTL-кэш внутри).
    get: (tabId, opts) => ipcRenderer.invoke('git:get', tabId, opts),
    // git:changed шлёт sessions.js на КАЖДЫЙ PostToolUse (см. main/sessions.js) —
    // тот же generic-мост onEvent→win.webContents.send, что и остальные
    // каналы (tab:status, term:data и т.п.), отдельной проводки в ipc.js не
    // требует.
    onChanged: (cb) => ipcRenderer.on('git:changed', (_e, p) => cb(p)),
  },
  gh: {
    // Task 4 фазы 6 (бейдж PR + дашборд GitHub): {tabId, {force}} → main
    // резолвит cwd вкладки и зовёт ghInfo.getRepo() (gh-info.js, TTL-кэш
    // внутри) — тот же приём, что git.get выше.
    repo: (tabId, opts) => ipcRenderer.invoke('gh:repo', tabId, opts),
    // Сводка по всем открытым PR/issues пользователя + уведомления — без
    // привязки к вкладке (раздел «GitHub» дашборда).
    global: (opts) => ipcRenderer.invoke('gh:global', opts),
  },
  tab: {
    onStatus: (cb) => ipcRenderer.on('tab:status', (_e, p) => cb(p)),
    // Task 2 фазы 4: клик по Windows-тосту — main поднимает окно и шлёт сюда
    // {tabId} вкладки тоста; app.js подписывается и зовёт activateTab(tabId).
    onActivate: (cb) => ipcRenderer.on('tab:activate', (_e, p) => cb(p)),
  },
  workspace: {
    get: () => ipcRenderer.invoke('workspace:get'),
    setActive: (tabId) => ipcRenderer.send('workspace:setActive', { tabId }),
    // FIX 2 (ревью): сигнал main'у, что восстановление воркспейса на старте
    // завершено (или решено начать пусто) — до этого момента синхронизация
    // манифеста заблокирована (см. workspace-sync.js, main/ipc.js).
    ready: () => ipcRenderer.send('workspace:ready'),
  },
  ghost: {
    save: (tabId, text) => ipcRenderer.invoke('ghost:save', { tabId, text }),
    load: (ghostId) => ipcRenderer.invoke('ghost:load', ghostId),
  },
  attention: {
    // Task 1 фазы 4: агрегат «сколько вкладок ждут» → overlay-иконка
    // таскбара + заголовок окна (main/attention.js). dataUrl рисует
    // renderer (badge.js) — main про canvas ничего не знает.
    update: (count, dataUrl) => ipcRenderer.send('attention:update', { count, dataUrl }),
  },
  screenshot: {
    // Task 4 фазы 4: main находит cwd вкладки и решает, картинка в буфере
    // обмена или нет (main/screenshot.js) — возвращает {path} или null.
    paste: (tabId) => ipcRenderer.invoke('screenshot:paste', tabId),
  },
  queue: {
    // Task 1 фазы 7 (очередь промптов): fire-and-forget, тот же приём, что
    // term.write/term.restart — состояние возвращается отдельно через
    // queue:changed (onChanged), а не через возврат invoke().
    add: (tabId, text) => ipcRenderer.send('queue:add', { tabId, text }),
    remove: (tabId, index) => ipcRenderer.send('queue:remove', { tabId, index }),
    clear: (tabId) => ipcRenderer.send('queue:clear', { tabId }),
    onChanged: (cb) => ipcRenderer.on('queue:changed', (_e, p) => cb(p)),
  },
  history: {
    // Task 3 фазы 7 (глобальный поиск истории, Ctrl+Shift+H): main лениво
    // строит индекс при первом реальном вызове (см. main/ipc.js) — {results,
    // indexSize} в non-smoke, null в smoke (ни один хендлер тогда не трогает
    // диск). search.js сам решает, когда звать (дебаунс/минимум 2 символа).
    search: (query, opts) => ipcRenderer.invoke('history:search', query, opts),
    // Явный пересбор индекса ({force}) — задел на будущую кнопку «Обновить
    // индекс»; текущий UI (search.js) полагается на встроенный ленивый
    // пересбор внутри history:search и этот канал напрямую не зовёт.
    refresh: (opts) => ipcRenderer.invoke('history:refresh', opts),
  },
  recipes: {
    // Task 4 фазы 7 (библиотека рецептов промптов + именованные воркспейсы):
    // list() отдаёт [{id,title,text,placeholders}] — placeholders уже
    // посчитаны на стороне main (см. main/ipc.js/'recipes:list'), палитра
    // (app.js/buildPaletteActions) решает по этому полю, показывать ли
    // мини-форму, не тратя отдельный IPC-вызов на каждый рецепт.
    list: () => ipcRenderer.invoke('recipes:list'),
    // savePrompt/deletePrompt — полный CRUD-контракт recipes.js; текущий UI их
    // напрямую не зовёт (палитра только читает list()), задел на будущую
    // форму редактирования библиотеки — тот же приём, что history.refresh выше.
    savePrompt: (p) => ipcRenderer.invoke('recipes:savePrompt', p),
    deletePrompt: (id) => ipcRenderer.invoke('recipes:deletePrompt', id),
    // fillPrompt(text, values) → строка с подставленными {{плейсхолдерами}} —
    // используется ПОСЛЕ мини-формы ввода, перед записью текста в pty
    // активной вкладки (см. app.js/runRecipe).
    fillPrompt: (text, values) => ipcRenderer.invoke('recipes:fillPrompt', text, values),
    // Minor 8 (ревью раунд 1): нормализация \r?\n → пробел перед записью в
    // pty — см. main/ipc.js/'recipes:normalizeForPty' и app.js/runRecipe.
    normalizeForPty: (text) => ipcRenderer.invoke('recipes:normalizeForPty', text),
    listWorkspaces: () => ipcRenderer.invoke('recipes:listWorkspaces'),
    saveWorkspace: (name, tabs) => ipcRenderer.invoke('recipes:saveWorkspace', name, tabs),
    deleteWorkspace: (id) => ipcRenderer.invoke('recipes:deleteWorkspace', id),
  },
  night: {
    // Task 2 фазы 8 («Ночная смена»): toggle() переключает armed и
    // возвращает снапшот ПОСЛЕ переключения; get() — снапшот по запросу
    // (дашборд при открытии); onChanged — push от ядра (main/ipc.js)
    // на КАЖДОЕ изменение состояния (арминг/детект/пробуждение/дизарм и т.п.),
    // тот же стиль, что queue.onChanged/tab.onStatus выше.
    toggle: () => ipcRenderer.invoke('night:toggle'),
    get: () => ipcRenderer.invoke('night:get'),
    onChanged: (cb) => ipcRenderer.on('night:changed', (_e, p) => cb(p)),
  },
  usage: {
    // Task 3 фазы 5 (кольца лимитов): {limits, spend} — снапшот слоя A
    // (usage-oauth.js) и последний известный ответ слоя B (usage-ccusage.js,
    // спрошенный лениво и не чаще TTL внутри самого модуля) или null.
    get: () => ipcRenderer.invoke('usage:get'),
    // Принудительное обновление ОБОИХ слоёв (клик по кольцам, кнопка «Обновить»
    // на дашборде Task 4) — возвращает тот же {limits, spend}, свежий.
    refresh: () => ipcRenderer.invoke('usage:refresh'),
    // main шлёт это после каждого успешно обнаруженного refresh поллера
    // (см. usageMonitorTimer в main/ipc.js) — payload той же формы {limits, spend}.
    onUpdate: (cb) => ipcRenderer.on('usage:update', (_e, p) => cb(p)),
  },
  stt: {
    // Task 2 фазы 9 (голосовой ввод, push-to-talk): transcribe(wav) — wav
    // ArrayBuffer/Uint8Array (recorder.js, Task 3) → main конвертирует в
    // Buffer и зовёт stt.transcribeWav() (stt.js, Task 1) → {text} или
    // {error: string} (НЕ reject — renderer сам показывает тост по полю error).
    transcribe: (wav) => ipcRenderer.invoke('stt:transcribe', wav),
    // status() → {available, backend, warm} — snapshot ядра, без прогрева.
    status: () => ipcRenderer.invoke('stt:status'),
  },
});
