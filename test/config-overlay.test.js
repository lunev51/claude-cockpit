'use strict';
// Сохранность пользовательских настроек (userData/config.user.json).
//
// Ревью 09.08: оверлей писался голым writeFileSync, тогда как рецепты и
// манифест воркспейса рядом пишутся атомарно. А это единственный файл
// настроек, который правит человек, и в нём живёт net.host — адрес, по
// которому кокпит доступен с макбука. Обрыв записи оставлял битый JSON, и
// читатель молча возвращал {}: разом терялись ВСЕ настройки, без следа.
//
// Тесты идут по реальным временным файлам (как в recipes.test.js): здесь
// проверяется именно поведение файловой системы — переименование, копия
// поколения, поведение при битом содержимом.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readOverlay, writeOverlay, parseJsonFile } = require('../src/main/config-overlay');

// Уборка за собой — находка M-3, из-за которой в TEMP владельца однажды
// накопилось больше трёхсот каталогов от прогонов: тесты не имеют права
// мусорить на диске. Тот же приём, что в fs-browse.test.js.
const TEMP_ROOTS = [];
after(() => {
  for (const dir of TEMP_ROOTS) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* уже убран */ }
  }
});

function tmpFile(name = 'config.user.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-config-'));
  TEMP_ROOTS.push(dir);
  return path.join(dir, name);
}

test('запись и чтение по кругу', () => {
  const file = tmpFile();
  assert.strictEqual(writeOverlay(file, { net: { host: '100.120.245.85' } }), true);
  assert.deepStrictEqual(readOverlay(file), { net: { host: '100.120.245.85' } });
});

test('файла нет — пустой оверлей, а не падение', () => {
  const file = tmpFile();
  assert.deepStrictEqual(readOverlay(file), {});
});

test('битый файл больше не стирает настройки: берётся предыдущее поколение', () => {
  // Главный сценарий находки. Сначала сохраняем настоящие настройки, потом
  // портим основной файл (обрыв питания посреди записи выглядит именно так) —
  // и ждём, что вернутся прежние значения, а не пустота.
  const file = tmpFile();
  writeOverlay(file, { net: { host: '100.120.245.85', port: 48300 } });
  writeOverlay(file, { net: { host: '100.120.245.85', port: 48300 }, terminal: { fontSize: 15 } });

  fs.writeFileSync(file, '{ "net": { "host": "100.1', 'utf8'); // оборванный JSON

  const restored = readOverlay(file);
  assert.strictEqual(restored.net.host, '100.120.245.85', 'адрес сетевого доступа потерян');
  assert.strictEqual(restored.net.port, 48300);
});

test('в .bak уходит только ВАЛИДНОЕ поколение', () => {
  // Тот же довод, что в workspace.js: если копировать в .bak что попало, одна
  // внешняя порча затирает страховку ровно тогда, когда она нужна.
  const file = tmpFile();
  writeOverlay(file, { keep: 'это последнее хорошее' }); // файла ещё нет — .bak не заводится
  writeOverlay(file, { keep: 'это последнее хорошее', more: 1 }); // теперь .bak = первое поколение
  fs.writeFileSync(file, 'не json вовсе', 'utf8');

  writeOverlay(file, { fresh: true }); // пишем поверх битого

  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')),
    { keep: 'это последнее хорошее' },
    'битое содержимое затёрло страховку',
  );
});

test('временный файл не остаётся рядом', () => {
  const file = tmpFile();
  writeOverlay(file, { a: 1 });
  assert.strictEqual(fs.existsSync(`${file}.tmp`), false, 'мусорный .tmp остался в userData');
});

test('запись в недоступное место не бросает, а честно возвращает false', () => {
  // setConfig зовётся из обработчика IPC: исключение оттуда уходит в
  // uncaughtException и роняет всё приложение (main.js).
  const file = path.join(tmpFile(), 'вложенный', 'config.user.json');
  fs.writeFileSync(path.dirname(path.dirname(file)), 'я файл, а не каталог', 'utf8');
  assert.strictEqual(writeOverlay(file, { a: 1 }), false);
});

test('обрыв на полпути не портит уже сохранённое', () => {
  // Суть атомарности: пока новый файл не переименован, старый цел. Ломаем
  // rename и проверяем, что читатель по-прежнему видит прежние настройки.
  const file = tmpFile();
  writeOverlay(file, { net: { host: '100.120.245.85' } });

  const realRename = fs.renameSync;
  fs.renameSync = () => { throw new Error('обрыв записи'); };
  let ok;
  try {
    ok = writeOverlay(file, { net: { host: 'сломанное' } });
  } finally {
    fs.renameSync = realRename;
  }

  assert.strictEqual(ok, false);
  assert.deepStrictEqual(readOverlay(file), { net: { host: '100.120.245.85' } }, 'прежние настройки не пережили обрыв');
});

test('массив и null оверлеем не считаются', () => {
  // deepMerge ниже по стеку ждёт объект; массив формально разбирается, но
  // настройками не является.
  const file = tmpFile();
  fs.writeFileSync(file, '[1,2,3]', 'utf8');
  assert.deepStrictEqual(readOverlay(file), {});
  fs.writeFileSync(file, 'null', 'utf8');
  assert.deepStrictEqual(readOverlay(file), {});
});

test('удаление конфига — это сброс настроек, а не повод воскресить их из .bak', () => {
  // Замечание ревью фикса: отступать на страховку при ОТСУТСТВИИ файла нельзя.
  // Человек удаляет config.user.json, чтобы вернуться к дефолтам; если рядом
  // молча оживёт .bak, сброс потребует знания про второй, никому не обещанный
  // файл — и следующая запись вернёт старые настройки в основной.
  const file = tmpFile();
  writeOverlay(file, { net: { host: '100.120.245.85' } });
  writeOverlay(file, { net: { host: '100.120.245.85' }, terminal: { fontSize: 15 } }); // теперь есть .bak
  fs.rmSync(file);

  assert.deepStrictEqual(readOverlay(file), {}, 'удалённый конфиг не должен воскресать');
  assert.ok(fs.existsSync(`${file}.bak`), 'сама страховка при этом остаётся на месте');
});

test('parseJsonFile: и отсутствие, и порча дают null; валидный объект — как есть', () => {
  const file = tmpFile();
  assert.strictEqual(parseJsonFile(file), null, 'файла нет');
  fs.writeFileSync(file, '{ "a": 1', 'utf8');
  assert.strictEqual(parseJsonFile(file), null, 'файл битый');
  fs.writeFileSync(file, '{ "a": 1 }', 'utf8');
  assert.deepStrictEqual(parseJsonFile(file), { a: 1 });
});
