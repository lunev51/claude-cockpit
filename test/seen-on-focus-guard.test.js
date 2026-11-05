'use strict';
// «Прочитано» при возврате фокуса окна — страж по исходнику.
//
// Регрессия #45 (8abba94). Слушатель window 'focus' → markSeenIfWatching жил
// внутри bindVoiceHotkey, а #45 добавил туда ранний return для сетевого
// клиента (голос по сети не работает — принятое ограничение B11). Слушатель
// стоял НИЖЕ этого return, и в браузере не вешался вовсе: вкладка, ответившая,
// пока человек был в другом окне, после возврата навсегда оставалась в
// «Готово». К голосу слушатель отношения не имеет — отсюда отдельная функция
// и безусловный вызов из boot.
//
// Renderer под node --test не поднимается, а инвариант — в том, ГДЕ висит
// слушатель и КАК зовётся функция. Отсюда страж текстом.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const APP_JS = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'js', 'app.js'),
  'utf8',
);

// Комментарии выкидываем: разбор бага описан прямо у слушателя, и имена
// функций встречаются в тексте. Страж, читающий комментарии, остался бы
// зелёным после удаления самого вызова — так уже выходили холостые стражи.
// Хвостовой комментарий режем только после пробела: '//' внутри строк вида
// 'http://' остаётся нетронутым.
const codeOnly = (source) => source
  .split(/\r?\n/)
  .filter((line) => !/^\s*\/\//.test(line))
  .map((line) => line.replace(/\s\/\/\s.*$/, ''))
  .join('\n');

// Тело функции верхнего уровня: от объявления до закрывающей скобки в начале
// строки (в проекте функции верхнего уровня закрываются именно так).
function topLevelBody(source, signature) {
  const start = source.indexOf(signature);
  assert.notStrictEqual(
    start, -1,
    `в app.js не найдено объявление «${signature}» — страж разъехался с исходником`,
  );
  const rest = source.slice(start);
  const end = rest.search(/\n\}/);
  assert.notStrictEqual(end, -1, `не найден конец функции «${signature}»`);
  return rest.slice(0, end);
}

const CODE = codeOnly(APP_JS);

test('слушатель возврата фокуса живёт в своей функции', () => {
  const body = topLevelBody(CODE, 'function bindSeenOnFocus(');
  assert.match(
    body,
    /window\.addEventListener\(\s*'focus'/,
    'bindSeenOnFocus не вешает слушатель window focus — возврат в окно больше не помечает вкладку прочитанной',
  );
  assert.match(
    body,
    /markSeenIfWatching\(/,
    'слушатель focus не зовёт markSeenIfWatching — вкладка останется в «Готово»',
  );
});

test('boot вешает слушатель безусловно — и в окне, и в браузере', () => {
  const body = topLevelBody(CODE, 'async function boot(');
  // Якорь: тело boot вырезано целиком хотя бы до соседнего вызова. Без этого
  // обрезанное тело дало бы красный по неверной причине — или, хуже, зелёный.
  assert.match(body, /^ {2}bindVoiceHotkey\(\);/m, 'в boot не найден вызов bindVoiceHotkey — тело boot вырезано не целиком');
  // Ровно два пробела: вызов на верхнем уровне тела boot. Под if или в блоке
  // (отступ 4) или в одной строке с условием — это снова «не везде».
  assert.match(
    body,
    /^ {2}bindSeenOnFocus\(\);/m,
    'boot не зовёт bindSeenOnFocus() безусловно — в браузере (или в окне) возврат фокуса не пометит вкладку прочитанной',
  );
});

test('в bindVoiceHotkey не осталось пометки «прочитано»', () => {
  const body = topLevelBody(CODE, 'function bindVoiceHotkey(');
  // Якорь: тело дошло хотя бы до сетевой ветки, ради которой всё это.
  assert.match(body, /__cockpitNetClient/, 'в bindVoiceHotkey не найден ранний выход сетевого клиента — тело вырезано не то');
  assert.doesNotMatch(
    body,
    /markSeenIfWatching\(/,
    'markSeenIfWatching снова внутри bindVoiceHotkey: ранний return сетевого клиента отрежет его в браузере',
  );
  assert.doesNotMatch(
    body,
    /addEventListener\(\s*'focus'/,
    'слушатель focus снова внутри bindVoiceHotkey — в браузере он не вешается (ранний return #45)',
  );
});
