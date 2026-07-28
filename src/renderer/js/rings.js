'use strict';
// Кольца лимитов (Task 3 фазы 5): два conic-gradient кольца в подвале сайдбара —
// 5-часовое окно и недельное. Никаких сторонних либ — чистый DOM + CSS conic-gradient
// (переменные --ring-pct/--ring-color читает app.css). renderRings — идемпотентная
// полная перерисовка hostEl из снапшота слоя A (usage-oauth.js через IPC).

import { formatCountdown } from './countdown.js';

// Пороги окраски строго по брифу: <60% --ok, 60–85% --warn, >85% --err.
function colorFor(percent) {
  if (percent > 85) return 'var(--err)';
  if (percent >= 60) return 'var(--warn)';
  return 'var(--ok)';
}

function buildRing(label, part, ok, now) {
  const wrap = document.createElement('div');
  wrap.className = 'limit-ring';

  const visual = document.createElement('div');
  visual.className = 'ring-visual';

  // ok:false — прочерки вместо процента/кольца, но разметка (размер кружка)
  // не ломается: кольцо просто рисуется пустым (0%, нейтральный цвет).
  const rawPercent = part && typeof part.percent === 'number' ? part.percent : 0;
  const percent = ok ? Math.max(0, Math.min(100, Math.round(rawPercent))) : 0;
  visual.style.setProperty('--ring-pct', String(percent));
  visual.style.setProperty('--ring-color', ok ? colorFor(percent) : 'var(--text-dim)');

  const percentText = document.createElement('span');
  percentText.className = 'ring-percent';
  percentText.textContent = ok ? `${percent}%` : '—';
  visual.appendChild(percentText);

  const labelEl = document.createElement('div');
  labelEl.className = 'ring-label';
  labelEl.textContent = label;

  const countdownEl = document.createElement('div');
  countdownEl.className = 'ring-countdown';
  countdownEl.textContent = ok ? formatCountdown(part && part.resetsAt, now) : '—';

  wrap.append(visual, labelEl, countdownEl);
  return wrap;
}

// renderRings(hostEl, snapshot, now): snapshot — форма из usage-oauth.js
// ({ok, stale, fetchedAt, fiveHour:{percent,resetsAt}, sevenDay:{...}, ...}).
// now — ms эпохи, инжектируется вызывающим кодом (app.js), чтобы обновление
// одного лишь отсчёта (локальный таймер 30с) не требовало сети/нового снапшота.
export function renderRings(hostEl, snapshot, now) {
  if (!hostEl) return;
  hostEl.textContent = '';

  const ok = !!(snapshot && snapshot.ok);
  const stale = !!(snapshot && snapshot.stale);
  const fiveHour = (snapshot && snapshot.fiveHour) || null;
  const sevenDay = (snapshot && snapshot.sevenDay) || null;

  hostEl.classList.toggle('stale', stale);
  if (stale) {
    hostEl.title = 'данные устарели';
  } else {
    hostEl.removeAttribute('title');
  }

  hostEl.appendChild(buildRing('5ч', fiveHour, ok, now));
  hostEl.appendChild(buildRing('неделя', sevenDay, ok, now));
}
