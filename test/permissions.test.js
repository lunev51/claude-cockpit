'use strict';
// Какие разрешения окно кокпита выдаёт странице. Чистый модуль, потому что
// сам обработчик живёт в main.js, который под node --test не идёт, — а цена
// ошибки здесь высокая в обе стороны: лишнее разрешение открывает камеру и
// геолокацию недоверенному выводу терминала, недостающее молча ломает фичу.
//
// Живая история: обработчик писался в фазе 9 под микрофон и разрешал ТОЛЬКО
// его. Пользователь: «не работает Ctrl+V… и Ctrl+Shift+V тоже». Замер
// отдельным Electron-приложением (scratchpad/paste-lab):
//   с обработчиком кокпита -> NotAllowedError: Read permission denied
//   без обработчика        -> "PASTE_PROBE_12345"
// То есть вставка из буфера (Ctrl+Shift+V и правый клик) была мертва целиком,
// а navigator.permissions.query при этом отвечал 'granted' — по нему баг не
// диагностируется.
const { test } = require('node:test');
const assert = require('node:assert');
const { decidePermission } = require('../src/main/permissions');

test('микрофон разрешён — на нём держится голосовой ввод', () => {
  assert.strictEqual(decidePermission('media', { mediaTypes: ['audio'] }), true);
});

test('камера запрещена, даже когда просят вместе с микрофоном', () => {
  // В Electron 29 разрешение 'media' покрывает и микрофон, и камеру одним
  // именем — проверки одного имени недостаточно.
  assert.strictEqual(decidePermission('media', { mediaTypes: ['video'] }), false);
  assert.strictEqual(decidePermission('media', { mediaTypes: ['audio', 'video'] }), false);
});

test('чтение буфера обмена разрешено — без него вставка мертва', () => {
  assert.strictEqual(decidePermission('clipboard-read', {}), true);
  assert.strictEqual(decidePermission('clipboard-sanitized-write', {}), true);
});

test('всё остальное запрещено — терминал рендерит недоверенный вывод', () => {
  for (const permission of [
    'geolocation', 'notifications', 'midi', 'midiSysex', 'pointerLock',
    'fullscreen', 'openExternal', 'window-management', 'display-capture',
    'idle-detection', 'serial', 'hid', 'usb', 'bluetooth',
  ]) {
    assert.strictEqual(decidePermission(permission, {}), false, `${permission} не должен разрешаться`);
  }
});

test('незнакомое разрешение запрещено', () => {
  assert.strictEqual(decidePermission('какое-то-новое-в-будущем', {}), false);
});

test('details может отсутствовать вовсе', () => {
  // Electron зовёт обработчик и без details. Поведение сохраняем прежним
  // (иначе сломается уже принятый пользователем голосовой ввод): media без
  // списка типов — это запрос микрофона, камера в нём назвалась бы явно.
  assert.strictEqual(decidePermission('media', undefined), true);
  assert.strictEqual(decidePermission('clipboard-read', undefined), true);
  assert.strictEqual(decidePermission('geolocation', undefined), false);
});
