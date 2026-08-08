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
//
// РАУНД 2 (ре-ревью C-1). Асинхронность освободила главный поток, но заморозка
// не исчезла — она переехала в пул libuv. Пул общий на весь процесс, потоков в
// нём по умолчанию ЧЕТЫРЕ, и там же живут history:search и чтение
// транскриптов. Таймаут ниже отвечает человеку, но саму операцию НЕ отменяет:
// зависший readdir держит свой поток до собственного таймаута SMB. Замер на
// запущенном приложении (порт 48314, свежие адреса TEST-NET-1):
//
//   БАЗА   fs:list(живая)      9 мс   error=null entries=3
//   1 UNC  fs:list(живая)      1 мс   error=null entries=3   <- один зависший безвреден
//   4 UNC  fs:list(живая)   5006 мс   «папка не отвечает»    <- ЛОЖЬ про живую папку
//   4 UNC  fs:drives        1502 мс   []                     <- дисков нет
//   4 UNC  history:search  17815 мс
//
// То есть ограничивать надо не время ответа, а ЧИСЛО ОДНОВРЕМЕННО ВИСЯЩИХ
// чтений — этим и заняты дорожки (lanes) ниже.
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

// Сколько чтений каталога модуль имеет право держать в пуле ОДНОВРЕМЕННО.
//
// Сеть — одно. Ровно этот уровень замером признан безвредным: при одном
// зависшем UNC живая папка отвечала за 1 мс, а список дисков был полон.
// Второй сетевой путь в пул уже не уходит: пока первый не вернулся, отвечаем
// человеку текстом, а поток пула не тратим вовсе.
//
// Диск — два, и дорожка у него ОТДЕЛЬНАЯ. Отдельная — это и есть суть фикса:
// одна общая очередь на всё просто переносит заморозку из пула в очередь, и
// живая C:\Users по-прежнему ждала бы мёртвый \\nas. Два, а не один, потому
// что буква сетевого диска (Z: → \\nas\share) от локальной синтаксически
// неотличима и умеет висеть так же: второй слот оставляет живым буквам дорогу
// мимо зависшей.
//
// Итого потолок незавершённых чтений модуля — три из четырёх потоков пула, и
// это ХУДШИЙ случай (две зависшие буквы одновременно). В сценарии ре-ревью
// (висит только сеть) занят один поток, три свободны — history:search и
// транскрипты продолжают работать.
const MAX_NET_READS = 1;
const MAX_DISK_READS = 2;

// Пробы букв в listDrives идут через собственный диспетчер, а не все 26 разом:
// иначе отсчёт их таймаута начинается в момент ПОСТАНОВКИ задачи, а не старта,
// и живая буква выбывает из списка, так и не начав проверяться (вторая часть
// находки C-1: `4 UNC fs:drives 1502 мс []` — C: не дождалась очереди в пуле).
const DRIVE_PROBE_CONCURRENCY = 4;

// Предел пути в обычных Win32-функциях. Длиннее — только через префикс \\?\.
const MAX_PATH = 260;

const TIMED_OUT = Symbol('таймаут');

const NET_LANE = 'сеть';
const DISK_LANE = 'диск';

// Асинхронное чтение освобождает ГЛАВНЫЙ поток, но не отменяет саму операцию:
// зависший вызов продолжает держать поток пула libuv (по умолчанию их 4), пока
// SMB не сдастся сам. Таймаут здесь — про «ответить человеку вовремя», а не про
// освобождение ресурса; за ресурс отвечают дорожки ниже.
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

// ---------------------------------------------------------------------------
// Дорожки: очередь на N одновременных чтений, слот держится до НАСТОЯЩЕГО
// конца вызова, а не до нашего таймаута. Отпустить слот по таймауту значило бы
// вернуться к исходной болезни: место в очереди освободилось, а поток пула
// по-прежнему занят, и следующий вызов отнимает ещё один.
// ---------------------------------------------------------------------------

// Состояние вынесено в объект, а не в модульные переменные, чтобы тест мог
// взять СВОЮ песочницу: зависшее чтение слот не отдаёт никогда (оно на то и
// зависшее), и на общем состоянии один такой тест испортил бы все следующие.
function createGate() {
  return { lanes: new Map(), reads: new Map() };
}

