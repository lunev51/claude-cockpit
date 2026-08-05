'use strict';
// Сетевой сервер: статика renderer + WebSocket с командами и событиями.
// Тесты интеграционные — поднимаем настоящий сервер на случайном порту и
// ходим настоящим клиентом: протокол нельзя проверить моками, в нём вся суть.
//
// Раунд 2 нашёл: битая percent-escape в адресе роняла весь Electron,
// префиксные корни не работали на Windows, тест на traversal ничего не
// проверял (fetch() сам режет '..' до отправки), WebSocket принимал
// подключение с любого сайта, занятый порт всё равно ронял процесс через
// wss.emit('error'), а упавший ДО server.stop() тест вешал весь прогон
// node --test навсегда (слушающий сокет держит цикл событий).
// Раунд 3: сравнение Origin с Host в одиночку открывало DNS-rebinding —
// закрыто ниже двухэтапной проверкой (Host против белого списка первым).
const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const { createNetServer } = require('../src/main/net-server');
const { createCommandRegistry } = require('../src/main/command-registry');
const { createBroadcast } = require('../src/main/broadcast');
const { createOutputBuffer } = require('../src/main/output-buffer');
const { createOwnership } = require('../src/main/ownership');
const { isWriteChannel } = require('../src/main/write-channels');

const fakeIpcMain = () => ({ handle: () => {}, on: () => {} });

// Серверы, созданные ЗА ТЕКУЩИЙ тест — afterEach ниже гасит их всегда,
// независимо от того, дошёл ли тест до собственного server.stop(). Без
// этого упавший ДО остановки тест оставляет слушающий сокет открытым, тот
// держит цикл событий, и node --test не даёт красный отчёт, а виснет
// навсегда (подтверждено вручную: реальный прогон на этой машине завис и
// был снят по трёхминутному таймауту, пока в файле не было этой уборки).
let activeServers = [];
afterEach(async () => {
  const servers = activeServers;
  activeServers = [];
  await Promise.all(servers.map((s) => s.stop().catch(() => { /* уже мог быть остановлен телом теста */ })));
});

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
  activeServers.push(server);
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
});

test('команда доходит до реестра и возвращает результат', async () => {
  const { server } = makeServer();
  const { port } = await server.start();
  const ws = await open(`ws://127.0.0.1:${port}/ws`);
  ws.send(JSON.stringify({ id: 1, channel: 'эхо', args: ['привет'] }));
  assert.deepStrictEqual(await nextFrame(ws), { id: 1, ok: true, result: { эхо: 'привет' } });
  ws.close();
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
});

test('события рассылки долетают до подключённого клиента', async () => {
  const { server, broadcast } = makeServer();
  const { port } = await server.start();
  const ws = await open(`ws://127.0.0.1:${port}/ws`);
  const frame = nextFrame(ws);
  broadcast.emit('tab:status', { tabId: 'T1', status: 'working' });
  assert.deepStrictEqual(await frame, { event: 'tab:status', payload: { tabId: 'T1', status: 'working' } });
  ws.close();
});

test('net:buffer отдаёт накопленную историю вкладки', async () => {
  const { server, outputBuffer } = makeServer();
  outputBuffer.push('T1', 'старый вывод');
  const { port } = await server.start();
  const ws = await open(`ws://127.0.0.1:${port}/ws`);
  ws.send(JSON.stringify({ id: 4, channel: 'net:buffer', args: ['T1'] }));
  assert.deepStrictEqual(await nextFrame(ws), { id: 4, ok: true, result: 'старый вывод' });
  ws.close();
});

test('битый кадр не роняет сервер', async () => {
  const { server } = makeServer();
  const { port } = await server.start();
  const ws = await open(`ws://127.0.0.1:${port}/ws`);
  ws.send('это не json');
  ws.send(JSON.stringify({ id: 5, channel: 'эхо', args: ['жив'] }));
  assert.deepStrictEqual(await nextFrame(ws), { id: 5, ok: true, result: { эхо: 'жив' } });
  ws.close();
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
});

// --- Critical: битая percent-escape в адресе не роняет процесс -----------

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
});

