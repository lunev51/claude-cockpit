'use strict';
// Чистые функции рендера секции дашборда «Ночная смена» (Task 3 фазы 8) —
// живут в src/renderer/js/night-format.js как ESM-модуль (renderer использует
// import), тест — CommonJS (node --test) с динамическим import() внутри
// async-теста, тот же мост, что test/format.test.js/test/countdown.test.js.

const test = require('node:test');
const assert = require('node:assert');

test('journalEntryText: маппинг типов на человеческий текст (дословно из брифа)', async () => {
  const { journalEntryText } = await import('../src/renderer/js/night-format.js');
  assert.strictEqual(journalEntryText({ type: 'limit-stop' }), 'встала по лимиту');
  assert.strictEqual(journalEntryText({ type: 'resumed' }), 'продолжена');
  assert.strictEqual(
    journalEntryText({ type: 'skipped', detail: 'status:waiting' }),
    'пропущена: status:waiting',
  );
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

test('journalEntryText: прочие типы показываются как есть (сырой type)', async () => {
  const { journalEntryText } = await import('../src/renderer/js/night-format.js');
  for (const type of ['usage-error', 'no-usage-data', 'no-resets-at', 'cap-reached', 'internal-error', 'aborted']) {
    assert.strictEqual(journalEntryText({ type }), type);
  }
});

test('journalEntryText: мусор на входе не бросает', async () => {
  const { journalEntryText } = await import('../src/renderer/js/night-format.js');
  assert.strictEqual(journalEntryText(null), '');
  assert.strictEqual(journalEntryText(undefined), '');
  assert.strictEqual(journalEntryText({}), '');
});

test('formatJournalLine: «HH:MM — текст»', async () => {
  const { formatJournalLine } = await import('../src/renderer/js/night-format.js');
  const ts = new Date(2026, 6, 28, 2, 47, 0).getTime();
  assert.strictEqual(formatJournalLine({ ts, type: 'resumed' }), '02:47 — продолжена');
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

test('nightStatusLine: ждёт сброса (wakeAt непуст)', async () => {
  const { nightStatusLine } = await import('../src/renderer/js/night-format.js');
  const wakeAt = new Date(2026, 6, 28, 3, 15, 0).getTime();
  assert.strictEqual(
    nightStatusLine({
      armed: true, wakeAt, pendingCount: 3, resetsHandled: 1,
    }),
    'ждёт сброса: 3 вкладок, продолжу в 03:15',
  );
});
