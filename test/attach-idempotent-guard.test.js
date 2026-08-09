'use strict';
// Страж идемпотентности подключения к живым вкладкам. Тот же жанр, что
// test/renderer-boot-guard.test.js и test/broadcast-guard.test.js: читает
// исходник и требует инварианта, который иначе держится на комментарии.
//
// Живая жалоба 09.08: «открыл кокпит на компе, перешёл на мак, вернулся — и
// сессии задвоились; попытался закрыть дубли — кокпит завис; после перезапуска
// осталась одна вкладка». Воспроизведено на живом кокпите: 4 строки в сайдбаре
// при 2 вкладках в менеджере.
//
// Механизм: в attachLiveTabs ведут ДВА пути, и на одной вкладке они
// встречаются штатно —
//   1) сверка составов (tabs:changed → syncTabsFromMain), работает у зрителя;
//   2) отложенный подъём воркспейса (workspaceBootPending → bootWorkspace),
//      доигрывается в afterControlGained при возврате управления.
// Зритель без своих вкладок откладывает (2), получает вкладки через (1) и,
// забрав руль, заходит в (2) на УЖЕ подключённые вкладки. Без фильтра второй
// заход звал attachTab на тот же tabId: tabStore.add давал вторую строку, а
// views.set перетирал первый xterm, оставляя его сиротой в DOM вместе с
// ResizeObserver.
//
// Тестом на чистом модуле это не ловится: attachLiveTabs живёт в app.js
// (renderer не покрыт node --test, см. «Грабли» в памяти проекта), а сам факт
// «цикл идёт по отфильтрованному списку» — структурный. Отсюда страж.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const APP_JS = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'js', 'app.js'),
  'utf8',
);

// Тело функции верхнего уровня: от её объявления до закрывающей скобки в
// НАЧАЛЕ строки (в проекте функции верхнего уровня закрываются именно так).
function topLevelBody(source, signature) {
  const start = source.indexOf(signature);
  assert.notStrictEqual(
    start, -1,
    `в app.js не найдено объявление «${signature}» — страж разъехался с исходником и молча ничего не проверяет`,
  );
  const rest = source.slice(start);
  const end = rest.search(/\n\}/);
  assert.notStrictEqual(end, -1, `не найден конец функции «${signature}»`);
  return rest.slice(0, end);
}

test('attachLiveTabs подключает только тех, кого ещё нет на экране', () => {
  const body = topLevelBody(APP_JS, 'async function attachLiveTabs(');

  // 1. Фильтр вообще есть, и считает он по views — единственному источнику
  //    правды «что уже подключено».
  const filter = body.match(/const\s*\{\s*add[^}]*\}\s*=\s*diffTabs\(\s*liveTabs\s*,\s*\[\s*\.\.\.\s*views\.keys\(\)\s*\]\s*\)/);
  assert.ok(
    filter,
    'из attachLiveTabs пропала сверка с views через diffTabs(liveTabs, [...views.keys()]). '
    + 'Без неё повторный заход (отложенный bootWorkspace после возврата управления) подключается '
    + 'к уже подключённым вкладкам: вторая строка в сайдбаре на ту же вкладку и осиротевший xterm '
    + 'в DOM. Живая жалоба 09.08 — ровно этот случай.',
  );

  // 2. Цикл идёт по РЕЗУЛЬТАТУ фильтра, а не по исходному списку: фильтр,
  //    результат которого не используется, — это отсутствие фильтра.
  assert.match(
    body,
    /for\s*\(\s*const\s+\w+\s+of\s+add\s*\)/,
    'attachLiveTabs считает фильтр, но обходит не его результат — значит подключает всех подряд, '
    + 'включая уже подключённых',
  );
  assert.doesNotMatch(
    body,
    /for\s*\(\s*const\s+\w+\s+of\s+liveTabs\s*\)/,
    'attachLiveTabs всё ещё обходит исходный liveTabs — фильтр не действует',
  );
});

test('attachTab зовут ровно из одного места — из-под фильтра attachLiveTabs', () => {
  // Инвариант, на котором держится страж выше. Фильтр стоит в attachLiveTabs,
  // поэтому любой новый вызов attachTab мимо неё дублей не избежит: он и есть
  // тот самый второй заход на живой tabId. openTab сюда не относится — новая
  // вкладка заводит свой терминал сама, её tabId в views заведомо нет.
  const callers = APP_JS.split(/\r?\n/)
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => /(?:await\s+)?attachTab\s*\(/.test(line))
    .filter(({ line }) => !line.startsWith('//') && !line.startsWith('*'))
    .filter(({ line }) => !/^async function attachTab\(/.test(line));

  assert.strictEqual(
    callers.length, 1,
    `attachTab вызывается из ${callers.length} мест (строки ${callers.map((c) => c.n).join(', ')}), `
    + 'а должен из одного — изнутри attachLiveTabs. Только там стоит сверка с views; '
    + 'вызов в обход неё вернёт задвоение вкладок (живая жалоба 09.08).',
  );

  const body = topLevelBody(APP_JS, 'async function attachLiveTabs(');
  assert.match(
    body,
    /attachTab\s*\(/,
    'единственный вызов attachTab оказался НЕ внутри attachLiveTabs — фильтр его не прикрывает',
  );
});
