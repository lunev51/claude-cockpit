'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createWorkspaceStore } = require('../src/main/workspace');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-ws-'));
  return path.join(dir, 'workspace.json');
}

const STATE = {
  version: 1,
  activeIndex: 1,
  tabs: [
    { cwd: 'C:\\p\\alpha', name: 'alpha', sessionId: 's-1', ghostId: 'g-1' },
    { cwd: 'C:\\p\\beta', name: 'beta', sessionId: null, ghostId: 'g-2' },
  ],
};

test('set+flush пишет файл; load возвращает то же состояние', () => {
  const file = tmpFile();
  const store = createWorkspaceStore({ file, debounceMs: 10000 });
  store.set(STATE);
  store.flush();
  assert.deepStrictEqual(createWorkspaceStore({ file }).load(), STATE);
});

test('load без файла → null', () => {
  assert.strictEqual(createWorkspaceStore({ file: tmpFile() }).load(), null);
});

test('битый файл → падаем на .bak', () => {
  const file = tmpFile();
  const store = createWorkspaceStore({ file, debounceMs: 10 });
  store.set(STATE);
  store.flush();
  const next = { ...STATE, activeIndex: 0 };
  store.set(next);
  store.flush(); // при второй записи прежний файл ушёл в .bak
  fs.writeFileSync(file, '{broken', 'utf8');
  const loaded = createWorkspaceStore({ file }).load();
  assert.deepStrictEqual(loaded, STATE); // .bak хранит ПРЕДЫДУЩЕЕ валидное
});

test('битый файл и битый .bak → null, не бросает', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{broken', 'utf8');
  fs.writeFileSync(`${file}.bak`, 'also broken', 'utf8');
  assert.strictEqual(createWorkspaceStore({ file }).load(), null);
});

test('невалидная схема (tabs не массив) отвергается → .bak/null', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ version: 1, activeIndex: 0, tabs: 'nope' }), 'utf8');
  assert.strictEqual(createWorkspaceStore({ file }).load(), null);
});

test('дебаунс: серия set → одна запись после паузы', async () => {
  const file = tmpFile();
  const store = createWorkspaceStore({ file, debounceMs: 50 });
  for (let i = 0; i < 10; i++) store.set({ ...STATE, activeIndex: i % 2 });
  assert.strictEqual(fs.existsSync(file), false); // ещё не писали
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(fs.existsSync(file));
  assert.strictEqual(createWorkspaceStore({ file }).load().activeIndex, 1);
});

test('flush без set — no-op, файла нет', () => {
  const file = tmpFile();
  createWorkspaceStore({ file }).flush();
  assert.strictEqual(fs.existsSync(file), false);
});
