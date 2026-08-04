'use strict';
// HTTP-статика + WebSocket: через них кокпит открывается на другой машине.
//
// Статика — ТОТ ЖЕ src/renderer, без правок разметки. Проверено на живом
// браузере: ссылка ../../node_modules/... из index.html схлопывается в
// /node_modules/..., поэтому достаточно отдать две папки.
//
// Протокол намеренно примитивный: кадр-запрос с id, кадр-ответ с тем же id,
// кадр-событие без id. Ничего, кроме JSON, — отлаживается глазами в консоли
// браузера.
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

function createNetServer({
  registry, broadcast, outputBuffer, staticRoots, port = 48300, host = '127.0.0.1',
}) {
  let server = null;
  let wss = null;
  const clients = new Set();

  // Каждый путь обязан остаться внутри объявленного корня: '..' в запросе —
  // это попытка вылезти к KEYS.md и остальному, что лежит рядом.
  function resolveFile(urlPath) {
    const clean = path.normalize(decodeURIComponent(urlPath.split('?')[0]));
    for (const [prefix, root] of Object.entries(staticRoots)) {
      if (prefix !== '/' && !clean.startsWith(prefix)) continue;
      const rel = prefix === '/' ? clean : clean.slice(prefix.length);
      const abs = path.join(root, rel === '' || rel === '\\' ? 'index.html' : rel);
      if (!abs.startsWith(path.resolve(root))) return null;
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
    }
    return null;
  }

  function onHttp(req, res) {
    const file = resolveFile(req.url === '/' ? '/index.html' : req.url);
    if (!file) { res.writeHead(404); res.end('нет такого'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  }

  async function onFrame(ws, raw) {
    let msg;
    // Битый кадр не имеет права ронять сервер: на другом конце браузер,
    // который может прислать что угодно при обрыве.
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.channel !== 'string') return;
    const args = Array.isArray(msg.args) ? msg.args : [];
    const reply = (body) => { try { ws.send(JSON.stringify({ id: msg.id, ...body })); } catch { /* сокет ушёл */ } };
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

  return {
    start() {
      return new Promise((resolve, reject) => {
        server = http.createServer(onHttp);
        wss = new WebSocket.Server({ server, path: '/ws' });
        wss.on('connection', (ws) => {
          const send = (event, payload) => ws.send(JSON.stringify({ event, payload }));
          clients.add(ws);
          broadcast.addClient(send);
          ws.on('message', (raw) => onFrame(ws, raw));
          ws.on('close', () => { clients.delete(ws); broadcast.removeClient(send); });
          ws.on('error', () => { clients.delete(ws); broadcast.removeClient(send); });
        });
        server.on('error', reject);
        server.listen(port, host, () => resolve({ port: server.address().port }));
      });
    },
    stop() {
      return new Promise((resolve) => {
        for (const ws of clients) { try { ws.terminate(); } catch { /* уже мёртв */ } }
        clients.clear();
        if (!server) { resolve(); return; }
        server.close(() => resolve());
      });
    },
    clientCount: () => clients.size,
  };
}

module.exports = { createNetServer };
