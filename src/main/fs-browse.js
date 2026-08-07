'use strict';
// Чтение каталогов для файлового обзора (план 3 фазы «кокпит по сети»).
// Без Electron: модуль обязан идти под node --test, поэтому здесь только
// fs/path, а решение «показывать ли это человеку» принимает renderer.
//
// Владелец решил: показываем ВСЕ папки, включая скрытые и node_modules.
// Файлы тоже отдаём (renderer рисует их серыми и некликабельными) — иначе
// человек не отличит «пустая папка» от «зашёл не туда».
//
// Всё чтение здесь АСИНХРОННОЕ, и это не стилистика. Канал fs:list свободный
// (см. write-channels.js), путь целиком задаёт клиент, а синхронный readdirSync
// на недостижимом UNC возвращался ~21 секунду — и всё это время главный
// процесс не делал НИЧЕГО: ни IPC, ни прокачки вывода вкладок, ни сетевого
// сервера, ни трея, ни захвата управления (он в той же очереди). Злого умысла
// для этого не нужно: спящий NAS или выключенный VPN дают тот же эффект, когда
// человек вставляет \\nas\share в строку пути.
const fsp = require('fs').promises;
const path = require('path');

// Каталог на тысячи записей подвесил бы и сервер, и браузер: один node_modules
// в корне проекта — это десятки тысяч имён на каждый переход.
const DEFAULT_LIMIT = 1000;

// Потолок ожидания обычной папки. 5 секунд выбраны так: живая цель (локальный
// каталог на десятки тысяч имён, шара по тайлнету) отвечает за доли секунды,
// холодный сетевой диск после простоя — иногда за 2-3, а недостижимый UNC не
// ответит вообще и упрётся в собственный таймаут SMB на ~21 секунде. То есть
// 5 с не обрывает ни одного рабочего сценария и втрое короче «зависания»,
// которое человек уже трактует как сломанное приложение.
const DEFAULT_TIMEOUT_MS = 5000;

// Список дисков собирается на каждое открытие обзора и ощущается как часть
// клика, а не как переход, — здесь потолок жёстче. Живая буква отвечает за
// единицы миллисекунд даже по сети; пустой картридер или отвалившийся сетевой
// диск просто не покажется, и это лучше, чем ждать его полторы секунды.
const DRIVES_TIMEOUT_MS = 1500;

// Предел пути в обычных Win32-функциях. Длиннее — только через префикс \\?\.
const MAX_PATH = 260;

const TIMED_OUT = Symbol('таймаут');

// Асинхронное чтение освобождает ГЛАВНЫЙ поток, но не отменяет саму операцию:
// зависший вызов продолжает держать поток пула libuv (по умолчанию их 4), пока
// SMB не сдастся сам. Таймаут здесь — про «ответить человеку вовремя», а не про
// освобождение ресурса; поэтому он и короткий, и поэтому цена ошибки клиента
// теперь — один поток пула на несколько секунд вместо всего приложения.
function withTimeout(promise, ms) {
  let timer;
  const alarm = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
    // Таймер не должен сам по себе держать процесс живым: без unref() пустой
    // ожидающий таймер задерживал бы выход node --test на свой полный срок.
    if (typeof timer.unref === 'function') timer.unref();
  });
  // Промис-проигравший остаётся висеть, но необработанным его отказ не станет:
  // Promise.race вешает обработчики на ОБА промиса ещё до гонки.
  return Promise.race([promise, alarm]).finally(() => clearTimeout(timer));
}

const forHumans = (ms) => (ms >= 1000 ? `${Math.round(ms / 1000)} с` : `${ms} мс`);

// \\?\ отключает разбор пути Win32 целиком, в том числе предел MAX_PATH. Форма
// для UNC отдельная: \\server\share → \\?\UNC\server\share.
function extendedPath(abs) {
  if (abs.startsWith('\\\\?\\')) return abs;
  if (abs.startsWith('\\\\')) return `\\\\?\\UNC\\${abs.slice(2)}`;
  return `\\\\?\\${abs}`;
}

