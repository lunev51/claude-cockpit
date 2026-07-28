'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRecipeStore, extractPlaceholders, fillPrompt } = require('../src/main/recipes');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-recipes-'));
}

function tmpFiles() {
  const dir = tmpDir();
  return {
    promptsFile: path.join(dir, 'prompts.json'),
    workspacesFile: path.join(dir, 'workspaces.json'),
  };
}

// --- extractPlaceholders ---

test('extractPlaceholders: несколько разных плейсхолдеров, в порядке появления', () => {
  const text = 'Обнови {{пакет}} до версии из {{файл}}';
  assert.deepStrictEqual(extractPlaceholders(text), ['пакет', 'файл']);
});

test('extractPlaceholders: повтор одного и того же имени схлопывается в одну запись', () => {
  const text = '{{имя}} и снова {{имя}}, а ещё {{другое}}';
  assert.deepStrictEqual(extractPlaceholders(text), ['имя', 'другое']);
});

test('extractPlaceholders: отсутствие плейсхолдеров → []', () => {
  assert.deepStrictEqual(extractPlaceholders('обычный текст без плейсхолдеров'), []);
});

test('extractPlaceholders: не-строка/пустая строка → []', () => {
  assert.deepStrictEqual(extractPlaceholders(''), []);
  assert.deepStrictEqual(extractPlaceholders(null), []);
  assert.deepStrictEqual(extractPlaceholders(undefined), []);
});

test('extractPlaceholders: пробелы внутри плейсхолдера не входят в имя', () => {
  assert.deepStrictEqual(extractPlaceholders('{{ пакет }}'), ['пакет']);
});

// --- fillPrompt ---

test('fillPrompt: подставляет значения по имени', () => {
  const text = 'Обнови зависимости в {{пакет}}';
  assert.strictEqual(fillPrompt(text, { пакет: 'lodash' }), 'Обнови зависимости в lodash');
});

test('fillPrompt: отсутствующее значение → пустая строка, а не сам плейсхолдер', () => {
  const text = 'Объясни, что делает {{файл}}';
  assert.strictEqual(fillPrompt(text, {}), 'Объясни, что делает ');
  assert.strictEqual(fillPrompt(text, { другое: 'x' }), 'Объясни, что делает ');
});

test('fillPrompt: values не объект → все плейсхолдеры пустые, не бросает', () => {
  assert.strictEqual(fillPrompt('{{a}}-{{b}}', null), '-');
  assert.strictEqual(fillPrompt('{{a}}-{{b}}', undefined), '-');
});

test('fillPrompt: несколько разных плейсхолдеров подставляются независимо', () => {
  const text = '{{a}} и {{b}} и снова {{a}}';
  assert.strictEqual(fillPrompt(text, { a: '1', b: '2' }), '1 и 2 и снова 1');
});

test('fillPrompt: текст без плейсхолдеров возвращается как есть', () => {
  assert.strictEqual(fillPrompt('просто текст', { x: '1' }), 'просто текст');
});

// --- CRUD промптов ---

test('listPrompts: файла нет → []', () => {
  const { promptsFile, workspacesFile } = tmpFiles();
  const store = createRecipeStore({ promptsFile, workspacesFile });
  assert.deepStrictEqual(store.listPrompts(), []);
});

test('savePrompt без id создаёт новую запись с минченным id; listPrompts её видит', () => {
  const { promptsFile, workspacesFile } = tmpFiles();
  const store = createRecipeStore({ promptsFile, workspacesFile });
  const saved = store.savePrompt({ title: 'Тест', text: 'Текст {{x}}' });
  assert.ok(saved && typeof saved.id === 'string' && saved.id);
  assert.strictEqual(saved.title, 'Тест');
  const list = store.listPrompts();
  assert.strictEqual(list.length, 1);
  assert.deepStrictEqual(list[0], saved);
});

test('savePrompt с существующим id обновляет запись на месте (не дублирует)', () => {
  const { promptsFile, workspacesFile } = tmpFiles();
  const store = createRecipeStore({ promptsFile, workspacesFile });
  const saved = store.savePrompt({ title: 'Первое', text: 'A' });
  const updated = store.savePrompt({ id: saved.id, title: 'Второе', text: 'B' });
  assert.strictEqual(updated.id, saved.id);
  const list = store.listPrompts();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].title, 'Второе');
});

test('savePrompt с некорректным входом (нет title/text) → null, ничего не пишет', () => {
  const { promptsFile, workspacesFile } = tmpFiles();
  const store = createRecipeStore({ promptsFile, workspacesFile });
  assert.strictEqual(store.savePrompt({ title: 'без текста' }), null);
  assert.strictEqual(store.savePrompt(null), null);
  assert.strictEqual(fs.existsSync(promptsFile), false);
});

test('deletePrompt удаляет запись по id; неизвестный id — no-op, не бросает', () => {
  const { promptsFile, workspacesFile } = tmpFiles();
  const store = createRecipeStore({ promptsFile, workspacesFile });
  const a = store.savePrompt({ title: 'A', text: 'a' });
  const b = store.savePrompt({ title: 'B', text: 'b' });
  store.deletePrompt(a.id);
  const list = store.listPrompts();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].id, b.id);
  assert.doesNotThrow(() => store.deletePrompt('нет-такого-id'));
});

// --- Устойчивость к повреждению (prompts.json) ---

test('битый prompts.json → listPrompts() пуст, не бросает', () => {
  const { promptsFile, workspacesFile } = tmpFiles();
  fs.writeFileSync(promptsFile, '{broken json', 'utf8');
  const store = createRecipeStore({ promptsFile, workspacesFile });
  assert.deepStrictEqual(store.listPrompts(), []);
});

