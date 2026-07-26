'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createHookBridge } = require('../src/main/hook-bridge');

function makeFakeSessions() {
  const calls = [];
  const bySession = new Map();
  const byCwd = new Map();
  return {
    calls,
    bySession,
    byCwd,
    findBySessionId: (sid) => bySession.get(sid) || null,
    findUnboundByCwd: (cwd) => byCwd.get(cwd) || null,
    applyHookEvent: (tabId, event, data) => calls.push({ tabId, event, data }),
  };
}

function post(port, body) {
  return new Promise((resolve, reject) => {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, path: '/event', method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

test('маршрутизация по session_id доставляет applyHookEvent', async () => {
  const sessions = makeFakeSessions();
  sessions.bySession.set('sess-1', 'tab-1');
  const bridge = createHookBridge({ sessions, port: 0 });
  const port = await bridge.start();
  const res = await post(port, { event: 'Stop', data: { session_id: 'sess-1' } });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(sessions.calls[0], { tabId: 'tab-1', event: 'Stop', data: { session_id: 'sess-1' } });
  bridge.stop();
});

test('fallback по cwd для непривязанной вкладки', async () => {
  const sessions = makeFakeSessions();
  sessions.byCwd.set('C:\\proj\\alpha', 'tab-2');
  const bridge = createHookBridge({ sessions, port: 0 });
  const port = await bridge.start();
  const res = await post(port, { event: 'SessionStart', data: { session_id: 'new-sess', cwd: 'C:\\proj\\alpha' } });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(sessions.calls[0].tabId, 'tab-2');
  assert.strictEqual(sessions.calls[0].event, 'SessionStart');
  bridge.stop();
});

test('незнакомая сессия без cwd-совпадения → 202, applyHookEvent не зовётся', async () => {
  const sessions = makeFakeSessions();
  const bridge = createHookBridge({ sessions, port: 0 });
  const port = await bridge.start();
  const res = await post(port, { event: 'Stop', data: { session_id: 'ghost', cwd: 'C:\\nowhere' } });
  assert.strictEqual(res.status, 202);
  assert.strictEqual(sessions.calls.length, 0);
  bridge.stop();
});

test('битый JSON и не-POST → 400/404, сервер не падает', async () => {
  const sessions = makeFakeSessions();
  const bridge = createHookBridge({ sessions, port: 0 });
  const port = await bridge.start();
  const bad = await post(port, '{oops');
  assert.strictEqual(bad.status, 400);
  const res2 = await post(port, { event: 42 });
  assert.strictEqual(res2.status, 400);
  // сервер жив после мусора
  sessions.bySession.set('s', 't');
  const ok = await post(port, { event: 'Stop', data: { session_id: 's' } });
  assert.strictEqual(ok.status, 200);
  bridge.stop();
});

test('portFile получает фактический порт', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const pf = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-test-')), 'bridge-port');
  const sessions = makeFakeSessions();
  const bridge = createHookBridge({ sessions, port: 0, portFile: pf });
  const port = await bridge.start();
  assert.strictEqual(Number(fs.readFileSync(pf, 'utf8').trim()), port);
  bridge.stop();
});
