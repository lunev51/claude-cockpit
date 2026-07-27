'use strict';
// parseOptions (Phase 4, Task 3 — peek popover) — чистая функция без DOM,
// живёт в src/renderer/js/peek-parse.js как ESM-модуль (renderer использует
// import), а этот тест — CommonJS (node --test). Мост между ними —
// динамический import() внутри async-теста: Node это поддерживает и в
// CommonJS-файле (import() — выражение, не декларация, доступно везде).

const test = require('node:test');
const assert = require('node:assert');

test('parseOptions: базовые форматы «1. …», «2) …», «[3] …»', async () => {
  const { parseOptions } = await import('../src/renderer/js/peek-parse.js');
  const text = 'Удалить таблицу?\n1. Да\n2) Нет\n[3] Отмена';
  assert.deepStrictEqual(parseOptions(text), [
    { digit: '1', label: 'Да' },
    { digit: '2', label: 'Нет' },
    { digit: '3', label: 'Отмена' },
  ]);
});

test('parseOptions: нет вариантов → []', async () => {
  const { parseOptions } = await import('../src/renderer/js/peek-parse.js');
  assert.deepStrictEqual(parseOptions('Просто обычный текст без списка вариантов.'), []);
  assert.deepStrictEqual(parseOptions(''), []);
  assert.deepStrictEqual(parseOptions(null), []);
  assert.deepStrictEqual(parseOptions(undefined), []);
});

test('parseOptions: игнорирует «1.5 секунды» (десятичное число, не маркер варианта)', async () => {
  const { parseOptions } = await import('../src/renderer/js/peek-parse.js');
  assert.deepStrictEqual(parseOptions('Подождите 1.5 секунды и попробуйте снова.'), []);
  assert.deepStrictEqual(parseOptions('1.5 секунды\n2.3 минуты — обе строки не варианты'), []);
});

test('parseOptions: реальные варианты вперемешку со строкой вида «X.Y число» — берёт только маркеры', async () => {
  const { parseOptions } = await import('../src/renderer/js/peek-parse.js');
  const text = 'Ждать 1.5 секунды нельзя.\n1. Подождать 5 секунд\n2. Отменить операцию';
  assert.deepStrictEqual(parseOptions(text), [
    { digit: '1', label: 'Подождать 5 секунд' },
    { digit: '2', label: 'Отменить операцию' },
  ]);
});

test('parseOptions: маркер с отступом (ведущие пробелы) распознаётся', async () => {
  const { parseOptions } = await import('../src/renderer/js/peek-parse.js');
  assert.deepStrictEqual(parseOptions('  1. Да\n  2. Нет'), [
    { digit: '1', label: 'Да' },
    { digit: '2', label: 'Нет' },
  ]);
});

test('parseOptions: двузначный номер («10. …») не считается маркером', async () => {
  const { parseOptions } = await import('../src/renderer/js/peek-parse.js');
  assert.deepStrictEqual(parseOptions('10. Одиннадцатый пункт по счёту'), []);
});

test('parseOptions: длинная подпись обрезается ровно до 80 символов', async () => {
  const { parseOptions } = await import('../src/renderer/js/peek-parse.js');
  const longLabel = 'а'.repeat(120);
  const opts = parseOptions(`1. ${longLabel}`);
  assert.strictEqual(opts.length, 1);
  assert.strictEqual(opts[0].label.length, 80);
  assert.strictEqual(opts[0].label, longLabel.slice(0, 80));
});

test('parseOptions: короткая подпись (≤80) не обрезается', async () => {
  const { parseOptions } = await import('../src/renderer/js/peek-parse.js');
  const opts = parseOptions('1. Короткий вариант');
  assert.strictEqual(opts[0].label, 'Короткий вариант');
});

test('parseOptions: максимум 9 вариантов, даже если валидных строк больше', async () => {
  const { parseOptions } = await import('../src/renderer/js/peek-parse.js');
  const lines = [];
  for (let i = 1; i <= 9; i += 1) lines.push(`${i}. Вариант ${i}`);
  for (let i = 1; i <= 3; i += 1) lines.push(`${i}. Лишний вариант ${i}`); // не должны попасть — уже набрано 9
  const opts = parseOptions(lines.join('\n'));
  assert.strictEqual(opts.length, 9);
  assert.deepStrictEqual(opts.map((o) => o.label), [
    'Вариант 1', 'Вариант 2', 'Вариант 3', 'Вариант 4', 'Вариант 5',
    'Вариант 6', 'Вариант 7', 'Вариант 8', 'Вариант 9',
  ]);
});