// Windows с ВЫКЛЮЧЕННОЙ поддержкой длинных путей отвечает на путь длиннее
// MAX_PATH тем же ENOENT, что и на отсутствующую папку, — и человек идёт искать
// несуществующую причину («да вот же она, я её вижу в проводнике»). Отличить
// одно от другого можно повторной пробой через \\?\: она предела не знает.
// На этой машине длинные пути включены (LongPathsEnabled=1) и readdir читает их
// сам, так что ветка молчит; она для машин, где их нет, — вплоть до соседней
// сборки Windows.
async function missingReason(abs, timeoutMs) {
  if (process.platform !== 'win32' || abs.length <= MAX_PATH) return 'папки не существует';
  try {
    const st = await withTimeout(fsp.stat(extendedPath(abs)), timeoutMs);
    if (st !== TIMED_OUT && st.isDirectory()) {
      return `путь длиннее ${MAX_PATH} символов — Windows не открывает такой без поддержки длинных путей`;
    }
  } catch { /* и через префикс не открылось — значит папки правда нет */ }
  return 'папки не существует';
}

async function listDir(dirPath, {
  limit = DEFAULT_LIMIT,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  // readdir подменяется ТОЛЬКО в тестах и только чтобы изобразить зависание:
  // настоящий недостижимый UNC держал бы поток пула ещё двадцать секунд после
  // конца теста, и node --test не смог бы выйти. Живая проверка на
  // \\192.0.2.1\share делается на запущенном приложении, не здесь.
  readdir = (p) => fsp.readdir(p, { withFileTypes: true }),
} = {}) {
  const empty = (error) => ({
    path: typeof dirPath === 'string' ? dirPath : '', parent: null, entries: [], truncated: false, error,
  });
  if (typeof dirPath !== 'string' || !dirPath.trim()) return empty('путь не указан');

  const abs = path.resolve(dirPath);
  let raw;
  try {
    raw = await withTimeout(readdir(abs), timeoutMs);
  } catch (err) {
    // Права, отсутствие, файл вместо каталога — всё это нормальные ответы
    // файловой системы, а не повод ронять процесс с необработанным исключением.
    if (err.code === 'ENOENT') return empty(await missingReason(abs, timeoutMs));
    if (err.code === 'ENOTDIR') return empty('это файл, а не папка');
    if (err.code === 'EPERM' || err.code === 'EACCES') return empty('нет доступа');
    return empty(`не удалось прочитать: ${err.code || err.message}`);
  }
  // Ответа нет — но это не «пусто» и не «нет такой папки»: человеку надо
  // сказать именно то, что произошло, иначе он будет чинить не то.
  if (raw === TIMED_OUT) return empty(`папка не отвечает (нет ответа за ${forHumans(timeoutMs)})`);

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

// Проба буквы: access дешевле stat (нам нужен факт «есть», а не метаданные).
const canOpen = async (root) => {
  try {
    await fsp.access(root);
    return true;
  } catch {
    return false; // нет диска или он не отвечает — просто не показываем
  }
};

// Список дисков: без него от C:\Users до C:\games не добраться вообще никак.
// Перебор букв дешевле любого внешнего вызова (wmic/powershell) и не зависит
// от локали вывода.
//
// Пробы асинхронные по той же причине, что и listDir: existsSync на букве
// отключённого сетевого диска или пустого картридера замораживал весь главный
// процесс — только теперь на ровном месте, без всякого ввода от человека.
async function listDrives({ timeoutMs = DRIVES_TIMEOUT_MS, probe = canOpen } = {}) {
  const letters = [];
  for (let code = 'A'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code += 1) {
    letters.push(`${String.fromCharCode(code)}:\\`);
  }
  // Все 26 проб идут ПАРАЛЛЕЛЬНО: последовательный перебор с таймаутом на
  // каждую в худшем случае стоил бы 26 таймаутов подряд.
  const found = await Promise.all(letters.map(async (root) => {
    try {
      const ok = await withTimeout(probe(root), timeoutMs);
      // TIMED_OUT — это Symbol, он истинный: сравнивать надо с ним самим, иначе
      // не ответившая буква попала бы в список как существующая.
      return (ok !== TIMED_OUT && ok) ? root : null;
    } catch {
      return null;
    }
  }));
  return found.filter(Boolean);
}

module.exports = {
  listDir, listDrives, DEFAULT_LIMIT, DEFAULT_TIMEOUT_MS,
};
