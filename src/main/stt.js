'use strict';
// Распознавание речи через whisper.cpp.
// Основной путь — долгоживущий whisper-server.exe (модель грузится один раз,
// остаётся тёплой), запросы идут HTTP POST /inference (multipart). Фоллбэк —
// разовый whisper-cli.exe. Контракт: transcribeWav(buffer, sttCfg) → Promise<string>.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { spawn } = require('child_process');
const { appRoot } = require('./paths');

const execFileAsync = promisify(execFile);

const DEFAULT_PORT = 48752;
const READY_TIMEOUT_MS = 20000;   // модель small грузится несколько секунд
const POLL_INTERVAL_MS = 300;
const INFER_TIMEOUT_MS = 60000;

let proc = null;            // живой child-process сервера
let serverPort = 0;         // порт текущего сервера
let readyPromise = null;    // ожидание готовности сервера
let activeBackend = 0;      // индекс бекенда, на котором сервер поднят/пробуется

// Кандидаты каталогов с бинарями whisper, в порядке предпочтения.
// vendor/whisper-cuda — CUDA-сборка (cuBLAS 12.4, self-contained DLL),
// vendor/whisper — CPU-сборка (фоллбэк). Берём первый существующий как
// стартовый; при провале старта переключаемся на следующий (см. startServer).
//
// ВАЖНО (Pascal / GTX 10xx, compute 6.1): CUDA-бинарь под compute 6.1
// заводится, но flash-attention на Pascal не имеет оптимизированных ядер и
// тормозит энкодер в ~9 раз. Поэтому для CUDA-бекенда передаём --no-flash-attn
// (и --no-fallback, чтобы убрать редкие 10-15с провалы на temperature-fallback).
const BACKENDS = [
  { dir: 'whisper-cuda', cuda: true },
  { dir: 'whisper', cuda: false },
];

// Список доступных бекендов (существующих каталогов с whisper-server.exe).
function availableBackends() {
  const root = appRoot();
  const out = [];
  for (const b of BACKENDS) {
    const serverExe = path.join(root, 'vendor', b.dir, 'whisper-server.exe');
    const cliExe = path.join(root, 'vendor', b.dir, 'whisper-cli.exe');
    if (fs.existsSync(serverExe)) out.push({ ...b, serverExe, cliExe });
  }
  return out;
}

function paths(cfg, backendIdx = activeBackend) {
  const root = appRoot();
  const backs = availableBackends();
  const b = backs[backendIdx] || backs[0] || { dir: 'whisper', cuda: false };
  return {
    backend: b,
    serverExe: b.serverExe || path.join(root, 'vendor', b.dir, 'whisper-server.exe'),
    cliExe: b.cliExe || path.join(root, 'vendor', b.dir, 'whisper-cli.exe'),
    model: path.join(root, 'models', 'whisper', `ggml-${cfg.model}.bin`),
  };
}

function killProc() {
  if (proc) {
    const pid = proc.pid;
    // Снимаем exit-хендлер: иначе его отложенное срабатывание затрёт
    // состояние уже нового сервера (proc/serverPort/readyPromise).
    try { proc.removeAllListeners('exit'); } catch { /* */ }
    try { proc.kill(); } catch { /* */ }
    // На Windows kill() может не добить процесс с загруженной моделью —
    // контрольный taskkill, как в src/main/tts/silero.js.
    try {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'],
        { windowsHide: true }, () => {});
    } catch { /* */ }
  }
  proc = null;
  serverPort = 0;
  readyPromise = null;
}

