'use strict';
// Библиотека рецептов промптов и именованные воркспейсы (Phase 7, Task 4).
// Два независимых плоских JSON-файла в userData:
//   prompts.json:            [{id, title, text}] — text может содержать плейсхолдеры {{имя}}
//   workspaces-library.json: [{id, name, tabs:[{cwd, name}]}]
// Имя второго файла НЕ workspaces.json (ревью раунд 1: исходное обоснование в
// отчёте задачи — «коллизия с workspace.json» — было неверным, единственное и
// множественное число не путаются на диске). Причина — читаемость: workspace.json
// (манифест ТЕКУЩЕГО состава вкладок, workspace.js/createWorkspaceStore) и
// workspaces.json отличались бы РОВНО одной буквой в одной папке — ловушка для
// человека, который будет это отлаживать (два файла с почти неразличимыми
// именами и разным назначением рядом на диске). workspaces-library.json читается
// однозначно как «библиотека сохранённых профилей», а не «тот же манифест, только
// во множественном числе».
// Стиль — тот же, что у соседнего workspace.js (манифест воркспейса): путь к
// файлу инжектируется вызывающим кодом (ipc.js резолвит его через
// app.getPath('userData')), само чтение/запись — прямой fs, атомарно
// (temp+rename). В отличие от workspace.js здесь НЕТ дебаунса — CRUD-операции
// палитры единичны и редки (клик пользователя), а не поток событий вроде
// tabs:changed, лишний таймер только усложнил бы контракт без пользы.
//
// Устойчивость к повреждению (бриф): битый/невалидный по форме файл на чтении
// → пустой список, НИКОГДА не бросаем. Но пустой список на чтении не должен
// молча стереть то, что реально лежит на диске, если это просто отличается по
// форме, а не мусор, — поэтому ПЕРЕД первой перезаписью новым (валидным)
// списком то, что сейчас лежит в file (если оно не парсится или не проходит
// проверку формы), копируется КАК ЕСТЬ в `${file}.bak`. После этой первой
// перезаписи файл уже валиден сам по себе — второго бэкапа больше не будет,
// пока кто-то не испортит file заново в обход этого модуля (тот же случай,
// что FIX 8 у workspace.js: битый file никогда не копируется в .bak, чтобы не
// затереть страховку испорченным содержимым).
//
// extractPlaceholders()/fillPrompt()/normalizeForPty() — чистые функции без
// единого обращения к диску, вынесены отдельно от createRecipeStore(): им не
// нужен путь к файлу, незачем прятать их за инстансом стора.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Плейсхолдер — {{имя}}, где имя не содержит фигурных скобок; пробелы по
// краям имени не считаются его частью ("{{ пакет }}" → имя "пакет").
const PLACEHOLDER_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function isValidPrompt(p) {
  return !!p && typeof p === 'object'
    && isNonEmptyString(p.id) && typeof p.title === 'string' && typeof p.text === 'string';
}

function isValidPromptsList(v) {
  return Array.isArray(v) && v.every(isValidPrompt);
}

function isValidWorkspaceTab(t) {
  return !!t && typeof t === 'object' && isNonEmptyString(t.cwd) && typeof t.name === 'string';
}

function isValidWorkspace(w) {
  return !!w && typeof w === 'object'
    && isNonEmptyString(w.id) && typeof w.name === 'string'
    && Array.isArray(w.tabs) && w.tabs.every(isValidWorkspaceTab);
}

function isValidWorkspacesList(v) {
  return Array.isArray(v) && v.every(isValidWorkspace);
}

// Дефолтные рецепты первого запуска (бриф, дословно) — title и text совпадают:
// это и есть готовый промпт, отдельного короткого лейбла бриф не просит.
const DEFAULT_PROMPTS = [
  'Прогони тесты и почини падения',
  'Отревьюй мои изменения',
  'Обнови зависимости в {{пакет}}',
  'Объясни, что делает {{файл}}',
].map((text) => ({ text, title: text }));

// Читает JSON-массив из file; отсутствующий/битый/неверной формы файл → [] —
// никогда не бросаем (бриф: отсутствие данных — нормальное состояние).
function readList(file, isValid) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return isValid(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// true, если то, что СЕЙЧАС лежит в file, не парсится или не проходит isValid
// (в т.ч. если файла нет вовсе — тогда бэкапить нечего, это НЕ считается
// «битым» в смысле этой функции).
function isCurrentFileCorrupted(file, isValid) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return false; // файла нет — обычная ветка «первое сохранение»
  }
  try {
    return !isValid(JSON.parse(raw));
  } catch {
    return true; // не JSON вовсе
  }
}

// true, только если file СУЩЕСТВУЕТ, парсится и проходит isValid. В отличие
// от isCurrentFileCorrupted() выше (где «файла нет» — НЕ битый, обычная
// ветка первой записи), здесь «файла нет» — тоже false: используется
// ensureDefaultPrompts() (Important 3, ревью раунд 1), где ОБА случая —
// «файла нет вовсе» И «файл есть, но битый» — одинаково повод засеять
// дефолты; отличать нужно только их ОБА от «файл валиден, но пуст»
// (пользователь осознанно удалил все рецепты — это НЕ повод реанимировать
// дефолты).
function isFileValidJson(file, isValid) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return isValid(JSON.parse(raw));
  } catch {
    return false;
  }
}

