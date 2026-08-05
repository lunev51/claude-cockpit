'use strict';
// Меню трея. Electron сюда не входит: модуль решает ТОЛЬКО что показать,
// сборка настоящего Menu живёт в main.js.
const { test } = require('node:test');
const assert = require('node:assert');
const { buildTrayModel } = require('../src/main/tray-menu');

const ids = (model) => model.items.filter((i) => i.id).map((i) => i.id);

test('управление на ПК: обычная иконка и понятный статус', () => {
  const model = buildTrayModel({
    owner: 'local', online: true, address: 'http://100.120.245.85:48300', autostart: false,
  });
  assert.strictEqual(model.icon, 'tray-local.ico');
  assert.match(model.tooltip, /управление здесь/i);
  assert.deepStrictEqual(ids(model), ['status', 'address', 'show', 'autostart', 'quit']);
  assert.strictEqual(model.items.find((i) => i.id === 'status').enabled, false);
  assert.match(model.items.find((i) => i.id === 'status').label, /здесь/i);
});

test('управление на другой машине: приглушённая иконка и другой статус', () => {
  const model = buildTrayModel({
    owner: 'c1', online: true, address: 'http://100.120.245.85:48300', autostart: false,
  });
  assert.strictEqual(model.icon, 'tray-remote.ico');
  assert.match(model.items.find((i) => i.id === 'status').label, /на другой машине/i);
  assert.match(model.tooltip, /на другой машине/i);
});

test('владелец не на связи — так и написано', () => {
  const model = buildTrayModel({
    owner: 'c1', online: false, address: 'http://x:1', autostart: false,
  });
  assert.match(model.items.find((i) => i.id === 'status').label, /не на связи/i);
});

test('галочка автозапуска отражает состояние', () => {
  const on = buildTrayModel({ owner: 'local', online: true, address: 'http://x:1', autostart: true });
  const off = buildTrayModel({ owner: 'local', online: true, address: 'http://x:1', autostart: false });
  assert.strictEqual(on.items.find((i) => i.id === 'autostart').checked, true);
  assert.strictEqual(off.items.find((i) => i.id === 'autostart').checked, false);
  assert.strictEqual(on.items.find((i) => i.id === 'autostart').type, 'checkbox');
});

test('сеть не поднялась — строка адреса это говорит и не кликается', () => {
  const model = buildTrayModel({ owner: 'local', online: true, address: null, autostart: false });
  const item = model.items.find((i) => i.id === 'address');
  assert.match(item.label, /сеть недоступна/i);
  assert.strictEqual(item.enabled, false);
});

test('сеть ещё поднимается — трей не выдаёт это за отказ', () => {
  // I7 (ревью): сервер стартует с повторами (6 попыток по 5с), штатно встаёт
  // на 5-25-й секунде. Всё это время «Сеть недоступна» — неправда.
  const model = buildTrayModel({
    owner: 'local', online: true, address: null, autostart: false, netStarting: true,
  });
  const item = model.items.find((i) => i.id === 'address');
  assert.match(item.label, /поднима/i);
  assert.doesNotMatch(item.label, /недоступна/i);
  assert.strictEqual(item.enabled, false);
});

test('адрес есть — netStarting уже не влияет', () => {
  const model = buildTrayModel({
    owner: 'local', online: true, address: 'http://x:1', autostart: false, netStarting: true,
  });
  const item = model.items.find((i) => i.id === 'address');
  assert.strictEqual(item.label, 'http://x:1');
  assert.strictEqual(item.enabled, true);
});
