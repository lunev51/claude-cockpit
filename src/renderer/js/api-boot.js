'use strict';
// Если preload уже дал window.api — мы в Electron, ничего не делаем.
// Иначе поднимаем сокет к тому же хосту, откуда пришла страница.
//
// Этот файл — ПЕРВЫЙ импорт app.js (см. комментарий там), не отдельный
// <script>: top-level await ниже реально блокирует выполнение app.js до
// готовности window.api (ревью задачи 6, Critical 1).
import { createNetApi } from './net-api.js';
import { API_SHAPE } from './api-shape.js';

// Недоступный сервер не должен вешать страницу навсегда (ревью задачи 6,
// Important 2) — таймаут ловит тихо непослушный порт (пакеты роняются без
// ответа), 'error' ловит быстрый и явный отказ (порт закрыт, TLS и т.п.).
const CONNECT_TIMEOUT_MS = 10000;

// I3 ревью: обрыва связи не было видно ВООБЩЕ, а переподключения не было ни
// здесь, ни в net-api.js — страница оставалась мёртвой до F5. Нарастающий
// интервал (спека: «клиент переподключается с нарастающим интервалом») —
// явный список, а не формула: последнее значение повторяется бесконечно, так
// что закрытая на ночь крышка макбука не превращается в раз-в-час.
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];

// Состояние связи для интерфейса. В Electron сокета нет вовсе — значение так и
// остаётся «на связи» (окно и main живут одним процессом: умер main — умерло
// окно, показывать некому).
export const linkState = { online: true, attempt: 0 };
const linkWatchers = [];

export function onLinkChange(fn) {
  linkWatchers.push(fn);
}

function setLink(patch) {
  Object.assign(linkState, patch);
  for (const fn of linkWatchers) {
    // Падение одного наблюдателя не должно рвать переподключение.
    try { fn({ ...linkState }); } catch { /* его беда */ }
  }
}

// Переподключение НЕ пытается чинить состояние страницы на живую: сокет
// поднимается заново только чтобы узнать, что кокпит снова отвечает, — а
// дальше страница перезагружается целиком. Это тот же путь, которым сюда
// приходит любой новый клиент (boot() → tabs:list → подключение к живым
// вкладкам с историей из net:buffer), то есть уже отревьюженный и рабочий, а
// не второй, «умный», написанный ради одного сценария.
function reconnectLoop(url) {
  const delay = RECONNECT_DELAYS_MS[
    Math.min(linkState.attempt, RECONNECT_DELAYS_MS.length - 1)
  ];
  setTimeout(() => {
    setLink({ attempt: linkState.attempt + 1 });
    let probe = null;
    let settled = false;
    // 'error' и 'close' приходят парой — вторая попытка планировалась бы
    // дважды и интервал схлопывался бы вдвое.
    const fail = () => {
      if (settled) return;
      settled = true;
      try { probe && probe.close(); } catch { /* уже мёртв */ }
      reconnectLoop(url);
    };
    try {
      probe = new WebSocket(url);
    } catch {
      fail();
      return;
    }
    probe.addEventListener('open', () => {
      if (settled) return;
      settled = true;
      setLink({ online: true });
      try { probe.close(); } catch { /* всё равно перезагружаемся */ }
      window.location.reload();
    }, { once: true });
    probe.addEventListener('error', fail, { once: true });
    probe.addEventListener('close', fail, { once: true });
  }, delay);
}

function watchLink(socket, url) {
  const down = () => {
    if (!linkState.online) return; // close после error — один обрыв, не два
    setLink({ online: false, attempt: 0 });
    reconnectLoop(url);
  };
  socket.addEventListener('close', down);
  socket.addEventListener('error', down);
}

if (!window.api) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  // Адрес собирается ЗДЕСЬ и дословно (`${proto}://${location.host}/ws`) —
  // test/renderer-boot-guard.js сверяет этот шаблон с path сокет-сервера в
  // net-server.js: разъехавшийся путь дал бы загружающуюся страницу, у
  // которой window.api не соберётся никогда. Переподключение берёт готовый
  // socket.url, чтобы второй копии этого шаблона в файле не было вовсе.
  const socket = new WebSocket(`${proto}://${location.host}/ws`);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('сервер кокпита не ответил за 10 секунд')),
      CONNECT_TIMEOUT_MS,
    );
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('не удалось подключиться к серверу кокпита'));
    }, { once: true });
  });
  window.api = createNetApi({ socket, shape: API_SHAPE });
  watchLink(socket, socket.url);
}
