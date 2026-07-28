'use strict';
// Файловый журнал «Ночной смены» (Task 2 фазы 8): JSON-массив записей,
// атомарная запись (temp+rename, тот же приём, что workspace.js/recipes.js).
// Битый файл → readAll()=[] + однократный .bak ПЕРЕД первой перезаписью
// поверх битого (образец recipes.js/writeList) — модуль НИКОГДА не бросает.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createNightJournal } = require('../src/main/night-journal');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-night-journal-'));
  return path.join(dir, 'night-journal.json');
}

// --- append/readAll круговой ---

test('readAll: файла нет → []', () => {
  const journal = createNightJournal({ file: tmpFile() });
  assert.deepStrictEqual(journal.readAll(), []);
});

test('append→readAll: одна запись круговым путём', () => {
  const file = tmpFile();
  const journal = createNightJournal({ file });
  journal.append({ ts: 1, type: 'armed' });
  assert.deepStrictEqual(journal.readAll(), [{ ts: 1, type: 'armed' }]);
});

test('append несколько раз подряд — накапливается по порядку', () => {
  const file = tmpFile();
  const journal = createNightJournal({ file });
  journal.append({ ts: 1, type: 'armed' });
  journal.append({ ts: 2, type: 'limit-stop', tabId: 'a' });
  journal.append({ ts: 3, type: 'wake-complete', detail: '1 of 1' });
  assert.deepStrictEqual(journal.readAll(), [
    { ts: 1, type: 'armed' },
    { ts: 2, type: 'limit-stop', tabId: 'a' },
    { ts: 3, type: 'wake-complete', detail: '1 of 1' },
  ]);
});

test('append переживает перезапуск: новый инстанс над тем же file видит прежние записи', () => {
  const file = tmpFile();
  createNightJournal({ file }).append({ ts: 1, type: 'armed' });
  const reopened = createNightJournal({ file });
  assert.deepStrictEqual(reopened.readAll(), [{ ts: 1, type: 'armed' }]);
});

// --- reset ---

test('reset→пусто: readAll() после reset() возвращает []', () => {
  const file = tmpFile();
  const journal = createNightJournal({ file });
  journal.append({ ts: 1, type: 'armed' });
  journal.reset();
  assert.deepStrictEqual(journal.readAll(), []);
});

test('reset на файле, которого ещё не было — не бросает, readAll() пуст', () => {
  const journal = createNightJournal({ file: tmpFile() });
  assert.doesNotThrow(() => journal.reset());
  assert.deepStrictEqual(journal.readAll(), []);
});

// --- битый файл → [] + .bak одноразовый ---

test('битый файл (не JSON) → readAll()=[], НЕ бросает', () => {
  const file = tmpFile();
  fs.writeFileSync(file, 'не json вовсе {{{', 'utf8');
  const journal = createNightJournal({ file });
  assert.deepStrictEqual(journal.readAll(), []);
});

test('файл валидный JSON, но не массив → readAll()=[]', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ not: 'array' }), 'utf8');
  const journal = createNightJournal({ file });
  assert.deepStrictEqual(journal.readAll(), []);
});

test('битый файл: .bak создаётся ИМЕННО при первой записи поверх него, с исходным содержимым', () => {
  const file = tmpFile();
  const original = 'битый мусор ###';
  fs.writeFileSync(file, original, 'utf8');
  const journal = createNightJournal({ file });

  assert.strictEqual(fs.existsSync(`${file}.bak`), false); // ещё не писали — бэкапа нет

  journal.append({ ts: 1, type: 'armed' });
  assert.strictEqual(fs.existsSync(`${file}.bak`), true);
  assert.strictEqual(fs.readFileSync(`${file}.bak`, 'utf8'), original);
  assert.deepStrictEqual(journal.readAll(), [{ ts: 1, type: 'armed' }]);
});

test('битый файл: .bak одноразовый — вторая запись НЕ перезаписывает уже созданный .bak', () => {
  const file = tmpFile();
  const original = 'битый мусор ###';
  fs.writeFileSync(file, original, 'utf8');
  const journal = createNightJournal({ file });

  journal.append({ ts: 1, type: 'armed' }); // первая запись поверх битого — создаёт .bak
  journal.append({ ts: 2, type: 'disarmed' }); // файл теперь валиден — второй .bak НЕ создаётся заново

  assert.strictEqual(fs.readFileSync(`${file}.bak`, 'utf8'), original);
  assert.deepStrictEqual(journal.readAll(), [
    { ts: 1, type: 'armed' },
    { ts: 2, type: 'disarmed' },
  ]);
});

// --- атомарность: сбой rename не должен портить/наполовину переписывать file ---

function fakeFsThrowingRename(realFile) {
  // Фейковый fs: readFileSync/writeFileSync/mkdirSync делегируют реальному
  // модулю fs (чтобы можно было проверить итоговое содержимое realFile
  // обычным способом), а renameSync ВСЕГДА бросает — имитация сбоя диска
  // ровно в момент коммита temp→file.
  return {
    readFileSync: (...args) => fs.readFileSync(...args),
    writeFileSync: (...args) => fs.writeFileSync(...args),
    mkdirSync: (...args) => fs.mkdirSync(...args),
    renameSync: () => { throw new Error('симулированный сбой rename'); },
  };
}

test('атомарность: падение renameSync не бросает наружу и не портит исходный файл', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify([{ ts: 1, type: 'armed' }]), 'utf8');
  const journal = createNightJournal({ file, fs: fakeFsThrowingRename(file) });

  assert.doesNotThrow(() => journal.append({ ts: 2, type: 'limit-stop', tabId: 'a' }));
  // rename упал ДО коммита — исходный файл остаётся ПРЕЖНИМ валидным содержимым.
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [{ ts: 1, type: 'armed' }]);
});

test('атомарность: падение renameSync на файле, которого ещё не было — не создаёт мусорный file', () => {
  const file = tmpFile();
  const journal = createNightJournal({ file, fs: fakeFsThrowingRename(file) });

  assert.doesNotThrow(() => journal.append({ ts: 1, type: 'armed' }));
  assert.strictEqual(fs.existsSync(file), false);
});

test('never throws: append/readAll/reset все проглатывают ошибки инжектированного fs', () => {
  const throwingFs = {
    readFileSync: () => { throw new Error('диск недоступен'); },
    writeFileSync: () => { throw new Error('диск недоступен'); },
    mkdirSync: () => { throw new Error('диск недоступен'); },
    renameSync: () => { throw new Error('диск недоступен'); },
  };
  const journal = createNightJournal({ file: 'C:\\nonexistent\\night-journal.json', fs: throwingFs });
  assert.doesNotThrow(() => journal.append({ ts: 1, type: 'armed' }));
  assert.doesNotThrow(() => journal.reset());
  let result;
  assert.doesNotThrow(() => { result = journal.readAll(); });
  assert.deepStrictEqual(result, []);
});
