'use strict';
// Сетевой сервер: статика renderer + WebSocket с командами и событиями.
// Тесты интеграционные — поднимаем настоящий сервер на случайном порту и
// ходим настоящим клиентом: протокол нельзя проверить моками, в нём вся суть.
//
// Второй раунд ревью нашёл, что первая версия падала на живой сети: битая
// percent-escape в адресе роняла весь Electron, префиксные корни не работали
// на Windows, тест на traversal ничего не проверял (fetch() сам режет '..'
// до отправки на провод), а WebSocket принимал подключение с любого сайта.
// Ниже — тесты именно на эти сценарии, сырым сокетом там, где fetch()/ws
// сглаживает то, что реально уходит на провод.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
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
const open = (url, opts) => new Promise((resolve, reject) => {
  const ws = opts ? new WebSocket(url, opts) : new WebSocket(url);
  ws.once('open', () => resolve(ws));
  ws.once('unexpected-response', (_req, res) => reject(Object.assign(new Error('апгрейд отклонён'), { statusCode: res.statusCode })));
  ws.once('error', reject);
});

// Сырой HTTP-запрос через голый сокет: в отличие от fetch()/undici, здесь
// строка запроса уходит на провод БУКВАЛЬНО как передана, без клиентской
// нормализации '..' (WHATWG URL резал бы их ДО отправки, и тест проверял бы
// не сервер, а поведение fetch — именно так первая версия теста и не ловила
// ничего, зелёная что с защитой, что без неё).
function rawRequest(port, requestLine, extraHeaders = '') {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(`${requestLine}\r\nHost: 127.0.0.1\r\nConnection: close\r\n${extraHeaders}\r\n`);
    });
    let data = '';
    sock.on('data', (chunk) => { data += chunk.toString(); });
    sock.on('end', () => resolve(data));
    sock.on('error', reject);
    sock.setTimeout(3000, () => { sock.destroy(); reject(new Error('таймаут сырого запроса')); });
  });
}
const statusOf = (raw) => { const m = raw.match(/^HTTP\/1\.1 (\d+)/); return m ? Number(m[1]) : null; };

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

// --- Critical 1: битая percent-escape в адресе не роняет процесс ---------

test('битый %-escape в адресе отвечает 400, а не роняет сервер', async () => {
  const { server } = makeServer();
  const { port } = await server.start();
  for (const bad of ['/%zz', '/%', '/%c0%ae%c0%ae/']) {
    const raw = await rawRequest(port, `GET ${bad} HTTP/1.1`);
    const status = statusOf(raw);
    assert.notStrictEqual(status, null, `сервер не ответил вовсе на ${bad}`);
    assert.notStrictEqual(status, 200, `${bad} не должен отдавать файл`);
  }
  // Сервер обязан пережить все три и ответить на следующий обычный запрос —
  // именно так проявлялся Critical 1: URIError без try/catch валил ВЕСЬ
  // процесс, и следующий запрос не отвечал бы никогда.
  const ok = await rawRequest(port, 'GET /index.html HTTP/1.1');
  assert.strictEqual(statusOf(ok), 200);
  await server.stop();
});

// --- Important 1: обход каталога наружу — сырым сокетом, с реальной уликой -

