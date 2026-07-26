'use strict';
// HTTP-приёмник событий хуков Claude Code. Слушает только 127.0.0.1.
// Хук-скрипт (scripts/cockpit-hook.js) POST-ит {event, data} на /event;
// data — это stdin-JSON хука (session_id, cwd, tool_name, message, …).
// Единственный источник правды о статусах — эти события (спека §4.1).

const http = require('http');
const fs = require('fs');

function createHookBridge({ sessions, port = 0, portFile = null }) {
  let server = null;
  let actualPort = 0;

  function route(event, data) {
    let tabId = data.session_id ? sessions.findBySessionId(data.session_id) : null;
    // До первого SessionStart вкладка ещё не привязана — ищем по cwd
    // среди непривязанных (двух непривязанных вкладок одного cwd мост
    // различить не может — привяжется первая, вторая дождётся своего события).
    if (!tabId && data.cwd) tabId = sessions.findUnboundByCwd(data.cwd);
    if (!tabId) return false;
    sessions.applyHookEvent(tabId, event, data);
    return true;
  }

  function handler(req, res) {
    if (req.method !== 'POST' || req.url !== '/event') {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 256 * 1024) req.destroy(); // защита от мусора
    });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* мусор */ }
      if (!parsed || typeof parsed.event !== 'string') {
        res.writeHead(400, { 'content-type': 'application/json' }).end('{"ok":false}');
        return;
      }
      const data = (parsed.data && typeof parsed.data === 'object') ? parsed.data : {};
      let routed = false;
      try { routed = route(parsed.event, data); } catch (err) {
        console.warn(`[hook-bridge] ошибка маршрутизации: ${err.message}`);
      }
      res.writeHead(routed ? 200 : 202, { 'content-type': 'application/json' }).end('{"ok":true}');
    });
  }

  function start() {
    return new Promise((resolve, reject) => {
      server = http.createServer(handler);
      server.on('error', reject);
      server.listen(port, '127.0.0.1', () => {
        actualPort = server.address().port;
        if (portFile) {
          try { fs.writeFileSync(portFile, String(actualPort), 'utf8'); } catch (err) {
            console.warn(`[hook-bridge] не записал port-файл: ${err.message}`);
          }
        }
        resolve(actualPort);
      });
    });
  }

  function stop() {
    if (server) {
      try { server.close(); } catch { /* уже */ }
      server = null;
    }
  }

  return { start, stop, port: () => actualPort };
}

module.exports = { createHookBridge };
