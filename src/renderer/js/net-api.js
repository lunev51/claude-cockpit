'use strict';
// Сборка window.api поверх WebSocket — вся разница между «мы в Electron» и
// «мы в браузере на макбуке» живёт здесь. Renderer её не видит: он знает
// только форму window.api и не подозревает про Electron (проверено — в нём
// нет ни require, ни process, ни __dirname).
//
// shape описывает форму api: путь через точку → канал, вид вызова и,
// опционально, pack — потому что 11 методов preload.js не шлют позиционные
// аргументы списком, а СОБИРАЮТ их в один объект перед ipcRenderer.send/invoke
// (например term.write(tabId, data) → {tabId, data}). Сервер задачи 5 зовёт
// обработчик как fn(...args) — без pack он получил бы 'T1' вместо
// {tabId:'T1', data:'ls\r'} и команда пропала бы молча (см. ниже packArgs;
// ревью задачи 6, Critical 2, список полей сверен построчно с preload.js).
const CONNECTION_LOST = 'соединение с сервером потеряно';

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

  // Обрыв связи (закрытие или ошибка сокета) — все, кто уже ждёт ответа,
  // иначе повисли бы навсегда: на макбуке интерфейс замер бы без объяснений
  // (ревью задачи 6, Important 2). И close, и error закрывают сокет — второй
  // отказ по уже опустошённой pending попросту ничего не делает.
  function rejectAllPending() {
    const err = new Error(CONNECTION_LOST);
    for (const { reject } of pending.values()) reject(err);
    pending.clear();
  }
  socket.addEventListener('close', rejectAllPending);
  socket.addEventListener('error', rejectAllPending);

  function send(channel, args) {
    const id = nextId;
    nextId += 1;
    // readyState !== OPEN — сокет уже мёртв (закрывается/закрыт), слать
    // некуда: реальный WebSocket в этом состоянии либо бросает, либо тихо
    // теряет кадр. id всё равно возвращаем — pending на него не заводим
    // (см. вызовы ниже), так что теряться нечему.
    if (socket.readyState === 1) socket.send(JSON.stringify({ id, channel, args }));
    return id;
  }

  // Переупаковка позиционных args в объект по именам полей — ТОЛЬКО когда
  // у метода есть spec.pack (список имён в порядке параметров, взят из
  // preload.js дословно). Без pack аргументы идут как есть — так работает
  // большинство методов (main-обработчик получает их через fn(...args)).
  function packArgs(spec, args) {
    if (!spec.pack) return args;
    const obj = {};
    spec.pack.forEach((key, i) => { obj[key] = args[i]; });
    return [obj];
  }

  const api = {};
  for (const [dotted, spec] of Object.entries(shape)) {
    const [group, name] = dotted.split('.');
    if (!api[group]) api[group] = {};
    if (spec.kind === 'invoke') {
      api[group][name] = (...args) => new Promise((resolve, reject) => {
        if (socket.readyState !== 1) { reject(new Error(CONNECTION_LOST)); return; }
        pending.set(send(spec.channel, packArgs(spec, args)), { resolve, reject });
      });
    } else if (spec.kind === 'send') {
      api[group][name] = (...args) => {
        if (socket.readyState !== 1) return; // некуда посылать — молча, это fire-and-forget по контракту
        send(spec.channel, packArgs(spec, args));
      };
    } else {
      api[group][name] = (fn) => {
        if (!subscribers.has(spec.channel)) subscribers.set(spec.channel, []);
        subscribers.get(spec.channel).push(fn);
      };
    }
  }
  return api;
}
