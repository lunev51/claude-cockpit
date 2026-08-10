'use strict';
// Индекс и поиск по транскриптам сессий (Phase 7, Task 2). Модуль ЧИСТЫЙ:
// перечисление проектов (`listProjects`), стат файла (`stat`), потоковое
// чтение строк (`readFileLines`), персистентный кэш (`cache`) и время
// (`now`) — только инжектируются. Никакого fs/electron/path здесь — реальные
// реализации этих функций собирает вызывающий код (ipc.js, Task 3).
//
// Формат транскрипта (снято живьём на этой машине 28.07.2026, см.
// task-2-report.md за урезанными образцами): один JSON-объект на строку.
// Полезные для нас типы записей:
//   {"type":"user","message":{"role":"user","content":"текст"|[...]},
//    "cwd":"C:\\...", ...}                     — сообщение пользователя
//   {"type":"assistant","message":{"role":"assistant","content":[...]}}
//                                                — сообщение ассистента
//   content-массив — список блоков {type:'text',text:'...'} и разного шума
//   (tool_use/tool_result/thinking/tool_reference) — берём только text-блоки.
// ВАЖНО: "user"-запись не всегда несёт текст человека — Claude Code хранит
// результаты инструментов КАК user-роль (content = [{type:'tool_result',...}]
// без текстового блока). Такая запись не считается «первым сообщением
// пользователя» — ищем следующую.
// Много другого мусора (queue-operation/mode/permission-mode/attachment/
// summary/last-prompt/битые строки) — просто игнорируется.
//
// Инкрементальность: индекс — Map<filePath, entry>, персистится на диск как
// {schemaVersion, builtAt, entries:[...]}. Файл считается «не изменившимся»,
// если и mtime, и size совпадают с прошлым разом, — тогда readFileLines()
// для него вовсе не вызывается (см. отдельный тест на подсчёт вызовов).
// Несовпадение schemaVersion трактуется как «кэша нет» — обычная ветка
// «нет записи под этим filePath» и без спецкода даёт полный пересбор.
//
// Устойчивость (см. бриф): битая строка JSONL — пропустить строку, не файл;
// исчезнувший файл (stat/readFileLines бросили) — пропустить файл целиком;
// пустой запрос → []; ничего не бросаем наружу ни из refresh(), ни из
// search() — на неожиданный сбой откатываемся на пустой/прежний результат.

const SCHEMA_VERSION = 1;
const FIRST_USER_TEXT_MAX = 200;
// Окно сниппета вокруг первого совпадения: не заданы брифом буквально —
// собственный выбор (см. отчёт), подобран для читаемого фрагмента строки.
const SNIPPET_RADIUS = 60;
const SNIPPET_MAX = 200;

function truncate(s, max) {
  if (typeof s !== 'string') return '';
  return s.length > max ? s.slice(0, max) : s;
}

// Текстовый блок content-массива → строка ('' для нетекстовых блоков вроде
// tool_use/tool_result/thinking/tool_reference — их намеренно не индексируем).
function blockText(block) {
  if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
    return block.text;
  }
  return '';
}

// «Отображаемый» текст записи: для user/assistant — либо строка content
// целиком, либо конкатенация text-блоков content-массива. Для всех прочих
// типов записей (queue-operation, mode, attachment, ...) — '' (нет текста).
function extractRecordText(record) {
  if (!record || typeof record !== 'object') return '';
  if (record.type !== 'user' && record.type !== 'assistant') return '';
  const msg = record.message;
  if (!msg || typeof msg !== 'object') return '';
  const content = msg.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(blockText).filter(Boolean).join(' ');
  }
  return '';
}

function isUserRecord(record) {
  return !!record && typeof record === 'object' && record.type === 'user'
    && !!record.message && typeof record.message === 'object' && record.message.role === 'user';
}

