'use strict';
// Страж захвата управления: с каким размером уезжает owner:claim.
//
// Живой замер 09.08 (ревью эстафеты). Здесь встречаются два разных механизма,
// и по отдельности каждый выглядит безобидно:
//   1) main на смену владельца подгоняет под его размер ВСЕ живые pty
//      (applyHandoffSize в ipc.js) — иначе фоновые вкладки остаются в чужой
//      раскладке;
//   2) renderer берёт размер у АКТИВНОЙ вкладки, а если её нет — отдаёт
//      запасные 80×24 (termSize), чтобы захват прошёл и на пустом кокпите.
// Вместе они дают порчу: клиент без активной вкладки ужимает ВСЕ сессии до 80
// колонок на широком экране. А активной вкладки закономерно не бывает у того,
// кому вкладки приехали синхронизацией — их завёл сосед (syncTabsFromMain
// подключает без активации, чтобы не дёргать человека). Это ровно случай «ушёл
// на мак, вернулся на ПК».
//
// Замерено живьём до фикса: обе вкладки 140 → 80 при окне на 1280px.
// После фикса: 140 → 126 (настоящая ширина окна), обе, включая фоновую.
//
// Renderer не покрыт node --test (см. «Грабли» в памяти проекта), а инвариант
// здесь — порядок двух вызовов. Отсюда страж по исходнику.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const APP_JS = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'js', 'app.js'),
  'utf8',
);

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

test('захват показывает вкладку ДО того, как снимет размер терминала', () => {
  const body = topLevelBody(APP_JS, 'async function claimControl(');

  const показ = body.indexOf('ensureActiveTabForHandoff(');
  const размер = body.indexOf('termSize(');

  assert.notStrictEqual(
    показ, -1,
    'из claimControl пропал показ вкладки перед захватом: клиент без активной вкладки снова уедет '
    + 'в claim с запасными 80×24, а main применит их ко ВСЕМ живым сессиям (applyHandoffSize)',
  );
  assert.notStrictEqual(размер, -1, 'claimControl больше не снимает размер терминала — захват уедет без размера');
  assert.ok(
    показ < размер,
    'размер снимается РАНЬШЕ показа вкладки: termSize() вернёт запасные 80×24 (или размер скрытого '
    + 'терминала), и все сессии переразмерятся под них',
  );
});

test('показ вкладки перед захватом пересчитывает её геометрию', () => {
  const body = topLevelBody(APP_JS, 'function ensureActiveTabForHandoff(');

  assert.match(
    body,
    /activateTab\(/,
    'ensureActiveTabForHandoff больше не показывает вкладку — тогда она и не нужна',
  );
  assert.match(
    body,
    /\.refit\(\)/,
    'после показа вкладки нет refit: activateTab только снимает hidden, а term.cols до пересчёта '
    + 'остаётся прежним — в claim уехал бы размер скрытого терминала',
  );
  assert.match(
    body,
    /if\s*\(\s*views\.has\(/,
    'пропала проверка «активная вкладка уже есть»: захват перебрасывал бы человека на другую вкладку '
    + 'на каждом возврате управления',
  );
});
