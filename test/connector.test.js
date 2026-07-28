'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { connectProject, isConnected, hookCommand, EVENTS } = require('../src/main/connector');

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

test('connect в проект без settings.json создаёт файл со всеми шестью событиями (Task 2 фазы 6: + PostToolUse)', () => {
  const dir = tmpProject();
  const res = connectProject(dir, OPTS);
  assert.strictEqual(res.connected, true);
  const s = readSettings(dir);
  for (const ev of EVENTS) {
    assert.ok(Array.isArray(s.hooks[ev]), `нет ${ev}`);
    const cmds = JSON.stringify(s.hooks[ev]);
    assert.ok(cmds.includes('cockpit-hook.js'), `нет нашей команды в ${ev}`);
  }
  assert.strictEqual(s.hooks.PreToolUse[0].matcher, '*');
  // PostToolUse — тоже с matcher '*' (любой инструмент), как PreToolUse.
  assert.strictEqual(s.hooks.PostToolUse[0].matcher, '*');
  assert.strictEqual(isConnected(dir), true);
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
  assert.strictEqual(isConnected(tmpProject()), false);
  const dir = tmpProject(JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] } }));
  assert.strictEqual(isConnected(dir), false);
});

test('hookCommand содержит node, скрипт в кавычках, имя события и port-file', () => {
  const cmd = hookCommand('Stop', OPTS);
  assert.ok(cmd.startsWith('node "'));
  assert.ok(cmd.includes('cockpit-hook.js" Stop'));
  assert.ok(cmd.includes('--port-file "C:\\cockpit\\bridge-port"'));
});

test('проект с hooks-как-массив (некорректная структура) — конвертируется, события пишутся', () => {
  const dir = tmpProject(JSON.stringify({ hooks: [] }));
  const res = connectProject(dir, OPTS);
  assert.strictEqual(res.connected, true);
  const s = readSettings(dir);
  for (const ev of EVENTS) {
    assert.ok(Array.isArray(s.hooks[ev]), `нет ${ev}`);
    const cmds = JSON.stringify(s.hooks[ev]);
    assert.ok(cmds.includes('cockpit-hook.js'), `нет нашей команды в ${ev}`);
  }
  assert.strictEqual(isConnected(dir), true);
});

// ---------- Task 2 фазы 6: строгий isConnected (проверка ВСЕХ EVENTS, не только маркера) ----------

test('(а) проект со старым набором из 5 событий (без PostToolUse) — isConnected === false', () => {
  // Симулируем settings.json проекта, подключённого ДО появления PostToolUse:
  // наш маркер присутствует во всех пяти старых событиях, шестого нет вовсе.
  const oldEvents = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Notification', 'Stop'];
  const hooks = {};
  for (const ev of oldEvents) {
    const entry = { hooks: [{ type: 'command', command: hookCommand(ev, OPTS) }] };
    if (ev === 'PreToolUse') entry.matcher = '*';
    hooks[ev] = [entry];
  }
  const dir = tmpProject(JSON.stringify({ hooks }));
  // Старая проверка (просто includes(MARKER) в файле) сочла бы это подключённым —
  // именно этот баг и чинит Task 2: PostToolUse отсутствует, значит НЕ подключено.
  assert.strictEqual(isConnected(dir), false);
});

test('(б) повторный connectProject поверх старого набора (5 событий) — isConnected становится true, в файле шесть событий', () => {
  const oldEvents = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Notification', 'Stop'];
  const hooks = {};
  for (const ev of oldEvents) {
    const entry = { hooks: [{ type: 'command', command: hookCommand(ev, OPTS) }] };
    if (ev === 'PreToolUse') entry.matcher = '*';
    hooks[ev] = [entry];
  }
  const dir = tmpProject(JSON.stringify({ hooks }));
  assert.strictEqual(isConnected(dir), false); // до до-подключения — как в (а)

  const res = connectProject(dir, OPTS);
  assert.strictEqual(res.connected, true);
  assert.strictEqual(isConnected(dir), true);

  const s = readSettings(dir);
  assert.strictEqual(EVENTS.length, 6, 'в этой фазе EVENTS должен содержать ровно шесть событий');
  for (const ev of EVENTS) {
    assert.ok(Array.isArray(s.hooks[ev]), `нет ${ev} после до-подключения`);
    assert.ok(JSON.stringify(s.hooks[ev]).includes('cockpit-hook.js'), `нет нашей команды в ${ev}`);
  }
});

test('(в) чужие хуки по-прежнему сохраняются при до-подключении старого проекта (включая соседей PostToolUse)', () => {
  const dir = tmpProject(JSON.stringify({
    permissions: { allow: ['Bash(npm test)'] },
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'node my-own-hook.js' }] }],
      // Чужая запись именно в PostToolUse — том самом событии, которого не
      // хватало старому подключению. connectProject должен ДОБАВИТЬ свою
      // запись рядом, не тронув чужую.
      PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node someone-elses-hook.js' }] }],
    },
  }));
  connectProject(dir, OPTS);
  const s = readSettings(dir);
  assert.deepStrictEqual(s.permissions, { allow: ['Bash(npm test)'] });

  const stopCmds = JSON.stringify(s.hooks.Stop);
  assert.ok(stopCmds.includes('my-own-hook.js'));
  assert.ok(stopCmds.includes('cockpit-hook.js'));

  const postToolUseCmds = JSON.stringify(s.hooks.PostToolUse);
  assert.ok(postToolUseCmds.includes('someone-elses-hook.js'), 'чужая запись PostToolUse должна была сохраниться');
  assert.ok(postToolUseCmds.includes('cockpit-hook.js'), 'наша запись PostToolUse должна была добавиться рядом');

  assert.strictEqual(isConnected(dir), true);
});
