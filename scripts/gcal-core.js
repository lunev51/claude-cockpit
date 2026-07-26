'use strict';
// Ядро интеграции с Google Calendar для Юки.
// Без внешних зависимостей: OAuth refresh-токен → access-токен, вызовы API,
// разбор правил (календарь-правила.txt), freeBusy, валидация, создание/список.
//
// Файлы в companion-home:
//   .gcal.json        — { clientId, clientSecret } (OAuth Desktop, gitignore)
//   .gcal-token.json  — { refresh_token, access_token, expiry } (gitignore)
//   календарь-правила.txt — правила (часовой пояс, окна, буфер, чёрные даты…)

const fs = require('fs');
const path = require('path');
const https = require('https');

// --- Где лежат файлы companion-home ---
// Терминальная Юки запускается с cwd=companion-home; песочница — из другого
// места, тогда падаем на путь относительно этого скрипта (…/companion-home).
function homeDir() {
  if (process.env.CC_HOME && fs.existsSync(process.env.CC_HOME)) return process.env.CC_HOME;
  if (fs.existsSync(path.join(process.cwd(), '.gcal.json'))) return process.cwd();
  return path.join(__dirname, '..', '..', 'companion-home');
}
const HOME = homeDir();
const CREDS_FILE = path.join(HOME, '.gcal.json');
const TOKEN_FILE = path.join(HOME, '.gcal-token.json');
const RULES_FILE = path.join(HOME, 'календарь-правила.txt');

const SCOPE = 'https://www.googleapis.com/auth/calendar';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_BASE = 'https://www.googleapis.com/calendar/v3';

// --- JSON read/write (utf-8, без BOM) ---
function readJson(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  return JSON.parse(raw);
}
function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}

function loadCreds() {
  if (!fs.existsSync(CREDS_FILE)) {
    throw new Error('Нет .gcal.json (clientId/clientSecret). Сначала настрой OAuth.');
  }
  const c = readJson(CREDS_FILE);
  if (!c.clientId || !c.clientSecret) throw new Error('.gcal.json: нет clientId/clientSecret');
  return c;
}

// --- Низкоуровневый HTTPS-запрос → { status, json, text } ---
function httpsRequest(method, urlStr, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const data = body == null ? null
      : (typeof body === 'string' ? body : JSON.stringify(body));
    const opts = {
      method,
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: { ...headers },
    };
    if (data != null) opts.headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request(opts, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null;
        try { json = buf ? JSON.parse(buf) : null; } catch { /* not json */ }
        resolve({ status: res.statusCode, json, text: buf });
      });
    });
    req.on('error', reject);
    if (data != null) req.write(data);
    req.end();
  });
}

// --- Токены ---
function loadToken() {
  if (!fs.existsSync(TOKEN_FILE)) return null;
  try { return readJson(TOKEN_FILE); } catch { return null; }
}

// Обмен authorization code → refresh+access (используется gcal-auth.js).
async function exchangeCode(code, redirectUri) {
  const { clientId, clientSecret } = loadCreds();
  const form = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  }).toString();
  const r = await httpsRequest('POST', TOKEN_URL,
    { 'Content-Type': 'application/x-www-form-urlencoded' }, form);
  if (r.status !== 200 || !r.json) {
    throw new Error(`token exchange failed: ${r.status} ${r.text}`);
  }
  const tok = {
    refresh_token: r.json.refresh_token,
    access_token: r.json.access_token,
    expiry: Date.now() + (r.json.expires_in || 3600) * 1000,
  };
  if (!tok.refresh_token) {
    throw new Error('Google не вернул refresh_token. Отзови доступ и повтори вход с prompt=consent.');
  }
  writeJson(TOKEN_FILE, tok);
  return tok;
}

async function refreshAccess(tok) {
  const { clientId, clientSecret } = loadCreds();
  const form = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: tok.refresh_token,
    grant_type: 'refresh_token',
  }).toString();
  const r = await httpsRequest('POST', TOKEN_URL,
    { 'Content-Type': 'application/x-www-form-urlencoded' }, form);
  if (r.status !== 200 || !r.json || !r.json.access_token) {
    throw new Error(`refresh failed: ${r.status} ${r.text}`);
  }
  tok.access_token = r.json.access_token;
  tok.expiry = Date.now() + (r.json.expires_in || 3600) * 1000;
  writeJson(TOKEN_FILE, tok);
  return tok;
}

