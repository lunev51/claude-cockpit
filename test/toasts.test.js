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

// Статус «фон» (план 2026-11-05): ход окончен, фоновая задача жива — вкладка
// в «Работают». «Готово» звать рано: результата, ради которого всё затевалось
// (записанная флешка), ещё нет.
// Решение владельца 05.11: вкладка с вечным dev-сервером каждый ход кончает в
// «фоне», и без этого тоста о том, что Claude ответил, человек не узнал бы
// никогда. Тост — не «готово» (работа ещё идёт), а «ответил · фон ещё работает».
test('фон: конец хода дольше 30с с живым фоном → тост «ответил · фон ещё работает» с подписью', () => {
  const h = makeToaster();
  h.setFocused(false);
  h.setClock(0);
  h.toaster.onStatus({ tabId: 't1', tabName: 'proj', status: 'working', waitingText: '' });
  h.setClock(60000);
  h.toaster.onStatus({
    tabId: 't1', tabName: 'proj', status: 'background', waitingText: '', subtitle: 'фон · 1 команда', turnEnd: true,
  });
  assert.strictEqual(h.notifications.length, 1);
  assert.strictEqual(h.notifications[0].title, 'proj: ответил · фон ещё работает');
  assert.strictEqual(h.notifications[0].body, 'фон · 1 команда');
  h.notifications[0].onClick();
  assert.deepStrictEqual(h.focusCalls, ['t1']);
});

test('фон: конец хода из «завис» с живым фоном — тоже ответ, тост есть', () => {
  const h = makeToaster();
  h.setFocused(false);
  h.setClock(0);
  h.toaster.onStatus({ tabId: 't1', tabName: 'proj', status: 'working', waitingText: '' });
  h.setClock(400000);
  h.toaster.onStatus({ tabId: 't1', tabName: 'proj', status: 'stuck', waitingText: '' });
  h.setClock(420000);
  h.toaster.onStatus({ tabId: 't1', tabName: 'proj', status: 'background', waitingText: '', subtitle: 'фон · 1 агент', turnEnd: true });
  assert.strictEqual(h.notifications.length, 1);
  assert.strictEqual(h.notifications[0].title, 'proj: ответил · фон ещё работает');
});

test('фон: «завис» → снова «работает» — тот же ход, порог тоста «фона» не сбрасывается', () => {
  const h = makeToaster();
  h.setFocused(false);
  h.setClock(0);
  h.toaster.onStatus({ tabId: 't1', tabName: 'proj', status: 'working', waitingText: '' });
  h.setClock(400000);
  h.toaster.onStatus({ tabId: 't1', tabName: 'proj', status: 'stuck', waitingText: '' });
  h.setClock(410000);
  h.toaster.onStatus({ tabId: 't1', tabName: 'proj', status: 'working', waitingText: '' });
  h.setClock(420000);
  h.toaster.onStatus({ tabId: 't1', tabName: 'proj', status: 'background', waitingText: '', subtitle: 'фон · 1 команда', turnEnd: true });
  assert.strictEqual(h.notifications.length, 1, 'ход длился 7 минут — тост обязан быть');
});

test('фон: короткий ход (до 30с) с живым фоном — тишина, тот же порог, что у «готово»', () => {
  const h = makeToaster();
  h.setFocused(false);
  h.setClock(0);
  h.toaster.onStatus({ tabId: 't1', tabName: 'proj', status: 'working', waitingText: '' });
  h.setClock(20000);
  h.toaster.onStatus({ tabId: 't1', tabName: 'proj', status: 'background', waitingText: '', subtitle: 'фон · 1 команда', turnEnd: true });
  assert.strictEqual(h.notifications.length, 0);
});

test('фон: человек смотрит на эту вкладку — тишина', () => {
  const h = makeToaster();
  h.setFocused(true);
  h.setActive('t1');
  h.setClock(0);
  h.toaster.onStatus({ tabId: 't1', tabName: 'proj', status: 'working', waitingText: '' });
  h.setClock(60000);
  h.toaster.onStatus({ tabId: 't1', tabName: 'proj', status: 'background', waitingText: '', subtitle: 'фон · 1 команда', turnEnd: true });
  assert.strictEqual(h.notifications.length, 0);
});

test('фон: «фон» без конца хода (хук фонового агента, смена подписи) — тишина', () => {
  // sessions.js возвращает вкладку в «фон» хуком фонового агента из «Ждут
  // тебя»/«Готово»/«Наготове» и шлёт новый «фон» при смене подписи — без
  // turnEnd. Ни то, ни другое — не ответ Claude; тост здесь был бы ложным.
  for (const from of ['waiting', 'done', 'ready', 'background']) {
    const h = makeToaster();
    h.setFocused(false);
    h.setClock(0);
    h.toaster.onStatus({ tabId: 't1', tabName: 'proj', status: 'working', waitingText: '' });
    h.setClock(60000);
    h.toaster.onStatus({ tabId: 't1', tabName: 'proj', status: from, waitingText: 'вопрос' });
    const before = h.notifications.length;
    h.setClock(120000);
    h.toaster.onStatus({ tabId: 't1', tabName: 'proj', status: 'background', waitingText: '', subtitle: 'фон · 2 агента' });
    assert.strictEqual(h.notifications.length, before, `из «${from}» в «фон» тоста быть не должно`);
  }
});

