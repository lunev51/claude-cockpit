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

// --- I3 ревью: обрыв связи с самим кокпитом ------------------------------

test('связь потеряна — так и написано, и это важнее вопроса о владельце', async () => {
  const { curtainState } = await import(url);
  // Зритель: раньше заглушка молчала прежним текстом «Управление на другой
  // машине», и человек жал «Забрать управление» в мёртвый сокет.
  const guest = curtainState({
    owner: 'local', self: 'c1', online: true, linked: false,
  });
  assert.strictEqual(guest.visible, true);
  assert.match(guest.title, /нет связи/i);
  assert.strictEqual(guest.canTake, false, 'захватывать нечем — кадр никуда не уйдёт');
});

test('владелец при обрыве тоже видит заглушку, а не замерший интерфейс', async () => {
  const { curtainState } = await import(url);
  const owner = curtainState({
    owner: 'c1', self: 'c1', online: true, linked: false,
  });
  assert.strictEqual(owner.visible, true);
  assert.match(owner.title, /нет связи/i);
});

test('linked по умолчанию true — старые вызовы ведут себя как прежде', async () => {
  const { curtainState } = await import(url);
  assert.strictEqual(curtainState({ owner: 'c1', self: 'c1', online: true }).visible, false);
  assert.strictEqual(curtainState({ owner: 'local', self: 'c1', online: true }).canTake, true);
});

// --- I2 ревью: молчаливый отказ протокола объясняется человеку ------------

test('controlBlock: владельцу можно, зрителю нет, обрыв связи важнее', async () => {
  const { controlBlock } = await import(url);
  assert.strictEqual(controlBlock({ owner: 'c1', self: 'c1', linked: true }), null);
  // Первый кадр (владелец ещё неизвестен) не должен блокировать действия:
  // до ответа сервера заглушки тоже нет.
  assert.strictEqual(controlBlock({ owner: null, self: 'local', linked: true }), null);

  const guest = controlBlock({ owner: 'local', self: 'c1', linked: true });
  assert.strictEqual(guest.reason, 'handoff');
  assert.match(guest.message, /управление/i);

  const offline = controlBlock({ owner: 'c1', self: 'c1', linked: false });
  assert.strictEqual(offline.reason, 'offline');
  assert.match(offline.message, /связ/i);
});

// --- M1/M2 + Critical соседнего ревью: захват при загрузке ----------------

test('shouldClaimOnLoad: окно ПК не отбирает управление фактом загрузки', async () => {
  const { shouldClaimOnLoad } = await import(url);
  // Автозапуск со скрытым окном при живом браузере на макбуке: захват здесь
  // вернул бы управление на ПК и вытащил окно на экран.
  assert.strictEqual(shouldClaimOnLoad({ owner: 'c2', self: 'local', intent: null }), false);
  // Никто не занял / мы и так владелец — захват уместен (заодно уедет размер).
  assert.strictEqual(shouldClaimOnLoad({ owner: 'local', self: 'local', intent: null }), true);
  assert.strictEqual(shouldClaimOnLoad({ owner: null, self: 'local', intent: null }), true);
});

test('shouldClaimOnLoad: браузер забирает управление, открывшись', async () => {
  const { shouldClaimOnLoad } = await import(url);
  assert.strictEqual(shouldClaimOnLoad({ owner: 'local', self: 'c1', intent: null }), true);
});

test('shouldClaimOnLoad: зритель после переподключения остаётся зрителем', async () => {
  const { shouldClaimOnLoad } = await import(url);
  // Страница перезагружается сама, когда кокпит поднялся заново. Без памяти о
  // роли вкладка-зритель отобрала бы управление у ПК на каждом обрыве.
  assert.strictEqual(shouldClaimOnLoad({ owner: 'local', self: 'c9', intent: 'view' }), false);
  // А владелец, потерявший связь, должен вернуть себе руль сам.
  assert.strictEqual(shouldClaimOnLoad({ owner: 'c1', self: 'c9', intent: 'claim' }), true);
});