async function getAccessToken() {
  let tok = loadToken();
  if (!tok || !tok.refresh_token) {
    throw new Error('Календарь не привязан — запусти один раз gcal-auth.js (вход в Google).');
  }
  if (!tok.access_token || !tok.expiry || Date.now() > tok.expiry - 60000) {
    tok = await refreshAccess(tok);
  }
  return tok.access_token;
}

// --- Вызов Calendar API (с авто-рефрешем при 401) ---
async function api(method, apiPath, { query, body } = {}) {
  const token = await getAccessToken();
  let url = API_BASE + apiPath;
  if (query) url += '?' + new URLSearchParams(query).toString();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  let r = await httpsRequest(method, url, headers, body);
  if (r.status === 401) {
    // токен мог стать невалидным — принудительный рефреш и повтор
    await refreshAccess(loadToken());
    const t2 = await getAccessToken();
    r = await httpsRequest(method, url, { ...headers, Authorization: `Bearer ${t2}` }, body);
  }
  if (r.status < 200 || r.status >= 300) {
    const msg = r.json && r.json.error ? (r.json.error.message || JSON.stringify(r.json.error)) : r.text;
    throw new Error(`Calendar API ${method} ${apiPath} → ${r.status}: ${msg}`);
  }
  return r.json;
}

