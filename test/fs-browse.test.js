'use strict';
// Чтение каталогов для файлового обзора. Тесты — на НАСТОЯЩЕЙ временной папке
// (тот же приём, что в session-title.test.js): поведение fs на Windows слишком
// богато на частности, чтобы проверять его моками.
//
// Единственное, что здесь подменяется, — ЗАВИСАНИЕ чтения (параметр readdir/
// probe). Настоящий недостижимый UNC держал бы поток libuv двадцать секунд, и
// node --test не смог бы выйти, пока тот не отвалится по таймауту SMB. Живая
// проверка на \\192.0.2.1\share делается отдельно, на запущенном приложении.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { listDir, listDrives } = require('../src/main/fs-browse');

function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-browse-'));
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-big-'));
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-edge-'));
  for (let i = 0; i < 10; i += 1) fs.mkdirSync(path.join(root, `dir-${i}`));
  const res = await listDir(root, { limit: 10 });
  assert.strictEqual(res.entries.length, 10);
  assert.strictEqual(res.truncated, false, 'ровно limit — весь каталог влез');
});

test('короткий каталог не помечается обрезанным', async () => {
  const root = makeTree();
  assert.strictEqual((await listDir(root, { limit: 1000 })).truncated, false);
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-acl-'));
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
  const started = Date.now();
  const res = await listDir('\\\\192.0.2.1\\share', { timeoutMs: 50, readdir: hangs });
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-long-'));
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
