'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createGitInfo } = require('../src/main/git-info');

// Реальные образцы (сняты 28.07 на claude-cockpit, git 2.54.0.windows.1,
// зафиксированы в отчёте задачи task-1-report.md):
//
//   git -c core.quotepath=false status --porcelain=v1 -b
//     ## main...origin/main [ahead 1]
//     ## tmp-local-fixture...tmp-upstream-fixture [ahead 1, behind 1]
//     ## tmp-behind-local...tmp-behind-upstream [behind 1]
//     ## tmp-no-upstream-test                       (нет upstream)
//     ## HEAD (no branch)                           (detached HEAD)
//     ## No commits yet on main                     (свежий репозиторий)
//      D src/main/notify.js
//      M src/main/paths.js
//     RM src/main/toasts.js -> src/main/toasts-renamed.js
//     A  tmp-staged-new.txt
//     ?? src/main/тест-кириллица.js                 (сырой UTF-8, НЕ квотится)
//     ?? "tmp file with spaces.txt"                  (квотится из-за пробела —
//                                                      это отдельное от
//                                                      core.quotepath правило)
//
//   git -c core.quotepath=false diff --numstat HEAD
//     0	24	src/main/notify.js
//     1	0	src/main/paths.js
//     1	0	src/main/{toasts.js => toasts-renamed.js}
//     -	-	tmp-binary.bin
//
//   git -c core.quotepath=false diff HEAD
//     diff --git a/src/main/paths.js b/src/main/paths.js
//     index 8343da4..e84a0b4 100644
//     --- a/src/main/paths.js
//     +++ b/src/main/paths.js
//     @@ -26,3 +26,4 @@ function appRoot() {
//      }
//      module.exports = { appRoot };
//     +// tmp edit

function ok(stdout, stderr = '') {
  return { code: 0, stdout, stderr };
}

function fail(stderr, code = 128) {
  return { code, stdout: '', stderr };
}

// Фейковый run(args, cwd): различает три вызова по содержимому args, как
// runFixture в usage-ccusage.test.js различает 'daily'/'session'.
function runFixture({ status, numstat, diff, calls } = {}) {
  return async (args, cwd) => {
    if (calls) calls.push({ args, cwd });
    // Каждый вызов ОБЯЗАН нести -c core.quotepath=false — жёсткое требование.
    assert.strictEqual(args[0], '-c');
    assert.strictEqual(args[1], 'core.quotepath=false');
    if (args.includes('--numstat')) return numstat !== undefined ? numstat : ok('');
    if (args.includes('status')) return status !== undefined ? status : ok('## main');
    if (args.includes('diff')) return diff !== undefined ? diff : ok('');
    throw new Error(`неожиданные args в run(): ${JSON.stringify(args)}`);
  };
}

function noCache() {
  return new Map();
}

test('branch header: ahead+behind разбирается верно (реальный образец)', async () => {
  const info = createGitInfo({
    run: runFixture({ status: ok('## tmp-local-fixture...tmp-upstream-fixture [ahead 1, behind 1]\n') }),
    cache: noCache(),
    now: () => 1,
  });
  const snap = await info.get('C:\\repo');
  assert.strictEqual(snap.ok, true);
  assert.strictEqual(snap.isRepo, true);
  assert.strictEqual(snap.branch, 'tmp-local-fixture');
  assert.strictEqual(snap.ahead, 1);
  assert.strictEqual(snap.behind, 1);
});

test('branch header: только ahead (реальный образец main...origin/main)', async () => {
  const info = createGitInfo({
    run: runFixture({ status: ok('## main...origin/main [ahead 1]\n') }),
    cache: noCache(),
    now: () => 1,
  });
  const snap = await info.get('C:\\repo');
  assert.strictEqual(snap.branch, 'main');
  assert.strictEqual(snap.ahead, 1);
  assert.strictEqual(snap.behind, 0);
});

test('branch header: только behind (реальный образец)', async () => {
  const info = createGitInfo({
    run: runFixture({ status: ok('## tmp-behind-local...tmp-behind-upstream [behind 1]\n') }),
    cache: noCache(),
    now: () => 1,
  });
  const snap = await info.get('C:\\repo');
  assert.strictEqual(snap.branch, 'tmp-behind-local');
  assert.strictEqual(snap.ahead, 0);
  assert.strictEqual(snap.behind, 1);
});

