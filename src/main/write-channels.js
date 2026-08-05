'use strict';
// Что невладелец делать не может. Свободно только ЧТЕНИЕ и то, что не выходит
// за пределы его собственного экрана: статусы, лимиты, история вывода, поиск.
// Иначе заглушка на неактивной машине была бы слепой и человек не понимал бы,
// что вообще происходит на той стороне.
//
// Первая редакция была заметно щедрее, и ревью показало цену: невладелец мог
// удалить рецепт или воркспейс владельца, переписать `.claude/settings.json` в
// его проекте (project:connect), подменить `terminal.command` через config:set
// — то есть команду, которой владелец поднимет СЛЕДУЮЩУЮ вкладку, — открыть у
// него в браузере произвольную ссылку, DevTools и системный диалог выбора
// папки поверх окна, которое в этот момент спрятано в трей. Всё это проверено
// живьём: `config:set` от невладельца возвращал ok:true и менял конфиг.
// Принцип теперь буквальный: команда, которая что-то меняет на машине владельца
// или показывает ему окно, — пишущая.
//
// Списки ЯВНЫЕ, оба. Тест полноты (test/write-channels.test.js) требует, чтобы
// каждый канал формы api попал ровно в один из них: новая команда, добавленная
// через полгода, обязана уронить прогон, а не молча получить право писать.
const WRITE_CHANNELS = new Set([
  'term:start', 'term:write', 'term:resize', 'term:restart',
  'tabs:open', 'tabs:close',
  // Открывает СИСТЕМНЫЙ диалог на машине владельца — окно которой в этот
  // момент спрятано в трей: модалка повиснет там, где никого нет.
  'tabs:chooseFolder',
  'queue:add', 'queue:remove', 'queue:clear',
  'stt:transcribe',
  'ghost:save',
  'workspace:setActive',
  // Меняет общий конфиг, включая terminal.command/args: подмена команды,
  // которой владелец поднимет следующую вкладку.
  'config:set',
  // Пишут на диск владельца: библиотека рецептов и именованные воркспейсы.
  'recipes:savePrompt', 'recipes:deletePrompt',
  'recipes:saveWorkspace', 'recipes:deleteWorkspace',
  // Переписывает .claude/settings.json в проекте владельца.
  'project:connect',
  // Глобальный режим: ночная смена сама вбрасывает промпты в чужие вкладки.
  'night:toggle',
  // Открывают на машине владельца окно, которого он не просил.
  'shell:openExternal', 'app:devtools',
]);

const FREE_CHANNELS = new Set([
  'config:get',
  'tabs:list', 'tabs:seen',
  'net:buffer',
  'project:status',
  'git:get', 'gh:repo', 'gh:global',
  'workspace:get', 'workspace:ready',
  'ghost:load', 'attention:update',
  // Читает буфер обмена той машины, за которой сидит человек, и возвращает
  // путь — на владельца не влияет никак.
  'screenshot:paste',
  'history:search', 'history:refresh',
  'recipes:list', 'recipes:fillPrompt', 'recipes:normalizeForPty',
  'recipes:listWorkspaces',
  'night:get',
  'usage:get', 'usage:refresh',
  'stt:status',
  // Захват управления обязан быть доступен тому, у кого управления нет, —
  // иначе забрать его невозможно в принципе.
  'owner:claim', 'owner:get',
]);

// Незнакомое имя считаем пишущим: ошибка в эту сторону стоит одного отказа,
// в другую — чужой команды в живом терминале. Поэтому в рантайме участвует
// только FREE_CHANNELS; WRITE_CHANNELS нужен тесту полноты и человеку, который
// будет читать этот файл через полгода.
function isWriteChannel(channel) {
  if (FREE_CHANNELS.has(channel)) return false;
  return true;
}

module.exports = { isWriteChannel, WRITE_CHANNELS, FREE_CHANNELS };
