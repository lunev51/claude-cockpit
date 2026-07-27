'use strict';
// Извлекает варианты-кнопки из текста вопроса Claude (peek-поповер, Phase 4
// Task 3): строки вида «1. …», «2) …», «[3] …» → [{digit, label}]. Чистая
// функция без DOM — тестируется отдельно (test/peek-parse.test.js) без
// живого renderer/Electron.

const MAX_OPTIONS = 9;
const MAX_LABEL = 80;

// `\s+` СРАЗУ после маркера — ключевое условие: у «1.5 секунды» после «1.»
// идёт цифра «5», не пробел, поэтому строка не совпадёт (это дробное число,
// а не пункт списка). Однозначные номера (1–9) — «10. …» и выше маркером не
// считаются (см. бриф: не более 9 вариантов, Claude нумерует 1–9).
const OPTION_LINE_RE = /^\s*(?:(\d)[.)]|\[(\d)\])\s+(.+?)\s*$/;

export function parseOptions(text) {
  const options = [];
  const lines = String(text ?? '').split(/\r?\n/);
  for (const line of lines) {
    const m = OPTION_LINE_RE.exec(line);
    if (!m) continue;
    const digit = m[1] ?? m[2];
    let label = m[3];
    if (label.length > MAX_LABEL) label = label.slice(0, MAX_LABEL);
    options.push({ digit, label });
    if (options.length >= MAX_OPTIONS) break;
  }
  return options;
}
