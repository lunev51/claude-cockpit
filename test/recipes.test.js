'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createRecipeStore, extractPlaceholders, fillPrompt, normalizeForPty,
} = require('../src/main/recipes');

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

// --- normalizeForPty (Minor 8, ревью раунд 1) ---

test('normalizeForPty: одиночный \\n схлопывается в пробел', () => {
  assert.strictEqual(normalizeForPty('Сравни X\nи Y'), 'Сравни X и Y');
});

test('normalizeForPty: \\r\\n тоже схлопывается в пробел', () => {
  assert.strictEqual(normalizeForPty('строка1\r\nстрока2'), 'строка1 строка2');
});

test('normalizeForPty: несколько переносов подряд → ОДИН пробел, не вереница', () => {
  assert.strictEqual(normalizeForPty('a\n\n\nb'), 'a b');
  assert.strictEqual(normalizeForPty('a\r\n\r\nb'), 'a b');
});

test('normalizeForPty: перенос в начале/конце текста обрезается, а не превращается в пробел по краю', () => {
  assert.strictEqual(normalizeForPty('\nтекст\n'), 'текст');
});

test('normalizeForPty: текст без переносов не меняется (кроме тримминга краевых пробелов)', () => {
  assert.strictEqual(normalizeForPty('обычный текст'), 'обычный текст');
  assert.strictEqual(normalizeForPty('  с пробелами по краям  '), 'с пробелами по краям');
});

test('normalizeForPty: не-строка → пустая строка, не бросает', () => {
  assert.strictEqual(normalizeForPty(null), '');
  assert.strictEqual(normalizeForPty(undefined), '');
  assert.strictEqual(normalizeForPty(42), '');
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

test('deletePrompt удаляет запись по id', () => {
  const { promptsFile, workspacesFile } = tmpFiles();
  const store = createRecipeStore({ promptsFile, workspacesFile });
  const a = store.savePrompt({ title: 'A', text: 'a' });
  const b = store.savePrompt({ title: 'B', text: 'b' });
  store.deletePrompt(a.id);
  const list = store.listPrompts();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].id, b.id);
});

// Minor 10 (ревью раунд 1): assert.doesNotThrow не доказывает, что неизвестный
// id — ДЕЙСТВИТЕЛЬНО no-op на диске (файл был бы переписан идентичным
// содержимым — и то же самое upToThrow прошло бы) — сравниваем БАЙТЫ файла
// до/после.
test('deletePrompt: неизвестный id на валидном файле — файл на диске не переписывается (сравнение содержимого)', () => {
  const { promptsFile, workspacesFile } = tmpFiles();
  const store = createRecipeStore({ promptsFile, workspacesFile });
  store.savePrompt({ title: 'A', text: 'a' });
  const before = fs.readFileSync(promptsFile, 'utf8');
  store.deletePrompt('нет-такого-id');
  const after = fs.readFileSync(promptsFile, 'utf8');
  assert.strictEqual(after, before);
});

