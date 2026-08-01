'use strict';
// Предикат «пользователь видит результат этой вкладки» (src/renderer/js/seen.js).
// Мост CommonJS → ESM — динамический import(), как в peek-parse.test.js.
//
// Цена ошибки несимметрична: ложное «прочитано» ТЕРЯЕТ ответ из «Готово»
// навсегда (вернуть его туда нечем), ложное «не прочитано» стоит одного
// лишнего пункта в списке. Поэтому все сомнительные случаи — в пользу «нет».

const test = require('node:test');
const assert = require('node:assert');

const load = () => import('../src/renderer/js/seen.js');
const base = {
  tabId: 't1', activeId: 't1', hasFocus: true, overlayCovering: false,
};

test('shouldMarkSeen: активная вкладка, окно в фокусе, ничем не накрыта — видел', async () => {
  const { shouldMarkSeen } = await load();
  assert.strictEqual(shouldMarkSeen(base), true);
});

test('shouldMarkSeen: смотрят ДРУГУЮ вкладку — не видел', async () => {
  const { shouldMarkSeen } = await load();
  assert.strictEqual(shouldMarkSeen({ ...base, activeId: 't2' }), false);
});

test('shouldMarkSeen: окно без фокуса (Alt+Tab, свёрнуто) — не видел', async () => {
  const { shouldMarkSeen } = await load();
  assert.strictEqual(shouldMarkSeen({ ...base, hasFocus: false }), false);
});

test('shouldMarkSeen: терминал накрыт оверлеем — НЕ видел', async () => {
  // Дашборд лимитов, палитра, поиск истории, форма рецепта, хоткеи, оверлей
  // восстановления — все закрывают терминальную область целиком.
  const { shouldMarkSeen } = await load();
  assert.strictEqual(shouldMarkSeen({ ...base, overlayCovering: true }), false);
});

test('shouldMarkSeen: активной вкладки ещё нет (загрузка) — не видел и не падает', async () => {
  const { shouldMarkSeen } = await load();
  assert.strictEqual(shouldMarkSeen({ ...base, tabId: null, activeId: null }), false);
  assert.strictEqual(shouldMarkSeen({ ...base, tabId: undefined, activeId: undefined }), false);
});

test('shouldMarkSeen: вызов без аргументов не роняет renderer', async () => {
  const { shouldMarkSeen } = await load();
  assert.strictEqual(shouldMarkSeen({}), false);
});
