'use strict';
// Чистые функции рендера секции дашборда «Ночная смена» (Task 3 фазы 8) —
// живут в src/renderer/js/night-format.js как ESM-модуль (renderer использует
// import), тест — CommonJS (node --test) с динамическим import() внутри
// async-теста, тот же мост, что test/format.test.js/test/countdown.test.js.
//
// Ревью раунда 1 (fix round 1): journalEntryText/formatJournalLine получили
// второй необязательный аргумент resolveTabName (Important 2) — тесты ниже
// покрывают ОБА случая (с резолвером и без, включая фолбэк на сырой tabId).
// detail записи 'skipped' теперь переводится словарём (Important 3), 6 ранее
// «сырых» типов получили русский текст (Minor 4), nightStatusLine согласует
// число вкладок через pluralTabs (Minor 5), recentJournalEntries(j, 0) → []
// (Nit).

const test = require('node:test');
const assert = require('node:assert');

test('journalEntryText: маппинг типов без tabId на человеческий текст (дословно из брифа)', async () => {
  const { journalEntryText } = await import('../src/renderer/js/night-format.js');
  assert.strictEqual(journalEntryText({ type: 'weekly-limit' }), 'недельный лимит');
  assert.strictEqual(
    journalEntryText({ type: 'wake-complete', detail: '3 of 4' }),
    'пробуждение: 3 of 4',
  );
  assert.strictEqual(journalEntryText({ type: 'gave-up' }), 'окно не сбросилось');
  assert.strictEqual(journalEntryText({ type: 'armed' }), 'включена');
  assert.strictEqual(journalEntryText({ type: 'disarmed' }), 'выключена');
  assert.strictEqual(
    journalEntryText({ type: 'retry', detail: '1 (tab-1)' }),
    'повтор: 1 (tab-1)',
  );
});

test('journalEntryText: 6 типов, ранее падавших в «как есть» (Minor 4, ревью раунда 1) — теперь русский текст', async () => {
  const { journalEntryText } = await import('../src/renderer/js/night-format.js');
  assert.strictEqual(journalEntryText({ type: 'usage-error' }), 'сбой опроса лимитов');
  assert.strictEqual(journalEntryText({ type: 'no-usage-data' }), 'нет данных о лимитах');
  assert.strictEqual(journalEntryText({ type: 'no-resets-at' }), 'нет времени сброса');
  assert.strictEqual(journalEntryText({ type: 'cap-reached' }), 'потолок пробуждений исчерпан');
  assert.strictEqual(journalEntryText({ type: 'internal-error' }), 'внутренняя ошибка');
  assert.strictEqual(journalEntryText({ type: 'aborted' }), 'прервано выключением');
});

test('journalEntryText: НЕИЗВЕСТНЫЙ (будущий) тип по-прежнему показывается как есть — защитный рубеж', async () => {
  const { journalEntryText } = await import('../src/renderer/js/night-format.js');
  assert.strictEqual(journalEntryText({ type: 'some-future-type' }), 'some-future-type');
});

test('journalEntryText: skipped — словарь detail (Important 3, ревью раунда 1)', async () => {
  const { journalEntryText } = await import('../src/renderer/js/night-format.js');
  assert.strictEqual(
    journalEntryText({ type: 'skipped', detail: 'status:waiting' }),
    'пропущена: ждёт ответа на диалог',
  );
  assert.strictEqual(
    journalEntryText({ type: 'skipped', detail: 'status:dead' }),
    'пропущена: вкладка умерла',
  );
  assert.strictEqual(
    journalEntryText({ type: 'skipped', detail: 'status:null' }),
    'пропущена: вкладки больше нет',
  );
  assert.strictEqual(
    journalEntryText({ type: 'skipped', detail: 'user-took-over' }),
    'пропущена: перехвачена тобой',
  );
  // M2 (ревью финальной волны фазы 8): pty вкладки сменился между детектом и
  // пробуждением (авто-респавн/ручной рестарт в пикер сессий) — resumeм
  // отменён как небезопасный.
  assert.strictEqual(
    journalEntryText({ type: 'skipped', detail: 'pty-restarted' }),
    'пропущена: вкладка перезапущена — резюм отменён',
  );
});