test('branch header: без upstream — просто имя ветки, ahead/behind = 0', async () => {
  const info = createGitInfo({
    run: runFixture({ status: ok('## tmp-no-upstream-test\n') }),
    cache: noCache(),
    now: () => 1,
  });
  const snap = await info.get('C:\\repo');
  assert.strictEqual(snap.branch, 'tmp-no-upstream-test');
  assert.strictEqual(snap.ahead, 0);
  assert.strictEqual(snap.behind, 0);
});

test('branch header: detached HEAD → branch:null', async () => {
  const info = createGitInfo({
    run: runFixture({ status: ok('## HEAD (no branch)\n') }),
    cache: noCache(),
    now: () => 1,
  });
  const snap = await info.get('C:\\repo');
  assert.strictEqual(snap.ok, true);
  assert.strictEqual(snap.isRepo, true);
  assert.strictEqual(snap.branch, null);
  assert.strictEqual(snap.ahead, 0);
  assert.strictEqual(snap.behind, 0);
});

test('branch header: свежий репозиторий без коммитов ("No commits yet on X")', async () => {
  const info = createGitInfo({
    run: runFixture({ status: ok('## No commits yet on main\n') }),
    cache: noCache(),
    now: () => 1,
  });
  const snap = await info.get('C:\\repo');
  assert.strictEqual(snap.ok, true);
  assert.strictEqual(snap.isRepo, true);
  assert.strictEqual(snap.branch, 'main');
  assert.strictEqual(snap.ahead, 0);
  assert.strictEqual(snap.behind, 0);
});

test('файлы: базовые статусы (M/D/A/??) и staged корректно проставлены', async () => {
  const statusOut = [
    '## main...origin/main [ahead 1]',
    ' D src/main/notify.js',
    ' M src/main/paths.js',
    'A  tmp-staged-new.txt',
    '?? tmp-untracked.txt',
    '',
  ].join('\n');
  const info = createGitInfo({
    run: runFixture({ status: ok(statusOut) }),
    cache: noCache(),
    now: () => 1,
  });
  const snap = await info.get('C:\\repo');
  const byPath = Object.fromEntries(snap.files.map((f) => [f.path, f]));
  assert.strictEqual(byPath['src/main/notify.js'].status, 'D');
  assert.strictEqual(byPath['src/main/notify.js'].staged, false);
  assert.strictEqual(byPath['src/main/paths.js'].status, 'M');
  assert.strictEqual(byPath['src/main/paths.js'].staged, false);
  assert.strictEqual(byPath['tmp-staged-new.txt'].status, 'A');
  assert.strictEqual(byPath['tmp-staged-new.txt'].staged, true);
  assert.strictEqual(byPath['tmp-untracked.txt'].status, '?');
  assert.strictEqual(byPath['tmp-untracked.txt'].staged, false);
  assert.strictEqual(snap.files.length, 4);
});

test('переименование: "RM old -> new" → путь берётся НОВЫЙ, статус R, staged true (реальный образец)', async () => {
  const statusOut = '## main\nRM src/main/toasts.js -> src/main/toasts-renamed.js\n';
  const info = createGitInfo({
    run: runFixture({ status: ok(statusOut) }),
    cache: noCache(),
    now: () => 1,
  });
  const snap = await info.get('C:\\repo');
  assert.strictEqual(snap.files.length, 1);
  assert.strictEqual(snap.files[0].path, 'src/main/toasts-renamed.js');
  assert.strictEqual(snap.files[0].status, 'R');
  assert.strictEqual(snap.files[0].staged, true);
});

test('переименование без доп. изменений: "R  old -> new" (staged, без worktree-модификации)', async () => {
  const statusOut = '## main\nR  a.js -> b.js\n';
  const info = createGitInfo({
    run: runFixture({ status: ok(statusOut) }),
    cache: noCache(),
    now: () => 1,
  });
  const snap = await info.get('C:\\repo');
  assert.strictEqual(snap.files[0].path, 'b.js');
  assert.strictEqual(snap.files[0].status, 'R');
  assert.strictEqual(snap.files[0].staged, true);
});

