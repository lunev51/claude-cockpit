'use strict';
// TTS-провайдер на базе piper.exe (rhasspy/piper, ru_RU-irina-medium).
// На каждый запрос спавним piper, текст подаём в stdin как UTF-8 байты,
// piper пишет WAV во временный файл, который мы читаем и удаляем.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { appRoot } = require('../paths');

const TIMEOUT_MS = 20000;

// Выбор файла модели по языку: 'en' → английский голос (cfg.piperVoiceEn),
// иначе русская модель irina.
function modelFor(root, cfg, lang) {
  if (lang === 'en') {
    const voice = (cfg && cfg.piperVoiceEn) || 'en_US-amy-medium';
    return path.join(root, 'models', 'tts', `${voice}.onnx`);
  }
  return path.join(root, 'models', 'tts', 'ru_RU-irina-medium.onnx');
}

// synthesize(text, cfg, lang) → Promise<Buffer> (WAV).
// cfg — секция tts; lang ('ru'|'en') задаёт модель/голос.
function synthesize(text, cfg, lang = 'ru') {
  const root = appRoot();
  const exe = path.join(root, 'vendor', 'piper', 'piper.exe');
  const model = modelFor(root, cfg, lang);

  if (!fs.existsSync(exe)) {
    return Promise.reject(new Error(`Не найден piper.exe: ${exe}`));
  }
  if (!fs.existsSync(model)) {
    return Promise.reject(new Error(`Не найдена модель piper: ${model}`));
  }

  const tmpWav = path.join(os.tmpdir(), `cc-tts-piper-${process.pid}-${Date.now()}.wav`);

  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { fs.unlinkSync(tmpWav); } catch { /* мог не создаться */ }
      fn(arg);
    };

    let child;
    try {
      child = spawn(exe, ['-m', model, '--output_file', tmpWav], {
        cwd: path.join(root, 'vendor', 'piper'),
        windowsHide: true,
      });
    } catch (err) {
      finish(reject, err);
      return;
    }

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* */ }
      finish(reject, new Error('piper: таймаут синтеза (20с)'));
    }, TIMEOUT_MS);

    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => finish(reject, err));

    child.on('close', (code) => {
      if (done) return;
      if (code !== 0) {
        finish(reject, new Error(`piper завершился с кодом ${code}: ${stderr.slice(-300)}`));
        return;
      }
      let buf;
      try {
        buf = fs.readFileSync(tmpWav);
      } catch (err) {
        finish(reject, new Error(`piper: не удалось прочитать WAV: ${err.message}`));
        return;
      }
      finish(resolve, buf);
    });

    // Текст в stdin строго UTF-8.
    try {
      child.stdin.write(Buffer.from(text + '\n', 'utf8'));
      child.stdin.end();
    } catch (err) {
      finish(reject, err);
    }
  });
}

module.exports = { synthesize };
