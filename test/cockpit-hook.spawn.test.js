'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const { execFile } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'cockpit-hook.js');

// Запуск скрипта с given env/args/stdin → {code, stdout, stderr}
function runHook({ args = [], env = {}, stdin = '' }) {
  return new Promise((resolve) => {
    const child = execFile('node', [SCRIPT, ...args], {
      env: { ...process.env, COCKPIT_BRIDGE_PORT: '', ...env },
      timeout: 5000,
    }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
    child.stdin.end(stdin);
  });
}

// Одноразовый стаб-сервер: принимает один POST, отдаёт 200.
function stubServer() {
  return new Promise((resolve) => {
    const received = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, received, port: server.address().port }));
  });
}

test('happy path: POST {event,data,tabId} с application/json, exit 0', async () => {
  const { server, received, port } = await stubServer();
  const res = await runHook({
    args: ['Stop'],
    env: { COCKPIT_BRIDGE_PORT: String(port), COCKPIT_TAB_ID: 'tab-42' },
    stdin: '{"session_id":"s-1","cwd":"C:\\\\p"}',
  });
  server.close();
  assert.strictEqual(res.code, 0);
  assert.strictEqual(received.length, 1);
  assert.ok(received[0].headers['content-type'].startsWith('application/json'));
  const payload = JSON.parse(received[0].body);
  assert.strictEqual(payload.event, 'Stop');
  assert.strictEqual(payload.tabId, 'tab-42');
  assert.strictEqual(payload.data.session_id, 's-1');
  // Без COCKPIT_TAB_GEN в env (не задан в этом тесте) — gen отдаётся null,
  // не 0/NaN/строкой (доп. находка ревью Task 1 фазы 7, задача 5).
  assert.strictEqual(payload.gen, null);
});

// ---------- доп. находка ревью Task 1 фазы 7 (задача 5): гард поколения ----------

test('COCKPIT_TAB_GEN в env → payload.gen несёт то же целое число', async () => {
  const { server, received, port } = await stubServer();
  const res = await runHook({
    args: ['Stop'],
    env: { COCKPIT_BRIDGE_PORT: String(port), COCKPIT_TAB_ID: 'tab-42', COCKPIT_TAB_GEN: '3' },
    stdin: '{"session_id":"s-1"}',
  });
  server.close();
  assert.strictEqual(res.code, 0);
  const payload = JSON.parse(received[0].body);
  assert.strictEqual(payload.gen, 3);
});

test('COCKPIT_TAB_GEN мусорный (не число/отрицательный/ноль) → payload.gen: null', async () => {
  for (const gen of ['abc', '-1', '0', '1.5', '']) {
    const { server, received, port } = await stubServer();
    // eslint-disable-next-line no-await-in-loop
    const res = await runHook({
      args: ['Stop'],
      env: { COCKPIT_BRIDGE_PORT: String(port), COCKPIT_TAB_GEN: gen },
      stdin: '{}',
    });
    server.close();
    assert.strictEqual(res.code, 0, gen);
    const payload = JSON.parse(received[0].body);
    assert.strictEqual(payload.gen, null, `COCKPIT_TAB_GEN=${JSON.stringify(gen)} должен был дать gen:null`);
  }
});

test('мёртвый порт, битый stdin, отсутствующий port-file — всегда exit 0', async () => {
  for (const opts of [
    { args: ['Stop'], env: { COCKPIT_BRIDGE_PORT: '1' }, stdin: '{}' },        // connection refused
    { args: ['Stop'], env: { COCKPIT_BRIDGE_PORT: '48333' }, stdin: '{oops' }, // битый JSON
    { args: ['Stop', '--port-file', 'C:\\nonexistent\\pf'], stdin: '{}' },     // нет файла и env
    { args: [], stdin: '{}' },                                                  // нет события
  ]) {
    const res = await runHook(opts);
    assert.strictEqual(res.code, 0, JSON.stringify(opts));
  }
});
