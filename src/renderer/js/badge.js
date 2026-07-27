'use strict';
// Рисует бейдж-иконку для taskbar overlay (Windows setOverlayIcon):
// круг --accent 32×32 с белой цифрой — сколько вкладок сейчас ждут.

// count=0 → бейджа нет (overlay снимается отдельно, в attention.js).
// Большие числа не помещаются в кружок 32px — 99+ как потолок отображения.
export function renderBadge(count) {
  if (!count || count <= 0) return null;

  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#D97757';

  ctx.clearRect(0, 0, 32, 32);
  ctx.beginPath();
  ctx.arc(16, 16, 16, 0, Math.PI * 2);
  ctx.fillStyle = accent;
  ctx.fill();

  const label = count > 99 ? '99+' : String(count);
  ctx.fillStyle = '#FFFFFF';
  ctx.font = label.length > 2 ? 'bold 12px sans-serif' : 'bold 18px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 16, 17);

  return canvas.toDataURL('image/png');
}