// --- Important: обход каталога наружу — сырым сокетом, с реальной уликой -

test('обход каталога наружу не отдаёт файл за пределами корня (сырой сокет)', async () => {
  // fetch() сам нормализует '..' в URL до отправки (WHATWG URL,
  // remove_dot_segments) — тест на fetch() зелёный что с защитой, что без
  // неё. Кладём секретный маркер РЯДОМ с корнем (в test/, на два уровня выше
  // src/renderer) и бьём по нему сырой строкой запроса с буквальными '..'.
  //
  // Имя маркера — ЛАТИНИЦЕЙ. HTTP-парсер Node отвергает не-ASCII байты
  // прямо в строке запроса (400 Bad Request) ещё до нашего кода — с
  // кириллицей в имени файла оба варианта запроса ниже были 400 ВСЕГДА,
  // что с защитой на месте, что без неё: тест ловил особенность парсера,
  // а не обход каталога. ASCII проверяет именно то, что называется в
  // тексте теста (содержимое файла ниже кириллицей — оно едет в теле
  // ответа, не в строке запроса, там ограничений нет).
  const marker = `secret-${process.pid}-${Date.now()}.txt`;
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
  } finally {
    fs.unlinkSync(markerPath);
  }
});

test('обход каталога через ../../package.json (эталонный сценарий брифа) не проходит', async () => {
  const { server } = makeServer();
  const { port } = await server.start();
  const raw = await rawRequest(port, 'GET /../../package.json HTTP/1.1');
  assert.notStrictEqual(statusOf(raw), 200);
});

// --- Important: префиксные корни на Windows и граница сегмента -----------

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
});

test('префикс с двоеточием в конфиге не ломает раздачу остальных корней', async () => {
  // ':' в САМОМ ПУТИ ЗАПРОСА блокируется целиком как защита от NTFS ADS
  // (index.html::$DATA) — значит запрос, которому нужен буквальный ':' в
  // пути, до сервера не дойдёт никогда, это ожидаемо и отдельно от этого
  // теста. Раньше баг был в другом месте: разбор ПРЕФИКСА ('/weird:root'
  // как строки конфигурации) прогонялся через ТУ ЖЕ функцию, что и путь
  // запроса, — она видела ':' и возвращала null для сегментов префикса на
  // КАЖДОМ вызове resolveFile, вне зависимости от того, какой запрос
  // разбирался. Само по себе это не крашило сервер, но смешение проверки
  // «доверенный конфиг» и «недоверенный ввод» в одной функции — источник
  // будущих сюрпризов. Префикс и путь запроса разобраны разными функциями;
  // здесь проверяем реально наблюдаемое: наличие такого корня в
  // конфигурации не мешает штатной раздаче ОСТАЛЬНЫХ корней.
  const { server } = makeServer({
    staticRoots: {
      '/weird:root': path.join(__dirname, '..', 'assets'),
      '/': path.join(__dirname, '..', 'src', 'renderer'),
    },
  });
  const { port } = await server.start();
  const res = await fetch(`http://127.0.0.1:${port}/index.html`);
  assert.strictEqual(res.status, 200, 'соседний обычный корень должен работать как обычно');
});

// --- Раунд 2/3: WebSocket принимает только свой origin ---------------------
// Раунд 2: белый список, собранный из host/port КОНФИГУРАЦИИ сервера,
// отсекал сценарий, ради которого всё затевается, — сервер поднят на
// Tailscale-адресе, браузер шлёт Origin с ЭТИМ адресом. Первый фикс раунда 2
// сравнивал ТОЛЬКО Origin с заголовком Host того же запроса — чинил макбук,
// но открывал DNS-rebinding: Host целиком в руках клиента, домен
// атакующего с коротким TTL сам подставляет и Origin, и Host на одно и то
// же чужое имя — сравнение "Origin == Host" в одиночку это пропускает,
// потому что оба совпадают, оба подделаны одним и тем же клиентом.
// Раунд 3: Host сначала сверяется с белым списком (host конфигурации,
// 127.0.0.1/localhost, allowedHosts), и только ПОТОМ Origin — с уже
// проверенным Host.

