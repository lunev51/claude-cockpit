'use strict';
// «Название» сессии для сайдбара (живая приёмка 01.08: «в одной папке может
// быть несколько сессий, чтобы их различить»).
//
// ИСТОЧНИК — запись ai-title в транскрипте сессии:
//   {"type":"ai-title","aiTitle":"Организовать папку Акто","sessionId":"…"}
// Это тот самый автозаголовок, который Claude Code показывает в своём UI.
//
// ПОЧЕМУ НЕ session_title ИЗ ХУКА (ревью 01.08 опровергло первую версию
// фичи экспериментом): поле session_title в payload хуков отдаёт ТОЛЬКО
// пользовательское имя из `/rename` (`currentSessionTitle`), а не
// автозаголовок (`currentSessionAiTitle`) — CLI показывает в UI второе, а
// хукам шлёт первое. На данных пользователя: ai-title есть у 41 сессии из
// 48, custom-title — у 3. То есть ~94% сессий через хук не подписались бы
// НИКОГДА, включая главный сценарий «утренние --resume вкладки».
//
// ПОЧЕМУ ТОЛЬКО ПРЕФИКС ФАЙЛА (замер на реальных данных): транскрипт бывает
// огромным (226 МБ у пользователя), и ai-title в нём дублируется на каждом
// чекпоинте (557 вхождений — с ОДИНАКОВЫМ текстом, заголовок не «плывёт»).
// Первое вхождение при этом лежит в самом начале (строка 9 из 8792).
// Поэтому читаем ограниченный префикс и берём ПЕРВОЕ вхождение: полное
// чтение дало бы тот же ответ ценой сотен мегабайт дискового ввода — ровно
// того, что уже вешало машину на 8ГБ ОЗУ (см. инцидент ccusage).

// Сколько байт от начала транскрипта просматриваем. ai-title появляется
// после первого обмена — это первые килобайты; 256 КБ дают кратный запас
// даже на длинные системные преамбулы и вставленные файлы.
const PREFIX_BYTES = 256 * 1024;

// Максимальная длина метки — как в сайдбаре (одна строка, обрезка с «…»).
const TITLE_MAX = 48;

function truncateTitle(text) {
  const squashed = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!squashed) return '';
  return squashed.length > TITLE_MAX ? `${squashed.slice(0, TITLE_MAX - 1)}…` : squashed;
}

// Чистый парсер: текст префикса JSONL → заголовок или ''. Никогда не бросает
// (транскрипт — внутренний формат CLI, меняется между версиями; битая строка
// или незнакомая схема должны просто не дать метки, а не уронить вкладку).
function parseAiTitle(prefixText) {
  if (typeof prefixText !== 'string' || !prefixText) return '';
  const lines = prefixText.split('\n');
  // Последняя строка префикса почти наверняка обрезана посередине — её
  // отбрасываем, чтобы не ловить JSON.parse на половине записи.
  for (let i = 0; i < lines.length - 1; i += 1) {
    const line = lines[i];
    // Дешёвый предфильтр: не парсим JSON у 99% строк (сообщения диалога).
    if (!line || line.indexOf('"ai-title"') === -1) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // битая/обрезанная строка — не наша забота
    }
    if (rec && rec.type === 'ai-title') {
      const title = truncateTitle(rec.aiTitle);
      if (title) return title;
    }
  }
  return '';
}

// readPrefix(path, maxBytes) → Promise<string> — инжектируемое чтение начала
// файла (в проде — fs.createReadStream с ограничением, см. ipc.js). Должно
// резолвиться пустой строкой на любой сбой (нет файла/нет прав), а не
// реджектить: отсутствие метки — нормальное состояние, не ошибка.
function createSessionTitleReader({ readPrefix, prefixBytes = PREFIX_BYTES }) {
  async function read(transcriptPath) {
    if (typeof transcriptPath !== 'string' || !transcriptPath) return '';
    let text = '';
    try {
      text = await readPrefix(transcriptPath, prefixBytes);
    } catch {
      return ''; // сбой чтения — просто нет метки
    }
    return parseAiTitle(text);
  }
  return { read };
}

module.exports = {
  createSessionTitleReader, parseAiTitle, truncateTitle, PREFIX_BYTES, TITLE_MAX,
};
