'use strict';
// Локальный HTTP-сервер для озвучки (только 127.0.0.1).
// Stop-хук Claude Code шлёт сюда POST /speak {text}; сервер санитизирует
// текст, синтезирует WAV и отправляет его в renderer через 'tts:speak'.

const http = require('http');
const { speak } = require('./tts');
const { notify } = require('./notify');

const MAX_BODY = 256 * 1024; // лимит тела запроса

let server = null;
let actualPort = 0; // фактический порт, на котором сервер реально слушает (0 = не слушает)

// Фактический порт озвучки. ipc.js передаёт его в env спавна pty (CC_SPEAK_PORT),
// чтобы Stop-хук стучался на реально занятый порт, а не на конфиг-значение.
function getActualPort() {
  return actualPort;
}

// Дедуп озвучки: двойной Stop-хук (Claude иногда дёргает дважды) → двойная
// речь. Запоминаем ключ последней озвучки и игнорируем повтор в окне 5с.
let lastSpokenKey = '';
let lastSpokenAt = 0;

// --- Эхо ответа обратно в Telegram-Избранное (для команд, пришедших оттуда) ---
// /command приходит ТОЛЬКО из Telegram-Избранного (локальный голос вставляет
// текст в терминал напрямую, мимо сервера). Поэтому /command ставит метку, а
// ближайший /speak (ответ Юки) отправляется обратно в Избранное с маркером 🤖 —
// слушатель такие свои сообщения игнорирует, иначе ответ зациклится как команда.
const TG_SEND_PORT = Number(process.env.CC_TG_SEND_PORT) || 48754;
const TG_ECHO_PREFIX = '🤖 Юки: ';
const TG_ECHO_WINDOW_MS = 15 * 60 * 1000; // команда могла выполняться долго
let pendingTgEcho = 0; // timestamp последней команды из Telegram (0 — нет)

function sendTelegramReply(text) {
  const t = String(text || '').trim();
  if (!t) return;
  const payload = Buffer.from(
    JSON.stringify({ to: 'me', text: TG_ECHO_PREFIX + t }), 'utf8');
  const req = http.request({
    host: '127.0.0.1', port: TG_SEND_PORT, path: '/send', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
    timeout: 8000,
  }, (res) => { res.resume(); });
  req.on('timeout', () => { try { req.destroy(); } catch { /* */ } });
  req.on('error', (e) => { console.warn(`[speak-server] эхо в Telegram не удалось: ${e.message}`); });
  req.write(payload);
  req.end();
}

// --- Числа прописью (Silero не озвучивает цифры) ---
const NUM_U  = ['', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
const NUM_UF = ['', 'одна', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
const NUM_TEEN = ['десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать',
  'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'];
const NUM_TENS = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят',
  'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'];
const NUM_H = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот',
  'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'];

// 1..999 прописью; fem — женский род единиц (для тысяч).
function triadRu(n, fem) {
  const u = fem ? NUM_UF : NUM_U;
  const parts = [NUM_H[Math.floor(n / 100)]];
  const t = n % 100;
  if (t >= 10 && t < 20) parts.push(NUM_TEEN[t - 10]);
  else { parts.push(NUM_TENS[Math.floor(t / 10)]); parts.push(u[t % 10]); }
  return parts.filter(Boolean).join(' ');
}

// Склонение: pluralRu(2, ['тысяча','тысячи','тысяч']) → 'тысячи'.
function pluralRu(n, forms) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return forms[0];
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return forms[1];
  return forms[2];
}

function numToWordsRu(n) {
  if (n === 0) return 'ноль';
  const parts = [];
  const mln = Math.floor(n / 1e6);
  const th = Math.floor((n % 1e6) / 1000);
  const rest = n % 1000;
  if (mln) parts.push(triadRu(mln, false), pluralRu(mln, ['миллион', 'миллиона', 'миллионов']));
  if (th) parts.push(triadRu(th, true), pluralRu(th, ['тысяча', 'тысячи', 'тысяч']));
  if (rest) parts.push(triadRu(rest, false));
  return parts.join(' ');
}

