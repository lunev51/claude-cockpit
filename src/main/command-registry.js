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

// guard({channel, who}) → можно ли этот вызов. Инжектируется, а не импортируется:
// реестр не должен знать ни про эстафету, ни про список пишущих каналов — иначе
// его нельзя было бы тестировать без них. who — 'local' для окна ПК и имя сокета
// для сетевого клиента.
function createCommandRegistry({ ipcMain, guard } = {}) {
  const handlers = new Map(); // channel → { kind: 'invoke' | 'send', fn }

  // Спрашиваем гард на КАЖДЫЙ вызов, а не один раз при регистрации: владение
  // меняется в рантайме, и клиент, которому только что отказали, через секунду
  // может стать хозяином.
  const allowed = (channel, who) => (typeof guard === 'function' ? guard({ channel, who }) : true);

  // Обработчики в ipc.js написаны как (event, payload). Обёртка отбрасывает
  // event, чтобы сетевой вызов передавал РОВНО те же аргументы, что локальный:
  // иначе два транспорта незаметно разъедутся в сигнатурах.
  function handle(channel, fn) {
    handlers.set(channel, { kind: 'invoke', fn });
    ipcMain.handle(channel, (_event, ...args) => {
      // Локальный отказ — молчаливый null. Бросать в окно нельзя: renderer
      // показал бы ошибку там, где по замыслу просто ничего не происходит
      // (спека: команда от клиента без управления отклоняется молча).
      if (!allowed(channel, 'local')) return null;
      return fn(...args);
    });
  }

  function on(channel, fn) {
    handlers.set(channel, { kind: 'send', fn });
    ipcMain.on(channel, (_event, ...args) => {
      if (!allowed(channel, 'local')) return;
      fn(...args);
    });
  }

  async function call(channel, args = [], who = 'local') {
    const entry = handlers.get(channel);
    if (!entry) throw new Error(`неизвестная команда: ${channel}`);
    if (!allowed(channel, who)) {
      // Отдельное поле, а не разбор текста сообщения: сетевой транспорт по нему
      // отличает штатный отказ эстафеты от поломки команды и молчит вместо
      // показа ошибки.
      throw Object.assign(new Error('нет управления'), { denied: true });
    }
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
