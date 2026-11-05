'use strict';
// Панель поиска в терминале: кнопки ▲▼✕ не отбирают фокус у поля — страж по
// исходнику (ревью 09.08, C10).
//
// Enter/Shift+Enter/Esc панели слушает только поле ввода. Клик мышью по
// кнопке на mousedown переносил фокус на саму кнопку, и после первого же
// «следующее совпадение» мышью клавиши переставали работать: Esc не
// закрывал панель, Enter не искал. Приём тот же, что у строк палитры и
// кнопки дашборда: mousedown → preventDefault, click при этом доходит.
//
// terminal.js под node --test не поднимается (нужен window.Terminal и DOM),
// поэтому проверяем текстом — как terminal-selection.test.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'js', 'terminal.js'),
  'utf8',
);

// Комментарии выкидываем: объяснение бага лежит прямо над кодом и цитирует
// его — страж по сырому тексту остался бы зелёным без самого обработчика.
const codeOnly = (source) => source
  .split(/\r?\n/)
  .filter((line) => !/^\s*\/\//.test(line))
  .map((line) => line.replace(/\s\/\/\s.*$/, ''))
  .join('\n');

const CODE = codeOnly(SOURCE);

// Тело стрелочной функции mkBtn — от «=> {» до парной закрывающей скобки.
function mkBtnBody() {
  const decl = CODE.indexOf('const mkBtn = (');
  assert.notStrictEqual(decl, -1, 'не найден mkBtn — страж разъехался с исходником');
  const open = CODE.indexOf('{', CODE.indexOf('=>', decl));
  let depth = 0;
  for (let i = open; i < CODE.length; i += 1) {
    if (CODE[i] === '{') depth += 1;
    else if (CODE[i] === '}') {
      depth -= 1;
      if (depth === 0) return CODE.slice(open, i + 1);
    }
  }
  return assert.fail('не найден конец mkBtn');
}

test('кнопки поиска не забирают фокус у поля ввода на mousedown', () => {
  const body = mkBtnBody();
  assert.match(body, /return b;/, 'тело mkBtn вырезано не целиком');
  assert.match(
    body,
    /\.addEventListener\(\s*'mousedown'\s*,\s*\(?\s*(\w+)\s*\)?\s*=>\s*\{?\s*\1\.preventDefault\(\)/,
    'у кнопок поиска нет mousedown → preventDefault: клик мышью уводит фокус с поля, '
    + 'и Esc/Enter панели после этого мертвы',
  );
});

test('все три кнопки панели сделаны через mkBtn', () => {
  // Кнопка, собранная мимо mkBtn, осталась бы без защиты фокуса.
  for (const name of ['btnPrev', 'btnNext', 'btnClose']) {
    assert.match(
      CODE,
      new RegExp(`const ${name} = mkBtn\\(`),
      `${name} создаётся мимо mkBtn — у неё нет mousedown → preventDefault`,
    );
  }
});
