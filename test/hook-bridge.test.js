'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createHookBridge } = require('../src/main/hook-bridge');

function makeFakeSessions() {
  const calls = [];
  const bySession = new Map();
  const byCwd = new Map();
  const knownTabs = new Set();
  return {
    calls,
    bySession,
    byCwd,
    knownTabs,
    has: (tabId) => knownTabs.has(tabId),
    findBySessionId: (sid) => bySession.get(sid) || null,
    findUnboundByCwd: (cwd) => byCwd.get(cwd) || null,
    applyHookEvent: (tabId, event, data, gen) => calls.push({
      tabId, event, data, gen,
    }),
  };
}

function post(port, body, headersOverride = {}) {
  return new Promise((resolve, reject) => {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    const headers = { 'content-type': 'application/json', ...headersOverride };
    const req = http.request(
      { host: '127.0.0.1', port, path: '/event', method: 'POST', headers },
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
  try {
    const port = await bridge.start();
    const res = await post(port, { event: 'Stop', data: { session_id: 'sess-1' } });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(sessions.calls[0], {
      tabId: 'tab-1', event: 'Stop', data: { session_id: 'sess-1' }, gen: null,
    });
  } finally {
    bridge.stop();
  }
});

test('чужая сессия того же cwd больше НЕ перехватывает непривязанную вкладку: 202, applyHookEvent не зовётся', async () => {
  const sessions = makeFakeSessions();
  // Раньше это был cwd-fallback (мост подхватывал непривязанную вкладку по
  // совпадению рабочей директории данных хука). Внешняя сессия того же
  // проекта тоже бьёт по этому cwd — мост больше не имеет права угадывать
  // и захватывать чужой вкладкой; findUnboundByCwd мостом больше не зовётся.
  sessions.byCwd.set('C:\\proj\\alpha', 'tab-2');
  const bridge = createHookBridge({ sessions, port: 0 });
  try {
    const port = await bridge.start();
    const res = await post(port, { event: 'SessionStart', data: { session_id: 'new-sess', cwd: 'C:\\proj\\alpha' } });
    assert.strictEqual(res.status, 202);
    assert.strictEqual(sessions.calls.length, 0);
  } finally {
    bridge.stop();
  }
});

test('tabId, известный sessions, маршрутизируется напрямую даже при неизвестном session_id', async () => {
  const sessions = makeFakeSessions();
  sessions.knownTabs.add('tab-3');
  const bridge = createHookBridge({ sessions, port: 0 });
  try {
    const port = await bridge.start();
    const res = await post(port, {
      event: 'PreToolUse',
      data: { session_id: 'unknown-sess', tool_name: 'Bash' },
      tabId: 'tab-3',
    });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(sessions.calls[0], {
      tabId: 'tab-3',
      event: 'PreToolUse',
      data: { session_id: 'unknown-sess', tool_name: 'Bash' },
      gen: null,
    });
  } finally {
    bridge.stop();
  }
});

test('tabId НЕ известен sessions и session_id неизвестен → 202', async () => {
  const sessions = makeFakeSessions();
  const bridge = createHookBridge({ sessions, port: 0 });
  try {
    const port = await bridge.start();
    const res = await post(port, { event: 'Stop', data: { session_id: 'ghost' }, tabId: 'ghost-tab' });
    assert.strictEqual(res.status, 202);
    assert.strictEqual(sessions.calls.length, 0);
  } finally {
    bridge.stop();
  }
});

test('незнакомая сессия без cwd-совпадения → 202, applyHookEvent не зовётся', async () => {
  const sessions = makeFakeSessions();
  const bridge = createHookBridge({ sessions, port: 0 });
  try {
    const port = await bridge.start();
    const res = await post(port, { event: 'Stop', data: { session_id: 'ghost', cwd: 'C:\\nowhere' } });
    assert.strictEqual(res.status, 202);
    assert.strictEqual(sessions.calls.length, 0);
  } finally {
    bridge.stop();
  }
});

test('битый JSON и не-POST → 400/404, сервер не падает', async () => {
  const sessions = makeFakeSessions();
  const bridge = createHookBridge({ sessions, port: 0 });
  try {
    const port = await bridge.start();
    const bad = await post(port, '{oops');
    assert.strictEqual(bad.status, 400);
    const res2 = await post(port, { event: 42 });
    assert.strictEqual(res2.status, 400);
    // сервер жив после мусора
    sessions.bySession.set('s', 't');
    const ok = await post(port, { event: 'Stop', data: { session_id: 's' } });
    assert.strictEqual(ok.status, 200);
  } finally {
    bridge.stop();
  }
});

test('portFile получает фактический порт', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const pf = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-test-')), 'bridge-port');
  const sessions = makeFakeSessions();
  const bridge = createHookBridge({ sessions, port: 0, portFile: pf });
  try {
    const port = await bridge.start();
    assert.strictEqual(Number(fs.readFileSync(pf, 'utf8').trim()), port);
  } finally {
    bridge.stop();
    assert.strictEqual(fs.existsSync(pf), false);
  }
});

// FIX 9 (ревью): второй инстанс, проигравший single-instance-lock, доходит до
// stop() своего (никогда реально не слушавшего publично) моста — не должен
// удалять port-файл живого первого инстанса, если тот уже переписал его своим
// портом.
test('FIX 9: stop() НЕ удаляет portFile, если в нём чужой (не наш) порт', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const pf = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-test-')), 'bridge-port');
  const sessions = makeFakeSessions();
  const bridge = createHookBridge({ sessions, port: 0, portFile: pf });
  await bridge.start();
  // Живой (другой) инстанс успел переписать файл своим портом ПОСЛЕ того,
  // как этот bridge стартовал и записал туда свой актуальный порт.
  fs.writeFileSync(pf, '99999', 'utf8');
  bridge.stop();
  assert.strictEqual(fs.existsSync(pf), true);
  assert.strictEqual(fs.readFileSync(pf, 'utf8').trim(), '99999');
});

