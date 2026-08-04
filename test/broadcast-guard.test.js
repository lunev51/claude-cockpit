'use strict';
// Страж исходящей половины: симметрично test/command-registry.coverage.test.js
// (тот ловит прямые ipcMain.handle/on в обход реестра команд), этот тест
// ловит прямые webContents.send в обход broadcast.emit — единственного
// места, откуда событие вообще может дойти до сетевого клиента.
//
// Зачем нужен именно такой тест (ревью задачи 3, Important 2): мутационная
// проверка на изолированной копии дерева показала, что npm test остаётся
// зелёным даже если откатить onEvent обратно на прямой win.webContents.send
// или вовсе выкинуть отправку usage:update из сторожевого таймера — вся
// проводка держалась только на смоуке, который не гоняется на каждом
// коммите. Этот тест читает исходники src/main/ и требует нуля прямых
// вызовов webContents.send везде, кроме самого broadcast.js (там это и есть
// точка отправки, легитимно).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const MAIN_DIR = path.join(__dirname, '..', 'src', 'main');
const ALLOWED_FILE = 'broadcast.js';
const CALL_RE = /\bwebContents\.send\s*\(/;

// Построчно, а не regex по всему файлу: нужно уметь отличить реальный вызов
// от упоминания в комментарии (в кодовой базе такие упоминания есть — см.
// toasts.js, sessions.js, night-watch.js, где webContents.send фигурирует
// только в тексте комментария, объясняющего, что делает чужой колбэк).
// Комментарии в этом проекте всегда однострочные ('//' с начала строки после
// отступа) — trim+startsWith достаточно, вложенных /* */ блоков с вызовами
// в коде нет (проверено вручную при написании теста).
function findDirectSends() {
  const violations = [];
  for (const name of fs.readdirSync(MAIN_DIR)) {
    if (!name.endsWith('.js') || name === ALLOWED_FILE) continue;
    const text = fs.readFileSync(path.join(MAIN_DIR, name), 'utf8');
    text.split('\n').forEach((line, i) => {
      if (line.trim().startsWith('//')) return; // строка целиком комментарий — не вызов
      if (CALL_RE.test(line)) violations.push(`${name}:${i + 1}`);
    });
  }
  return violations;
}

test('webContents.send нигде в src/main/, кроме broadcast.js', () => {
  const violations = findDirectSends();
  assert.deepStrictEqual(violations, [], `прямая отправка мимо broadcast.emit: ${violations.join(', ')}`);
});