test('свой Origin на дефолтном host (127.0.0.1) — подключается', async () => {
  const { server } = makeServer();
  const { port } = await server.start();
  const ws = await open(`ws://127.0.0.1:${port}/ws`, { origin: `http://127.0.0.1:${port}` });
  ws.send(JSON.stringify({ id: 1, channel: 'эхо', args: ['свой'] }));
  assert.deepStrictEqual(await nextFrame(ws), { id: 1, ok: true, result: { эхо: 'свой' } });
  ws.close();
});

test('чужой Origin при штатном Host (127.0.0.1) отклоняется на этапе апгрейда', async () => {
  const { server } = makeServer();
  const { port } = await server.start();
  await assert.rejects(
    () => open(`ws://127.0.0.1:${port}/ws`, { origin: 'https://evil.example.com' }),
    (err) => { assert.strictEqual(err.statusCode, 403); return true; },
  );
  assert.strictEqual(server.clientCount(), 0, 'чужой origin не должен был попасть в клиенты');
});

test('DNS-rebinding: Origin и Host ОДНОВРЕМЕННО подделаны на одно чужое имя — отклоняется', async () => {
  // Это и есть закрываемый Critical: имя не входит в белый список — не
  // важно, что Origin ему "соответствует", подделать оба одновременно
  // может сам атакующий домен.
  const { server } = makeServer();
  const { port } = await server.start();
  const evilHost = `evil.example.com:${port}`;
  await assert.rejects(
    () => open(`ws://127.0.0.1:${port}/ws`, { origin: `http://${evilHost}`, headers: { Host: evilHost } }),
    (err) => { assert.strictEqual(err.statusCode, 403); return true; },
  );
  assert.strictEqual(server.clientCount(), 0);
});

test('allowedHosts: дополнительное имя из конфига (вход в тайлнет по имени, когда в конфиге записан IP) — подключается', async () => {
  const dnsName = 'cockpit-desktop.tailXXXX.ts.net';
  const { server } = makeServer({ allowedHosts: [dnsName] });
  const { port } = await server.start();
  const fakeHost = `${dnsName}:${port}`;
  const ws = await open(`ws://127.0.0.1:${port}/ws`, { origin: `http://${fakeHost}`, headers: { Host: fakeHost } });
  ws.send(JSON.stringify({ id: 1, channel: 'эхо', args: ['по имени'] }));
  assert.deepStrictEqual(await nextFrame(ws), { id: 1, ok: true, result: { эхо: 'по имени' } });
  ws.close();
});

test('имя вне host и вне allowedHosts отклоняется, даже когда Origin ему равен', async () => {
  const { server } = makeServer({ allowedHosts: ['cockpit-desktop.tailXXXX.ts.net'] });
  const { port } = await server.start();
  const otherHost = `other-name.example:${port}`;
  await assert.rejects(
    () => open(`ws://127.0.0.1:${port}/ws`, { origin: `http://${otherHost}`, headers: { Host: otherHost } }),
    (err) => { assert.strictEqual(err.statusCode, 403); return true; },
  );
});

test("host='0.0.0.0' (слушать везде) сам по себе не становится разрешённым именем", async () => {
  // '0.0.0.0' — адрес «слушать на всех интерфейсах», а не имя, по которому
  // реально пришёл запрос. Включить его в белый список значило бы
  // разрешить буквально любой Host, стоит серверу слушать 0.0.0.0.
  const { server } = makeServer({ host: '0.0.0.0' });
  const { port } = await server.start();
  const fakeHost = `0.0.0.0:${port}`;
  await assert.rejects(
    () => open(`ws://127.0.0.1:${port}/ws`, { origin: `http://${fakeHost}`, headers: { Host: fakeHost } }),
    (err) => { assert.strictEqual(err.statusCode, 403); return true; },
  );
  // Но 127.0.0.1 (всегда в списке) на том же сервере по-прежнему работает.
  const ws = await open(`ws://127.0.0.1:${port}/ws`, { origin: `http://127.0.0.1:${port}` });
  ws.send(JSON.stringify({ id: 1, channel: 'эхо', args: ['жив'] }));
  assert.deepStrictEqual(await nextFrame(ws), { id: 1, ok: true, result: { эхо: 'жив' } });
  ws.close();
});

