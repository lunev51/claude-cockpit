'use strict';
// Шов «статусы ядра → секции сайдбара → разметка». Три списка живут в трёх
// файлах и обязаны сходиться, но связывать их было нечем (Minor 4 ревью
// 01.08): юнит-тест раскладки перечисляет статусы СВОИМ захардкоженным
// списком, а смоук видит только одну строку и две секции из пяти.
//
// Цена расхождения высокая и молчаливая:
//   • статус ядра, не попавший в GROUP_OF, уезжает в фолбэк-секцию — вкладка
//     находится не там, где ей место;
//   • секция из GROUP_ORDER без [data-body] в разметке роняет refreshGroups()
//     (bodyOf вернёт null) на КАЖДОЙ смене статуса — то есть сайдбар целиком.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { STATUSES } = require('../src/main/sessions');

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
const load = () => import('../src/renderer/js/tab-group.js');
const bodiesInHtml = () => [...html.matchAll(/data-body="([^"]+)"/g)].map((m) => m[1]);

test('разметка: у каждой секции GROUP_ORDER есть и заголовок, и тело', async () => {
  const { GROUP_ORDER } = await load();
  for (const g of GROUP_ORDER) {
    assert.ok(html.includes(`data-group="${g}"`), `нет заголовка секции data-group="${g}"`);
    assert.ok(html.includes(`data-body="${g}"`), `нет тела data-body="${g}" — refreshGroups() упадёт`);
  }
});

test('разметка: нет осиротевших секций, которых не знает GROUP_ORDER', async () => {
  const { GROUP_ORDER } = await load();
  const bodies = bodiesInHtml();
  assert.ok(bodies.length > 0, 'секций в разметке не найдено вовсе — регэксп протух');
  for (const b of bodies) {
    assert.ok(GROUP_ORDER.includes(b), `секция ${b} есть в разметке, но её нет в GROUP_ORDER`);
  }
});

test('КАЖДЫЙ статус ядра известен сайдбару ПОИМЁННО, а не через фолбэк', async () => {
  // Ключевая проверка шва. Проверять «groupOf вернул валидную секцию»
  // недостаточно: фолбэк возвращает валидную секцию для чего угодно, и новый
  // статус ядра проехал бы молча. Список берётся из sessions.js, а не
  // переписывается здесь — иначе седьмой статус тест просто не заметит.
  const { KNOWN_STATUSES } = await load();
  for (const s of STATUSES) {
    assert.ok(KNOWN_STATUSES.includes(s), `статус ядра "${s}" не описан в раскладке сайдбара`);
  }
});

test('КАЖДЫЙ статус ядра приземляется в реально отрисованную секцию', async () => {
  const { groupOf, GROUP_ORDER } = await load();
  for (const s of [...STATUSES, null, undefined, '', 'будущий-статус']) {
    const g = groupOf(s);
    assert.ok(GROUP_ORDER.includes(g), `статус ${s} → секция ${g}, которой нет в GROUP_ORDER`);
    assert.ok(html.includes(`data-body="${g}"`), `статус ${s} → секция ${g}, которой нет в разметке`);
  }
});

test('порядок секций в разметке совпадает с заявленным порядком срочности', async () => {
  const { GROUP_ORDER } = await load();
  assert.deepStrictEqual(bodiesInHtml(), GROUP_ORDER,
    'порядок сверху вниз в сайдбаре разошёлся с GROUP_ORDER');
});
