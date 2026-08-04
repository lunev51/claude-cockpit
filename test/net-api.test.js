'use strict';
// Мост window.api поверх сокета. Renderer не знает, где он работает, — вся
// разница между Electron и браузером живёт здесь, в одном модуле.
const test = require('node:test');
const assert = require('node:assert');

const load = () => import('../src/renderer/js/net-api.js');

// Поддельный сокет: тот же интерфейс, что у WebSocket, но без сети.
// close()/error() — симуляция обрыва связи для тестов Important 2 ревью:
// дёргаем обработчик напрямую, тем же приёмом, что и receive() для message.
function fakeSocket() {
  const sent = [];
  const listeners = {};
  return {
    sent,
    readyState: 1,
    send: (raw) => sent.push(JSON.parse(raw)),
    addEventListener: (name, fn) => { listeners[name] = fn; },
    receive(obj) { listeners.message({ data: JSON.stringify(obj) }); },
    close() { this.readyState = 3; if (listeners.close) listeners.close(); },
    error() { if (listeners.error) listeners.error(); },
  };
}

const SHAPE = {
  'tabs.open': { channel: 'tabs:open', kind: 'invoke' },
  'term.write': { channel: 'term:write', kind: 'send' },
  'tab.onStatus': { channel: 'tab:status', kind: 'event' },
  // Переупаковываемые методы (Critical 2 ревью) — preload.js собирает
  // позиционные аргументы в объект перед send/invoke; те же имена и порядок
  // полей, что в реальном api-shape.js для queue.add/ghost.save.
  'queue.add': { channel: 'queue:add', kind: 'send', pack: ['tabId', 'text'] },
  'ghost.save': { channel: 'ghost:save', kind: 'invoke', pack: ['tabId', 'text'] },
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

// --- Critical 2 ревью: pack переупаковывает позиционные args в объект ---
// preload.js для 11 методов собирает аргументы renderer в один объект перед
// ipcRenderer.send/invoke (например term.write(tabId,data) → {tabId,data}).
// Сервер зовёт обработчик как fn(...args) — без pack он получил бы 'T1'
// вместо {tabId:'T1',...} и main-обработчик молча отбросил бы команду
// (typeof payload !== 'object'). Эти два теста ловят именно это на границе.

test('send с pack переупаковывает позиционные аргументы в объект — как делает preload.js', async () => {
  const { createNetApi } = await load();
  const socket = fakeSocket();
  const api = createNetApi({ socket, shape: SHAPE });
  api.queue.add('T1', 'привет');
  assert.deepStrictEqual(socket.sent[0], { id: 1, channel: 'queue:add', args: [{ tabId: 'T1', text: 'привет' }] });
});

test('invoke с pack тоже переупаковывает аргументы, ответ резолвится как обычно', async () => {
  const { createNetApi } = await load();
  const socket = fakeSocket();
  const api = createNetApi({ socket, shape: SHAPE });
  const promise = api.ghost.save('T1', 'черновик');
  assert.deepStrictEqual(socket.sent[0], { id: 1, channel: 'ghost:save', args: [{ tabId: 'T1', text: 'черновик' }] });
  socket.receive({ id: 1, ok: true, result: { ghostId: 'G1' } });
  assert.deepStrictEqual(await promise, { ghostId: 'G1' });
});

// --- Important 2 ревью: обрыв связи не должен вешать интерфейс навсегда ---

test('закрытие сокета отклоняет все ожидающие вызовы понятной ошибкой', async () => {
  const { createNetApi } = await load();
  const socket = fakeSocket();
  const api = createNetApi({ socket, shape: SHAPE });
  const first = api.tabs.open({ cwd: 'первая' });
  const second = api.tabs.open({ cwd: 'вторая' });
  socket.close();
  await assert.rejects(() => first, /соединение с сервером потеряно/);
  await assert.rejects(() => second, /соединение с сервером потеряно/);
});

test('ошибка сокета отклоняет ожидающие вызовы тем же способом, что и close', async () => {
  const { createNetApi } = await load();
  const socket = fakeSocket();
  const api = createNetApi({ socket, shape: SHAPE });
  const promise = api.tabs.open({});
  socket.error();
  await assert.rejects(() => promise, /соединение с сервером потеряно/);
});

test('invoke после разрыва связи отклоняется сразу, не дожидаясь ответа', async () => {
  const { createNetApi } = await load();
  const socket = fakeSocket();
  const api = createNetApi({ socket, shape: SHAPE });
  socket.close();
  await assert.rejects(() => api.tabs.open({}), /соединение с сервером потеряно/);
  assert.deepStrictEqual(socket.sent, []); // кадр в мёртвый сокет не уходит
});

test('send после разрыва связи не бросает и ничего не отправляет', async () => {
  const { createNetApi } = await load();
  const socket = fakeSocket();
  const api = createNetApi({ socket, shape: SHAPE });
  socket.close();
  assert.doesNotThrow(() => api.term.write('T1', 'ls\r'));
  assert.deepStrictEqual(socket.sent, []);
});

// --- Important 1 ревью: форма api должна совпадать с preload.js не только
// по наличию канала, но и по виду вызова, имени метода и переупаковке
// аргументов — иначе браузер либо не находит метод (лишний/переименованный),
// либо зовёт правильный канал неправильно (send вместо invoke, без pack).
// Проверено мутациями ревьюером: смена kind и переименование метода при том
// же канале раньше проходили зелёными — старая проверка сверяла только
// множество каналов. ---

const fs = require('node:fs');
const path = require('node:path');

// Построчный разбор preload.js: группа (2-пробельный отступ, `имя: {`) →
// методы внутри (4-пробельный отступ, `имя: (парам) => ipcRenderer.вид('канал'[, rest])`).
// Для invoke/send: если rest — объектный литерал-шорткат `{ a, b }`, это и
// есть pack (preload сам переупаковывает позиционные параметры в объект).
// Для on события rest не разбираем — событиям пересборка args не грозит.
function parsePreloadShape(source) {
  const KIND_BY_KEYWORD = { invoke: 'invoke', send: 'send' };
  const parsed = {};
  let group = null;
  for (const line of source.split(/\r?\n/)) {
    const groupOpen = line.match(/^ {2}(\w+): \{$/);
    if (groupOpen) { group = groupOpen[1]; continue; }
    if (group && /^ {2}\},?$/.test(line)) { group = null; continue; }
    if (!group) continue;

    const onMatch = line.match(/^\s{4}(\w+):\s*\([^)]*\)\s*=>\s*ipcRenderer\.on\(\s*'([^']+)'/);
    if (onMatch) {
      parsed[`${group}.${onMatch[1]}`] = { channel: onMatch[2], kind: 'event' };
      continue;
    }

    const m = line.match(/^\s{4}(\w+):\s*\([^)]*\)\s*=>\s*ipcRenderer\.(invoke|send)\(\s*'([^']+)'\s*(?:,\s*(.+))?\)\s*,?\s*$/);
    if (!m) continue;
    const [, method, kw, channel, rest] = m;
    const entry = { channel, kind: KIND_BY_KEYWORD[kw] };
    if (rest) {
      const objMatch = rest.match(/^\{\s*([\w, ]+?)\s*\}$/);
      if (objMatch) entry.pack = objMatch[1].split(',').map((s) => s.trim());
    }
    parsed[`${group}.${method}`] = entry;
  }
  return parsed;
}

