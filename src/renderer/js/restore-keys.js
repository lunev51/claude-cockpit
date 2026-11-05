'use strict';
// Клавиши оверлея восстановления воркспейса: Enter — восстановить, Esc —
// начать пусто. Вынесено из app.js/showRestoreOverlay ради node --test:
// решение здесь необратимое (startEmpty теряет вчерашний список проектов), а
// ловушка — в соседстве с другими оверлеями, которые слушают те же клавиши
// на том же document в той же capture-фазе.
//
// isCovered() — «сверху открыт другой оверлей» (app.js/otherOverlayOpen):
// тогда клавиша не наша, её обработает тот, кого человек видит.
//
// defaultPrevented — первым (ревью ветки). isCovered ловит только оверлей,
// который ещё открыт. Но restore подписывается не всегда раньше соседей:
// bootWorkspace ждёт IPC до показа restore, а у зрителя проходит заново после
// захвата управления. Тогда оверлей сверху получает Esc первым, закрывается —
// и isCovered() уже ложь: «начать пусто» за спиной человека. Все оверлеи,
// закрываясь по Esc/Enter, зовут preventDefault — это и есть след «клавиша не
// твоя», от порядка подписки не зависящий.
export function createRestoreKeyHandler({ isCovered, onRestore, onEmpty }) {
  return function onRestoreKey(ev) {
    if (ev.defaultPrevented) return;
    if (isCovered()) return;
    if (ev.key === 'Enter') {
      ev.preventDefault();
      onRestore();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      onEmpty();
    }
  };
}
