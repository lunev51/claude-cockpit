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

if (!window.api) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
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
}
