#!/usr/bin/env node
'use strict';
// Хук Claude Code → POST в Cockpit hook-bridge. КОНТРАКТ: никогда не мешать
// работе CLI — любая ошибка глотается, exit 0 всегда, таймаут 400 мс.
// Использование: node cockpit-hook.js <EventName> --port-file "<path>"
// Порт: env COCKPIT_BRIDGE_PORT (хуки — потомки pty кокпита), иначе port-файл
// (сессии, запущенные вне кокпита, пока кокпит открыт).

const http = require('http');
const fs = require('fs');

function resolvePort(argv) {
  if (process.env.COCKPIT_BRIDGE_PORT) return Number(process.env.COCKPIT_BRIDGE_PORT);
  const i = argv.indexOf('--port-file');
  if (i !== -1 && argv[i + 1]) {
    try { return Number(fs.readFileSync(argv[i + 1], 'utf8').trim()); } catch { /* нет файла */ }
  }
  return 0;
}

function main() {
  const event = process.argv[2];
  const port = resolvePort(process.argv);
  if (!event || !port) process.exit(0);

  let stdin = '';
  process.stdin.on('data', (c) => { stdin += c; });
  process.stdin.on('end', () => {
    let data = {};
    try { data = JSON.parse(stdin); } catch { /* хук без JSON — шлём пустой */ }
    const payload = JSON.stringify({ event, data });
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/event',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      timeout: 400,
    }, (res) => { res.resume(); res.on('end', () => process.exit(0)); });
    req.on('timeout', () => { req.destroy(); process.exit(0); });
    req.on('error', () => process.exit(0));
    req.end(payload);
  });
  // Стража: даже если stdin не закроется — выходим.
  setTimeout(() => process.exit(0), 1500).unref();
}

main();
