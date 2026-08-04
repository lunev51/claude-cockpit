'use strict';
// HTTP-статика + WebSocket: через них кокпит открывается на другой машине.
//
// Статика — ТОТ ЖЕ src/renderer, без правок разметки. Проверено на живом
// браузере: ссылка ../../node_modules/... из index.html схлопывается в
// /node_modules/..., поэтому достаточно отдать нужные корни (renderer,
// node_modules, assets — см. задачу 7).
//
// Протокол намеренно примитивный: кадр-запрос с id, кадр-ответ с тем же id,
// кадр-событие без id. Ничего, кроме JSON, — отлаживается глазами в консоли
// браузера.
//
// Ревью первого раунда нашло, что «эталонный» вариант из брифа падает на
// живой сети: битый %-escape в адресе роняет весь Electron, префиксные корни
// не работают на Windows (обратные слэши после normalize против прямых в
// ключах объекта), тест на traversal ничего не проверял (fetch() сам режет
// '..' до отправки), а WebSocket принимал подключение с любого сайта.
// Комментарии ниже — про то, как это закрыто, а не про историю.
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

// Разбираем URL-путь на сегменты по ЛЮБОМУ разделителю ('/' или '\'), а не
// только по '/'. Причина: итоговый path.join() всё равно работает с
// ОС-семантикой, а на Windows он трактует '\' как разделитель независимо от
// того, что мы «думали» об URL. Если резать только по '/', обратный слэш в
// декодированном пути проскакивает мимо разбора одним сегментом-как-есть и
// на path.join снова превращается в переход по каталогу — проверено:
// '/foo/..\\..\\..\\KEYS.md' без такого разбора улетает вплоть до C:\.
function splitSegments(p) {
  return p.split(/[/\\]+/);
}

// Гасим '.' и '..' вручную, сегмент за сегментом, не давая уйти выше начала
// списка. '..' на пустом стеке просто отбрасывается — подняться выше
// стартовой точки невозможно, сколько бы '..' ни было в запросе. Это
// единственный источник защиты от traversal: она работает ДО path.join, а
// не проверяется постфактум строкой startsWith (та проверка добавляла
// ложное чувство безопасности, но реальной работы не делала).
function collapseSegments(segments) {
  const out = [];
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (out.length) out.pop(); continue; }
    out.push(seg);
  }
  return out;
}

