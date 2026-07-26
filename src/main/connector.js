'use strict';
// «Подключить проект»: прописывает хуки Cockpit в .claude/settings.json проекта.
// Merge аккуратный: чужие хуки и ключи сохраняются, свои записи (узнаём по
// подстроке cockpit-hook.js) заменяются идемпотентно. Битый JSON не трогаем.

const fs = require('fs');
const path = require('path');

const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Notification', 'Stop'];
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
    if (event === 'PreToolUse') entry.matcher = '*';
    const existing = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    settings.hooks[event] = [...existing.filter((e) => !isOurs(e)), entry];
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return { connected: true, settingsPath: file };
}

function isConnected(projectDir) {
  const file = settingsPath(projectDir);
  try {
    return fs.readFileSync(file, 'utf8').includes(MARKER);
  } catch {
    return false;
  }
}

module.exports = { connectProject, isConnected, hookCommand, EVENTS };