test('кириллический путь: приходит сырым UTF-8, не квотится, не экранируется (реальный образец)', async () => {
  const statusOut = '## main\n?? src/main/тест-кириллица.js\n';
  const info = createGitInfo({
    run: runFixture({ status: ok(statusOut) }),
    cache: noCache(),
    now: () => 1,
  });
  const snap = await info.get('C:\\repo');
  assert.strictEqual(snap.files.length, 1);
  assert.strictEqual(snap.files[0].path, 'src/main/тест-кириллица.js');
  assert.strictEqual(snap.files[0].status, '?');
});

test('путь с пробелом: git status квотит его в "...", unquote убирает кавычки (реальный образец)', async () => {
  const statusOut = '## main\n?? "tmp file with spaces.txt"\n';
  const info = createGitInfo({
    run: runFixture({ status: ok(statusOut) }),
    cache: noCache(),
    now: () => 1,
  });
  const snap = await info.get('C:\\repo');
  assert.strictEqual(snap.files[0].path, 'tmp file with spaces.txt');
});

test('переименование с кавычками с обеих сторон (кириллица+пробел, реальный образец)', async () => {
  const statusOut = '## main\nR  "a b.txt" -> "новый файл.txt"\n';
  const info = createGitInfo({
    run: runFixture({ status: ok(statusOut) }),
    cache: noCache(),
    now: () => 1,
  });
  const snap = await info.get('C:\\repo');
  assert.strictEqual(snap.files[0].path, 'новый файл.txt');
});

test('unmerged/conflict коды (UU, AA, DD, AU, UD, UA, DU) → status:"U"', async () => {
  const codes = ['UU', 'AA', 'DD', 'AU', 'UD', 'UA', 'DU'];
  const statusOut = ['## main', ...codes.map((c, i) => `${c} conflict-${i}.txt`), ''].join('\n');
  const info = createGitInfo({
    run: runFixture({ status: ok(statusOut) }),
    cache: noCache(),
    now: () => 1,
  });
  const snap = await info.get('C:\\repo');
  assert.strictEqual(snap.files.length, codes.length);
  for (const f of snap.files) assert.strictEqual(f.status, 'U');
});

test('numstat: added/removed приписываются к файлам по пути (реальный образец)', async () => {
  const statusOut = ['## main', ' D src/main/notify.js', ' M src/main/paths.js', ''].join('\n');
  const numstatOut = ['0\t24\tsrc/main/notify.js', '1\t0\tsrc/main/paths.js', ''].join('\n');
  const info = createGitInfo({
    run: runFixture({ status: ok(statusOut), numstat: ok(numstatOut) }),
    cache: noCache(),
    now: () => 1,
  });
  const snap = await info.get('C:\\repo');
  const byPath = Object.fromEntries(snap.files.map((f) => [f.path, f]));
  assert.deepStrictEqual([byPath['src/main/notify.js'].added, byPath['src/main/notify.js'].removed], [0, 24]);
  assert.deepStrictEqual([byPath['src/main/paths.js'].added, byPath['src/main/paths.js'].removed], [1, 0]);
});

test('numstat: переименование в скобочной нотации "{old => new}" резолвится в новый путь и матчится с status (реальный образец)', async () => {
  const statusOut = '## main\nRM src/main/toasts.js -> src/main/toasts-renamed.js\n';
  const numstatOut = '1\t0\tsrc/main/{toasts.js => toasts-renamed.js}\n';
  const info = createGitInfo({
    run: runFixture({ status: ok(statusOut), numstat: ok(numstatOut) }),
    cache: noCache(),
    now: () => 1,
  });
  const snap = await info.get('C:\\repo');
  assert.strictEqual(snap.files[0].path, 'src/main/toasts-renamed.js');
  assert.strictEqual(snap.files[0].added, 1);
  assert.strictEqual(snap.files[0].removed, 0);
});

