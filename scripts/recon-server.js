'use strict';
// Разведка перед портированием кокпита в сеть (вариант A, 03.08).
// Одноразовый сервер: отдаёт страницу-испытание и принимает от неё отчёт.
//
// Проверяет РАЗОМ четыре неизвестных, ради которых затевалась разведка:
//   1. достаёт ли макбук до ПК по Tailscale и не режет ли firewall;
//   2. какие горячие клавиши браузер на macOS вообще отдаёт странице;
//   3. есть ли на маке шрифт терминала и как выглядят глифы Nerd Font;
//   4. задержка канала (round-trip на пустой ответ).
//
// Заодно проверяет главную техническую догадку варианта A: что renderer
// поедет по HTTP без правки разметки, потому что путь ../../node_modules
// браузер схлопывает в /node_modules. Страница грузит xterm ИМЕННО так.
//
// Запуск: node scripts/recon-server.js    Остановка: Ctrl+C.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 48210;
const ROOT = path.join(__dirname, '..');
const REPORT = path.join(ROOT, 'docs', 'recon-report.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
};

// Отдаём только из двух корней и только те расширения, что нужны странице.
// Разведочный сервер живёт полчаса, но пусть даже полчаса он не будет
// раздавать весь диск.
function resolveSafe(urlPath) {
  const clean = path.normalize(decodeURIComponent(urlPath.split('?')[0]));
  if (clean.includes('..')) return null;
  if (clean === '/' || clean === '\\') return path.join(__dirname, 'recon.html');
  const abs = path.join(ROOT, clean);
  const okRoot = abs.startsWith(path.join(ROOT, 'node_modules'))
    || abs.startsWith(path.join(ROOT, 'assets'))
    || abs.startsWith(path.join(ROOT, 'src', 'renderer'))
    || abs.startsWith(path.join(ROOT, 'scripts'));
  if (!okRoot) return null;
  if (!MIME[path.extname(abs)]) return null;
  return abs;
}

const server = http.createServer((req, res) => {
  // Логируем КАЖДЫЙ запрос: во втором заходе отчёт не пришёл, и без этого
  // невозможно было отличить «страница не обновилась» от «отправка не дошла».
  const who = (req.socket.remoteAddress || '').replace('::ffff:', '');
  console.log(`${new Date().toLocaleTimeString('ru-RU')} ${who} ${req.method} ${req.url}`);

  // Пустой ответ для замера задержки — минимальный, чтобы мерить канал,
  // а не работу сервера.
  if (req.url.startsWith('/ping')) {
    res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
    res.end('.');
    return;
  }

  if (req.method === 'POST' && req.url.startsWith('/report')) {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try {
        fs.mkdirSync(path.dirname(REPORT), { recursive: true });
        fs.writeFileSync(REPORT, body, 'utf8');
        console.log(`\n[отчёт получен] ${REPORT} (${body.length} байт)`);
      } catch (e) {
        console.error('[отчёт] не записался:', e.message);
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    return;
  }

  const file = resolveSafe(req.url);
  if (!file || !fs.existsSync(file)) { res.writeHead(404); res.end('нет такого'); return; }
  // no-store на саму страницу: правки в ней бесполезны, если браузер отдаёт
  // клиенту вчерашнюю копию из кэша (подозрение на это и сорвало второй заход).
  const headers = { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' };
  if (path.extname(file) === '.html') headers['cache-control'] = 'no-store, must-revalidate';
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Разведочный сервер поднят.');
  console.log(`  с этого ПК   : http://localhost:${PORT}/`);
  console.log(`  с макбука    : http://100.120.245.85:${PORT}/`);
  console.log('Отчёт со страницы придёт в docs/recon-report.json. Ctrl+C — остановить.');
});
