'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { createStt } = require('../src/main/stt');

// --- фейковые зависимости (все эффекты фейковые, дёргаются руками — node --test без реального времени) ---

function makeClock(start = 0) {
  let t = start;
  return { now: () => t, set(v) { t = v; }, advance(d) { t += d; } };
}

// setTimer/clearTimer — тот же фейк-паттерн, что в test/night-watch.test.js:
// setTimer кладёт колбэк+задержку в реестр, fire(id) вызывает его руками.
function fakeTimers() {
  let seq = 0;
  const live = new Map();
  const log = [];
  return {
    setTimer(fn, ms) {
      const id = ++seq;
      live.set(id, { fn, ms });
      log.push({ id, ms });
      return id;
    },
    clearTimer(id) {
      live.delete(id);
    },
    fire(id) {
      const entry = live.get(id);
      if (!entry) throw new Error(`таймер #${id} не запланирован или уже снят`);
      live.delete(id);
      return entry.fn();
    },
    lastId() {
      return log.length ? log[log.length - 1].id : null;
    },
    liveCount() {
      return live.size;
    },
  };
}

function fakeFs(existing = []) {
  const set = new Set(existing);
  return { existsSync: (p) => set.has(p) };
}

// Фейковый child: {pid, on, removeAllListeners, kill} + журнал вызовов (для
// теста «killProc снимает exit-хендлер до kill») и emit() для симуляции
// реального выхода процесса.
function fakeChild(pid) {
  const listeners = {};
  const calls = [];
  const child = {
    pid,
    calls,
    on(event, cb) {
      (listeners[event] = listeners[event] || []).push(cb);
      calls.push({ op: 'on', event });
      return child;
    },
    removeAllListeners(event) {
      delete listeners[event];
      calls.push({ op: 'removeAllListeners', event });
      return child;
    },
    kill() {
      calls.push({ op: 'kill' });
    },
    emit(event) {
      (listeners[event] || []).slice().forEach((cb) => cb());
    },
  };
  return child;
}

// spawnProc — очередь фейковых children по вызовам; записывает {exe, args, child}
// (child — ЧТО ИМЕННО было возвращено на этот конкретный вызов, включая
// вызовы killProc'а на 'taskkill' — так тесты могут точно отличить «этого
// ребёнка зарегистрировали» от «этого — нет», не полагаясь на индексы).
function fakeSpawn(children) {
  const calls = [];
  let i = 0;
  const fn = (exe, args) => {
    const child = children[i] || fakeChild(9000 + i);
    i += 1;
    calls.push({ exe, args, child });
    return child;
  };
  fn.calls = calls;
  return fn;
}

// Все spawnProc-вызовы КРОМЕ служебного taskkill (killProc его не регистрирует —
// см. тесты про registerProcess). Используется вместо хрупких абсолютных
// индексов/счётчиков, т.к. killProc сам по себе тоже идёт через spawnProc.
function serverSpawns(spawnProc) {
  return spawnProc.calls.filter((c) => c.exe !== 'taskkill');
}

function fakeRegisterProcess() {
  const calls = [];
  const fn = (child) => calls.push(child);
  fn.calls = calls;
  return fn;
}

function fakeLog() {
  const lines = [];
  const fn = (msg) => lines.push(msg);
  fn.lines = lines;
  return fn;
}

// httpGet — очередь функций (port, path, timeoutMs) => Promise; вызывающий
// код сам решает, resolve или reject на каждый конкретный запрос.
function queueHttp(responders) {
  const calls = [];
  let i = 0;
  const fn = (...args) => {
    calls.push(args);
    const r = responders[Math.min(i, responders.length - 1)];
    i += 1;
    return typeof r === 'function' ? r(...args) : r;
  };
  fn.calls = calls;
  return fn;
}

function ROOT1() { return 'C:\\root1'; }
function ROOT2() { return 'C:\\root2'; }

function serverExePath(root, dir) {
  return path.join(root, 'vendor', dir, 'whisper-server.exe');
}
function modelPathFor(root, model) {
  return path.join(root, 'models', 'whisper', `ggml-${model}.bin`);
}

const MODEL = 'large-v3-turbo-q5_0';

function baseConfig(overrides = {}) {
  return {
    stackRoots: [ROOT1(), ROOT2()],
    model: MODEL,
    language: 'ru',
    threads: 6,
    serverPort: 48753,
    ...overrides,
  };
}

