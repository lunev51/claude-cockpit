'use strict';
// singleFlight(fn): пока предыдущий вызов не завершился, повторный получает
// ТОТ ЖЕ промис и fn второй раз не зовёт (ревью 09.08, C16).
//
// Нужен там, где действие — тумблер: двойной клик по 🌙 слал night:toggle
// дважды, вооружал и тут же разоружал ночную смену, а человек уходил спать в
// уверенности, что включил. Блокировать кнопку на время запроса мало: то же
// действие зовётся и из палитры.
//
// После завершения — успехом или отказом — следующий вызов снова зовёт fn:
// иначе один отклонённый запрос заклинил бы тумблер до перезагрузки.
// Синхронный throw в fn превращается в отказ промиса по той же причине.
export function singleFlight(fn) {
  let inFlight = null;
  return function singleFlightCall(...args) {
    if (inFlight) return inFlight;
    let result;
    try {
      result = Promise.resolve(fn.apply(this, args));
    } catch (err) {
      result = Promise.reject(err);
    }
    inFlight = result.finally(() => { inFlight = null; });
    return inFlight;
  };
}
