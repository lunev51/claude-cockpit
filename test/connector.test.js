'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { connectProject, isConnected, hookCommand } = require('../src/main/connector');

const OPTS = { scriptPath: 'C:\\cockpit\\scripts\\cockpit-hook.js', portFile: 'C:\\cockpit\\bridge-port' };

function tmpProject(settings) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-conn-'));
  if (settings !== undefined) {
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), settings, 'utf8');
  }
  return dir;
}

const readSettings = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));

test('connect в проект без settings.json создаёт файл со всеми пятью событиями', () => {
  const dir = tmpProject();
  const res = connectProject(dir, OPTS);
  assert.strictEqual(res.connected, true);
  const s = readSettings(dir);
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Notification', 'Stop']) {
    assert.ok(Array.isArray(s.hooks[ev]), `нет ${ev}`);
    const cmds = JSON.stringify(s.hooks[ev]);
    assert.ok(cmds.includes('cockpit-hook.js'), `нет нашей команды в ${ev}`);
  }
  // PreToolUse — с matcher
  assert.strictEqual(s.hooks.PreToolUse[0].matcher, '*');
  assert.strictEqual(isConnected(dir, OPTS), true);
});

test('чужие хуки и прочие ключи сохраняются', () => {
  const dir = tmpProject(JSON.stringify({
    permissions: { allow: ['Bash(npm test)'] },
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node my-own-hook.js' }] }] },
  }));
  connectProject(dir, OPTS);
  const s = readSettings(dir);
  assert.deepStrictEqual(s.permissions, { allow: ['Bash(npm test)'] });
  const stopCmds = JSON.stringify(s.hooks.Stop);
  assert.ok(stopCmds.includes('my-own-hook.js'));
  assert.ok(stopCmds.includes('cockpit-hook.js'));
});

test('повторный connect идемпотентен (наши записи не дублируются)', () => {
  const dir = tmpProject();
  connectProject(dir, OPTS);
  connectProject(dir, OPTS);
  const s = readSettings(dir);
  const count = (JSON.stringify(s.hooks.Stop).match(/cockpit-hook\.js/g) || []).length;
  assert.strictEqual(count, 1);
});

test('битый settings.json не перезаписывается', () => {
  const dir = tmpProject('{broken');
  const res = connectProject(dir, OPTS);
  assert.strictEqual(res.connected, false);
  assert.ok(res.error);
  assert.strictEqual(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'), '{broken');
});

test('isConnected: false без файла и без наших записей', () => {
  assert.strictEqual(isConnected(tmpProject(), OPTS), false);
  const dir = tmpProject(JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] } }));
  assert.strictEqual(isConnected(dir, OPTS), false);
});

test('hookCommand содержит node, скрипт в кавычках, имя события и port-file', () => {
  const cmd = hookCommand('Stop', OPTS);
  assert.ok(cmd.startsWith('node "'));
  assert.ok(cmd.includes('cockpit-hook.js" Stop'));
  assert.ok(cmd.includes('--port-file "C:\\cockpit\\bridge-port"'));
});