// Собирает createStt() с разумными дефолтами; тест переопределяет только то, что ему нужно.
function setup(overrides = {}) {
  const clock = overrides.clock || makeClock(0);
  const timers = overrides.timers || fakeTimers();
  const fs = overrides.fs || fakeFs([]);
  const spawnProc = overrides.spawnProc || fakeSpawn([]);
  const registerProcess = overrides.registerProcess || fakeRegisterProcess();
  const log = overrides.log || fakeLog();
  const httpGet = overrides.httpGet || queueHttp([() => Promise.resolve({ status: 200 })]);
  const httpPost = overrides.httpPost || (() => Promise.resolve({ status: 200, body: Buffer.from('{"text":""}', 'utf8') }));
  const config = overrides.config || baseConfig();

  const stt = createStt({
    spawnProc,
    httpGet,
    httpPost,
    fs,
    now: clock.now,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    registerProcess,
    config,
    log,
  });

  return {
    stt, clock, timers, fs, spawnProc, registerProcess, log, httpGet, httpPost, config,
  };
}

// Продвигает ready-поллинг: сколько раз ни попроси, дёргает последний
// запланированный таймер поллинга (setTimer из waitReady), пока он есть.
function firePoll(timers) {
  const id = timers.lastId();
  return timers.fire(id);
}

async function flush(times = 5) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

// Ready-поллинг реагирует на httpGet АСИНХРОННО (через .then/.catch —
// микрозадачи), поэтому просто "продвинуть часы и дёрнуть таймер" в тесном
// синхронном цикле НЕ работает: на момент проверки timers.liveCount() ещё
// нет ни одного запланированного таймера (микрозадача httpGet ещё не
// отработала), проверка ложно уходит в else-ветку, а таймер, который
// планируется чуть позже (уже после выхода из цикла), никто больше не
// дёргает — промис зависает навсегда. driveUntilSettled сначала ДОЖИДАЕТСЯ
// (flush) микрозадач и только потом решает, дёргать таймер или нет; работает
// для ЛЮБОГО количества бекендов/итераций поллинга без ручного подсчёта
// микрозадач в каждом тесте.
async function driveUntilSettled(promise, timers, clock, { stepMs = 300, maxSteps = 200 } = {}) {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (let i = 0; i < maxSteps; i += 1) {
    await flush(5);
    if (settled) return;
    if (timers.liveCount() > 0) {
      clock.advance(stepMs);
      firePoll(timers);
    }
  }
  throw new Error('driveUntilSettled: превышен лимит шагов, промис так и не осел');
}

// ============================================================= выбор корня =====

test('выбор корня: первый валидный root из двух → spawnProc идёт в root1', async () => {
  const fs = fakeFs([
    serverExePath(ROOT1(), 'whisper'),
    modelPathFor(ROOT1(), MODEL),
  ]);
  const httpGet = queueHttp([() => Promise.resolve({ status: 200 })]);
  const { stt, spawnProc } = setup({ fs, httpGet });

  await stt.ensureServer();

  assert.strictEqual(spawnProc.calls.length, 1);
  assert.strictEqual(spawnProc.calls[0].exe, serverExePath(ROOT1(), 'whisper'));
});

test('выбор корня: root1 без модели, root2 валиден → spawnProc идёт в root2', async () => {
  const fs = fakeFs([
    serverExePath(ROOT1(), 'whisper'), // бекенд есть, модели НЕТ
    serverExePath(ROOT2(), 'whisper'),
    modelPathFor(ROOT2(), MODEL),
  ]);
  const httpGet = queueHttp([() => Promise.resolve({ status: 200 })]);
  const { stt, spawnProc } = setup({ fs, httpGet });

  await stt.ensureServer();

  assert.strictEqual(spawnProc.calls[0].exe, serverExePath(ROOT2(), 'whisper'));
});

test('выбор корня: ни одного валидного root → ensureServer() реджектит, status().available=false, spawnProc не вызван', async () => {
  const fs = fakeFs([serverExePath(ROOT1(), 'whisper')]); // модели нигде нет
  const { stt, spawnProc } = setup({ fs });

  await assert.rejects(() => stt.ensureServer());
  assert.strictEqual(spawnProc.calls.length, 0);
  assert.deepStrictEqual(stt.status(), { available: false, backend: null, warm: false });
});

