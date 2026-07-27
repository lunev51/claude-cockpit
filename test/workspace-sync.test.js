'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createWorkspaceSync } = require('../src/main/workspace-sync');

// Фейковый стор: только пишет в массив вызовов + текущий pending, без диска —
// нам важна ЛОГИКА гейтов (ready/quitting/smoke), а не персист как таковой
// (тот уже покрыт workspace.test.js).
function makeFakeStore() {
  const calls = [];
  let current = null;
  return {
    calls,
    get current() { return current; },
    set(state) { current = state; calls.push(state); },
    flush() { /* нет дебаунса в фейке — set() уже "записал" */ },
  };
}

test('sync до markReady() — store.set НЕ вызван', () => {
  const store = makeFakeStore();
  const wsync = createWorkspaceSync({ store, listTabs: () => [] });
  wsync.sync(null);
  assert.strictEqual(store.calls.length, 0);
});

test('после markReady() — store.set вызван, activeIndex верно найден по tabId', () => {
  const store = makeFakeStore();
  const tabs = [
    { tabId: 't-1', cwd: 'C:\\a', name: 'a', sessionId: null, ghostId: 'g-1' },
    { tabId: 't-2', cwd: 'C:\\b', name: 'b', sessionId: 's-2', ghostId: 'g-2' },
  ];
  const wsync = createWorkspaceSync({ store, listTabs: () => tabs });
  wsync.markReady();
  wsync.sync('t-2');
  assert.strictEqual(store.calls.length, 1);
  assert.deepStrictEqual(store.current, {
    version: 1,
    activeIndex: 1,
    tabs: [
      { cwd: 'C:\\a', name: 'a', sessionId: null, ghostId: 'g-1' },
      { cwd: 'C:\\b', name: 'b', sessionId: 's-2', ghostId: 'g-2' },
    ],
  });
});

test('после markReady() — неизвестный activeTabId падает на activeIndex:0', () => {
  const store = makeFakeStore();
  const tabs = [
    { tabId: 't-1', cwd: 'C:\\a', name: 'a', sessionId: null, ghostId: 'g-1' },
  ];
  const wsync = createWorkspaceSync({ store, listTabs: () => tabs });
  wsync.markReady();
  wsync.sync('неизвестный-id');
  assert.strictEqual(store.current.activeIndex, 0);
});

test('после markQuitting() — все последующие sync инертны', () => {
  const store = makeFakeStore();
  const tabs = [{ tabId: 't-1', cwd: 'C:\\a', name: 'a', sessionId: null, ghostId: 'g-1' }];
  const wsync = createWorkspaceSync({ store, listTabs: () => tabs });
  wsync.markReady();
  wsync.sync('t-1');
  const callsBefore = store.calls.length;
  wsync.markQuitting();
  wsync.sync('t-1');
  wsync.sync('t-1');
  assert.strictEqual(store.calls.length, callsBefore);
});

// Регрессия на FIX 1: полная последовательность нормального выхода —
// window-all-closed синкает хорошее состояние, потом disposeSessions()
// закрывает вкладки одну за другой (listTabs теперь отдаёт []), потом
// before-quit зовёт flush()+markQuitting() ещё раз. Последнее, что видел
// store.set, должно быть состоянием С ДВУМЯ вкладками — пустой список
// НЕ должен попасть на диск.
test('ПОЛНАЯ ПОСЛЕДОВАТЕЛЬНОСТЬ ВЫХОДА: пустой список после disposeSessions не затирает последний хороший sync', () => {
  const store = makeFakeStore();
  let tabs = [
    { tabId: 't-1', cwd: 'C:\\a', name: 'a', sessionId: null, ghostId: 'g-1' },
    { tabId: 't-2', cwd: 'C:\\b', name: 'b', sessionId: null, ghostId: 'g-2' },
  ];
  const wsync = createWorkspaceSync({ store, listTabs: () => tabs });
  wsync.markReady();

  // window-all-closed: flushWorkspace() #1 — sync с ещё живыми двумя вкладками, затем flush.
  wsync.sync(null);
  wsync.flush();
  assert.strictEqual(store.current.tabs.length, 2);

  // Именно так фиксован ipc.js: flushWorkspace() = wsync.flush(); wsync.markQuitting();
  // — markQuitting() наступает СРАЗУ вслед за первым flush, ДО того как
  // disposeSessions() успеет закрыть хоть одну вкладку.
  wsync.markQuitting();

  tabs = []; // disposeSessions() закрывает вкладки одну за другой — список опустел
  wsync.sync(null); // tabs:changed от close() — должен быть инертен (quitting=true)
  wsync.flush();     // before-quit: flushWorkspace() #2 — второй раз пишет то же pending:null → no-op

  assert.strictEqual(store.current.tabs.length, 2);
  assert.strictEqual(store.calls.length, 1); // второй sync ничего не добавил
});

test('smoke:true — sync никогда не пишет, даже после markReady()', () => {
  const store = makeFakeStore();
  const tabs = [{ tabId: 't-1', cwd: 'C:\\a', name: 'a', sessionId: null, ghostId: 'g-1' }];
  const wsync = createWorkspaceSync({ store, listTabs: () => tabs, smoke: true });
  wsync.markReady();
  wsync.sync('t-1');
  assert.strictEqual(store.calls.length, 0);
});