// Аккуратный парс одной строки JSONL: битая строка → null, не бросаем.
function tryParseLine(line) {
  if (typeof line !== 'string' || !line.trim()) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

// Кэш валиден, только если форма реально совпадает (см. usage-ccusage.js —
// тот же принцип: не просто «поле есть», а корректные типы у каждой записи).
function isGoodEntryShape(e) {
  return !!e && typeof e === 'object'
    && typeof e.filePath === 'string'
    && typeof e.sessionId === 'string'
    && typeof e.projectDir === 'string'
    && (typeof e.cwd === 'string' || e.cwd === null)
    && typeof e.mtime === 'number'
    && typeof e.size === 'number'
    && typeof e.firstUserText === 'string';
}

function isGoodCacheShape(c) {
  return !!c && typeof c === 'object'
    && c.schemaVersion === SCHEMA_VERSION
    && Array.isArray(c.entries)
    && c.entries.every(isGoodEntryShape);
}

function publicEntry(e) {
  return {
    sessionId: e.sessionId,
    projectDir: e.projectDir,
    cwd: e.cwd,
    mtime: e.mtime,
    size: e.size,
    firstUserText: e.firstUserText,
  };
}

// readFileLines(filePath) может вернуть асинхронный генератор/итерируемое
// НАПРЯМУЮ (обычный случай) или Promise, резолвящийся в итерируемое, — await
// на не-Promise просто возвращает значение как есть, так что оба варианта
// работают одинаково.
async function openLines(readFileLines, filePath) {
  return await readFileLines(filePath);
}

function mergeRanges(ranges) {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  const out = [sorted[0].slice()];
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i];
    const last = out[out.length - 1];
    if (s <= last[1]) {
      if (e > last[1]) last[1] = e;
    } else {
      out.push([s, e]);
    }
  }
  return out;
}

// Ищет ВСЕ вхождения ВСЕХ слов (регистронезависимо) в тексте записи и
// строит сниппет ±SNIPPET_RADIUS вокруг первого совпадения, длиной до
// SNIPPET_MAX символов; ranges — позиции ВНУТРИ snippet.text (не всего
// text), как того требует контракт. null, если совпадений вообще нет
// (сюда попадаем, только если вызывающий уже проверил "все слова есть" —
// see search() ниже — так что на практике всегда непусто).
function buildSnippet(text, words) {
  const lowerText = text.toLowerCase();
  let ranges = [];
  for (const w of words) {
    if (!w) continue;
    let idx = lowerText.indexOf(w);
    while (idx !== -1) {
      ranges.push([idx, idx + w.length]);
      idx = lowerText.indexOf(w, idx + 1);
    }
  }
  if (ranges.length === 0) return null;
  ranges = mergeRanges(ranges);

  const firstStart = ranges[0][0];
  let start = Math.max(0, firstStart - SNIPPET_RADIUS);
  let end = Math.min(text.length, start + SNIPPET_MAX);
  if (end - start < SNIPPET_MAX) start = Math.max(0, end - SNIPPET_MAX);

  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  const snippetText = prefix + text.slice(start, end) + suffix;

  const shifted = ranges
    .filter(([s, e]) => s >= start && e <= end)
    .map(([s, e]) => [s - start + prefix.length, e - start + prefix.length]);

  return { text: snippetText, ranges: shifted };
}