test('фон: короткие автоходы по уведомлению (события Monitor) при живом dev-сервере — тоста нет, порог от начала ТЕКУЩЕГО хода', () => {
  // Ревью PR #51: события Monitor приходят тем же <task-notification>, CLI
  // будит сессию на каждое. Меряй порог от начала первого хода человека —
  // каждый трёхсекундный автоход давал бы «ответил · фон ещё работает».
  const h = makeToaster();
  h.setFocused(false);
  h.setClock(0);
  h.toaster.onStatus({ tabId: 't1', tabName: 'proj', status: 'working', waitingText: '' });
  h.setClock(44000);
  h.toaster.onStatus({ tabId: 't1', tabName: 'proj', status: 'background', waitingText: '', subtitle: 'фон · 2 команды', turnEnd: true });
  assert.strictEqual(h.notifications.length, 1);
  for (const at of [600000, 900000, 1200000]) {
    h.setClock(at);
    h.toaster.onStatus({ tabId: 't1', tabName: 'proj', status: 'working', waitingText: '', taskNotification: true });
    h.setClock(at + 3000);
    h.toaster.onStatus({ tabId: 't1', tabName: 'proj', status: 'background', waitingText: '', subtitle: 'фон · 2 команды', turnEnd: true });
  }
  assert.strictEqual(h.notifications.length, 1, 'на каждое событие Monitor тоста быть не должно');
});

test('фон: длинный автоход по уведомлению (дольше 30с), после которого фон ещё жив, — тост есть', () => {
  const h = makeToaster();
  h.setFocused(false);
  h.setClock(0);
  h.toaster.onStatus({ tabId: 't1', tabName: 'proj', status: 'working', waitingText: '' });
  h.setClock(44000);
  h.toaster.onStatus({ tabId: 't1', tabName: 'proj', status: 'background', waitingText: '', subtitle: 'фон · 2 команды', turnEnd: true });
  h.setClock(600000);
  h.toaster.onStatus({ tabId: 't1', tabName: 'proj', status: 'working', waitingText: '', taskNotification: true });
  h.setClock(650000);
  h.toaster.onStatus({ tabId: 't1', tabName: 'proj', status: 'background', waitingText: '', subtitle: 'фон · 1 команда', turnEnd: true });
  assert.strictEqual(h.notifications.length, 2);
  assert.strictEqual(h.notifications[1].title, 'proj: ответил · фон ещё работает');
});

test('фон: ход кончился на вопросе разрешения (Stop пришёл из «Ждут тебя») — тоже конец хода, тост есть', () => {
  // Ревью PR #51: по прежнему статусу конец хода не угадать — sessions.js
  // помечает Stop флагом turnEnd.
  const h = makeToaster();
  h.setFocused(false);
  h.setClock(0);
  h.toaster.onStatus({ tabId: 't1', tabName: 'proj', status: 'working', waitingText: '' });
  h.setClock(50000);
  h.toaster.onStatus({ tabId: 't1', tabName: 'proj', status: 'waiting', waitingText: 'Claude needs your permission to use Bash' });
  h.setClock(60000);
  h.toaster.onStatus({ tabId: 't1', tabName: 'proj', status: 'background', waitingText: '', subtitle: 'фон · 1 команда', turnEnd: true });
  assert.deepStrictEqual(h.notifications.map((n) => n.title), ['proj ждёт ответа', 'proj: ответил · фон ещё работает']);
});

test('фон: короткий ход после уведомления о конце фона даёт «готово» — время считается с начала всей работы', () => {
  // Запись флешки: ход 20с → фон 10 минут → уведомление запускает ход на
  // 15с → Stop. Мерить от начала последнего хода — 15с, ниже порога, и
  // человек не узнал бы, что флешка готова. Фон — продолжение работы.
  const h = makeToaster();
  h.setClock(0);
  h.toaster.onStatus({ tabId: 't1', tabName: 'proj', status: 'working', waitingText: '' });
  h.setClock(20000);
  h.toaster.onStatus({ tabId: 't1', tabName: 'proj', status: 'background', waitingText: '', turnEnd: true });
  h.setClock(620000);
  h.toaster.onStatus({
    tabId: 't1', tabName: 'proj', status: 'working', waitingText: '', taskNotification: true,
  });
  h.setClock(635000);
  h.toaster.onStatus({ tabId: 't1', tabName: 'proj', status: 'done', waitingText: '' });
  assert.strictEqual(h.notifications.length, 1);
  assert.strictEqual(h.notifications[0].title, 'proj: готово');
});

test('фон: НОВЫЙ промпт человека из «фона» — новый ход, порог 30с меряется от него (сценарий S2 ревью)', () => {
  // Три часа живого dev-сервера, потом короткий вопрос с ответом за 2с —
  // тост «готово» с длительностью «3 часа» был бы враньём.
  const h = makeToaster();
  h.setClock(0);
  h.toaster.onStatus({ tabId: 't1', tabName: 'proj', status: 'working', waitingText: '' });
  h.setClock(20000);
  h.toaster.onStatus({ tabId: 't1', tabName: 'proj', status: 'background', waitingText: '', turnEnd: true });
  h.setClock(3 * 3600 * 1000);
  h.toaster.onStatus({ tabId: 't1', tabName: 'proj', status: 'working', waitingText: '' });
  h.setClock(3 * 3600 * 1000 + 2000);
  h.toaster.onStatus({ tabId: 't1', tabName: 'proj', status: 'done', waitingText: '' });
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
