'use strict';
// «Название» сессии для сайдбара (живая приёмка 01.08: «в одной папке может
// быть несколько сессий, чтобы их различить»).
//
// ДВА ИСТОЧНИКА в транскрипте, в порядке приоритета (запрос пользователя
// 01.08: «если есть моё имя сессии — писалось оно, а если нету — то что даёт
// сам Claude»):
//   1) {"type":"custom-title","customTitle":"…","sessionId":"…"} — имя,
//      заданное командой `/rename`. Приоритетнее: это осознанный выбор
//      человека, он же виден в `/resume`.
//   2) {"type":"ai-title","aiTitle":"…","sessionId":"…"} — автозаголовок
//      Claude Code (тот, что показывает его UI).
//
// ПОЧЕМУ НЕ session_title ИЗ ХУКА (ревью 01.08 опровергло первую версию
// фичи экспериментом): поле session_title в payload хуков отдаёт ТОЛЬКО
// custom-title, а автозаголовок — никогда. На данных пользователя ai-title
// есть у 41 сессии из 48, custom-title — у 3: ~94% сессий через хук не
// подписались бы вовсе.
//
// ГДЕ ИСКАТЬ (замеры на реальных транскриптах — источники лежат в РАЗНЫХ
// концах файла, поэтому читаются двумя кусками):
//   • ai-title — в НАЧАЛЕ (генерируется после первого обмена: строка 9 из
//     8792 в 226-мегабайтном файле). Дублируется на чекпоинтах сотнями
//     одинаковых записей, поэтому берём ПЕРВОЕ вхождение.
//   • custom-title — в КОНЦЕ (дописывается в момент `/rename`: замеры дали
//     0, 8 и 10 КБ от конца файла). Переименовать можно несколько раз (в
//     одном файле пользователя их два), поэтому берём ПОСЛЕДНЕЕ вхождение.
// Полное чтение не годится принципиально: 226 МБ на вкладку — ровно тот
// дисковый шторм, который уже вешал машину на 8 ГБ ОЗУ (инцидент ccusage).

// Начало файла — под ai-title (5× запаса над наблюдаемым максимумом 51 КБ).
const PREFIX_BYTES = 256 * 1024;
// Хвост файла — под custom-title.
//
// Important 1 (ревью): 64 КБ было выбрано по НЕ ТОЙ величине — по расстоянию
// последней копии от конца файла (0-10 КБ в замерах). Ограничивает же нас
// ИНТЕРВАЛ МЕЖДУ копиями: custom-title переиздаётся на каждом чекпоинте
// (43 копии в 236-МБ файле), и замеренные максимальные интервалы — 88 133 и
// 89 640 байт. То есть существуют окна жизни файла, когда последняя копия
// оказывается за пределами 64-килобайтного хвоста, и вкладка молча
// показывает автозаголовок вместо имени пользователя. 256 КБ перекрывают
// наблюдаемый интервал почти втрое; цена — 512 КБ чтения на сессию вместо
// 320 КБ, на фоне 226-МБ транскриптов это шум.
const SUFFIX_BYTES = 256 * 1024;

// Максимальная длина метки — как в сайдбаре (одна строка, обрезка с «…»).
const TITLE_MAX = 48;

function truncateTitle(text) {
  const squashed = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!squashed) return '';
  return squashed.length > TITLE_MAX ? `${squashed.slice(0, TITLE_MAX - 1)}…` : squashed;
}

// Разбор одной строки JSONL в запись нужного типа. Никогда не бросает:
// транскрипт — внутренний формат CLI, он меняется между версиями, а битая
// или обрезанная границей чтения строка должна просто не дать метки.
// sessionId: страховка на случай, если в файле окажется запись ЧУЖОЙ сессии
// (гипотетический fork с копированием истории). Minor 3 ревью: на реальных
// данных таких записей нет — `--resume` дописывает тот же файл с тем же id
// (236-МБ транскрипт за полтора месяца содержит ровно один sessionId), так
// что это именно страховка, а не решение наблюдаемой проблемы. Запись БЕЗ
// sessionId принимается всегда — иначе страховка съела бы имя пользователя.
function pickTitle(line, type, field, sessionId) {
  if (!line || line.indexOf(`"${type}"`) === -1) return '';
  let rec;
  try {
    rec = JSON.parse(line);
  } catch {
    return '';
  }
  if (!rec || rec.type !== type) return '';
  if (sessionId && rec.sessionId && rec.sessionId !== sessionId) return '';
  return truncateTitle(rec[field]);
}

// Первое вхождение ai-title в тексте начала файла.
// Последняя строка куска отбрасывается — она почти наверняка обрезана
// границей чтения, и JSON.parse увидел бы половину записи.
function parseAiTitle(prefixText, sessionId) {
  if (typeof prefixText !== 'string' || !prefixText) return '';
  const lines = prefixText.split('\n');
  for (let i = 0; i < lines.length - 1; i += 1) {
    const title = pickTitle(lines[i], 'ai-title', 'aiTitle', sessionId);
    if (title) return title;
  }
  return '';
}