// Цифра за цифрой (длинные id, дробные части с ведущим нулём).
function digitsRu(s) {
  return s.split('').map((d) => (d === '0' ? 'ноль' : NUM_U[Number(d)])).join(' ');
}

// Все числа в тексте → прописью.
function spellNumbers(t) {
  // Версии: 3.5.3 → «три точка пять точка три».
  t = t.replace(/\d+(?:\.\d+){2,}/g, (m) => m.split('.').map(spellInt).join(' точка '));
  // Десятичные: 3.5 / 3,5 → «три запятая пять».
  t = t.replace(/(\d+)[.,](\d+)/g, (_m, a, b) => {
    const frac = b[0] === '0' || b.length > 2 ? digitsRu(b) : numToWordsRu(parseInt(b, 10));
    return `${spellInt(a)} запятая ${frac}`;
  });
  // Целые.
  t = t.replace(/\d+/g, (m) => spellInt(m));
  return t;
}

function spellInt(s) {
  return s.length > 9 ? digitsRu(s) : numToWordsRu(parseInt(s, 10));
}

// --- Определение языка ---
// Считаем латинские [a-z] и кириллические [а-я] буквы; если латиница > 60%
// от всех букв → 'en', иначе 'ru'. Текст без букв → 'ru'.
function detectLang(text) {
  const s = String(text || '');
  const lat = (s.match(/[a-z]/gi) || []).length;
  const cyr = (s.match(/[а-яё]/gi) || []).length;
  const total = lat + cyr;
  if (total === 0) return 'ru';
  return lat / total > 0.6 ? 'en' : 'ru';
}

// --- Транслитерация латиницы в кириллицу (для русской ветки) ---
// Словарь вынесен в отдельный модуль для удобства расширения.
const TRANSLIT_WORDS = require('./translit-dict');

// Побуквенно-диграфная транслитерация латинского слова (нижний регистр).
// Сначала длинные сочетания, затем одиночные буквы — приближение к тому,
// как слово реально читается, а не «по буквам».
const TRANSLIT_DIGRAPHS = [
  ['tion', 'шн'], ['sion', 'жн'], ['ight', 'айт'], ['ough', 'о'],
  ['sch', 'ск'], ['tch', 'ч'],
  ['sh', 'ш'], ['ch', 'ч'], ['ph', 'ф'], ['th', 'т'], ['wh', 'в'],
  ['wr', 'р'], ['kn', 'н'], ['qu', 'кв'], ['ck', 'к'],
  ['ee', 'и'], ['oo', 'у'], ['ea', 'и'], ['ai', 'эй'], ['ay', 'эй'],
  ['ey', 'ей'], ['oa', 'оу'], ['ou', 'ау'], ['ow', 'оу'], ['au', 'о'],
  ['aw', 'о'], ['ew', 'ью'], ['ya', 'я'], ['yu', 'ю'], ['yo', 'йо'],
];
const TRANSLIT_LETTERS = {
  a: 'а', b: 'б', c: 'к', d: 'д', e: 'е', f: 'ф', g: 'г', h: 'х',
  i: 'и', j: 'дж', k: 'к', l: 'л', m: 'м', n: 'н', o: 'о', p: 'п',
  q: 'к', r: 'р', s: 'с', t: 'т', u: 'у', v: 'в', w: 'в', x: 'кс',
  y: 'й', z: 'з',
};

function translitWord(lower) {
  // Немое конечное e: code→код, file→фил (словарь обычно перехватывает раньше).
  let s = lower.replace(/([bcdfgklmnprstvz])e$/, '$1');
  for (const [d, r] of TRANSLIT_DIGRAPHS) s = s.split(d).join(r);
  let out = '';
  for (const ch of s) out += (TRANSLIT_LETTERS[ch] !== undefined ? TRANSLIT_LETTERS[ch] : ch);
  return out;
}

// transliterate(t): латинские слова → кириллица. Сначала словарь терминов,
// потом оставшиеся латинские слова — побуквенно.
function transliterate(t) {
  return String(t || '').replace(/[A-Za-z]+/g, (w) => {
    const lower = w.toLowerCase();
    if (TRANSLIT_WORDS[lower] !== undefined) return TRANSLIT_WORDS[lower];
    return translitWord(lower);
  });
}

