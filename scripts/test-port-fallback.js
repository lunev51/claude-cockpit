'use strict';
// Electron-main мини-тест динамического порта speak-server.
// Занимаем 48751 сторонним net-сервером, затем стартуем speak-server и через
// 2с проверяем getActualPort() — ожидаем 48753 (48751 занят → +2).
//
// Запуск: npx electron scripts/test-port-fallback.js

const net = require('net');
const { app } = require('electron');
const { startSpeakServer, getActualPort } = require('../src/main/speak-server');

app.whenReady().then(() => {
  // Занимаем базовый порт 48751.
  const blocker = net.createServer();
  blocker.listen(48751, '127.0.0.1', () => {
    console.log('[test] порт 48751 занят блокером');

    // Фейковое окно: send просто печатает уведомления.
    const fakeWin = {
      isDestroyed: () => false,
      webContents: { send: (channel, payload) => console.log(`[notice→${channel}]`, payload) },
    };
    const getConfig = () => ({ tts: { port: 48751, enabled: true } });

    startSpeakServer(fakeWin, getConfig);

    setTimeout(() => {
      const actual = getActualPort();
      console.log(`[test] getActualPort() = ${actual} (ожидаем 48753)`);
      console.log(actual === 48753 ? '[test] PASS' : '[test] FAIL');
      app.exit(0);
    }, 2000);
  });
});