test('numstat: переименование без общего префикса ("old => new" без скобок, реальный образец)', async () => {
  const statusOut = '## main\nR  "a b.txt" -> "новый файл 2.txt"\n';
  const numstatOut = '0\t0\ta b.txt => новый файл 2.txt\n';
  const info = createGitInfo({
    run: runFixture({ status: ok(statusOut), numstat: ok(numstatOut) }),
    cache: noCache(),
    now: () => 1,
  });
  const snap = await info.get('C:\\repo');
  assert.strictEqual(snap.files[0].path, 'новый файл 2.txt');
  assert.strictEqual(snap.files[0].added, 0);
  assert.strictEqual(snap.files[0].removed, 0);
});

test('numstat: бинарный файл ("-\\t-\\tpath") → added/removed = 0, не NaN (реальный образец)', async () => {
  const statusOut = '## main\nA  tmp-binary.bin\n';
  const numstatOut = '-\t-\ttmp-binary.bin\n';
  const info = createGitInfo({
    run: runFixture({ status: ok(statusOut), numstat: ok(numstatOut) }),
    cache: noCache(),
    now: () => 1,
  });
  const snap = await info.get('C:\\repo');
  assert.strictEqual(snap.files[0].added, 0);
  assert.strictEqual(snap.files[0].removed, 0);
});

test('файл без совпадения в numstat (например ?? untracked) → added/removed остаются 0', async () => {
  const statusOut = '## main\n?? tmp-untracked.txt\n';
  const info = createGitInfo({
    run: runFixture({ status: ok(statusOut), numstat: ok('') }),
    cache: noCache(),
    now: () => 1,
  });
  const snap = await info.get('C:\\repo');
  assert.strictEqual(snap.files[0].added, 0);
  assert.strictEqual(snap.files[0].removed, 0);
});

test('diff: текст unified-диффа возвращается как есть, когда лимиты не превышены (реальный образец)', async () => {
  const diffText = [
    'diff --git a/src/main/paths.js b/src/main/paths.js',
    'index 8343da4..e84a0b4 100644',
    '--- a/src/main/paths.js',
    '+++ b/src/main/paths.js',
    '@@ -26,3 +26,4 @@ function appRoot() {',
    ' }',
    ' module.exports = { appRoot };',
    '+// tmp edit',
    '',
  ].join('\n');
  const info = createGitInfo({
    run: runFixture({ status: ok('## main\n M src/main/paths.js\n'), diff: ok(diffText) }),
    cache: noCache(),
    now: () => 1,
  });
  const snap = await info.get('C:\\repo');
  assert.strictEqual(snap.diff, diffText);
  assert.strictEqual(snap.truncated, null);
});

test('не в репозитории: code!=0 + "not a git repository" в stderr → ok:true, isRepo:false, error:not-a-repo; numstat/diff НЕ вызываются', async () => {
  const calls = [];
  const info = createGitInfo({
    run: runFixture({
      status: fail('fatal: not a git repository (or any of the parent directories): .git'),
      calls,
    }),
    cache: noCache(),
    now: () => 1,
  });
  const snap = await info.get('C:\\not-a-repo');
  assert.strictEqual(snap.ok, true);
  assert.strictEqual(snap.isRepo, false);
  assert.strictEqual(snap.error, 'not-a-repo');
  assert.strictEqual(snap.files.length, 0);
  assert.strictEqual(calls.length, 1, 'diff/numstat не должны вызываться, если это не репозиторий');
});

test('отсутствие git (ENOENT из run) → ok:false, error:git-missing, не бросает наружу', async () => {
  const info = createGitInfo({
    run: async () => { const err = new Error('spawn git ENOENT'); err.code = 'ENOENT'; throw err; },
    cache: noCache(),
    now: () => 1,
  });
  const snap = await info.get('C:\\repo');
  assert.strictEqual(snap.ok, false);
  assert.strictEqual(snap.isRepo, false);
  assert.strictEqual(snap.error, 'git-missing');
});

