'use strict';
// Мост window.api поверх сокета. Renderer не знает, где он работает, — вся
// разница между Electron и браузером живёт здесь, в одном модуле.
const test = require('node:test');
const assert = require('node:assert');

const load = () => import('../src/renderer/js/net-api.js');

// Поддельный сокет: тот же интерфейс, что у WebSocket, но без сети.
function fakeSocket() {
  const sent = [];
  const listeners = {};
  return {
    sent,
    readyState: 1,
    send: (raw) => sent.push(JSON.parse(raw)),
    addEventListener: (name, fn) => { listeners[name] = fn; },
    receive(obj) { listeners.message({ data: JSON.stringify(obj) }); },
  };
}

const SHAPE = {
  'tabs.open': { channel: 'tabs:open', kind: 'invoke' },
  'term.write': { channel: 'term:write', kind: 'send' },
  'tab.onStatus': { channel: 'tab:status', kind: 'event' },
};

test('invoke уходит кадром с id и резолвится ответом', async () => {
  const { createNetApi } = await load();
  const socket = fakeSocket();
  const api = createNetApi({ socket, shape: SHAPE });

  const promise = api.tabs.open({ cwd: 'C:\\proj' });
  assert.deepStrictEqual(socket.sent[0], { id: 1, channel: 'tabs:open', args: [{ cwd: 'C:\\proj' }] });

  socket.receive({ id: 1, ok: true, result: { tabId: 'T1' } });
  assert.deepStrictEqual(await promise, { tabId: 'T1' });
});

test('ошибка с той стороны становится отказом промиса', async () => {
  const { createNetApi } = await load();
  const socket = fakeSocket();
  const api = createNetApi({ socket, shape: SHAPE });
  const promise = api.tabs.open({});
  socket.receive({ id: 1, ok: false, error: 'папки нет' });
  await assert.rejects(() => promise, /папки нет/);
});

test('send уходит без ожидания ответа', async () => {
  const { createNetApi } = await load();
  const socket = fakeSocket();
  const api = createNetApi({ socket, shape: SHAPE });
  api.term.write('T1', 'ls\r');
  assert.deepStrictEqual(socket.sent[0], { id: 1, channel: 'term:write', args: ['T1', 'ls\r'] });
});

test('подписка получает события сервера', async () => {
  const { createNetApi } = await load();
  const socket = fakeSocket();
  const api = createNetApi({ socket, shape: SHAPE });
  const got = [];
  api.tab.onStatus((p) => got.push(p));
  socket.receive({ event: 'tab:status', payload: { tabId: 'T1', status: 'working' } });
  assert.deepStrictEqual(got, [{ tabId: 'T1', status: 'working' }]);
});

test('несколько одновременных вызовов не путают ответы', async () => {
  // Ответы приходят в произвольном порядке: id — единственное, что их
  // различает, и перепутанный ответ выглядел бы как «данные другой вкладки».
  const { createNetApi } = await load();
  const socket = fakeSocket();
  const api = createNetApi({ socket, shape: SHAPE });
  const first = api.tabs.open({ cwd: 'первая' });
  const second = api.tabs.open({ cwd: 'вторая' });

  socket.receive({ id: 2, ok: true, result: 'ответ второй' });
  socket.receive({ id: 1, ok: true, result: 'ответ первой' });

  assert.strictEqual(await first, 'ответ первой');
  assert.strictEqual(await second, 'ответ второй');
});

test('ответ на неизвестный id игнорируется молча', async () => {
  const { createNetApi } = await load();
  const socket = fakeSocket();
  createNetApi({ socket, shape: SHAPE });
  socket.receive({ id: 999, ok: true, result: 'ничей' }); // не должно бросить
});

const fs = require('node:fs');
const path = require('node:path');

test('форма api совпадает с preload — иначе метод молча отсутствует в браузере', async () => {
  const { API_SHAPE } = await import('../src/renderer/js/api-shape.js');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'preload.js'), 'utf8');
  const channels = new Set([...preload.matchAll(/ipcRenderer\.\w+\(\s*'([^']+)'/g)].map((m) => m[1]));
  const inShape = new Set(Object.values(API_SHAPE).map((s) => s.channel));
  const missing = [...channels].filter((c) => !inShape.has(c));
  assert.deepStrictEqual(missing, [], `каналы есть в preload, но не в форме: ${missing.join(', ')}`);
});
