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
const {
  gitGetHandler, ghRepoHandler, ghGlobalHandler,
  historySearchHandler, historyRefreshHandler, createHistoryIndexState, HISTORY_INDEX_TTL_MS,
  recipesListHandler, recipesSavePromptHandler, recipesDeletePromptHandler,
  recipesListWorkspacesHandler, recipesSaveWorkspaceHandler, recipesDeleteWorkspaceHandler,
} = require('../src/main/ipc');

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

// --------------------------------------------------------- historySearchHandler --
// «Дыра тестов №1» (ревью финальной волны фазы 7): history:search добавлен в
// ЭТОЙ ЖЕ ветке (Task 3 фазы 7) с тем же классом смоук-гейта, что git:get/
// gh:repo/gh:global, но остался без единого теста — удаление гейта прошло бы
// зелёным и заставило бы smoke обходить ~/.claude/projects. Плюс покрытие
// TTL-фикса I5 (индекс больше не строится РОВНО ОДИН РАЗ за жизнь окна).

function throwingHistoryIndex() {
  return {
    refresh: () => { throw new Error('historyIndex.refresh НЕ должен был вызваться в smoke'); },
    search: () => { throw new Error('historyIndex.search НЕ должен был вызваться в smoke'); },
  };
}

function fakeHistoryIndex({ entries = [], results = [] } = {}) {
  const calls = { refresh: 0, search: 0 };
  return {
    calls,
    refresh: async () => { calls.refresh += 1; return entries; },
    search: async (query, opts) => { calls.search += 1; return results; },
  };
}

test('historySearchHandler: smoke:true → null, historyIndex.refresh/search НИКОГДА не вызываются', async () => {
  const state = createHistoryIndexState();
  const res = await historySearchHandler({
    smoke: true, query: 'x', opts: {}, state, historyIndex: throwingHistoryIndex(),
  });
  assert.strictEqual(res, null);
});

test('historySearchHandler: индекс ещё ни разу не строился (builtAt:0) → сначала refresh(), потом search(), indexSize из refresh()', async () => {
  const state = createHistoryIndexState();
  const historyIndex = fakeHistoryIndex({ entries: [{ a: 1 }, { a: 2 }], results: [{ hit: true }] });
  const res = await historySearchHandler({
    smoke: false, query: 'x', opts: {}, state, historyIndex, now: () => 1000,
  });
  assert.deepStrictEqual(res, { results: [{ hit: true }], indexSize: 2 });
  assert.strictEqual(historyIndex.calls.refresh, 1);
  assert.strictEqual(historyIndex.calls.search, 1);
  assert.strictEqual(state.builtAt, 1000);
});

test('historySearchHandler: индекс свежий (builtAt внутри TTL) → refresh() НЕ зовётся повторно, только search()', async () => {
  const state = { builtAt: 1000, size: 5, buildInFlight: null };
  const historyIndex = fakeHistoryIndex({ results: [] });
  const now = () => 1000 + HISTORY_INDEX_TTL_MS - 1; // на грани, ещё не протух
  const res = await historySearchHandler({
    smoke: false, query: 'x', opts: {}, state, historyIndex, now,
  });
  assert.strictEqual(historyIndex.calls.refresh, 0, 'refresh() не должен был вызваться — индекс ещё свежий');
  assert.strictEqual(historyIndex.calls.search, 1);
  assert.strictEqual(res.indexSize, 5, 'indexSize должен остаться прежним (state.size), раз refresh() не звался');
});

test('historySearchHandler: I5 — индекс протух (builtAt старше TTL) → refresh() зовётся заново перед search()', async () => {
  const state = { builtAt: 1000, size: 5, buildInFlight: null };
  const historyIndex = fakeHistoryIndex({ entries: [{ a: 1 }], results: [] });
  const now = () => 1000 + HISTORY_INDEX_TTL_MS + 1; // строго протух
  const res = await historySearchHandler({
    smoke: false, query: 'x', opts: {}, state, historyIndex, now,
  });
  assert.strictEqual(historyIndex.calls.refresh, 1, 'протухший индекс должен был пересобраться (I5)');
  assert.strictEqual(res.indexSize, 1, 'indexSize должен обновиться из свежего refresh()');
  assert.strictEqual(state.builtAt, now());
});