const defaultGate = createGate();

function laneOf(gate, name, limit) {
  let lane = gate.lanes.get(name);
  if (!lane) {
    lane = { name, limit, running: 0, hung: 0, waiters: [], stuck: [] };
    gate.lanes.set(name, lane);
  }
  lane.limit = limit;
  return lane;
}

function release(lane) {
  // Слот не «освобождается», а переходит следующему в очереди: между shift() и
  // повторным захватом нет ни одного await, поэтому чужой вызов не успеет
  // вклиниться и превысить потолок.
  const next = lane.waiters.shift();
  if (next) { next.resolve(true); return; }
  lane.running -= 1;
}

// Ожидание слота, когда свободного нет. Свободный слот берётся СИНХРОННО в
// guardedReaddir и сюда не заходит — см. комментарий там, это не оптимизация.
function waitForSlot(lane, waitMs) {
  const ticket = {};
  const wait = new Promise((resolve) => { ticket.resolve = resolve; });
  lane.waiters.push(ticket);
  return withTimeout(wait, waitMs).then((res) => {
    if (res !== TIMED_OUT) return true;
    const i = lane.waiters.indexOf(ticket);
    if (i >= 0) { lane.waiters.splice(i, 1); return false; }
    // Нас разбудили ровно в тот момент, когда сработал таймаут: слот уже наш и
    // его надо вернуть, иначе он потеряется навсегда.
    release(lane);
    return false;
  });
}

// Ответ человеку, когда до чтения дело не дошло. Врать «папка не отвечает»
// здесь нельзя: эту папку мы не спрашивали, а сломано совсем другое.
function busyText(lane, waitedMs) {
  const rule = `одновременных чтений (${lane.name}) — не больше ${lane.limit}`;
  if (lane.stuck.length) return `не пробовали читать: ${lane.stuck[0]} не отвечает, ${rule}`;
  return `не пробовали читать: очередь занята, ${rule} (ждали ${forHumans(waitedMs)})`;
}

// \\server\share — сеть. \\?\C:\... и \\.\PhysicalDrive0 начинаются так же, но
// сетью не являются: расширенная форма сетевого пути пишется \\?\UNC\server\share.
function looksNetwork(abs) {
  if (!abs.startsWith('\\\\')) return false;
  if (abs.startsWith('\\\\.\\')) return false;
  if (abs.startsWith('\\\\?\\')) return abs.slice(4, 8).toUpperCase() === 'UNC\\';
  return true;
}

// Само чтение: слот дорожки уже взят, вернуть его обязаны мы.
function startRead({ gate, lane, abs, readdir, timeoutMs }) {
  let done = false;
  let hung = false;
  const started = Promise.resolve().then(() => readdir(abs));
  // Запись в reads делается ДО первого await — иначе второй клик по тому же
  // пути успевал проскочить мимо неё (см. guardedReaddir).
  gate.reads.set(abs, started);
  const finish = () => {
    if (done) return;
    done = true;
    if (hung) {
      lane.hung -= 1;
      const i = lane.stuck.indexOf(abs);
      if (i >= 0) lane.stuck.splice(i, 1);
    }
    gate.reads.delete(abs);
    release(lane);
  };
  // Обработчик на started ставим СРАЗУ и на оба исхода: он и отпускает слот,
  // и заодно снимает вопрос необработанного отказа, если наш await уже ушёл
  // по таймауту.
  started.then(finish, finish);

  return withTimeout(started, timeoutMs).then((raw) => {
    if (raw === TIMED_OUT) {
      // Между проверкой и записью нет await — значит finish() не мог влезть в
      // середину и счётчики не разъедутся.
      if (!done) { hung = true; lane.hung += 1; lane.stuck.push(abs); }
      return { timedOut: true };
    }
    return { raw };
  });
}

