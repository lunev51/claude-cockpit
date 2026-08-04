'use strict';
// Ревью раунда 2 задачи 7 (Important 1 + Important 2): без аутентификации в
// этой фазе адрес прослушивания сетевого сервера — ЕДИНСТВЕННАЯ линия
// обороны кокпита. Ревьюер подменил дефолт host на '0.0.0.0' прямо в
// источнике (внутри registerIpc(), инлайн-тернарник) и весь набор — 828
// тестов — остался зелёным: ни один тест не трогал именно эту строку.
// resolveNetConfig()/startNetServerWithRetries() (ipc.js) — вынесенные
// чистые функции, которые registerIpc() реально зовёт (см. комментарии у их
// определения в ipc.js) — тесты здесь зовут ту же самую реализацию, а не
// копию, тем же приёмом, что test/ipc-output-buffer-wiring.test.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { resolveNetConfig, startNetServerWithRetries } = require('../src/main/ipc');

// --- resolveNetConfig ---

test('resolveNetConfig: пустой конфиг → 127.0.0.1:48300, allowedHosts:[] (дефолт, БУКВАЛЬНЫЙ литерал в assert — не константа модуля)', () => {
  assert.deepStrictEqual(resolveNetConfig({}), { host: '127.0.0.1', port: 48300, allowedHosts: [] });
  assert.deepStrictEqual(resolveNetConfig(undefined), { host: '127.0.0.1', port: 48300, allowedHosts: [] });
  assert.deepStrictEqual(resolveNetConfig(null), { host: '127.0.0.1', port: 48300, allowedHosts: [] });
});

test('resolveNetConfig: адрес, порт и allowedHosts из конфига доезжают как есть', () => {
  const warnings = [];
  const result = resolveNetConfig(
    { host: '100.120.245.85', port: 48301, allowedHosts: ['cockpit-desktop.tailnet.ts.net'] },
    (m) => warnings.push(m),
  );
  assert.deepStrictEqual(result, {
    host: '100.120.245.85', port: 48301, allowedHosts: ['cockpit-desktop.tailnet.ts.net'],
  });
  assert.deepStrictEqual(warnings, []); // валидные значения — без единого предупреждения
});

test('resolveNetConfig: мусор в конфиге (включая allowedHosts не-массивом) откатывается к умолчанию, с предупреждением', () => {
  const warnings = [];
  const result = resolveNetConfig({ host: 12345, port: 'мусор', allowedHosts: 'не-массив' }, (m) => warnings.push(m));
  assert.deepStrictEqual(result, { host: '127.0.0.1', port: 48300, allowedHosts: [] });
  assert.strictEqual(warnings.length, 3); // host, port и allowedHosts предупредили независимо
});

test('resolveNetConfig: пустая строка host — тоже мусор, не «валидная строка»', () => {
  const result = resolveNetConfig({ host: '   ' });
  assert.strictEqual(result.host, '127.0.0.1');
});

test('resolveNetConfig: port вне диапазона (0, отрицательный, дробный, >65535) откатывается', () => {
  for (const bad of [0, -1, 3.5, 70000]) {
    assert.strictEqual(resolveNetConfig({ port: bad }).port, 48300, `port=${bad} должен откатиться к дефолту`);
  }
});

// M3 (ревью раунда 2, Minor): порт-строка из руками правленного config.json.
test('resolveNetConfig: port строкой ("48377") приводится к числу, с предупреждением', () => {
  const warnings = [];
  const result = resolveNetConfig({ port: '48377' }, (m) => warnings.push(m));
  assert.strictEqual(result.port, 48377);
  assert.strictEqual(typeof result.port, 'number');
  assert.strictEqual(warnings.length, 1);
});

test('resolveNetConfig: port строкой-мусором ("abc") откатывается к дефолту, с предупреждением', () => {
  const warnings = [];
  const result = resolveNetConfig({ port: 'abc' }, (m) => warnings.push(m));
  assert.strictEqual(result.port, 48300);
  assert.strictEqual(warnings.length, 1);
});

