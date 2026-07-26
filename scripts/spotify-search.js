'use strict';
// Резолвит запрос («queen bohemian rhapsody») → spotify:track:ID через
// Spotify Web API (Client Credentials flow — нужен только Client ID/Secret,
// без входа пользователя и без Premium; сам трек запускает desktop-приложение
// командой `start spotify:track:ID`).
//
// Креды берутся из companion-home/.spotify.json {clientId, clientSecret}
// или из env SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET.
//
// Запуск: node spotify-search.js "название трека или исполнитель"
// Вывод: одна строка вида `spotify:track:4u7EnebtmKWzUH433cf5Qv — Queen — Bohemian Rhapsody`

const fs = require('fs');
const path = require('path');
const https = require('https');

function loadCreds() {
  let id = process.env.SPOTIFY_CLIENT_ID;
  let secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (id && secret) return { id, secret };
  // .spotify.json ищем в текущей рабочей папке (companion-home) и рядом со скриптом.
  for (const dir of [process.cwd(), path.join(__dirname, '..', '..', 'companion-home')]) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, '.spotify.json'), 'utf8'));
      if (j.clientId && j.clientSecret) return { id: j.clientId, secret: j.clientSecret };
    } catch { /* нет файла — пробуем дальше */ }
  }
  return null;
}

function httpsJson(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
          return;
        }
        try { resolve(JSON.parse(text)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getToken(id, secret) {
  const auth = Buffer.from(`${id}:${secret}`).toString('base64');
  const body = 'grant_type=client_credentials';
  const json = await httpsJson({
    method: 'POST',
    hostname: 'accounts.spotify.com',
    path: '/api/token',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);
  return json.access_token;
}

async function search(token, query) {
  const q = encodeURIComponent(query);
  const json = await httpsJson({
    method: 'GET',
    hostname: 'api.spotify.com',
    // market=from_token требует пользовательский токен; для client-credentials
    // указываем фиксированный рынок (иначе 403 Insufficient client scope).
    path: `/v1/search?q=${q}&type=track&limit=1&market=RU`,
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const item = json.tracks && json.tracks.items && json.tracks.items[0];
  if (!item) return null;
  return {
    uri: item.uri, // spotify:track:ID
    title: item.name,
    artist: (item.artists || []).map((a) => a.name).join(', '),
  };
}

async function main() {
  const query = process.argv.slice(2).join(' ').trim();
  if (!query) { console.error('Использование: node spotify-search.js "запрос"'); process.exit(2); }

  const creds = loadCreds();
  if (!creds) {
    console.error('Нет кредов Spotify: создай companion-home/.spotify.json {"clientId":"...","clientSecret":"..."}');
    process.exit(3);
  }

  try {
    const token = await getToken(creds.id, creds.secret);
    const track = await search(token, query);
    if (!track) { console.error('Ничего не найдено'); process.exit(4); }
    console.log(`${track.uri} — ${track.artist} — ${track.title}`);
  } catch (err) {
    console.error(`Ошибка Spotify API: ${err.message}`);
    process.exit(1);
  }
}

main();
