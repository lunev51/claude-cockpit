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

test('done: каденция PreToolUse (working-пинги каждые 10с) НЕ откатывает таймер — тост показывается по суммарному времени с НАЧАЛА хода, а не с последнего пинга', () => {
  const h = makeToaster();
  h.setClock(0);
  h.toaster.onStatus({
    tabId: 't1', tabName: 'proj', status: 'working', waitingText: '',
  }); // начало хода (SessionStart/UserPromptSubmit)
  h.setClock(10000);
  h.toaster.onStatus({
    tabId: 't1', tabName: 'proj', status: 'working', waitingText: '',
  }); // PreToolUse #1 — повторный пинг, НЕ новый переход, не должен сдвигать базу
  h.setClock(20000);
  h.toaster.onStatus({
    tabId: 't1', tabName: 'proj', status: 'working', waitingText: '',
  }); // PreToolUse #2 — тоже повторный пинг
  h.setClock(35000);
  h.toaster.onStatus({
    tabId: 't1', tabName: 'proj', status: 'done', waitingText: '',
  }); // Stop — 35с С НАЧАЛА хода (не 15с с последнего PreToolUse)
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

test('dead чистит внутренние карты по tabId — done сразу после dead не подавляется старой working-отметкой', () => {
  const h = makeToaster();
  h.setClock(0);
  h.toaster.onStatus({
    tabId: 't1', tabName: 'proj', status: 'working', waitingText: '',
  });
  h.setClock(1000);
  h.toaster.onStatus({
    tabId: 't1', tabName: 'proj', status: 'dead', waitingText: '',
  });
  assert.strictEqual(h.notifications.length, 1); // тост «сессия завершилась»
  h.setClock(1500);
  h.toaster.onStatus({
    tabId: 't1', tabName: 'proj', status: 'done', waitingText: '',
  });
  // Без чистки workingSince на dead здесь elapsed=1500-0=1500мс ≤30с → тишина
  // (без чистки notifications.length осталось бы 1). После чистки записи для
  // t1 нет → elapsed=Infinity → тост показывается.
  assert.strictEqual(h.notifications.length, 2);
  assert.strictEqual(h.notifications[1].title, 'proj: готово');
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

test('forget(tabId): done сразу после forget без предшествующего working ведёт себя как для новой вкладки', () => {
  const h = makeToaster();
  h.setClock(0);
  h.toaster.onStatus({
    tabId: 't1', tabName: 'proj', status: 'working', waitingText: '',
  });
  h.setClock(1000);
  h.toaster.forget('t1');
  h.setClock(1500); // всего 500мс после forget — без чистки elapsed был бы 1500мс от working (≤30с → тишина)
  h.toaster.onStatus({
    tabId: 't1', tabName: 'proj', status: 'done', waitingText: '',
  });
  // После forget() workingSince для t1 нет → elapsed=Infinity → порог
  // пройден, тост показывается, как для вкладки, которую видим впервые.
  assert.strictEqual(h.notifications.length, 1);
  assert.strictEqual(h.notifications[0].title, 'proj: готово');
});

test('forget(tabId) сбрасывает и lastStatus — working после forget считается НОВЫМ переходом, а не повторным пингом', () => {
  const h = makeToaster();
  h.setClock(0);
  h.toaster.onStatus({
    tabId: 't1', tabName: 'proj', status: 'working', waitingText: '',
  });
  h.toaster.forget('t1');
  h.setClock(100000);
  // Без сброса lastStatus этот working считался бы повторным пингом того же
  // хода (prevStatus==='working') и НЕ сдвинул бы workingSince — тогда done
  // ниже мерил бы время от t=0, а не от t=100000.
  h.toaster.onStatus({
    tabId: 't1', tabName: 'proj', status: 'working', waitingText: '',
  });
  h.setClock(100000 + 20000); // 20с от НОВОЙ базы — порог 30с не пройден
  h.toaster.onStatus({
    tabId: 't1', tabName: 'proj', status: 'done', waitingText: '',
  });
  assert.strictEqual(h.notifications.length, 0);
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
