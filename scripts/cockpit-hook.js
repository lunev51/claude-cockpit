#!/usr/bin/env node
'use strict';
// Хук Claude Code → POST в Cockpit hook-bridge. КОНТРАКТ: никогда не мешать
// работе CLI — любая ошибка глотается, exit 0 всегда, таймаут 400 мс.
// Использование: node cockpit-hook.js <EventName> --port-file "<path>"
// Порт: env COCKPIT_BRIDGE_PORT (хуки — потомки pty кокпита), иначе port-файл
// (сессии, запущенные вне кокпита, пока кокпит открыт).

const http = require('http');
const fs = require('fs');

function isValidPort(port) {
  return Number.isInteger(port) && port > 0 && port < 65536;
}

function resolvePort(argv) {
  if (process.env.COCKPIT_BRIDGE_PORT) {
    const p = Number(process.env.COCKPIT_BRIDGE_PORT);
    if (isValidPort(p)) return p;
  }
  const i = argv.indexOf('--port-file');
  if (i !== -1 && argv[i + 1]) {
    try {
      const p = Number(fs.readFileSync(argv[i + 1], 'utf8').trim());
      if (isValidPort(p)) return p;
    } catch { /* нет файла */ }
  }
  return 0;
}

function main() {
  // Контракт абсолютен: НИКОГДА не мешать CLI. Любая непойманная ошибка — тихий выход 0.
  process.on('uncaughtException', () => process.exit(0));
  process.on('unhandledRejection', () => process.exit(0));
  process.stdin.on('error', () => process.exit(0));

  const event = process.argv[2];
  const port = resolvePort(process.argv);
  if (!event || !port) process.exit(0);

  let stdin = '';
  process.stdin.on('data', (c) => { stdin += c; });
  process.stdin.on('end', () => {
    let data = {};
    try { data = JSON.parse(stdin); } catch { /* хук без JSON — шлём пустой */ }
    // tabId — точный канал адресации моста (hook-bridge.js): COCKPIT_TAB_ID
    // наследуется из env pty-процесса кокпита, если этот хук — потомок именно
    // его вкладки. У СТОРОННИХ claude-сессий той же папки (запущенных вручную,
    // не из кокпита) такой переменной нет — им достанется tabId: null, и мост
    // не сможет спутать их с чужой вкладкой по одному лишь cwd/session_id.
    //
    // gen (доп. находка ревью Task 1 фазы 7, задача 5): COCKPIT_TAB_GEN —
    // поколение pty-процесса на момент ЕГО спавна (sessions.js/spawn()), тоже
    // наследуется только потомками вкладки кокпита. Мост сверяет его с
    // ТЕКУЩИМ поколением вкладки — если к моменту, когда этот хук долетел,
    // вкладка уже успела перезапуститься/закрыться (новое поколение), событие
    // отбрасывается целиком: оно принадлежит уже мёртвому процессу и не
    // должно ничего менять в новой сессии (в т.ч. вбрасывать очередь
    // промптов на Stop). Нет переменной (сторонняя сессия, гипотетический
    // старый мост) — gen: null, мост тогда не гардит поколение вовсе.
    const rawGen = Number(process.env.COCKPIT_TAB_GEN);
    const gen = Number.isInteger(rawGen) && rawGen > 0 ? rawGen : null;
    const payload = JSON.stringify({
      event, data, tabId: process.env.COCKPIT_TAB_ID || null, gen,
    });
    try {
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
    } catch { process.exit(0); }
  });
  // Стража: даже если stdin не закроется — выходим.
  setTimeout(() => process.exit(0), 1500).unref();
}

main();