test('обход каталога наружу не отдаёт файл за пределами корня (сырой сокет)', async () => {
  // fetch() сам нормализует '..' в URL до отправки (WHATWG URL,
  // remove_dot_segments) — тест на fetch() зелёный что с защитой, что без
  // неё. Кладём секретный маркер РЯДОМ с корнем (в test/, на два уровня выше
  // src/renderer) и бьём по нему сырой строкой запроса с буквальными '..'.
  const marker = `секрет-${process.pid}-${Date.now()}.txt`;
  const markerPath = path.join(__dirname, marker); // test/<marker>, вне staticRoots
  fs.writeFileSync(markerPath, 'ЕСЛИ ЭТО ВИДНО В ОТВЕТЕ — ЗАЩИТА СЛОМАНА', 'utf8');
  try {
    const { server } = makeServer(); // staticRoots: { '/': .../src/renderer }
    const { port } = await server.start();
    for (const attempt of [
      `GET /../../test/${marker} HTTP/1.1`,
      `GET /../../test/${marker.replace(/-/g, '%2d')} HTTP/1.1`, // тот же путь, частично закодирован
    ]) {
      const raw = await rawRequest(port, attempt);
      assert.notStrictEqual(statusOf(raw), 200, `утекло по запросу: ${attempt}`);
      assert.ok(!raw.includes('ЗАЩИТА СЛОМАНА'), `тело ответа содержит секрет: ${attempt}`);
    }
    await server.stop();
  } finally {
    fs.unlinkSync(markerPath);
  }
});

test('обход каталога через ../../package.json (эталонный сценарий брифа) не проходит', async () => {
  const { server } = makeServer();
  const { port } = await server.start();
  const raw = await rawRequest(port, 'GET /../../package.json HTTP/1.1');
  assert.notStrictEqual(statusOf(raw), 200);
  await server.stop();
});

// --- Important 2: префиксные корни на Windows и граница сегмента ---------

test('многокорневая раздача: реальные файлы xterm через префикс /node_modules (сценарий задачи 7)', async () => {
  // Ровно та конфигурация, которую задача 7 передаёт в createNetServer:
  // несколько корней с префиксами. Старая реализация сравнивала обратные
  // слэши (после path.normalize на Windows) с прямыми в ключах объекта и
  // отдавала 404 на всё — браузер открылся бы без терминала и без шрифтов.
  const { server } = makeServer({
    staticRoots: {
      '/node_modules': path.join(__dirname, '..', 'node_modules'),
      '/assets': path.join(__dirname, '..', 'assets'),
      '/': path.join(__dirname, '..', 'src', 'renderer'),
    },
  });
  const { port } = await server.start();
  const res = await fetch(`http://127.0.0.1:${port}/node_modules/@xterm/xterm/css/xterm.css`);
  const body = await res.text();
  assert.strictEqual(res.status, 200, 'xterm.css не отдался через префиксный корень');
  assert.ok(body.length > 0);
  await server.stop();
});

