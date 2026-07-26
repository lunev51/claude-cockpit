'use strict';
// Разовый вход в Google Calendar (OAuth Desktop, loopback redirect).
// Запусти ОДИН раз: node gcal-auth.js
//   1) откроется браузер с экраном согласия Google;
//   2) после «Разрешить» Google вернёт код на http://localhost:<порт>;
//   3) скрипт обменяет код на refresh-токен и сохранит в .gcal-token.json.
// Повторно запускать не нужно (токен живёт постоянно, пока не отзовёшь доступ).

const http = require('http');
const { exec } = require('child_process');
const core = require('./gcal-core');

const PORT = 53682; // loopback-порт для редиректа (Desktop-клиент разрешает любой)
const REDIRECT = `http://localhost:${PORT}`;

function authUrl() {
  const { clientId } = core.loadCreds();
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: core.SCOPE,
    access_type: 'offline',
    prompt: 'consent', // гарантируем выдачу refresh_token
  });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + p.toString();
}

function openBrowser(url) {
  // Windows: start через cmd; кавычки-заглушка для адреса с &.
  exec(`start "" "${url}"`, { shell: 'cmd.exe' }, () => {});
}

function main() {
  try { core.loadCreds(); } catch (e) {
    console.error('✗', e.message);
    process.exit(1);
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, REDIRECT);
    const code = u.searchParams.get('code');
    const err = u.searchParams.get('error');
    if (!code && !err) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (err) {
      res.end('<h2>Отказано в доступе. Можно закрыть вкладку.</h2>');
      console.error('✗ Google вернул ошибку:', err);
      server.close(); process.exit(1);
      return;
    }
    res.end('<h2>Готово! Юки привязана к календарю. Можно закрыть вкладку.</h2>');
    try {
      await core.exchangeCode(code, REDIRECT);
      console.log('✓ Токен сохранён — Календарь привязан.');
      server.close(); process.exit(0);
    } catch (e) {
      console.error('✗ Не удалось обменять код:', e.message);
      server.close(); process.exit(1);
    }
  });

  server.on('error', (e) => {
    console.error(`✗ Не поднять localhost:${PORT}: ${e.message}`);
    process.exit(1);
  });

  server.listen(PORT, '127.0.0.1', () => {
    const url = authUrl();
    console.log('Открываю браузер для входа в Google…');
    console.log('Если не открылся сам — перейди вручную:\n' + url);
    openBrowser(url);
  });
}

main();
