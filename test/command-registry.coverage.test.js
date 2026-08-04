'use strict';
// Шов «сколько каналов зарегистрировано в ipc.js» ↔ «сколько попало в реестр».
// Забытая команда не ломает локальный кокпит и потому незаметна — она молча
// не работает только по сети. Тест читает исходник и требует, чтобы прямых
// вызовов ipcMain не осталось вовсе.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ipc.js'), 'utf8');

// Important (ревью задачи 2): регэксп ловил канал ТОЛЬКО в одинарных
// кавычках — `ipcMain.handle("net:secret", ...)` в двойных (или в
// обратных, шаблонная строка без интерполяции) молча проходил бы мимо
// обоих тестов, хотя это ровно тот же прямой вызов ipcMain в обход
// реестра, для отлова которого тест и существует. Линтера, принуждающего
// к единому стилю кавычек, в проекте нет — полагаться на стиль нельзя,
// матчить нужно все три формы. Заодно покрыты handleOnce/once — реже
// встречающиеся, но полноправные формы регистрации канала, которые тест
// раньше не видел вовсе.
// Формы вызова: handle/handleOnce/on/once — все четыре кладут обработчик на
// канал; кавычки: '/"/` — все три допустимые в JS для строкового литерала.
function channelsCalledOn(obj, text) {
  const re = new RegExp(`\\b${obj}\\.(handle|handleOnce|on|once)\\(\\s*['"\`]([^'"\`]+)['"\`]`, 'g');
  return [...text.matchAll(re)].map((m) => m[2]);
}

test('в ipc.js не осталось прямых ipcMain.handle/ipcMain.on', () => {
  const direct = channelsCalledOn('ipcMain', src);
  assert.deepStrictEqual(direct, [], `эти каналы не попали в реестр: ${direct.join(', ')}`);
});

// Порог 43, а не оценочные «45» из плана задачи (docs/superpowers/plans/
// 2026-08-04-cockpit-remote-foundation.md, раздел «Задача 2»): на момент
// написания этого теста в ipc.js фактически 4 канала группы tabs:* (задача 1)
// + 39 остальных = 43 уникальных канала, без единого пропущенного или
// задвоенного. Плановая оценка была сделана заранее и разошлась с реальным
// числом — живая проверка важнее переписанной вслепую цифры.
test('через реестр зарегистрировано не меньше 43 каналов', () => {
  const viaRegistry = channelsCalledOn('registry', src);
  assert.ok(viaRegistry.length >= 43, `в реестре только ${viaRegistry.length}`);
  assert.strictEqual(new Set(viaRegistry).size, viaRegistry.length, 'канал зарегистрирован дважды');
});
