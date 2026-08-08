'use strict';
// Чтение каталогов для файлового обзора. Тесты — на НАСТОЯЩЕЙ временной папке
// (тот же приём, что в session-title.test.js): поведение fs на Windows слишком
// богато на частности, чтобы проверять его моками.
//
// Единственное, что здесь подменяется, — ЗАВИСАНИЕ чтения (параметр readdir/
// probe). Настоящий недостижимый UNC держал бы поток libuv двадцать секунд, и
// node --test не смог бы выйти, пока тот не отвалится по таймауту SMB. Живая
// проверка на \\192.0.2.1\share делается отдельно, на запущенном приложении.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { listDir, listDrives, createGate } = require('../src/main/fs-browse');

// Каждый mkdtemp регистрируется здесь и удаляется в конце файла. Раньше тесты
// этого не делали, и в TEMP от одного этого файла накопилось 317 каталогов
// (находка M-3 ре-ревью): прогон тестов не имеет права мусорить на диске
// владельца.
const TEMP_ROOTS = [];

function tempRoot(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TEMP_ROOTS.push(root);
  return root;
}

after(() => {
  for (const root of TEMP_ROOTS) {
    // Уборка не имеет права ронять прогон: часть каталогов тесты уже удалили
    // сами, у одного менялась ACL, ещё один длиннее MAX_PATH и снимается
    // только через префикс \\?\.
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* уже нет или занят */ }
    if (process.platform === 'win32' && fs.existsSync(`\\\\?\\${root}`)) {
      try { fs.rmSync(`\\\\?\\${root}`, { recursive: true, force: true }); } catch { /* и так сойдёт */ }
    }
  }
});

function makeTree() {
  const root = tempRoot('cockpit-browse-');
  fs.mkdirSync(path.join(root, 'zebra'));
  fs.mkdirSync(path.join(root, 'Alpha'));
  // 'apple' и 'Beta' стоят здесь не для красоты: при сравнении по кодам
  // символов (обычные < >) 'Beta' обгоняет 'apple', при сравнении без учёта
  // регистра — наоборот. Без такой пары подмена localeCompare на < > проходит
  // незамеченной (фикстура из одних '.hidden/Alpha/node_modules/zebra'
  // сортируется одинаково обоими способами).
  fs.mkdirSync(path.join(root, 'apple'));
  fs.mkdirSync(path.join(root, 'Beta'));
  fs.mkdirSync(path.join(root, '.hidden'));
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'readme.md'), 'x');
  fs.writeFileSync(path.join(root, 'A-file.txt'), 'x');
  fs.writeFileSync(path.join(root, 'Zeta.txt'), 'x');
  fs.writeFileSync(path.join(root, 'beta.txt'), 'x');
  return root;
}

// Зависшее чтение: промис, который не разрешится никогда.
const hangs = () => new Promise(() => {});
const delay = (ms) => new Promise((r) => { setTimeout(r, ms).unref?.(); });

test('папки идут первыми, потом файлы, внутри — по алфавиту без учёта регистра', async () => {
  const root = makeTree();
  const res = await listDir(root);
  assert.strictEqual(res.error, null);
  assert.deepStrictEqual(res.entries, [
    { name: '.hidden', dir: true },
    { name: 'Alpha', dir: true },
    { name: 'apple', dir: true },
    { name: 'Beta', dir: true },
    { name: 'node_modules', dir: true },
    { name: 'zebra', dir: true },
    { name: 'A-file.txt', dir: false },
    { name: 'beta.txt', dir: false },
    { name: 'readme.md', dir: false },
    { name: 'Zeta.txt', dir: false },
  ], 'скрытые и node_modules показываются наравне — решение владельца');
});

test('родитель известен, а у корня диска его нет', async () => {
  const root = makeTree();
  const res = await listDir(root);
  assert.strictEqual(res.parent, path.dirname(root));

  const drive = path.parse(root).root; // 'C:\\'
  assert.strictEqual((await listDir(drive)).parent, null, 'выше корня диска идти некуда');
});

test('путь нормализуется: слеши, точки, хвостовой разделитель', async () => {
  const root = makeTree();
  const messy = `${root}${path.sep}Alpha${path.sep}..${path.sep}`;
  assert.strictEqual((await listDir(messy)).path, path.resolve(root));
});

