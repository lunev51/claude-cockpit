'use strict';
// Эмпирический подбор wake-имени: синтез кандидатов через Silero →
// распознавание whisper-cli → насколько стабильно имя возвращается.
// Запуск: node scripts/test-wakenames.js (из корня проекта).

const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const PYTHON = path.join(ROOT, 'sidecar', 'venv', 'Scripts', 'python.exe');
const SIDECAR = path.join(ROOT, 'sidecar', 'silero_tts.py');
const WHISPER = path.join(ROOT, 'vendor', 'whisper', 'whisper-cli.exe');
const MODEL = path.join(ROOT, 'models', 'whisper', 'ggml-small.bin');

const NAMES = ['Юки', 'Алиса', 'Ника', 'Кира', 'Лиза', 'Мира', 'Соня', 'Аврора'];
// Два шаблона: имя отдельно и имя+команда (как в реальном сценарии).
const PHRASES = (n) => [`${n}!`, `${n}, покажи статус проекта.`];

const norm = (s) => s.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

function lev(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

async function main() {
  // --- 1. Синтез всех фраз одним процессом сайдкара ---
  const requests = [];
  let id = 0;
  for (const name of NAMES) for (const ph of PHRASES(name)) requests.push({ id: ++id, name, phrase: ph });

  const proc = spawn(PYTHON, [SIDECAR], { env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' } });
  const wavs = new Map(); // id -> path
  let buf = '';
  proc.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.ready) {
          for (const r of requests) {
            proc.stdin.write(JSON.stringify({ id: r.id, text: r.phrase, speaker: 'baya', sample_rate: 48000 }) + '\n');
          }
        } else if (msg.wav) {
          wavs.set(msg.id, msg.wav);
          if (wavs.size === requests.length) proc.stdin.end();
        } else if (msg.error) {
          console.error('synth error:', msg.id, msg.error);
          wavs.set(msg.id, null);
          if (wavs.size === requests.length) proc.stdin.end();
        }
      } catch { /* лог сайдкара */ }
    }
  });
  proc.stderr.on('data', () => {});
  await new Promise((res) => proc.on('exit', res));

  // --- 2. Распознавание и оценка ---
  const score = new Map(NAMES.map((n) => [n, { hits: 0, total: 0, heard: [] }]));
  for (const r of requests) {
    const wav = wavs.get(r.id);
    const s = score.get(r.name);
    s.total++;
    if (!wav || !fs.existsSync(wav)) { s.heard.push('<нет wav>'); continue; }
    let out = '';
    try {
      out = execFileSync(WHISPER, ['-m', MODEL, '-l', 'ru', '-t', '6', '-f', wav, '--no-timestamps', '--no-prints'],
        { encoding: 'utf8', timeout: 60000 }).trim();
    } catch (e) { out = `<ошибка: ${e.message}>`; }
    const tokens = norm(out).split(' ');
    const target = norm(r.name);
    // имя засчитано, если первый или второй токен ≈ имя (lev ≤ 1)
    const hit = tokens.slice(0, 2).some((t) => t === target || lev(t, target) <= 1);
    if (hit) s.hits++;
    s.heard.push(out);
    try { fs.unlinkSync(wav); } catch { /* */ }
  }

  // --- 3. Отчёт ---
  console.log('\n=== Результаты (имя засчитано, если 1-2 токен ≈ имени, lev<=1) ===');
  for (const [name, s] of score) {
    console.log(`\n${name}: ${s.hits}/${s.total}`);
    s.heard.forEach((h, i) => console.log(`   [${i + 1}] ${h}`));
  }
}

main();