test('git-missing кэшируется НАДОЛГО: повторный вызов через 5с (дольше обычного ttlMs=3000) НЕ зовёт run снова', async () => {
  let calls = 0;
  let t = 0;
  const run = async () => { calls++; const err = new Error('ENOENT'); err.code = 'ENOENT'; throw err; };
  const info = createGitInfo({ run, cache: noCache(), now: () => t });

  await info.get('C:\\repo');
  assert.strictEqual(calls, 1);

  t = 5000; // дольше дефолтного ttlMs (3000), но короче долгого git-missing TTL
  const snap = await info.get('C:\\repo');
  assert.strictEqual(calls, 1, 'run() не должен был вызваться повторно так скоро после git-missing');
  assert.strictEqual(snap.error, 'git-missing');
});

test('git-missing: force:true всё равно вызывает run() заново', async () => {
  let calls = 0;
  const run = async () => { calls++; const err = new Error('ENOENT'); err.code = 'ENOENT'; throw err; };
  const info = createGitInfo({ run, cache: noCache(), now: () => 1 });

  await info.get('C:\\repo');
  await info.get('C:\\repo', { force: true });
  assert.strictEqual(calls, 2);
});

test('прочий сбой status (code!=0, текст не про "not a git repository") → ok:false, error:failed', async () => {
  const info = createGitInfo({
    run: runFixture({ status: fail('fatal: something else entirely broke') }),
    cache: noCache(),
    now: () => 1,
  });
  const snap = await info.get('C:\\repo');
  assert.strictEqual(snap.ok, false);
  assert.strictEqual(snap.error, 'failed');
});

test('обрезка по числу файлов: >200 файлов → files.length===200, truncated.files = фактическое число скрытых', async () => {
  const lines = ['## main'];
  for (let i = 0; i < 250; i++) lines.push(`?? file-${i}.txt`);
  const info = createGitInfo({
    run: runFixture({ status: ok(lines.join('\n') + '\n') }),
    cache: noCache(),
    now: () => 1,
  });
  const snap = await info.get('C:\\repo');
  assert.strictEqual(snap.files.length, 200);
  assert.ok(snap.truncated);
  assert.strictEqual(snap.truncated.files, 50);
  assert.strictEqual(snap.truncated.lines, 0);
});

test('обрезка по числу строк диффа: >2000 строк → diff содержит первые 2000, truncated.lines = фактическое число скрытых', async () => {
  const diffLines = [];
  for (let i = 0; i < 2500; i++) diffLines.push(`+line ${i}`);
  const diffText = diffLines.join('\n') + '\n';
  const info = createGitInfo({
    run: runFixture({ status: ok('## main\n M x.js\n'), diff: ok(diffText) }),
    cache: noCache(),
    now: () => 1,
  });
  const snap = await info.get('C:\\repo');
  const resultLines = snap.diff.split('\n');
  assert.strictEqual(resultLines.length, 2000);
  assert.strictEqual(resultLines[0], '+line 0');
  assert.strictEqual(resultLines[1999], '+line 1999');
  assert.ok(snap.truncated);
  assert.strictEqual(snap.truncated.lines, 500);
  assert.strictEqual(snap.truncated.files, 0);
});

test('без превышения лимитов → truncated:null', async () => {
  const info = createGitInfo({
    run: runFixture({ status: ok('## main\n M x.js\n'), diff: ok('diff --git a/x.js b/x.js\n') }),
    cache: noCache(),
    now: () => 1,
  });
  const snap = await info.get('C:\\repo');
  assert.strictEqual(snap.truncated, null);
});

// Один успешный fetchFresh() бьёт по run() трижды (status + numstat + diff),
// поэтому ниже сравниваем РОСТ calls.length относительно этого шага, а не
// абсолютные числа — так тест не завязан на внутреннее количество команд.
test('TTL: второй вызов внутри ttlMs не зовёт run() повторно, отдаёт тот же результат', async () => {
  const calls = [];
  let t = 1000;
  const info = createGitInfo({
    run: runFixture({ status: ok('## main [ahead 1]\n'), calls }),
    cache: noCache(),
    now: () => t,
    ttlMs: 3000,
  });
  const first = await info.get('C:\\repo');
  const callsAfterFirst = calls.length;
  t += 1000; // моложе ttlMs
  const second = await info.get('C:\\repo');
  assert.strictEqual(calls.length, callsAfterFirst, 'второй get() внутри TTL не должен был звать run()');
  assert.deepStrictEqual(second, first);
});

