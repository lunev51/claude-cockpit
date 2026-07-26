'use strict';
// Диагностика: интерактивная сессия claude через pty (как в companion),
// отправляем промпт, ждём ответ и Stop-хук, выходим.
// Запуск: node scripts/drive-claude.js (из корня проекта).

const path = require('path');
const pty = require('@homebridge/node-pty-prebuilt-multiarch');

const cwd = 'C:\\Users\\Lunev\\AssistClaude\\companion-home';
const proc = pty.spawn('C:\\Users\\Lunev\\.local\\bin\\claude.exe', ['--model', 'sonnet'], {
  name: 'xterm-256color',
  cols: 120,
  rows: 30,
  cwd,
  env: { ...process.env, CC_COMPANION: '1' },
  useConpty: true,
  useConptyDll: true,
});

let out = '';
proc.onData((d) => { out += d; });

// Через 6с (после загрузки TUI) — отправляем промпт.
setTimeout(() => {
  proc.write('ответь одним коротким предложением: как дела?\r');
}, 6000);

// Через 40с — завершаем сессию (Ctrl+C дважды + exit).
setTimeout(() => {
  proc.write('\x03');
  setTimeout(() => { proc.write('\x03'); }, 500);
  setTimeout(() => { try { proc.kill(); } catch {} }, 1500);
}, 40000);

proc.onExit(() => {
  const clean = out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
  console.log('--- хвост вывода сессии (очищенный) ---');
  console.log(clean.slice(-600));
  process.exit(0);
});