// --- Эмоция ответа (для выражения лица аватара) ---
// Простая эвристика по ключевым словам/эмодзи; считается по всему ответу.
const EMO_RULES = [
  ['happy', /готово|отлично|успешн|ура|прекрасн|работает|прошл[иа]|починил|исправил|закончил|поздравля|🎉|✅|😊|😄|👍|passed|success|fixed|done|great|perfect|works/i],
  ['sad', /к сожалению|не удалось|не получил|ошибк|провал|сломан|упал[аио]?\b|проблем|увы|неудач|😞|😢|❌|fail|error|broken|unfortunately|sorry/i],
  ['surprised', /неожиданн|удивительн|странн|интересно|ого\b|вот это|оказывается|любопытн|🤔|😮|вау|surprising|interesting|unexpected|strange/i],
];

function detectEmotion(text) {
  const s = String(text || '');
  let best = 'neutral';
  let bestScore = 0;
  for (const [emo, re] of EMO_RULES) {
    const matches = s.match(new RegExp(re.source, re.flags + 'g'));
    const score = matches ? matches.length : 0;
    if (score > bestScore) { bestScore = score; best = emo; }
  }
  return best;
}

// prepareSpeech(raw, maxChars) → [{lang, text}] — готовые к синтезу сегменты.
// Один голос на весь ответ: смешанный/русский текст целиком читает Silero
// (латиница — словарём и транслитом), полностью английский — Piper.
function prepareSpeech(raw, maxChars) {
  let t = stripMarkdown(raw);
  t = t.replace(/\s+/g, ' ').trim();

  const limit = maxChars || 600;
  if (t.length > limit) {
    const head = t.slice(0, limit);
    const lastStop = Math.max(
      head.lastIndexOf('. '), head.lastIndexOf('! '),
      head.lastIndexOf('? '), head.lastIndexOf('… '),
    );
    t = (lastStop > limit * 0.5 ? head.slice(0, lastStop + 1) : head).trim();
  }

  const lang = detectLang(t);
  let s = t;
  if (lang === 'ru') {
    s = transliterate(s); // словарь + диграфная транслитерация
    s = s.replace(/(\d)\s*%/g, '$1 процентов');
    s = spellNumbers(s);  // Silero не читает цифры
  } else {
    s = s.replace(/(\d)\s*%/g, '$1 percent'); // цифры piper читает сам
  }

  return [{ lang, text: s.trim() }]
    .filter((seg) => /[\p{L}\p{N}]{2,}/u.test(seg.text));
}