// GET / — сервер отвечает (любым кодом), значит порт слушает и готов.
function ping(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1000 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// Поллинг до готовности сервера или таймаута.
async function waitReady(port, deadline) {
  for (;;) {
    if (await ping(port)) return;
    if (Date.now() > deadline) throw new Error('whisper-server: таймаут готовности (20с)');
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

// Лениво стартует сервер; повторные вызовы возвращают тот же промис.
// Перебирает бекенды (CUDA → CPU): при провале старта первого пробует
// следующий. Флаг triedFrom не даёт зациклиться.
function startServer(cfg) {
  if (readyPromise) return readyPromise;

  const backs = availableBackends();
  if (backs.length === 0) {
    return Promise.reject(new Error('Не найден ни один whisper-server.exe в vendor/'));
  }

  const port = Number(cfg.serverPort) || DEFAULT_PORT;

  // self — ссылка на этот же промис: killProc/exit-хендлер обнуляют module-level
  // readyPromise между итерациями, поэтому восстанавливаем его, чтобы параллельные
  // вызовы startServer (если случатся) дожидались текущего перебора, а не плодили
  // второй сервер.
  const self = (async () => {
    let lastErr = null;
    for (let i = 0; i < backs.length; i++) {
      const { serverExe, model, backend } = paths(cfg, i);
      if (!fs.existsSync(model)) {
        throw new Error(`Не найдена модель whisper: ${model}`);
      }

      const args = [
        '-m', model,
        '-t', String(cfg.threads || 6),
        '-l', cfg.language || 'ru',
        '--host', '127.0.0.1',
        '--port', String(port),
        '-nt',   // без таймстампов
      ];
      // CUDA на Pascal: гасим flash-attn (нет оптимизированных ядер) и
      // temperature-fallback (редкие 10-15с провалы инференса).
      if (backend.cuda) args.push('--no-flash-attn', '--no-fallback');

      console.log(`[stt] старт whisper-server [${backend.dir}] на 127.0.0.1:${port} (модель ${cfg.model})`);
      proc = spawn(serverExe, args, { windowsHide: true });
      serverPort = port;
      activeBackend = i;

      proc.stdout.on('data', () => {});  // подавляем вывод whisper
      proc.stderr.on('data', () => {});
      proc.on('exit', () => { proc = null; serverPort = 0; readyPromise = null; });

      const deadline = Date.now() + READY_TIMEOUT_MS;
      try {
        await waitReady(port, deadline);
        console.log(`[stt] whisper-server готов: бекенд ${backend.dir}${backend.cuda ? ' (CUDA)' : ' (CPU)'}, порт ${port}`);
        return;
      } catch (err) {
        lastErr = err;
        console.warn(`[stt] бекенд ${backend.dir} не поднялся (${err.message})`);
        killProc();              // снимает exit-хендлер, добивает процесс, обнуляет readyPromise
        readyPromise = self;     // восстанавливаем in-flight промис для следующей итерации
        // продолжаем со следующим бекендом
      }
    }
    throw lastErr || new Error('whisper-server: не удалось запустить ни один бекенд');
  })();

  readyPromise = self;
  return readyPromise;
}

// Собираем multipart/form-data тело вручную (без зависимостей):
// part file (filename="a.wav", audio/wav) + part response_format=json
// [+ part prompt, если задан].
//
// prompt передаём ТОЛЬКО серверным (HTTP) путём: тело multipart — это UTF-8,
// кириллица в нём безопасна. Имя поля — "prompt" (whisper-server: то же, что
// стартовый флаг --prompt PROMPT, это initial_prompt для биаса декодера).
// ВАЖНО: через argv whisper-cli (--prompt) кириллицу по-прежнему НЕ передаём —
// на Windows argv приходит в cp1251 и whisper выдаёт мусор (см. transcribeViaCli).
function buildMultipart(buffer, prompt) {
  const boundary = `----ccstt${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const CRLF = '\r\n';
  const head = Buffer.from(
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="file"; filename="a.wav"${CRLF}` +
    `Content-Type: audio/wav${CRLF}${CRLF}`, 'utf8');
  const mid = Buffer.from(
    `${CRLF}--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="response_format"${CRLF}${CRLF}` +
    `json`, 'utf8');
  const parts = [head, buffer, mid];
  if (prompt && String(prompt).trim()) {
    parts.push(Buffer.from(
      `${CRLF}--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="prompt"${CRLF}${CRLF}` +
      `${String(prompt)}`, 'utf8'));
  }
  parts.push(Buffer.from(`${CRLF}--${boundary}--${CRLF}`, 'utf8'));
  const body = Buffer.concat(parts);
  return { body, boundary };
}

// POST WAV на /inference, ждём JSON {text}.
function postInference(buffer, port, prompt) {
  const { body, boundary } = buildMultipart(buffer, prompt);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/inference', method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
      timeout: INFER_TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) {
          reject(new Error(`whisper-server HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
          return;
        }
        try {
          const json = JSON.parse(text);
          resolve((json.text || '').trim());
        } catch (err) {
          reject(new Error(`whisper-server: невалидный JSON: ${err.message}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('whisper-server: таймаут запроса')); });
    req.end(body);
  });
}

// Фоллбэк: разовый запуск whisper-cli.exe (старый путь).
async function transcribeViaCli(buffer, cfg) {
  const { cliExe, model } = paths(cfg);
  if (!fs.existsSync(cliExe)) throw new Error(`Не найден whisper-cli.exe: ${cliExe}`);
  if (!fs.existsSync(model)) throw new Error(`Не найдена модель whisper: ${model}`);

  const tmp = path.join(os.tmpdir(), `cc-stt-${process.pid}-${Date.now()}.wav`);
  fs.writeFileSync(tmp, buffer);
  try {
    const { stdout } = await execFileAsync(cliExe, [
      '-m', model,
      '-l', cfg.language || 'ru',
      '-t', String(cfg.threads || 6),
      '-f', tmp,
      '--no-timestamps',
      '--no-prints',
      // ВАЖНО: НЕ передавать кириллицу через argv (--prompt и т.п.) —
      // на Windows argv приходит в cp1251 и whisper выдаёт мусор.
    ], { timeout: 60000, windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
    return (stdout || '').trim();
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* мог не создаться */ }
  }
}

// transcribeWav(buffer, sttCfg) → Promise<string>.
// buffer — WAV (whisper.cpp сам ресемплит), sttCfg — секция stt из конфига.
async function transcribeWavImpl(buffer, sttCfg) {
  const cfg = sttCfg || {};
  try {
    await startServer(cfg);
    return await postInference(buffer, serverPort, cfg.prompt);
  } catch (err) {
    // Один перезапуск сервера, потом — фоллбэк на whisper-cli.
    console.warn(`[stt] сервер недоступен (${err.message}), перезапуск`);
    killProc();
    try {
      await startServer(cfg);
      return await postInference(buffer, serverPort, cfg.prompt);
    } catch (err2) {
      console.warn(`[stt] сервер снова недоступен (${err2.message}), фоллбэк на whisper-cli`);
      killProc();
      return transcribeViaCli(buffer, cfg);
    }
  }
}

// Сериализация запросов: whisper-server однопоточный, параллельные POST
// (concurrent push + wake) ставят его в неопределённое состояние. Цепочка
// промисов гарантирует строго последовательное выполнение.
let chain = Promise.resolve();
function transcribeWav(buffer, sttCfg) {
  chain = chain.catch(() => {}).then(() => transcribeWavImpl(buffer, sttCfg));
  return chain;
}

// Убить серверный процесс (вызывается при window-all-closed).
function disposeStt() {
  killProc();
}

module.exports = { transcribeWav, transcribeViaCli, disposeStt };
