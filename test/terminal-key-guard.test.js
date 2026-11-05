'use strict';
// Терминал не принимает клавишу, которую уже обработал оверлей, — страж по
// исходнику (ре-ревью ветки).
//
// Оверлеи (палитра, поиск, дашборд, peek, форма рецепта) ловят Esc на
// document в capture-фазе и зовут preventDefault. Если фокус при этом в
// textarea xterm (Shift+Tab из оверлея), событие идёт дальше к нему — а xterm
// defaultPrevented не смотрит: _keyDown зовёт customKeyEventHandler и, если
// тот не вернул false, шлёт клавишу в pty (проверено по
// node_modules/@xterm/xterm/lib/xterm.js 6.0.0). Esc закрывал оверлей И уходил
// в claude как \x1b, прерывая генерацию.
//
// terminal.js под node --test не поднимается (нужны window.Terminal и DOM),
// поэтому проверяем текстом — как terminal-selection.test.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'js', 'terminal.js'),
  'utf8',
);

// Комментарии выкидываем: разбор бага лежит прямо над проверкой и цитирует её.
const codeOnly = (source) => source
  .split(/\r?\n/)
  .filter((line) => !/^\s*\/\//.test(line))
  .map((line) => line.replace(/\s\/\/\s.*$/, ''))
  .join('\n');

test('обработчик клавиш xterm первым делом пропускает уже обработанные клавиши', () => {
  const code = codeOnly(SOURCE);
  const m = code.match(/term\.attachCustomKeyEventHandler\(\(\s*(\w+)\s*\)\s*=>\s*\{\n/);
  assert.ok(m, 'не найден term.attachCustomKeyEventHandler((ev) => { — страж разъехался с исходником');
  const param = m[1];
  const after = code.slice(m.index + m[0].length);
  const first = after.split('\n').find((line) => line.trim());

  // Именно первой строкой: любая ветка выше (Ctrl+V, Ctrl+Shift+C) успела бы
  // обработать уже погашенную клавишу, а return true — отдать её в pty.
  assert.match(
    first || '',
    new RegExp(`^\\s*if \\(${param}\\.defaultPrevented\\) return false;\\s*$`),
    'первая строка обработчика клавиш xterm — не «if (ev.defaultPrevented) return false;»: '
    + 'Esc, закрывший оверлей, уйдёт в claude как \\x1b',
  );
});
