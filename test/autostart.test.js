'use strict';
// Автозапуск. Проверяем ровно то, что легко перепутать: чем именно Windows
// будет запускать кокпит при входе — собранным exe или electron.exe с путём
// к проекту.
const { test } = require('node:test');
const assert = require('node:assert');
const { buildLoginItem } = require('../src/main/autostart');

test('собранное приложение стартует само собой, скрытым', () => {
  const item = buildLoginItem({
    packaged: true,
    execPath: 'C:\\Apps\\Cockpit.exe',
    appRoot: 'C:\\Apps',
  });
  assert.strictEqual(item.path, 'C:\\Apps\\Cockpit.exe');
  assert.deepStrictEqual(item.args, ['--hidden']);
});

test('в разработке electron.exe получает путь к проекту первым аргументом', () => {
  const item = buildLoginItem({
    packaged: false,
    execPath: 'C:\\proj\\node_modules\\electron\\dist\\electron.exe',
    appRoot: 'C:\\proj',
  });
  assert.strictEqual(item.path, 'C:\\proj\\node_modules\\electron\\dist\\electron.exe');
  assert.deepStrictEqual(item.args, ['C:\\proj', '--hidden'],
    'без пути к проекту electron.exe поднимет пустое окно, а не кокпит');
});
