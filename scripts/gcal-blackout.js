'use strict';
// Управление «чёрными датами» (дни, когда Данил недоступен — на них не ставятся
// события). Редактирует секцию `блокировать:` в календарь-правила.txt с твоих слов.
//
//   node gcal-blackout.js add YYYY-MM-DD ["причина"]
//   node gcal-blackout.js remove YYYY-MM-DD
//   node gcal-blackout.js list

const fs = require('fs');
const path = require('path');
const core = require('./gcal-core');

const RULES = path.join(core.HOME, 'календарь-правила.txt');

function readLines() {
  return fs.readFileSync(RULES, 'utf8').replace(/^﻿/, '').split(/\r?\n/);
}
function writeLines(lines) {
  fs.writeFileSync(RULES, lines.join('\n'), 'utf8');
}
// Дата из строки секции (без комментария).
function dateOf(line) {
  const m = String(line).replace(/#.*/, '').trim().match(/^\d{4}-\d{2}-\d{2}$/);
  return m ? m[0] : null;
}

function add(date, comment) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { console.error('✗ Нужна дата YYYY-MM-DD'); process.exit(2); }
  const lines = readLines();
  if (lines.some((l) => dateOf(l) === date)) { console.log(`Уже в чёрных датах: ${date}`); return; }
  let idx = lines.findIndex((l) => /^блокировать\s*:/.test(l.trim()));
  if (idx < 0) { lines.push('', 'блокировать:'); idx = lines.length - 1; }
  lines.splice(idx + 1, 0, comment ? `${date}   # ${comment}` : date);
  writeLines(lines);
  console.log(`✓ Добавлена чёрная дата: ${date}${comment ? ' (' + comment + ')' : ''}`);
}

function remove(date) {
  const lines = readLines();
  const kept = lines.filter((l) => dateOf(l) !== date);
  if (kept.length === lines.length) { console.log(`Не было в чёрных датах: ${date}`); return; }
  writeLines(kept);
  console.log(`✓ Снята чёрная дата: ${date}`);
}

function list() {
  const dates = [...core.loadRules().blackout].sort();
  if (!dates.length) { console.log('Чёрных дат нет.'); return; }
  const wf = new Intl.DateTimeFormat('ru-RU', { weekday: 'short', day: '2-digit', month: '2-digit' });
  console.log(`Чёрные даты (${dates.length}):`);
  for (const d of dates) {
    const [y, m, dd] = d.split('-').map(Number);
    console.log(`- ${d} (${wf.format(new Date(Date.UTC(y, m - 1, dd)))})`);
  }
}

const [cmd, date, ...rest] = process.argv.slice(2);
try {
  if (cmd === 'add') add(date, rest.join(' ').trim());
  else if (cmd === 'remove') remove(date);
  else if (cmd === 'list') list();
  else { console.error('Использование: gcal-blackout.js add|remove YYYY-MM-DD | list'); process.exit(2); }
} catch (e) {
  console.error('✗ Ошибка:', e.message); process.exit(1);
}
