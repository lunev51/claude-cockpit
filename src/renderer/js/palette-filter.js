'use strict';
// Палитра команд (Task 4 фазы 4): чистая фильтрация без DOM — используется и
// в palette.js (UI), и напрямую в тесте (test/palette-filter.test.js, тот же
// приём динамического import(), что и test/peek-parse.test.js).

// Ищет query как подпоследовательность в title (регистр уже приведён к
// нижнему у обеих строк вызывающей стороной): все символы query должны
// встретиться в title по порядку, необязательно подряд. Возвращает индекс
// ПЕРВОГО совпавшего символа — жадный разбор слева направо даёт самое раннее
// вхождение первой буквы запроса, с которого ещё удаётся дособрать всю
// подпоследовательность целиком; либо -1, если подпоследовательности нет.
function firstMatchIndex(title, query) {
  let qi = 0;
  let first = -1;
  for (let ti = 0; ti < title.length && qi < query.length; ti += 1) {
    if (title[ti] === query[qi]) {
      if (first === -1) first = ti;
      qi += 1;
    }
  }
  return qi === query.length ? first : -1;
}

// filterActions(actions, query) → actions, отфильтрованные и отсортированные.
// Пустой запрос — все действия в исходном порядке (без пересортировки).
// Иначе: подпоследовательное совпадение по title (регистр игнорируется),
// сортировка по позиции первого совпадения, при равенстве — по длине title
// (короче — выше, как более точное совпадение).
function filterActions(actions, query) {
  if (!query) return [...actions];
  const q = query.toLowerCase();
  const scored = [];
  for (const action of actions) {
    const title = String(action.title || '');
    const pos = firstMatchIndex(title.toLowerCase(), q);
    if (pos !== -1) scored.push({ action, pos, len: title.length });
  }
  scored.sort((a, b) => (a.pos - b.pos) || (a.len - b.len));
  return scored.map((s) => s.action);
}

export { filterActions };
