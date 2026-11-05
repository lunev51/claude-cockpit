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