// Очистка markdown/кода/ссылок (язык-независимая часть санитизации).
function stripMarkdown(raw) {
  let t = String(raw || '');

  // Fenced-блоки ```…``` → заглушка.
  t = t.replace(/```[\s\S]*?```/g, ' Фрагмент кода. ');
  // Незакрытый fenced-блок до конца текста.
  t = t.replace(/```[\s\S]*$/g, ' Фрагмент кода. ');

  // Инлайн-код `код` → содержимое.
  t = t.replace(/`([^`]*)`/g, '$1');

  // URL → «ссылка».
  t = t.replace(/https?:\/\/\S+/gi, 'ссылка');

  // Markdown-ссылки [text](url) уже частично схлопнутся; уберём скобки url.
  t = t.replace(/\]\([^)]*\)/g, ']');

  // Таблицы и разделители: | → пробел.
  t = t.replace(/\|/g, ' ');

  // Прочие markdown-символы.
  t = t.replace(/[#*_>~]/g, ' ');

  return t;
}

// Читает тело запроса с лимитом; отдаёт строку или null при превышении.
function readBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    let aborted = false;
    req.on('data', (c) => {
      if (aborted) return;
      size += c.length;
      if (size > MAX_BODY) {
        aborted = true;
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!aborted) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', () => { if (!aborted) { aborted = true; resolve(null); } });
  });
}

// startSpeakServer(win, getConfig): запускает HTTP-сервер на cfg.tts.port.
function startSpeakServer(win, getConfig) {
  if (server) return;
  const ttsCfg = getConfig().tts || {};
  const port = ttsCfg.port || 48751;

  server = http.createServer(async (req, res) => {
    // Инъекция команды от удалённого управления (Telegram-Избранное) →
    // renderer вставит текст в терминал и нажмёт Enter (как голосовой submit).
    if (req.method === 'POST' && req.url === '/command') {
      const body = await readBody(req);
      res.writeHead(204).end();
      if (body === null) return;
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        return;
      }
      const text = parsed.text;
      if (typeof text !== 'string' || !text.trim()) return;
      // Команда из Telegram-Избранного → ответ Юки вернём туда же (см. /speak).
      // Авто-уведомления (echo:false, напр. итог переговоров) обратно НЕ эхаем.
      if (parsed.echo !== false) pendingTgEcho = Date.now();
      if (win && !win.isDestroyed()) win.webContents.send('cmd:inject', { text });
      return;
    }

    if (req.method !== 'POST' || req.url !== '/speak') {
      res.writeHead(404).end();
      return;
    }
    const body = await readBody(req);
    // Сразу подтверждаем приём — хук не ждёт синтеза.
    res.writeHead(204).end();
    if (body === null) return;

    let text;
    try {
      text = JSON.parse(body).text;
    } catch {
      return;
    }
    if (typeof text !== 'string' || !text.trim()) return;

    const cfg = getConfig().tts || {};
    // Эмоция считается по всему ответу и едет с каждым сегментом.
    const emotion = detectEmotion(stripMarkdown(text));
    // Гибридная озвучка: текст режется на языковые сегменты, каждый
    // синтезируется своим движком и уходит в очередь плеера по порядку.
    const parts = prepareSpeech(text, cfg.maxChars);

    // Дедуп: одинаковый набор сегментов в пределах 5с — повторный хук, пропускаем.
    const key = parts.map((p) => p.text).join('|');
    if (key === lastSpokenKey && Date.now() - lastSpokenAt < 5000) return;
    lastSpokenKey = key;
    lastSpokenAt = Date.now();

    // Если этот ответ — на команду из Telegram, шлём его обратно в Избранное.
    // Берём исходный текст реплики (а не транслитерированный для синтеза).
    if (pendingTgEcho && Date.now() - pendingTgEcho < TG_ECHO_WINDOW_MS) {
      pendingTgEcho = 0;
      sendTelegramReply(text);
    }

    for (const part of parts) {
      if (!win || win.isDestroyed()) return;
      try {
        const wav = await speak(part.text, cfg, part.lang);
        if (!win || win.isDestroyed()) return;
        win.webContents.send('tts:speak', { wav, text: part.text, emotion });
      } catch (err) {
        console.warn(`[speak-server] синтез не удался (${part.lang}): ${err.message}`);
        notify(`синтез не удался: ${err.message}`, 'error');
      }
    }
  });

  // Динамический порт: при занятом cfg.port пробуем port+2, +4, … до +10.
  // Stop-хук получает фактический порт через CC_SPEAK_PORT (см. ipc.js).
  const basePort = port;
  let curPort = port;
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && curPort < basePort + 10) {
      curPort += 2;
      // повторная попытка слушать на следующем порту
      setImmediate(() => { try { server.listen(curPort, '127.0.0.1'); } catch { /* */ } });
      return;
    }
    if (err.code === 'EADDRINUSE') {
      notify(`порт ${basePort} занят — озвучка не запущена`, 'error');
    } else {
      notify(`озвучка: ошибка сервера — ${err.message}`, 'error');
    }
    console.warn(`[speak-server] ошибка сервера: ${err.message}`);
    actualPort = 0;
    server = null;
  });

  // Только локальный интерфейс.
  server.listen(curPort, '127.0.0.1', () => {
    actualPort = curPort;
    console.log(`[speak-server] слушает 127.0.0.1:${curPort}`);
    if (curPort !== basePort) {
      notify(`порт ${basePort} занят — озвучка на ${curPort}`, 'warn');
    }
  });
}

function stopSpeakServer() {
  if (!server) return;
  try { server.close(); } catch { /* */ }
  server = null;
  actualPort = 0;
}

module.exports = { startSpeakServer, stopSpeakServer, getActualPort, detectLang, transliterate, prepareSpeech, detectEmotion };
