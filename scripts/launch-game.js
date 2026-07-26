'use strict';
// Запуск УСТАНОВЛЕННЫХ игр по названию (а не открытие лаунчера Steam).
// Авто-находит игры Steam по манифестам (steamapps/appmanifest_*.acf) во всех
// библиотеках, плюс читает companion-home/игры.txt («название = команда») для
// не-Steam игр. Запускает конкретную игру: steam://rungameid/<appid>.
//
//   node launch-game.js "<название>"   — найти и запустить
//   node launch-game.js list           — показать найденные игры

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const core = require('./gcal-core'); // только ради core.HOME (companion-home)

function steamRoots() {
  const roots = [];
  for (const p of ['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam']) {
    if (fs.existsSync(path.join(p, 'steamapps'))) roots.push(p);
  }
  // доп. библиотеки (другие диски) из libraryfolders.vdf
  for (const r of [...roots]) {
    try {
      const t = fs.readFileSync(path.join(r, 'steamapps', 'libraryfolders.vdf'), 'utf8');
      for (const m of t.matchAll(/"path"\s+"([^"]+)"/g)) {
        const lib = m[1].replace(/\\\\/g, '\\');
        if (fs.existsSync(path.join(lib, 'steamapps')) && !roots.includes(lib)) roots.push(lib);
      }
    } catch { /* */ }
  }
  return roots;
}

function steamGames() {
  const games = [];
  for (const root of steamRoots()) {
    const dir = path.join(root, 'steamapps');
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      const m = f.match(/^appmanifest_(\d+)\.acf$/);
      if (!m) continue;
      const appid = m[1];
      let name = `Steam ${appid}`;
      try {
        const nm = fs.readFileSync(path.join(dir, f), 'utf8').match(/"name"\s+"([^"]+)"/);
        if (nm) name = nm[1];
      } catch { /* */ }
      games.push({ name, launch: `steam://rungameid/${appid}`, source: 'steam' });
    }
  }
  return games;
}

function txtGames() {
  const out = [];
  let lines;
  try {
    lines = fs.readFileSync(path.join(core.HOME, 'игры.txt'), 'utf8')
      .replace(/^﻿/, '').split(/\r?\n/);
  } catch { return out; }
  for (const line of lines) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq < 0) continue;
    const name = s.slice(0, eq).trim();
    const cmd = s.slice(eq + 1).trim();
    if (name && cmd) out.push({ name, launch: cmd, source: 'txt' });
  }
  return out;
}

function allGames() {
  const seen = new Set();
  const out = [];
  for (const g of [...txtGames(), ...steamGames()]) {  // свои (txt) — в приоритете
    const k = g.name.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(g); }
  }
  return out;
}

function findGame(query, games) {
  const q = query.trim().toLowerCase();
  return games.find((g) => g.name.toLowerCase() === q)
    || games.find((g) => g.name.toLowerCase().includes(q))
    || games.find((g) => q.includes(g.name.toLowerCase()));
}

const arg = process.argv.slice(2).join(' ').trim();
const games = allGames();

if (!arg || arg.toLowerCase() === 'list') {
  if (!games.length) { console.log('Установленных игр не нашёл.'); process.exit(0); }
  console.log(`Найдено игр: ${games.length}`);
  for (const g of games) console.log(`- ${g.name}${g.source === 'txt' ? ' (своя)' : ''}`);
  process.exit(0);
}

const g = findGame(arg, games);
if (!g) {
  console.error(`Не нашёл игру «${arg}». Запусти 'list', чтобы увидеть установленные, и подбери точное название.`);
  process.exit(1);
}
exec(`start "" "${g.launch}"`, { shell: 'cmd.exe', windowsHide: true }, () => {});
console.log(`▶ Запускаю: ${g.name}`);