function createNetServer({
  registry, broadcast, outputBuffer, staticRoots, port = 48300, host = '127.0.0.1',
}) {
  let server = null;
  let wss = null;
  let boundPort = null;
  const clients = new Set();
  const heartbeats = new Map(); // ws → жив ли с прошлого пинга

  // Корни приводим к абсолютному виду ОДИН раз, здесь. Если этого не
  // сделать, относительный root (например 'src/renderer' вместо полного
  // пути) даёт на выходе path.join() относительный путь, а старая проверка
  // сравнивала его с path.resolve(root) — абсолютным — и никогда не
  // совпадала: сервер тихо отдавал 404 на всё, без единой ошибки в логе.
  const roots = Object.fromEntries(
    Object.entries(staticRoots || {}).map(([prefix, root]) => [prefix, path.resolve(root)]),
  );

  function resolveFile(decodedPath) {
    const clean = collapseSegments(splitSegments(decodedPath.split('?')[0]));
    for (const [rawPrefix, root] of Object.entries(roots)) {
      let rest;
      if (rawPrefix === '/') {
        rest = clean;
      } else {
        // Сравнение ПО СЕГМЕНТАМ, а не по началу строки: префикс '/assets'
        // не имеет права подхватить запрос к '/assets-private/...' — это
        // была бы утечка соседнего корня через похожее имя.
        const prefixSegs = collapseSegments(splitSegments(rawPrefix));
        const matches = prefixSegs.length <= clean.length
          && prefixSegs.every((seg, i) => clean[i] === seg);
        if (!matches) continue;
        rest = clean.slice(prefixSegs.length);
      }
      const abs = rest.length ? path.join(root, ...rest) : path.join(root, 'index.html');
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
      // Файла тут нет — пробуем СЛЕДУЮЩИЙ корень, а не сдаёмся сразу: иначе
      // первый совпавший по префиксу, но безуспешный корень обрывал бы
      // поиск в остальных.
    }
    return null;
  }

  function onHttp(req, res) {
    const rawUrl = req.url === '/' ? '/index.html' : req.url;
    let decoded;
    try {
      decoded = decodeURIComponent(rawUrl.split('?')[0]);
    } catch {
      // %zz, одинокий '%' и подобная битая percent-escape-последовательность
      // — ошибка клиента (опечатка в адресе на макбуке, сканер портов), а не
      // повод ронять процесс. Без try/catch это необработанное исключение
      // валит ВЕСЬ Electron вместе со всеми pty открытых вкладок.
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('битый путь');
      return;
    }
    const file = resolveFile(decoded);
    if (!file) { res.writeHead(404); res.end('нет такого'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  }

  async function onFrame(ws, raw) {
    let msg;
    // Битый кадр не имеет права ронять сервер: на другом конце браузер,
    // который может прислать что угодно при обрыве. Если распарсить вообще
    // не удалось — отвечать нечем (id неизвестен), просто молчим.
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;

    const hasId = Object.prototype.hasOwnProperty.call(msg, 'id');
    const reply = (body) => { try { ws.send(JSON.stringify({ id: msg.id, ...body })); } catch { /* сокет ушёл */ } };

    // Протокол обещает {id, ok:false, error} на любую свою ошибку, а не
    // тишину: браузерный мост держит промис по id, и без ответа он повис бы
    // навсегда. Молчим только когда id вообще нет — отвечать некому.
    if (typeof msg.channel !== 'string') {
      if (hasId) reply({ ok: false, error: 'протокол: нет канала' });
      return;
    }
    if (msg.args !== undefined && !Array.isArray(msg.args)) {
      if (hasId) reply({ ok: false, error: 'протокол: args должен быть массивом' });
      return;
    }
    const args = Array.isArray(msg.args) ? msg.args : [];
    try {
      // net:buffer обслуживает сервер, а не реестр: история — свойство
      // соединения, локальному окну она не нужна (у него свой xterm).
      const result = msg.channel === 'net:buffer'
        ? outputBuffer.get(args[0])
        : await registry.call(msg.channel, args);
      reply({ ok: true, result: result === undefined ? null : result });
    } catch (err) {
      reply({ ok: false, error: String((err && err.message) || err) });
    }
  }

  // Разрешаем подключаться только странице, реально загруженной С ЭТОГО
  // сервера. Без этой проверки любая вкладка, открытая в браузере на том же
  // ПК, могла бы подключиться к сокету и вызвать ЛЮБУЮ команду реестра —
  // включая запись в терминал. WebSocket не подчиняется CORS/same-origin
  // сам по себе, это надо проверять руками на этапе апгрейда.
  //
  // Origin отсутствует — не браузер (тестовый клиент, будущий нативный
  // инструмент): пропускаем. Риск именно в случаях, когда Origin ЕСТЬ и он
  // чужой, — подделать сам заголовок со страницы браузер не даёт.
  function isAllowedOrigin(origin) {
    if (!origin) return true;
    const allowed = new Set([
      `http://${host}:${boundPort}`,
      `http://127.0.0.1:${boundPort}`,
      `http://localhost:${boundPort}`,
    ]);
    return allowed.has(origin);
  }

  return {
    start() {
      return new Promise((resolve, reject) => {
        server = http.createServer(onHttp);
        wss = new WebSocket.Server({
          server,
          path: '/ws',
          verifyClient: (info, callback) => {
            const ok = isAllowedOrigin(info.origin);
            callback(ok, ok ? undefined : 403, ok ? undefined : 'чужой origin');
          },
        });
        wss.on('connection', (ws) => {
          const send = (event, payload) => ws.send(JSON.stringify({ event, payload }));
          clients.add(ws);
          heartbeats.set(ws, true);
          broadcast.addClient(send);
          ws.on('message', (raw) => onFrame(ws, raw));
          ws.on('pong', () => heartbeats.set(ws, true));
          ws.on('close', () => { clients.delete(ws); heartbeats.delete(ws); broadcast.removeClient(send); });
          ws.on('error', () => { clients.delete(ws); heartbeats.delete(ws); broadcast.removeClient(send); });
        });
        // Полуоткрытые соединения (закрыли крышку макбука посреди сессии)
        // иначе не обнаруживаются до таймаута TCP — вкладка выглядела бы
        // подключённой, а событий и ответов не было бы никогда.
        const heartbeat = setInterval(() => {
          for (const ws of clients) {
            if (heartbeats.get(ws) === false) { ws.terminate(); continue; }
            heartbeats.set(ws, false);
            try { ws.ping(); } catch { /* сокет уже уходит */ }
          }
        }, 30000);
        heartbeat.unref(); // не держит процесс живым, если забыли позвать stop()

        // Слушатель ошибок ДО успешного listen — только чтобы отклонить
        // промис старта (например, порт занят). После успешного старта его
        // обязательно снимаем: иначе он навсегда перехватывает reject уже
        // разрешённого промиса и глушит все дальнейшие ошибки сервера.
        const onStartError = (err) => { clearInterval(heartbeat); reject(err); };
        server.on('error', onStartError);
        server.listen(port, host, () => {
          server.removeListener('error', onStartError);
          server.on('error', (err) => console.log(`[net] ошибка сервера: ${err.message}`));
          boundPort = server.address().port;
          server._cockpitHeartbeat = heartbeat; // чтобы stop() мог его погасить
          resolve({ port: boundPort });
        });
      });
    },
    stop() {
      return new Promise((resolve) => {
        if (server && server._cockpitHeartbeat) clearInterval(server._cockpitHeartbeat);
        for (const ws of clients) { try { ws.terminate(); } catch { /* уже мёртв */ } }
        clients.clear();
        heartbeats.clear();
        // wss.close() снимает собственные слушатели ('upgrade' и т.д.) с
        // http-сервера — без этого объект wss продолжал бы висеть в памяти
        // и реагировать на апгрейды даже после того, как http-сервер лёг.
        if (wss) { try { wss.close(); } catch { /* уже закрыт */ } }
        if (!server) { resolve(); return; }
        server.close(() => resolve());
      });
    },
    clientCount: () => clients.size,
  };
}

module.exports = { createNetServer };
