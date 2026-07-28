'use strict';
// Файловый журнал «Ночной смены» (Task 2 фазы 8): JSON-массив записей на
// диске, атомарная запись (temp+rename — тот же приём, что уже применяется в
// workspace.js/recipes.js). Битый/неверной формы файл на чтении → readAll()=[],
// НИКОГДА не бросаем (см. раздел «Обработка ошибок» спеки night-watch). Перед
// ПЕРВОЙ перезаписью поверх битого файла его исходное содержимое сохраняется
// КАК ЕСТЬ в `${file}.bak` (образец recipes.js/writeList, включая
// «одноразовость» бэкапа — как только file снова становится валидным, второй
// .bak больше не создаётся, пока кто-то не испортит file заново в обход
// этого модуля).
//
// fs — инжектируемый (по умолчанию require('fs')): night-watch.js в smoke
// получает in-memory фейк journal (см. ipc.js), а этот модуль в проде читает
// и пишет реальный файл в userData; инъекция fs здесь же даёт тестам проверить
// атомарность (падение renameSync не должно портить уже лежащий на диске
// файл) фейковым fs, а не реальным сбоем диска.

const nodeFs = require('fs');
const nodePath = require('path');

function isValidList(v) {
  return Array.isArray(v);
}

function createNightJournal({ file, fs = nodeFs, path = nodePath }) {
  function readRaw() {
    return fs.readFileSync(file, 'utf8');
  }

  // readAll() никогда не бросает: файла нет / не JSON / JSON, но не массив —
  // всё трактуется как «журнала ещё нет», не как ошибка.
  function readAll() {
    try {
      const parsed = JSON.parse(readRaw());
      return isValidList(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  // true, только если то, что СЕЙЧАС лежит в file, не парсится или не массив
  // (отсутствие файла — НЕ считается «битым» в этом смысле: бэкапить нечего,
  // это обычная ветка первой записи).
  function isCurrentFileCorrupted() {
    let raw;
    try {
      raw = readRaw();
    } catch {
      return false;
    }
    try {
      return !isValidList(JSON.parse(raw));
    } catch {
      return true;
    }
  }

  // Атомарная запись всего списка: битый file (если есть) уходит в .bak
  // ПЕРЕД перезаписью; сама запись — через temp-файл + rename, чтобы падение
  // посреди записи никогда не оставляло file наполовину переписанным. Любая
  // ошибка (диск недоступен, renameSync упал и т.п.) только логируется —
  // журнал не должен ронять ядро ночной смены из-за проблем с диском.
  function writeList(list) {
    try {
      if (isCurrentFileCorrupted()) {
        try {
          const raw = readRaw();
          fs.writeFileSync(`${file}.bak`, raw, 'utf8');
        } catch { /* гонка (файл исчез между проверкой и чтением) — не критично */ }
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
      fs.renameSync(tmp, file);
    } catch (err) {
      console.warn(`[night-journal] запись ${path.basename(file)} не удалась: ${err && err.message}`);
    }
  }

  function append(entry) {
    try {
      const list = readAll();
      list.push(entry);
      writeList(list);
    } catch {
      // readAll()/writeList() уже не бросают сами по себе, но на всякий
      // случай (например, path.basename выше бросит на совсем экзотическом
      // фейковом fs/path) — append() по контракту тоже не бросает никогда.
    }
  }

  function reset() {
    writeList([]);
  }

  return { append, readAll, reset };
}

module.exports = { createNightJournal };