// ── Часовые пояса (без библиотек, через Intl) ──────────────────────
// Смещение пояса (local-utc, мс) для заданного UTC-инстанта.
function tzOffsetMs(utcMs, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const m = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) m[p.type] = p.value;
  const asUtc = Date.UTC(+m.year, +m.month - 1, +m.day,
    +(m.hour === '24' ? '00' : m.hour), +m.minute, +m.second);
  return asUtc - utcMs;
}
// Наивное локальное время (в timeZone) → UTC-инстант (мс).
function zonedToUtcMs(y, mo, d, h, mi, timeZone) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  const off = tzOffsetMs(guess, timeZone);
  // одна коррекция (хватает кроме редких краёв DST)
  return guess - off;
}
// Разбор "YYYY-MM-DD HH:MM" / "YYYY-MM-DDTHH:MM" → {y,mo,d,h,mi}.
function parseLocal(s) {
  const m = String(s).trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/);
  if (!m) throw new Error(`Не понял дату/время: «${s}». Нужен формат YYYY-MM-DD HH:MM`);
  return { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5] };
}
function pad(n) { return String(n).padStart(2, '0'); }
// {y,mo,d,h,mi} → "YYYY-MM-DDTHH:MM:00" (для start.dateTime + timeZone).
function localIso(p) {
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:00`;
}

// ── Правила (календарь-правила.txt) ────────────────────────────────
const DAY_IDX = {
  'понедельник': 1, 'вторник': 2, 'среда': 3, 'четверг': 4,
  'пятница': 5, 'суббота': 6, 'воскресенье': 0,
};
function parseWindows(val) {
  const out = [];
  for (const part of val.split(',')) {
    const m = part.trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
    if (m) out.push([+m[1] * 60 + +m[2], +m[3] * 60 + +m[4]]);
  }
  return out;
}
function loadRules() {
  const r = {
    timezone: 'Europe/Warsaw',
    windows: {}, // weekdayIdx → [[startMin,endMin]]
    defaultDuration: 30,
    buffer: 15,         // общий буфер (фолбэк)
    bufferMeeting: 30,  // буфер для ВСТРЕЧ (с обеих сторон)
    bufferCall: 15,     // буфер для СОЗВОНОВ
    minNotice: 120,
    horizonDays: 30,
    blackout: new Set(),
    autoEnabled: true,
    autoOnly: [],
  };
  if (!fs.existsSync(RULES_FILE)) return r;
  const lines = fs.readFileSync(RULES_FILE, 'utf8').replace(/^﻿/, '').split(/\r?\n/);
  let section = null; // 'blackout' | 'autoonly'
  for (let raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // секции-списки
    if (/^блокировать\s*:/.test(line)) { section = 'blackout'; continue; }
    if (/^автопланирование_только\s*:/.test(line)) { section = 'autoonly'; continue; }
    if (line.startsWith('#')) continue; // комментарий
    const eq = line.indexOf('=');
    if (eq > 0) {
      section = null;
      const key = line.slice(0, eq).trim().toLowerCase();
      let val = line.slice(eq + 1).trim();
      const h = val.indexOf('#'); if (h >= 0) val = val.slice(0, h).trim();
      if (key === 'часовой_пояс' && val) r.timezone = val;
      else if (key in DAY_IDX) r.windows[DAY_IDX[key]] = parseWindows(val);
      else if (key === 'длительность_по_умолчанию') r.defaultDuration = +val || r.defaultDuration;
      else if (key === 'буфер_между_встречами') r.buffer = isNaN(+val) ? r.buffer : +val;
      else if (key === 'буфер_встречи') r.bufferMeeting = isNaN(+val) ? r.bufferMeeting : +val;
      else if (key === 'буфер_созвона') r.bufferCall = isNaN(+val) ? r.bufferCall : +val;
      else if (key === 'минимальный_срок') r.minNotice = isNaN(+val) ? r.minNotice : +val;
      else if (key === 'горизонт_дней') r.horizonDays = +val || r.horizonDays;
      else if (key === 'автопланирование') r.autoEnabled = /вкл|on|да|true|1/i.test(val);
      continue;
    }
    // элемент текущей секции-списка
    let item = line; const h = item.indexOf('#'); if (h >= 0) item = item.slice(0, h).trim();
    if (!item) continue;
    if (section === 'blackout') r.blackout.add(item);
    else if (section === 'autoonly') r.autoOnly.push(item.toLowerCase());
  }
  return r;
}

// ── freeBusy: занятые интервалы [ {startMs,endMs} ] ────────────────
async function freeBusy(timeMinIso, timeMaxIso, calendarId = 'primary') {
  const res = await api('POST', '/freeBusy', {
    body: { timeMin: timeMinIso, timeMax: timeMaxIso, items: [{ id: calendarId }] },
  });
  const cal = res.calendars && res.calendars[calendarId];
  const busy = (cal && cal.busy) || [];
  return busy.map((b) => ({ startMs: Date.parse(b.start), endMs: Date.parse(b.end) }));
}

// ── Валидация события против правил ────────────────────────────────
// start/end — {y,mo,d,h,mi} в поясе rules.timezone. Возвращает {ok, reason}.
async function validateEvent(start, end, rules, opts = {}) {
  const tz = rules.timezone;
  const startMs = zonedToUtcMs(start.y, start.mo, start.d, start.h, start.mi, tz);
  const endMs = zonedToUtcMs(end.y, end.mo, end.d, end.h, end.mi, tz);
  const now = Date.now();
  if (endMs <= startMs) return { ok: false, reason: 'конец раньше начала' };

  // чёрные даты
  const dateStr = `${start.y}-${pad(start.mo)}-${pad(start.d)}`;
  if (rules.blackout.has(dateStr)) {
    return { ok: false, reason: `${dateStr} — чёрная дата (в правилах помечена как недоступная)` };
  }
  // минимальный срок
  if (startMs < now + rules.minNotice * 60000) {
    return { ok: false, reason: `слишком скоро — минимум за ${rules.minNotice} минут` };
  }
  // горизонт
  if (startMs > now + rules.horizonDays * 86400000) {
    return { ok: false, reason: `дальше горизонта (${rules.horizonDays} дней)` };
  }
  // рабочее окно
  if (!opts.skipWindow) {
    const wd = new Date(startMs);
    // weekday по локальному поясу
    const localWd = new Date(startMs + tzOffsetMs(startMs, tz)).getUTCDay();
    const wins = rules.windows[localWd] || [];
    const sMin = start.h * 60 + start.mi;
    const eMin = end.h * 60 + end.mi;
    const fits = wins.some(([ws, we]) => sMin >= ws && eMin <= we);
    if (!fits) {
      return { ok: false, reason: 'вне рабочих окон этого дня (см. правила)' };
    }
    void wd;
  }
  // буфер/занятость: расширяем на буфер с обеих сторон (зависит от типа события).
  const bufMin = (opts.buffer != null ? opts.buffer : rules.buffer);
  const bufMs = bufMin * 60000;
  const fromIso = new Date(startMs - bufMs).toISOString();
  const toIso = new Date(endMs + bufMs).toISOString();
  const busy = await freeBusy(fromIso, toIso);
  const clash = busy.find((b) => b.startMs < endMs + bufMs && b.endMs > startMs - bufMs);
  if (clash) {
    return { ok: false, reason: `пересекается/впритык с другим событием (нужен зазор ${bufMin} мин)` };
  }
  return { ok: true, startMs, endMs };
}

// ── Создание события ───────────────────────────────────────────────
async function createEvent({ title, start, end, timeZone, description, attendees }) {
  const body = {
    summary: title,
    start: { dateTime: localIso(start), timeZone },
    end: { dateTime: localIso(end), timeZone },
  };
  if (description) body.description = description;
  if (attendees && attendees.length) body.attendees = attendees.map((e) => ({ email: e }));
  const query = attendees && attendees.length ? { sendUpdates: 'all' } : undefined;
  return api('POST', '/calendars/primary/events', { query, body });
}

// ── Список событий в диапазоне (ISO UTC) ───────────────────────────
async function listEvents(timeMinIso, timeMaxIso, max = 25) {
  const res = await api('GET', '/calendars/primary/events', {
    query: {
      timeMin: timeMinIso, timeMax: timeMaxIso,
      singleEvents: 'true', orderBy: 'startTime', maxResults: String(max),
    },
  });
  return (res.items || []).map((e) => ({
    id: e.id,
    title: e.summary || '(без названия)',
    start: e.start && (e.start.dateTime || e.start.date),
    end: e.end && (e.end.dateTime || e.end.date),
    location: e.location || '',
    htmlLink: e.htmlLink || '',
  }));
}

// ── Журнал авто-созданных встреч (для «какие у меня новые события») ──
// Сюда пишутся события, созданные АВТОМАТИЧЕСКИ из Telegram. Юки по запросу
// выдаёт непоказанные и помечает их notified, чтобы второй раз не повторять.
const JOURNAL_FILE = path.join(HOME, '.gcal-journal.json');

function loadJournal() {
  try { return readJson(JOURNAL_FILE); } catch { return []; }
}
function saveJournal(arr) {
  try { writeJson(JOURNAL_FILE, arr.slice(-120)); } catch { /* */ }
}
function appendJournal(entry) {
  const arr = loadJournal();
  arr.push({ ...entry, ts: Date.now(), notified: false });
  saveJournal(arr);
}
// «Слить и очистить» (как с входящими SMS): возвращаем ВСЕ записи журнала и
// сразу ОЧИЩАЕМ его. Спросил → озвучили и стёрли; новые встречи снова добавит
// appendJournal при авто-создании. Сами события остаются в Google-календаре.
function takeNewJournal() {
  const arr = loadJournal();
  if (arr.length) saveJournal([]);
  return arr;
}

// ── Уведомление в Telegram-Избранное (через шлюз слушателя :48754) ──
// Текст ДОЛЖЕН начинаться с маркера, который слушатель игнорирует (📅/🤖),
// иначе уведомление зациклится как новая команда.
function notifySaved(text) {
  return new Promise((resolve) => {
    const port = Number(process.env.CC_TG_SEND_PORT) || 48754;
    const body = JSON.stringify({ to: 'me', text });
    const req = require('http').request({
      host: '127.0.0.1', port, path: '/send', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 8000,
    }, (res) => { res.resume(); res.on('end', resolve); });
    req.on('timeout', () => { try { req.destroy(); } catch { /* */ } resolve(); });
    req.on('error', () => resolve());
    req.write(body); req.end();
  });
}

// Буфер по ТИПУ события (определяем по названию): созвон → bufferCall,
// иначе (встреча/неизвестно) → bufferMeeting (больший, безопасный по умолчанию).
function eventBuffer(title, rules) {
  const t = String(title || '').toLowerCase();
  const isCall = /созвон|созвонимся|звонок|позвон|\bcall\b|zoom|скайп|skype|discord|голосов/.test(t);
  return isCall ? rules.bufferCall : rules.bufferMeeting;
}

module.exports = {
  HOME, SCOPE, TOKEN_URL, CREDS_FILE, TOKEN_FILE,
  loadCreds, exchangeCode, getAccessToken, api,
  tzOffsetMs, zonedToUtcMs, parseLocal, localIso, pad,
  loadRules, eventBuffer, freeBusy, validateEvent, createEvent, listEvents,
  appendJournal, takeNewJournal, notifySaved,
};
