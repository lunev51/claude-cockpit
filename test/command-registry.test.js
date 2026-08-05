'use strict';
// Реестр команд: обработчики ipcMain становятся вызываемыми по имени, чтобы
// их мог позвать не только локальный renderer, но и сетевой клиент.
const test = require('node:test');
const assert = require('node:assert');
const { createCommandRegistry } = require('../src/main/command-registry');

function fakeIpcMain() {
  const handled = new Map();
  const oned = new Map();
  return {
    handled,
    oned,
    handle: (ch, fn) => handled.set(ch, fn),
    on: (ch, fn) => oned.set(ch, fn),
  };
}

test('handle: регистрирует и в ipcMain, и в реестре', async () => {
  const ipc = fakeIpcMain();
  const reg = createCommandRegistry({ ipcMain: ipc });
  reg.handle('tabs:open', async (opts) => ({ tabId: 'T1', cwd: opts.cwd }));

  assert.ok(ipc.handled.has('tabs:open'), 'локальный renderer должен работать как раньше');
  assert.deepStrictEqual(await reg.call('tabs:open', [{ cwd: 'C:\\proj' }]), { tabId: 'T1', cwd: 'C:\\proj' });
});

test('handle: вызов через ipcMain отбрасывает объект события', async () => {
  // Обработчики в ipc.js написаны как (event, payload) — обёртка обязана
  // скрыть event, иначе сетевой вызов с теми же аргументами разъедется с локальным.
  const ipc = fakeIpcMain();
  const reg = createCommandRegistry({ ipcMain: ipc });
  let got = null;
  reg.handle('tabs:close', async (tabId) => { got = tabId; return 'ok'; });

  const viaIpc = await ipc.handled.get('tabs:close')({ sender: 'фиктивное событие' }, 'T7');
  assert.strictEqual(got, 'T7');
  assert.strictEqual(viaIpc, 'ok');
});

test('on: команда без ответа тоже вызывается по имени', async () => {
  const ipc = fakeIpcMain();
  const reg = createCommandRegistry({ ipcMain: ipc });
  const seen = [];
  reg.on('term:write', (p) => seen.push(p));

  await reg.call('term:write', [{ tabId: 'T1', data: 'ls\r' }]);
  assert.deepStrictEqual(seen, [{ tabId: 'T1', data: 'ls\r' }]);

  // Симметрично handle-тесту выше: реестр обязан не только сам уметь звать
  // send-обработчик по имени (call), но и реально зарегистрировать его в
  // ipcMain.on — и так же отбросить объект события при вызове через ipcMain,
  // иначе локальный и сетевой путь незаметно разъедутся сигнатурами.
  const viaIpc = ipc.oned.get('term:write');
  assert.ok(viaIpc, 'send-канал обязан быть зарегистрирован и в ipcMain');
  viaIpc({ sender: 'фиктивное событие' }, { tabId: 'T2', data: 'pwd\r' });
  assert.deepStrictEqual(seen[1], { tabId: 'T2', data: 'pwd\r' }, 'объект события не должен доехать до обработчика');
});

test('call: неизвестная команда — понятная ошибка, а не тишина', async () => {
  const reg = createCommandRegistry({ ipcMain: fakeIpcMain() });
  await assert.rejects(() => reg.call('нет:такой', []), /неизвестная команда: нет:такой/);
});

test('names/has: реестр знает свой состав', () => {
  const reg = createCommandRegistry({ ipcMain: fakeIpcMain() });
  reg.handle('a:b', async () => 1);
  reg.on('c:d', () => {});
  assert.ok(reg.has('a:b'));
  assert.ok(reg.has('c:d'));
  assert.ok(!reg.has('нет'));
  assert.deepStrictEqual(reg.names().sort(), ['a:b', 'c:d']);
});

test('ошибка внутри обработчика доезжает до вызывающего, а не теряется', async () => {
  const reg = createCommandRegistry({ ipcMain: fakeIpcMain() });
  reg.handle('плохая:команда', async () => { throw new Error('внутри рвануло'); });
  await assert.rejects(() => reg.call('плохая:команда', []), /внутри рвануло/);
});

// --- Эстафета: гард записи -------------------------------------------------
// Гард стоит ЗДЕСЬ, а не в транспортах: локальный ipcMain и сетевой сокет оба
// приходят в реестр, и это единственная точка, где их нельзя развести по
// разным правилам. Тесты проверяют оба пути, потому что сломать можно любой.

