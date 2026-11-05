'use strict';
// Снимок ghost-буфера на конце хода — страж по исходнику.
//
// Конец хода — самый ценный кадр скроллбека (app.js сериализует его сразу, не
// дожидаясь 30-секундного таймера). Статус «фон» (план 2026-11-05) — тоже
// конец хода: Claude ответил, а фоновая команда ещё идёт. Без него в списке
// кадр ответа ждал бы таймера — и терялся бы при закрытии кокпита в эти 30с.
//
// Renderer под node --test не поднимается, а инвариант — в условии вызова
// внутри обработчика tab.onStatus. Отсюда страж текстом.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const APP_JS = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'js', 'app.js'),
  'utf8',
);

// Комментарии выкидываем: у обработчика подробная история, и имена статусов
// в ней встречаются — страж, читающий комментарии, остался бы зелёным после
// удаления условия из кода (так уже выходили холостые стражи).
// Однострочные /* … */ режем тоже: закомментированное внутри условия
// `|| status === 'background'` иначе читалось бы как живое.
const codeOnly = (source) => source
  .split(/\r?\n/)
  .filter((line) => !/^\s*\/\//.test(line))
  .map((line) => line.replace(/\/\*.*?\*\//g, '').replace(/\s\/\/\s.*$/, ''))
  .join('\n');

test('конец хода: ghost сохраняется и на «фоне», не только на done/waiting', () => {
  const code = codeOnly(APP_JS);
  const start = code.indexOf('window.api.tab.onStatus(');
  assert.notStrictEqual(start, -1, 'в app.js не найден обработчик tab.onStatus — страж разъехался с исходником');
  const rest = code.slice(start);
  const body = rest.slice(0, rest.search(/\n {2}\}\);/));
  // Якорь: вырезан именно обработчик статуса, а не что-то соседнее.
  assert.match(body, /tabStore\.setStatus\(/, 'тело обработчика вырезано не то — нет tabStore.setStatus');

  const calls = body.split('\n').filter((line) => /saveGhost\(tabId\)/.test(line));
  assert.strictEqual(calls.length, 1, `ожидался ровно один вызов saveGhost(tabId) в обработчике, найдено ${calls.length}`);
  const [line] = calls;
  assert.match(line, /!labelOnly/, 'смена одной лишь метки снова пишет полумегабайтный буфер на диск');
  for (const status of ['done', 'waiting', 'background']) {
    assert.ok(
      line.includes(`status === '${status}'`),
      `конец хода в статусе '${status}' больше не сохраняет ghost сразу: ${line.trim()}`,
    );
  }
});