// M1 (координатор, фикс DNS-rebinding в net-server.js, раунд 4): allowedHosts —
// доп. имена для белого списка Host (net-server.js уже принимает параметр и
// по умолчанию считает его []) — разбор здесь не мягче, чем у host/port выше.

test('resolveNetConfig: allowedHosts отсутствует в конфиге → пустой массив, без предупреждений', () => {
  const warnings = [];
  const result = resolveNetConfig({}, (m) => warnings.push(m));
  assert.deepStrictEqual(result.allowedHosts, []);
  assert.deepStrictEqual(warnings, []);
});

test('resolveNetConfig: allowedHosts — нормальный список доезжает как есть', () => {
  const warnings = [];
  const list = ['cockpit-desktop.tailnet.ts.net', '100.120.245.85'];
  const result = resolveNetConfig({ allowedHosts: list }, (m) => warnings.push(m));
  assert.deepStrictEqual(result.allowedHosts, list);
  assert.deepStrictEqual(warnings, []);
});

test('resolveNetConfig: allowedHosts не массивом целиком откатывается к [], с предупреждением', () => {
  const warnings = [];
  const result = resolveNetConfig({ allowedHosts: 'cockpit-desktop.tailnet.ts.net' }, (m) => warnings.push(m));
  assert.deepStrictEqual(result.allowedHosts, []);
  assert.strictEqual(warnings.length, 1);
});

test('resolveNetConfig: allowedHosts массивом с мусором — не-строки и пустые строки отбрасываются поэлементно, валидные остаются', () => {
  const warnings = [];
  const result = resolveNetConfig(
    { allowedHosts: ['valid.tailnet.ts.net', 123, '', '   ', null, 'second-valid.example'] },
    (m) => warnings.push(m),
  );
  assert.deepStrictEqual(result.allowedHosts, ['valid.tailnet.ts.net', 'second-valid.example']);
  assert.strictEqual(warnings.length, 4); // по одному предупреждению на каждый из 4 отброшенных элементов
});

// --- startNetServerWithRetries ---

// Фейковый setTimer: НЕ ждёт реального времени, но и не зовёт колбэк
// синхронно в тот же тик (setTimeout(fn, 0) тоже так не делает) — планирует
// его на следующую микрозадачу через Promise.resolve().then(fn). Этого
// достаточно, чтобы обычный await на возвращённом startNetServerWithRetries()
// промисе дождался ЛЮБОЙ глубины рекурсии повторов сам, без ручной
// оркестровки очереди таймеров (в отличие от night-watch.test.js, где
// повторов внутри одного прогона может быть много и нужен точечный контроль
// момента срабатывания — здесь порядок фиксированный и синхронный await
// безопасен). msLog хранит задержку КАЖДОГО запланированного повтора —
// проверка «не перепутали константу retryMs», тот же приём, что в
// night-watch.test.js.
function fakeSetTimer() {
  const msLog = [];
  const setTimer = (fn, ms) => {
    msLog.push(ms);
    Promise.resolve().then(fn);
    return { unref() {} };
  };
  return { setTimer, msLog };
}

test('startNetServerWithRetries: успех с первой попытки — notify не зовётся, ретраев нет', async () => {
  const notified = [];
  const timers = fakeSetTimer();
  const result = await startNetServerWithRetries({
    start: () => Promise.resolve({ port: 48300 }),
    host: '127.0.0.1',
    port: 48300,
    notify: (text, level) => notified.push({ text, level }),
    setTimer: timers.setTimer,
  });
  assert.strictEqual(result, true);
  assert.strictEqual(notified.length, 0);
  assert.strictEqual(timers.msLog.length, 0);
});