test('гард отклоняет запись от того, у кого нет управления', async () => {
  const seen = [];
  const reg = createCommandRegistry({
    ipcMain: fakeIpcMain(),
    guard: ({ channel, who }) => !(channel === 'term:write' && who !== 'local'),
  });
  reg.handle('term:write', (payload) => { seen.push(payload); return 'ок'; });

  assert.strictEqual(await reg.call('term:write', ['от локального'], 'local'), 'ок');
  await assert.rejects(
    () => reg.call('term:write', ['от чужого'], 'c1'),
    (err) => err.denied === true,
  );
  assert.deepStrictEqual(seen, ['от локального'], 'обработчик не должен был увидеть чужой вызов');
});

test('who по умолчанию — локальное окно', async () => {
  const reg = createCommandRegistry({
    ipcMain: fakeIpcMain(),
    guard: ({ who }) => who === 'local',
  });
  reg.handle('term:write', () => 'ок');
  assert.strictEqual(await reg.call('term:write', ['x']), 'ок');
});

test('локальный invoke при отказе возвращает null, а не бросает в окно', async () => {
  const ipc = fakeIpcMain();
  const reg = createCommandRegistry({ ipcMain: ipc, guard: () => false });
  let called = false;
  reg.handle('term:write', () => { called = true; return 'ок'; });

  const result = await ipc.handled.get('term:write')({ sender: 'фиктивное событие' }, 'нагрузка');
  assert.strictEqual(result, null);
  assert.strictEqual(called, false, 'отказ обязан случиться ДО обработчика, а не после');
});

test('локальный send при отказе молчит', () => {
  const ipc = fakeIpcMain();
  const reg = createCommandRegistry({ ipcMain: ipc, guard: () => false });
  let called = false;
  reg.on('term:write', () => { called = true; });

  ipc.oned.get('term:write')({ sender: 'фиктивное событие' }, 'нагрузка');
  assert.strictEqual(called, false);
});

test('гард спрашивают на КАЖДЫЙ вызов, а не один раз при регистрации', async () => {
  // Владение меняется в рантайме: клиент, которому только что отказали,
  // через секунду может стать хозяином. Гард, опрошенный при handle(),
  // навсегда заморозил бы первое решение.
  let owner = 'local';
  const reg = createCommandRegistry({
    ipcMain: fakeIpcMain(),
    guard: ({ who }) => who === owner,
  });
  reg.handle('term:write', () => 'ок');

  await assert.rejects(() => reg.call('term:write', ['x'], 'c1'), (err) => err.denied === true);
  owner = 'c1';
  assert.strictEqual(await reg.call('term:write', ['x'], 'c1'), 'ок');
});

test('гард видит имя канала — иначе он не отличит чтение от записи', async () => {
  const asked = [];
  const reg = createCommandRegistry({
    ipcMain: fakeIpcMain(),
    guard: ({ channel, who }) => { asked.push({ channel, who }); return true; },
  });
  reg.handle('usage:get', () => 'ок');
  await reg.call('usage:get', [], 'c1');
  assert.deepStrictEqual(asked, [{ channel: 'usage:get', who: 'c1' }]);
});

test('без guard реестр работает как раньше', async () => {
  const reg = createCommandRegistry({ ipcMain: fakeIpcMain() });
  reg.handle('term:write', () => 'ок');
  assert.strictEqual(await reg.call('term:write', ['x'], 'кто-угодно'), 'ок');
});

test('отказ отличается от поломки: у него есть denied', async () => {
  // Сетевой транспорт по этому полю решает, показывать ошибку человеку или
  // промолчать (спека: отклонение молчаливое). Разбор текста сообщения был бы
  // хрупким — поле обязано быть.
  const reg = createCommandRegistry({ ipcMain: fakeIpcMain(), guard: () => false });
  reg.handle('term:write', () => 'ок');
  reg.handle('рвётся', () => { throw new Error('внутри рвануло'); });

  const denied = await reg.call('term:write', [], 'c1').catch((e) => e);
  assert.strictEqual(denied.denied, true);

  const broken = await createCommandRegistry({ ipcMain: fakeIpcMain() })
    .call('нет:такой', []).catch((e) => e);
  assert.strictEqual(broken.denied, undefined, 'обычная ошибка не должна выглядеть отказом эстафеты');
});