// Одно чтение под охраной дорожки. Возвращает {raw} | {timedOut} | {busy},
// исключения файловой системы пробрасывает как есть — их разбирает listDir.
async function guardedReaddir({ gate, abs, readdir, timeoutMs, netLimit, diskLimit }) {
  // Этот же путь уже читается — присоединяемся к идущему вызову. Второй
  // readdir не ускорит ответ ни на миллисекунду, зато займёт ещё один поток
  // пула ровно на те же двадцать секунд. Человек, который жмёт «+ Проект»
  // три раза подряд (индикатора загрузки в обзоре нет, ограничения на
  // повторное открытие тоже), получит один и тот же ответ на все три клика.
  const already = gate.reads.get(abs);
  if (already) {
    const shared = await withTimeout(already, timeoutMs);
    return shared === TIMED_OUT ? { timedOut: true } : { raw: shared };
  }

  const net = looksNetwork(abs);
  const lane = laneOf(gate, net ? NET_LANE : DISK_LANE, net ? netLimit : diskLimit);
  // Свободный слот берём СИНХРОННО, без единого await по дороге. Это не
  // микрооптимизация: два клика подряд приходят в один тик, и если между
  // проверкой потолка и записью в reads вклинится микротаск, оба запроса
  // решат, что путь свободен, — потолок дорожки станет декоративным ровно в
  // том сценарии, ради которого он написан.
  if (lane.running < lane.limit) {
    lane.running += 1;
    return startRead({ gate, lane, abs, readdir, timeoutMs });
  }
  // Все занятые слоты уже признаны зависшими — ждать нечего. Продержать
  // человека полный таймаут, чтобы сказать ровно то же самое, было бы просто
  // медленнее: именно так выглядит повторный клик по недостижимому пути.
  if (lane.hung >= lane.running) return { busy: busyText(lane, 0) };

  const waitStarted = Date.now();
  if (!await waitForSlot(lane, timeoutMs)) return { busy: busyText(lane, Date.now() - waitStarted) };
  // Пока стояли в очереди, этот же путь мог начать читать кто-то другой.
  const meanwhile = gate.reads.get(abs);
  if (meanwhile) {
    release(lane);
    const shared = await withTimeout(meanwhile, timeoutMs);
    return shared === TIMED_OUT ? { timedOut: true } : { raw: shared };
  }
  return startRead({ gate, lane, abs, readdir, timeoutMs });
}

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
  netLimit = MAX_NET_READS,
  diskLimit = MAX_DISK_READS,
  // Общая на процесс очередь чтений: у ipc.js она одна на все окна и на всех
  // сетевых клиентов — потолок имеет смысл только тогда, когда он общий.
  gate = defaultGate,
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

  // I-1 финального ре-ревью: '\\сервер' без имени шары Windows UNC-корнем не
  // считает, и path.resolve достраивает к нему букву ТЕКУЩЕГО диска. Живой
  // замер: fs:list('\\Users') отдавал содержимое C:\Users с error=null — то
  // есть локальная папка показывалась как содержимое сервера, с активной
  // кнопкой «Открыть сессию здесь». Отказываем ДО resolve и говорим, чего не
  // хватает: перечислить шары сервера мы всё равно не умеем (для этого нужен
  // не readdir, а обход сети).
  const bare = dirPath.trim().replace(/\//g, '\\');
  if (/^\\{2,}[^\\]+\\*$/.test(bare)) {
    return empty('укажите имя шары: \\\\сервер\\шара — список шар сервера кокпит не показывает');
  }

  const abs = path.resolve(dirPath);
  let got;
  try {
    got = await guardedReaddir({ gate, abs, readdir, timeoutMs, netLimit, diskLimit });
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
  if (got.timedOut) return empty(`папка не отвечает (нет ответа за ${forHumans(timeoutMs)})`);
  // А это и вовсе не про эту папку: до чтения не дошло.
  if (got.busy) return empty(got.busy);

  const entries = got.raw
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
// Набор дисков меняется редко (флешку втыкают не каждую секунду), а обзор
// спрашивает его на каждую навигацию — кэша хватает, чтобы переходы по папкам
// вообще перестали трогать файловую систему. hung — буквы, чья проба брошена
// по таймауту и всё ещё висит в пуле.
const DRIVES_CACHE_MS = 30000;
const driveState = { cache: null, hung: new Set() };

// Пробы асинхронные по той же причине, что и listDir: existsSync на букве
// отключённого сетевого диска или пустого картридера замораживал весь главный
// процесс — только теперь на ровном месте, без всякого ввода от человека.
async function listDrives({
  timeoutMs = DRIVES_TIMEOUT_MS,
  probe = canOpen,
  concurrency = DRIVE_PROBE_CONCURRENCY,
  drives = driveState,
  now = Date.now,
  ttlMs = DRIVES_CACHE_MS,
} = {}) {
  // I-2 финального ре-ревью. Обзор зовёт этот список на КАЖДУЮ навигацию, а
  // проба по таймауту БРОСАЕТСЯ: слот отпускается, но операция висит в пуле
  // libuv до конца SMB (~21 с). Потоков четыре, и замер показал: три брошенные
  // безвредны, четвёртая вешает живое локальное чтение на 20 секунд. То есть
  // одной отвалившейся сетевой буквы и четырёх переходов по папкам хватало,
  // чтобы вернуть заморозку целиком — без единого сетевого пути от человека.
  //
  // Лечим с двух сторон: набор дисков меняется редко, поэтому короткий кэш
  // (навигации перестают трогать файловую систему вовсе), и буква, чья
  // прошлая проба ещё висит, повторно не пробуется — именно так брошенные
  // операции и копились.
  if (drives.cache && now() - drives.cache.at < ttlMs) return drives.cache.list;
  // Состояние может прийти частичным (в тестах — намеренно): достраиваем, а не
  // падаем. Набор висящих букв обязан быть общим между вызовами, иначе вся
  // защита от повторной пробы теряет смысл.
  if (!drives.hung) drives.hung = new Set();

  const letters = [];
  for (let code = 'A'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code += 1) {
    letters.push(`${String.fromCharCode(code)}:\\`);
  }
  const found = new Array(letters.length).fill(null);
  let next = 0;
  // Пробы идут ПАЧКАМИ, а не все 26 разом (и уж точно не по одной:
  // последовательный перебор с таймаутом на каждую в худшем случае стоил бы 26
  // таймаутов подряд). Разом было хуже, чем кажется: буква, отправленная в
  // пул, где все потоки заняты, тратила свои полторы секунды СТОЯ В ОЧЕРЕДИ и
  // выбывала из списка, ни разу не проверившись, — так живая C: и пропала из
  // замера. Здесь отсчёт начинается на строке probe() ниже, то есть с момента
  // старта самой пробы.
  const worker = async () => {
    for (;;) {
      const i = next;
      if (i >= letters.length) return;
      next += 1;
      // Её прошлая проба всё ещё держит поток пула — второй такой же ничего не
      // узнает, только отнимет ещё один поток у остального приложения.
      if (drives.hung.has(letters[i])) continue;
      try {
        const started = probe(letters[i]);
        const ok = await withTimeout(started, timeoutMs);
        if (ok === TIMED_OUT) {
          // Бросаем — но помним, что бросили, и снимаем отметку, когда проба
          // наконец завершится сама.
          drives.hung.add(letters[i]);
          const forget = () => drives.hung.delete(letters[i]);
          Promise.resolve(started).then(forget, forget);
        }
        // TIMED_OUT — это Symbol, он истинный: сравнивать надо с ним самим, иначе
        // не ответившая буква попала бы в список как существующая.
        if (ok !== TIMED_OUT && ok) found[i] = letters[i];
      } catch {
        // нет диска или он не отвечает — просто не показываем
      }
      // Слот занимает следующая буква, даже если предыдущая ещё висит в пуле:
      // одна мёртвая буква не имеет права спрятать все остальные (в отличие от
      // listDir, где висящий слот держится до конца, — там цена ошибки выше:
      // путь произвольный и приходит от клиента, а букв всего 26 и они свои).
    }
  };
  const size = Math.max(1, Math.min(concurrency, letters.length));
  await Promise.all(Array.from({ length: size }, () => worker()));
  const list = found.filter(Boolean);
  drives.cache = { at: now(), list };
  return list;
}

module.exports = {
  listDir, listDrives, createGate,
  DEFAULT_LIMIT, DEFAULT_TIMEOUT_MS, DRIVES_TIMEOUT_MS,
  MAX_NET_READS, MAX_DISK_READS, DRIVE_PROBE_CONCURRENCY,
};