test('Host в другом регистре (LOCALHOST) распознаётся как разрешённый', async () => {
  const { server } = makeServer();
  const { port } = await server.start();
  const mixedHost = `LOCALHOST:${port}`;
  const ws = await open(`ws://127.0.0.1:${port}/ws`, { origin: `http://${mixedHost}`, headers: { Host: mixedHost } });
  ws.send(JSON.stringify({ id: 1, channel: 'эхо', args: ['регистр'] }));
  assert.deepStrictEqual(await nextFrame(ws), { id: 1, ok: true, result: { эхо: 'регистр' } });
  ws.close();
});

// --- Раунд 4: IPv6-литерал и «молчаливо мёртвые» записи белого списка ----
// Браузер всегда шлёт IPv6-литерал в Host/Origin в квадратных скобках
// ('[::1]:порт', RFC 3986) — голый '::1' в белом списке никогда бы не
// совпал с тем, что реально приходит по сети, и адрес Tailscale IPv6
// (выдаётся всегда, наравне с IPv4) отрезал бы браузер целиком.

test('IPv6-литерал в allowedHosts автоматически оборачивается в скобки и совпадает с Host браузера', async () => {
  // Голая запись в конфиге — 'fd7a:115c:1234::1' (без скобок, как и
  // задокументировано в комментарии у allowedHosts); браузер же всегда
  // шлёт Host в скобках — сервер обязан свести оба вида к одному.
  const ipv6 = 'fd7a:115c:1234::1';
  const { server } = makeServer({ allowedHosts: [ipv6] });
  const { port } = await server.start();
  const bracketedHost = `[${ipv6}]:${port}`;
  const ws = await open(`ws://127.0.0.1:${port}/ws`, {
    origin: `http://${bracketedHost}`,
    headers: { Host: bracketedHost },
  });
  ws.send(JSON.stringify({ id: 1, channel: 'эхо', args: ['ipv6'] }));
  assert.deepStrictEqual(await nextFrame(ws), { id: 1, ok: true, result: { эхо: 'ipv6' } });
  ws.close();
});

test('пробелы по краям в allowedHosts не превращают запись в молчаливо мёртвую', async () => {
  const dnsName = 'cockpit-desktop.tailXXXX.ts.net';
  const { server } = makeServer({ allowedHosts: [`  ${dnsName}  `] });
  const { port } = await server.start();
  const fakeHost = `${dnsName}:${port}`;
  const ws = await open(`ws://127.0.0.1:${port}/ws`, { origin: `http://${fakeHost}`, headers: { Host: fakeHost } });
  ws.send(JSON.stringify({ id: 1, channel: 'эхо', args: ['без пробелов'] }));
  assert.deepStrictEqual(await nextFrame(ws), { id: 1, ok: true, result: { эхо: 'без пробелов' } });
  ws.close();
});

test("'0.0.0.0' в allowedHosts тоже отбрасывается, а не только в host", async () => {
  // Раньше фильтр «это не имя, это 'слушать везде'» применялся только к
  // host — в allowedHosts 0.0.0.0 проходил как есть и разрешал ЛЮБОЙ Host.
  const { server } = makeServer({ allowedHosts: ['0.0.0.0'] });
  const { port } = await server.start();
  const fakeHost = `0.0.0.0:${port}`;
  await assert.rejects(
    () => open(`ws://127.0.0.1:${port}/ws`, { origin: `http://${fakeHost}`, headers: { Host: fakeHost } }),
    (err) => { assert.strictEqual(err.statusCode, 403); return true; },
  );
});

test('WebSocket без Origin (не браузер) подключается как раньше', async () => {
  const { server } = makeServer();
  const { port } = await server.start();
  const ws = await open(`ws://127.0.0.1:${port}/ws`);
  ws.send(JSON.stringify({ id: 1, channel: 'эхо', args: ['свой'] }));
  assert.deepStrictEqual(await nextFrame(ws), { id: 1, ok: true, result: { эхо: 'свой' } });
  ws.close();
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
});

