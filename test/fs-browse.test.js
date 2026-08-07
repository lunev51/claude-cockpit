'use strict';
// Чтение каталогов для файлового обзора. Тесты — на НАСТОЯЩЕЙ временной папке
// (тот же приём, что в session-title.test.js): поведение fs на Windows слишком
// богато на частности, чтобы проверять его моками.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listDir, listDrives } = require('../src/main/fs-browse');

function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-browse-'));
  fs.mkdirSync(path.join(root, 'zebra'));
  fs.mkdirSync(path.join(root, 'Alpha'));
  fs.mkdirSync(path.join(root, '.hidden'));
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'readme.md'), 'x');
  fs.writeFileSync(path.join(root, 'A-file.txt'), 'x');
  return root;
}

test('папки идут первыми, потом файлы, внутри — по алфавиту без учёта регистра', () => {
  const root = makeTree();
  const res = listDir(root);
  assert.strictEqual(res.error, null);
  assert.deepStrictEqual(res.entries, [
    { name: '.hidden', dir: true },
    { name: 'Alpha', dir: true },
    { name: 'node_modules', dir: true },
    { name: 'zebra', dir: true },
    { name: 'A-file.txt', dir: false },
    { name: 'readme.md', dir: false },
  ], 'скрытые и node_modules показываются наравне — решение владельца');
});

test('родитель известен, а у корня диска его нет', () => {
  const root = makeTree();
  const res = listDir(root);
  assert.strictEqual(res.parent, path.dirname(root));

  const drive = path.parse(root).root; // 'C:\\'
  assert.strictEqual(listDir(drive).parent, null, 'выше корня диска идти некуда');
});

test('путь нормализуется: слеши, точки, хвостовой разделитель', () => {
  const root = makeTree();
  const messy = `${root}${path.sep}Alpha${path.sep}..${path.sep}`;
  assert.strictEqual(listDir(messy).path, path.resolve(root));
});

test('длинный каталог режется и честно об этом сообщает', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-big-'));
  for (let i = 0; i < 25; i += 1) fs.mkdirSync(path.join(root, `dir-${String(i).padStart(3, '0')}`));
  const res = listDir(root, { limit: 10 });
  assert.strictEqual(res.entries.length, 10);
  assert.strictEqual(res.truncated, true);
  // Обрезаем ПОСЛЕ сортировки, иначе список прыгал бы от вызова к вызову.
  assert.strictEqual(res.entries[0].name, 'dir-000');
});

test('короткий каталог не помечается обрезанным', () => {
  const root = makeTree();
  assert.strictEqual(listDir(root, { limit: 1000 }).truncated, false);
});

test('несуществующая папка — понятный текст, а не исключение', () => {
  const res = listDir(path.join(os.tmpdir(), 'нет-такой-папки-12345'));
  assert.strictEqual(res.entries.length, 0);
  assert.match(res.error, /не существует/i);
});

test('файл вместо папки — тоже понятный отказ', () => {
  const root = makeTree();
  const res = listDir(path.join(root, 'readme.md'));
  assert.ok(res.error, 'файл — не каталог, и это надо сказать');
});

test('пустой и не-строковый путь не роняют', () => {
  for (const bad of ['', null, undefined, 42, {}]) {
    const res = listDir(bad);
    assert.ok(res.error, `${JSON.stringify(bad)} должен дать ошибку, а не исключение`);
    assert.deepStrictEqual(res.entries, []);
  }
});

test('диски: непустой список, каждый существует', () => {
  const drives = listDrives();
  assert.ok(Array.isArray(drives) && drives.length > 0);
  for (const d of drives) {
    assert.match(d, /^[A-Z]:\\$/);
    assert.ok(fs.existsSync(d), `${d} обязан существовать — иначе он не диск`);
  }
  assert.ok(drives.includes('C:\\'), 'на этой машине C: есть всегда');
});