test('FIX 9: stop() удаляет portFile, если содержимое всё ещё совпадает с нашим фактическим портом', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const pf = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-test-')), 'bridge-port');
  const sessions = makeFakeSessions();
  const bridge = createHookBridge({ sessions, port: 0, portFile: pf });
  await bridge.start();
  bridge.stop();
  assert.strictEqual(fs.existsSync(pf), false);
});

test('POST с text/plain content-type → 400, applyHookEvent не зовётся', async () => {
  const sessions = makeFakeSessions();
  sessions.bySession.set('sess-1', 'tab-1');
  const bridge = createHookBridge({ sessions, port: 0 });
  try {
    const port = await bridge.start();
    const res = await post(port, { event: 'Stop', data: { session_id: 'sess-1' } }, { 'content-type': 'text/plain' });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(sessions.calls.length, 0);
  } finally {
    bridge.stop();
  }
});

// ---------- доп. находка ревью Task 1 фазы 7 (задача 5): гард поколения ----------
// Мост сам НЕ решает, актуально ли поколение (это знает только sessions.js —
// у него единственного есть текущий tab.gen) — его дело только вытащить gen
// из payload и передать дальше как есть. Эти тесты проверяют именно
// передачу/нормализацию, а не сам гард (тот покрыт test/sessions.test.js).

test('gen: целое число в payload передаётся в applyHookEvent как есть', async () => {
  const sessions = makeFakeSessions();
  sessions.bySession.set('sess-1', 'tab-1');
  const bridge = createHookBridge({ sessions, port: 0 });
  try {
    const port = await bridge.start();
    const res = await post(port, { event: 'Stop', data: { session_id: 'sess-1' }, gen: 3 });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(sessions.calls[0], {
      tabId: 'tab-1', event: 'Stop', data: { session_id: 'sess-1' }, gen: 3,
    });
  } finally {
    bridge.stop();
  }
});

// Minor 4 (ревью раунд 1): тест "gen: поле отсутствует → null" отсюда убран —
// он слал ТОТ ЖЕ POST-body и проверял ТО ЖЕ самое, что уже покрыто тестом
// «маршрутизация по session_id доставляет applyHookEvent» выше (после
// обновления его deepStrictEqual на gen:null) — полный дубль без собственного
// режима падения. Случай «поле отсутствует» остаётся покрыт ИМ.

test('gen: мусорное значение (строка, дробное) в payload нормализуется в null', async () => {
  const sessions = makeFakeSessions();
  sessions.bySession.set('sess-1', 'tab-1');
  const bridge = createHookBridge({ sessions, port: 0 });
  try {
    const port = await bridge.start();
    const res1 = await post(port, { event: 'Stop', data: { session_id: 'sess-1' }, gen: 'три' });
    assert.strictEqual(sessions.calls[0].gen, null);
    const res2 = await post(port, { event: 'Stop', data: { session_id: 'sess-1' }, gen: 1.5 });
    assert.strictEqual(sessions.calls[1].gen, null);
    assert.strictEqual(res1.status, 200);
    assert.strictEqual(res2.status, 200);
  } finally {
    bridge.stop();
  }
});