// ==================================================== перебор бекендов/аргументы =====

function fsWithBothBackends(root = ROOT1()) {
  return fakeFs([
    serverExePath(root, 'whisper-cuda'),
    serverExePath(root, 'whisper'),
    modelPathFor(root, MODEL),
  ]);
}

test('перебор бекендов: CUDA поднялся первым же пингом → status().backend=whisper-cuda, ОДИН spawnProc', async () => {
  const fs = fsWithBothBackends();
  const httpGet = queueHttp([() => Promise.resolve({ status: 200 })]);
  const { stt, spawnProc } = setup({ fs, httpGet, config: baseConfig({ stackRoots: [ROOT1()] }) });

  await stt.ensureServer();

  assert.strictEqual(spawnProc.calls.length, 1);
  assert.strictEqual(spawnProc.calls[0].exe, serverExePath(ROOT1(), 'whisper-cuda'));
  assert.deepStrictEqual(stt.status(), { available: true, backend: 'whisper-cuda', warm: true });
});

test('перебор бекендов: CUDA-аргументы содержат --no-flash-attn/--no-fallback', async () => {
  const fs = fsWithBothBackends();
  const httpGet = queueHttp([() => Promise.resolve({ status: 200 })]);
  const { stt, spawnProc } = setup({ fs, httpGet, config: baseConfig({ stackRoots: [ROOT1()] }) });

  await stt.ensureServer();

  const args = spawnProc.calls[0].args;
  assert.ok(args.includes('--no-flash-attn'), 'ожидался --no-flash-attn у CUDA-бекенда');
  assert.ok(args.includes('--no-fallback'), 'ожидался --no-fallback у CUDA-бекенда');
});

test('перебор бекендов: базовые аргументы сервера (-m/-t/-l/--host/--port/-nt)', async () => {
  const root = ROOT1();
  const fs = fakeFs([serverExePath(root, 'whisper'), modelPathFor(root, MODEL)]);
  const httpGet = queueHttp([() => Promise.resolve({ status: 200 })]);
  const { stt, spawnProc } = setup({
    fs, httpGet, config: baseConfig({ stackRoots: [root], threads: 8, language: 'ru', serverPort: 48753 }),
  });

  await stt.ensureServer();

  const args = spawnProc.calls[0].args;
  assert.deepStrictEqual(args, [
    '-m', modelPathFor(root, MODEL),
    '-t', '8',
    '-l', 'ru',
    '--host', '127.0.0.1',
    '--port', '48753',
    '-nt',
  ]);
  assert.ok(!args.includes('--no-flash-attn'), 'CPU-бекенд не должен получать CUDA-флаги');
});

test('перебор бекендов: CUDA не поднялся (таймаут) → фоллбэк на CPU, CPU БЕЗ CUDA-флагов, итог warm', async () => {
  const root = ROOT1();
  const fs = fsWithBothBackends(root);
  const timers = fakeTimers();
  const clock = makeClock(0);
  const spawnProc = fakeSpawn([]);
  // CUDA (первый server-спавн) — httpGet всегда реджектится, никогда не готов.
  // CPU (второй server-спавн, после фоллбэка) — готов сразу же первым пингом.
  // ВАЖНО: считаем именно СЕРВЕРНЫЕ спавны — killProc() между бекендами сам
  // делает ещё один spawnProc('taskkill', ...), который в счёт не идёт.
  const httpGet = () => (serverSpawns(spawnProc).length < 2
    ? Promise.reject(new Error('econnrefused'))
    : Promise.resolve({ status: 200 }));
  const { stt } = setup({
    fs, httpGet, timers, clock, spawnProc, config: baseConfig({ stackRoots: [root] }),
  });

  const p = stt.ensureServer();
  await driveUntilSettled(p, timers, clock);
  await p;

  const servers = serverSpawns(spawnProc);
  assert.strictEqual(servers.length, 2, 'ожидалось два СЕРВЕРНЫХ spawnProc: CUDA, затем CPU');
  assert.strictEqual(servers[0].exe, serverExePath(root, 'whisper-cuda'));
  assert.strictEqual(servers[1].exe, serverExePath(root, 'whisper'));
  assert.ok(!servers[1].args.includes('--no-flash-attn'));
  assert.ok(spawnProc.calls.some((c) => c.exe === 'taskkill'), 'killProc после провала CUDA должен был вызвать контрольный taskkill');
  assert.deepStrictEqual(stt.status(), { available: true, backend: 'whisper', warm: true });
});

