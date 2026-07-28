'use strict';
// Раннеры внешних CLI + реестр процессов + watchdog (Task 5 carryover фазы 6,
// п.2 брифа задачи 5 фазы 7): раньше эта логика жила прямо внутри ipc.js,
// который требует require('electron') — вне настоящего Electron-рантайма это
// не объект, а строка, и ipc.js вообще не тестировался. runners.js — чистый
// модуль: execFile инжектируется, фейковый child — обычный EventEmitter c
// .pid (как node ChildProcess), setTimeoutFn/clearTimeoutFn — тоже
// инжектируемые, что даёт детерминированно проверить и вотчдог, не дожидаясь
// реальных секунд.

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { createRunners, CCUSAGE_PACKAGE } = require('../src/main/runners');

// Фейковый execFile(cmd, args, options, cb): возвращает EventEmitter с .pid
// (как настоящий child_process.ChildProcess) СИНХРОННО, cb вызывается вручную
// из теста (fake.calls[i].cb(err, stdout, stderr)) — полный контроль над
// таймингом завершения/таймаута/ENOENT.
function makeFakeExecFile() {
  const calls = [];
  const fn = (cmd, args, options, cb) => {
    const child = new EventEmitter();
    child.pid = 5000 + calls.length;
    calls.push({
      cmd, args, options, cb, child,
    });
    return child;
  };
  fn.calls = calls;
  return fn;
}

// Фейковые setTimeout/clearTimeout: setTimeoutFn возвращает объект-«таймер»
// без реального планирования — тест сам решает, когда «наступит» момент,
// вызывая scheduled[i].fn() руками.
function makeFakeTimers() {
  const scheduled = [];
  const setTimeoutFn = (fn, delay) => {
    const timer = { fn, delay, cleared: false };
    scheduled.push(timer);
    return timer;
  };
  const clearTimeoutFn = (timer) => { if (timer) timer.cleared = true; };
  return { scheduled, setTimeoutFn, clearTimeoutFn };
}

// ---------------------------------------------------------------- реестр --

test('trackChild регистрирует pid в реестре; событие exit убирает его', () => {
  const runners = createRunners({ execFile: makeFakeExecFile() });
  const child = new EventEmitter();
  child.pid = 777;
  runners.trackChild(child);
  assert.ok(runners.liveChildren.has(777));
  child.emit('exit');
  assert.ok(!runners.liveChildren.has(777));
});

test('trackChild игнорирует child без числового pid (не падает, не добавляет запись)', () => {
  const runners = createRunners({ execFile: makeFakeExecFile() });
  const sizeBefore = runners.liveChildren.size;
  runners.trackChild({});
  runners.trackChild(null);
  runners.trackChild(undefined);
  assert.strictEqual(runners.liveChildren.size, sizeBefore);
});

// ------------------------------------------------------------ killProcessTree --

test('killProcessTree зовёт execFile("taskkill", ["/PID", String(pid), "/T", "/F"], {windowsHide:true}, cb)', () => {
  const fake = makeFakeExecFile();
  const runners = createRunners({ execFile: fake });
  runners.killProcessTree(4242);
  assert.strictEqual(fake.calls.length, 1);
  assert.strictEqual(fake.calls[0].cmd, 'taskkill');
  assert.deepStrictEqual(fake.calls[0].args, ['/PID', '4242', '/T', '/F']);
  assert.deepStrictEqual(fake.calls[0].options, { windowsHide: true });
});

test('killProcessTree с не-числовым pid — no-op, execFile не зовётся', () => {
  const fake = makeFakeExecFile();
  const runners = createRunners({ execFile: fake });
  runners.killProcessTree('abc');
  runners.killProcessTree(undefined);
  runners.killProcessTree(null);
  assert.strictEqual(fake.calls.length, 0);
});

// ------------------------------------------------------------ armKillWatchdog --

test('armKillWatchdog планирует таймер с задержкой (timeoutMs - запас 500мс)', () => {
  const timers = makeFakeTimers();
  const runners = createRunners({
    execFile: makeFakeExecFile(), setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn,
  });
  const child = new EventEmitter();
  child.pid = 111;
  runners.armKillWatchdog(child, 10000);
  assert.strictEqual(timers.scheduled.length, 1);
  assert.strictEqual(timers.scheduled[0].delay, 9500);
});