// ПОСЛЕДНЕЕ вхождение custom-title в тексте конца файла (переименований
// может быть несколько — актуально самое свежее). Здесь отбрасывается
// ПЕРВАЯ строка: обрезана та, что на границе чтения, а конец файла — целый.
function parseCustomTitle(suffixText, sessionId) {
  if (typeof suffixText !== 'string' || !suffixText) return '';
  const lines = suffixText.split('\n');
  for (let i = lines.length - 1; i >= 1; i -= 1) {
    const title = pickTitle(lines[i], 'custom-title', 'customTitle', sessionId);
    if (title) return title;
  }
  return '';
}

// readParts(path, prefixBytes, suffixBytes) → Promise<{prefix, suffix}> —
// инжектируемое чтение НАЧАЛА и КОНЦА файла (в проде — fs.stat + два
// fs.read, см. ipc.js). Контракт: резолвится {prefix:'', suffix:''} на любой
// сбой (нет файла/нет прав), а НЕ реджектит — отсутствие метки нормальное
// состояние, не ошибка. Если файл целиком меньше запрошенного префикса,
// реализация вправе вернуть его весь в prefix, а suffix оставить пустым:
// парсер custom-title в таком случае вызывается по префиксу (см. read()).
function createSessionTitleReader({
  readParts, prefixBytes = PREFIX_BYTES, suffixBytes = SUFFIX_BYTES,
}) {
  async function read(transcriptPath, sessionId) {
    if (typeof transcriptPath !== 'string' || !transcriptPath) return '';
    let parts;
    try {
      parts = await readParts(transcriptPath, prefixBytes, suffixBytes);
    } catch {
      return ''; // сбой чтения — просто нет метки
    }
    const prefix = (parts && parts.prefix) || '';
    const suffix = (parts && parts.suffix) || '';
    // Имя пользователя (`/rename`) приоритетнее автозаголовка. Ищем в хвосте,
    // а если хвоста нет (короткий файл прочитан целиком в prefix) — в нём же.
    const custom = parseCustomTitle(suffix, sessionId)
      || (suffix ? '' : parseCustomTitle(`\n${prefix}`, sessionId));
    if (custom) return custom;
    return parseAiTitle(prefix, sessionId);
  }
  return { read };
}

// Реальная реализация readParts поверх инжектируемого fs — живёт ЗДЕСЬ, а не
// в ipc.js (Minor 1 ревью: там она была недостижима для тестов, и именно в
// ней пряталась дыра «мёртвого окна» размеров). fs инжектируется, так что
// модуль остаётся чистым, а тест гоняет её на настоящем временном файле.
//
// Читает НАЧАЛО (ai-title) и КОНЕЦ (custom-title) файла двумя fs.read в
// буферы фиксированного размера. Никогда не реджектит — сбой любой стадии
// даёт {prefix:'', suffix:''} (отсутствие метки — нормальное состояние).
function createFsReadParts(fs) {
  function readChunk(fd, length, position) {
    return new Promise((resolve) => {
      if (length <= 0) { resolve(''); return; }
      const buf = Buffer.allocUnsafe(length);
      fs.read(fd, buf, 0, length, position, (err, bytesRead) => {
        resolve(err ? '' : buf.toString('utf8', 0, bytesRead));
      });
    });
  }

  return function readParts(filePath, prefixBytes, suffixBytes) {
    return new Promise((resolve) => {
      const empty = { prefix: '', suffix: '' };
      fs.stat(filePath, (statErr, st) => {
        if (statErr || !st || !st.isFile()) { resolve(empty); return; }
        fs.open(filePath, 'r', async (openErr, fd) => {
          if (openErr) { resolve(empty); return; }
          try {
            const { size } = st;
            const prefix = await readChunk(fd, Math.min(prefixBytes, size), 0);
            // Critical 1 (ревью): раньше условие было `size - suffixBytes >
            // prefixBytes`, из-за чего у файлов размером (256 КБ, 320 КБ]
            // хвост не читался ВООБЩЕ, а префикс их не покрывал — байты между
            // 256 КБ и концом файла не читал никто. `/rename` в этой полосе
            // терялся, а при двух переименованиях показывалось СТАРОЕ имя
            // (ранние копии записи лежат в префиксе, свежие — в дыре).
            // Теперь хвост начинается не раньше конца префикса, но читается
            // всегда, когда файл длиннее префикса — дыры не остаётся.
            const suffixStart = Math.max(prefixBytes, size - suffixBytes);
            const suffix = size > prefixBytes
              ? await readChunk(fd, size - suffixStart, suffixStart)
              : '';
            resolve({ prefix, suffix });
          } catch {
            resolve(empty);
          } finally {
            fs.close(fd, () => {});
          }
        });
      });
    });
  };
}

module.exports = {
  createSessionTitleReader,
  createFsReadParts,
  parseAiTitle,
  parseCustomTitle,
  truncateTitle,
  PREFIX_BYTES,
  SUFFIX_BYTES,
  TITLE_MAX,
};
