'use strict';
// Кольца лимитов (Task 3 фазы 5): чистая функция форматирования обратного
// отсчёта «сброс через …» до resetsAt (эпоха, мс). Никакого DOM — используется
// и в rings.js (renderer), и напрямую в тесте через динамический import().

const MINUTE = 60000;
const HOUR = 3600000;
const DAY = 86400000;

// resetsAt — ms эпохи или null/невалидное значение (не бросаем).
// now — ms эпохи, инжектируется вызывающим кодом (без Date.now() внутри —
// функция должна оставаться чистой и детерминированной для теста).
//
// FINDING 3 (ревью, fix round 1): недельное кольцо изначально показывало
// «164ч 26м» — часовой формат не ограничен сверху. Добавлена дневная шкала:
// ≥24ч → «Xд Yч» (минуты отбрасываются — на масштабе суток они не нужны),
// 1..24ч (не включая 24ч) → «Xч Yм» как раньше, <1ч/<1м/прошедшее — без изменений.
export function formatCountdown(resetsAt, now) {
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt)) return '—';
  const diff = resetsAt - now;
  if (diff <= 0) return '—'; // прошедшее время — сброс уже случился (или вот-вот, трактуем как «нет данных»)

  if (diff >= DAY) {
    const days = Math.floor(diff / DAY);
    const hours = Math.floor((diff % DAY) / HOUR);
    return `${days}д ${hours}ч`;
  }

  const totalMinutes = Math.floor(diff / MINUTE);
  if (totalMinutes < 1) return 'меньше минуты';
  if (totalMinutes < 60) return `${totalMinutes}м`;

  const hours = Math.floor(diff / HOUR);
  const minutes = Math.floor((diff % HOUR) / MINUTE);
  return `${hours}ч ${minutes}м`;
}
