'use strict';
// Заглушка «управление на другой машине». Чистая часть — DOM не участвует
// (renderer под node --test не идёт), поэтому решение «показывать или нет»
// вынесено в отдельный модуль и проверяется прямо, а не глазами на живом окне.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// handoff-view.js — ES-модуль renderer'а; из CommonJS-теста он доступен
// только динамическим import() (тот же приём, что в net-api.test.js).
const url = pathToFileURL(
  path.join(__dirname, '..', 'src', 'renderer', 'js', 'handoff-view.js'),
).href;

test('владелец не видит заглушку', async () => {
  const { curtainState } = await import(url);
  assert.strictEqual(curtainState({ owner: 'local', self: 'local', online: true }).visible, false);
  assert.strictEqual(curtainState({ owner: 'c1', self: 'c1', online: true }).visible, false);
});

test('невладелец видит заглушку с объяснением', async () => {
  const { curtainState } = await import(url);
  const state = curtainState({ owner: 'local', self: 'c1', online: true });
  assert.strictEqual(state.visible, true);
  assert.match(state.title, /управление/i);
  assert.match(state.hint, /забрать/i);
});

test('владелец офлайн — так и сказано, кнопка та же', async () => {
  const { curtainState } = await import(url);
  const state = curtainState({ owner: 'c2', self: 'c1', online: false });
  assert.strictEqual(state.visible, true);
  assert.match(state.title, /не на связи/i);
  assert.match(state.hint, /забрать/i, 'забрать управление можно и у пропавшего хозяина');
});

test('до ответа сервера заглушки нет', async () => {
  const { curtainState } = await import(url);
  // Первый кадр страницы: владелец ещё неизвестен. Показать заглушку на пустом
  // месте — напугать человека там, где всё в порядке.
  assert.strictEqual(curtainState({ owner: null, self: 'c1', online: true }).visible, false);
  assert.strictEqual(curtainState({ owner: undefined, self: 'local', online: true }).visible, false);
});

test('в Electron мы всегда local', async () => {
  const { selfId } = await import(url);
  // Окно ПК не получает net:hello — сетевого имени у него нет вовсе.
  assert.strictEqual(selfId({ clientId: null }), 'local');
  assert.strictEqual(selfId({}), 'local');
  assert.strictEqual(selfId({ clientId: 'c3' }), 'c3');
});

test('заглушка владельца пуста, а не просто невидима', async () => {
  const { curtainState } = await import(url);
  // Пустые строки важны: обвязка пишет title/hint в DOM безусловно, и остатки
  // прошлого текста мигнули бы в момент возврата управления.
  const state = curtainState({ owner: 'local', self: 'local', online: true });
  assert.strictEqual(state.title, '');
  assert.strictEqual(state.hint, '');
});
