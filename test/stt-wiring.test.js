'use strict';
// Minor-1 (ревью Task 2 фазы 9): HTTP-обёртки sttHttpGet/sttHttpPost из
// ipc.js — предмет ДОСЛОВНОЙ сверки с контрактом ядра (шапка stt.js):
// резолв на ЛЮБОЙ завершённый HTTP-ответ, reject ТОЛЬКО на сетевой
// сбой/таймаут. Тестируются против ЛОКАЛЬНОГО http-сервера (loopback,
// in-process, не «реальная сеть» и не спавн процессов).

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { sttHttpGet, sttHttpPost } = require('../src/main/ipc');

// Однострочный сервер на порту, назначенном ОС (:0), закрываемый явно.
function startServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

test('sttHttpGet: 404 от сервера → РЕЗОЛВ {status:404} (критерий готовности «порт слушает», не 200)', async () => {
  const { srv, port } = await startServer((req, res) => {
    res.statusCode = 404;
    res.end('not found');
  });
  try {
    const out = await sttHttpGet(port, '/', 1000);
    assert.strictEqual(out.status, 404);
  } finally {
    srv.close();
  }
});

test('sttHttpGet: закрытый порт (ECONNREFUSED) → reject', async () => {
  // Порт берём у только что закрытого сервера — гарантированно ничей.
  const { srv, port } = await startServer(() => {});
  await new Promise((r) => srv.close(r));
  await assert.rejects(sttHttpGet(port, '/', 1000));
});

test('sttHttpGet: молчащий сервер → reject по таймауту', async () => {
  const { srv, port } = await startServer(() => { /* никогда не отвечаем */ });
  try {
    await assert.rejects(sttHttpGet(port, '/', 200), /таймаут/);
  } finally {
    srv.close();
  }
});

test('sttHttpPost: 500 с телом → РЕЗОЛВ {status:500, body:Buffer} (код разбирает ядро)', async () => {
  const seen = {};
  const { srv, port } = await startServer((req, res) => {
    seen.method = req.method;
    seen.cl = req.headers['content-length'];
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.body = Buffer.concat(chunks);
      res.statusCode = 500;
      res.end('{"error":"внутренняя"}');
    });
  });
  try {
    const payload = Buffer.from('abcde', 'utf8');
    const out = await sttHttpPost(
      port, '/inference',
      { 'Content-Type': 'application/octet-stream', 'Content-Length': String(payload.length) },
      payload, 1000,
    );
    assert.strictEqual(out.status, 500);
    assert.ok(Buffer.isBuffer(out.body));
    assert.strictEqual(out.body.toString('utf8'), '{"error":"внутренняя"}');
    assert.strictEqual(seen.method, 'POST');
    assert.strictEqual(seen.cl, '5', 'Content-Length из заголовков дошёл до сервера');
    assert.strictEqual(seen.body.toString('utf8'), 'abcde', 'тело дошло байт-в-байт');
  } finally {
    srv.close();
  }
});
