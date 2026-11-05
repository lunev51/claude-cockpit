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

// --- План «размер терминала», задача A4 -------------------------------------
// Запись кадров на стенде 05.11: первым кадром загрузки уходил
// owner:claim {80×24} — вкладок ещё нет, termSize() отдавал запасной размер, и
// main при смене владельца раздавал его ВСЕМ живым pty. Теперь размера нет —
// значит null, и main его не применяет (ownership.claim считает кривой размер
// отсутствующим).
//
// Комментарии вырезаются до поиска: тексты вокруг захвата подробно цитируют
// старое поведение («запасные 80×24»), и цитата не должна краснить или
// зеленить страж.
function code(body) {
  return body
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('//'))
    .map((line) => line.replace(/\s+\/\/ .*$/, ''))
    .join('\n');
}

test('termSize не выдумывает размер: только refit() активного терминала или null', () => {
  const body = code(topLevelBody(APP_JS, 'function termSize('));
  assert.match(body, /\.refit\(\)/, 'termSize больше не спрашивает refit() — размер снова читается из неподогнанного term.cols');
  assert.doesNotMatch(
    body, /\b(80|24)\b/,
    'в termSize снова запасной размер: захват без вкладок раздаст его всем сессиям (applyHandoffSize)',
  );
  assert.doesNotMatch(body, /term\.(cols|rows)/, 'termSize читает term.cols/term.rows напрямую — у скрытого терминала это умолчание 80×24');
  assert.match(body, /return null;/, 'termSize не отдаёт null, когда размера нет');
});

test('claimControl шлёт размер termSize() или null — без запасных 80×24', () => {
  const body = code(topLevelBody(APP_JS, 'async function claimControl('));
  assert.doesNotMatch(body, /\b80\b/, 'в claimControl появился литерал 80 — запасной размер вернулся');
  assert.doesNotMatch(body, /\{\s*cols:\s*80/, 'в claimControl запасной объект { cols: 80 ... }');
  assert.match(
    body,
    /const\s+(\w+)\s*=\s*termSize\(\);[\s\S]*window\.api\.owner\.claim\(\s*\1\s*\?\s*\1\.cols\s*:\s*null\s*,\s*\1\s*\?\s*\1\.rows\s*:\s*null\s*\)/,
    'owner.claim должен получать размер termSize() или null',
  );
});

test('boot ждёт шрифт терминала до первого терминала', () => {
  const body = code(topLevelBody(APP_JS, 'async function boot('));
  const config = body.indexOf('config = await window.api.config.get()');
  const font = body.search(/await\s+waitForFont\(\s*document\.fonts\s*,/);
  const sync = body.indexOf('window.api.tabs.onChanged(');
  const workspace = body.indexOf('await bootWorkspace()');
  assert.notStrictEqual(config, -1, 'в boot не найдено чтение конфига — страж разъехался с исходником');
  assert.notStrictEqual(font, -1, 'boot не ждёт шрифт (await waitForFont(document.fonts, ...)) — xterm измерит ячейку по запасному шрифту');
  assert.notStrictEqual(sync, -1, 'в boot не найдена подписка tabs.onChanged');
  assert.notStrictEqual(workspace, -1, 'в boot не найден вызов bootWorkspace');
  assert.ok(config < font, 'шрифт ждём раньше, чем прочитан конфиг — неоткуда взять размер и семейство');
  assert.ok(
    font < sync && font < workspace,
    'ожидание шрифта стоит ПОСЛЕ того, как могут появиться терминалы (сверка вкладок/подъём воркспейса)',
  );
  assert.match(APP_JS, /import\s*\{\s*waitForFont\s*\}\s*from\s*'\.\/term-size\.js'/, 'waitForFont не импортируется из term-size.js');
});

test('повтор term:start после захвата не шлёт размер скрытых терминалов', () => {
  // resumeInputAfterClaim будит ввод во ВСЕХ вкладках, большинство которых
  // скрыты: их term.cols — умолчание xterm 80×24, если вкладку ни разу не
  // показывали. Размер здесь не нужен вовсе (у живой вкладки main его не
  // трогает), а для поднятия заново main возьмёт размер владельца.
  const body = code(topLevelBody(APP_JS, 'async function resumeInputAfterClaim('));
  const start = body.match(/window\.api\.term\.start\(([^;]*)\);/);
  assert.ok(start, 'в resumeInputAfterClaim нет term.start — разблокировка ввода после захвата пропала');
  assert.doesNotMatch(start[1], /term\.(cols|rows)/, 'resumeInputAfterClaim снова шлёт term.cols/term.rows скрытых вкладок');
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
