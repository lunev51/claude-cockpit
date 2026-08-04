'use strict';
// Хвост вывода каждой вкладки — то, что клиент увидит, подключившись.
//
// Зачем. main не хранит вывод pty вообще: история живёт в xterm внутри окна
// ПК. Клиент с макбука увидел бы пустой терминал и не понял бы, на чём
// остановилась работа, — то есть главный сценарий («встал из-за ПК, сел с
// макбука») не работал бы вовсе.
//
// Предел по байтам — условие жизни на 8 ГБ ОЗУ: вкладка, гоняющая тесты в
// цикле, иначе съела бы память за ночь. 256 КБ × 10 вкладок ≈ 2,5 МБ.
const DEFAULT_MAX = 256 * 1024;

// Число байт, которые кодовая точка займёт в UTF-8, — по правилу самого
// формата (границы 1/2/3/4-байтовых диапазонов), БЕЗ обращения к Buffer: на
// длинном выводе это считается на каждый символ, лишняя аллокация тут не нужна.
function utf8CodePointLength(codePoint) {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

// CRITICAL (ревью задачи 4): исходный вариант резал начало ПЕРЕСКАНИРОВАНИЕМ —
// на каждом шаге сдвига `start` заново звал Buffer.byteLength(text.slice(start))
// по всему хвосту. На не-ASCII выводе (кириллица, рамки TUI — Claude Code
// рисует их постоянно, даже когда человек пишет по-английски) text.length
// оказывается МЕНЬШЕ лимита в байтах, Math.max зажимал стартовую позицию в
// ноль, и цикл пересчитывал байты всё удлиняющегося хвоста посимвольно —
// O(n²). Замер ревью на заполненном 256-килобайтном буфере: 80 КБ вывода —
// 7,3 с, event loop стоял 7,27 с (главный процесс не рисует вкладки, не
// проходит IPC, не тикает ночная смена). Живой замер здесь (256×4 КБ
// реалистичного вывода — ASCII + рамки + кириллица, ~1 МБ): 37 821 мс —
// подробности и цифры «после» в task-4-report.md.
//
// Исправление — один проход С КОНЦА по кодовым ТОЧКАМ (не кодовым единицам
// UTF-16 — суррогатная пара эмодзи иначе рвётся пополам, Important 2 ревью:
// text.length считает суррогат отдельным символом, нужен codePointAt),
// вычитая размер каждой точки в байтах. O(число символов в итоговом хвосте),
// без единого Buffer.byteLength на подстроке.
function trimToBytesFromEnd(text, limit) {
  let bytes = 0;
  let start = text.length;
  let i = text.length;
  while (i > 0) {
    let code = text.charCodeAt(i - 1);
    let cpIndex = i - 1;
    // Низкий суррогат на позиции i-1 — проверяем, что НЕПОСРЕДСТВЕННО перед
    // ним стоит высокий: только тогда это настоящая пара (одна кодовая точка
    // вне BMP, например эмодзи). Одинокий суррогат (битый ввод) — берём как
    // есть, это уже «своя» кодовая точка длиной 3 байта по правилу UTF-8 для
    // непарных суррогатов.
    if (code >= 0xDC00 && code <= 0xDFFF && i - 2 >= 0) {
      const high = text.charCodeAt(i - 2);
      if (high >= 0xD800 && high <= 0xDBFF) {
        code = text.codePointAt(i - 2);
        cpIndex = i - 2;
      }
    }
    const len = utf8CodePointLength(code);
    if (bytes + len > limit) break; // ещё один символ не влезает — хвост найден
    bytes += len;
    start = cpIndex;
    i = cpIndex;
  }
  return { text: text.slice(start), bytes };
}

function createOutputBuffer({ maxBytes = DEFAULT_MAX } = {}) {
  // tabId → { text, bytes } — bytes кэшируется РЯДОМ с текстом, а не
  // пересчитывается Buffer.byteLength(text) на каждый push: иначе даже после
  // фикса Critical каждый push всё равно проходил бы ВЕСЬ накопленный буфер
  // целиком ради одной проверки «влезаем ли» — при частых мелких чанках от
  // pty (а pty шлёт их часто) это тот же класс проблемы с меньшим
  // показателем степени. push() ниже трогает байтовым счётом только НОВЫЙ
  // кусок; полный проход по буферу случается лишь когда лимит реально
  // превышен (trimToBytesFromEnd), и он один на push.
  const buffers = new Map();

  return {
    push(tabId, data) {
      if (!tabId || typeof data !== 'string' || !data) return;
      const prev = buffers.get(tabId) || { text: '', bytes: 0 };
      const text = prev.text + data;
      const bytes = prev.bytes + Buffer.byteLength(data, 'utf8'); // только новый кусок
      if (bytes <= maxBytes) {
        buffers.set(tabId, { text, bytes });
        return;
      }
      buffers.set(tabId, trimToBytesFromEnd(text, maxBytes));
    },
    get: (tabId) => (buffers.get(tabId) || { text: '' }).text,
    drop: (tabId) => { buffers.delete(tabId); },
    size: (tabId) => (buffers.get(tabId) || { bytes: 0 }).bytes,
    totalBytes: () => [...buffers.values()].reduce((sum, b) => sum + b.bytes, 0),
  };
}

module.exports = { createOutputBuffer };