test('args не массивом — явная ошибка протокола, а не молчаливый вызов без аргументов', async () => {
  const { server } = makeServer();
  const { port } = await server.start();
  const ws = await open(`ws://127.0.0.1:${port}/ws`);
  ws.send(JSON.stringify({ id: 7, channel: 'эхо', args: 'не массив' }));
  const frame = await nextFrame(ws);
  assert.strictEqual(frame.ok, false);
  ws.close();
});

test('несериализуемый результат канала получает ok:false, а не тишину', async () => {
  // BigInt/циклическая ссылка проходят по локальному IPC (structured clone),
  // но не через JSON.stringify — по сети JSON единственный формат. Без
  // отдельного try вокруг сериализации клиент не получил бы вообще ничего
  // и промис на браузерном мосту завис бы навсегда.
  const { server, registry } = makeServer();
  registry.handle('циклическое', async () => { const o = {}; o.self = o; return o; });
  const { port } = await server.start();
  const ws = await open(`ws://127.0.0.1:${port}/ws`);
  ws.send(JSON.stringify({ id: 8, channel: 'циклическое', args: [] }));
  const frame = await nextFrame(ws);
  assert.strictEqual(frame.id, 8);
  assert.strictEqual(frame.ok, false);
  ws.close();
});

// --- Занятый порт не роняет процесс ---------------------------------------

test('порт занят посторонним сервером — start() отклоняется, процесс жив', async () => {
  // WebSocket.Server({server}) сам переизлучает ЛЮБУЮ ошибку http-сервера
  // как wss.emit('error', err) — без своего слушателя на wss EventEmitter
  // бросает необработанное исключение НА ЭТОМ, отдельном пути, и роняет
  // весь процесс раньше, чем reject() успевает сработать. Если бы process
  // упал, этот тест не досчитался бы до assert.rejects — сам факт зелёного
  // теста и есть доказательство.
  const foreign = net.createServer();
  await new Promise((resolve) => foreign.listen(0, '127.0.0.1', resolve));
  try {
    const busyPort = foreign.address().port;
    const { server } = makeServer({ port: busyPort });
    await assert.rejects(() => server.start(), /EADDRINUSE/);
  } finally {
    await new Promise((resolve) => foreign.close(resolve));
  }
});

// --- stop() не должен виснуть на открытых соединениях ---------------------

test('stop() не виснет на висящем keep-alive соединении', async () => {
  // Раньше server.close() ждал, пока браузер САМ отпустит keep-alive-связь
  // (секунды простоя) — тумблер «выключить сеть» и выход из Electron
  // подвисали бы на каждой открытой вкладке браузера. closeAllConnections()
  // рвёт живые соединения принудительно, stop() обязан вернуться быстро.
  const { server } = makeServer();
  const { port } = await server.start();
  const sock = net.connect(port, '127.0.0.1');
  try {
    await new Promise((resolve, reject) => {
      sock.once('connect', resolve);
      sock.once('error', reject);
    });
    sock.write('GET /index.html HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n');
    await new Promise((resolve) => sock.once('data', resolve)); // ответ пошёл, соединение НЕ закрываем
    const t0 = Date.now();
    await server.stop();
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 1000, `stop() занял ${elapsed} мс — висит на keep-alive`);
  } finally {
    sock.destroy();
  }
});

// --- Мелочь: сегмент с ':' (обход MIME/расширения через NTFS ADS) ---------

test('сегмент с двоеточием (index.html::$DATA) не отдаётся как файл', async () => {
  const { server } = makeServer();
  const { port } = await server.start();
  const res = await fetch(`http://127.0.0.1:${port}/index.html::$DATA`);
  assert.notStrictEqual(res.status, 200, 'ADS-путь не должен отдавать файл');
});

