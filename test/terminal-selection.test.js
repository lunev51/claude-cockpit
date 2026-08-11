'use strict';
// Выделение мышью в сессии, которая перехватила мышь, — страж по исходнику.
//
// Живая жалоба 11.08: с макбука «при выделении ничего в буфер не уходит,
// Cmd+C тоже ничего, а правой кнопкой копируется только слово». Причина не в
// буфере обмена: Claude Code включает отслеживание мыши (в потоке pty
// CSI ?1000h/?1002h/?1003h/?1006h), xterm отдаёт мышь приложению и своё
// выделение не строит — копировать нечего. Форсировать выделение можно только
// модификатором, и xterm выбирает его по платформе:
//   isMac ? altKey && macOptionClickForcesSelection : shiftKey
// То есть на Windows Shift работает всегда, а на маке — ТОЛЬКО при включённой
// опции, у которой дефолт false. Пока её нет, на макбуке выделить текст в
// работающей сессии нельзя ничем.
//
// Renderer под node --test не поднимается (структурный пробел проекта),
// поэтому проверяем текстом — как broadcast-guard и ui-honesty-guard.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer', 'js');
const read = (name) => fs.readFileSync(path.join(RENDERER, name), 'utf8');

// Комментарии выкидываем ЦЕЛИКОМ, и это не перестраховка: разбор бага описан
// прямо над опцией, и имя `macOptionClickForcesSelection` встречается в тексте
// несколько раз. Страж, ищущий его по всему файлу, остался бы зелёным даже
// после удаления самой опции — ровно так уже трижды выходили холостые стражи.
const codeOnly = (source) => source
  .split(/\r?\n/)
  .filter((line) => !/^\s*\/\//.test(line))
  .join('\n');

test('терминал разрешает выделение мышью, когда сессия перехватила мышь', () => {
  const code = codeOnly(read('terminal.js'));

  // Опция обязана стоять именно в объекте опций xterm — в другом месте она
  // ничего не значит.
  const start = code.indexOf('new window.Terminal({');
  assert.notStrictEqual(start, -1, 'не найден конструктор Terminal — страж разъехался с исходником');
  const end = code.indexOf('});', start);
  assert.notStrictEqual(end, -1, 'не найден конец объекта опций Terminal');
  const options = code.slice(start, end);

  assert.match(
    options,
    /macOptionClickForcesSelection\s*:\s*true/,
    'macOptionClickForcesSelection не передан xterm: на маке выделение мышью в занятой сессии невозможно, '
    + 'а значит не работают ни «копировать выделением», ни Cmd+C',
  );
});

test('шпаргалка клавиш объясняет, чем выделять в занятой сессии', () => {
  const code = codeOnly(read('hotkeys.js'));

  // Модификатор нельзя угадать: на маке это Option, на ПК Shift. Без строки в
  // шпаргалке фича необнаружима — тот же класс, что I2 про правый Shift.
  assert.match(
    code,
    /\[\s*'[^']*Option[^']*Shift[^']*'\s*,/,
    'в шпаргалке нет строки про выделение с Option/Shift — человек не догадается, '
    + 'чем выделять текст, пока сессия занимает мышь',
  );
});
