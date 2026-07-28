'use strict';
// Смоук-гейт git:get/gh:repo/gh:global (п.4 брифа задачи 5 фазы 7, carryover
// ревью фазы 6, находка 3): раньше эта проверка (`if (smoke) return null;`)
// жила прямо внутри ipcMain.handle() в ipc.js — ipc.js целиком не тестируется
// (require('electron') вне настоящего Electron-рантайма отдаёт не объект, а
// строку пути к бинарнику, ipcMain/app там undefined), поэтому удаление гейта
// прошло бы зелёным, ни один тест бы не заметил. gitGetHandler/ghRepoHandler/
// ghGlobalHandler — ЭТО ТА ЖЕ логика, что реально исполняется в проде
// (registerIpc() в ipc.js просто вызывает их с реальными зависимостями), но
// вынесенная в отдельные функции с явными параметрами — требовать ipc.js
// под node --test безопасно (см. ниже), а звать эти три функции напрямую —
// тем более: ни Electron, ни child_process тут вообще не нужны.

const test = require('node:test');
const assert = require('node:assert');
const { gitGetHandler, ghRepoHandler, ghGlobalHandler } = require('../src/main/ipc');

// gitInfo/ghInfo-заглушки, которые ПАДАЮТ, если их дёрнули: смоук-гейт по
// контракту (бриф фазы, глобальное ограничение «в smoke не спавнить процессы»)
// обязан вернуть null РАНЬШЕ, чем логика дойдёт до реального запроса — эти
// заглушки делают регрессию (случайное удаление `if (smoke) return null;`)
// красной, а не просто «возвращает не то значение».
function throwingGitInfo() {
  return { get: () => { throw new Error('gitInfo.get НЕ должен был вызваться в smoke'); } };
}

function throwingGhInfo() {
  return {
    getRepo: () => { throw new Error('ghInfo.getRepo НЕ должен был вызваться в smoke'); },
    getGlobal: () => { throw new Error('ghInfo.getGlobal НЕ должен был вызваться в smoke'); },
  };
}

function fakeTabCwd(map) {
  return (tabId) => (Object.prototype.hasOwnProperty.call(map, tabId) ? map[tabId] : null);
}

// ------------------------------------------------------------- gitGetHandler --

test('gitGetHandler: smoke:true → null, gitInfo.get НИКОГДА не вызывается, даже если вкладка реальная', () => {
  const res = gitGetHandler({
    smoke: true,
    tabId: 'tab-1',
    opts: {},
    tabCwd: fakeTabCwd({ 'tab-1': 'C:\\proj' }),
    gitInfo: throwingGitInfo(),
  });
  assert.strictEqual(res, null);
});

test('gitGetHandler: smoke:false, валидная вкладка → зовёт gitInfo.get(cwd, {force}) и отдаёт его результат', () => {
  const calls = [];
  const gitInfo = { get: (cwd, o) => { calls.push({ cwd, o }); return { ok: true, cwd }; } };
  const res = gitGetHandler({
    smoke: false, tabId: 'tab-1', opts: { force: true }, tabCwd: fakeTabCwd({ 'tab-1': 'C:\\proj' }), gitInfo,
  });
  assert.deepStrictEqual(res, { ok: true, cwd: 'C:\\proj' });
  assert.deepStrictEqual(calls, [{ cwd: 'C:\\proj', o: { force: true } }]);
});

test('gitGetHandler: smoke:false, но tabId не строка/вкладка не найдена → null, gitInfo.get не вызывается', () => {
  const gitInfo = throwingGitInfo();
  assert.strictEqual(gitGetHandler({
    smoke: false, tabId: 42, opts: {}, tabCwd: fakeTabCwd({}), gitInfo,
  }), null);
  assert.strictEqual(gitGetHandler({
    smoke: false, tabId: 'unknown', opts: {}, tabCwd: fakeTabCwd({}), gitInfo,
  }), null);
});

// ------------------------------------------------------------- ghRepoHandler --

test('ghRepoHandler: smoke:true → null, ghInfo.getRepo НИКОГДА не вызывается', () => {
  const res = ghRepoHandler({
    smoke: true, tabId: 'tab-1', opts: {}, tabCwd: fakeTabCwd({ 'tab-1': 'C:\\proj' }), ghInfo: throwingGhInfo(),
  });
  assert.strictEqual(res, null);
});

test('ghRepoHandler: smoke:false, валидная вкладка → зовёт ghInfo.getRepo(cwd, {force})', () => {
  const calls = [];
  const ghInfo = { getRepo: (cwd, o) => { calls.push({ cwd, o }); return { ok: true, repo: 'me/r' }; } };
  const res = ghRepoHandler({
    smoke: false, tabId: 'tab-1', opts: {}, tabCwd: fakeTabCwd({ 'tab-1': 'C:\\proj' }), ghInfo,
  });
  assert.deepStrictEqual(res, { ok: true, repo: 'me/r' });
  assert.deepStrictEqual(calls, [{ cwd: 'C:\\proj', o: { force: false } }]);
});

test('ghRepoHandler: вкладка не найдена → null, ghInfo.getRepo не вызывается', () => {
  assert.strictEqual(ghRepoHandler({
    smoke: false, tabId: 'ghost', opts: {}, tabCwd: fakeTabCwd({}), ghInfo: throwingGhInfo(),
  }), null);
});

// ----------------------------------------------------------- ghGlobalHandler --

test('ghGlobalHandler: smoke:true → null, ghInfo.getGlobal НИКОГДА не вызывается', () => {
  const res = ghGlobalHandler({ smoke: true, opts: {}, ghInfo: throwingGhInfo() });
  assert.strictEqual(res, null);
});

test('ghGlobalHandler: smoke:false → зовёт ghInfo.getGlobal({force}) и отдаёт его результат', () => {
  const calls = [];
  const ghInfo = { getGlobal: (o) => { calls.push(o); return { ok: true, prs: [] }; } };
  const res = ghGlobalHandler({ smoke: false, opts: { force: true }, ghInfo });
  assert.deepStrictEqual(res, { ok: true, prs: [] });
  assert.deepStrictEqual(calls, [{ force: true }]);
});

// Minor 3 (ревью раунд 1): тест "ipc.js require()-ится под plain node без
// падения" отсюда убран — у него не было собственного режима падения. Если
// бы верхнеуровневый require('../src/main/ipc') на строке 14 этого же файла
// когда-нибудь начал бросать (кто-то допишет top-level вызов ipcMain.xxx),
// весь ЭТОТ файл упал бы на ЗАГРУЗКЕ раньше, чем node:test дошёл бы до
// регистрации хоть одного test() — включая сам этот тест, который поэтому
// никогда не смог бы стать источником сигнала о поломке. Гарантия («весь
// код, трогающий ipcMain/app/dialog/clipboard, живёт внутри функций, а не на
// верхнем уровне модуля») по-прежнему в силе и по-прежнему проверяется —
// просто НЕЯВНО, самим фактом того, что require на строке 14 (и вообще любой
// тест в этом файле) продолжает выполняться.
