'use strict';
// Агрегат «сколько вкладок ждут» → overlay-иконка таскбара + заголовок окна.
// Чистый модуль (без require('electron')) — окно и сеттер оверлея инжектятся
// извне (main.js), поэтому логика тестируется через node --test без Electron.

// Русское склонение «ждёт/ждут»: 1 → «ждёт», 0 и 2+ → «ждут» (по брифу
// достаточно этого простого правила — сложные формы 21/22.../11-14 не нужны).
function pluralWait(count) {
  return count === 1 ? 'ждёт' : 'ждут';
}

function formatTitle(count) {
  if (count === 0) return 'Cockpit';
  return `Cockpit — ${count} ${pluralWait(count)}`;
}

function createAttention({ getWindow, setOverlay }) {
  let lastCount = null; // null — ещё не было ни одного update(), дедуп по count

  function update({ count, dataUrl }) {
    if (count === lastCount) return; // dedupe: тот же count — окно не дёргаем
    lastCount = count;

    const win = getWindow ? getWindow() : null;
    if (!win || win.isDestroyed()) return;

    try {
      const img = count > 0 ? dataUrl : null;
      const desc = count > 0 ? `${count} ${pluralWait(count)} тебя` : '';
      setOverlay(img, desc);
    } catch { /* overlay best-effort — не роняем приложение */ }

    try {
      win.setTitle(formatTitle(count));
    } catch { /* заголовок best-effort */ }
  }

  return { update };
}

module.exports = { createAttention, formatTitle };
