'use strict';
// Страж записи вкладки в app.js (views: tabId → entry) — ревью 09.08, C19.
//
// entry.lastPtyStatus и entry.fontSize годами писались колбэками терминала и
// не читались нигде: отладочную статус-строку убрали ещё в фазе панели
// действий, а поля и писатели остались. Мёртвое поле врёт читателю кода —
// выглядит как состояние, на которое что-то опирается.
//
// Проверка общая, а не на два имени: каждое поле записи вкладки должно где-то
// читаться. Поле заводится двумя способами — ключом литерала `const entry =
// {...}` и присваиванием `entry.x = …` / `views.get(id).x = …` после него
// (ревью ветки: первая редакция видела только литерал, и `entry.lastPtyStatus
// = ''` присваиванием проходил мимо). Комментарии вырезаются до поиска: в
// app.js был комментарий «onPtyStatus кладёт строку в entry.lastPtyStatus», и
// цитата поля в нём выглядела бы как чтение.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const JS_DIR = path.join(__dirname, '..', 'src', 'renderer', 'js');
// Однострочные комментарии проекта — '//' до конца строки. Строки с '//'
// внутри (адреса) теряют хвост — для поиска полей это безвредно.
const stripComments = (src) => src.replace(/\/\/.*$/gm, '');
const code = (f) => stripComments(fs.readFileSync(path.join(JS_DIR, f), 'utf8'));

// Записи вкладок ходят только по этим модулям: app.js их держит, grid-share.js
// получает views целиком. В остальных `entry` и `v` — чужие объекты (запись
// журнала ночной смены, DOM-узел дашборда, результат поиска), и их `.ts` или
// `.className` выдали бы мёртвое поле записи за читаемое.
const HOLDERS = ['app.js', 'grid-share.js'];
const APP_CODE = code('app.js');
const HOLDER_CODE = HOLDERS.map(code).join('\n');

const RECEIVER = String.raw`(?:\bentry|\bv|views\.get\([^()]*\))\??`;
const NOT_ASSIGN = String.raw`(?!\s*=(?!=))`;

function entryFields() {
  const bodies = [...APP_CODE.matchAll(/const entry = \{([\s\S]*?)\};/g)].map((m) => m[1]);
  const fromLiteral = new Set();
  for (const body of bodies) {
    for (const m of body.matchAll(/(?:^|[{,])\s*([A-Za-z_$][\w$]*)\s*(?=[:,]|$)/g)) fromLiteral.add(m[1]);
  }
  // `entry.x = …`, но не `entry.x == …`; `entry.view?.adoptGrid` — чтение.
  const assigned = new Set(
    [...HOLDER_CODE.matchAll(new RegExp(String.raw`${RECEIVER}\.([A-Za-z_$][\w$]*)\s*=(?!=)`, 'g'))].map((m) => m[1]),
  );
  return { bodies, fromLiteral, assigned };
}

test('записи вкладок держат только известные модули', () => {
  // Новый держатель views — новые чтения и записи, которых страж ниже не
  // видит. Лучше громко покраснеть здесь, чем молча пропустить мёртвое поле.
  const holders = fs.readdirSync(JS_DIR)
    .filter((f) => f.endsWith('.js') && /(?<![.\w$])views\b/.test(code(f)))
    .sort();
  assert.deepStrictEqual(holders, [...HOLDERS].sort(), 'views ходит по новому модулю — добавь его в HOLDERS');
});

test('у записи вкладки нет полей, которые только пишутся', () => {
  const { bodies, fromLiteral, assigned } = entryFields();
  // openTab и attachTab — две точки создания записи; меньше — разбор
  // расклеился с исходником, и тест молча ничего не проверяет.
  assert.ok(bodies.length >= 2, `найдено литералов записи: ${bodies.length} — страж разъехался с app.js`);
  assert.ok(fromLiteral.has('view') && fromLiteral.has('container'), `ключи записи не разобраны: ${[...fromLiteral].join(', ')}`);
  // entry.view = view в openTab/attachTab и entry.pendingOutput = null в
  // replayHistory — присваивания есть сегодня точно.
  assert.ok(assigned.has('view') && assigned.has('pendingOutput'), `присваивания полям записи не разобраны: ${[...assigned].join(', ')}`);
  for (const key of new Set([...fromLiteral, ...assigned])) {
    // Чтение — `.key` у записи вкладки, за которым не стоит присваивание.
    // Получатель обязателен: голое `.fontSize` нашлось бы у config.terminal и
    // cfg, и мёртвое entry.fontSize выглядело бы читаемым. Получатели записи
    // сегодня: entry, переменная цикла по views (v) и views.get(...).
    const read = new RegExp(`${RECEIVER}\\.${key}\\b${NOT_ASSIGN}`);
    assert.match(HOLDER_CODE, read, `поле записи вкладки «${key}» пишется, но нигде не читается — мёртвое состояние`);
  }
});