// --- Важное наследие раунда 1: ошибка чтения файла не роняет процесс -----
// .pipe() слушает ошибки только на приёмнике — ошибка чтения источника
// (EBUSY: антивирус, npm install поверх node_modules, автообновление,
// редактор с открытым файлом — злоумышленник для этого не нужен) была
// необработанным исключением и валила ВЕСЬ Electron. Живьём проверено
// отдельно (не в этом наборе) настоящей блокировкой файла через PowerShell
// ([System.IO.File]::Open(..., 'None')) — 500, сервер остался жив и тут же
// штатно отдал следующий файл. Здесь — детерминированная регрессия через
// подмену fs.createReadStream: тестировать НЕПРЕДСКАЗУЕМУЮ по времени
// внешнюю блокировку каждый прогон было бы медленно и хрупко, а код не
// различает ПРИЧИНУ ошибки потока — реагирует ровно на само событие 'error'.

test('ошибка чтения ДО открытия файла (аналог EBUSY) — 500, а не падение процесса', async (t) => {
  const { server } = makeServer();
  const { port } = await server.start();
  const mockFn = t.mock.method(fs, 'createReadStream', () => {
    const emitter = new EventEmitter();
    emitter.pipe = () => emitter; // не участвует в проверке — просто заглушка
    process.nextTick(() => {
      emitter.emit('error', Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }));
    });
    return emitter;
  });
  const res = await fetch(`http://127.0.0.1:${port}/index.html`);
  assert.strictEqual(res.status, 500, 'заблокированный файл должен отвечать 500, а не убивать процесс');
  mockFn.mock.restore();
  // Сервер жив — тот же порт штатно обслуживает следующий, уже настоящий запрос.
  const ok = await fetch(`http://127.0.0.1:${port}/index.html`);
  assert.strictEqual(ok.status, 200, 'сервер должен остаться живым после ошибки чтения');
});

test('ошибка чтения ПОСЛЕ открытия файла (обрыв на середине) — соединение рвётся, а не притворяется целым файлом', async (t) => {
  const { server } = makeServer();
  const { port } = await server.start();
  t.mock.method(fs, 'createReadStream', () => {
    const emitter = new EventEmitter();
    emitter.pipe = () => emitter; // заголовки уже уйдут по 'open' — реального тела не шлём
    process.nextTick(() => {
      emitter.emit('open'); // res.writeHead(200) уже случился к этому моменту
      process.nextTick(() => {
        emitter.emit('error', Object.assign(new Error('EIO: чтение упало на середине'), { code: 'EIO' }));
      });
    });
    return emitter;
  });
  // Заголовки (200) уже ушли к моменту ошибки — по протоколу соединение
  // должно оборваться, а не тихо закрыться так, будто файл дошёл целиком.
  await assert.rejects(() => fetch(`http://127.0.0.1:${port}/index.html`).then((r) => r.text()));
});

// --- Эстафета управления: личность клиента, захват, отказ ------------------
// Сервер — единственный, кто знает, ЧЕЙ это сокет: реестр получил бы кадр без
// личности и не отличил бы захват макбуком от захвата локальным окном.

// makeServer из этого файла не знает про эстафету — собираем отдельный,
// с гардом и владением, ровно как их собирает ipc.js в проде.
function makeHandoffServer() {
  const ownership = createOwnership({});
  const registry = createCommandRegistry({
    ipcMain: fakeIpcMain(),
    guard: ({ channel, who }) => !isWriteChannel(channel) || ownership.canWrite(who),
  });
  const written = [];
  registry.handle('term:write', (payload) => { written.push(payload); return 'ок'; });
  registry.handle('usage:get', () => ({ спент: 1 }));
  const server = createNetServer({
    registry,
    ownership,
    broadcast: createBroadcast({ getWindow: () => null }),
    outputBuffer: createOutputBuffer({}),
    staticRoots: { '/': path.join(__dirname, '..', 'src', 'renderer') },
    port: 0,
    host: '127.0.0.1',
  });
  activeServers.push(server);
  return { server, ownership, written };
}

