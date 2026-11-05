'use strict';
// Стражи по исходнику ipc.js — гигиена обвязки (ревью 09.08, раздел C).
//
// registerIpc под node --test не поднять (require('electron') вне рантайма не
// даёт объект), поэтому то, что живёт только внутри него, держится текстом.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const IPC_JS = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ipc.js'), 'utf8');

// Комментарии выкидываем: якорь не должен цепляться за цитату кода в них.
const codeOnly = (source) => source
  .split(/\r?\n/)
  .filter((line) => !/^\s*\/\//.test(line))
  .map((line) => line.replace(/\/\*.*?\*\//g, '').replace(/\s\/\/\s.*$/, ''))
  .join('\n');

// C20/C21 (ре-ревью): кэши лимитов и истории не переписывают файл, если
// данные не менялись, — и для этого им надо знать, легла ли прошлая запись.
// Настоящий кэш ошибку диска (EBUSY/EPERM от антивируса) глотает сам, так что
// без ответа write() проваленная запись считалась бы сделанной.
test('C20/C21: createJsonFileCache.write отвечает, легла ли запись на диск', (t) => {
  const { createJsonFileCache } = require('../src/main/ipc');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'json-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const good = createJsonFileCache(path.join(dir, 'sub', 'c.json'));
  assert.strictEqual(good.write({ a: 1 }), true);
  assert.deepStrictEqual(good.read(), { a: 1 });

  // Файл на месте каталога — запись лечь не может.
  fs.writeFileSync(path.join(dir, 'blocker'), 'x');
  const bad = createJsonFileCache(path.join(dir, 'blocker', 'c.json'));
  assert.strictEqual(bad.write({ a: 1 }), false);
});

// C26: обёртка «setTimeout + unref» для инжектируемых таймеров была
// продублирована дословно (ночная смена и голосовой ввод) — одна копия.
test('C26: unrefSetTimer — таймер срабатывает и не держит процесс живым', async () => {
  const { unrefSetTimer } = require('../src/main/ipc');
  let fired = false;
  const id = unrefSetTimer(() => { fired = true; }, 5);
  assert.strictEqual(id.hasRef(), false, 'таймер держит event loop — процесс не выйдет, пока он не сработает');
  // Свой ref'нутый таймер ждёт срабатывания: unref'нутый сам не удержал бы тест.
  await new Promise((resolve) => { setTimeout(resolve, 30); });
  assert.strictEqual(fired, true);
  clearTimeout(id);
});

test('C26: инжектируемый setTimer в ipc.js — одна общая обёртка, а не копии', () => {
  const code = codeOnly(IPC_JS);
  const inline = code.match(/setTimer:\s*\(/g) || [];
  assert.strictEqual(inline.length, 0, `инлайн-обёрток setTimer в ipc.js: ${inline.length}`);
  const shared = code.match(/setTimer:\s*unrefSetTimer\b/g) || [];
  assert.strictEqual(shared.length, 2, `ожидалось 2 места с setTimer: unrefSetTimer (ночная смена, голос), найдено ${shared.length}`);
});

// C23: сама логика детекта под тестом на настоящих ядрах (routeLimitStop в
// test/ipc-smoke-gate.test.js), но звать её обязан onEvent — сразу после того,
// как prev прочитан из карты статусов и карта обновлена.
test('C23: onEvent отдаёт событие tab:status в routeLimitStop с prev из карты статусов', () => {
  const code = codeOnly(IPC_JS);
  const anchor = 'const prev = lastStatusByTab.get(payload.tabId);';
  assert.strictEqual(code.split(anchor).length - 1, 1, 'якорь чтения prev не найден или не один');
  const after = code.slice(code.indexOf(anchor), code.indexOf(anchor) + 300);
  assert.match(
    after,
    /^const prev = lastStatusByTab\.get\(payload\.tabId\);\s*lastStatusByTab\.set\(payload\.tabId, payload\.status\);\s*routeLimitStop\(\{ prev, payload, nightWatch, manager \}\);/,
    'детект лимит-стопа больше не вызывается из onEvent — ночная смена не заметит остановку по лимиту',
  );
  const calls = code.match(/(?<!function )routeLimitStop\(\{/g) || [];
  assert.strictEqual(calls.length, 1, `ожидался ровно один вызов routeLimitStop, найдено ${calls.length}`);
});

// C24: list() копирует ВСЕ вкладки с очередями, а искали в нём одну по tabId —
// семь раз, дважды на одно событие tab:status. Для одной вкладки есть get().
test('C24: одну вкладку по tabId обвязка берёт через manager.get(), а не list().find()', () => {
  const code = codeOnly(IPC_JS);
  const finds = code.match(/manager\.list\(\)\s*\.find\(/g) || [];
  assert.strictEqual(finds.length, 0, `manager.list().find(...) в ipc.js: ${finds.length}`);
  // Якорь: читаем тот самый файл, и замена действительно сделана.
  const gets = code.match(/manager\.get\(/g) || [];
  assert.ok(gets.length >= 7, `ожидалось не меньше 7 вызовов manager.get(), найдено ${gets.length}`);
});
