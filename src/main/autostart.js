'use strict';
// Чем Windows запускает кокпит при входе. Вынесено из main.js отдельным
// модулем ровно из-за разницы между «собрано» и «разработка»: в проде
// execPath — сам кокпит, в разработке — electron.exe, который без пути к
// проекту поднимет пустое окно Electron и человек решит, что автозапуск сломан.
function buildLoginItem({ packaged, execPath, appRoot }) {
  return {
    path: execPath,
    args: packaged ? ['--hidden'] : [appRoot, '--hidden'],
  };
}

module.exports = { buildLoginItem };
