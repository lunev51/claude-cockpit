'use strict';
// Если preload уже дал window.api — мы в Electron, ничего не делаем.
// Иначе поднимаем сокет к тому же хосту, откуда пришла страница.
import { createNetApi } from './net-api.js';
import { API_SHAPE } from './api-shape.js';

if (!window.api) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${proto}://${location.host}/ws`);
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
  window.api = createNetApi({ socket, shape: API_SHAPE });
}
