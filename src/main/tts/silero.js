'use strict';
// TTS-провайдер Silero (v4_ru) через долгоживущий Python-сайдкар.
// Сайдкар грузит torch+модель один раз; запросы идут построчным JSON по id.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { appRoot } = require('../paths');

const READY_TIMEOUT_MS = 30000;   // первый импорт torch медленный
const SYNTH_TIMEOUT_MS = 30000;
const RESTART_COOLDOWN_MS = 30000;

let proc = null;            // живой child-process сайдкара
let ready = false;          // получили {"ready":true}
let readyPromise = null;    // ожидание готовности
let lastSpawnAt = 0;        // для троттлинга рестартов
let nextId = 1;
const pending = new Map();  // id → { resolve, reject, timer }

function paths(cfg) {
  const root = appRoot();
  // venv непереносим и в exe не пакуется; в упакованном виде путь к python
  // берём из конфига (tts.venvPython) — на этой машине это dev-venv.
  const bundled = path.join(root, 'sidecar', 'venv', 'Scripts', 'python.exe');
  const configured = cfg && cfg.venvPython;
  return {
    python: fs.existsSync(bundled) ? bundled : (configured || bundled),
    script: path.join(root, 'sidecar', 'silero_tts.py'),
    model: path.join(root, 'models', 'tts', 'v4_ru.pt'),
  };
}

// Отклоняем все висящие запросы (при падении сайдкара).
function rejectAll(err) {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.reject(err);
  }
  pending.clear();
}

function killProc() {
  if (proc) {
    const pid = proc.pid;
    try { proc.stdin.end(); } catch { /* */ }
    try { proc.kill(); } catch { /* */ }
    // На Windows kill() может не добить python с загруженным torch —
    // контрольный taskkill, иначе Electron выходит с кодом 9.
    try {
      require('child_process').execFile('taskkill', ['/PID', String(pid), '/T', '/F'],
        { windowsHide: true }, () => {});
    } catch { /* */ }
  }
  proc = null;
  ready = false;
  readyPromise = null;
}

// Запуск сайдкара. Возвращает промис, который резолвится при {"ready":true}.
function start(cfg) {
  if (readyPromise) return readyPromise;

  const { python, script, model } = paths(cfg);
  if (!fs.existsSync(python)) {
    return Promise.reject(new Error(`Silero: не найден python venv: ${python}`));
  }
  if (!fs.existsSync(model)) {
    return Promise.reject(new Error(`Silero: не найдена модель v4_ru.pt: ${model}`));
  }

  // Троттлинг рестартов: не чаще раза в 30с.
  const since = Date.now() - lastSpawnAt;
  if (lastSpawnAt && since < RESTART_COOLDOWN_MS) {
    return Promise.reject(new Error('Silero: сайдкар недавно падал, ждём перезапуск'));
  }
  lastSpawnAt = Date.now();

  readyPromise = new Promise((resolve, reject) => {
    let settled = false;
    try {
      proc = spawn(python, [script], {
        cwd: appRoot(),
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
      });
    } catch (err) {
      killProc();
      reject(err);
      return;
    }

    const readyTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killProc();
      reject(new Error('Silero: таймаут готовности сайдкара (30с)'));
    }, READY_TIMEOUT_MS);

    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      const s = line.trim();
      if (!s) return;
      let msg;
      try { msg = JSON.parse(s); } catch { return; }

      if (Object.prototype.hasOwnProperty.call(msg, 'ready')) {
        if (msg.ready) {
          ready = true;
          if (!settled) { settled = true; clearTimeout(readyTimer); resolve(); }
        } else if (!settled) {
          settled = true;
          clearTimeout(readyTimer);
          killProc();
          reject(new Error(`Silero: ошибка загрузки модели: ${msg.error || 'unknown'}`));
        }
        return;
      }

      // Ответ на конкретный запрос синтеза.
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        p.reject(new Error(`Silero: ${msg.error}`));
      } else {
        fs.readFile(msg.wav, (err, buf) => {
          try { fs.unlinkSync(msg.wav); } catch { /* */ }
          if (err) p.reject(new Error(`Silero: не прочитать WAV: ${err.message}`));
          else p.resolve(buf);
        });
      }
    });

    proc.stderr.on('data', (d) => {
      const t = d.toString().trim();
      if (t) console.warn(`[silero] ${t}`);
    });

    proc.on('error', (err) => {
      if (!settled) { settled = true; clearTimeout(readyTimer); reject(err); }
      killProc();
      rejectAll(new Error(`Silero: процесс упал: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (!settled) { settled = true; clearTimeout(readyTimer); reject(new Error(`Silero: сайдкар завершился (код ${code})`)); }
      killProc();
      rejectAll(new Error('Silero: сайдкар завершился до ответа'));
    });
  });

  return readyPromise;
}

// synthesize(text, cfg) → Promise<Buffer> (WAV).
async function synthesize(text, cfg) {
  await start(cfg);
  if (!proc || !ready) throw new Error('Silero: сайдкар не готов');

  const id = nextId++;
  const req = {
    id,
    text,
    speaker: (cfg && cfg.speaker) || 'baya',
    sample_rate: (cfg && cfg.sampleRate) || 48000,
  };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Silero: таймаут синтеза (30с)'));
    }, SYNTH_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    try {
      proc.stdin.write(Buffer.from(JSON.stringify(req) + '\n', 'utf8'));
    } catch (err) {
      pending.delete(id);
      clearTimeout(timer);
      reject(err);
    }
  });
}

function dispose() {
  rejectAll(new Error('Silero: dispose'));
  killProc();
}

module.exports = { synthesize, dispose };
