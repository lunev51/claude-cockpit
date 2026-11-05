'use strict';
// Страж: terminal.js сообщает pty размер ТОЛЬКО подогнанного терминала.
//
// Запись кадров на стенде 05.11 (браузер, три вкладки claude) — откуда «квадрат»:
//   SEND term:start  {80×24}  ← вкладка создана в скрытом .term-view, fit() — no-op
//   SEND term:resize {80×24}  ← ResizeObserver скрытой вкладки: fit не сработал,
//                               а размер ушёл всё равно (term.cols — умолчание xterm)
// Дальше main запоминал 80×24 как размер владельца (ownership.noteSize), и
// следующая пересадка без размера раздавала его всем сессиям.
//
// Решение — measure(): fittedSize(fit.proposeDimensions(), коробка контейнера),
// и в pty уходит только его ненулевой результат. Renderer не покрыт node --test
// (DOM, xterm), поэтому стережём форму кода — тем же приёмом, что
// handoff-claim-guard.test.js. Комментарии вырезаются ДО поиска: в этом файле
// много текста, цитирующего код, и цитата не должна сходить за живой вызов
// (так уже бывало — страж цеплялся за комментарий).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const RAW = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'js', 'terminal.js'), 'utf8');

// Строки-комментарии целиком и хвостовые « // ...» после кода.
function stripComments(source) {
  return source
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('//'))
    .map((line) => line.replace(/\s+\/\/ .*$/, ''))
    .join('\n');
}
const SRC = stripComments(RAW);

// Тело блока, начинающегося с якоря: от первой «{» после него до парной «}».
// Якорь обязан быть уникальным — иначе страж мог бы проверять не то место.
function blockAfter(anchor) {
  const at = SRC.indexOf(anchor);
  assert.notStrictEqual(at, -1, `в terminal.js не найден «${anchor}» — страж разъехался с исходником`);
  assert.strictEqual(SRC.indexOf(anchor, at + 1), -1, `«${anchor}» встречается в terminal.js не один раз — непонятно, что стеречь`);
  const open = SRC.indexOf('{', at + anchor.length - 1);
  let depth = 0;
  for (let i = open; i < SRC.length; i += 1) {
    if (SRC[i] === '{') depth += 1;
    else if (SRC[i] === '}') {
      depth -= 1;
      if (depth === 0) return SRC.slice(open, i + 1);
    }
  }
  assert.fail(`не найден конец блока «${anchor}»`);
  return '';
}