test('startNetServerWithRetries: падает дважды, потом успевает — успех без notify, ровно 2 запланированных повтора с ЗАКАЗАННОЙ задержкой', async () => {
  const notified = [];
  const timers = fakeSetTimer();
  let calls = 0;
  const start = () => {
    calls += 1;
    if (calls <= 2) return Promise.reject(new Error('EADDRNOTAVAIL'));
    return Promise.resolve({ port: 48300 });
  };
  const result = await startNetServerWithRetries({
    start,
    host: '100.120.245.85',
    port: 48300,
    notify: (text, level) => notified.push({ text, level }),
    setTimer: timers.setTimer,
    retryMs: 5000,
    maxRetries: 6,
  });
  assert.strictEqual(result, true);
  assert.strictEqual(calls, 3);
  assert.strictEqual(notified.length, 0);
  assert.deepStrictEqual(timers.msLog, [5000, 5000], 'оба повтора должны планироваться РОВНО с retryMs, а не с другим числом');
});

test('startNetServerWithRetries: исчерпал попытки — notify зовётся ровно один раз с адресом/портом/причиной, повторов ровно maxRetries', async () => {
  const notified = [];
  const timers = fakeSetTimer();
  let calls = 0;
  const start = () => {
    calls += 1;
    return Promise.reject(new Error('EADDRNOTAVAIL'));
  };
  const result = await startNetServerWithRetries({
    start,
    host: '100.120.245.85',
    port: 48300,
    notify: (text, level) => notified.push({ text, level }),
    setTimer: timers.setTimer,
    retryMs: 1000,
    maxRetries: 3,
  });
  assert.strictEqual(result, false);
  assert.strictEqual(calls, 4); // 1 первая попытка + 3 повтора
  assert.deepStrictEqual(timers.msLog, [1000, 1000, 1000]);
  assert.strictEqual(notified.length, 1);
  assert.strictEqual(notified[0].level, 'error');
  assert.ok(notified[0].text.includes('100.120.245.85'), 'текст уведомления должен называть адрес');
  assert.ok(notified[0].text.includes('48300'), 'текст уведомления должен называть порт');
  assert.ok(notified[0].text.includes('EADDRNOTAVAIL'), 'текст уведомления должен нести причину сбоя');
});

// --- Проводка: registerIpc() реально зовёт resolveNetConfig()/
// startNetServerWithRetries() с реальными зависимостями, а не только
// определяет их (тот же приём, что test/ipc-output-buffer-wiring.test.js —
// см. шапку файла: диверсия «удалить строку вызова, оставить определение»
// уже показала себя на этом же файле и не ловится юнит-тестами чистых
// функций самих по себе).
const ipcSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ipc.js'), 'utf8');

function countOccurrences(text, substr) {
  return text.split(substr).length - 1;
}

test('проводка: registerIpc зовёт resolveNetConfig(getConfig().net) (не только определяет функцию)', () => {
  assert.ok(
    countOccurrences(ipcSrc, 'resolveNetConfig(getConfig().net)') >= 1,
    'вызов resolveNetConfig(getConfig().net) не найден в исходнике — netCfg мог начать браться откуда-то ещё (например, снова инлайн-тернарником)',
  );
});

test('проводка: createNetServer получает host/port/allowedHosts ИЗ netCfg, а не литералами', () => {
  assert.ok(
    ipcSrc.includes('port: netCfg.port,') && ipcSrc.includes('host: netCfg.host,'),
    'createNetServer() должен получать host/port из результата resolveNetConfig(), а не захардкоженными литералами',
  );
  assert.ok(
    ipcSrc.includes('allowedHosts: netCfg.allowedHosts,'),
    'createNetServer() должен получать allowedHosts из результата resolveNetConfig() — иначе доп. имена тайлнета собираются, но никуда не доезжают',
  );
});

test('проводка: старт сервера идёт через startNetServerWithRetries (не голый netServer.start().catch)', () => {
  assert.ok(
    ipcSrc.includes('startNetServerWithRetries({'),
    'вызов startNetServerWithRetries не найден — старт мог откатиться на голый netServer.start().catch без повторов и уведомления',
  );
  assert.ok(
    !/netServer\.start\(\)\.catch/.test(ipcSrc),
    'найден голый netServer.start().catch(...) — регресс к старому поведению без повторов/notify',
  );
});