test('armKillWatchdog: задержка не уходит в минус при timeoutMs меньше запаса (Math.max(0, ...))', () => {
  const timers = makeFakeTimers();
  const runners = createRunners({
    execFile: makeFakeExecFile(), setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn,
  });
  const child = new EventEmitter();
  child.pid = 1;
  runners.armKillWatchdog(child, 200);
  assert.strictEqual(timers.scheduled[0].delay, 0);
});

test('armKillWatchdog: срабатывание таймера бьёт по дереву child.pid (execFile taskkill)', () => {
  const fake = makeFakeExecFile();
  const timers = makeFakeTimers();
  const runners = createRunners({ execFile: fake, setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn });
  const child = new EventEmitter();
  child.pid = 999;
  runners.armKillWatchdog(child, 10000);
  timers.scheduled[0].fn(); // симулируем «наступил момент вотчдога»
  assert.strictEqual(fake.calls.length, 1);
  assert.strictEqual(fake.calls[0].cmd, 'taskkill');
  assert.ok(fake.calls[0].args.includes('999'));
});

// ----------------------------------------------------------------- runCcusage --

test('runCcusage зовёт execFile("npx", ["--yes", CCUSAGE_PACKAGE, ...args], {shell:true, timeout:60000, windowsHide:true, maxBuffer}, cb)', async () => {
  const fake = makeFakeExecFile();
  const runners = createRunners({ execFile: fake });
  const p = runners.runCcusage(['claude', 'daily', '--json']);
  assert.strictEqual(fake.calls.length, 1);
  const call = fake.calls[0];
  assert.strictEqual(call.cmd, 'npx');
  assert.deepStrictEqual(call.args, ['--yes', CCUSAGE_PACKAGE, 'claude', 'daily', '--json']);
  assert.strictEqual(call.options.shell, true, 'npx — .cmd-шим на Windows, shell:true нельзя потерять при переносе');
  assert.strictEqual(call.options.timeout, 60000);
  assert.strictEqual(call.options.windowsHide, true);
  assert.strictEqual(call.options.maxBuffer, 16 * 1024 * 1024);
  call.cb(null, '{"ok":true}', '');
  const res = await p;
  assert.deepStrictEqual(res, { code: 0, stdout: '{"ok":true}', stderr: '' });
});

test('runCcusage: child трекается в реестре и убирается по exit', async () => {
  const fake = makeFakeExecFile();
  const runners = createRunners({ execFile: fake });
  const p = runners.runCcusage(['x']);
  const { child } = fake.calls[0];
  assert.ok(runners.liveChildren.has(child.pid));
  fake.calls[0].cb(null, '', '');
  await p;
  child.emit('exit');
  assert.ok(!runners.liveChildren.has(child.pid));
});

test('runCcusage: err с числовым code → resolve({code: err.code, stdout, stderr}), дерево НЕ добивается (Minor 6, ревью раунд 1)', async () => {
  const fake = makeFakeExecFile();
  const runners = createRunners({ execFile: fake });
  const p = runners.runCcusage(['x']);
  const err = new Error('boom');
  err.code = 7; // обычный код завершения, НЕ убийство по таймауту (err.killed отсутствует)
  fake.calls[0].cb(err, '', 'stderr text');
  const res = await p;
  assert.deepStrictEqual(res, { code: 7, stdout: '', stderr: 'stderr text' });
  // Minor 6: без этой проверки регрессия killTreeOnTimeout (замена
  // `if (err && err.killed)` на `if (err)`) осталась бы зелёной — обычный
  // code!=0 (например, штатный "not a git repository" в gitRun) НЕ должен
  // порождать лишний вызов killProcessTree(taskkill) по уже мёртвому pid.
  assert.strictEqual(fake.calls.length, 1, 'обычный code!=0 не должен вызывать killProcessTree — только сам runCcusage-вызов execFile');
});

test('runCcusage: err без code → code:1 по умолчанию', async () => {
  const fake = makeFakeExecFile();
  const runners = createRunners({ execFile: fake });
  const p = runners.runCcusage(['x']);
  fake.calls[0].cb(new Error('boom'), '', '');
  const res = await p;
  assert.strictEqual(res.code, 1);
});