test('длинный каталог режется и честно об этом сообщает', async () => {
  const root = tempRoot('cockpit-big-');
  for (let i = 0; i < 25; i += 1) fs.mkdirSync(path.join(root, `dir-${String(i).padStart(3, '0')}`));
  const res = await listDir(root, { limit: 10 });
  assert.strictEqual(res.entries.length, 10);
  assert.strictEqual(res.truncated, true);
  // Обрезаем ПОСЛЕ сортировки, иначе список прыгал бы от вызова к вызову.
  assert.strictEqual(res.entries[0].name, 'dir-000');
});

test('ровно limit записей — это ещё не обрезка', async () => {
  // Граница: при '>=' вместо '>' каталог из ровно limit имён помечался бы
  // обрезанным, хотя не потеряно ни одной записи, и человек видел бы
  // «показано не всё» на полном списке.
  const root = tempRoot('cockpit-edge-');
  for (let i = 0; i < 10; i += 1) fs.mkdirSync(path.join(root, `dir-${i}`));
  const res = await listDir(root, { limit: 10 });
  assert.strictEqual(res.entries.length, 10);
  assert.strictEqual(res.truncated, false, 'ровно limit — весь каталог влез');
});

test('короткий каталог не помечается обрезанным', async () => {
  const root = makeTree();
  assert.strictEqual((await listDir(root, { limit: 1000 })).truncated, false);
});

// I-1 финального ре-ревью: '\\сервер' без имени шары Windows за UNC-корень не
// считает, и path.resolve достраивает к нему букву ТЕКУЩЕГО диска. Живой замер
// через канал приложения: fs:list('\\Users') вернул path="C:\Users", 14 записей
// и error=null — то есть содержимое локальной папки показывалось в ответ на
// запрос сервера, вместе с активной кнопкой «Открыть сессию здесь». Renderer
// эту форму уже понимает (browse-view.js), а main её молча подменял.
test('\\\\сервер без шары не превращается в локальную папку', async () => {
  const res = await listDir('\\\\Users');
  assert.notStrictEqual(res.path, path.resolve('\\Users'), 'путь не должен резолвиться в локальный');
  assert.deepStrictEqual(res.entries, [], 'содержимое локальной папки здесь показывать нельзя');
  assert.ok(res.error, 'должен быть понятный отказ');
  assert.match(res.error, /шар|сервер/i, 'текст обязан объяснять, чего не хватает');
});

// I-2 финального ре-ревью: обзор зовёт fs:drives на КАЖДУЮ навигацию, а проба
// буквы по таймауту бросается — слот отпускается, но операция висит в пуле
// libuv до конца SMB. Пул из четырёх потоков; замер ревьюера: три брошенные
// операции безвредны, четвёртая вешает живое локальное чтение на 20 036 мс.
// Достаточно ОДНОЙ отвалившейся сетевой буквы (выключенный VPN, спящий NAS) и
// четырёх переходов по папкам — и заморозка возвращается целиком, без единого
// сетевого пути от человека.
test('повторные вызовы не пробуют буквы заново — набор дисков кэшируется', async () => {
  let probes = 0;
  const probe = async (letter) => { probes += 1; return letter === 'C:\\'; };
  const drives = { cache: null };

  const first = await listDrives({ probe, drives });
  const after = probes;
  const second = await listDrives({ probe, drives });

  assert.deepStrictEqual(first, ['C:\\']);
  assert.deepStrictEqual(second, first, 'ответ тот же');
  assert.strictEqual(probes, after, 'второй вызов не должен трогать файловую систему вовсе');
});

test('буква, чья проба ещё висит, повторно не пробуется', async () => {
  // Именно так брошенные пробы и копятся: каждая навигация отправляла в пул
  // новую пробу той же мёртвой буквы.
  let probes = 0;
  const hang = new Promise(() => {}); // никогда не завершается — как мёртвый SMB
  const probe = async (letter) => {
    probes += 1;
    if (letter === 'Z:\\') return hang;
    return letter === 'C:\\';
  };
  const drives = { cache: null };

  await listDrives({ probe, drives, timeoutMs: 20 });
  const afterFirst = probes;
  // Кэш обходим явно: проверяем защиту от повторной пробы, а не кэш.
  drives.cache = null;
  await listDrives({ probe, drives, timeoutMs: 20 });

  // Во втором проходе пробуются 25 букв из 26: Z: пропущена, её прошлая проба
  // всё ещё держит поток пула и второй такой же ничего не узнает.
  assert.strictEqual(
    probes, afterFirst + 25,
    'Z: пробовать заново нельзя, пока висит прошлая проба',
  );
});

