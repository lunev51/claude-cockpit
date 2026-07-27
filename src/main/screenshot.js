'use strict';
// Вставка скриншота из буфера обмена в терминал (Task 4 фазы 4, Ctrl+Shift+V).
// Чистый модуль: fs можно, require('electron') — НЕЛЬЗЯ. clipboard/nativeImage
// инжектируются через readImage() (см. ipc.js: readImage: () => clipboard.readImage()),
// поэтому вся логика тестируется фейковым readImage без Electron (test/screenshot.test.js).

const fs = require('fs');
const path = require('path');

function pad2(n) {
  return String(n).padStart(2, '0');
}

// Имя файла из момента времени (мс, как Date.now()): YYYYMMDD-HHmmss.png —
// сортируется лексикографически так же, как и хронологически.
function timestampName(now) {
  const d = new Date(now);
  const date = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
  const time = `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  return `${date}-${time}.png`;
}

// Разрешение timestampName — 1с: две вставки в один и тот же буфер в течение
// одной секунды дают одинаковое имя файла. Без этой проверки второй write
// молча затёр бы первый PNG. Ищем первое свободное имя, добавляя суффикс
// -2, -3, … (первая попытка — без суффикса, как раньше).
function uniqueFile(shotsDir, now) {
  const base = timestampName(now);
  const stem = base.slice(0, -'.png'.length);
  let candidate = path.join(shotsDir, base);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(shotsDir, `${stem}-${n}.png`);
    n += 1;
  }
  return candidate;
}

// saveClipboardImage({ readImage, dir, now }) → { path } | null.
// readImage() — Electron-подобный nativeImage: isEmpty()/toPNG(). Если в
// буфере не картинка (isEmpty() === true) — возвращаем null, ничего не пишем.
// dir — cwd вкладки; пишем в <dir>/.cockpit-shots/<timestamp>.png (mkdir -p).
// При ПЕРВОМ создании этой подпапки кладём рядом .gitignore с «*» — папка
// живёт внутри чужого (пользовательского) git-репозитория проекта, и без
// этого туда бы намусорило PNG-артефактами скриншотов.
function saveClipboardImage({ readImage, dir, now }) {
  const image = readImage();
  if (!image || image.isEmpty()) return null;

  const shotsDir = path.join(dir, '.cockpit-shots');
  const isNewDir = !fs.existsSync(shotsDir);
  fs.mkdirSync(shotsDir, { recursive: true });
  if (isNewDir) {
    try {
      fs.writeFileSync(path.join(shotsDir, '.gitignore'), '*', 'utf8');
    } catch { /* best-effort — отсутствие .gitignore не критично */ }
  }

  const file = uniqueFile(shotsDir, now);
  fs.writeFileSync(file, image.toPNG());
  return { path: file };
}

module.exports = { saveClipboardImage, timestampName };
