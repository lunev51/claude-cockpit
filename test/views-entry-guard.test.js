'use strict';
// Страж записи вкладки в app.js (views: tabId → entry) — ревью 09.08, C19.
//
// entry.lastPtyStatus и entry.fontSize годами писались колбэками терминала и
// не читались нигде: отладочную статус-строку убрали ещё в фазе панели
// действий, а поля и писатели остались. Мёртвое поле врёт читателю кода —
// выглядит как состояние, на которое что-то опирается.
//
// Проверка общая, а не на два имени: каждое поле из литерала `const entry =
// {...}` должно где-то в renderer читаться. Комментарии вырезаются до поиска:
// в app.js был комментарий «onPtyStatus кладёт строку в entry.lastPtyStatus»,
// и цитата поля в нём выглядела бы как чтение.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const JS_DIR = path.join(__dirname, '..', 'src', 'renderer', 'js');
// Однострочные комментарии проекта — '//' до конца строки. Строки с '//'
// внутри (адреса) теряют хвост — для поиска чтений полей это безвредно.
const stripComments = (src) => src.replace(/\/\/.*$/gm, '');

const APP_CODE = stripComments(fs.readFileSync(path.join(JS_DIR, 'app.js'), 'utf8'));
const ALL_CODE = fs.readdirSync(JS_DIR)
  .filter((f) => f.endsWith('.js'))
  .map((f) => stripComments(fs.readFileSync(path.join(JS_DIR, f), 'utf8')))
  .join('\n');

function entryKeys() {
  const bodies = [...APP_CODE.matchAll(/const entry = \{([\s\S]*?)\};/g)].map((m) => m[1]);
  const keys = new Set();
  for (const body of bodies) {
    for (const m of body.matchAll(/(?:^|[{,])\s*([A-Za-z_$][\w$]*)\s*(?=[:,]|$)/g)) keys.add(m[1]);
  }
  return { bodies, keys };
}

test('у записи вкладки нет полей, которые только пишутся', () => {
  const { bodies, keys } = entryKeys();
  // openTab и attachTab — две точки создания записи; меньше — разбор
  // расклеился с исходником, и тест молча ничего не проверяет.
  assert.ok(bodies.length >= 2, `найдено литералов записи: ${bodies.length} — страж разъехался с app.js`);
  assert.ok(keys.has('view') && keys.has('container'), `ключи записи не разобраны: ${[...keys].join(', ')}`);
  for (const key of keys) {
    // Чтение — `.key` у записи вкладки, за которым не стоит присваивание
    // (`=`, но не `==`). Получатель обязателен: голое `.fontSize` нашлось бы у
    // config.terminal и cfg, и мёртвое entry.fontSize выглядело бы читаемым.
    // Получатели записи сегодня: entry, переменная цикла по views (v) и
    // views.get(...). Новый получатель — тест покраснеет громко, а не промолчит.
    const read = new RegExp(`(?:\\bentry|\\bv|views\\.get\\([^()]*\\))\\??\\.${key}\\b(?!\\s*=(?!=))`);
    assert.match(ALL_CODE, read, `поле записи вкладки «${key}» пишется, но нигде не читается — мёртвое состояние`);
  }
});
