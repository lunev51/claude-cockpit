'use strict';
// Чтение каталогов для файлового обзора (план 3 фазы «кокпит по сети»).
// Без Electron: модуль обязан идти под node --test, поэтому здесь только
// fs/path, а решение «показывать ли это человеку» принимает renderer.
//
// Владелец решил: показываем ВСЕ папки, включая скрытые и node_modules.
// Файлы тоже отдаём (renderer рисует их серыми и некликабельными) — иначе
// человек не отличит «пустая папка» от «зашёл не туда».
const fs = require('fs');
const path = require('path');

// Каталог на тысячи записей подвесил бы и сервер, и браузер: один node_modules
// в корне проекта — это десятки тысяч имён на каждый переход.
const DEFAULT_LIMIT = 1000;

function listDir(dirPath, { limit = DEFAULT_LIMIT } = {}) {
  const empty = (error) => ({
    path: typeof dirPath === 'string' ? dirPath : '', parent: null, entries: [], truncated: false, error,
  });
  if (typeof dirPath !== 'string' || !dirPath.trim()) return empty('путь не указан');

  const abs = path.resolve(dirPath);
  let raw;
  try {
    raw = fs.readdirSync(abs, { withFileTypes: true });
  } catch (err) {
    // Права, отсутствие, файл вместо каталога — всё это нормальные ответы
    // файловой системы, а не повод ронять процесс с необработанным исключением.
    if (err.code === 'ENOENT') return empty('папки не существует');
    if (err.code === 'ENOTDIR') return empty('это файл, а не папка');
    if (err.code === 'EPERM' || err.code === 'EACCES') return empty('нет доступа');
    return empty(`не удалось прочитать: ${err.code || err.message}`);
  }

  const entries = raw
    .map((d) => ({ name: d.name, dir: d.isDirectory() }))
    // Папки первыми: человек сюда пришёл выбирать папку, файлы — только
    // ориентир. Внутри группы — по алфавиту без учёта регистра, иначе
    // 'Alpha' и 'alpha' разъезжаются по разным концам списка.
    .sort((a, b) => {
      if (a.dir !== b.dir) return a.dir ? -1 : 1;
      return a.name.localeCompare(b.name, 'ru', { sensitivity: 'base' });
    });

  // Режем ПОСЛЕ сортировки — иначе набор видимых имён менялся бы от вызова к
  // вызову вместе с порядком выдачи файловой системы.
  const truncated = entries.length > limit;
  const parent = path.dirname(abs);

  return {
    path: abs,
    // dirname корня диска возвращает сам корень — выше идти некуда.
    parent: parent === abs ? null : parent,
    entries: truncated ? entries.slice(0, limit) : entries,
    truncated,
    error: null,
  };
}

// Список дисков: без него от C:\Users до C:\games не добраться вообще никак.
// Перебор букв дешевле любого внешнего вызова (wmic/powershell) и не зависит
// от локали вывода.
function listDrives() {
  const drives = [];
  for (let code = 'A'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code += 1) {
    const root = `${String.fromCharCode(code)}:\\`;
    try {
      if (fs.existsSync(root)) drives.push(root);
    } catch { /* недоступный диск — просто не показываем */ }
  }
  return drives;
}

module.exports = { listDir, listDrives, DEFAULT_LIMIT };
