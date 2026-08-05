'use strict';
// Что показывает трей. Чистый модуль: Electron собирает по этому описанию
// настоящее Menu, но решение «какой пункт, какая иконка, какой текст»
// принимается здесь и проверяется node --test.
// netStarting — «сервер ещё имеет право подняться» (он стартует с повторами,
// см. startNetServerWithRetries в ipc.js). Без него единственной альтернативой
// адресу было «Сеть недоступна» — неправда в первые полминуты после запуска.
function buildTrayModel({
  owner, online, address, autostart, netStarting = false,
}) {
  const local = owner === 'local';
  let status;
  if (local) status = 'Управление здесь';
  else if (online) status = 'Управление на другой машине';
  else status = 'Управление на другой машине (не на связи)';

  return {
    icon: local ? 'tray-local.ico' : 'tray-remote.ico',
    tooltip: `Cockpit — ${status.toLowerCase()}`,
    items: [
      { id: 'status', label: status, enabled: false },
      address
        ? { id: 'address', label: address, enabled: true }
        : {
          id: 'address',
          label: netStarting ? 'Сеть поднимается…' : 'Сеть недоступна',
          enabled: false,
        },
      { type: 'separator' },
      { id: 'show', label: 'Показать окно' },
      {
        id: 'autostart', label: 'Запускать при входе в Windows', type: 'checkbox', checked: !!autostart,
      },
      { type: 'separator' },
      { id: 'quit', label: 'Выход' },
    ],
  };
}

module.exports = { buildTrayModel };