test('\\\\сервер\\шара остаётся рабочей формой', async () => {
  // Проверяем, что запрет не задел нормальный UNC: читать его мы по-прежнему
  // пробуем (недостижимый ответит своей ошибкой, а не «укажите шару»).
  const res = await listDir('\\\\192.0.2.77\\share', {
    timeoutMs: 50,
    readdir: async () => { throw Object.assign(new Error('нет сети'), { code: 'ENOENT' }); },
  });
  assert.ok(!/шар/i.test(res.error || ''), `форма с шарой не должна отвергаться: ${res.error}`);
});

test('несуществующая папка — понятный текст, а не исключение', async () => {
  const missing = path.join(os.tmpdir(), 'нет-такой-папки-12345');
  const res = await listDir(missing);
  assert.strictEqual(res.entries.length, 0);
  assert.match(res.error, /не существует/i);
  // path в ответе-ошибке обязателен: renderer по нему оставляет строку пути
  // заполненной, чтобы человек мог поправить опечатку, а не набирать заново.
  assert.strictEqual(res.path, missing, 'путь обязан вернуться и в ошибке');
});

test('файл вместо папки — тоже понятный отказ', async () => {
  const root = makeTree();
  const file = path.join(root, 'readme.md');
  const res = await listDir(file);
  assert.ok(res.error, 'файл — не каталог, и это надо сказать');
  assert.strictEqual(res.path, file, 'путь обязан вернуться и в ошибке');
});