// Пишет list в file атомарно (temp+rename), никогда не бросает наружу (ошибку
// только логируем — тот же приём, что workspace.js/writeNow). Перед
// перезаписью — если текущее содержимое file битое, сохраняет его КАК ЕСТЬ в
// `${file}.bak` (см. комментарий в шапке файла).
function writeList(file, isValid, list) {
  try {
    if (isCurrentFileCorrupted(file, isValid)) {
      try {
        const raw = fs.readFileSync(file, 'utf8');
        fs.writeFileSync(`${file}.bak`, raw, 'utf8');
      } catch { /* гонка (файл исчез между проверкой и чтением) — не критично */ }
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    console.warn(`[recipes] запись ${path.basename(file)} не удалась: ${err.message}`);
  }
}

// extractPlaceholders(text) → уникальные имена плейсхолдеров, В ПОРЯДКЕ
// первого появления в тексте. Повторы одного и того же имени схлопываются в
// одну запись. Текст без плейсхолдеров/не-строка → [].
function extractPlaceholders(text) {
  if (typeof text !== 'string' || !text) return [];
  const seen = new Set();
  const out = [];
  // .exec на глобальном regex — сбрасываем lastIndex созданием нового объекта
  // regex на каждый вызов (модульный PLACEHOLDER_RE иначе накапливал бы
  // состояние между вызовами — известная ловушка глобальных regex-констант).
  const re = new RegExp(PLACEHOLDER_RE.source, 'g');
  let m = re.exec(text);
  while (m !== null) {
    const name = m[1];
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
    m = re.exec(text);
  }
  return out;
}

// fillPrompt(text, values) → text с подставленными {{имя}} → values[имя].
// Плейсхолдер БЕЗ соответствующего значения (в т.ч. если values вообще не
// объект) даёт пустую строку, а не оставленный как есть "{{имя}}" — иначе
// текст, отправленный в pty, содержал бы буквальные фигурные скобки вместо
// ответа пользователя (бриф: отсутствующее значение — нормальное состояние,
// не ошибка).
function fillPrompt(text, values) {
  if (typeof text !== 'string') return '';
  const v = values && typeof values === 'object' ? values : {};
  return text.replace(new RegExp(PLACEHOLDER_RE.source, 'g'), (_all, name) => {
    const val = v[name];
    return typeof val === 'string' ? val : '';
  });
}

// normalizeForPty(text) → text с переносами строк, схлопнутыми в пробел, и
// обрезанными пробелами по краям (Minor 8, ревью раунд 1). Текст рецепта
// уходит в pty ОДНОЙ записью (app.js/runRecipe: term.write(tabId, `${text}\r`)) —
// внутренний перенос строки терминал воспринимает как отдельный Enter: первая
// строка ушла бы САМОСТОЯТЕЛЬНЫМ промптом раньше остальных, а если сессия в
// этот момент показывает диалог разрешения — молча подтвердила бы его (та же
// проектная ловушка, что и голый '\r', см. runRecipe/peek.js). Схлопывает ЛЮБУЮ
// последовательность \r\n/\r/\n (и повторы подряд) в ОДИН пробел, а не в
// пробел на каждый символ перевода строки — иначе несколько пустых строк
// подряд превратились бы в вереницу пробелов.
function normalizeForPty(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/(\r\n|\r|\n)+/g, ' ').trim();
}