function createHistoryIndex({
  listProjects, readFileLines, stat, cache, now = Date.now, maxResults = 50,
  // Потолок просмотренных сессий за ОДИН поиск (ревью 09.08, B10). Кэш хранит
  // только firstUserText, поэтому каждый запрос заново стримит транскрипты с
  // диска, а останов был единственный — набралось maxResults попаданий. Запрос
  // без совпадений («опечатка», редкое слово) читал весь индекс целиком.
  //
  // Про объём — точность важна, потому что она определяет цену: индекс
  // намеренно НЕ рекурсивный (listProjects берёт только верхний уровень), так
  // что суб-агентские транскрипты — а их на порядок больше — сюда не входят
  // никогда. На машине владельца это сегодня 49 файлов, и потолок в 400 не
  // срабатывает вовсе: он задел на будущее, а реальную экономию даёт отмена
  // устаревшего прохода выше.
  //
  // Записи отсортированы по свежести, так что режется самый старый хвост, и об
  // этом честно сообщается наружу (см. scannedOf в search и конверт в ipc.js).
  scanCap = 400,
}) {
  // Map<filePath, {filePath, sessionId, projectDir, cwd, mtime, size, firstUserText}>
  let entriesMap = new Map();
  let sortedEntries = []; // те же значения entriesMap, отсортированные по mtime убыв. — порядок выдачи refresh()/search()
  let loadedFromDisk = false;
  // Номер последнего начатого поиска: проход сверяется с ним между файлами и
  // бросает работу, если его обогнал более свежий запрос.
  let searchGen = 0;

  // Ленивая загрузка диск-кэша (один раз за жизнь инстанса) — тот же приём,
  // что в usage-ccusage.js/usage-oauth.js: позволяет search() отработать
  // сразу после создания инстанса, даже до первого явного refresh().
  function ensureLoaded() {
    if (loadedFromDisk) return;
    loadedFromDisk = true;
    let cached = null;
    try {
      cached = cache.read();
    } catch {
      cached = null; // диск недоступен/битый — трактуем как «нет кэша»
    }
    if (isGoodCacheShape(cached)) {
      for (const e of cached.entries) entriesMap.set(e.filePath, e);
      resort();
    }
  }

  function resort() {
    sortedEntries = [...entriesMap.values()].sort((a, b) => b.mtime - a.mtime);
  }

  async function refresh(opts = {}) {
    const force = !!(opts && opts.force);
    try {
      ensureLoaded();

      let projects;
      try {
        projects = await listProjects();
      } catch {
        // listProjects() недоступен — деградируем на текущий (возможно,
        // загруженный из кэша) индекс, не роняя refresh().
        return sortedEntries.map(publicEntry);
      }
      const list = Array.isArray(projects) ? projects : [];

      const nextMap = new Map();
      for (const p of list) {
        if (!p || typeof p.filePath !== 'string' || typeof p.sessionId !== 'string' || typeof p.projectDir !== 'string') {
          continue; // некорректный дескриптор от listProjects() — пропускаем
        }
        const filePath = p.filePath;

        let st;
        try {
          st = await stat(filePath);
        } catch {
          continue; // файл исчез — пропустить
        }
        if (!st || typeof st.mtimeMs !== 'number' || typeof st.size !== 'number') continue;

        const cached = !force ? entriesMap.get(filePath) : null;
        if (cached && cached.mtime === st.mtimeMs && cached.size === st.size) {
          nextMap.set(filePath, cached); // не изменился — берём из кэша, readFileLines НЕ зовём
          continue;
        }

        let cwd = null;
        let firstUserText = '';
        try {
          const it = await openLines(readFileLines, filePath);
          for await (const rawLine of it) {
            const obj = tryParseLine(rawLine);
            if (obj === null) continue; // битая строка — пропустить строку
            if (cwd === null && typeof obj.cwd === 'string' && obj.cwd) cwd = obj.cwd;
            if (!firstUserText && isUserRecord(obj)) {
              const t = extractRecordText(obj).trim();
              if (t) firstUserText = truncate(t, FIRST_USER_TEXT_MAX);
            }
            if (cwd !== null && firstUserText) break; // нашли всё нужное — не читаем файл дальше
          }
        } catch {
          continue; // файл исчез/недоступен во время чтения — пропустить файл целиком
        }

        nextMap.set(filePath, {
          filePath,
          sessionId: p.sessionId,
          projectDir: p.projectDir,
          cwd,
          mtime: st.mtimeMs,
          size: st.size,
          firstUserText,
        });
      }

      entriesMap = nextMap;
      resort();

      try {
        cache.write({ schemaVersion: SCHEMA_VERSION, builtAt: now(), entries: sortedEntries });
      } catch {
        // запись кэша упала — не критично, отдаём свежепостроенный индекс всё равно
      }

      return sortedEntries.map(publicEntry);
    } catch {
      // непредвиденный сбой — никогда не бросаем наружу
      return sortedEntries.map(publicEntry);
    }
  }

  async function search(query, opts = {}) {
    // Поколение запроса (ревью 09.08, B10). Кэш хранит только firstUserText,
    // поэтому КАЖДЫЙ поиск заново стримит транскрипты с диска. Отмены не было:
    // человек уточняет запрос в открытом оверлее — дебаунс в renderer гасит
    // только ещё не отправленный таймер, а уже улетевший проход дочитывает
    // хранилище до конца впустую. Два-три уточнения подряд = два-три
    // ПАРАЛЛЕЛЬНЫХ полных обхода диска и пула libuv (собственный замер
    // проекта: history:search 17.8 с при занятом пуле).
    //
    // Новый запрос обесценивает старый: тот бросает работу на ближайшей
    // границе файла.
    const gen = searchGen + 1;
    searchGen = gen;
    try {
      ensureLoaded();

      const q = typeof query === 'string' ? query.trim() : '';
      if (!q) return [];
      const words = q.toLowerCase().split(/\s+/).filter(Boolean);
      if (words.length === 0) return [];

      const limit = opts && Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : maxResults;

      const results = [];
      let scanned = 0;
      for (const entry of sortedEntries) {
        if (results.length >= limit) break;
        // Нас обогнал более свежий запрос — его ответ и нужен человеку.
        if (gen !== searchGen) return [];
        // Потолок просмотренных сессий: запрос БЕЗ совпадений иначе читает всё
        // хранилище целиком (на этой машине ~1.7 ГБ транскриптов). Записи
        // отсортированы по свежести, так что потолок режет самый старый хвост
        // — и об этом честно сообщается наружу (см. truncated ниже).
        if (scanned >= scanCap) break;
        scanned += 1;

        let hit = null;
        try {
          const it = await openLines(readFileLines, entry.filePath);
          let lineNo = 0;
          for await (const rawLine of it) {
            lineNo += 1;
            const obj = tryParseLine(rawLine);
            if (obj === null) continue; // битая строка — пропустить строку
            const text = extractRecordText(obj);
            if (!text) continue;
            const lowerText = text.toLowerCase();
            if (!words.every((w) => lowerText.includes(w))) continue;
            const snippet = buildSnippet(text, words);
            if (!snippet) continue;
            hit = { line: lineNo, snippet };
            break; // первое совпадение в файле — этой сессии достаточно одного результата
          }
        } catch {
          continue; // файл исчез/недоступен между refresh() и search() — пропустить сессию
        }

        if (hit) {
          results.push({
            sessionId: entry.sessionId,
            cwd: entry.cwd,
            mtime: entry.mtime,
            firstUserText: entry.firstUserText,
            snippet: hit.snippet,
            line: hit.line,
          });
        }
      }
      // Сколько сессий осталось непросмотренными — знает только этот цикл.
      // Прячем результат в свойство массива, а не меняем его на объект:
      // контракт «search возвращает список найденного» держат и вызывающий, и
      // десяток тестов, и ломать его ради одного числа неразумно. Свойство
      // необязательное: кто про него не знает, работает как раньше.
      if (scanned >= scanCap && sortedEntries.length > scanned) {
        Object.defineProperty(results, 'scannedOf', {
          value: { scanned, total: sortedEntries.length },
          enumerable: false,
        });
      }
      return results;
    } catch {
      return [];
    }
  }

  return { refresh, search };
}

module.exports = { createHistoryIndex };
