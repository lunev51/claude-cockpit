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
// Хвост файла — под custom-title (6× запаса над наблюдаемым максимумом 10 КБ).
const SUFFIX_BYTES = 64 * 1024;

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
// sessionId: если запись его несёт и он НЕ наш — запись чужая (после
// `--resume`/fork в файле встречаются записи других сессий), пропускаем.
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

module.exports = {
  createSessionTitleReader,
  parseAiTitle,
  parseCustomTitle,
  truncateTitle,
  PREFIX_BYTES,
  SUFFIX_BYTES,
  TITLE_MAX,
};
