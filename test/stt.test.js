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
    lastMs() {
      return log.length ? log[log.length - 1].ms : null;
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

// Фейковый child: {pid, on, removeListener, removeAllListeners, kill} +
// журнал вызовов (для теста «killProc снимает exit-хендлер до kill» и B3 —
// «killProc снимает ИМЕННО свой хендлер, не все») и emit() для симуляции
// реального выхода процесса. removeListener поддерживает НЕСКОЛЬКО
// слушателей одного события — снимает только переданную функцию, остальные
// (например, «чужой» once от registerProcess) остаются жить.
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
    removeListener(event, cb) {
      if (listeners[event]) listeners[event] = listeners[event].filter((f) => f !== cb);
      calls.push({ op: 'removeListener', event });
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
  const fs = fakeFs([serverExePath(ROOT1(), 'whisper')]); // бекенд в root1 есть, модели нигде нет
  const { stt, spawnProc } = setup({ fs }); // baseConfig(): stackRoots = [ROOT1(), ROOT2()]

  let rejection = null;
  await stt.ensureServer().catch((e) => { rejection = e; });
  assert.ok(rejection);
  assert.strictEqual(spawnProc.calls.length, 0);
  assert.deepStrictEqual(stt.status(), { available: false, backend: null, warm: false });

  // Minor-1 (ревью раунд 1): сообщение обязано называть ОБА проверенных
  // корня и то, чего именно в каждом не хватило — не просто «не найдено».
  assert.ok(rejection.message.includes(ROOT1()), 'сообщение должно упоминать root1');
  assert.ok(rejection.message.includes(ROOT2()), 'сообщение должно упоминать root2');
  assert.match(rejection.message, /нет модели/, 'root1: бекенд есть, модели нет — должно быть явно сказано');
  assert.match(rejection.message, /нет ни одного.*whisper-server\.exe/, 'root2: бекенда нет вовсе — должно быть явно сказано');
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
  // Хвост B2 сдвинул спавн из синхронной фазы в микрозадачу (await undefined
  // первым делом IIFE) — важное свойство теста не «КОГДА спавн», а «ОДИН
  // спавн на обоих ожидающих»: оба вызова делят один перебор.
  assert.strictEqual(p1, p2, 'оба синхронных вызова обязаны делить один in-flight промис');
  await Promise.all([p1, p2]);
  assert.strictEqual(spawnProc.calls.length, 1, 'один спавн на оба вызова');
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

test('transcribeWav: невалидный JSON от /inference → reject с понятным сообщением, тоже вызывает ретрай', async () => {
  const root = ROOT1();
  const fs = fakeFs([serverExePath(root, 'whisper'), modelPathFor(root, MODEL)]);
  const httpGet = () => Promise.resolve({ status: 200 });
  const httpPost = () => Promise.resolve({ status: 200, body: Buffer.from('не-json{', 'utf8') });
  const { stt, spawnProc } = setup({ fs, httpGet, httpPost, config: baseConfig({ stackRoots: [root] }) });

  await assert.rejects(() => stt.transcribeWav(Buffer.from('a')), /невалидный JSON/);
  assert.strictEqual(serverSpawns(spawnProc).length, 2, 'невалидный JSON — тоже сбой, тоже один ретрай, как любой другой');
});

test('transcribeWav: стек не найден нигде → reject сразу, ни одного spawnProc', async () => {
  const fs = fakeFs([]); // ничего нет ни в одном stackRoot
  const { stt, spawnProc } = setup({ fs });

  await assert.rejects(() => stt.transcribeWav(Buffer.from('a')), /Голосовой стек не найден/);
  assert.strictEqual(spawnProc.calls.length, 0);
});

// ============================================================ B1: сериализация =====
// Ревью раунд 1, Critical: без сериализации конкурентный вызов №2 бьёт по
// серверу, который ретрай вызова №1 как раз убивает — теряет диктовку и
// плодит лишние спавны (каждый грузит модель ~1ГБ). Портированная из
// Companion цепочка промисов (`chain`) должна гарантировать строго
// последовательное выполнение.

test('B1: два конкурентных transcribeWav сериализуются — POST-запросы идут строго по очереди, обе диктовки доезжают', async () => {
  const root = ROOT1();
  const fs = fakeFs([serverExePath(root, 'whisper'), modelPathFor(root, MODEL)]);
  const httpGet = () => Promise.resolve({ status: 200 });
  const postLog = [];
  let postCalls = 0;
  const httpPost = () => {
    postCalls += 1;
    const call = postCalls;
    postLog.push(`start#${call}`);
    if (call === 1) {
      // Первый POST вызова №1 — проваливается, вызывает ретрай.
      return Promise.resolve({ status: 500, body: Buffer.from('boom', 'utf8') });
    }
    return Promise.resolve({ status: 200, body: Buffer.from(`{"text":"text#${call}"}`, 'utf8') });
  };
  const spawnProc = fakeSpawn([]);
  const { stt } = setup({ fs, httpGet, httpPost, spawnProc, config: baseConfig({ stackRoots: [root] }) });

  const p1 = stt.transcribeWav(Buffer.from('a')); // диктовка №1
  const p2 = stt.transcribeWav(Buffer.from('b')); // диктовка №2, запущена КОНКУРЕНТНО (сервер ещё грузится/не готов к P2)

  const [r1, r2] = await Promise.all([p1, p2]);

  // Без сериализации call2 стартовал бы своим POST, пока висит ретрай call1,
  // и порядок/число вызовов было бы недетерминированным. С сериализацией —
  // строго 1 (провал call1), 2 (ретрай call1, успех), 3 (call2, успех).
  assert.deepStrictEqual(postLog, ['start#1', 'start#2', 'start#3']);
  assert.strictEqual(r1, 'text#2', 'диктовка №1 должна была доехать (после своего ретрая)');
  assert.strictEqual(r2, 'text#3', 'диктовка №2 должна была доехать, а не потеряться');
  assert.strictEqual(
    serverSpawns(spawnProc).length,
    2,
    'ровно один спавн + один ретрай ИЗ-ЗА 500 у call1 — БЕЗ третьего спавна от call2 (это и есть регрессия B1)',
  );
});

test('B1: сериализация не роняет второй вызов, если первый успешен с первой попытки', async () => {
  const root = ROOT1();
  const fs = fakeFs([serverExePath(root, 'whisper'), modelPathFor(root, MODEL)]);
  const httpGet = () => Promise.resolve({ status: 200 });
  let postCalls = 0;
  const httpPost = () => {
    postCalls += 1;
    return Promise.resolve({ status: 200, body: Buffer.from(`{"text":"t${postCalls}"}`, 'utf8') });
  };
  const { stt, spawnProc } = setup({ fs, httpGet, httpPost, config: baseConfig({ stackRoots: [root] }) });

  const [r1, r2] = await Promise.all([stt.transcribeWav(Buffer.from('a')), stt.transcribeWav(Buffer.from('b'))]);

  assert.strictEqual(r1, 't1');
  assert.strictEqual(r2, 't2');
  assert.strictEqual(serverSpawns(spawnProc).length, 1, 'один сервер на оба вызова — второй ensureServer() дождался уже поднятого');
});

// ================================================================== B2: живучесть =====
// Ревью раунд 1, Critical: после провала ВСЕГО перебора бекендов
// readyPromise раньше оставался уже РЕДЖЕКТНУТЫМ промисом навсегда —
// следующий ensureServer()/transcribeWav() мгновенно получал СТАРУЮ ошибку,
// ни одного нового spawnProc. Один моргнувший драйвер при прогреве убивал
// голос до перезапуска кокпита.

test('B2: провал полного перебора не отравляет модуль — второй ensureServer() делает НОВЫЕ спавны', async () => {
  const root = ROOT1();
  const fs = fakeFs([serverExePath(root, 'whisper'), modelPathFor(root, MODEL)]);
  const httpGet = () => Promise.reject(new Error('econnrefused'));
  const timers = fakeTimers();
  const clock = makeClock(0);
  const { stt, spawnProc } = setup({
    fs, httpGet, timers, clock, config: baseConfig({ stackRoots: [root] }),
  });

  const p1 = stt.ensureServer();
  await driveUntilSettled(p1, timers, clock);
  await assert.rejects(p1, /таймаут готовности/);
  assert.strictEqual(serverSpawns(spawnProc).length, 1);

  const p2 = stt.ensureServer();
  assert.notStrictEqual(p1, p2, 'второй ensureServer() не должен возвращать ту же (уже реджектнутую) ссылку на промис');
  await driveUntilSettled(p2, timers, clock);
  await assert.rejects(p2, /таймаут готовности/);
  assert.strictEqual(
    serverSpawns(spawnProc).length,
    2,
    'второй вызов должен был сделать НОВЫЙ спавн, а не мгновенно вернуть старую ошибку без единой попытки',
  );
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
  // Тест-хвост ревью раунда 1: этот второй фейковый child достаётся вызову
  // spawnProc('taskkill', ...) из killProc (НЕ второму серверу-ретраю — тот
  // получает уже дефолтный fakeChild из fakeSpawn) — назван по факту, а не
  // "second", чтобы имя не намекало на несуществующий второй сервер.
  const taskkillChild = fakeChild(222);
  const spawnProc = fakeSpawn([first, taskkillChild]);
  const { stt } = setup({
    fs, httpGet, httpPost, spawnProc, config: baseConfig({ stackRoots: [root] }),
  });

  await stt.transcribeWav(Buffer.from('a')); // вызывает ретрай → killProc() над first

  // fakeChild поддерживает removeListener — killProc (B3) снимает ИМЕННО
  // свой exit-хендлер через него, не через removeAllListeners.
  const ops = first.calls.map((c) => c.op).filter((op) => op === 'removeListener' || op === 'kill');
  const removeIdx = ops.indexOf('removeListener');
  const killIdx = ops.indexOf('kill');
  assert.ok(removeIdx >= 0 && killIdx >= 0, 'ожидались оба вызова у первого child');
  assert.ok(removeIdx < killIdx, `removeListener('exit', ...) должен быть ДО kill(), порядок: ${JSON.stringify(ops)}`);
});

test('B3: killProc снимает ТОЛЬКО свой exit-хендлер — чужой (registerProcess/runners.js) переживает', async () => {
  const root = ROOT1();
  const fs = fakeFs([serverExePath(root, 'whisper'), modelPathFor(root, MODEL)]);
  const httpGet = () => Promise.resolve({ status: 200 });
  let postCalls = 0;
  const httpPost = () => {
    postCalls += 1;
    if (postCalls === 1) return Promise.resolve({ status: 500, body: Buffer.from('x', 'utf8') });
    return Promise.resolve({ status: 200, body: Buffer.from('{"text":"ok"}', 'utf8') });
  };
  let foreignExitFired = 0;
  // Симулируем runners.js trackChild: СВОЙ 'exit'-слушатель, повешенный
  // ВНУТРИ registerProcess (та же точка входа, что и у настоящего реестра).
  const registerProcess = (child) => {
    child.on('exit', () => { foreignExitFired += 1; });
  };
  const spawnProc = fakeSpawn([]);
  const { stt } = setup({
    fs, httpGet, httpPost, spawnProc, registerProcess, config: baseConfig({ stackRoots: [root] }),
  });

  await stt.transcribeWav(Buffer.from('a')); // 500 → killProc над первым сервером → ретрай

  const firstServer = serverSpawns(spawnProc)[0].child;
  assert.ok(
    firstServer.calls.some((c) => c.op === 'removeListener' && c.event === 'exit'),
    'killProc должен был снять СВОЙ хендлер через removeListener, не removeAllListeners',
  );
  assert.ok(
    !firstServer.calls.some((c) => c.op === 'removeAllListeners'),
    'removeAllListeners НЕ должен был вызываться, пока у child есть removeListener',
  );

  // Процесс реально завершается (уже ПОСЛЕ killProc, как в жизни) — чужой
  // (registerProcess/runners.js) слушатель обязан ЭТО ПОЛУЧИТЬ.
  firstServer.emit('exit');
  assert.strictEqual(foreignExitFired, 1, 'чужой exit-листенер должен был пережить killProc');
});

test('B3 (фоллбэк): child без removeListener — killProc падает обратно на removeAllListeners', async () => {
  const root = ROOT1();
  const fs = fakeFs([serverExePath(root, 'whisper'), modelPathFor(root, MODEL)]);
  const httpGet = () => Promise.resolve({ status: 200 });
  const child = {
    pid: 111,
    calls: [],
    on(event, cb) { this.calls.push({ op: 'on', event }); return this; },
    removeAllListeners(event) { this.calls.push({ op: 'removeAllListeners', event }); return this; },
    kill() { this.calls.push({ op: 'kill' }); },
    // removeListener СОЗНАТЕЛЬНО отсутствует — проверяем фоллбэк.
  };
  const spawnProc = fakeSpawn([child]);
  const { stt } = setup({ fs, httpGet, spawnProc, config: baseConfig({ stackRoots: [root] }) });

  await stt.ensureServer();
  stt.dispose(); // dispose() тоже идёт через killProc

  assert.ok(child.calls.some((c) => c.op === 'removeAllListeners' && c.event === 'exit'));
  assert.ok(child.calls.some((c) => c.op === 'kill'));
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

test('dispose: идемпотентен (двойной вызов не бросает), снимает pending poll-таймер, будит зависший ensureServer()', async () => {
  const root = ROOT1();
  const fs = fakeFs([serverExePath(root, 'whisper'), modelPathFor(root, MODEL)]);
  const httpGet = () => new Promise(() => {}); // никогда не резолвится — сервер вечно "не готов"
  const timers = fakeTimers();
  const { stt } = setup({ fs, httpGet, timers, config: baseConfig({ stackRoots: [root] }) });

  const p = stt.ensureServer(); // запускает poll-цикл, не ждём
  p.catch(() => {}); // должен осесть (reject) ПОСЛЕ dispose() — гасим unhandled rejection заранее
  await Promise.resolve();
  await Promise.resolve();

  assert.doesNotThrow(() => stt.dispose());
  assert.doesNotThrow(() => stt.dispose());
  assert.strictEqual(timers.liveCount(), 0, 'poll-таймер должен быть снят dispose()');
  await assert.rejects(p, 'зависший ensureServer() должен был осесть (reject) после dispose(), а не висеть вечно');
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

test('dispose: ensureServer()/transcribeWav() после dispose() реджектят СРАЗУ, ни одного нового spawnProc', async () => {
  const root = ROOT1();
  const fs = fakeFs([serverExePath(root, 'whisper'), modelPathFor(root, MODEL)]);
  const httpGet = () => Promise.resolve({ status: 200 });
  const { stt, spawnProc } = setup({ fs, httpGet, config: baseConfig({ stackRoots: [root] }) });

  await stt.ensureServer();
  stt.dispose(); // сам dispose() тоже спавнит контрольный taskkill — считаем baseline ПОСЛЕ него
  const afterDispose = spawnProc.calls.length;

  await assert.rejects(() => stt.ensureServer(), /dispose/i);
  await assert.rejects(() => stt.transcribeWav(Buffer.from('a')), /dispose/i);
  assert.strictEqual(spawnProc.calls.length, afterDispose, 'ни ensureServer(), ни transcribeWav() после dispose() не должны спавнить (это и закрывает дыру "retry оживляет сервер после teardown")');
});

// ---------------------------------------------- Important-1: dispose во время поллинга -----
// Ревью раунд 1, зонды B и C: (B) continuation уже летящего httpGet
// планирует НОВЫЙ таймер ПОСЛЕ dispose() — поллинг переживает teardown;
// (C) отменённый таймер оставляет waitReady неосевшим → ensureServer()/
// transcribeWav() висят PENDING навсегда, renderer застревает в «🎤 …».

test('Important-1(B): dispose() во время зависшего httpGet-continuation НЕ планирует новый poll-таймер', async () => {
  const root = ROOT1();
  const fs = fakeFs([serverExePath(root, 'whisper'), modelPathFor(root, MODEL)]);
  let rejectHttpGet;
  const httpGet = () => new Promise((res, rej) => { rejectHttpGet = rej; });
  const timers = fakeTimers();
  const { stt } = setup({ fs, httpGet, timers, config: baseConfig({ stackRoots: [root] }) });

  const p = stt.ensureServer();
  p.catch(() => {});
  await flush(3); // httpGet уже вызван и висит (continuation ещё не отработала)

  stt.dispose();
  assert.strictEqual(timers.liveCount(), 0);

  // Теперь "поздно" срабатывает continuation исходного httpGet — сервер так и не ответил.
  rejectHttpGet(new Error('econnrefused'));
  await flush(5);

  assert.strictEqual(timers.liveCount(), 0, 'continuation НЕ должна была запланировать новый таймер после dispose()');
  await assert.rejects(p);
});

test('Important-1(C): dispose() во время активного poll-таймера — ensureServer() реджектится СРАЗУ, а не висит до дедлайна', async () => {
  const root = ROOT1();
  const fs = fakeFs([serverExePath(root, 'whisper'), modelPathFor(root, MODEL)]);
  const httpGet = () => Promise.reject(new Error('econnrefused')); // никогда не готов, поллинг идёт таймерами
  const timers = fakeTimers();
  const clock = makeClock(0);
  const { stt } = setup({
    fs, httpGet, timers, clock, config: baseConfig({ stackRoots: [root] }),
  });

  const p = stt.ensureServer();
  await flush(5); // первый poll-таймер уже запланирован — ensureServer "висит" в ожидании (до 20000мс дедлайна)

  stt.dispose();

  await assert.rejects(p, /dispose/i);
});

// -------------------------------------------------- Minor-4: точные числа таймингов -----
// Регрессия «поллинг раз в 3с вместо 300мс» или «дедлайн 2000мс вместо
// 20000мс» раньше проходила бы зелёной — ни один тест не смотрел на
// КОНКРЕТНОЕ число, только на факт «таймер где-то планируется».

test('Minor-4: POLL_INTERVAL_MS===300 — таймер поллинга планируется РОВНО с задержкой 300мс', async () => {
  const root = ROOT1();
  const fs = fakeFs([serverExePath(root, 'whisper'), modelPathFor(root, MODEL)]);
  const httpGet = () => Promise.reject(new Error('econnrefused'));
  const timers = fakeTimers();
  const { stt } = setup({ fs, httpGet, timers, config: baseConfig({ stackRoots: [root] }) });

  const p = stt.ensureServer();
  p.catch(() => {});
  await flush(5);

  assert.strictEqual(timers.lastMs(), 300);
});

test('Minor-4: READY_TIMEOUT_MS===20000 — дедлайн срабатывает строго ПОСЛЕ 20000мс (now()===deadline ещё не истёк)', async () => {
  const root = ROOT1();
  const fs = fakeFs([serverExePath(root, 'whisper'), modelPathFor(root, MODEL)]);
  const httpGet = () => Promise.reject(new Error('econnrefused'));
  const timers = fakeTimers();
  const clock = makeClock(0);
  const { stt } = setup({
    fs, httpGet, timers, clock, config: baseConfig({ stackRoots: [root] }),
  });

  const p = stt.ensureServer();
  let settled = false;
  p.then(() => { settled = true; }, () => { settled = true; });

  await flush(5); // первая попытка сразу реджектится → таймер #1 на 300мс

  clock.set(20000); // РОВНО дедлайн — по контракту (now() > deadline) ЕЩЁ не истёк
  firePoll(timers);
  await flush(5);
  assert.strictEqual(settled, false, 'на now()===deadline (20000) поллинг должен ПРОДОЛЖАТЬСЯ (строгое >)');

  clock.set(20001); // на 1мс больше — теперь истёк
  firePoll(timers);
  await assert.rejects(p, /таймаут готовности/);
});

// ========================================================================= status =====

test('status(): available=true до первого ensureServer(), warm=false и backend=null пока сервер не поднят', () => {
  const root = ROOT1();
  const fs = fakeFs([serverExePath(root, 'whisper'), modelPathFor(root, MODEL)]);
  const { stt } = setup({ fs, config: baseConfig({ stackRoots: [root] }) });

  assert.deepStrictEqual(stt.status(), { available: true, backend: null, warm: false });
});

// Хвост B2 (ре-ревью раунда 1): СИНХРОННЫЙ бросок из пролога итерации
// (registerProcess упал / spawnProc вернул null и child.on кинул TypeError)
// раньше ронял IIFE до строки-фикса B2 — readyPromise навсегда оставался
// реджектнутым тем же способом, что и в исходном B2. Фикс: await undefined
// первым делом (тело — микрозадача после readyPromise=self) + catch-обёртка.
test('B2-хвост: синхронный бросок registerProcess не отравляет модуль — после «починки» реестра спавн проходит', async () => {
  const root = ROOT1();
  const fs = fakeFs([serverExePath(root, 'whisper'), modelPathFor(root, MODEL)]);
  const httpGet = () => Promise.resolve({ status: 200 });
  const timers = fakeTimers();
  const clock = makeClock(0);
  let failOnce = true;
  const registered = [];
  const registerProcess = (child) => {
    if (failOnce) { failOnce = false; throw new Error('реестр упал'); }
    registered.push(child);
  };
  const { stt, spawnProc } = setup({
    fs, httpGet, timers, clock, registerProcess,
    config: baseConfig({ stackRoots: [root] }),
  });

  const p1 = stt.ensureServer();
  await driveUntilSettled(p1, timers, clock);
  await assert.rejects(p1, /реестр упал/);

  // Второй вызов обязан сделать НОВУЮ попытку (реестр «починился») и дойти
  // до готовности — а не мгновенно вернуть старую ошибку.
  const p2 = stt.ensureServer();
  assert.notStrictEqual(p1, p2);
  await driveUntilSettled(p2, timers, clock);
  await p2; // резолвится — сервер поднят
  assert.strictEqual(registered.length, 1, 'второй спавн зарегистрирован в реестре');
  assert.ok(serverSpawns(spawnProc).length >= 2, 'вторая попытка сделала новый спавн');
});

// ============= боевой инцидент живой приёмки: смерть CUDA на инференсе =============
// Сервер успешно грузит модель («готов»), но умирает на ПЕРВОМ инференсе
// (рабочие буферы CUDA не влезли в занятую VRAM). Старый ретрай крутил тот же
// CUDA-бекенд по кругу — фоллбэк на CPU существовал только для провала СТАРТА.

test('инцидент: сервер умер на инференсе → ретрай уходит на СЛЕДУЮЩИЙ бекенд (CPU)', async () => {
  const root = ROOT1();
  const fs = fakeFs([
    serverExePath(root, 'whisper-cuda'),
    serverExePath(root, 'whisper'),
    modelPathFor(root, MODEL),
  ]);
  const httpGet = () => Promise.resolve({ status: 200 });
  const children = [fakeChild(111), fakeChild(222)];
  const spawnProc = fakeSpawn(children);
  let postN = 0;
  const httpPost = () => {
    postN += 1;
    if (postN === 1) {
      // ПРОДОВЫЙ порядок (Critical-1 ревью инцидент-фикса): reject сокета —
      // микрозадача, приходит ПЕРВЫМ; событие exit на Windows едет через
      // threadpool и опаздывает ВСЕГДА (20/20 замеров зонда). Эмитим exit
      // поздним setImmediate — сдвиг обязан сработать по транспортной
      // метке err.sttTransport, а не по гонке proc===null.
      setImmediate(() => children[0].emit('exit'));
      return Promise.reject(new Error('read ECONNRESET'));
    }
    return Promise.resolve({ status: 200, body: Buffer.from('{"text":"привет"}', 'utf8') });
  };
  const { stt } = setup({
    fs, httpGet, httpPost, spawnProc, config: baseConfig({ stackRoots: [root] }),
  });

  const text = await stt.transcribeWav(Buffer.from('wav'));
  assert.strictEqual(text, 'привет');
  const spawns = serverSpawns(spawnProc);
  assert.strictEqual(spawns.length, 2);
  assert.strictEqual(spawns[0].exe, serverExePath(root, 'whisper-cuda'), 'первая попытка — CUDA');
  assert.strictEqual(spawns[1].exe, serverExePath(root, 'whisper'), 'ретрай обязан уйти на CPU, а не крутить CUDA');
});

test('инцидент: после смерти CUDA следующий transcribeWav стартует сразу с CPU (предпочтение закреплено)', async () => {
  const root = ROOT1();
  const fs = fakeFs([
    serverExePath(root, 'whisper-cuda'),
    serverExePath(root, 'whisper'),
    modelPathFor(root, MODEL),
  ]);
  const httpGet = () => Promise.resolve({ status: 200 });
  const children = [fakeChild(111), fakeChild(222), fakeChild(333)];
  const spawnProc = fakeSpawn(children);
  let postN = 0;
  const httpPost = () => {
    postN += 1;
    if (postN === 1) {
      setImmediate(() => children[0].emit('exit')); // продовый порядок: reject первым (Critical-1)
      return Promise.reject(new Error('read ECONNRESET'));
    }
    return Promise.resolve({ status: 200, body: Buffer.from('{"text":"ok"}', 'utf8') });
  };
  const { stt } = setup({
    fs, httpGet, httpPost, spawnProc, config: baseConfig({ stackRoots: [root] }),
  });

  await stt.transcribeWav(Buffer.from('wav1'));
  // Убьём CPU-сервер штатно (exit), чтобы следующий вызов спавнил заново.
  // ВАЖНО: адресуемся через serverSpawns().child, НЕ через children[индекс] —
  // killProc (теперь реально выполняющийся: с продовым порядком exit
  // опаздывает, proc жив в catch) спавнит taskkill, который СЪЕДАЕТ
  // очередного ребёнка из массива fakeSpawn, и children[1] оказался бы
  // taskkill-ребёнком, а не CPU-сервером.
  serverSpawns(spawnProc)[1].child.emit('exit');
  await stt.transcribeWav(Buffer.from('wav2'));
  const spawns = serverSpawns(spawnProc);
  assert.strictEqual(spawns.length, 3);
  assert.strictEqual(spawns[2].exe, serverExePath(root, 'whisper'), 'третий спавн — сразу CPU, CUDA больше не пробуем');
});

test('инцидент: HTTP 500 при ЖИВОМ сервере → ретрай на ТОМ ЖЕ бекенде (бекенд не виноват)', async () => {
  const root = ROOT1();
  const fs = fakeFs([
    serverExePath(root, 'whisper-cuda'),
    serverExePath(root, 'whisper'),
    modelPathFor(root, MODEL),
  ]);
  const httpGet = () => Promise.resolve({ status: 200 });
  const spawnProc = fakeSpawn([]);
  let postN = 0;
  const httpPost = () => {
    postN += 1;
    if (postN === 1) return Promise.resolve({ status: 500, body: Buffer.from('err', 'utf8') });
    return Promise.resolve({ status: 200, body: Buffer.from('{"text":"ok"}', 'utf8') });
  };
  const { stt } = setup({
    fs, httpGet, httpPost, spawnProc, config: baseConfig({ stackRoots: [root] }),
  });

  await stt.transcribeWav(Buffer.from('wav'));
  const spawns = serverSpawns(spawnProc);
  assert.strictEqual(spawns.length, 2);
  assert.strictEqual(spawns[0].exe, serverExePath(root, 'whisper-cuda'));
  assert.strictEqual(spawns[1].exe, serverExePath(root, 'whisper-cuda'), '500 от живого сервера — не повод менять бекенд');
});

test('инцидент: CPU (последний бекенд) умер на инференсе → предпочтение не сдвигается, обычный ретрай CPU', async () => {
  const root = ROOT1();
  const fs = fakeFs([serverExePath(root, 'whisper'), modelPathFor(root, MODEL)]); // только CPU
  const httpGet = () => Promise.resolve({ status: 200 });
  const children = [fakeChild(111), fakeChild(222)];
  const spawnProc = fakeSpawn(children);
  let postN = 0;
  const httpPost = () => {
    postN += 1;
    if (postN === 1) {
      setImmediate(() => children[0].emit('exit')); // продовый порядок: reject первым (Critical-1)
      return Promise.reject(new Error('read ECONNRESET'));
    }
    return Promise.resolve({ status: 200, body: Buffer.from('{"text":"ok"}', 'utf8') });
  };
  const { stt } = setup({
    fs, httpGet, httpPost, spawnProc, config: baseConfig({ stackRoots: [root] }),
  });

  const text = await stt.transcribeWav(Buffer.from('wav'));
  assert.strictEqual(text, 'ok');
  const spawns = serverSpawns(spawnProc);
  assert.strictEqual(spawns[1].exe, serverExePath(root, 'whisper'), 'единственный бекенд ретраится сам');
});

test('инцидент: порт занят чужим (ready отвечает, но НАШ ребёнок умер) → попытка честно падает, следующий бекенд', async () => {
  const root = ROOT1();
  const fs = fakeFs([
    serverExePath(root, 'whisper-cuda'),
    serverExePath(root, 'whisper'),
    modelPathFor(root, MODEL),
  ]);
  const children = [fakeChild(111), fakeChild(222)];
  const spawnProc = fakeSpawn(children);
  let getN = 0;
  const httpGet = () => {
    getN += 1;
    if (getN === 1) {
      // Чужой процесс на порту отвечает на пинг — но наш ребёнок №1 уже умер.
      children[0].emit('exit');
      return Promise.resolve({ status: 200 });
    }
    return Promise.resolve({ status: 200 });
  };
  const httpPost = () => Promise.resolve({ status: 200, body: Buffer.from('{"text":"ok"}', 'utf8') });
  const logs = [];
  const { stt } = setup({
    fs, httpGet, httpPost, spawnProc,
    config: baseConfig({ stackRoots: [root] }),
    log: (m) => logs.push(m),
  });

  const text = await stt.transcribeWav(Buffer.from('wav'));
  assert.strictEqual(text, 'ok');
  const spawns = serverSpawns(spawnProc);
  assert.strictEqual(spawns.length, 2, 'первая попытка отвергнута, вторая — следующий бекенд');
  assert.strictEqual(spawns[1].exe, serverExePath(root, 'whisper'));
  assert.ok(
    logs.some((l) => /умер при старте/.test(l)),
    'лог обязан назвать причину («умер при старте»), а не рапортовать готовность чужака',
  );
});

test('Important-1: провал СТАРТА всех бекендов — НЕ демоция; следующий вызов снова начинает с CUDA', async () => {
  const root = ROOT1();
  const fs = fakeFs([
    serverExePath(root, 'whisper-cuda'),
    serverExePath(root, 'whisper'),
    modelPathFor(root, MODEL),
  ]);
  const timers = fakeTimers();
  const clock = makeClock(0);
  let phase = 'down'; // 'down' → ни один бекенд не отвечает; 'up' → всё работает
  const httpGet = () => (phase === 'down'
    ? Promise.reject(new Error('econnrefused'))
    : Promise.resolve({ status: 200 }));
  const httpPost = () => Promise.resolve({ status: 200, body: Buffer.from('{"text":"ok"}', 'utf8') });
  const spawnProc = fakeSpawn([]);
  const logs = [];
  const { stt } = setup({
    fs, httpGet, httpPost, spawnProc, timers, clock,
    config: baseConfig({ stackRoots: [root] }),
    log: (m) => logs.push(m),
  });

  const p1 = stt.transcribeWav(Buffer.from('wav'));
  p1.catch(() => {}); // ожидаемый провал — гасим unhandled
  // transcribeWav делает ДВА полных перебора бекендов (попытка + ретрай):
  // 2 × 2 бекенда × ~67 тиков поллинга до дедлайна — дефолтных 200 шагов
  // драйвера не хватает.
  await driveUntilSettled(p1, timers, clock, { maxSteps: 600 });
  await assert.rejects(p1);
  assert.ok(!logs.some((l) => /умер на инференсе/.test(l)),
    'провал старта не должен маскироваться под смерть на инференсе');

  phase = 'up';
  const spawnsBefore = serverSpawns(spawnProc).length;
  await stt.transcribeWav(Buffer.from('wav2'));
  const spawns = serverSpawns(spawnProc);
  assert.strictEqual(spawns[spawnsBefore].exe, serverExePath(root, 'whisper-cuda'),
    'после провала старта предпочтение НЕ сдвинуто — снова CUDA');
});

test('Minor-1: демоция не навсегда — холодный старт спустя интервал снова пробует CUDA', async () => {
  const root = ROOT1();
  const fs = fakeFs([
    serverExePath(root, 'whisper-cuda'),
    serverExePath(root, 'whisper'),
    modelPathFor(root, MODEL),
  ]);
  const clock = makeClock(0);
  const httpGet = () => Promise.resolve({ status: 200 });
  const children = [fakeChild(111), fakeChild(222), fakeChild(333)];
  const spawnProc = fakeSpawn(children);
  let postN = 0;
  const httpPost = () => {
    postN += 1;
    if (postN === 1) {
      setImmediate(() => children[0].emit('exit'));
      return Promise.reject(new Error('read ECONNRESET'));
    }
    return Promise.resolve({ status: 200, body: Buffer.from('{"text":"ok"}', 'utf8') });
  };
  const { stt } = setup({
    fs, httpGet, httpPost, spawnProc, clock, config: baseConfig({ stackRoots: [root] }),
  });

  await stt.transcribeWav(Buffer.from('wav1')); // CUDA умер → CPU
  // Через serverSpawns().child — killProc-таскилл съедает детей из массива
  // по порядку вызовов (см. комментарий в тесте «предпочтение закреплено»).
  serverSpawns(spawnProc)[1].child.emit('exit'); // тёплый CPU умер сам — состояние холодное
  clock.set(6 * 60000); // интервал ре-пробы вышел
  await stt.transcribeWav(Buffer.from('wav2'));
  const spawns = serverSpawns(spawnProc);
  assert.strictEqual(spawns.length, 3);
  assert.strictEqual(spawns[2].exe, serverExePath(root, 'whisper-cuda'),
    'холодный старт после интервала обязан снова попробовать CUDA');
});

// ============= инцидент 8ГБ (01.08): глушение тёплого сервера по простою =====

test('инцидент 8ГБ: после transcribeWav взводится idle-таймер (600000мс); его выстрел глушит сервер', async () => {
  const root = ROOT1();
  const fs = fakeFs([serverExePath(root, 'whisper'), modelPathFor(root, MODEL)]);
  const timers = fakeTimers();
  const httpGet = () => Promise.resolve({ status: 200 });
  const httpPost = () => Promise.resolve({ status: 200, body: Buffer.from('{"text":"ok"}', 'utf8') });
  const children = [fakeChild(111), fakeChild(222)];
  const spawnProc = fakeSpawn(children);
  const { stt } = setup({
    fs, timers, httpGet, httpPost, spawnProc, config: baseConfig({ stackRoots: [root] }),
  });

  await stt.transcribeWav(Buffer.from('wav'));
  await flush(5); // хвост цепочки (armIdleShutdown) — микрозадачи
  assert.strictEqual(timers.lastMs(), 600000, 'idle-таймер на 10 минут');
  assert.strictEqual(timers.liveCount(), 1);

  timers.fire(timers.lastId()); // простой вышел
  // Сервер заглушен: kill у ребёнка + контрольный taskkill.
  assert.ok(children[0].calls.some((c) => c.op === 'kill'), 'сервер убит по простою');
  // Следующая диктовка прогревает заново.
  await stt.transcribeWav(Buffer.from('wav2'));
  assert.strictEqual(serverSpawns(spawnProc).length, 2, 'после глушения — новый спавн');
});

test('инцидент 8ГБ: каждый transcribeWav перевзводит idle-таймер (старый снят, не копятся)', async () => {
  const root = ROOT1();
  const fs = fakeFs([serverExePath(root, 'whisper'), modelPathFor(root, MODEL)]);
  const timers = fakeTimers();
  const httpGet = () => Promise.resolve({ status: 200 });
  const httpPost = () => Promise.resolve({ status: 200, body: Buffer.from('{"text":"ok"}', 'utf8') });
  const { stt } = setup({
    fs, timers, httpGet, httpPost, config: baseConfig({ stackRoots: [root] }),
  });

  await stt.transcribeWav(Buffer.from('a'));
  await flush(5);
  await stt.transcribeWav(Buffer.from('b'));
  await flush(5);
  assert.strictEqual(timers.liveCount(), 1, 'живой idle-таймер ровно один');
});

test('инцидент 8ГБ: dispose снимает idle-таймер', async () => {
  const root = ROOT1();
  const fs = fakeFs([serverExePath(root, 'whisper'), modelPathFor(root, MODEL)]);
  const timers = fakeTimers();
  const httpGet = () => Promise.resolve({ status: 200 });
  const httpPost = () => Promise.resolve({ status: 200, body: Buffer.from('{"text":"ok"}', 'utf8') });
  const { stt } = setup({
    fs, timers, httpGet, httpPost, config: baseConfig({ stackRoots: [root] }),
  });

  await stt.transcribeWav(Buffer.from('a'));
  await flush(5);
  stt.dispose();
  assert.strictEqual(timers.liveCount(), 0, 'после dispose живых таймеров нет');
});
