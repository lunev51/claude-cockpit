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
