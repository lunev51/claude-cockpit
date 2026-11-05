'use strict';
// Первое скрытие окна за запуск объясняется — и крестиком тоже (ревью 09.08,
// C28). Комментарий у hideExplained обещал «первое скрытие объясняем», а
// объяснял только уход управления; крестик — самый частый путь — молчал.
//
// Решение живёт в hide-notice.js (чистый модуль), проводка — в main.js,
// который под node --test не поднимается (require('electron')); её держит
// страж по исходнику внизу.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createHideExplainer, HIDE_NOTICES } = require('../src/main/hide-notice');

function explainer({ supported = true } = {}) {
  const shown = [];
  const explainHide = createHideExplainer({
    canNotify: () => supported,
    notify: (n) => shown.push(n),
  });
  return { explainHide, shown };
}

test('крестик: первое скрытие объясняется своим текстом — сессии живы, выход через трей', () => {
  const { explainHide, shown } = explainer();
  explainHide('close');
  assert.deepStrictEqual(shown, [HIDE_NOTICES.close]);
  assert.match(HIDE_NOTICES.close.title, /трее/);
  assert.match(HIDE_NOTICES.close.body, /Сессии живы/);
  assert.match(HIDE_NOTICES.close.body, /«Выход»/, 'текст не говорит, как выйти совсем');
});

test('уход управления: прежний текст', () => {
  const { explainHide, shown } = explainer();
  explainHide('handoff');
  assert.deepStrictEqual(shown, [{
    title: 'Cockpit свёрнут в трей',
    body: 'Управление ушло на другую машину. Значок в трее вернёт окно.',
  }]);
});

test('объясняем один раз за запуск — каким бы путём ни было первое скрытие', () => {
  for (const [first, second] of [['close', 'handoff'], ['handoff', 'close'], ['close', 'close']]) {
    const { explainHide, shown } = explainer();
    explainHide(first);
    assert.strictEqual(explainHide(second), null, `${first} → ${second}: объяснили второй раз`);
    assert.deepStrictEqual(shown, [HIDE_NOTICES[first]]);
  }
});

test('без центра уведомлений — молчим; неизвестный путь — молчим и не тратит «первый раз»', () => {
  const none = explainer({ supported: false });
  assert.strictEqual(none.explainHide('close'), null);
  assert.deepStrictEqual(none.shown, []);

  const { explainHide, shown } = explainer();
  assert.strictEqual(explainHide('что-то-ещё'), null);
  explainHide('close');
  assert.deepStrictEqual(shown, [HIDE_NOTICES.close], 'неизвестный путь съел «первый раз»');
});

// I1 ревью ветки: explainHide зовётся из win.on('close') — точки входа без
// guarded(). Бросок оттуда уходит в uncaughtException → teardown() и
// app.exit(1): все pty умирают ради тоста. Поэтому сама не бросает никогда.
test('сбой центра уведомлений не вылетает из explainHide — ни в canNotify, ни в notify', () => {
  const warn = console.warn;
  const warned = [];
  console.warn = (...args) => warned.push(args.join(' '));
  try {
    const noCenter = createHideExplainer({
      canNotify: () => { throw new Error('нет центра уведомлений'); },
      notify: () => { throw new Error('notify НЕ должен был вызваться'); },
    });
    assert.doesNotThrow(() => noCenter('close'), 'бросок canNotify вылетел из explainHide');
    assert.strictEqual(noCenter('close'), null);
    assert.ok(warned.length >= 1, 'сбой canNotify проглочен молча — в консоли ни слова');
    warned.length = 0;

    let calls = 0;
    const brokenToast = createHideExplainer({
      canNotify: () => true,
      notify: () => { calls += 1; throw new Error('тост не показался'); },
    });
    assert.doesNotThrow(() => brokenToast('close'), 'бросок notify вылетел из explainHide');
    // Сломанный тост не повторяем на каждом крестике: «первый раз» потрачен.
    assert.doesNotThrow(() => brokenToast('handoff'));
    assert.strictEqual(calls, 1, 'сломанный notify дёргается на каждом скрытии');
    assert.strictEqual(warned.length, 1, 'сбой notify проглочен молча — в консоли ни слова');
  } finally {
    console.warn = warn;
  }
});

// --- проводка в main.js ---

const codeOnly = (source) => source
  .split(/\r?\n/)
  .filter((line) => !/^\s*\/\//.test(line))
  .map((line) => line.replace(/\s\/\/\s.*$/, ''))
  .join('\n');

const MAIN = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8'));

// Тело обработчика от якоря до первой строки с закрывающей «});» на том же
// отступе, что и сам якорь.
function block(anchor) {
  const start = MAIN.indexOf(anchor);
  assert.notStrictEqual(start, -1, `в main.js не найдено «${anchor}» — страж разъехался с исходником`);
  const lineStart = MAIN.lastIndexOf('\n', start) + 1;
  const indent = MAIN.slice(lineStart, start).match(/^\s*/)[0];
  const end = MAIN.indexOf(`\n${indent}});`, start);
  assert.notStrictEqual(end, -1, `не найден конец «${anchor}»`);
  return MAIN.slice(start, end);
}

test('main.js: крестик прячет окно И объясняет это', () => {
  const body = block("win.on('close', (e) => {");
  const hidden = body.match(/if \(!quitting\) \{([\s\S]*?)\n\s*\}/);
  assert.ok(hidden, 'в обработчике close не найдена ветка if (!quitting) — страж разъехался');
  assert.match(hidden[1], /win\.hide\(\);/, 'крестик больше не прячет окно');
  assert.match(hidden[1], /explainHide\('close'\);/, 'крестик прячет окно молча — первое скрытие не объяснено');
  // Сначала спрятать, потом объяснять: тост — украшение, окно — главное.
  assert.match(hidden[1], /win\.hide\(\);\s*\n\s*explainHide\('close'\);/, 'объяснение стоит раньше win.hide()');
});

test('main.js: уход управления объясняется тем же explainHide, а не своим флагом', () => {
  const body = block("const hideWindow = guarded('скрытие окна', () => {");
  assert.match(body, /win\.hide\(\);\s*\n\s*explainHide\('handoff'\);/, 'hideWindow не объясняет скрытие через explainHide');
  assert.ok(!/new Notification\(/.test(body), 'hideWindow снова показывает уведомление сам — «один раз» у путей разъедется');
  assert.ok(!/hideExplained/.test(MAIN), 'старый флаг hideExplained жив — у путей два разных «первый раз»');
});

test('main.js: explainHide собран из hide-notice.js с настоящим Notification', () => {
  assert.match(MAIN, /const \{ createHideExplainer \} = require\('\.\/hide-notice'\);/);
  const body = block('const explainHide = createHideExplainer({');
  assert.match(body, /canNotify:\s*\(\)\s*=>\s*Notification\.isSupported\(\),/);
  assert.match(body, /notify:\s*\(\{\s*title,\s*body\s*\}\)\s*=>\s*new Notification\(\{\s*title,\s*body\s*\}\)\.show\(\),/);
});
