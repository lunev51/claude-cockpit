'use strict';
// Кольца лимитов (Task 3 фазы 5): чистая функция форматирования обратного
// отсчёта «сброс через …» до resetsAt (эпоха, мс). Никакого DOM — используется
// и в rings.js (renderer), и напрямую в тесте через динамический import().

const MINUTE = 60000;
const HOUR = 3600000;

// resetsAt — ms эпохи или null/невалидное значение (не бросаем).
// now — ms эпохи, инжектируется вызывающим кодом (без Date.now() внутри —
// функция должна оставаться чистой и детерминированной для теста).
export function formatCountdown(resetsAt, now) {
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt)) return '—';
  const diff = resetsAt - now;
  if (diff <= 0) return '—'; // прошедшее время — сброс уже случился (или вот-вот, трактуем как «нет данных»)

  const totalMinutes = Math.floor(diff / MINUTE);
  if (totalMinutes < 1) return 'меньше минуты';
  if (totalMinutes < 60) return `${totalMinutes}м`;

  const hours = Math.floor(diff / HOUR);
  const minutes = Math.floor((diff % HOUR) / MINUTE);
  return `${hours}ч ${minutes}м`;
}