test('форма api совпадает с preload — по каналу, виду вызова, имени метода и переупаковке аргументов, в обе стороны', async () => {
  const { API_SHAPE } = await import('../src/renderer/js/api-shape.js');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'preload.js'), 'utf8');
  const parsed = parsePreloadShape(preload);

  // Разбор нашёл хоть что-то — иначе весь тест был бы зелёным просто потому,
  // что регулярка перестала матчить формат файла (ложный зелёный не менее
  // опасен ложного красного).
  assert.ok(Object.keys(parsed).length > 40, 'разбор preload.js дал подозрительно мало методов — регулярка расклеилась с реальным форматом файла');

  const parsedNames = new Set(Object.keys(parsed));
  const shapeNames = new Set(Object.keys(API_SHAPE));

  const missing = [...parsedNames].filter((n) => !shapeNames.has(n));
  assert.deepStrictEqual(missing, [], `методы есть в preload, но нет в форме — молча отсутствуют в браузере: ${missing.join(', ')}`);

  const extra = [...shapeNames].filter((n) => !parsedNames.has(n));
  assert.deepStrictEqual(extra, [], `методы есть в форме, но не в preload — лишние или переименованные: ${extra.join(', ')}`);

  for (const name of parsedNames) {
    const want = parsed[name];
    const got = API_SHAPE[name];
    assert.strictEqual(got.channel, want.channel, `${name}: канал не совпадает с preload.js`);
    assert.strictEqual(got.kind, want.kind, `${name}: вид вызова (invoke/send/event) не совпадает с preload.js`);
    assert.deepStrictEqual(got.pack || null, want.pack || null, `${name}: переупаковка аргументов не совпадает с preload.js`);
  }
});