const ANY_RESIZE = /window\.api\.term\.resize\s*\(/g;
// Вызов sendSize (объявление `const sendSize = (s) =>` сюда не попадает).
const ANY_SEND = /\bsendSize\s*\(/g;

// Ровно одна допустимая форма отправки: результат measure() в переменной, и
// sendSize под проверкой ЭТОЙ ЖЕ переменной, с ней же.
//   const s = measure();
//   if (s) sendSize(s);
// sendSize — единственное место, где размер уходит в pty (и наружу, соседним
// вкладкам — см. adoptGrid).
const GUARDED_SEND = /const\s+(\w+)\s*=\s*measure\(\);\s*if\s*\(\s*\1\s*\)\s*sendSize\(\s*\1\s*\)/g;

function assertGuardedSite(body, where) {
  const sends = [...body.matchAll(ANY_SEND)].length;
  const guarded = [...body.matchAll(GUARDED_SEND)].length;
  assert.strictEqual(
    guarded, 1,
    `${where}: нет отправки размера под проверкой measure() — либо она пропала, либо снова безусловная `
    + '(тогда неподогнанный терминал опять шлёт pty умолчание 80×24)',
  );
  assert.strictEqual(
    sends, guarded,
    `${where}: рядом с проверенной отправкой есть ещё ${sends - guarded} безусловная — `
    + 'скрытая вкладка снова сообщит pty размер, которого у неё нет',
  );
  assert.strictEqual(
    [...body.matchAll(ANY_RESIZE)].length, 0,
    `${where}: window.api.term.resize в обход sendSize — мимо проверки и мимо раздачи сетки соседям`,
  );
}

test('measure() решает по fittedSize и не трогает xterm, пока терминал не подогнан', () => {
  const body = blockAfter('const measure = () => {');
  assert.match(
    body,
    /const\s+(\w+)\s*=\s*cellNow\(\);[\s\S]*fittedSize\(\s*fit\.proposeDimensions\(\)\s*,\s*cellArea\(\)\s*,\s*\1\s*\)/,
    'measure() больше не спрашивает fittedSize с областью под клетки и ячейкой — проверка «подогнан ли» потеряна',
  );
  // fit() на контейнере 0×0 (свёрнутое окно) ужал бы сам xterm до 2×1: буфер
  // переложился бы в две колонки, а с ним и вся прокрутка.
  const fits = [...body.matchAll(/fit\.fit\(\)/g)].length;
  assert.strictEqual(fits, 1, `fit.fit() в measure() встречается ${fits} раз(а), ожидался один под проверкой`);
  assert.match(
    body,
    /if\s*\(\s*(\w+)\s*\)\s*\{?\s*fit\.fit\(\)/,
    'fit.fit() в measure() не под проверкой результата fittedSize — свёрнутое окно ужмёт терминал до 2×1',
  );
  assert.match(SRC, /import\s*\{\s*fittedSize\s*\}\s*from\s*'\.\/term-size\.js'/, 'fittedSize не импортируется из term-size.js');
});

test('область под клетки — по содержимому контейнера, не по clientWidth/clientHeight', () => {
  // Ревью в Chrome: clientWidth/Height включают отступ .term-view (4px 0 0 8px).
  // Хост 0×0 давал 8×4, хост 0×500 — 8×500, и зажатые FitAddon 2×1 / 2×29
  // проходили проверку и уезжали в pty. Первая редакция этого стража именно
  // эту неверную коробку и закрепляла.
  assert.doesNotMatch(SRC, /\bclient(Width|Height)\b/, 'terminal.js снова берёт clientWidth/clientHeight — коробка с отступом');
  const area = blockAfter('const cellArea = () => {');
  assert.match(area, /getComputedStyle\(\s*container\s*\)/, 'cellArea не читает getComputedStyle контейнера');
  assert.match(area, /parseFloat\(\s*(\w+)\.width\s*\)\s*-\s*(\w+)/, 'ширина области — не контентная ширина минус полоса прокрутки');
  assert.match(area, /parseFloat\(\s*(\w+)\.height\s*\)/, 'высота области — не контентная высота');
  assert.match(area, /overviewRuler\?\.width\s*\|\|\s*14/, 'полоса прокрутки считается не так, как в addon-fit 0.11.0');
  const adopt = blockAfter('adoptGrid: (size) => {');
  assert.match(
    adopt,
    /fittedSize\(\s*fit\.proposeDimensions\(\)\s*,\s*cellArea\(\)\s*,\s*cellNow\(\)\s*\)/,
    'adoptGrid решает «подогнан ли» не той же проверкой, что measure()',
  );
});

test('ResizeObserver шлёт размер только подогнанного терминала', () => {
  assertGuardedSite(blockAfter('new ResizeObserver('), 'колбэк ResizeObserver');
});

test('смена размера шрифта шлёт размер только подогнанного терминала', () => {
  assertGuardedSite(blockAfter('const setFontSize = (size) => {'), 'setFontSize');
});

test('refit шлёт размер только подогнанного терминала и отдаёт null, если не подогнан', () => {
  const body = blockAfter('refit: () => {');
  assertGuardedSite(body, 'refit');
  const ret = body.match(/const\s+(\w+)\s*=\s*measure\(\);[\s\S]*return\s+(\w+);/);
  assert.ok(ret, 'refit больше не возвращает результат measure()');
  assert.strictEqual(
    ret[2], ret[1],
    'refit возвращает не результат measure(): app.js (termSize, захват управления) получит размер '
    + 'неподогнанного терминала вместо null',
  );
  assert.doesNotMatch(body, /term\.cols|term\.rows/, 'refit снова читает term.cols/term.rows напрямую');
});

test('любая отправка term:resize в terminal.js — только в проверенной форме', () => {
  // Ловит и НОВОЕ место, которого страж поимённо не знает.
  const sends = [...SRC.matchAll(ANY_SEND)].length;
  const guarded = [...SRC.matchAll(GUARDED_SEND)].length;
  assert.ok(sends > 0, 'в terminal.js не осталось ни одного sendSize — разбор расклеился с файлом');
  assert.strictEqual(sends, guarded, `из ${sends} вызовов sendSize проверены measure() только ${guarded}`);

  // Прямой вызов window.api.term.resize — ровно один, внутри sendSize, с её
  // же аргументом. Любой второй — дверь в pty мимо проверки.
  const direct = [...SRC.matchAll(ANY_RESIZE)].length;
  assert.strictEqual(direct, 1, `window.api.term.resize встречается ${direct} раз(а) — ожидался один, внутри sendSize`);
  const send = blockAfter('const sendSize = (');
  assert.match(
    send,
    /window\.api\.term\.resize\(\s*tabId\s*,\s*(\w+)\.cols\s*,\s*\1\.rows\s*\)/,
    'единственный window.api.term.resize не внутри sendSize',
  );
  const param = SRC.match(/const sendSize = \((\w+)\) =>/);
  assert.ok(param, 'sendSize больше не принимает размер параметром');
  assert.match(send, new RegExp(`window\\.api\\.term\\.resize\\(\\s*tabId\\s*,\\s*${param[1]}\\.cols`), 'sendSize шлёт не свой аргумент');
});

test('term.start не берёт term.cols/term.rows напрямую', () => {
  const starts = [...SRC.matchAll(/window\.api\.term\.start\(([^;]*)\);/g)];
  assert.strictEqual(starts.length, 1, `window.api.term.start встречается ${starts.length} раз(а)`);
  const args = starts[0][1];
  assert.doesNotMatch(
    args, /term\.(cols|rows)/,
    'term.start снова шлёт term.cols/term.rows: вкладка создаётся в скрытом контейнере, и это умолчание 80×24',
  );
  assert.match(
    SRC,
    /const\s+(\w+)\s*=\s*measure\(\);\s*window\.api\.term\.start\(\s*tabId\s*,\s*\1\s*\?\s*\1\.cols\s*:\s*null\s*,\s*\1\s*\?\s*\1\.rows\s*:\s*null\s*\)/,
    'term.start должен слать результат measure() или null (размер тогда выберет main — размер владельца)',
  );
});

// --- app.js: сетка видимой вкладки — скрытым (A6) ---------------------------
// main раздаёт размер видимой вкладки ВСЕМ pty, а скрытые xterm подогнаться
// не могут. app.js держит последнюю подогнанную сетку (sharedGrid) и отдаёт её
// скрытым вкладкам: при каждой отправке размера (onGrid → shareGrid) и при
// создании вкладки (adoptGrid сразу после initTerminal, ДО истории вывода —
// иначе история ляжет в сетку 80×24).
const APP = stripComments(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'js', 'app.js'), 'utf8'));

function appFunction(signature) {
  const at = APP.indexOf(signature);
  assert.notStrictEqual(at, -1, `в app.js не найдено «${signature}» — страж разъехался с исходником`);
  const rest = APP.slice(at);
  // Конец — строка из одной «}». Просто «\n}» не годится: у openTab параметры
  // деструктурируются в несколько строк, и строка «} = {}) {» оборвала бы
  // тело на списке параметров.
  const end = rest.search(/\n\}(?=\n|$)/);
  assert.notStrictEqual(end, -1, `не найден конец «${signature}»`);
  return rest.slice(0, end);
}

