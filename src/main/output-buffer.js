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

function createOutputBuffer({ maxBytes = DEFAULT_MAX } = {}) {
  const buffers = new Map(); // tabId → string

  // Режем по СИМВОЛАМ с конца, а не по байтам: наивная байтовая резка
  // разрывает кириллицу пополам, и первая строка на экране макбука
  // встречает человека символом замены.
  function trimToBytes(text, limit) {
    if (Buffer.byteLength(text, 'utf8') <= limit) return text;
    let start = Math.max(0, text.length - limit);
    while (start < text.length && Buffer.byteLength(text.slice(start), 'utf8') > limit) start += 1;
    return text.slice(start);
  }

  return {
    push(tabId, data) {
      if (!tabId || typeof data !== 'string' || !data) return;
      buffers.set(tabId, trimToBytes((buffers.get(tabId) || '') + data, maxBytes));
    },
    get: (tabId) => buffers.get(tabId) || '',
    drop: (tabId) => { buffers.delete(tabId); },
    size: (tabId) => Buffer.byteLength(buffers.get(tabId) || '', 'utf8'),
    totalBytes: () => [...buffers.values()]
      .reduce((sum, text) => sum + Buffer.byteLength(text, 'utf8'), 0),
  };
}

module.exports = { createOutputBuffer };
