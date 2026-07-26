'use strict';
// Выбор и инициализация рабочей папки Claude.

const fs   = require('fs');
const path = require('path');
const { app, dialog } = require('electron');
const { appRoot } = require('./paths');

// Путь к Stop-хуку (прямые слэши — шелл хуков не понимает обратные).
function hookPath() {
  return path.join(appRoot(), 'scripts', 'claude-stop-hook.js').replace(/\\/g, '/');
}

// Создать папку (и родителей) если нет.
function mkdirSafe(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* уже есть */ }
}

// Записать файл только если он ещё не существует.
function writeIfAbsent(filePath, content) {
  if (fs.existsSync(filePath)) return;
  mkdirSafe(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf8');
}

// Засеять рабочую папку шаблонными файлами (не перезаписывать существующие).
function seedWorkdir(dir) {
  // CLAUDE.md — из шаблона
  const tmpl = path.join(appRoot(), 'templates', 'CLAUDE.md');
  let claudeMd = '';
  try { claudeMd = fs.readFileSync(tmpl, 'utf8'); } catch (e) {
    console.warn('[workdir] не удалось прочитать шаблон CLAUDE.md:', e.message);
  }
  writeIfAbsent(path.join(dir, 'CLAUDE.md'), claudeMd);

  // .claude/settings.json — Stop-хук
  const settingsPath = path.join(dir, '.claude', 'settings.json');
  const settings = JSON.stringify(
    {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: 'command', command: `node ${hookPath()}` },
            ],
          },
        ],
      },
    },
    null,
    2,
  );
  writeIfAbsent(settingsPath, settings);
}

// Показать диалог выбора папки.
// Возвращает выбранный путь или null при отмене.
async function _showDialog(win) {
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Выбери рабочую папку для Claude',
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
}

// Проверить, что папка существует на диске.
function dirExists(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// Убедиться, что рабочая папка задана.
// Если cwd в конфиге непустой и существует — вернуть его без диалога.
// Иначе — показать диалог; отмена → app.getPath('home').
// Выбранный путь сохраняется в конфиге.
async function ensureWorkdir(win, getConfig, setConfig) {
  const saved = getConfig().terminal.cwd;
  if (saved && dirExists(saved)) return saved;

  // cwd пустой или папка не существует — спрашиваем пользователя
  const chosen = await _showDialog(win);
  const cwd = chosen || app.getPath('home');
  setConfig({ terminal: { cwd } });
  return cwd;
}

// Диалог смены папки — всегда показывает выбор.
// После выбора: сохраняет конфиг + засевает; возвращает путь или null при отмене.
async function chooseWorkdir(win, getConfig, setConfig) {
  const chosen = await _showDialog(win);
  if (!chosen) return null;
  setConfig({ terminal: { cwd: chosen } });
  seedWorkdir(chosen);
  return chosen;
}

module.exports = { ensureWorkdir, seedWorkdir, chooseWorkdir };