test('journalEntryText: tab-closed (M1+M3, ревью финальной волны фазы 8) — вкладка закрыта до пробуждения', async () => {
  const { journalEntryText } = await import('../src/renderer/js/night-format.js');
  assert.strictEqual(journalEntryText({ type: 'tab-closed' }), 'закрыта до пробуждения');
  assert.strictEqual(
    journalEntryText({ type: 'tab-closed', tabId: 'tab-1' }, (id) => (id === 'tab-1' ? 'cockpit' : null)),
    'cockpit закрыта до пробуждения',
  );
});

test('journalEntryText: skipped с неизвестным detail — сырой текст (защитный фолбэк)', async () => {
  const { journalEntryText } = await import('../src/renderer/js/night-format.js');
  assert.strictEqual(
    journalEntryText({ type: 'skipped', detail: 'status:weird' }),
    'пропущена: status:weird',
  );
});

test('journalEntryText: мусор на входе не бросает', async () => {
  const { journalEntryText } = await import('../src/renderer/js/night-format.js');
  assert.strictEqual(journalEntryText(null), '');
  assert.strictEqual(journalEntryText(undefined), '');
  assert.strictEqual(journalEntryText({}), '');
});

// --- Important 2 (ревью раунда 1): resolveTabName ---

test('journalEntryText: с резолвером — имя вкладки подставляется перед текстом', async () => {
  const { journalEntryText } = await import('../src/renderer/js/night-format.js');
  const resolveTabName = (tabId) => ({ 'tab-1': 'cockpit', 'tab-2': 'helper' }[tabId] || null);
  assert.strictEqual(
    journalEntryText({ type: 'limit-stop', tabId: 'tab-1' }, resolveTabName),
    'cockpit встала по лимиту',
  );
  assert.strictEqual(
    journalEntryText({ type: 'skipped', tabId: 'tab-2', detail: 'status:waiting' }, resolveTabName),
    'helper пропущена: ждёт ответа на диалог',
  );
});

test('journalEntryText: без резолвера (или резолвер не знает tabId) — фолбэк на сырой tabId', async () => {
  const { journalEntryText } = await import('../src/renderer/js/night-format.js');
  assert.strictEqual(
    journalEntryText({ type: 'resumed', tabId: 'tab-9' }),
    'tab-9 продолжена',
  );
  const resolveTabName = () => null; // закрытая вкладка — резолвер не знает её
  assert.strictEqual(
    journalEntryText({ type: 'resumed', tabId: 'tab-9' }, resolveTabName),
    'tab-9 продолжена',
  );
});

test('journalEntryText: резолвер бросает исключение — не роняет функцию, фолбэк на tabId', async () => {
  const { journalEntryText } = await import('../src/renderer/js/night-format.js');
  const throwing = () => { throw new Error('boom'); };
  assert.strictEqual(
    journalEntryText({ type: 'cap-reached', tabId: 'tab-1' }, throwing),
    'tab-1 потолок пробуждений исчерпан',
  );
});

test('journalEntryText: без tabId (armed/disarmed/wake-complete/gave-up/retry) — резолвер не влияет', async () => {
  const { journalEntryText } = await import('../src/renderer/js/night-format.js');
  const resolveTabName = () => 'should-not-appear';
  assert.strictEqual(journalEntryText({ type: 'armed' }, resolveTabName), 'включена');
});

test('formatJournalLine: «HH:MM — текст», без tabId', async () => {
  const { formatJournalLine } = await import('../src/renderer/js/night-format.js');
  const ts = new Date(2026, 6, 28, 2, 47, 0).getTime();
  assert.strictEqual(formatJournalLine({ ts, type: 'resumed' }), '02:47 — продолжена');
});

test('formatJournalLine: резолвер прокидывается насквозь (Important 2)', async () => {
  const { formatJournalLine } = await import('../src/renderer/js/night-format.js');
  const ts = new Date(2026, 6, 28, 2, 47, 0).getTime();
  const resolveTabName = () => 'cockpit';
  assert.strictEqual(
    formatJournalLine({
      ts, type: 'limit-stop', tabId: 'tab-1',
    }, resolveTabName),
    '02:47 — cockpit встала по лимиту',
  );
});

test('formatJournalLine: битый ts → «—:—»', async () => {
  const { formatJournalLine } = await import('../src/renderer/js/night-format.js');
  assert.strictEqual(formatJournalLine({ type: 'armed' }), '—:— — включена');
});

