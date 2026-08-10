'use strict';
// Форма window.api: единый список для сетевого моста. Сверяется с preload.js
// тестом ниже — расхождение означает метод, который в браузере просто
// отсутствует и падает в неожиданный момент, а не при загрузке.
//
// pack — только там, где preload.js САМ переупаковывает позиционные
// аргументы renderer в один объект перед ipcRenderer.send/invoke (например
// `write: (tabId, data) => ipcRenderer.send('term:write', { tabId, data })`).
// Без этого поля net-api.js отправил бы список ['T1','ls\r'], сервер сделал
// бы fn(...args) и main-обработчик получил бы 'T1' вместо {tabId,data} —
// команда пропала бы молча (ревью задачи 6, Critical 2). Имена и порядок
// полей — дословно из preload.js, не восстановлены по догадке.
export const API_SHAPE = {
  'config.get': { channel: 'config:get', kind: 'invoke' },
  'config.set': { channel: 'config:set', kind: 'invoke' },
  'tabs.open': { channel: 'tabs:open', kind: 'invoke' },
  // C1 финального ревью: список ЖИВЫХ вкладок — без него сетевой клиент не
  // мог узнать tabId работающих сессий и умел только заводить новые.
  'tabs.list': { channel: 'tabs:list', kind: 'invoke' },
  'tabs.close': { channel: 'tabs:close', kind: 'invoke' },
  'tabs.chooseFolder': { channel: 'tabs:chooseFolder', kind: 'invoke' },
  'tabs.markSeen': { channel: 'tabs:seen', kind: 'send', pack: ['tabId'] },
  'term.start': { channel: 'term:start', kind: 'send', pack: ['tabId', 'cols', 'rows'] },
  'term.write': { channel: 'term:write', kind: 'send', pack: ['tabId', 'data'] },
  'term.resize': { channel: 'term:resize', kind: 'send', pack: ['tabId', 'cols', 'rows'] },
  'term.restart': { channel: 'term:restart', kind: 'send', pack: ['tabId'] },
  'term.onData': { channel: 'term:data', kind: 'event' },
  'term.onExit': { channel: 'term:exit', kind: 'event' },
  'term.onStarted': { channel: 'term:started', kind: 'event' },
  'shell.openExternal': { channel: 'shell:openExternal', kind: 'invoke' },
  // C2 финального ревью: история вывода вкладки. Канал жил ТОЛЬКО на сервере
  // (net-server.js), в этой форме его не было — и подключившийся клиент видел
  // пустой терминал, то есть задача 4 (кольцевой буфер) работала в стол.
  'net.buffer': { channel: 'net:buffer', kind: 'invoke' },
  // Файловый обзор (план 3): каталоги читает main, renderer только рисует.
  'fs.list': { channel: 'fs:list', kind: 'invoke' },
  'fs.drives': { channel: 'fs:drives', kind: 'invoke' },
  // Эстафета (план 2). pack ОБЯЗАТЕЛЕН для claim: без него net-api.js отправит
  // позиционный список [cols, rows], сервер возьмёт args[0] — и захват получит
  // ЧИСЛО вместо размера. Ровно этот класс ошибки был Critical 2 задачи 6.
  'owner.claim': { channel: 'owner:claim', kind: 'invoke', pack: ['cols', 'rows'] },
  'owner.get': { channel: 'owner:get', kind: 'invoke' },
  'owner.onChanged': { channel: 'owner:changed', kind: 'event' },
  // Только для сетевого клиента: имя, под которым его знает сервер. В Electron
  // такого события не бывает — preload подставляет заглушку.
  'owner.onHello': { channel: 'net:hello', kind: 'event' },
  'app.onNotice': { channel: 'app:notice', kind: 'event' },
  'app.devtools': { channel: 'app:devtools', kind: 'invoke' },
  // Видимость ОКНА ПК (ревью 09.08, B7). Нужна, потому что document.hidden в
  // этом окне ненадёжен: оно создаётся с backgroundThrottling:false, и по
  // документации Electron состояние остаётся visible даже когда окно скрыто,
  // а автозапуск с --hidden (show:false) и вовсе даёт visible у окна, которое
  // человек ни разу не видел. Сетевому клиенту это событие не про него — у
  // браузера есть собственный document.hidden.
  'window.isVisible': { channel: 'window:visible', kind: 'invoke' },
  'window.onVisibility': { channel: 'window:visibility', kind: 'event' },
  'project.connect': { channel: 'project:connect', kind: 'invoke' },
  'project.status': { channel: 'project:status', kind: 'invoke' },
  'git.get': { channel: 'git:get', kind: 'invoke' },
  'git.onChanged': { channel: 'git:changed', kind: 'event' },
  'gh.repo': { channel: 'gh:repo', kind: 'invoke' },
  'gh.global': { channel: 'gh:global', kind: 'invoke' },
  // Состав вкладок изменился (у кого угодно: у нас, у соседа, автоматикой).
  // Живая жалоба 08.08: сессия, заведённая с макбука, на ПК не появлялась —
  // событие main рассылал всем с начала фазы, а формы api для него не было,
  // и интерфейс просто не подписывался.
  'tabs.onChanged': { channel: 'tabs:changed', kind: 'event' },
  'tab.onStatus': { channel: 'tab:status', kind: 'event' },
  'tab.onActivate': { channel: 'tab:activate', kind: 'event' },
  'workspace.get': { channel: 'workspace:get', kind: 'invoke' },
  'workspace.setActive': { channel: 'workspace:setActive', kind: 'send', pack: ['tabId'] },
  'workspace.ready': { channel: 'workspace:ready', kind: 'send' },
  'ghost.save': { channel: 'ghost:save', kind: 'invoke', pack: ['tabId', 'text'] },
  'ghost.load': { channel: 'ghost:load', kind: 'invoke' },
  'attention.update': { channel: 'attention:update', kind: 'send', pack: ['count', 'dataUrl'] },
  'screenshot.paste': { channel: 'screenshot:paste', kind: 'invoke' },
  'queue.add': { channel: 'queue:add', kind: 'send', pack: ['tabId', 'text'] },
  'queue.remove': { channel: 'queue:remove', kind: 'send', pack: ['tabId', 'index'] },
  'queue.clear': { channel: 'queue:clear', kind: 'send', pack: ['tabId'] },
  'queue.onChanged': { channel: 'queue:changed', kind: 'event' },
  'history.search': { channel: 'history:search', kind: 'invoke' },
  'history.refresh': { channel: 'history:refresh', kind: 'invoke' },
  'recipes.list': { channel: 'recipes:list', kind: 'invoke' },
  'recipes.savePrompt': { channel: 'recipes:savePrompt', kind: 'invoke' },
  'recipes.deletePrompt': { channel: 'recipes:deletePrompt', kind: 'invoke' },
  'recipes.fillPrompt': { channel: 'recipes:fillPrompt', kind: 'invoke' },
  'recipes.normalizeForPty': { channel: 'recipes:normalizeForPty', kind: 'invoke' },
  'recipes.listWorkspaces': { channel: 'recipes:listWorkspaces', kind: 'invoke' },
  'recipes.saveWorkspace': { channel: 'recipes:saveWorkspace', kind: 'invoke' },
  'recipes.deleteWorkspace': { channel: 'recipes:deleteWorkspace', kind: 'invoke' },
  'night.toggle': { channel: 'night:toggle', kind: 'invoke' },
  'night.get': { channel: 'night:get', kind: 'invoke' },
  'night.onChanged': { channel: 'night:changed', kind: 'event' },
  'usage.get': { channel: 'usage:get', kind: 'invoke' },
  'usage.refresh': { channel: 'usage:refresh', kind: 'invoke' },
  'usage.onUpdate': { channel: 'usage:update', kind: 'event' },
  'stt.transcribe': { channel: 'stt:transcribe', kind: 'invoke' },
  'stt.status': { channel: 'stt:status', kind: 'invoke' },
};