test('перебор бекендов: оба не поднялись → ensureServer() реджектит с последней ошибкой, ДВА серверных spawnProc', async () => {
  const root = ROOT1();
  const fs = fsWithBothBackends(root);
  const httpGet = () => Promise.reject(new Error('econnrefused'));
  const timers = fakeTimers();
  const clock = makeClock(0);
  const { stt, spawnProc } = setup({
    fs, httpGet, timers, clock, config: baseConfig({ stackRoots: [root] }),
  });

  const p = stt.ensureServer();
  await driveUntilSettled(p, timers, clock);
  await assert.rejects(p, /таймаут готовности/);
  assert.strictEqual(serverSpawns(spawnProc).length, 2);
});

// ============================================================ ready-поллинг =====

test('ready-поллинг: не готов на первом пинге, готов на втором → ensureServer() резолвится после одного fire() таймера', async () => {
  const root = ROOT1();
  const fs = fakeFs([serverExePath(root, 'whisper'), modelPathFor(root, MODEL)]);
  const httpGet = queueHttp([
    () => Promise.reject(new Error('econnrefused')),
    () => Promise.resolve({ status: 200 }),
  ]);
  const timers = fakeTimers();
  const { stt } = setup({ fs, httpGet, timers, config: baseConfig({ stackRoots: [root] }) });

  const p = stt.ensureServer();
  await flush(5); // даём первому httpGet отработать (reject) и запланировать poll-таймер
  assert.strictEqual(timers.liveCount(), 1, 'должен быть запланирован ровно один poll-таймер');
  firePoll(timers);
  await p;

  assert.strictEqual(httpGet.calls.length, 2);
  assert.deepStrictEqual(stt.status(), { available: true, backend: 'whisper', warm: true });
});

test('ready-поллинг: дедлайн истёк на единственном бекенде → ensureServer() реджектит с сообщением про таймаут', async () => {
  const root = ROOT1();
  const fs = fakeFs([serverExePath(root, 'whisper'), modelPathFor(root, MODEL)]);
  const httpGet = () => Promise.reject(new Error('econnrefused'));
  const timers = fakeTimers();
  const clock = makeClock(0);
  const { stt } = setup({
    fs, httpGet, timers, clock, config: baseConfig({ stackRoots: [root] }),
  });

  const p = stt.ensureServer();
  await driveUntilSettled(p, timers, clock);
  await assert.rejects(p, /таймаут готовности/);
});

test('параллельные ensureServer(): два синхронных вызова → ОДИН spawnProc, оба промиса резолвятся', async () => {
  const root = ROOT1();
  const fs = fakeFs([serverExePath(root, 'whisper'), modelPathFor(root, MODEL)]);
  const httpGet = queueHttp([() => Promise.resolve({ status: 200 })]);
  const { stt, spawnProc } = setup({ fs, httpGet, config: baseConfig({ stackRoots: [root] }) });

  const p1 = stt.ensureServer();
  const p2 = stt.ensureServer();
  assert.strictEqual(spawnProc.calls.length, 1, 'второй синхронный вызов не должен был запустить свой spawnProc');
  await Promise.all([p1, p2]);
  assert.strictEqual(spawnProc.calls.length, 1);
});

// ================================================================= multipart =====