test('historySearchHandler: single-flight переживает TTL-фикс — два параллельных вызова на протухшем индексе делят ОДИН refresh()', async () => {
  const state = { builtAt: 1000, size: 0, buildInFlight: null };
  let refreshCalls = 0;
  let resolveRefresh;
  const historyIndex = {
    refresh: () => {
      refreshCalls += 1;
      return new Promise((resolve) => { resolveRefresh = () => resolve([{ a: 1 }, { a: 2 }, { a: 3 }]); });
    },
    search: async () => [],
  };
  const now = () => 1000 + HISTORY_INDEX_TTL_MS + 1;
  const p1 = historySearchHandler({
    smoke: false, query: 'x', opts: {}, state, historyIndex, now,
  });
  const p2 = historySearchHandler({
    smoke: false, query: 'y', opts: {}, state, historyIndex, now,
  });
  // Даём микрозадачам обоих вызовов дойти до await state.buildInFlight, ПОТОМ
  // разрешаем refresh() — если бы второй вызов запустил СВОЙ refresh(),
  // refreshCalls было бы 2 к этому моменту уже сейчас.
  await Promise.resolve();
  await Promise.resolve();
  assert.strictEqual(refreshCalls, 1, 'второй параллельный вызов не должен был запустить свой refresh()');
  resolveRefresh();
  const [res1, res2] = await Promise.all([p1, p2]);
  assert.strictEqual(res1.indexSize, 3);
  assert.strictEqual(res2.indexSize, 3);
});

// -------------------------------------------------------- historyRefreshHandler --

test('historyRefreshHandler: smoke:true → null, historyIndex.refresh НИКОГДА не вызывается', async () => {
  const state = createHistoryIndexState();
  const res = await historyRefreshHandler({ smoke: true, opts: {}, state, historyIndex: throwingHistoryIndex() });
  assert.strictEqual(res, null);
});

test('historyRefreshHandler: smoke:false → зовёт historyIndex.refresh({force}), обновляет state.builtAt/size, отдаёт entries', async () => {
  const state = createHistoryIndexState();
  const calls = [];
  const historyIndex = {
    refresh: async (opts) => { calls.push(opts); return [{ a: 1 }]; },
  };
  const res = await historyRefreshHandler({
    smoke: false, opts: { force: true }, state, historyIndex, now: () => 4242,
  });
  assert.deepStrictEqual(res, [{ a: 1 }]);
  assert.deepStrictEqual(calls, [{ force: true }]);
  assert.strictEqual(state.builtAt, 4242);
  assert.strictEqual(state.size, 1);
});

// ------------------------------------------------------------ recipes:* handlers --
// «Дыра тестов №1»: recipes:* добавлены в ЭТОЙ ЖЕ ветке (Task 4 фазы 7) с тем
// же классом смоук-гейта — тоже остались без единого теста.

function throwingRecipeStore() {
  const boom = (name) => () => { throw new Error(`recipeStore.${name} НЕ должен был вызваться в smoke`); };
  return {
    listPrompts: boom('listPrompts'),
    savePrompt: boom('savePrompt'),
    deletePrompt: boom('deletePrompt'),
    listWorkspaces: boom('listWorkspaces'),
    saveWorkspace: boom('saveWorkspace'),
    deleteWorkspace: boom('deleteWorkspace'),
  };
}

test('recipesListHandler: smoke:true → [], recipeStore.listPrompts НИКОГДА не вызывается', () => {
  const res = recipesListHandler({ smoke: true, recipeStore: throwingRecipeStore() });
  assert.deepStrictEqual(res, []);
});

test('recipesListHandler: smoke:false → отдаёт listPrompts() с посчитанными placeholders', () => {
  const recipeStore = { listPrompts: () => [{ id: '1', title: 't', text: 'привет {{имя}}' }] };
  const res = recipesListHandler({ smoke: false, recipeStore });
  assert.deepStrictEqual(res, [{ id: '1', title: 't', text: 'привет {{имя}}', placeholders: ['имя'] }]);
});

