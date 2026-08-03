'use strict';
// Реестр команд: единая точка регистрации обработчиков.
//
// Зачем. Обработчики ipcMain недостижимы ниоткуда, кроме самого ipcMain, —
// поэтому сетевой клиент не мог бы позвать ничего, не дублируя их. Реестр
// кладёт обработчик СРАЗУ в два места: в ipcMain (локальное окно продолжает
// работать буквально как раньше) и в карту имён (сетевой транспорт зовёт по
// имени канала). Логика самих обработчиков не меняется ни на строку.
//
// ipcMain инжектируется, а не подключается здесь: так модуль остаётся чистым
// и тестируется без Electron.

function createCommandRegistry({ ipcMain }) {
  const handlers = new Map(); // channel → { kind: 'invoke' | 'send', fn }

  // Обработчики в ipc.js написаны как (event, payload). Обёртка отбрасывает
  // event, чтобы сетевой вызов передавал РОВНО те же аргументы, что локальный:
  // иначе два транспорта незаметно разъедутся в сигнатурах.
  function handle(channel, fn) {
    handlers.set(channel, { kind: 'invoke', fn });
    ipcMain.handle(channel, (_event, ...args) => fn(...args));
  }

  function on(channel, fn) {
    handlers.set(channel, { kind: 'send', fn });
    ipcMain.on(channel, (_event, ...args) => fn(...args));
  }

  async function call(channel, args = []) {
    const entry = handlers.get(channel);
    if (!entry) throw new Error(`неизвестная команда: ${channel}`);
    return entry.fn(...args);
  }

  return {
    handle,
    on,
    call,
    has: (channel) => handlers.has(channel),
    names: () => [...handlers.keys()],
  };
}

module.exports = { createCommandRegistry };