test('нет доступа — так и говорим, а не «не удалось прочитать: EPERM»', async () => {
  // Настоящий каталог без прав: создаём свой и вешаем запрещающую ACL. Брать
  // системный (C:\System Volume Information) нельзя — под админом он читается,
  // и тест молча превратился бы в пустышку.
  const root = tempRoot('cockpit-acl-');
  const denied = path.join(root, 'denied');
  fs.mkdirSync(denied);
  fs.writeFileSync(path.join(denied, 'inside.txt'), 'x');
  const user = process.env.USERNAME;
  assert.ok(user, 'без имени пользователя ACL не поставить');
  execFileSync('icacls', [denied, '/inheritance:r', '/deny', `${user}:(OI)(CI)(F)`], { stdio: 'pipe' });
  try {
    const res = await listDir(denied);
    assert.deepStrictEqual(res.entries, []);
    assert.match(res.error, /нет доступа/i, 'EPERM/EACCES — это «нет доступа», а не общий сбой');
    assert.strictEqual(res.path, denied, 'путь обязан вернуться и в ошибке');
  } finally {
    // Запрещающую запись снимаем сами: владелец может править ACL, но rm без
    // этого упадёт и оставит мусор в temp на каждый прогон тестов.
    execFileSync('icacls', [denied, '/remove:d', user], { stdio: 'pipe' });
    execFileSync('icacls', [denied, '/grant', `${user}:(OI)(CI)(F)`], { stdio: 'pipe' });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('пустой и не-строковый путь не роняют', async () => {
  for (const bad of ['', null, undefined, 42, {}]) {
    const res = await listDir(bad);
    assert.ok(res.error, `${JSON.stringify(bad)} должен дать ошибку, а не исключение`);
    assert.deepStrictEqual(res.entries, []);
  }
});

test('не отвечающая папка отдаёт ошибку по таймауту, а не держит вызов', async () => {
  // Это главный дефект C1 в миниатюре: недостижимый UNC (спящий NAS,
  // выключенный VPN) отвечал только через ~21 секунду, и всё это время
  // главный процесс не обслуживал НИ ОДИН другой вызов.
  //
  // Своя песочница-очередь (gate): зависшее чтение слот не отдаёт никогда, и
  // на общей очереди этот тест занял бы сетевую дорожку до конца прогона.
  const started = Date.now();
  const res = await listDir('\\\\192.0.2.1\\share', { gate: createGate(), timeoutMs: 50, readdir: hangs });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `ответ обязан прийти по таймауту, а пришёл через ${elapsed} мс`);
  assert.deepStrictEqual(res.entries, []);
  assert.match(res.error, /не отвеча/i, 'человеку нужен смысл, а не код ошибки');
  assert.strictEqual(res.path, '\\\\192.0.2.1\\share', 'путь обязан вернуться и в ошибке');
  assert.strictEqual(res.parent, null);
  assert.strictEqual(res.truncated, false);
});

test('путь длиннее 260 символов не выдаём за несуществующую папку', async () => {
  // На ЭТОЙ машине длинные пути включены (LongPathsEnabled=1), и readdir их
  // читает. Подменённый readdir изображает машину, где они выключены: там
  // Windows отвечает тем же ENOENT, что и на отсутствующую папку, и текст
  // «папки не существует» отправлял бы человека искать несуществующую причину.
  const root = tempRoot('cockpit-long-');
  const seg = 'y'.repeat(60);
  let deep = root;
  for (let i = 0; i < 5; i += 1) deep = path.join(deep, `${seg}${i}`);
  assert.ok(deep.length > 260, `для проверки нужен путь длиннее 260, получилось ${deep.length}`);
  fs.mkdirSync(`\\\\?\\${deep}`, { recursive: true });
  try {
    const enoent = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
    const res = await listDir(deep, { readdir: enoent });
    assert.match(res.error, /260/, 'длина пути — настоящая причина, её и называем');
    assert.strictEqual(res.path, deep);

    // А вот тут папки действительно нет — и длина пути ни при чём.
    const ghost = path.join(deep, 'нет-такой');
    assert.match((await listDir(ghost, { readdir: enoent })).error, /не существует/i);
  } finally {
    fs.rmSync(`\\\\?\\${root}`, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// C-1 (ре-ревью): заморозка переехала в пул libuv. Таймаут отвечает человеку,
// но операцию не отменяет — зависший readdir держит поток пула (их 4) до
// собственного таймаута SMB. Замер на запущенном приложении: один зависший UNC
// безвреден (живая папка — 1 мс), четыре съедают пул целиком, и приложение
// уверенно врёт про живую локальную папку и отдаёт пустой список дисков.
// Значит, ограничивать надо число ОДНОВРЕМЕННО ВИСЯЩИХ чтений.
// ---------------------------------------------------------------------------

test('сетевые пути читаются по одному: второй недостижимый в пул не уходит', async () => {
  const gate = createGate();
  let calls = 0;
  const readdir = () => { calls += 1; return hangs(); };
  const first = listDir('\\\\192.0.2.1\\a', { gate, timeoutMs: 80, readdir });
  const second = await listDir('\\\\192.0.2.2\\b', { gate, timeoutMs: 80, readdir });

  assert.strictEqual(calls, 1, 'второй путь обязан остаться в очереди, а не занять ещё один поток пула');
  assert.deepStrictEqual(second.entries, []);
  assert.match(second.error, /не пробовали читать/, 'про непрочитанную папку нельзя говорить «не отвечает»');
  assert.match((await first).error, /не отвеча/, 'первый честно дождался своего таймаута');
});

test('зависшая сеть не мешает читать живую локальную папку', async () => {
  // Ровно та ложь, которую поймал замер: «4 UNC → fs:list(живая) 5006 мс,
  // папка не отвечает». Общая очередь на всё её не лечит, а лишь переносит из
  // пула в очередь, поэтому дорожки у сети и у диска разные.
  const gate = createGate();
  const root = makeTree();
  const hanging = listDir('\\\\192.0.2.1\\share', { gate, timeoutMs: 300, readdir: hangs });

  const started = Date.now();
  const local = await listDir(root, { gate, timeoutMs: 300 });
  const elapsed = Date.now() - started;

  assert.strictEqual(local.error, null, 'живая папка обязана читаться, пока висит сеть');
  assert.strictEqual(local.entries.length, 10);
  assert.ok(elapsed < 200, `живая папка обязана отвечать сразу, а ответила через ${elapsed} мс`);
  await hanging;
});

test('повторный клик по тому же пути не добавляет второго висящего вызова', async () => {
  // В обзоре нет ни индикатора загрузки, ни запрета на повторное открытие:
  // человек жмёт «+ Проект» несколько раз подряд по одному и тому же адресу.
  const gate = createGate();
  let calls = 0;
  const readdir = () => { calls += 1; return hangs(); };
  const p = '\\\\192.0.2.1\\share';
  const [a, b, c] = await Promise.all([
    listDir(p, { gate, timeoutMs: 80, readdir }),
    listDir(p, { gate, timeoutMs: 80, readdir }),
    listDir(p, { gate, timeoutMs: 80, readdir }),
  ]);
  assert.strictEqual(calls, 1, 'три клика по одному пути — один вызов в пул');
  for (const res of [a, b, c]) {
    assert.match(res.error, /не отвеча/, 'присоединившийся получает тот же ответ, а не «очередь занята»');
  }
});

test('повторный клик по зависшему пути получает отказ сразу, а не через таймаут', async () => {
  const gate = createGate();
  const first = listDir('\\\\192.0.2.1\\a', { gate, timeoutMs: 60, readdir: hangs });
  assert.match((await first).error, /не отвеча/);

  const started = Date.now();
  const second = await listDir('\\\\192.0.2.2\\b', { gate, timeoutMs: 5000, readdir: hangs });
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 1000, `ждать нечего — отказ обязан прийти сразу, а пришёл через ${elapsed} мс`);
  assert.ok(second.error.includes('192.0.2.1'), `в отказе называем виновника, а не спрошенный путь: ${second.error}`);
});

test('слот возвращается, когда зависшее чтение всё-таки ответило', async () => {
  // Восстановление: в замере приложение оживало через 24,5 с — ровно тогда,
  // когда SMB сдавался сам. Дорожка обязана открыться в этот же момент, а не
  // остаться закрытой навсегда.
  const gate = createGate();
  let unblock;
  const readdir = (p) => (p.includes('192.0.2.1')
    ? new Promise((resolve) => { unblock = resolve; })
    : Promise.resolve([]));

  assert.match((await listDir('\\\\192.0.2.1\\a', { gate, timeoutMs: 40, readdir })).error, /не отвеча/);
  assert.match((await listDir('\\\\192.0.2.2\\b', { gate, timeoutMs: 40, readdir })).error, /не пробовали/);

  unblock([]); // SMB наконец сдался
  await new Promise((resolve) => { setImmediate(resolve); });

  const revived = await listDir('\\\\192.0.2.2\\b', { gate, timeoutMs: 40, readdir });
  assert.strictEqual(revived.error, null, 'дорожка обязана открыться, как только зависший вызов вернулся');
});

test('диски: непустой список, каждый существует', async () => {
  const drives = await listDrives();
  assert.ok(Array.isArray(drives) && drives.length > 0);
  for (const d of drives) {
    assert.match(d, /^[A-Z]:\\$/);
    assert.ok(fs.existsSync(d), `${d} обязан существовать — иначе он не диск`);
  }
  assert.ok(drives.includes('C:\\'), 'на этой машине C: есть всегда');
});

test('не отвечающая буква диска не задерживает список', async () => {
  // Пустой картридер или отключённый сетевой диск — тот же класс, что и C1:
  // одна буква не имеет права заморозить перебор остальных.
  const started = Date.now();
  const drives = await listDrives({
    timeoutMs: 50,
    probe: (root) => (root === 'Z:\\' ? hangs() : Promise.resolve(root === 'C:\\')),
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `перебор букв обязан уложиться в таймаут, а занял ${elapsed} мс`);
  assert.deepStrictEqual(drives, ['C:\\'], 'зависшая буква просто не показывается');
});

test('таймаут буквы отсчитывается от старта пробы, а не от постановки в очередь', async () => {
  // Вторая половина C-1: «4 UNC → fs:drives 1502 мс, []». Живая C: не пропала
  // и не зависла — она простояла свои полторы секунды В ОЧЕРЕДИ пула и выбыла,
  // так и не начав проверяться. Здесь очередь заведомо длиннее таймаута: A: и
  // B: висят, до C: очередь доходит не раньше 120-й миллисекунды, а бюджет у
  // пробы — 60 мс. При отсчёте «с постановки» C: не попала бы в список.
  const drives = await listDrives({
    timeoutMs: 60,
    concurrency: 1,
    probe: (root) => {
      if (root === 'A:\\' || root === 'B:\\') return hangs();
      if (root === 'C:\\') return delay(30).then(() => true);
      return Promise.resolve(false);
    },
  });
  assert.deepStrictEqual(drives, ['C:\\'], 'живая буква обязана дождаться очереди и попасть в список');
});

test('потолок сетевых чтений работает и на общей очереди, без песочницы', async () => {
  // Проводка: ipc.js зовёт listDir БЕЗ опций. Если очередь создавать на каждый
  // вызов заново, все проверки выше остаются зелёными, а приложение —
  // сломанным. Тест НАМЕРЕННО оставляет сетевую дорожку общей очереди занятой
  // навсегда (зависшее чтение слот не отдаёт), поэтому он последний в файле, а
  // все остальные сетевые тесты работают на своих песочницах.
  let calls = 0;
  const readdir = () => { calls += 1; return hangs(); };
  const first = listDir('\\\\192.0.2.250\\a', { timeoutMs: 60, readdir });
  const second = await listDir('\\\\192.0.2.251\\b', { timeoutMs: 60, readdir });
  assert.strictEqual(calls, 1, 'общая очередь обязана быть одна на весь процесс');
  assert.match(second.error, /не пробовали читать/);
  await first;
});
