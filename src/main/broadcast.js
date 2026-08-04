'use strict';
// Единственная точка исходящих событий кокпита.
//
// Зачем. События уходили прямыми win.webContents.send из нескольких мест
// ipc.js. Сетевому клиенту пришлось бы перехватывать каждое такое место, а
// любое НОВОЕ молча проходило бы мимо сети — класс ошибки, который замечаешь
// через месяц и не понимаешь, почему с макбука «иногда не обновляется».
//
// getWindow — функция, а не окно: на момент сборки окна может ещё не быть, а
// при перезапуске оно меняется.
function createBroadcast({ getWindow }) {
  const clients = new Set();

  function emit(channel, payload) {
    const win = typeof getWindow === 'function' ? getWindow() : null;
    if (win && !win.isDestroyed()) {
      try { win.webContents.send(channel, payload); } catch { /* окно уходит — не наша забота */ }
    }
    // Копия набора: клиент может отписаться прямо из обработчика (оборвался сокет).
    for (const client of [...clients]) {
      // Падение одного клиента не должно останавливать остальных: оборванный
      // макбук не имеет права глушить поток вывода в локальное окно.
      try { client(channel, payload); } catch { /* мёртвый клиент отвалится сам */ }
    }
  }

  return {
    emit,
    addClient: (fn) => { clients.add(fn); },
    removeClient: (fn) => { clients.delete(fn); },
    clientCount: () => clients.size,
  };
}

module.exports = { createBroadcast };