test('битый prompts.json: .bak создаётся ИМЕННО при первой записи поверх него, с исходным содержимым', () => {
  const { promptsFile, workspacesFile } = tmpFiles();
  const original = '{this is not valid json at all';
  fs.writeFileSync(promptsFile, original, 'utf8');
  const store = createRecipeStore({ promptsFile, workspacesFile });

  assert.strictEqual(fs.existsSync(`${promptsFile}.bak`), false); // ещё не писали — бэкапа нет

  const saved = store.savePrompt({ title: 'Новый', text: 'текст' });
  assert.ok(saved);

  assert.strictEqual(fs.readFileSync(`${promptsFile}.bak`, 'utf8'), original);
  const list = store.listPrompts();
  assert.deepStrictEqual(list, [saved]); // новый файл валиден и содержит только новую запись

  // Вторая запись НЕ должна снова перезаписать .bak — файл после первой
  // записи уже валиден, .bak остаётся тем же битым снимком.
  store.savePrompt({ title: 'Ещё один', text: 'y' });
  assert.strictEqual(fs.readFileSync(`${promptsFile}.bak`, 'utf8'), original);
});

test('невалидная форма prompts.json (не массив/элементы без нужных полей) → тоже пусто и бэкапится', () => {
  const { promptsFile, workspacesFile } = tmpFiles();
  fs.writeFileSync(promptsFile, JSON.stringify([{ id: 'x' }]), 'utf8'); // нет title/text
  const store = createRecipeStore({ promptsFile, workspacesFile });
  assert.deepStrictEqual(store.listPrompts(), []);
  store.savePrompt({ title: 'A', text: 'a' });
  assert.ok(fs.existsSync(`${promptsFile}.bak`));
});

// --- ensureDefaultPrompts ---

test('ensureDefaultPrompts: файла нет → засевает 4 дефолтных рецепта', () => {
  const { promptsFile, workspacesFile } = tmpFiles();
  const store = createRecipeStore({ promptsFile, workspacesFile });
  store.ensureDefaultPrompts();
  const list = store.listPrompts();
  assert.strictEqual(list.length, 4);
  assert.ok(list.every((p) => typeof p.id === 'string' && p.id));
  assert.ok(list.some((p) => p.text.includes('{{пакет}}')));
});

test('ensureDefaultPrompts: файл уже существует (в т.ч. пустой список) → не трогает', () => {
  const { promptsFile, workspacesFile } = tmpFiles();
  fs.writeFileSync(promptsFile, '[]', 'utf8');
  const store = createRecipeStore({ promptsFile, workspacesFile });
  store.ensureDefaultPrompts();
  assert.deepStrictEqual(store.listPrompts(), []); // пользователь удалил всё — не реанимируем дефолты
});

// --- CRUD воркспейсов ---

test('listWorkspaces: файла нет → []', () => {
  const { promptsFile, workspacesFile } = tmpFiles();
  const store = createRecipeStore({ promptsFile, workspacesFile });
  assert.deepStrictEqual(store.listWorkspaces(), []);
});

test('saveWorkspace создаёт запись с id, именем и составом вкладок', () => {
  const { promptsFile, workspacesFile } = tmpFiles();
  const store = createRecipeStore({ promptsFile, workspacesFile });
  const tabs = [{ cwd: 'C:\\proj\\a', name: 'a' }, { cwd: 'C:\\proj\\b', name: 'b' }];
  const saved = store.saveWorkspace('Мой воркспейс', tabs);
  assert.ok(saved && typeof saved.id === 'string' && saved.id);
  assert.strictEqual(saved.name, 'Мой воркспейс');
  assert.deepStrictEqual(saved.tabs, tabs);
  assert.deepStrictEqual(store.listWorkspaces(), [saved]);
});

test('saveWorkspace: вкладки без cwd отбрасываются, без name — берут имя из cwd', () => {
  const { promptsFile, workspacesFile } = tmpFiles();
  const store = createRecipeStore({ promptsFile, workspacesFile });
  const tabs = [{ cwd: 'C:\\proj\\a' }, { name: 'без cwd' }, { cwd: '', name: 'пустой cwd' }];
  const saved = store.saveWorkspace('WS', tabs);
  assert.deepStrictEqual(saved.tabs, [{ cwd: 'C:\\proj\\a', name: 'C:\\proj\\a' }]);
});

test('saveWorkspace: пустое/пробельное имя → null, ничего не пишет', () => {
  const { promptsFile, workspacesFile } = tmpFiles();
  const store = createRecipeStore({ promptsFile, workspacesFile });
  assert.strictEqual(store.saveWorkspace('', []), null);
  assert.strictEqual(store.saveWorkspace('   ', []), null);
  assert.strictEqual(fs.existsSync(workspacesFile), false);
});

test('deleteWorkspace удаляет запись по id; неизвестный id — no-op', () => {
  const { promptsFile, workspacesFile } = tmpFiles();
  const store = createRecipeStore({ promptsFile, workspacesFile });
  const a = store.saveWorkspace('A', []);
  const b = store.saveWorkspace('B', []);
  store.deleteWorkspace(a.id);
  const list = store.listWorkspaces();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].id, b.id);
  assert.doesNotThrow(() => store.deleteWorkspace('нет-такого-id'));
});

test('битый workspaces.json → listWorkspaces() пуст, .bak создаётся при первой записи', () => {
  const { promptsFile, workspacesFile } = tmpFiles();
  const original = 'not json at all {{{';
  fs.writeFileSync(workspacesFile, original, 'utf8');
  const store = createRecipeStore({ promptsFile, workspacesFile });
  assert.deepStrictEqual(store.listWorkspaces(), []);
  store.saveWorkspace('WS', []);
  assert.strictEqual(fs.readFileSync(`${workspacesFile}.bak`, 'utf8'), original);
});
