'use strict';
// Что невладелец делать не может. Принцип: запрещаем ровно то, чем можно
// испортить работу тому, кто сейчас за рулём, — ввод в pty, вкладки, очередь,
// голос и черновики. Чтение статусов, лимитов и истории идёт всем: без этого
// заглушка на неактивной машине была бы слепой и человек не понимал бы, что
// вообще происходит на той стороне.
//
// Списки ЯВНЫЕ, оба. Тест полноты (test/write-channels.test.js) требует, чтобы
// каждый канал формы api попал ровно в один из них: новая команда, добавленная
// через полгода, обязана уронить прогон, а не молча получить право писать.
const WRITE_CHANNELS = new Set([
  'term:start', 'term:write', 'term:resize', 'term:restart',
  'tabs:open', 'tabs:close',
  'queue:add', 'queue:remove', 'queue:clear',
  'stt:transcribe',
  'ghost:save',
  'workspace:setActive',
]);

const FREE_CHANNELS = new Set([
  'config:get', 'config:set',
  'tabs:list', 'tabs:chooseFolder', 'tabs:seen',
  'shell:openExternal', 'net:buffer', 'app:devtools',
  'project:connect', 'project:status',
  'git:get', 'gh:repo', 'gh:global',
  'workspace:get', 'workspace:ready',
  'ghost:load', 'attention:update', 'screenshot:paste',
  'history:search', 'history:refresh',
  'recipes:list', 'recipes:savePrompt', 'recipes:deletePrompt',
  'recipes:fillPrompt', 'recipes:normalizeForPty',
  'recipes:listWorkspaces', 'recipes:saveWorkspace', 'recipes:deleteWorkspace',
  'night:toggle', 'night:get',
  'usage:get', 'usage:refresh',
  'stt:status',
  // Захват управления обязан быть доступен тому, у кого управления нет, —
  // иначе забрать его невозможно в принципе.
  'owner:claim', 'owner:get',
]);

// Незнакомое имя считаем пишущим: ошибка в эту сторону стоит одного отказа,
// в другую — чужой команды в живом терминале.
function isWriteChannel(channel) {
  if (FREE_CHANNELS.has(channel)) return false;
  return true;
}

module.exports = { isWriteChannel, WRITE_CHANNELS, FREE_CHANNELS };
