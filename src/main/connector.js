'use strict';
// «Подключить проект»: прописывает хуки Cockpit в .claude/settings.json проекта.
// Merge аккуратный: чужие хуки и ключи сохраняются, свои записи (узнаём по
// подстроке cockpit-hook.js) заменяются идемпотентно. Битый JSON не трогаем.

const fs = require('fs');
const path = require('path');

// PostToolUse добавлен в фазе 6 (Task 2, панель диффа): sessions.js эмитит
// git:changed на КАЖДЫЙ вызов инструмента — панель узнаёт, что стоит обновить
// статус git, не дожидаясь Stop. matcher '*' — как у PreToolUse (любой инструмент).
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop'];
const MARKER = 'cockpit-hook.js';

function hookCommand(event, { scriptPath, portFile }) {
  return `node "${scriptPath}" ${event} --port-file "${portFile}"`;
}

function settingsPath(projectDir) {
  return path.join(projectDir, '.claude', 'settings.json');
}

// Наша ли это запись события (ищем маркер в командах).
function isOurs(entry) {
  return JSON.stringify(entry).includes(MARKER);
}

function connectProject(projectDir, opts) {
  const file = settingsPath(projectDir);
  let settings = {};
  if (fs.existsSync(file)) {
    try {
      settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      return { connected: false, error: `settings.json повреждён: ${err.message}` };
    }
  }
  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) settings.hooks = {};

  for (const event of EVENTS) {
    const entry = { hooks: [{ type: 'command', command: hookCommand(event, opts) }] };
    if (event === 'PreToolUse' || event === 'PostToolUse') entry.matcher = '*';
    const existing = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    settings.hooks[event] = [...existing.filter((e) => !isOurs(e)), entry];
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return { connected: true, settingsPath: file };
}

// Fix (Task 2 фазы 6, ревью задачи): раньше isConnected() проверял лишь
// наличие маркера cockpit-hook.js ГДЕ УГОДНО в файле — проект, подключённый
// ДО появления PostToolUse (5 событий), навсегда считался бы «подключён»,
// молча не отправляя новое событие, а кнопка ⚡ в интерфейсе больше не
// загоралась бы, чтобы это исправить одним кликом. Теперь isConnected true,
// только если НАША запись (по маркеру) присутствует в hooks[event] для
// КАЖДОГО события из EVENTS — отсутствие хотя бы одного (например,
// PostToolUse у старого подключения) даёт false.
function isConnected(projectDir) {
  const file = settingsPath(projectDir);
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return false; // файла нет или битый JSON — точно не подключено
  }
  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) return false;
  return EVENTS.every((event) => {
    const arr = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    return arr.some(isOurs);
  });
}

module.exports = { connectProject, isConnected, hookCommand, EVENTS };