test('multipart: boundary совпадает в заголовке и в теле; части file/response_format присутствуют; WAV передан байт-в-байт', async () => {
  const root = ROOT1();
  const fs = fakeFs([serverExePath(root, 'whisper'), modelPathFor(root, MODEL)]);
  const httpGet = queueHttp([() => Promise.resolve({ status: 200 })]);
  let captured = null;
  const httpPost = (port, p, headers, body, timeoutMs) => {
    captured = {
      port, path: p, headers, body, timeoutMs,
    };
    return Promise.resolve({ status: 200, body: Buffer.from('{"text":"ok"}', 'utf8') });
  };
  const { stt } = setup({
    fs, httpGet, httpPost, config: baseConfig({ stackRoots: [root] }),
  });

  const wav = Buffer.from([0xd0, 0x9f, 0x00, 0xff, 0x52, 0x49, 0x46, 0x46, 0x01, 0x02, 0x03]);
  const text = await stt.transcribeWav(wav);
  assert.strictEqual(text, 'ok');

  assert.strictEqual(captured.path, '/inference');
  assert.strictEqual(captured.timeoutMs, 60000);

  const boundaryMatch = captured.headers['Content-Type'].match(/boundary=(\S+)/);
  assert.ok(boundaryMatch, 'Content-Type должен содержать boundary');
  const boundary = boundaryMatch[1];

  const bodyText = captured.body.toString('latin1'); // latin1 — байт-в-байт, без потери небезопасных байт при поиске маркеров
  assert.ok(bodyText.includes(`--${boundary}`), 'тело должно содержать граничную строку');
  assert.ok(bodyText.includes('name="file"; filename="a.wav"'), 'должна быть часть file');
  assert.ok(bodyText.includes('Content-Type: audio/wav'));
  assert.ok(bodyText.includes('name="response_format"'), 'должна быть часть response_format');
  assert.ok(bodyText.includes('\r\n\r\njson'), 'response_format должен нести значение json');

  // WAV-буфер должен входить в тело БЕЗ ИЗМЕНЕНИЙ (byte-for-byte) — ищем его как подряд идущие байты.
  const idx = captured.body.indexOf(wav);
  assert.ok(idx >= 0, 'исходный WAV-буфер должен присутствовать в теле целиком и без изменений');
});

test('multipart: кириллица в ответе (UTF-8 тело JSON) декодируется корректно, без искажений и с trim', async () => {
  const root = ROOT1();
  const fs = fakeFs([serverExePath(root, 'whisper'), modelPathFor(root, MODEL)]);
  const httpGet = queueHttp([() => Promise.resolve({ status: 200 })]);
  const httpPost = () => Promise.resolve({
    status: 200,
    body: Buffer.from('{"text":"  привет, как дела?\\n"}', 'utf8'),
  });
  const { stt } = setup({ fs, httpGet, httpPost, config: baseConfig({ stackRoots: [root] }) });

  const text = await stt.transcribeWav(Buffer.from('wav-data'));
  assert.strictEqual(text, 'привет, как дела?');
});

// ============================================================ transcribeWav =====

test('transcribeWav: happy-path → ensureServer + POST /inference → текст', async () => {
  const root = ROOT1();
  const fs = fakeFs([serverExePath(root, 'whisper'), modelPathFor(root, MODEL)]);
  const httpGet = queueHttp([() => Promise.resolve({ status: 200 })]);
  const httpPost = () => Promise.resolve({ status: 200, body: Buffer.from('{"text":"готово"}', 'utf8') });
  const { stt, spawnProc } = setup({ fs, httpGet, httpPost, config: baseConfig({ stackRoots: [root] }) });

  const text = await stt.transcribeWav(Buffer.from('abc'));
  assert.strictEqual(text, 'готово');
  assert.strictEqual(spawnProc.calls.length, 1);
});

test('transcribeWav: не-200 на первом POST → один ретрай (killProc + НОВЫЙ spawnProc + ensureServer) → успех', async () => {
  const root = ROOT1();
  const fs = fakeFs([serverExePath(root, 'whisper'), modelPathFor(root, MODEL)]);
  const httpGet = () => Promise.resolve({ status: 200 });
  let postCalls = 0;
  const httpPost = () => {
    postCalls += 1;
    if (postCalls === 1) return Promise.resolve({ status: 500, body: Buffer.from('boom', 'utf8') });
    return Promise.resolve({ status: 200, body: Buffer.from('{"text":"после ретрая"}', 'utf8') });
  };
  const { stt, spawnProc } = setup({ fs, httpGet, httpPost, config: baseConfig({ stackRoots: [root] }) });

  const text = await stt.transcribeWav(Buffer.from('abc'));
  assert.strictEqual(text, 'после ретрая');
  assert.strictEqual(postCalls, 2);
  assert.strictEqual(serverSpawns(spawnProc).length, 2, 'ретрай должен был заспавнить НОВЫЙ процесс сервера');
  assert.ok(spawnProc.calls.some((c) => c.exe === 'taskkill'), 'killProc перед ретраем должен был вызвать taskkill');
});