test('shareGrid раздаёт сетку всем вкладкам, кроме той, что её прислала', () => {
  const body = appFunction('function shareGrid(');
  assert.match(body, /sharedGrid\s*=/, 'shareGrid не запоминает сетку — вкладка, открытая позже, её не получит');
  assert.match(body, /for\s*\(\s*const\s*\[\s*(\w+)\s*,\s*(\w+)\s*\]\s*of\s*views\s*\)/, 'shareGrid не обходит views');
  assert.match(body, /\.adoptGrid\(/, 'shareGrid не отдаёт сетку вкладкам (adoptGrid)');
  assert.match(body, /!==\s*fromTabId|fromTabId\s*!==/, 'shareGrid не пропускает вкладку-источник');
});

for (const [fn, idExpr] of [['async function openTab(', 'tab.tabId'], ['async function attachTab(', 't.tabId']]) {
  test(`${fn.replace('async function ', '').replace('(', '')}: вкладка получает общую сетку и раздаёт свою`, () => {
    const body = appFunction(fn);
    const idRe = idExpr.replace('.', '\\.');
    assert.match(
      body,
      new RegExp(`onGrid:\\s*\\((\\w+)\\)\\s*=>\\s*shareGrid\\(\\s*${idRe}\\s*,\\s*\\1\\s*\\)`),
      `initTerminal в ${fn} не получает onGrid → shareGrid: сетка этой вкладки не дойдёт до скрытых`,
    );
    const adopt = body.search(/if\s*\(\s*sharedGrid\s*\)\s*view\.adoptGrid\(\s*sharedGrid\s*\)/);
    assert.notStrictEqual(adopt, -1, `${fn}: новая вкладка не принимает общую сетку — останется в 80×24 при pty в размере окна`);
    assert.ok(adopt > body.indexOf('initTerminal('), `${fn}: adoptGrid раньше initTerminal`);
  });
}

test('attachTab: сетка известна ДО истории вывода', () => {
  // История (net:buffer) печатается как есть; в неподогнанной сетке 80×24 она
  // разъедется, а перерисовки не будет — размер pty не изменится.
  const body = appFunction('async function attachTab(');
  const history = body.indexOf('await replayHistory(');
  assert.notStrictEqual(history, -1, 'в attachTab нет replayHistory — страж разъехался с исходником');
  const adopt = body.search(/view\.adoptGrid\(\s*sharedGrid\s*\)/);
  assert.ok(adopt !== -1 && adopt < history, 'общая сетка принимается ПОСЛЕ истории — история ляжет в 80×24');
  const refit = body.search(/\.refit\(\)/);
  const activate = body.search(/activateTab\(\s*t\.tabId\s*\)/);
  assert.ok(activate !== -1 && refit > activate && refit < history, 'активная вкладка не подгоняется синхронно между показом и историей');
});

test('догрузка шрифта перемеряет ячейку и снимает подписку в dispose', () => {
  const sub = SRC.match(/document\.fonts\??\.addEventListener\??\.?\(\s*'loadingdone'\s*,\s*(\w+)\s*\)/);
  assert.ok(sub, 'нет подписки на document.fonts loadingdone — шрифт, догрузившийся после замера, не перемерит ячейку');
  const handler = sub[1];
  const body = blockAfter(`const ${handler} = () => {`);
  assert.match(
    body,
    /_charSizeService[\s\S]*\.measure\??\.?\(\)/,
    'обработчик догрузки шрифта не перемеряет ячейку (_charSizeService.measure) — публичного перемера в xterm 6 нет, '
    + 'и без этого fit посчитает строки по старой высоте',
  );
  assertGuardedSite(body, `обработчик догрузки шрифта (${handler})`);
  const dispose = blockAfter('dispose: () => {');
  assert.match(
    dispose,
    new RegExp(`document\\.fonts\\??\\.removeEventListener\\??\\.?\\(\\s*'loadingdone'\\s*,\\s*${handler}\\s*\\)`),
    'dispose не снимает подписку на loadingdone — закрытая вкладка держала бы xterm и слала бы размер мёртвому tabId',
  );
});