test('runCcusage: таймаут (err.killed) добивает дерево через killProcessTree(child.pid)', async () => {
  const fake = makeFakeExecFile();
  const runners = createRunners({ execFile: fake });
  const p = runners.runCcusage(['x']);
  const { child } = fake.calls[0];
  const err = new Error('timeout');
  err.killed = true;
  fake.calls[0].cb(err, '', '');
  await p;
  assert.strictEqual(fake.calls.length, 2, 'должен появиться ВТОРОЙ вызов execFile — killProcessTree(taskkill)');
  assert.strictEqual(fake.calls[1].cmd, 'taskkill');
  assert.ok(fake.calls[1].args.includes(String(child.pid)));
});

test('runCcusage: успешное завершение до срабатывания вотчдога гасит его таймер (clearTimeoutFn)', async () => {
  const fake = makeFakeExecFile();
  const timers = makeFakeTimers();
  const runners = createRunners({ execFile: fake, setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn });
  const p = runners.runCcusage(['x']);
  assert.strictEqual(timers.scheduled[0].cleared, false);
  fake.calls[0].cb(null, 'ok', '');
  await p;
  assert.strictEqual(timers.scheduled[0].cleared, true);
});

// -------------------------------------------------------------------- gitRun --

test('gitRun зовёт execFile("git", args, {cwd, windowsHide:true, timeout:15000, maxBuffer}, cb) БЕЗ shell:true', async () => {
  const fake = makeFakeExecFile();
  const runners = createRunners({ execFile: fake });
  const p = runners.gitRun(['status', '--porcelain=v1', '-b'], 'C:\\repo');
  const call = fake.calls[0];
  assert.strictEqual(call.cmd, 'git');
  assert.deepStrictEqual(call.args, ['status', '--porcelain=v1', '-b']);
  assert.strictEqual(call.options.cwd, 'C:\\repo');
  assert.strictEqual(call.options.timeout, 15000);
  assert.strictEqual(call.options.maxBuffer, 10 * 1024 * 1024);
  assert.strictEqual('shell' in call.options, false, 'git.exe — обычный бинарник, shell:true здесь не нужен');
  call.cb(null, 'stdout-text', '');
  const res = await p;
  assert.deepStrictEqual(res, { code: 0, stdout: 'stdout-text', stderr: '' });
});

test('gitRun: ENOENT → reject (git не установлен)', async () => {
  const fake = makeFakeExecFile();
  const runners = createRunners({ execFile: fake });
  const p = runners.gitRun(['status'], 'C:\\repo');
  const err = new Error('spawn git ENOENT');
  err.code = 'ENOENT';
  fake.calls[0].cb(err, '', '');
  await assert.rejects(p, /ENOENT/);
});

test('gitRun: code!=0 (не ENOENT, напр. "not a git repository") → resolve с числовым code, НЕ reject, дерево НЕ добивается (Minor 6, ревью раунд 1)', async () => {
  const fake = makeFakeExecFile();
  const runners = createRunners({ execFile: fake });
  const p = runners.gitRun(['status', '--porcelain=v1', '-b'], 'C:\\not-a-repo');
  const err = new Error('exit 1');
  err.code = 1; // штатный код (не убийство по таймауту) — именно тот сценарий, что Minor 6 просит покрыть явно
  fake.calls[0].cb(err, '', 'fatal: not a git repository\n');
  const res = await p;
  assert.deepStrictEqual(res, { code: 1, stdout: '', stderr: 'fatal: not a git repository\n' });
  // Каждый git:get на репозитории без .git штатно получает именно этот код —
  // без этой проверки регрессия killTreeOnTimeout (if(err) вместо
  // if(err&&err.killed)) начала бы спавнить лишний taskkill по мёртвому pid
  // на КАЖДОЕ такое обновление панели, и тест остался бы зелёным.
  assert.strictEqual(fake.calls.length, 1, 'обычный code!=0 не должен вызывать killProcessTree');
});

