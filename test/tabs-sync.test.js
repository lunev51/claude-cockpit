'use strict';
// Сверка состава вкладок между main и интерфейсом. Живая жалоба 08.08:
// «открыл новую сессию на маке, вернулся на компьютер — её там нет, хотя она
// даже не пустая». Событие tabs:changed main рассылает всем клиентам с самого
// начала фазы, но в форме api его не было — интерфейс просто не подписан, и
// состав вкладок расходился между машинами до перезагрузки страницы.
//
// Решение о том, что добавить и что убрать, вынесено сюда: в app.js эта логика
// была бы непокрытой, а ошибиться в ней легко — лишнее «убрать» разбирает
// экран живой сессии.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const url = pathToFileURL(
  path.join(__dirname, '..', 'src', 'renderer', 'js', 'tabs-sync.js'),
).href;

test('новая вкладка соседа добавляется, закрытая — убирается', async () => {
  const { diffTabs } = await import(url);
  const res = diffTabs(
    [{ tabId: 'A' }, { tabId: 'C' }],
    ['A', 'B'],
  );
  assert.deepStrictEqual(res.add.map((t) => t.tabId), ['C'], 'C завёл сосед — её надо показать');
  assert.deepStrictEqual(res.remove, ['B'], 'B закрыли — её экран надо разобрать');
});

test('когда всё совпадает, делать нечего', async () => {
  const { diffTabs } = await import(url);
  const res = diffTabs([{ tabId: 'A' }, { tabId: 'B' }], ['B', 'A']);
  assert.deepStrictEqual(res.add, []);
  assert.deepStrictEqual(res.remove, []);
  assert.strictEqual(res.changed, false, 'нечего делать — и трогать интерфейс незачем');
});

test('changed говорит, было ли расхождение', async () => {
  const { diffTabs } = await import(url);
  assert.strictEqual(diffTabs([{ tabId: 'A' }], []).changed, true);
  assert.strictEqual(diffTabs([], ['A']).changed, true);
});

test('пустой ответ main НЕ разбирает экран', async () => {
  // Самый опасный случай: tabs:list не ответил (обрыв связи, отказ гарда) и
  // вернул пусто/мусор. Разобрать по нему все живые вкладки — значит стереть с
  // экрана работающие сессии, которые никто не закрывал.
  const { diffTabs } = await import(url);
  for (const bad of [null, undefined, 'нет', 42, {}]) {
    const res = diffTabs(bad, ['A', 'B']);
    assert.deepStrictEqual(res.remove, [], `${JSON.stringify(bad)} не повод разбирать экран`);
    assert.deepStrictEqual(res.add, []);
    assert.strictEqual(res.changed, false);
  }
});

test('пустой СПИСОК от main — законный ответ: все вкладки закрыли', async () => {
  // Отличается от предыдущего: main ответил, и ответ — «вкладок нет».
  const { diffTabs } = await import(url);
  const res = diffTabs([], ['A']);
  assert.deepStrictEqual(res.remove, ['A']);
  assert.strictEqual(res.changed, true);
});

test('записи без tabId игнорируются, а не роняют сверку', async () => {
  const { diffTabs } = await import(url);
  const res = diffTabs([{ tabId: 'A' }, {}, { tabId: '' }, null], ['A']);
  assert.deepStrictEqual(res.add, []);
  assert.deepStrictEqual(res.remove, []);
});
