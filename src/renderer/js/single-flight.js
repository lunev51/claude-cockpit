'use strict';
// singleFlight(fn, { holdMs }): пока предыдущий вызов не завершился, повторный
// получает ТОТ ЖЕ промис и fn второй раз не зовёт (ревью 09.08, C16).
//
// Нужен там, где действие — тумблер: двойной клик по 🌙 слал night:toggle
// дважды, вооружал и тут же разоружал ночную смену, а человек уходил спать в
// уверенности, что включил. Блокировать кнопку на время запроса мало: то же
// действие зовётся и из палитры.
//
// holdMs — окно ПОСЛЕ завершения, в котором повторный вызов тоже получает
// прежний результат. Одного «в полёте» мало (ревью ветки): night:toggle в
// main синхронный, ответ приходит за миллисекунды, а второй клик двойного —
// через 100–300 мс, то есть уже после ответа. Окно считается от ответа, а не
// от клика: медленный ответ по сети не должен его съедать. now — часы,
// подменяемые в тесте.
//
// После окна (или сразу, без holdMs) следующий вызов снова зовёт fn — и после
// успеха, и после отказа: иначе один отклонённый запрос заклинил бы тумблер до
// перезагрузки. Синхронный throw в fn превращается в отказ промиса по той же
// причине.
export function singleFlight(fn, { holdMs = 0, now = Date.now } = {}) {
  let inFlight = null;
  let last = null;
  let settledAt = 0;
  return function singleFlightCall(...args) {
    if (inFlight) return inFlight;
    if (last && now() - settledAt < holdMs) return last;
    let result;
    try {
      result = Promise.resolve(fn.apply(this, args));
    } catch (err) {
      result = Promise.reject(err);
    }
    const run = result.finally(() => {
      inFlight = null;
      last = run;
      settledAt = now();
    });
    inFlight = run;
    return run;
  };
}