test('recentJournalEntries: последние N, новые сверху', async () => {
  const { recentJournalEntries } = await import('../src/renderer/js/night-format.js');
  const journal = [
    { ts: 1, type: 'armed' },
    { ts: 2, type: 'limit-stop' },
    { ts: 3, type: 'resumed' },
  ];
  assert.deepStrictEqual(recentJournalEntries(journal, 2), [
    { ts: 3, type: 'resumed' },
    { ts: 2, type: 'limit-stop' },
  ]);
});

test('recentJournalEntries: мусор/пусто на входе → []', async () => {
  const { recentJournalEntries } = await import('../src/renderer/js/night-format.js');
  assert.deepStrictEqual(recentJournalEntries(null), []);
  assert.deepStrictEqual(recentJournalEntries(undefined), []);
  assert.deepStrictEqual(recentJournalEntries([]), []);
});

test('recentJournalEntries: limit 0/отрицательный/не число → [] (Nit, ревью раунда 1)', async () => {
  const { recentJournalEntries } = await import('../src/renderer/js/night-format.js');
  const journal = [{ ts: 1, type: 'armed' }, { ts: 2, type: 'resumed' }];
  assert.deepStrictEqual(recentJournalEntries(journal, 0), []);
  assert.deepStrictEqual(recentJournalEntries(journal, -1), []);
  assert.deepStrictEqual(recentJournalEntries(journal, NaN), []);
});

test('nightStatusLine: выключена', async () => {
  const { nightStatusLine } = await import('../src/renderer/js/night-format.js');
  assert.strictEqual(nightStatusLine({ armed: false }), 'выключена');
  assert.strictEqual(nightStatusLine(null), 'выключена');
});

test('nightStatusLine: вооружена без ожидания', async () => {
  const { nightStatusLine } = await import('../src/renderer/js/night-format.js');
  assert.strictEqual(
    nightStatusLine({
      armed: true, wakeAt: null, pendingCount: 0, resetsHandled: 2,
    }),
    'вооружена, сбросов обработано 2',
  );
});

test('nightStatusLine: ждёт сброса (wakeAt непуст) — согласование числа вкладок (Minor 5, ревью раунда 1)', async () => {
  const { nightStatusLine } = await import('../src/renderer/js/night-format.js');
  const wakeAt = new Date(2026, 6, 28, 3, 15, 0).getTime();
  assert.strictEqual(
    nightStatusLine({
      armed: true, wakeAt, pendingCount: 1, resetsHandled: 0,
    }),
    'ждёт сброса: 1 вкладка, продолжу в 03:15',
  );
  assert.strictEqual(
    nightStatusLine({
      armed: true, wakeAt, pendingCount: 3, resetsHandled: 1,
    }),
    'ждёт сброса: 3 вкладки, продолжу в 03:15',
  );
  assert.strictEqual(
    nightStatusLine({
      armed: true, wakeAt, pendingCount: 5, resetsHandled: 1,
    }),
    'ждёт сброса: 5 вкладок, продолжу в 03:15',
  );
});

// === ниты ре-ревью раунда 1 (N1/N2) ===

test('N1: UUID-tabId без резолвера обрезается до 8 символов — журнал прошлой ночи читаем', async () => {
  const { journalEntryText } = await import('../src/renderer/js/night-format.js');
  assert.strictEqual(
    journalEntryText({ type: 'resumed', tabId: '0f8b7c2a-1d34-4e56-9abc-def012345678' }),
    '0f8b7c2a продолжена',
  );
});

test('N2: no-resets-at различает «нет времени» и «время в прошлом»', async () => {
  const { journalEntryText } = await import('../src/renderer/js/night-format.js');
  assert.strictEqual(
    journalEntryText({ type: 'no-resets-at' }),
    'нет времени сброса',
  );
  assert.strictEqual(
    journalEntryText({ type: 'no-resets-at', detail: 'resets-at-in-past' }),
    'время сброса уже в прошлом',
  );
});

test('N2: internal-error показывает err.message из detail', async () => {
  const { journalEntryText } = await import('../src/renderer/js/night-format.js');
  assert.strictEqual(
    journalEntryText({ type: 'internal-error', detail: 'boom' }),
    'внутренняя ошибка: boom',
  );
  assert.strictEqual(
    journalEntryText({ type: 'internal-error' }),
    'внутренняя ошибка',
  );
});
