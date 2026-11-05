// Общая сетка терминалов (план «размер терминала»). Вынесено из app.js ради
// теста значений (test/grid-share.test.js): раздачу стерегла только форма
// кода, и ревью ветки показало цену — мутация «rows: size.cols» выживала.
//
// main применяет размер видимой вкладки ко ВСЕМ pty (termResizeHandler в
// ipc.js): область окна у вкладок одна, а скрытые свой размер не сообщают.
// Но скрытый xterm сам подогнаться не может (контейнер display:none), и без
// этой раздачи стоял бы в своей старой сетке — у ни разу не показанной
// вкладки это умолчание 80×24. Вывод фоновой сессии ложился бы в чужую
// сетку, а при показе ресайз pty выходил бы пустым (размер уже тот), и Claude
// Code не перерисовался бы поверх испорченного экрана.
//
// current — последняя подогнанная сетка этого клиента; её получает и
// вкладка, открытая позже (adopt сразу после initTerminal). adoptGrid у
// вкладки в pty не шлёт ничего и подогнанную вкладку не трогает
// (terminal.js). Вкладка с другим размером шрифта при показе подгонится сама
// и сообщит свою сетку — принятая цена.
//
// Узкая сетка (уже MIN_SHARED_GRID, см. term-size.js) не раздаётся и общей не
// становится: скрытые вкладки остаются в последней раздаваемой — ровно в той,
// в которой main оставил их pty (termResizeHandler шлёт узкий размер только
// своей вкладке). Иначе сужение видимой срезало бы прокрутку всех скрытых.
import { isShareableGrid } from './term-size.js';

export function createGridShare() {
  let grid = null;
  return {
    current: () => grid,
    // views — Map tabId → запись app.js ({view, ...}); view бывает ещё null,
    // пока initTerminal не вернулся.
    share(views, fromTabId, size) {
      if (!isShareableGrid(size)) return grid;
      grid = { cols: size.cols, rows: size.rows };
      for (const [id, entry] of views) {
        if (id !== fromTabId) entry.view?.adoptGrid(grid);
      }
      return grid;
    },
    adopt(view) {
      if (grid) view.adoptGrid(grid);
    },
  };
}
