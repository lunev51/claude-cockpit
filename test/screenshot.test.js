'use strict';
// saveClipboardImage (Phase 4, Task 4 — вставка скриншотов) — чистая логика,
// electron (clipboard/nativeImage) не импортируется; readImage — фейк.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { saveClipboardImage, timestampName } = require('../src/main/screenshot');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-shot-'));
}

// Фейковый Electron nativeImage: isEmpty()/toPNG(), как того требует контракт.
function fakeImage(png) {
  return {
    isEmpty: () => !png,
    toPNG: () => png,
  };
}

test('timestampName: формат YYYYMMDD-HHmmss.png', () => {
  const d = new Date(2026, 6, 27, 9, 5, 3); // месяцы с 0 → июль = 6
  assert.strictEqual(timestampName(d.getTime()), '20260727-090503.png');
});

test('timestampName: нули дополняются слева (однозначные месяц/день/часы/минуты/секунды)', () => {
  const d = new Date(2026, 0, 5, 2, 3, 4); // 5 января, 02:03:04
  assert.strictEqual(timestampName(d.getTime()), '20260105-020304.png');
});

test('пустой буфер обмена (isEmpty() === true) → null, папка не создаётся', () => {
  const dir = tmpDir();
  const res = saveClipboardImage({
    readImage: () => fakeImage(null),
    dir,
    now: Date.now(),
  });
  assert.strictEqual(res, null);
  assert.strictEqual(fs.existsSync(path.join(dir, '.cockpit-shots')), false);
});

test('картинка в буфере → файл создан по верному пути, содержимое совпадает, .gitignore появился', () => {
  const dir = tmpDir();
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]); // сигнатура PNG, реальный битмап не нужен
  const now = new Date(2026, 6, 27, 9, 5, 3).getTime();

  const res = saveClipboardImage({ readImage: () => fakeImage(png), dir, now });

  const expected = path.join(dir, '.cockpit-shots', '20260727-090503.png');
  assert.deepStrictEqual(res, { path: expected });
  assert.ok(fs.existsSync(expected));
  assert.deepStrictEqual(fs.readFileSync(expected), png);

  const gitignore = path.join(dir, '.cockpit-shots', '.gitignore');
  assert.ok(fs.existsSync(gitignore));
  assert.strictEqual(fs.readFileSync(gitignore, 'utf8'), '*');
});

test('второй скриншот в ту же папку — .gitignore не трогается повторно, оба файла на месте', () => {
  const dir = tmpDir();
  const png1 = Buffer.from([1, 2, 3]);
  const png2 = Buffer.from([4, 5, 6]);

  const res1 = saveClipboardImage({
    readImage: () => fakeImage(png1), dir, now: new Date(2026, 6, 27, 9, 0, 0).getTime(),
  });
  const res2 = saveClipboardImage({
    readImage: () => fakeImage(png2), dir, now: new Date(2026, 6, 27, 9, 0, 1).getTime(),
  });

  assert.notStrictEqual(res1.path, res2.path);
  assert.ok(fs.existsSync(res1.path));
  assert.ok(fs.existsSync(res2.path));
  assert.deepStrictEqual(fs.readFileSync(res1.path), png1);
  assert.deepStrictEqual(fs.readFileSync(res2.path), png2);
  assert.strictEqual(
    fs.readFileSync(path.join(dir, '.cockpit-shots', '.gitignore'), 'utf8'),
    '*',
  );
});

test('readImage() возвращающий null/undefined (а не объект с isEmpty) не роняет функцию', () => {
  const dir = tmpDir();
  const res = saveClipboardImage({ readImage: () => null, dir, now: Date.now() });
  assert.strictEqual(res, null);
});

test('две вставки с ОДИНАКОВЫМ now (разрешение timestampName — 1с) → разные файлы, оба существуют, первый НЕ затёрт', () => {
  const dir = tmpDir();
  const now = new Date(2026, 6, 27, 10, 0, 0).getTime();
  const pngA = Buffer.from([9, 9, 9]);
  const pngB = Buffer.from([8, 8, 8]);

  const resA = saveClipboardImage({ readImage: () => fakeImage(pngA), dir, now });
  const resB = saveClipboardImage({ readImage: () => fakeImage(pngB), dir, now });

  assert.notStrictEqual(resA.path, resB.path);
  assert.ok(fs.existsSync(resA.path));
  assert.ok(fs.existsSync(resB.path));
  assert.deepStrictEqual(fs.readFileSync(resA.path), pngA); // первый не затёрт вторым
  assert.deepStrictEqual(fs.readFileSync(resB.path), pngB);
});

test('папка .cockpit-shots уже существует БЕЗ .gitignore (удалили, старая сборка, копия проекта) → после сохранения .gitignore появился', () => {
  const dir = tmpDir();
  const shotsDir = path.join(dir, '.cockpit-shots');
  fs.mkdirSync(shotsDir, { recursive: true }); // папка есть, .gitignore — нет
  assert.strictEqual(fs.existsSync(path.join(shotsDir, '.gitignore')), false);

  const png = Buffer.from([7, 7, 7]);
  const res = saveClipboardImage({
    readImage: () => fakeImage(png), dir, now: new Date(2026, 6, 27, 11, 0, 0).getTime(),
  });

  assert.ok(fs.existsSync(res.path));
  const gitignore = path.join(shotsDir, '.gitignore');
  assert.ok(fs.existsSync(gitignore));
  assert.strictEqual(fs.readFileSync(gitignore, 'utf8'), '*');
});

test('третья и последующие вставки в ту же секунду продолжают счётчик суффиксов (-2, -3, …)', () => {
  const dir = tmpDir();
  const now = new Date(2026, 6, 27, 10, 0, 0).getTime();
  const results = [Buffer.from([1]), Buffer.from([2]), Buffer.from([3])].map(
    (png) => saveClipboardImage({ readImage: () => fakeImage(png), dir, now }),
  );
  assert.deepStrictEqual(results.map((r) => path.basename(r.path)), [
    '20260727-100000.png',
    '20260727-100000-2.png',
    '20260727-100000-3.png',
  ]);
});