// Кадры копятся С МОМЕНТА создания сокета, а не с момента подписки в теле
// теста. Так надо именно здесь: 'net:hello' сервер шлёт сразу при
// подключении, и он успевает приехать РАНЬШЕ, чем тест подпишется. Причина
// не в скорости сети, а в очередях Node: ws эмитит 'message' из
// process.nextTick, а продолжение `await open(...)` — микротаска промиса,
// она выполняется ПОЗЖЕ nextTick. Обычный nextFrame() (ws.once('message'))
// первый кадр в этой гонке терял бы и ждал следующего вечно — прогон висел
// бы, а не краснел. Общий open()/nextFrame выше не трогаем: у остальных
// тестов такой гонки нет, а менять их поведение задача не просит.
function openBuffered(url) {
  const ws = new WebSocket(url);
  const queue = [];
  let waiting = null;
  ws.on('message', (raw) => {
    const frame = JSON.parse(raw);
    if (waiting) { const resolve = waiting; waiting = null; resolve(frame); return; }
    queue.push(frame);
  });
  ws.takeFrame = () => (queue.length
    ? Promise.resolve(queue.shift())
    : new Promise((resolve) => { waiting = resolve; }));
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (_req, res) => reject(Object.assign(new Error('апгрейд отклонён'), { statusCode: res.statusCode })));
    ws.once('error', reject);
  });
}
const takeFrame = (ws) => ws.takeFrame();

const ask = (ws, frame) => {
  const answer = takeFrame(ws);
  ws.send(JSON.stringify(frame));
  return answer;
};

// --- Адрес для человека (находка ревью: address() не был покрыт вовсе) ------
// Пункт меню трея существует ровно затем, чтобы человек взял адрес и открыл
// его на макбуке. Мутации «address() всегда null» и «address() без реального
// порта» раньше обе оставались зелёными.

test('до старта адреса нет, после старта он с РЕАЛЬНЫМ портом', async () => {
  const { server } = makeServer();
  assert.strictEqual(server.address(), null, 'сервер не слушает — адреса не существует');
  const { port } = await server.start();
  assert.strictEqual(server.address(), `http://127.0.0.1:${port}`);
  // port:0 отдаёт эфемерный порт — в адресе обязан быть он, а не ноль.
  assert.ok(!server.address().endsWith(':0'));
  await server.stop();
  assert.strictEqual(server.address(), null, 'после остановки адрес снова пуст');
});

test('литерал IPv6 в адресе берётся в скобки', async () => {
  const { server } = makeServer({ host: '::1' });
  await server.start();
  assert.match(server.address(), /^http:\/\/\[::1\]:\d+$/);
});

test('«слушаю везде» подменяется адресом, который можно открыть с другой машины', async () => {
  // 0.0.0.0 — не имя, а «на всех интерфейсах»: на макбуке такой адрес
  // бесполезен, а клик по строке трея открыл бы его в браузере.
  const { server } = makeServer({
    host: '0.0.0.0',
    allowedHosts: ['revision-pc.tailb86363.ts.net', '100.120.245.85'],
  });
  const { port } = await server.start();
  assert.strictEqual(server.address(), `http://revision-pc.tailb86363.ts.net:${port}`);
});

test('«слушаю везде» без подсказок — честный localhost, а не 0.0.0.0', async () => {
  const { server } = makeServer({ host: '0.0.0.0', allowedHosts: [] });
  const { port } = await server.start();
  assert.strictEqual(server.address(), `http://127.0.0.1:${port}`);
});

test('клиент узнаёт своё имя сразу после подключения', async () => {
  const { server } = makeHandoffServer();
  const { port } = await server.start();
  const ws = await openBuffered(`ws://127.0.0.1:${port}/ws`);
  const hello = await takeFrame(ws);
  assert.strictEqual(hello.event, 'net:hello');
  assert.strictEqual(typeof hello.payload.clientId, 'string');
  assert.ok(hello.payload.clientId.length > 0);
  ws.close();
});

