'use strict';
// Раскладка вкладок по секциям сайдбара (src/renderer/js/tab-group.js).
// Мост CommonJS → ESM — динамический import(), как в peek-parse.test.js.
//
// Живая приёмка 01.08, отзыв пользователя: «а что насчёт того, что они
// возвращались именно во вкладку "работают", если по сути они просто открыты
// без дела?» — «Работают» должно значить «Claude сейчас думает».

const test = require('node:test');
const assert = require('node:assert');

const load = () => import('../src/renderer/js/tab-group.js');

test('groupOf: рабочие статусы раскладываются по своим секциям', async () => {
  const { groupOf } = await load();
  assert.strictEqual(groupOf('waiting'), 'waiting');
  assert.strictEqual(groupOf('working'), 'working');
  assert.strictEqual(groupOf('done'), 'done');
});

test('groupOf: сломанное — в «Проблемы»', async () => {
  const { groupOf } = await load();
  assert.strictEqual(groupOf('stuck'), 'trouble');
  assert.strictEqual(groupOf('dead'), 'trouble');
});

test('groupOf: поднятая, но нетронутая сессия — «Наготове», НЕ «Работают»', async () => {
  const { groupOf } = await load();
  assert.strictEqual(groupOf('ready'), 'ready');
});

test('groupOf: статуса ещё нет вовсе — тоже «Наготове»', async () => {
  // Вкладка только открыта, первый хук не пришёл. Раньше здесь было
  // «Работают»: тот же ложный счётчик, только на секунду раньше.
  const { groupOf } = await load();
  assert.strictEqual(groupOf(null), 'ready');
  assert.strictEqual(groupOf(undefined), 'ready');
  assert.strictEqual(groupOf(''), 'ready');
});

test('groupOf: незнакомый статус уходит в «Проблемы», а не прячется в «Наготове»', async () => {
  // Статусы ядра могут прирасти раньше, чем сайдбар про них узнает. «Нет
  // статуса» и «статус, которого я не знаю» — разные вещи: второе означает
  // рассинхрон, и прятать такую вкладку в самый низ нельзя.
  const { groupOf } = await load();
  assert.strictEqual(groupOf('какой-то-новый'), 'trouble');
});

test('GROUP_ORDER: порядок секций — по убыванию срочности, «Наготове» последняя', async () => {
  const { GROUP_ORDER } = await load();
  assert.deepStrictEqual(GROUP_ORDER, ['waiting', 'working', 'done', 'trouble', 'ready']);
});

test('GROUP_ORDER покрывает ВСЕ секции, куда groupOf умеет класть', async () => {
  // Секция, в которую что-то кладут, но которой нет в порядке отрисовки, —
  // это молча пропавшая из сайдбара вкладка.
  const { GROUP_ORDER, groupOf } = await load();
  const statuses = ['waiting', 'working', 'done', 'stuck', 'dead', 'ready', null, 'чужой'];
  for (const s of statuses) {
    assert.ok(GROUP_ORDER.includes(groupOf(s)), `секция ${groupOf(s)} (статус ${s}) отсутствует в GROUP_ORDER`);
  }
});
