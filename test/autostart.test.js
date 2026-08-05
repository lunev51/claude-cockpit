'use strict';
// Автозапуск. Проверяем ровно то, что легко перепутать: чем именно Windows
// будет запускать кокпит при входе — собранным exe или electron.exe с путём
// к проекту.
const { test } = require('node:test');
const assert = require('node:assert');
const { buildLoginItem, isAutostartOn } = require('../src/main/autostart');

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

// --- C3 (ревью): включён ли автозапуск НА САМОМ ДЕЛЕ ---
// Формы ответа ниже — не выдумка, а живой вывод app.getLoginItemSettings()
// в Electron 29 на Windows 10, снятый ревьюером отдельным приложением.

test('запись в реестре есть: openAtLogin врёт false, честный признак — executableWillLaunchAtLogin', () => {
  // Ровно тот ответ, который получал ревьюер при СУЩЕСТВУЮЩЕЙ записи в
  // HKCU\...\Run: парсер Electron потерял аргумент '--hidden' (в launchItems
  // args приехал только путь к проекту), сравнение с ожидаемыми args не
  // сошлось — и openAtLogin вышел false при живой записи.
  const settings = {
    openAtLogin: false,
    openAsHidden: false,
    wasOpenedAtLogin: false,
    wasOpenedAsHidden: false,
    restoreState: false,
    executableWillLaunchAtLogin: true,
    launchItems: [{
      name: 'com.lunev.claude-cockpit',
      path: 'C:\\proj\\node_modules\\electron\\dist\\electron.exe',
      args: ['C:\\proj'],
      scope: 'user',
      enabled: true,
    }],
  };
  assert.strictEqual(isAutostartOn(settings), true,
    'на openAtLogin полагаться нельзя: галочка вечно выглядела выключенной, и выключить автозапуск было невозможно');
});

test('записи в реестре нет — выключено', () => {
  assert.strictEqual(isAutostartOn({
    openAtLogin: false,
    executableWillLaunchAtLogin: false,
    launchItems: [],
  }), false);
});

test('пункт есть, но отключён в диспетчере задач — считаем выключенным', () => {
  // Windows умеет деактивировать запись Run, не удаляя её (StartupApproved).
  // executableWillLaunchAtLogin это учитывает — Windows кокпит НЕ запустит.
  assert.strictEqual(isAutostartOn({
    openAtLogin: true,
    executableWillLaunchAtLogin: false,
    launchItems: [{
      name: 'com.lunev.claude-cockpit',
      path: 'C:\\proj\\node_modules\\electron\\dist\\electron.exe',
      args: ['C:\\proj'],
      scope: 'user',
      enabled: false,
    }],
  }), false);
});

// --- I3 (ре-ревью): признаки должны РАСХОДИТЬСЯ, иначе приоритет не проверен ---
// Ревьюер заменил первую ветку (executableWillLaunchAtLogin) на `if (false)` —
// и весь test/autostart.test.js остался зелёным, потому что ни в одном
// случае выше executableWillLaunchAtLogin не расходится с тем, что даёт
// разбор launchItems/openAtLogin: либо оба говорят одно и то же, либо
// launchItems пуст и функция всё равно проваливается туда же через
// openAtLogin. Ниже — случаи, где первый признак единственный источник
// правды, а остальные два врут в другую сторону.

test('I3: executableWillLaunchAtLogin=true перевешивает launchItems/openAtLogin, говорящие "выключено"', () => {
  // Реальная форма ответа Windows с нашим --hidden (см. разбор в autostart.js):
  // Windows запустит exe, но и launchItems, и openAtLogin утверждают обратное.
  // Если приоритет сломан (первая ветка отключена), функция провалится в
  // разбор launchItems и наврёт "выключено" — ровно тот баг, который чинили.
  const settings = {
    openAtLogin: false,
    executableWillLaunchAtLogin: true,
    launchItems: [{
      name: 'com.lunev.claude-cockpit',
      path: 'C:\\proj\\node_modules\\electron\\dist\\electron.exe',
      args: ['C:\\proj'],
      scope: 'user',
      enabled: false,
    }],
  };
  assert.strictEqual(isAutostartOn(settings), true,
    'executableWillLaunchAtLogin честный признак — он обязан победить, даже когда остальные два врут');
});

test('I3: executableWillLaunchAtLogin=false перевешивает launchItems/openAtLogin, говорящие "включено"', () => {
  // Обратный случай: Windows точно НЕ запустит exe (например, StartupApproved
  // деактивировала запись так, что Electron этого не видит иначе), а
  // launchItems и openAtLogin говорят "включено". Честный признак обязан
  // победить и здесь — иначе галочка в трее покажет "включено" для записи,
  // которая реально не сработает.
  const settings = {
    openAtLogin: true,
    executableWillLaunchAtLogin: false,
    launchItems: [{
      name: 'com.lunev.claude-cockpit',
      path: 'C:\\proj\\node_modules\\electron\\dist\\electron.exe',
      args: ['C:\\proj'],
      scope: 'user',
      enabled: true,
    }],
  };
  assert.strictEqual(isAutostartOn(settings), false,
    'executableWillLaunchAtLogin честный признак — он обязан победить, даже когда остальные два врут');
});

test('без Windows-полей решает openAtLogin', () => {
  // macOS/Linux: executableWillLaunchAtLogin там нет вовсе, launchItems тоже.
  assert.strictEqual(isAutostartOn({ openAtLogin: true }), true);
  assert.strictEqual(isAutostartOn({ openAtLogin: false }), false);
});

test('запись нашлась только в launchItems — этого достаточно', () => {
  // Подстраховка на случай сборки Electron, где executableWillLaunchAtLogin
  // не отдаётся: разбор launchItems даёт тот же ответ.
  assert.strictEqual(isAutostartOn({
    openAtLogin: false,
    launchItems: [{
      name: 'com.lunev.claude-cockpit',
      path: 'C:\\Apps\\Cockpit.exe',
      args: [],
      scope: 'user',
      enabled: true,
    }],
  }), true);
});

test('мусор вместо настроек не роняет и не включает галочку', () => {
  assert.strictEqual(isAutostartOn(null), false);
  assert.strictEqual(isAutostartOn(undefined), false);
  assert.strictEqual(isAutostartOn('да'), false);
  assert.strictEqual(isAutostartOn({}), false);
});