test('сервер без ownership не шлёт net:hello — старый клиент видит ровно то же, что и раньше', async () => {
  // Эстафета необязательна: в тестах и в сборках без сети createNetServer
  // зовут без ownership. Лишний кадр сразу после подключения сдвинул бы
  // ПЕРВЫЙ кадр у всех, кто просто ждёт ответ на свою команду. Проверяем
  // буферизованным сокетом (ничего не теряется), иначе тест был бы зелёным
  // просто потому, что кадр не успел приехать.
  const { server } = makeServer();
  const { port } = await server.start();
  const ws = await openBuffered(`ws://127.0.0.1:${port}/ws`);
  ws.send(JSON.stringify({ id: 1, channel: 'эхо', args: ['первый'] }));
  assert.deepStrictEqual(await takeFrame(ws), { id: 1, ok: true, result: { эхо: 'первый' } });
  ws.close();
});

test('без управления запись отклоняется, а чтение проходит', async () => {
  const { server, written } = makeHandoffServer();
  const { port } = await server.start();
  const ws = await openBuffered(`ws://127.0.0.1:${port}/ws`);
  await takeFrame(ws); // net:hello

  const denied = await ask(ws, { id: 1, channel: 'term:write', args: [{ tabId: 'T1', data: 'ls\r' }] });
  assert.strictEqual(denied.ok, false);
  assert.strictEqual(denied.denied, true);
  assert.deepStrictEqual(written, [], 'до захвата ни один байт не имеет права дойти до pty');

  const read = await ask(ws, { id: 2, channel: 'usage:get', args: [] });
  assert.strictEqual(read.ok, true, 'чтение доступно и без управления — иначе заглушка слепая');
  ws.close();
});

test('после захвата тот же клиент пишет свободно', async () => {
  const { server, ownership, written } = makeHandoffServer();
  const { port } = await server.start();
  const ws = await openBuffered(`ws://127.0.0.1:${port}/ws`);
  const hello = await takeFrame(ws);

  const claimed = await ask(ws, { id: 1, channel: 'owner:claim', args: [{ cols: 90, rows: 30 }] });
  assert.strictEqual(claimed.ok, true);
  assert.strictEqual(claimed.result.owner, hello.payload.clientId);
  assert.strictEqual(claimed.result.self, hello.payload.clientId);
  assert.deepStrictEqual(ownership.size(), { cols: 90, rows: 30 });

  const ok = await ask(ws, { id: 2, channel: 'term:write', args: [{ tabId: 'T1', data: 'ls\r' }] });
  assert.strictEqual(ok.ok, true);
  assert.deepStrictEqual(written, [{ tabId: 'T1', data: 'ls\r' }]);
  ws.close();
});

test('второй клиент забирает управление у первого', async () => {
  const { server, written } = makeHandoffServer();
  const { port } = await server.start();
  const a = await openBuffered(`ws://127.0.0.1:${port}/ws`);
  await takeFrame(a);
  await ask(a, { id: 1, channel: 'owner:claim', args: [{ cols: 80, rows: 24 }] });

  const b = await openBuffered(`ws://127.0.0.1:${port}/ws`);
  await takeFrame(b);
  await ask(b, { id: 1, channel: 'owner:claim', args: [{ cols: 120, rows: 40 }] });

  const denied = await ask(a, { id: 2, channel: 'term:write', args: [{ tabId: 'T1', data: 'вредное' }] });
  assert.strictEqual(denied.ok, false);
  assert.deepStrictEqual(written, [], 'потерявший управление больше не пишет');
  a.close();
  b.close();
});

test('уход клиента не отдаёт управление обратно локальному окну', async () => {
  const { server, ownership } = makeHandoffServer();
  const { port } = await server.start();
  const ws = await openBuffered(`ws://127.0.0.1:${port}/ws`);
  const hello = await takeFrame(ws);
  await ask(ws, { id: 1, channel: 'owner:claim', args: [{ cols: 80, rows: 24 }] });

  const gone = new Promise((resolve) => ws.on('close', resolve));
  ws.close();
  await gone;
  // Сокет закрывается асинхронно и на стороне сервера — ждём, пока он это заметит.
  const deadline = Date.now() + 2000;
  while (ownership.ownerOnline() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.strictEqual(ownership.owner(), hello.payload.clientId, 'обрыв ≠ потеря управления');
  assert.strictEqual(ownership.ownerOnline(), false);
});