test('recipesSavePromptHandler: smoke:true → null, recipeStore.savePrompt НИКОГДА не вызывается', () => {
  const res = recipesSavePromptHandler({ smoke: true, recipe: { title: 't', text: 'x' }, recipeStore: throwingRecipeStore() });
  assert.strictEqual(res, null);
});

test('recipesSavePromptHandler: smoke:false → зовёт recipeStore.savePrompt(recipe)', () => {
  const calls = [];
  const recipeStore = { savePrompt: (p) => { calls.push(p); return { id: '1', ...p }; } };
  const res = recipesSavePromptHandler({ smoke: false, recipe: { title: 't', text: 'x' }, recipeStore });
  assert.deepStrictEqual(res, { id: '1', title: 't', text: 'x' });
  assert.deepStrictEqual(calls, [{ title: 't', text: 'x' }]);
});

test('recipesDeletePromptHandler: smoke:true → recipeStore.deletePrompt НИКОГДА не вызывается', () => {
  assert.doesNotThrow(() => recipesDeletePromptHandler({ smoke: true, id: '1', recipeStore: throwingRecipeStore() }));
});

test('recipesDeletePromptHandler: smoke:false, валидный id → зовёт recipeStore.deletePrompt(id)', () => {
  const calls = [];
  const recipeStore = { deletePrompt: (id) => calls.push(id) };
  recipesDeletePromptHandler({ smoke: false, id: '1', recipeStore });
  assert.deepStrictEqual(calls, ['1']);
});

test('recipesListWorkspacesHandler: smoke:true → [], recipeStore.listWorkspaces НИКОГДА не вызывается', () => {
  const res = recipesListWorkspacesHandler({ smoke: true, recipeStore: throwingRecipeStore() });
  assert.deepStrictEqual(res, []);
});

test('recipesListWorkspacesHandler: smoke:false → отдаёт recipeStore.listWorkspaces()', () => {
  const recipeStore = { listWorkspaces: () => [{ id: '1', name: 'w', tabs: [] }] };
  const res = recipesListWorkspacesHandler({ smoke: false, recipeStore });
  assert.deepStrictEqual(res, [{ id: '1', name: 'w', tabs: [] }]);
});

test('recipesSaveWorkspaceHandler: smoke:true → null, recipeStore.saveWorkspace НИКОГДА не вызывается', () => {
  const res = recipesSaveWorkspaceHandler({
    smoke: true, name: 'w', tabs: [], recipeStore: throwingRecipeStore(),
  });
  assert.strictEqual(res, null);
});

test('recipesSaveWorkspaceHandler: smoke:false → зовёт recipeStore.saveWorkspace(name, tabs)', () => {
  const calls = [];
  const recipeStore = { saveWorkspace: (name, tabs) => { calls.push({ name, tabs }); return { id: '1', name, tabs }; } };
  const res = recipesSaveWorkspaceHandler({
    smoke: false, name: 'w', tabs: [{ cwd: 'C:\\p', name: 'p' }], recipeStore,
  });
  assert.deepStrictEqual(res, { id: '1', name: 'w', tabs: [{ cwd: 'C:\\p', name: 'p' }] });
  assert.deepStrictEqual(calls, [{ name: 'w', tabs: [{ cwd: 'C:\\p', name: 'p' }] }]);
});

test('recipesDeleteWorkspaceHandler: smoke:true → recipeStore.deleteWorkspace НИКОГДА не вызывается', () => {
  assert.doesNotThrow(() => recipesDeleteWorkspaceHandler({ smoke: true, id: '1', recipeStore: throwingRecipeStore() }));
});

test('recipesDeleteWorkspaceHandler: smoke:false, валидный id → зовёт recipeStore.deleteWorkspace(id)', () => {
  const calls = [];
  const recipeStore = { deleteWorkspace: (id) => calls.push(id) };
  recipesDeleteWorkspaceHandler({ smoke: false, id: '1', recipeStore });
  assert.deepStrictEqual(calls, ['1']);
});
