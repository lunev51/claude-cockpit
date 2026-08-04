'use strict';
// Сетевой сервер: статика renderer + WebSocket с командами и событиями.
// Тесты интеграционные — поднимаем настоящий сервер на случайном порту и
// ходим настоящим клиентом: протокол нельзя проверить моками, в нём вся суть.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const WebSocket = require('ws');
const { createNetServer } = require('../src/main/net-server');
const { createCommandRegistry } = require('../src/main/command-registry');
const { createBroadcast } = require('../src/main/broadcast');
const { createOutputBuffer } = require('../src/main/output-buffer');

const fakeIpcMain = () => ({ handle: () => {}, on: () => {} });

function makeServer(extra = {}) {
  const registry = createCommandRegistry({ ipcMain: fakeIpcMain() });
  registry.handle('эхо', async (x) => ({ эхо: x }));
  registry.handle('рвётся', async () => { throw new Error('обработчик упал'); });
  const broadcast = createBroadcast({ getWindow: () => null });
  const outputBuffer = createOutputBuffer({});
  const server = createNetServer({
    registry,
    broadcast,
    outputBuffer,
    staticRoots: { '/': path.join(__dirname, '..', 'src', 'renderer') },
    port: 0,
    host: '127.0.0.1',
    ...extra,
  });
  return { server, registry, broadcast, outputBuffer };
}

// Ждём один кадр от сокета — иначе тесты превращаются в гонку таймеров.
const nextFrame = (ws) => new Promise((resolve) => ws.once('message', (m) => resolve(JSON.parse(m))));
const open = (url) => new Promise((resolve) => {
  const ws = new WebSocket(url);
  ws.once('open', () => resolve(ws));
});

test('отдаёт страницу renderer по HTTP', async () => {
  const { server } = makeServer();
  const { port } = await server.start();
  const res = await fetch(`http://127.0.0.1:${port}/index.html`);
  const body = await res.text();
  assert.strictEqual(res.status, 200);
  assert.ok(body.includes('<div id="app">'), 'отдана не та страница');
  await server.stop();
});

test('команда доходит до реестра и возвращает результат', async () => {
  const { server } = makeServer();
  const { port } = await server.start();
  const ws = await open(`ws://127.0.0.1:${port}/ws`);
  ws.send(JSON.stringify({ id: 1, channel: 'эхо', args: ['привет'] }));
  assert.deepStrictEqual(await nextFrame(ws), { id: 1, ok: true, result: { эхо: 'привет' } });
  ws.close();
  await server.stop();
});

test('ошибка обработчика приезжает клиенту текстом, а не тишиной', async () => {
  const { server } = makeServer();
  const { port } = await server.start();
  const ws = await open(`ws://127.0.0.1:${port}/ws`);
  ws.send(JSON.stringify({ id: 2, channel: 'рвётся', args: [] }));
  const frame = await nextFrame(ws);
  assert.strictEqual(frame.ok, false);
  assert.match(frame.error, /обработчик упал/);
  ws.close();
  await server.stop();
});

test('неизвестная команда — понятная ошибка', async () => {
  const { server } = makeServer();
  const { port } = await server.start();
  const ws = await open(`ws://127.0.0.1:${port}/ws`);
  ws.send(JSON.stringify({ id: 3, channel: 'нет:такой', args: [] }));
  const frame = await nextFrame(ws);
  assert.strictEqual(frame.ok, false);
  assert.match(frame.error, /неизвестная команда/);
  ws.close();
  await server.stop();
});

test('события рассылки долетают до подключённого клиента', async () => {
  const { server, broadcast } = makeServer();
  const { port } = await server.start();
  const ws = await open(`ws://127.0.0.1:${port}/ws`);
  const frame = nextFrame(ws);
  broadcast.emit('tab:status', { tabId: 'T1', status: 'working' });
  assert.deepStrictEqual(await frame, { event: 'tab:status', payload: { tabId: 'T1', status: 'working' } });
  ws.close();
  await server.stop();
});

test('net:buffer отдаёт накопленную историю вкладки', async () => {
  const { server, outputBuffer } = makeServer();
  outputBuffer.push('T1', 'старый вывод');
  const { port } = await server.start();
  const ws = await open(`ws://127.0.0.1:${port}/ws`);
  ws.send(JSON.stringify({ id: 4, channel: 'net:buffer', args: ['T1'] }));
  assert.deepStrictEqual(await nextFrame(ws), { id: 4, ok: true, result: 'старый вывод' });
  ws.close();
  await server.stop();
});

test('битый кадр не роняет сервер', async () => {
  const { server } = makeServer();
  const { port } = await server.start();
  const ws = await open(`ws://127.0.0.1:${port}/ws`);
  ws.send('это не json');
  ws.send(JSON.stringify({ id: 5, channel: 'эхо', args: ['жив'] }));
  assert.deepStrictEqual(await nextFrame(ws), { id: 5, ok: true, result: { эхо: 'жив' } });
  ws.close();
  await server.stop();
});

test('отключившийся клиент снимается с рассылки', async () => {
  const { server, broadcast } = makeServer();
  const { port } = await server.start();
  const ws = await open(`ws://127.0.0.1:${port}/ws`);
  assert.strictEqual(server.clientCount(), 1);
  await new Promise((r) => { ws.once('close', r); ws.close(); });
  await new Promise((r) => { setTimeout(r, 50); });
  assert.strictEqual(server.clientCount(), 0);
  broadcast.emit('tab:status', {}); // не должно бросить
  await server.stop();
});

test('обход каталога наружу не проходит', async () => {
  const { server } = makeServer();
  const { port } = await server.start();
  const res = await fetch(`http://127.0.0.1:${port}/../../package.json`);
  assert.notStrictEqual(res.status, 200);
  await server.stop();
});