test('TTL: вызов ПОСЛЕ истечения ttlMs зовёт run() заново', async () => {
  const calls = [];
  let t = 1000;
  const info = createGitInfo({
    run: runFixture({ status: ok('## main\n'), calls }),
    cache: noCache(),
    now: () => t,
    ttlMs: 3000,
  });
  await info.get('C:\\repo');
  const callsAfterFirst = calls.length;
  t += 3001; // строго старше ttl
  await info.get('C:\\repo');
  assert.strictEqual(calls.length, callsAfterFirst * 2, 'run() должен был вызваться заново после истечения TTL');
});

test('force:true игнорирует свежесть TTL и зовёт run() заново', async () => {
  const calls = [];
  const info = createGitInfo({
    run: runFixture({ status: ok('## main\n'), calls }),
    cache: noCache(),
    now: () => 1,
    ttlMs: 3000,
  });
  await info.get('C:\\repo');
  const callsAfterFirst = calls.length;
  await info.get('C:\\repo', { force: true });
  assert.strictEqual(calls.length, callsAfterFirst * 2, 'force:true должен был вызвать run() заново несмотря на свежий кэш');
});

test('кэш ведётся ПО CWD: разные пути не делят кэш друг с другом', async () => {
  const calls = [];
  const info = createGitInfo({
    run: runFixture({ status: ok('## main\n'), calls }),
    cache: noCache(),
    now: () => 1,
  });
  await info.get('C:\\repo-a');
  const callsAfterFirst = calls.length;
  await info.get('C:\\repo-b');
  const callsAfterSecond = calls.length;
  await info.get('C:\\repo-a'); // всё ещё свежий кэш repo-a
  assert.strictEqual(callsAfterSecond, callsAfterFirst * 2, 'новый cwd должен был вызвать run() заново');
  assert.strictEqual(calls.length, callsAfterSecond, 'повторный get() для repo-a внутри TTL не должен был звать run()');
});

test('каждый вызов run() несёт "-c core.quotepath=false" первыми двумя аргументами (status/numstat/diff)', async () => {
  const calls = [];
  const info = createGitInfo({
    run: runFixture({ status: ok(' M x.js\n## main\n'), calls }),
    cache: noCache(),
    now: () => 1,
  });
  await info.get('C:\\repo');
  assert.ok(calls.length >= 1);
  for (const c of calls) {
    assert.strictEqual(c.args[0], '-c');
    assert.strictEqual(c.args[1], 'core.quotepath=false');
  }
});

test('свежий репозиторий без коммитов: diff/numstat падают с code!=0 (нет HEAD) → деградация в пустой дифф, а не ok:false', async () => {
  const info = createGitInfo({
    run: runFixture({
      status: ok('## No commits yet on main\nA  new.txt\n'),
      numstat: fail("fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree."),
      diff: fail("fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree."),
    }),
    cache: noCache(),
    now: () => 1,
  });
  const snap = await info.get('C:\\repo');
  assert.strictEqual(snap.ok, true);
  assert.strictEqual(snap.isRepo, true);
  assert.strictEqual(snap.branch, 'main');
  assert.strictEqual(snap.diff, '');
  assert.strictEqual(snap.files[0].added, 0);
  assert.strictEqual(snap.files[0].removed, 0);
});

test('run() бросает неожиданное исключение (не ENOENT) на status → ok:false, error:failed, не бросает наружу', async () => {
  const info = createGitInfo({
    run: async () => { throw new Error('какой-то другой сбой'); },
    cache: noCache(),
    now: () => 1,
  });
  const snap = await info.get('C:\\repo');
  assert.strictEqual(snap.ok, false);
  assert.strictEqual(snap.error, 'failed');
});

test('форма результата: fetchedAt проставлен из now()', async () => {
  const info = createGitInfo({
    run: runFixture({ status: ok('## main\n') }),
    cache: noCache(),
    now: () => 424242,
  });
  const snap = await info.get('C:\\repo');
  assert.strictEqual(snap.fetchedAt, 424242);
});
