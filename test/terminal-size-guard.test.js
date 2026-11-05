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

// Ровно одна допустимая форма отправки: результат measure() в переменной, и
// вызов под проверкой ЭТОЙ ЖЕ переменной, с её же cols/rows.
//   const s = measure();
//   if (s) window.api.term.resize(tabId, s.cols, s.rows);
const GUARDED_RESIZE = /const\s+(\w+)\s*=\s*measure\(\);\s*if\s*\(\s*\1\s*\)\s*window\.api\.term\.resize\(\s*tabId\s*,\s*\1\.cols\s*,\s*\1\.rows\s*\)/g;

function assertGuardedSite(body, where) {
  const all = [...body.matchAll(ANY_RESIZE)].length;
  const guarded = [...body.matchAll(GUARDED_RESIZE)].length;
  assert.strictEqual(
    guarded, 1,
    `${where}: нет отправки размера под проверкой measure() — либо она пропала, либо снова безусловная `
    + '(тогда неподогнанный терминал опять шлёт pty умолчание 80×24)',
  );
  assert.strictEqual(
    all, guarded,
    `${where}: рядом с проверенной отправкой есть ещё ${all - guarded} безусловная — `
    + 'скрытая вкладка снова сообщит pty размер, которого у неё нет',
  );
}

test('measure() решает по fittedSize и не трогает xterm, пока терминал не подогнан', () => {
  const body = blockAfter('const measure = () => {');
  assert.match(
    body,
    /fittedSize\(\s*fit\.proposeDimensions\(\)\s*,\s*\{\s*width:\s*container\.clientWidth\s*,\s*height:\s*container\.clientHeight\s*\}\s*\)/,
    'measure() больше не спрашивает fittedSize с коробкой контейнера — проверка «подогнан ли» потеряна',
  );
  // fit() на контейнере 0×0 (свёрнутое окно) ужал бы сам xterm до 2×1: буфер
  // переложился бы в две колонки, а с ним и вся прокрутка.
  const fits = [...body.matchAll(/fit\.fit\(\)/g)].length;
  assert.strictEqual(fits, 1, `fit.fit() в measure() встречается ${fits} раз(а), ожидался один под проверкой`);
  assert.match(
    body,
    /if\s*\(\s*(\w+)\s*\)\s*fit\.fit\(\)/,
    'fit.fit() в measure() не под проверкой результата fittedSize — свёрнутое окно ужмёт терминал до 2×1',
  );
  assert.match(SRC, /import\s*\{\s*fittedSize\s*\}\s*from\s*'\.\/term-size\.js'/, 'fittedSize не импортируется из term-size.js');
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
  const all = [...SRC.matchAll(ANY_RESIZE)].length;
  const guarded = [...SRC.matchAll(GUARDED_RESIZE)].length;
  assert.ok(all > 0, 'в terminal.js не осталось ни одного term:resize — разбор расклеился с файлом');
  assert.strictEqual(all, guarded, `из ${all} вызовов window.api.term.resize проверены measure() только ${guarded}`);
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
