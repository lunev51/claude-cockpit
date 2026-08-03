'use strict';
// Сборка window.api поверх WebSocket — вся разница между «мы в Electron» и
// «мы в браузере на макбуке» живёт здесь. Renderer её не видит: он знает
// только форму window.api и не подозревает про Electron (проверено — в нём
// нет ни require, ни process, ни __dirname).
//
// shape описывает форму api: путь через точку → канал и вид вызова.
// invoke — с ответом, send — без, event — подписка.
export function createNetApi({ socket, shape }) {
  const pending = new Map(); // id → {resolve, reject}
  const subscribers = new Map(); // канал события → [функции]
  let nextId = 1;

  socket.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.event) {
      for (const fn of subscribers.get(msg.event) || []) {
        // Падение одного подписчика не должно рвать поток остальным.
        try { fn(msg.payload); } catch { /* его беда */ }
      }
      return;
    }
    const waiter = pending.get(msg.id);
    // Ответ на неизвестный id — нормальная ситуация после переподключения:
    // молчим, а не падаем.
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.ok) waiter.resolve(msg.result);
    else waiter.reject(new Error(msg.error || 'сетевая команда не удалась'));
  });

  function send(channel, args) {
    const id = nextId;
    nextId += 1;
    socket.send(JSON.stringify({ id, channel, args }));
    return id;
  }

  const api = {};
  for (const [dotted, spec] of Object.entries(shape)) {
    const [group, name] = dotted.split('.');
    if (!api[group]) api[group] = {};
    if (spec.kind === 'invoke') {
      api[group][name] = (...args) => new Promise((resolve, reject) => {
        pending.set(send(spec.channel, args), { resolve, reject });
      });
    } else if (spec.kind === 'send') {
      api[group][name] = (...args) => { send(spec.channel, args); };
    } else {
      api[group][name] = (fn) => {
        if (!subscribers.has(spec.channel)) subscribers.set(spec.channel, []);
        subscribers.get(spec.channel).push(fn);
      };
    }
  }
  return api;
}
