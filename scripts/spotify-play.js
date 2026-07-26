'use strict';
// «Включи трек X в моём Spotify» через Web API (Premium). Полная цепочка:
// запрос → поиск трека → (refresh_token → access_token) → выбор активного
// устройства (desktop Spotify) → PUT /me/player/play с URI трека.
// Не зависит от фокуса окна и симуляции клавиш.
//
// Креды: companion-home/.spotify.json {clientId, clientSecret, refreshToken}
// refreshToken создаётся однократно скриптом spotify-auth.js.
//
// Запуск: node spotify-play.js "queen bohemian rhapsody"

const fs = require('fs');
const path = require('path');
const https = require('https');

function loadCreds() {
  for (const dir of [process.cwd(), path.join(__dirname, '..', '..', 'companion-home')]) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, '.spotify.json'), 'utf8'));
      if (j.clientId && j.clientSecret) return j;
    } catch { /* пробуем дальше */ }
  }
  return null;
}

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, text });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function clientToken(creds) {
  const auth = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');
  const body = 'grant_type=client_credentials';
  const r = await request({
    method: 'POST', hostname: 'accounts.spotify.com', path: '/api/token',
    headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': body.length },
  }, body);
  return JSON.parse(r.text).access_token;
}

async function userToken(creds) {
  if (!creds.refreshToken) throw new Error('нет refreshToken — запусти spotify-auth.js');
  const auth = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');
  const body = `grant_type=refresh_token&refresh_token=${encodeURIComponent(creds.refreshToken)}`;
  const r = await request({
    method: 'POST', hostname: 'accounts.spotify.com', path: '/api/token',
    headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
  }, body);
  if (r.status !== 200) throw new Error(`refresh failed: ${r.text}`);
  return JSON.parse(r.text).access_token;
}

async function searchTrack(token, query) {
  const r = await request({
    method: 'GET', hostname: 'api.spotify.com',
    path: `/v1/search?q=${encodeURIComponent(query)}&type=track&limit=1&market=RU`,
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const item = JSON.parse(r.text).tracks?.items?.[0];
  return item ? { uri: item.uri, title: item.name, artist: (item.artists || []).map((a) => a.name).join(', ') } : null;
}

async function getDevices(token) {
  const r = await request({
    method: 'GET', hostname: 'api.spotify.com', path: '/v1/me/player/devices',
    headers: { 'Authorization': `Bearer ${token}` },
  });
  return JSON.parse(r.text).devices || [];
}

async function play(token, uri, deviceId) {
  const qs = deviceId ? `?device_id=${deviceId}` : '';
  const body = JSON.stringify({ uris: [uri] });
  return request({
    method: 'PUT', hostname: 'api.spotify.com', path: `/v1/me/player/play${qs}`,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, body);
}

async function main() {
  const query = process.argv.slice(2).join(' ').trim();
  if (!query) { console.error('Использование: node spotify-play.js "запрос"'); process.exit(2); }
  const creds = loadCreds();
  if (!creds) { console.error('Нет .spotify.json'); process.exit(3); }

  try {
    const uToken = await userToken(creds);

    // 1. Находим трек (клиентский токен годится и для поиска, но юзерский тоже ок).
    const track = await searchTrack(uToken, query);
    if (!track) { console.error('Ничего не найдено'); process.exit(4); }

    // 2. Активное устройство. Если ни одного активного — берём первое (desktop).
    let devices = await getDevices(uToken);
    let dev = devices.find((d) => d.is_active) || devices[0];
    if (!dev) {
      console.error('Нет устройств Spotify. Открой приложение Spotify и повтори.');
      process.exit(5);
    }

    // 3. Играем.
    let r = await play(uToken, track.uri, dev.id);
    if (r.status >= 400) {
      console.error(`play HTTP ${r.status}: ${r.text}`);
      process.exit(6);
    }
    console.log(`▶ ${track.artist} — ${track.title}  (на «${dev.name}»)`);
  } catch (err) {
    console.error(`Ошибка: ${err.message}`);
    process.exit(1);
  }
}

main();
