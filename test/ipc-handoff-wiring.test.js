'use strict';
// Проводка эстафеты. registerIpc целиком под node --test не запускается
// (require('electron') вне настоящего рантайма не даёт объект), поэтому
// проверяем ту самую функцию, которую зовёт прод, — не копию для теста.
// Тот же приём, что у bufferTermData в ipc-output-buffer-wiring.test.js.
const { test } = require('node:test');
const assert = require('node:assert');
const { applyHandoffSize } = require('../src/main/ipc');

function fakeManager(tabs) {
  const calls = [];
  return {
    calls,
    list: () => tabs,
    resize: (tabId, cols, rows) => calls.push({ tabId, cols, rows }),
  };
}

test('смена владельца переразмеривает ВСЕ живые вкладки под его терминал', () => {
  // Все вкладки рисуются в одну и ту же область окна, значит размер у них
  // общий: подогнать только активную — оставить остальные в чужой раскладке,
  // и Claude Code в них перерисуется криво при первом же переключении.
  const manager = fakeManager([{ id: 'T1' }, { id: 'T2' }, { id: 'T3' }]);
  applyHandoffSize({ manager, size: { cols: 120, rows: 40 } });
  assert.deepStrictEqual(manager.calls, [
    { tabId: 'T1', cols: 120, rows: 40 },
    { tabId: 'T2', cols: 120, rows: 40 },
    { tabId: 'T3', cols: 120, rows: 40 },
  ]);
});

test('без размера не трогаем ничего', () => {
  // Кривой размер ХУЖЕ прежнего: ConPTY на нулевых колонках ломает
  // перерисовку Claude Code, и вкладка остаётся с мусором на экране.
  const manager = fakeManager([{ id: 'T1' }]);
  applyHandoffSize({ manager, size: null });
  applyHandoffSize({ manager, size: undefined });
  applyHandoffSize({ manager, size: { cols: 0, rows: 0 } });
  applyHandoffSize({ manager, size: { cols: 80 } });
  applyHandoffSize({ manager, size: { rows: 24 } });
  applyHandoffSize({ manager, size: { cols: -5, rows: 24 } });
  assert.deepStrictEqual(manager.calls, []);
});

test('вкладок нет — не падаем', () => {
  const manager = fakeManager([]);
  applyHandoffSize({ manager, size: { cols: 80, rows: 24 } });
  assert.deepStrictEqual(manager.calls, []);
});