test('префикс совпадает по границе сегмента, а не по началу строки', async () => {
  // '/assets' не имеет права подхватить '/assets-private/...' — это была бы
  // утечка соседнего (незаявленного) корня через похожее имя.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'net-server-boundary-'));
  const assetsDir = path.join(tmp, 'assets');
  const siblingDir = path.join(tmp, 'assets-private');
  fs.mkdirSync(assetsDir);
  fs.mkdirSync(siblingDir);
  fs.writeFileSync(path.join(assetsDir, 'ok.txt'), 'публичное', 'utf8');
  fs.writeFileSync(path.join(siblingDir, 'secret.txt'), 'ПРИВАТНОЕ — НЕ ДОЛЖНО ОТДАВАТЬСЯ', 'utf8');
  try {
    const { server } = makeServer({ staticRoots: { '/assets': assetsDir } });
    const { port } = await server.start();
    const ok = await fetch(`http://127.0.0.1:${port}/assets/ok.txt`);
    assert.strictEqual(ok.status, 200);
    const leak = await fetch(`http://127.0.0.1:${port}/assets-private/secret.txt`);
    assert.notStrictEqual(leak.status, 200, 'соседний корень отдался по похожему префиксу');
    await server.stop();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('".." не выводит из префиксного корня в соседнюю папку', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'net-server-escape-'));
  const nodeModulesDir = path.join(tmp, 'node_modules');
  const secretDir = path.join(tmp, 'node_modules-secret');
  fs.mkdirSync(nodeModulesDir);
  fs.mkdirSync(secretDir);
  fs.writeFileSync(path.join(nodeModulesDir, 'marker.txt'), 'публичное', 'utf8');
  fs.writeFileSync(path.join(secretDir, 'leak.md'), 'ПРИВАТНОЕ — НЕ ДОЛЖНО ОТДАВАТЬСЯ', 'utf8');
  try {
    const { server } = makeServer({ staticRoots: { '/node_modules': nodeModulesDir } });
    const { port } = await server.start();
    const ok = await fetch(`http://127.0.0.1:${port}/node_modules/marker.txt`);
    assert.strictEqual(ok.status, 200);
    for (const attempt of [
      'GET /node_modules/../node_modules-secret/leak.md HTTP/1.1',
      'GET /node_modules/%2e%2e/node_modules-secret/leak.md HTTP/1.1',
      'GET /node_modules/..\\node_modules-secret\\leak.md HTTP/1.1',
    ]) {
      const raw = await rawRequest(port, attempt);
      assert.notStrictEqual(statusOf(raw), 200, `утекло по запросу: ${attempt}`);
      assert.ok(!raw.includes('ПРИВАТНОЕ'), attempt);
    }
    await server.stop();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('относительный root не превращает раздачу в молчаливые 404', async () => {
  // path.join от относительного root даёт относительный путь, а старая
  // проверка сравнивала его с path.resolve(root) — абсолютным — и не
  // совпадала никогда. Роняем root намеренно относительным и ждём рабочую
  // раздачу: корни резолвятся в абсолютные один раз, при создании сервера.
  const rendererAbs = path.join(__dirname, '..', 'src', 'renderer');
  const relative = path.relative(process.cwd(), rendererAbs);
  const { server } = makeServer({ staticRoots: { '/': relative } });
  const { port } = await server.start();
  const res = await fetch(`http://127.0.0.1:${port}/index.html`);
  assert.strictEqual(res.status, 200, `относительный root '${relative}' не сработал`);
  await server.stop();
});

// --- Important 3: WebSocket принимает только свой origin -----------------

test('WebSocket с чужим Origin отклоняется на этапе апгрейда', async () => {
  const { server } = makeServer();
  const { port } = await server.start();
  await assert.rejects(
    () => open(`ws://127.0.0.1:${port}/ws`, { origin: 'https://evil.example.com' }),
    (err) => {
      assert.strictEqual(err.statusCode, 403);
      return true;
    },
  );
  assert.strictEqual(server.clientCount(), 0, 'чужой origin не должен был попасть в клиенты');
  await server.stop();
});

test('WebSocket со своим Origin подключается и работает как обычно', async () => {
  const { server } = makeServer();
  const { port } = await server.start();
  const ws = await open(`ws://127.0.0.1:${port}/ws`, { origin: `http://127.0.0.1:${port}` });
  ws.send(JSON.stringify({ id: 1, channel: 'эхо', args: ['свой'] }));
  assert.deepStrictEqual(await nextFrame(ws), { id: 1, ok: true, result: { эхо: 'свой' } });
  ws.close();
  await server.stop();
});

// --- Мелочи: протокол отвечает ошибкой, а не тишиной ----------------------

test('кадр с id, но без валидного channel — получает ok:false, а не тишину', async () => {
  const { server } = makeServer();
  const { port } = await server.start();
  const ws = await open(`ws://127.0.0.1:${port}/ws`);
  ws.send(JSON.stringify({ id: 6, args: [] })); // channel вообще нет
  const frame = await nextFrame(ws);
  assert.strictEqual(frame.id, 6);
  assert.strictEqual(frame.ok, false);
  ws.close();
  await server.stop();
});

test('args не массивом — явная ошибка протокола, а не молчаливый вызов без аргументов', async () => {
  const { server } = makeServer();
  const { port } = await server.start();
  const ws = await open(`ws://127.0.0.1:${port}/ws`);
  ws.send(JSON.stringify({ id: 7, channel: 'эхо', args: 'не массив' }));
  const frame = await nextFrame(ws);
  assert.strictEqual(frame.ok, false);
  ws.close();
  await server.stop();
});