test('gitRun: err.code не число (сигнал/таймаут) → code:1 по умолчанию', async () => {
  const fake = makeFakeExecFile();
  const runners = createRunners({ execFile: fake });
  const p = runners.gitRun(['diff', 'HEAD'], 'C:\\repo');
  const err = new Error('killed');
  err.killed = true;
  err.code = null;
  err.signal = 'SIGTERM';
  fake.calls[0].cb(err, '', '');
  const res = await p;
  assert.strictEqual(res.code, 1);
});

// -------------------------------------------------------------------- ghRun --

test('ghRun зовёт execFile("gh", args, {cwd, windowsHide:true, timeout:30000, maxBuffer, shell:true}, cb)', async () => {
  const fake = makeFakeExecFile();
  const runners = createRunners({ execFile: fake });
  const p = runners.ghRun(['repo', 'view', '--json', 'nameWithOwner'], 'C:\\repo');
  const call = fake.calls[0];
  assert.strictEqual(call.cmd, 'gh');
  assert.strictEqual(call.options.cwd, 'C:\\repo');
  assert.strictEqual(call.options.shell, true, 'gh.exe может быть шимом на некоторых установках — shell:true обязателен');
  assert.strictEqual(call.options.timeout, 30000);
  assert.strictEqual(call.options.maxBuffer, 5 * 1024 * 1024);
  call.cb(null, '{}', '');
  const res = await p;
  assert.deepStrictEqual(res, { code: 0, stdout: '{}', stderr: '' });
});

test('ghRun без cwd (getGlobal не привязан к репозиторию) — options.cwd undefined, не бросает', async () => {
  const fake = makeFakeExecFile();
  const runners = createRunners({ execFile: fake });
  const p = runners.ghRun(['search', 'prs', '--author=@me']);
  const call = fake.calls[0];
  assert.strictEqual(call.options.cwd, undefined);
  call.cb(null, '[]', '');
  const res = await p;
  assert.deepStrictEqual(res, { code: 0, stdout: '[]', stderr: '' });
});

test('ghRun: ENOENT → reject (gh не установлен)', async () => {
  const fake = makeFakeExecFile();
  const runners = createRunners({ execFile: fake });
  const p = runners.ghRun(['repo', 'view'], 'C:\\repo');
  const err = new Error('spawn gh ENOENT');
  err.code = 'ENOENT';
  fake.calls[0].cb(err, '', '');
  await assert.rejects(p, /ENOENT/);
});

test('ghRun: code!=0 (напр. не авторизован) → resolve с кодом, НЕ reject, дерево НЕ добивается (Minor 6, ревью раунд 1)', async () => {
  const fake = makeFakeExecFile();
  const runners = createRunners({ execFile: fake });
  const p = runners.ghRun(['pr', 'status'], 'C:\\repo');
  const err = new Error('exit 4');
  err.code = 4; // штатный код (не убийство по таймауту)
  fake.calls[0].cb(err, '', 'gh auth login\n');
  const res = await p;
  assert.deepStrictEqual(res, { code: 4, stdout: '', stderr: 'gh auth login\n' });
  assert.strictEqual(fake.calls.length, 1, 'обычный code!=0 не должен вызывать killProcessTree');
});

// -------------------------------------------------------------- killAllTracked --

test('killAllTracked убивает все текущие живые pid реестра (сценарий disposeSessions на выходе из приложения)', () => {
  const fake = makeFakeExecFile();
  const runners = createRunners({ execFile: fake });
  runners.runCcusage(['a']);
  runners.gitRun(['status'], 'C:\\r');
  // cb ни разу не звался — оба child всё ещё "выполняются", ровно случай
  // закрытия приложения, пока помощники ещё висят.
  assert.strictEqual(runners.liveChildren.size, 2);
  const callsBefore = fake.calls.length;
  runners.killAllTracked();
  const taskkillCalls = fake.calls.slice(callsBefore);
  assert.strictEqual(taskkillCalls.length, 2);
  assert.ok(taskkillCalls.every((c) => c.cmd === 'taskkill'));
});

test('killAllTracked на пустом реестре — no-op, execFile не зовётся', () => {
  const fake = makeFakeExecFile();
  const runners = createRunners({ execFile: fake });
  runners.killAllTracked();
  assert.strictEqual(fake.calls.length, 0);
});
