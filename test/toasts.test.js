'use strict';
// Тосты Windows по правилу «не уведомлять о том, на что смотришь» (Phase 4, Task 2).
// toasts.js — чистый модуль (без require('electron')): showNotification/focusTab/
// isWindowFocused/getActiveTabId/now — все зависимости инжектируются, что даёт
// прогонять машину правил через node --test без живого Electron-окна.

const test = require('node:test');
const assert = require('node:assert');
const { createToaster } = require('../src/main/toasts');

// Тестовый стенд: фейковые isWindowFocused/getActiveTabId управляются через
// setFocused/setActive, clock — через setClock (now инжектируется явно,
// иначе порог done/30с нельзя было бы детерминированно проверить).
function makeToaster() {
  const notifications = [];
  const focusCalls = [];
  let focused = true;
  let activeTabId = null;
  let clock = 0;
  const toaster = createToaster({
    isWindowFocused: () => focused,
    getActiveTabId: () => activeTabId,
    showNotification: (n) => notifications.push(n),
    focusTab: (tabId) => focusCalls.push(tabId),
    now: () => clock,
  });
  return {
    toaster,
    notifications,
    focusCalls,
    setFocused: (v) => { focused = v; },
    setActive: (id) => { activeTabId = id; },
    setClock: (t) => { clock = t; },
  };
}

test('waiting: неактивная вкладка → тост показывается', () => {
  const h = makeToaster();
  h.setFocused(true);
  h.setActive('другая-вкладка');
  h.toaster.onStatus({
    tabId: 't1', tabName: 'proj', status: 'waiting', waitingText: 'нужен ответ на вопрос',
  });
  assert.strictEqual(h.notifications.length, 1);
  assert.strictEqual(h.notifications[0].title, 'proj ждёт ответа');
  assert.strictEqual(h.notifications[0].body, 'нужен ответ на вопрос');
});

test('waiting: активная вкладка + окно в фокусе → тишина (подавление)', () => {
  const h = makeToaster();
  h.setFocused(true);
  h.setActive('t1');
  h.toaster.onStatus({
    tabId: 't1', tabName: 'proj', status: 'waiting', waitingText: 'нужен ответ',
  });
  assert.strictEqual(h.notifications.length, 0);
});

test('waiting: активная вкладка, но окно БЕЗ фокуса → тост (не подавляется)', () => {
  const h = makeToaster();
  h.setFocused(false);
  h.setActive('t1');
  h.toaster.onStatus({
    tabId: 't1', tabName: 'proj', status: 'waiting', waitingText: 'нужен ответ',
  });
  assert.strictEqual(h.notifications.length, 1);
});

test('waiting: тело обрезается до 120 символов с многоточием', () => {
  const h = makeToaster();
  const long = 'a'.repeat(150);
  h.toaster.onStatus({
    tabId: 't1', tabName: 'proj', status: 'waiting', waitingText: long,
  });
  assert.strictEqual(h.notifications.length, 1);
  assert.strictEqual(h.notifications[0].body, `${'a'.repeat(120)}…`);
});

test('waiting: короткий текст (≤120) не получает многоточие', () => {
  const h = makeToaster();
  h.toaster.onStatus({
    tabId: 't1', tabName: 'proj', status: 'waiting', waitingText: 'коротко',
  });
  assert.strictEqual(h.notifications[0].body, 'коротко');
});

test('waiting: берётся первая НЕПУСТАЯ строка waitingText', () => {
  const h = makeToaster();
  h.toaster.onStatus({
    tabId: 't1',
    tabName: 'proj',
    status: 'waiting',
    waitingText: '\n\n   \nВопрос: одобрить деплой?\nвторая строка игнорируется',
  });
  assert.strictEqual(h.notifications[0].body, 'Вопрос: одобрить деплой?');
});

test('done через 5с после working → тишина (порог 30с не пройден)', () => {
  const h = makeToaster();
  h.setClock(0);
  h.toaster.onStatus({
    tabId: 't1', tabName: 'proj', status: 'working', waitingText: '',
  });
  h.setClock(5000);
  h.toaster.onStatus({
    tabId: 't1', tabName: 'proj', status: 'done', waitingText: '',
  });
  assert.strictEqual(h.notifications.length, 0);
});

test('done через 60с после working → тост', () => {
  const h = makeToaster();
  h.setClock(0);
  h.toaster.onStatus({
    tabId: 't1', tabName: 'proj', status: 'working', waitingText: '',
  });
  h.setClock(60000);
  h.toaster.onStatus({
    tabId: 't1', tabName: 'proj', status: 'done', waitingText: '',
  });
  assert.strictEqual(h.notifications.length, 1);
  assert.strictEqual(h.notifications[0].title, 'proj: готово');
});

test('done: подавление активная+фокус работает так же, как для waiting', () => {
  const h = makeToaster();
  h.setFocused(true);
  h.setActive('t1');
  h.setClock(0);
  h.toaster.onStatus({
    tabId: 't1', tabName: 'proj', status: 'working', waitingText: '',
  });
  h.setClock(60000);
  h.toaster.onStatus({
    tabId: 't1', tabName: 'proj', status: 'done', waitingText: '',
  });
  assert.strictEqual(h.notifications.length, 0);
});

test('dead → тост «сессия завершилась» независимо от давности working', () => {
  const h = makeToaster();
  h.toaster.onStatus({
    tabId: 't1', tabName: 'proj', status: 'dead', waitingText: '',
  });
  assert.strictEqual(h.notifications.length, 1);
  assert.strictEqual(h.notifications[0].title, 'proj: сессия завершилась');
});

test('working/stuck: тишина, но working обновляет отметку времени для done-порога', () => {
  const h = makeToaster();
  h.setClock(0);
  h.toaster.onStatus({
    tabId: 't1', tabName: 'proj', status: 'working', waitingText: '',
  });
  h.setClock(10000);
  h.toaster.onStatus({
    tabId: 't1', tabName: 'proj', status: 'stuck', waitingText: '',
  });
  assert.strictEqual(h.notifications.length, 0); // stuck сам по себе молчит
  h.setClock(20000);
  h.toaster.onStatus({
    tabId: 't1', tabName: 'proj', status: 'working', waitingText: '',
  }); // база сдвинулась на 20000
  h.setClock(45000); // прошло только 25000мс с последнего working — не 45000
  h.toaster.onStatus({
    tabId: 't1', tabName: 'proj', status: 'done', waitingText: '',
  });
  assert.strictEqual(h.notifications.length, 0);
});

test('клик по тосту вызывает focusTab с верным tabId', () => {
  const h = makeToaster();
  h.toaster.onStatus({
    tabId: 't1', tabName: 'proj', status: 'dead', waitingText: '',
  });
  assert.strictEqual(typeof h.notifications[0].onClick, 'function');
  h.notifications[0].onClick();
  assert.deepStrictEqual(h.focusCalls, ['t1']);
});

test('неизвестный статус не показывает тост и не падает', () => {
  const h = makeToaster();
  assert.doesNotThrow(() => {
    h.toaster.onStatus({
      tabId: 't1', tabName: 'proj', status: 'idle', waitingText: '',
    });
  });
  assert.strictEqual(h.notifications.length, 0);
});