// Minor 10: на БИТОМ файле неизвестный id тем более не должен тратить
// единственный шанс сохранить исходное повреждённое содержимое в .bak —
// удалять реально нечего, значит и писать (а значит, и бэкапить) не нужно.
test('deletePrompt: неизвестный id на БИТОМ файле — файл и .bak не создаются/не трогаются', () => {
  const { promptsFile, workspacesFile } = tmpFiles();
  const original = '{broken prompts file, nothing to delete here';
  fs.writeFileSync(promptsFile, original, 'utf8');
  const store = createRecipeStore({ promptsFile, workspacesFile });
  store.deletePrompt('нет-такого-id');
  assert.strictEqual(fs.readFileSync(promptsFile, 'utf8'), original); // не тронут
  assert.strictEqual(fs.existsSync(`${promptsFile}.bak`), false); // .bak не создан — шанс на восстановление ещё жив
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

// Important 4 (ревью раунд 1): раньше проверялись только length===4 и
// подстрока '{{пакет}}' — этого недостаточно, бриф перечисляет 4 рецепта
// ДОСЛОВНО. Сверяем заголовки/тексты по всему массиву, а не выборочно.
const EXPECTED_DEFAULT_TITLES = [
  'Прогони тесты и почини падения',
  'Отревьюй мои изменения',
  'Обнови зависимости в {{пакет}}',
  'Объясни, что делает {{файл}}',
];

test('ensureDefaultPrompts: файла нет → засевает ровно 4 дефолтных рецепта из брифа, дословно', () => {
  const { promptsFile, workspacesFile } = tmpFiles();
  const store = createRecipeStore({ promptsFile, workspacesFile });
  store.ensureDefaultPrompts();
  const list = store.listPrompts();
  assert.strictEqual(list.length, 4);
  assert.ok(list.every((p) => typeof p.id === 'string' && p.id));
  assert.deepStrictEqual(list.map((p) => p.title), EXPECTED_DEFAULT_TITLES);
  // title === text для дефолтов — бриф не просит отдельного короткого лейбла.
  assert.deepStrictEqual(list.map((p) => p.text), EXPECTED_DEFAULT_TITLES);
});

test('ensureDefaultPrompts: файл уже существует (в т.ч. пустой список) → не трогает', () => {
  const { promptsFile, workspacesFile } = tmpFiles();
  fs.writeFileSync(promptsFile, '[]', 'utf8');
  const store = createRecipeStore({ promptsFile, workspacesFile });
  store.ensureDefaultPrompts();
  assert.deepStrictEqual(store.listPrompts(), []); // пользователь удалил всё — не реанимируем дефолты
});

// Important 3 (ревью раунд 1): раньше проверялся только fs.existsSync — битый
// prompts.json навсегда оставлял палитру без единого рецепта (ни один путь UI
// не пишет рецепты — некому больше запустить repair). Теперь «файл битый»
// приравнено к «файла нет» — засеваем дефолты, и, как обычная запись поверх
// битого файла, .bak сохраняет исходное содержимое.
test('ensureDefaultPrompts: БИТЫЙ prompts.json → пересеивается дефолтами, .bak хранит исходное содержимое', () => {
  const { promptsFile, workspacesFile } = tmpFiles();
  const original = '{this used to be prompts.json but somebody broke it';
  fs.writeFileSync(promptsFile, original, 'utf8');
  const store = createRecipeStore({ promptsFile, workspacesFile });
  store.ensureDefaultPrompts();
  const list = store.listPrompts();
  assert.strictEqual(list.length, 4);
  assert.deepStrictEqual(list.map((p) => p.title), EXPECTED_DEFAULT_TITLES);
  assert.strictEqual(fs.readFileSync(`${promptsFile}.bak`, 'utf8'), original);
});

test('ensureDefaultPrompts: валидный JSON неверной формы (элементы без title/text) — тоже пересеивается', () => {
  const { promptsFile, workspacesFile } = tmpFiles();
  fs.writeFileSync(promptsFile, JSON.stringify([{ id: 'x' }]), 'utf8');
  const store = createRecipeStore({ promptsFile, workspacesFile });
  store.ensureDefaultPrompts();
  assert.strictEqual(store.listPrompts().length, 4);
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

// Minor 9 (ревью раунд 1): код и комментарий раньше расходились — комментарий
// обещал path.basename(cwd), код подставлял cwd целиком. Приведено в
// соответствие (код теперь ДЕЙСТВИТЕЛЬНО берёт basename, как sessions.js для
// новой вкладки) — тест фиксирует РЕАЛЬНОЕ поведение.
test('saveWorkspace: вкладки без cwd отбрасываются, без name — берут basename(cwd) (как sessions.js для новой вкладки)', () => {
  const { promptsFile, workspacesFile } = tmpFiles();
  const store = createRecipeStore({ promptsFile, workspacesFile });
  const tabs = [{ cwd: 'C:\\proj\\a' }, { name: 'без cwd' }, { cwd: '', name: 'пустой cwd' }];
  const saved = store.saveWorkspace('WS', tabs);
  assert.deepStrictEqual(saved.tabs, [{ cwd: 'C:\\proj\\a', name: 'a' }]);
});

test('saveWorkspace: имя тримится по краям', () => {
  const { promptsFile, workspacesFile } = tmpFiles();
  const store = createRecipeStore({ promptsFile, workspacesFile });
  const tabs = [{ cwd: 'C:\\proj\\a', name: 'a' }];
  const saved = store.saveWorkspace('  Работа  ', tabs);
  assert.strictEqual(saved.name, 'Работа');
});

// Minor 6 (ревью раунд 1): повторное «Сохранить воркспейс…» под тем же именем
// (после трима) должно ЗАМЕНЯТЬ старую запись, а не плодить неразличимый
// дубль, который раньше можно было убрать только руками через файл.
test('saveWorkspace: сохранение под уже существующим (после трима) именем перезаписывает запись НА МЕСТЕ (тот же id)', () => {
  const { promptsFile, workspacesFile } = tmpFiles();
  const store = createRecipeStore({ promptsFile, workspacesFile });
  const first = store.saveWorkspace('Работа', [{ cwd: 'C:\\proj\\a', name: 'a' }]);
  const second = store.saveWorkspace('  Работа  ', [
    { cwd: 'C:\\proj\\a', name: 'a' },
    { cwd: 'C:\\proj\\b', name: 'b' },
  ]);
  assert.strictEqual(second.id, first.id);
  const list = store.listWorkspaces();
  assert.strictEqual(list.length, 1); // не два — перезапись, не добавление
  assert.strictEqual(list[0].tabs.length, 2);
});

test('saveWorkspace: разные имена — отдельные записи, обе видны в listWorkspaces', () => {
  const { promptsFile, workspacesFile } = tmpFiles();
  const store = createRecipeStore({ promptsFile, workspacesFile });
  store.saveWorkspace('Работа', [{ cwd: 'C:\\proj\\a', name: 'a' }]);
  store.saveWorkspace('Дом', [{ cwd: 'C:\\proj\\b', name: 'b' }]);
  assert.strictEqual(store.listWorkspaces().length, 2);
});

test('saveWorkspace: пустое/пробельное имя → null, ничего не пишет', () => {
  const { promptsFile, workspacesFile } = tmpFiles();
  const store = createRecipeStore({ promptsFile, workspacesFile });
  const tabs = [{ cwd: 'C:\\proj\\a', name: 'a' }];
  assert.strictEqual(store.saveWorkspace('', tabs), null);
  assert.strictEqual(store.saveWorkspace('   ', tabs), null);
  assert.strictEqual(fs.existsSync(workspacesFile), false);
});

// Minor 6: воркспейс без единой вкладки (состав пуст ДО или ПОСЛЕ фильтрации
// по cwd) бесполезен в палитре — отказ без записи, даже если имя валидно.
test('saveWorkspace: нулевой состав вкладок (валидное имя) → null, ничего не пишет', () => {
  const { promptsFile, workspacesFile } = tmpFiles();
  const store = createRecipeStore({ promptsFile, workspacesFile });
  assert.strictEqual(store.saveWorkspace('Пустой', []), null);
  assert.strictEqual(store.saveWorkspace('Тоже пустой', [{ name: 'без cwd' }]), null); // после фильтрации — тоже []
  assert.strictEqual(fs.existsSync(workspacesFile), false);
});

test('deleteWorkspace удаляет запись по id', () => {
  const { promptsFile, workspacesFile } = tmpFiles();
  const store = createRecipeStore({ promptsFile, workspacesFile });
  const a = store.saveWorkspace('A', [{ cwd: 'C:\\proj\\a', name: 'a' }]);
  const b = store.saveWorkspace('B', [{ cwd: 'C:\\proj\\b', name: 'b' }]);
  store.deleteWorkspace(a.id);
  const list = store.listWorkspaces();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].id, b.id);
});

// Minor 10: тот же приём, что у deletePrompt выше — сравнение содержимого
// файла до/после, а не doesNotThrow.
test('deleteWorkspace: неизвестный id на валидном файле — файл на диске не переписывается', () => {
  const { promptsFile, workspacesFile } = tmpFiles();
  const store = createRecipeStore({ promptsFile, workspacesFile });
  store.saveWorkspace('A', [{ cwd: 'C:\\proj\\a', name: 'a' }]);
  const before = fs.readFileSync(workspacesFile, 'utf8');
  store.deleteWorkspace('нет-такого-id');
  const after = fs.readFileSync(workspacesFile, 'utf8');
  assert.strictEqual(after, before);
});

test('deleteWorkspace: неизвестный id на БИТОМ файле — файл и .bak не создаются/не трогаются', () => {
  const { promptsFile, workspacesFile } = tmpFiles();
  const original = 'not json at all {{{';
  fs.writeFileSync(workspacesFile, original, 'utf8');
  const store = createRecipeStore({ promptsFile, workspacesFile });
  store.deleteWorkspace('нет-такого-id');
  assert.strictEqual(fs.readFileSync(workspacesFile, 'utf8'), original);
  assert.strictEqual(fs.existsSync(`${workspacesFile}.bak`), false);
});

test('битый workspaces.json → listWorkspaces() пуст, .bak создаётся при первой записи', () => {
  const { promptsFile, workspacesFile } = tmpFiles();
  const original = 'not json at all {{{';
  fs.writeFileSync(workspacesFile, original, 'utf8');
  const store = createRecipeStore({ promptsFile, workspacesFile });
  assert.deepStrictEqual(store.listWorkspaces(), []);
  store.saveWorkspace('WS', [{ cwd: 'C:\\proj\\a', name: 'a' }]);
  assert.strictEqual(fs.readFileSync(`${workspacesFile}.bak`, 'utf8'), original);
});