test('transcribeWav: двойной провал POST → reject (без CLI-фоллбэка)', async () => {
  const root = ROOT1();
  const fs = fakeFs([serverExePath(root, 'whisper'), modelPathFor(root, MODEL)]);
  const httpGet = () => Promise.resolve({ status: 200 });
  const httpPost = () => Promise.resolve({ status: 500, body: Buffer.from('boom', 'utf8') });
  const { stt, spawnProc } = setup({ fs, httpGet, httpPost, config: baseConfig({ stackRoots: [root] }) });

  await assert.rejects(() => stt.transcribeWav(Buffer.from('abc')), /whisper-server HTTP 500/);
  assert.strictEqual(serverSpawns(spawnProc).length, 2, 'ожидались попытка + один ретрай = два серверных spawnProc');
});

test('exit сервера → следующий вызов transcribeWav спавнит заново', async () => {
  const root = ROOT1();
  const fs = fakeFs([serverExePath(root, 'whisper'), modelPathFor(root, MODEL)]);
  const httpGet = () => Promise.resolve({ status: 200 });
  const httpPost = () => Promise.resolve({ status: 200, body: Buffer.from('{"text":"ok"}', 'utf8') });
  const children = [fakeChild(111), fakeChild(222)];
  const spawnProc = fakeSpawn(children);
  const { stt } = setup({
    fs, httpGet, httpPost, spawnProc, config: baseConfig({ stackRoots: [root] }),
  });

  await stt.transcribeWav(Buffer.from('a'));
  assert.strictEqual(spawnProc.calls.length, 1);
  assert.deepStrictEqual(stt.status().warm, true);

  children[0].emit('exit'); // сервер упал сам по себе
  assert.deepStrictEqual(stt.status(), { available: true, backend: null, warm: false });

  await stt.transcribeWav(Buffer.from('b'));
  assert.strictEqual(spawnProc.calls.length, 2, 'после exit следующий вызов должен был заспавнить заново');
});

// ===================================================================== killProc order =====

test('killProc: снимает exit-хендлер ДО kill() — фейковый child фиксирует порядок (через ретрай transcribeWav)', async () => {
  const root = ROOT1();
  const fs = fakeFs([serverExePath(root, 'whisper'), modelPathFor(root, MODEL)]);
  const httpGet = () => Promise.resolve({ status: 200 });
  let postCalls = 0;
  const httpPost = () => {
    postCalls += 1;
    if (postCalls === 1) return Promise.resolve({ status: 500, body: Buffer.from('x', 'utf8') });
    return Promise.resolve({ status: 200, body: Buffer.from('{"text":"ok"}', 'utf8') });
  };
  const first = fakeChild(111);
  const second = fakeChild(222);
  const spawnProc = fakeSpawn([first, second]);
  const { stt } = setup({
    fs, httpGet, httpPost, spawnProc, config: baseConfig({ stackRoots: [root] }),
  });

  await stt.transcribeWav(Buffer.from('a')); // вызывает ретрай → killProc() над first

  const ops = first.calls.map((c) => c.op).filter((op) => op === 'removeAllListeners' || op === 'kill');
  const removeIdx = ops.indexOf('removeAllListeners');
  const killIdx = ops.indexOf('kill');
  assert.ok(removeIdx >= 0 && killIdx >= 0, 'ожидались оба вызова у первого child');
  assert.ok(removeIdx < killIdx, `removeAllListeners должен быть ДО kill(), порядок: ${JSON.stringify(ops)}`);
});