function createRecipeStore({ promptsFile, workspacesFile }) {
  function listPrompts() {
    return readList(promptsFile, isValidPromptsList);
  }

  // savePrompt({id?, title, text}) → сохранённая запись, либо null при
  // некорректном входе (title/text не строки) — ничего не пишем в этом
  // случае. id отсутствует/пуст → новый рецепт (id минтится здесь); id есть
  // и совпадает с существующим → обновление на месте, иначе — добавление с
  // ЭТИМ id (даёт вызывающему коду контроль над id при импорте/сидировании
  // дефолтов, см. ensureDefaultPrompts ниже).
  function savePrompt(p) {
    if (!p || typeof p !== 'object' || typeof p.title !== 'string' || typeof p.text !== 'string') {
      return null;
    }
    const list = listPrompts();
    const id = isNonEmptyString(p.id) ? p.id : crypto.randomUUID();
    const entry = { id, title: p.title, text: p.text };
    const idx = list.findIndex((x) => x.id === id);
    if (idx === -1) list.push(entry);
    else list[idx] = entry;
    writeList(promptsFile, isValidPromptsList, list);
    return entry;
  }

  // deletePrompt(id): неизвестный id — намеренный no-op БЕЗ записи на диск
  // (ревью раунд 1, Minor 10: рассматривали и вариант «писать всегда», но он
  // означал бы, что даже удаление НЕСУЩЕСТВУЮЩЕГО рецепта на битом
  // prompts.json тратит единственный шанс сохранить исходное повреждённое
  // содержимое в .bak — на пустом месте, без единого реального изменения.
  // Восстановление после порчи — забота ensureDefaultPrompts() ниже, не этой
  // функции; тест на файл-не-тронут см. test/recipes.test.js).
  function deletePrompt(id) {
    if (typeof id !== 'string' || !id) return;
    const list = listPrompts();
    const next = list.filter((p) => p.id !== id);
    if (next.length === list.length) return; // такого id не было — нечего писать
    writeList(promptsFile, isValidPromptsList, next);
  }

  // Первый запуск — засеваем DEFAULT_PROMPTS. «Первый запуск» — это ЛИБО
  // файла нет вовсе, ЛИБО файл есть, но битый/неверной формы (Important 3,
  // ревью раунд 1: раньше проверялся только fs.existsSync — повреждённый
  // prompts.json навсегда оставлял палитру без единого рецепта, потому что
  // ни один путь UI в этой задаче не вызывает savePrompt/deletePrompt —
  // некому больше запустить repair через writeList, а .bak в такой ситуации
  // не создавался НИКОГДА). Валидный, но ПУСТОЙ файл (пользователь осознанно
  // удалил все рецепты) — это НЕ повод реанимировать дефолты, isFileValidJson
  // отличает такой файл от битого. Вызывается явно из ipc.js (не изнутри
  // listPrompts()) — чтение не должно иметь побочных эффектов записи на диск.
  function ensureDefaultPrompts() {
    if (isFileValidJson(promptsFile, isValidPromptsList)) return;
    const seeded = DEFAULT_PROMPTS.map((p) => ({ id: crypto.randomUUID(), ...p }));
    writeList(promptsFile, isValidPromptsList, seeded);
  }

  function listWorkspaces() {
    return readList(workspacesFile, isValidWorkspacesList);
  }

  // saveWorkspace(name, tabs) → сохранённая запись, либо null при пустом
  // (после трима) имени ИЛИ нулевом составе вкладок. tabs — [{cwd, name}]
  // (состав вкладок на момент сохранения, собирает вызывающий код из
  // tabStore); элементы без cwd отбрасываются, отсутствующее/пустое name у
  // вкладки подстраховано именем из cwd так же, как sessions.js называет
  // НОВУЮ вкладку (path.basename(cwd) || cwd, Minor 9 ревью раунд 1 — код и
  // комментарий раньше расходились: комментарий обещал basename, код
  // подставлял cwd целиком).
  function saveWorkspace(name, tabs) {
    const trimmedName = typeof name === 'string' ? name.trim() : '';
    const list = Array.isArray(tabs) ? tabs : [];
    const cleanTabs = list
      .filter((t) => t && typeof t.cwd === 'string' && t.cwd)
      .map((t) => ({
        cwd: t.cwd,
        name: typeof t.name === 'string' && t.name ? t.name : (path.basename(t.cwd) || t.cwd),
      }));
    // Minor 6 (ревью раунд 1): пустое имя ПОСЛЕ трима ИЛИ нулевой состав
    // вкладок (после фильтрации без cwd) — отказ без записи на диск:
    // воркспейс без единой вкладки только захламляет палитру бесполезной
    // строкой «Открыть воркспейс: …», которую и открыть-то нечем.
    if (!trimmedName || cleanTabs.length === 0) return null;

    const all = listWorkspaces();
    // Сохранение под УЖЕ существующим именем (после трима) ПЕРЕЗАПИСЫВАЕТ
    // запись НА МЕСТЕ (id сохраняется) — иначе повторное «Сохранить
    // воркспейс…» под тем же именем копит неразличимые дубли, которые
    // раньше можно было убрать только руками через файл (сценарий ревью:
    // сохранил «работа», добавил вкладку, сохранил «работа» ещё раз).
    const existing = all.find((w) => w.name === trimmedName);
    const entry = {
      id: existing ? existing.id : crypto.randomUUID(),
      name: trimmedName,
      tabs: cleanTabs,
    };
    const next = existing ? all.map((w) => (w.id === entry.id ? entry : w)) : [...all, entry];
    writeList(workspacesFile, isValidWorkspacesList, next);
    return entry;
  }

  // deleteWorkspace(id): та же логика намеренного no-op на неизвестном id,
  // что deletePrompt выше (Minor 10, ревью раунд 1) — не тратим единственный
  // шанс бэкапа битого файла на удаление того, чего и так не было.
  function deleteWorkspace(id) {
    if (typeof id !== 'string' || !id) return;
    const list = listWorkspaces();
    const next = list.filter((w) => w.id !== id);
    if (next.length === list.length) return;
    writeList(workspacesFile, isValidWorkspacesList, next);
  }

  return {
    listPrompts,
    savePrompt,
    deletePrompt,
    ensureDefaultPrompts,
    listWorkspaces,
    saveWorkspace,
    deleteWorkspace,
  };
}

module.exports = {
  createRecipeStore, extractPlaceholders, fillPrompt, normalizeForPty,
};
