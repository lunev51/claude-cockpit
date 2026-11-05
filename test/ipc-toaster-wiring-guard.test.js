'use strict';
// Шов sessions.js → тостер — страж по исходнику ipc.js.
//
// Тостер отличает пробуждение по уведомлению о конце фоновой задачи от нового
// промпта человека по флагу taskNotification из payload 'tab:status' (статус
// «фон», ревью 05.11). Флаг доезжает до тостера только через обвязку onEvent в
// registerIpc, а её под node --test не поднять: юнит-тесты по обе стороны шва
// остались бы зелёными, а живой тост «готово» после записи флешки — молча
// пропал бы. Отсюда страж текстом.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const IPC_JS = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ipc.js'), 'utf8');

// Комментарии выкидываем (так уже выходили холостые стражи: якорь цеплялся
// за цитату кода в комментарии).
const codeOnly = (source) => source
  .split(/\r?\n/)
  .filter((line) => !/^\s*\/\//.test(line))
  .map((line) => line.replace(/\/\*.*?\*\//g, '').replace(/\s\/\/\s.*$/, ''))
  .join('\n');

test('обвязка передаёт тостеру флаг taskNotification из payload статуса', () => {
  const code = codeOnly(IPC_JS);
  const calls = code.split('toaster.onStatus({').length - 1;
  assert.strictEqual(calls, 1, `ожидался ровно один вызов toaster.onStatus({ … }), найдено ${calls}`);
  const start = code.indexOf('toaster.onStatus({');
  const literal = code.slice(start, code.indexOf('})', start));
  // Якорь: вырезан именно объект вызова, а не что-то соседнее.
  assert.match(literal, /status:\s*payload\.status/, 'объект вызова тостера вырезан не тот');
  assert.match(
    literal,
    /taskNotification:\s*payload\.taskNotification/,
    'флаг taskNotification не доезжает до тостера — «готово» после фоновой задачи будет мериться от последнего хода',
  );
  assert.match(
    literal,
    /subtitle:\s*payload\.subtitle/,
    'подпись статуса не доезжает до тостера — в тосте «ответил · фон ещё работает» не будет видно, что именно работает',
  );
});
