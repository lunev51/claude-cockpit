'use strict';
// Эстафета: кто владеет управлением. Чистое ядро — Electron и сокеты сюда
// не входят, поэтому всё поведение проверяется прямыми вызовами.
const { test } = require('node:test');
const assert = require('node:assert');
const { createOwnership } = require('../src/main/ownership');

// Собираем вызовы onChange списком: «сколько раз позвали» — половина
// проверяемых правил (повторный захват тем же клиентом обязан молчать).
function make() {
  const changes = [];
  const own = createOwnership({ onChange: (info) => changes.push(info) });
  return { own, changes };
}

test('на старте владеет локальное окно, писать может только оно', () => {
  const { own, changes } = make();
  assert.strictEqual(own.owner(), 'local');
  assert.strictEqual(own.canWrite('local'), true);
  assert.strictEqual(own.canWrite('c1'), false);
  assert.strictEqual(own.size(), null);
  assert.deepStrictEqual(changes, []);
});

test('захват сетевым клиентом переносит владение и его размер', () => {
  const { own, changes } = make();
  assert.strictEqual(own.claim('c1', { cols: 80, rows: 24 }), true);
  assert.strictEqual(own.owner(), 'c1');
  assert.deepStrictEqual(own.size(), { cols: 80, rows: 24 });
  assert.strictEqual(own.canWrite('local'), false);
  assert.strictEqual(own.canWrite('c1'), true);
  assert.strictEqual(changes.length, 1);
  assert.deepStrictEqual(changes[0], {
    owner: 'c1', previous: 'local', size: { cols: 80, rows: 24 },
  });
});

test('повторный захват тем же клиентом не событие, но размер обновляет', () => {
  const { own, changes } = make();
  own.claim('c1', { cols: 80, rows: 24 });
  assert.strictEqual(own.claim('c1', { cols: 100, rows: 30 }), false);
  assert.strictEqual(changes.length, 1);
  assert.deepStrictEqual(own.size(), { cols: 100, rows: 30 });
});

test('повторный захват без размера сохраняет СВОЙ прежний размер', () => {
  // Тест раньше утверждал обратное — что захват без размера наследует размер
  // предыдущего владельца. Так и было задумано в первой редакции плана, пока
  // не выяснилось, что возврат управления на ПК происходит именно без размера
  // (main.js забирает его при показе окна) и наследование натягивало бы на
  // терминал ширину макбука.
  const { own } = make();
  own.claim('c1', { cols: 80, rows: 24 });
  own.claim('c1');
  assert.deepStrictEqual(own.size(), { cols: 80, rows: 24 });
});

test('уход НЕ владельца ничего не меняет', () => {
  const { own, changes } = make();
  own.claim('c1', { cols: 80, rows: 24 });
  assert.strictEqual(own.drop('c2'), false);
  assert.strictEqual(own.owner(), 'c1');
  assert.strictEqual(own.ownerOnline(), true);
  assert.strictEqual(changes.length, 1);
});

test('уход владельца не отдаёт управление, но помечает его офлайн', () => {
  const { own, changes } = make();
  own.claim('c1', { cols: 80, rows: 24 });
  assert.strictEqual(own.drop('c1'), true);
  assert.strictEqual(own.owner(), 'c1', 'обрыв связи не равен потере управления');
  assert.strictEqual(own.ownerOnline(), false);
  assert.strictEqual(own.canWrite('local'), false, 'окно ПК не забирает управление само');
  assert.strictEqual(changes.length, 1, 'уход владельца — не смена владельца');
});

test('вернувшийся владелец снова онлайн без события смены', () => {
  const { own, changes } = make();
  own.claim('c1', { cols: 80, rows: 24 });
  own.drop('c1');
  assert.strictEqual(own.claim('c1', { cols: 80, rows: 24 }), false);
  assert.strictEqual(own.ownerOnline(), true);
  assert.strictEqual(changes.length, 1);
});

test('локальное окно забирает управление обратно', () => {
  const { own, changes } = make();
  own.claim('c1', { cols: 80, rows: 24 });
  assert.strictEqual(own.claim('local', { cols: 200, rows: 50 }), true);
  assert.strictEqual(own.owner(), 'local');
  assert.strictEqual(own.ownerOnline(), true);
  assert.deepStrictEqual(changes[1], {
    owner: 'local', previous: 'c1', size: { cols: 200, rows: 50 },
  });
});

test('размер помнится ПО ВЛАДЕЛЬЦУ — вернувшийся получает свой, а не чужой', () => {
  // Окно ПК на весь экран и браузер на макбуке — это два разных размера.
  // main.js забирает управление обратно БЕЗ размера (renderer в этот момент
  // ещё не успел сказать своё слово), и подставить сюда размер макбука
  // означало бы перерисовать Claude Code в чужой ширине на каждом возврате.
  const { own } = make();
  own.claim('local', { cols: 200, rows: 50 });
  own.claim('c1', { cols: 80, rows: 24 });
  assert.deepStrictEqual(own.size(), { cols: 80, rows: 24 });

  own.claim('local');
  assert.deepStrictEqual(own.size(), { cols: 200, rows: 50 }, 'вернулся размер окна ПК');

  own.claim('c1');
  assert.deepStrictEqual(own.size(), { cols: 80, rows: 24 }, 'и размер макбука тоже свой');
});

test('незнакомый владелец без размера не тащит чужой', () => {
  const { own, changes } = make();
  own.claim('local', { cols: 200, rows: 50 });
  own.claim('c9');
  assert.strictEqual(own.size(), null, 'о размере c9 мы ничего не знаем — лучше ничего, чем чужое');
  assert.strictEqual(changes[changes.length - 1].size, null);
});

test('onChange получает размер НОВОГО владельца, а не прежнего', () => {
  const { own, changes } = make();
  own.claim('local', { cols: 200, rows: 50 });
  own.claim('c1', { cols: 80, rows: 24 });
  own.claim('local');
  assert.deepStrictEqual(changes[changes.length - 1], {
    owner: 'local', previous: 'c1', size: { cols: 200, rows: 50 },
  });
});

test('createOwnership работает без onChange', () => {
  const own = createOwnership();
  assert.strictEqual(own.claim('c1', { cols: 80, rows: 24 }), true);
  assert.strictEqual(own.owner(), 'c1');
});
