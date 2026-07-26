'use strict';
// Stop-хук Claude Code: после ответа ассистента отправляет его текст
// на локальный speak-сервер companion'а для озвучки.
// Без внешних зависимостей. Любые ошибки глотаются, всегда exit 0.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const PORT = Number(process.env.CC_SPEAK_PORT) || 48751; // tts.port
const POST_TIMEOUT_MS = 1500;

// Отладочный лог (хук работает молча, иначе ошибки не diagnose-ятся).
function log(msg) {
  try {
    fs.appendFileSync(path.join(os.tmpdir(), 'cc-hook.log'),
      `${new Date().toISOString()} ${msg}\n`);
  } catch { /* */ }
}

function done() { process.exit(0); }

// ВАЖНО: stdin нужно дочитать ДО выхода, даже если хук «не наш» —
// мгновенный exit ломает пайп Claude Code (EPIPE → «Stop hook error»).
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('error', done);
process.stdin.on('end', () => {
  log(`start companion=${Boolean(process.env.CC_COMPANION)} rawLen=${input.length}`);
  // Озвучиваем только внутри companion-терминала.
  if (!process.env.CC_COMPANION) return done();
  try {
    main(input);
  } catch (e) {
    log(`main threw: ${e.message}`);
    done();
  }
});

function main(raw) {
  let hook;
  try {
    // PowerShell (через который Windows запускает хуки) добавляет UTF-8 BOM
    // в stdin — срезаем его и любой мусор до первой скобки.
    hook = JSON.parse(raw.replace(/^[^{]*/, ''));
  } catch {
    return done();
  }
  // Claude Code ≥2.1.173 кладёт текст ответа прямо во вход хука —
  // надёжнее транскрипта (тот пишется с задержкой/в новом формате).
  if (typeof hook.last_assistant_message === 'string' && hook.last_assistant_message.trim()) {
    log('source=last_assistant_message');
    return speakFromText(hook.last_assistant_message);
  }

  const transcriptPath = hook && hook.transcript_path;
  if (!transcriptPath) { log('no transcript_path; keys=' + Object.keys(hook || {}).join(',')); return done(); }

  // Старые версии: текст берём из транскрипта (он может дописываться
  // с отставанием от Stop-хука — пробуем несколько раз с паузой).
  tryExtract(transcriptPath, 0);
}

// Извлечь 🗣-реплики из текста ответа и озвучить их (или весь текст).
function speakFromText(message) {
  const replicas = [];
  for (const m of message.matchAll(/🗣\s*([^\n]+)/g)) {
    const r = m[1].trim();
    if (r && replicas[replicas.length - 1] !== r) replicas.push(r);
  }
  const text = replicas.length ? replicas.join(' ') : message.trim();
  log(`speakFromText len=${text.length} replicas=${replicas.length}`);
  if (!text) return done();
  postSpeak(text);
}

function tryExtract(transcriptPath, attempt) {
  let content;
  try {
    content = fs.readFileSync(transcriptPath, 'utf8');
  } catch (e) {
    // У свежей сессии транскрипт может появиться ПОЗЖЕ Stop-хука —
    // ретраим чтение, а не сдаёмся (до ~4с суммарно).
    log(`read fail (attempt=${attempt}): ${e.message}`);
    if (attempt >= 8) return done();
    return setTimeout(() => tryExtract(transcriptPath, attempt + 1), 500);
  }

  const texts = collectTurnTexts(content);
  // Голосовые реплики: все строки «🗣 …» текущего хода по порядку
  // (длинный ход пишется несколькими текст-блоками, в каждом своя реплика).
  const replicas = [];
  for (const t of texts) {
    for (const m of t.matchAll(/🗣\s*([^\n]+)/g)) {
      const r = m[1].trim();
      if (r && replicas[replicas.length - 1] !== r) replicas.push(r);
    }
  }
  // Есть реплики — озвучиваем их вместе; нет — последний текст целиком.
  const text = replicas.length
    ? replicas.join(' ')
    : (texts[texts.length - 1] || '');
  log(`attempt=${attempt} textLen=${(text || '').length} replicas=${replicas.length}`);
  if (text) return postSpeak(text);
  if (attempt >= 3) return done();
  setTimeout(() => tryExtract(transcriptPath, attempt + 1), 350);
}

// Собирает ВСЕ assistant-тексты ТЕКУЩЕГО хода (в хронологическом порядке):
// идём с конца; thinking/tool_use пропускаем; на реальном сообщении
// пользователя (content-строка) останавливаемся, чтобы не зацепить старый ход.
function collectTurnTexts(jsonl) {
  const lines = jsonl.split('\n');
  const texts = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type === 'user') {
      const c = obj.message && obj.message.content;
      if (typeof c === 'string') break; // граница хода пользователя
      continue; // tool_result и пр. — пропускаем
    }
    if (obj.type !== 'assistant') continue;
    const blocks = obj.message && obj.message.content;
    if (!Array.isArray(blocks)) continue;
    const text = blocks
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join(' ')
      .trim();
    if (text) texts.unshift(text); // восстанавливаем хронологию
  }
  return texts;
}

function postSpeak(text) {
  const payload = Buffer.from(JSON.stringify({ text }), 'utf8');
  const req = http.request(
    {
      host: '127.0.0.1',
      port: PORT,
      path: '/speak',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
      timeout: POST_TIMEOUT_MS,
    },
    (res) => { log(`post status=${res.statusCode}`); res.resume(); res.on('end', done); },
  );
  req.on('timeout', () => { log('post timeout'); try { req.destroy(); } catch { /* */ } done(); });
  req.on('error', (e) => { log(`post error: ${e.message}`); done(); });
  req.write(payload);
  req.end();
  // Подстраховка: гарантированный выход.
  setTimeout(done, POST_TIMEOUT_MS + 200);
}
