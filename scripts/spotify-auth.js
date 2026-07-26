'use strict';
// ОДНОРАЗОВАЯ авторизация Spotify (Authorization Code flow): открывает браузер,
// ты подтверждаешь доступ своим аккаунтом, скрипт ловит код на localhost:8888,
// меняет его на refresh_token и дописывает в companion-home/.spotify.json.
// Дальше spotify-play.js играет треки без повторного входа.
//
// Запуск: node spotify-auth.js   (нужны clientId/clientSecret в .spotify.json)

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { exec } = require('child_process');

const REDIRECT = 'http://127.0.0.1:8888/callback';
const SCOPES = 'user-modify-playback-state user-read-playback-state';

function credsPath() {
  // .spotify.json в companion-home (рядом, на два уровня вверх от scripts/).
  return path.join(__dirname, '..', '..', 'companion-home', '.spotify.json');
}
function loadCreds() {
  return JSON.parse(fs.readFileSync(credsPath(), 'utf8'));
}
function saveCreds(obj) {
  fs.writeFileSync(credsPath(), JSON.stringify(obj, null, 2), 'utf8');
}

function exchangeCode(creds, code) {
  const auth = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');
  const body = `grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(REDIRECT)}`;
  return new Promise((resolve, reject) => {
    const req = https.request({
      method: 'POST', hostname: 'accounts.spotify.com', path: '/api/token',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${text}`));
        try { resolve(JSON.parse(text)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function main() {
  const creds = loadCreds();
  const authUrl = `https://accounts.spotify.com/authorize?client_id=${creds.clientId}` +
    `&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT)}` +
    `&scope=${encodeURIComponent(SCOPES)}`;

  const server = http.createServer(async (req, res) => {
    if (!req.url.startsWith('/callback')) { res.writeHead(404).end(); return; }
    const code = new URL(req.url, REDIRECT).searchParams.get('code');
    if (!code) { res.writeHead(400).end('no code'); return; }
    try {
      const tok = await exchangeCode(creds, code);
      creds.refreshToken = tok.refresh_token;
      saveCreds(creds);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h2>Готово! Spotify подключён. Можно закрыть вкладку.</h2>');
      console.log('OK: refresh_token сохранён в .spotify.json');
      setTimeout(() => { server.close(); process.exit(0); }, 500);
    } catch (err) {
      res.writeHead(500).end(String(err.message));
      console.error('Ошибка обмена кода:', err.message);
      setTimeout(() => process.exit(1), 500);
    }
  });

  server.listen(8888, '127.0.0.1', () => {
    console.log('Открываю браузер для входа в Spotify…');
    exec(`start "" "${authUrl}"`, { shell: 'cmd.exe' });
    console.log('Если не открылось — вставь вручную:\n' + authUrl);
  });
}

main();
