'use strict';
// Пользовательский оверлей настроек (userData/config.user.json): чтение и
// запись. Отдельный модуль, а не часть config.js, по той же причине, по
// которой отдельно живут recipes.js и workspace.js: config.js на верхнем
// уровне зовёт require('electron') и под node --test не грузится вовсе, а эта
// логика обязана быть под тестом — она про сохранность настроек.
//
// Ревью 09.08. Оверлей писался голым writeFileSync, тогда как рецепты и
// манифест воркспейса рядом пишутся атомарно (temp+rename с копией
// предыдущего поколения). Между тем оверлей — единственный файл настроек,
// который правит человек, и именно в нём живёт net.host, от которого зависит
// доступ к кокпиту с макбука. Обрыв записи (выключили питание, краш, полный
// диск) оставлял битый JSON, а читатель молча возвращал {} — разом терялись
// ВСЕ настройки, без следа и без возможности восстановить.
//
// Здесь исправлены обе половины: запись атомарна, а чтение умеет отступить на
// последнее валидное поколение.

const fs = require('fs');
const path = require('path');

// Разбор файла: объект при успехе, null при отсутствии ИЛИ битом содержимом.
// Отличать одно от другого вызывающему не нужно — обе ситуации означают
// «пригодных настроек здесь нет», а причина уходит в лог.
function parseJsonFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null; // файла нет — это норма, а не ошибка
  }
  try {
    const data = JSON.parse(raw);
    // Массив или null формально разбираются, но оверлеем быть не могут:
    // deepMerge ниже по стеку ждёт объект.
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch (err) {
    console.warn(`[config] ${path.basename(file)} не разобрался: ${err.message}`);
    return null;
  }
}

// Чтение с подстраховкой: рядом лежит последнее ВАЛИДНОЕ поколение (.bak), и
// битый основной файл больше не означает потерю всех настроек.
function readOverlay(file) {
  const direct = parseJsonFile(file);
  if (direct) return direct;
  // На страховку отступаем ТОЛЬКО если файл есть, но испорчен. Удаление
  // config.user.json — законный жест «сбросить настройки к дефолтным», и
  // воскрешать их из .bak значило бы, что сброс требует знать про второй,
  // никому не обещанный файл. (Замечание ревью фикса.)
  if (!fs.existsSync(file)) return {};
  const backup = parseJsonFile(`${file}.bak`);
  if (backup) {
    console.warn(`[config] ${path.basename(file)} испорчен — беру предыдущее сохранение (.bak)`);
    return backup;
  }
  return {};
}

// Атомарная запись: temp+rename, плюс копия предыдущего валидного поколения.
// Копируем в .bak ТОЛЬКО валидный файл — тот же довод, что в
// workspace.js/writeNow: иначе одна внешняя порча затирает страховку ровно
// тогда, когда она нужна.
//
// Никогда не бросает: не сохранившиеся настройки не повод ронять приложение
// (setConfig зовётся из обработчика IPC, а исключение оттуда уходит в
// uncaughtException → app.exit(1)).
function writeOverlay(file, data) {
  try {
    if (parseJsonFile(file)) {
      try { fs.copyFileSync(file, `${file}.bak`); } catch { /* страховка не удалась — не критично */ }
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    console.warn(`[config] запись ${path.basename(file)} не удалась: ${err.message}`);
    return false;
  }
}

module.exports = { readOverlay, writeOverlay, parseJsonFile };