test('killProc: контрольный taskkill идёт через spawnProc, но НЕ регистрируется через registerProcess', async () => {
  const root = ROOT1();
  const fs = fakeFs([serverExePath(root, 'whisper'), modelPathFor(root, MODEL)]);
  const httpGet = () => Promise.resolve({ status: 200 });
  let postCalls = 0;
  const httpPost = () => {
    postCalls += 1;
    if (postCalls === 1) return Promise.resolve({ status: 500, body: Buffer.from('x', 'utf8') });
    return Promise.resolve({ status: 200, body: Buffer.from('{"text":"ok"}', 'utf8') });
  };
  const spawnProc = fakeSpawn([]);
  const registerProcess = fakeRegisterProcess();
  const { stt } = setup({
    fs, httpGet, httpPost, spawnProc, registerProcess, config: baseConfig({ stackRoots: [root] }),
  });

  await stt.transcribeWav(Buffer.from('a'));

  const servers = serverSpawns(spawnProc);
  const taskkillCalls = spawnProc.calls.filter((c) => c.exe === 'taskkill');
  assert.strictEqual(servers.length, 2, 'первый спавн сервера + ретрай');
  assert.strictEqual(taskkillCalls.length, 1);
  assert.deepStrictEqual(taskkillCalls[0].args, ['/PID', String(servers[0].child.pid), '/T', '/F']);

  // registerProcess должен был получить РОВНО двух серверных детей (по одному
  // на server-спавн), и НИ РАЗУ — результат spawnProc('taskkill', ...).
  assert.strictEqual(registerProcess.calls.length, 2);
  assert.deepStrictEqual(registerProcess.calls, [servers[0].child, servers[1].child]);
  assert.ok(!registerProcess.calls.includes(taskkillCalls[0].child), 'taskkill-процесс не должен регистрироваться');
});

test('registerProcess: зовётся для КАЖДОГО серверного spawnProc, включая ретрай при провале готовности бекенда', async () => {
  const root = ROOT1();
  const fs = fsWithBothBackends(root);
  const timers = fakeTimers();
  const clock = makeClock(0);
  const registerProcess = fakeRegisterProcess();
  const spawnProc = fakeSpawn([]);
  const httpGet = () => (serverSpawns(spawnProc).length < 2 // CUDA не готов, CPU готов сразу
    ? Promise.reject(new Error('econnrefused'))
    : Promise.resolve({ status: 200 }));
  const { stt } = setup({
    fs, httpGet, timers, clock, spawnProc, registerProcess, config: baseConfig({ stackRoots: [root] }),
  });

  const p = stt.ensureServer();
  await driveUntilSettled(p, timers, clock);
  await p;

  const servers = serverSpawns(spawnProc);
  assert.strictEqual(servers.length, 2);
  assert.strictEqual(registerProcess.calls.length, 2, 'registerProcess должен был вызваться для обоих бекендов, и НИ РАЗУ для taskkill');
  assert.deepStrictEqual(registerProcess.calls, [servers[0].child, servers[1].child]);
});

// ========================================================================= dispose =====

test('dispose: идемпотентен (двойной вызов не бросает), снимает pending poll-таймер', async () => {
  const root = ROOT1();
  const fs = fakeFs([serverExePath(root, 'whisper'), modelPathFor(root, MODEL)]);
  const httpGet = () => new Promise(() => {}); // никогда не резолвится — сервер вечно "не готов"
  const timers = fakeTimers();
  const { stt } = setup({ fs, httpGet, timers, config: baseConfig({ stackRoots: [root] }) });

  stt.ensureServer(); // запускает poll-цикл, не ждём
  await Promise.resolve();
  await Promise.resolve();

  assert.doesNotThrow(() => stt.dispose());
  assert.doesNotThrow(() => stt.dispose());
  assert.strictEqual(timers.liveCount(), 0, 'poll-таймер должен быть снят dispose()');
});

test('dispose: убивает текущий процесс (kill вызван), status() после dispose — не warm', async () => {
  const root = ROOT1();
  const fs = fakeFs([serverExePath(root, 'whisper'), modelPathFor(root, MODEL)]);
  const httpGet = queueHttp([() => Promise.resolve({ status: 200 })]);
  const child = fakeChild(111);
  const spawnProc = fakeSpawn([child]);
  const { stt } = setup({ fs, httpGet, spawnProc, config: baseConfig({ stackRoots: [root] }) });

  await stt.ensureServer();
  stt.dispose();

  assert.ok(child.calls.some((c) => c.op === 'kill'));
  assert.deepStrictEqual(stt.status(), { available: true, backend: null, warm: false });
});

// ========================================================================= status =====

test('status(): available=true до первого ensureServer(), warm=false и backend=null пока сервер не поднят', () => {
  const root = ROOT1();
  const fs = fakeFs([serverExePath(root, 'whisper'), modelPathFor(root, MODEL)]);
  const { stt } = setup({ fs, config: baseConfig({ stackRoots: [root] }) });

  assert.deepStrictEqual(stt.status(), { available: true, backend: null, warm: false });
});
