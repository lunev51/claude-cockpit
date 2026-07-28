'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createGhInfo } = require('../src/main/gh-info');

// Реальные образцы (сняты 28.07.2026, gh version 2.94.0, аккаунт lunev51;
// полный протокол — в task-3-report.md):
//
//   gh pr status --json number,title,state,isDraft,statusCheckRollup,reviewDecision,url
//     (ветка phase6-insight в claude-cockpit, БЕЗ своего PR):
//     {"createdBy":[],"needsReview":[]}                 (ключ currentBranch
//                                                         отсутствует вовсе)
//
//   gh repo view --json nameWithOwner
//     {"nameWithOwner":"lunev51/claude-cockpit"}
//
//   gh pr list --repo cli/cli --limit 1 --json number,title,state,isDraft,statusCheckRollup,reviewDecision,url
//     (форма currentBranch, когда PR есть; поле statusCheckRollup сокращено
//     до 2 элементов ради читаемости — полный образец из 18 элементов см.
//     task-3-report.md):
//     {"number":13982,"title":"Add --latest-pre-release and --pin flags to gh extension upgrade",
//      "state":"OPEN","isDraft":false,"reviewDecision":"CHANGES_REQUESTED",
//      "url":"https://github.com/cli/cli/pull/13982"}
//     PR #13957 того же репозитория: reviewDecision:"" (пустая строка, не null)
//
//   statusCheckRollup — реальные значения:
//     cli/cli #13982: conclusion SUCCESS/SKIPPED, status COMPLETED (пройден)
//     cli/cli #13788: среди прочих conclusion:"FAILURE" (провален)
//     vscode #327769: status:"IN_PROGRESS", conclusion:"" (в процессе)
//     vscode #327675: conclusion:"ACTION_REQUIRED" (трактуем как провал)
//
//   gh search prs --author=@me --state=open --json repository,number,title,url --limit 20
//     [] (0 открытых PR у пользователя на момент снятия образца)
//     форма repository (снята с --repo=cli/cli): {"name":"cli","nameWithOwner":"cli/cli"}
//   gh search issues --assignee=@me --state=open --json repository,number,title,url --limit 20
//     []
//   gh api notifications --jq length
//     0
//
//   Деградация (реальные фикстуры, коды возврата):
//     не git-репозиторий вообще (код 1): "failed to run git: fatal: not a
//       git repository (or any of the parent directories): .git"
//     git-репозиторий БЕЗ remote (код 1): "no git remotes found"
//     не авторизован (код 4, снято через GH_CONFIG_DIR на пустой каталог):
//       "To get started with GitHub CLI, please run:  gh auth login\n
//        Alternatively, populate the GH_TOKEN environment variable..."

function ok(stdout, stderr = '') {
  return { code: 0, stdout, stderr };
}

function fail(stderr, code = 1) {
  return { code, stdout: '', stderr };
}

const PASSING_ROLLUP = [
  { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS', name: 'CodeQL-Build (go)', workflowName: 'Code Scanning' },
  { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SKIPPED', name: 'close-from-default-branch / close-from-default-branch', workflowName: 'PR Triaging' },
];

const FAILING_ROLLUP = [
  { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS', name: 'build', workflowName: 'CI' },
  { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE', name: 'lint', workflowName: 'CI' },
];

const PENDING_ROLLUP = [
  { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS', name: 'build (linux)', workflowName: 'CI' },
  { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: '', name: 'build (windows)', workflowName: 'CI' },
];

const ACTION_REQUIRED_ROLLUP = [
  { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS', name: 'build', workflowName: 'CI' },
  { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'ACTION_REQUIRED', name: 'deploy', workflowName: 'CD' },
];

// Фейковый run(args, cwd): различает вызовы по первым двум элементам args,
// как runFixture в git-info.test.js различает status/numstat/diff.
function runFixture({ repoView, prStatus, searchPrs, searchIssues, notifications, prView, calls } = {}) {
  return async (args, cwd) => {
    if (calls) calls.push({ args, cwd });
    if (args[0] === 'repo' && args[1] === 'view') {
      return repoView !== undefined ? repoView : ok('{"nameWithOwner":"lunev51/claude-cockpit"}');
    }
    if (args[0] === 'pr' && args[1] === 'status') {
      return prStatus !== undefined ? prStatus : ok('{"createdBy":[],"needsReview":[]}');
    }
    if (args[0] === 'search' && args[1] === 'prs') {
      return searchPrs !== undefined ? searchPrs : ok('[]');
    }
    if (args[0] === 'search' && args[1] === 'issues') {
      return searchIssues !== undefined ? searchIssues : ok('[]');
    }
    if (args[0] === 'api' && args[1] === 'notifications') {
      return notifications !== undefined ? notifications : ok('0');
    }
    if (args[0] === 'pr' && args[1] === 'view') {
      if (typeof prView === 'function') return prView(args, cwd);
      return prView !== undefined ? prView : ok('{"statusCheckRollup":[]}');
    }
    throw new Error(`неожиданные args в run(): ${JSON.stringify(args)}`);
  };
}

function noCache() {
  return new Map();
}

// ---------------------------------------------------------------- getRepo --

test('getRepo: реальный образец — ветка без своего PR → ok:true, error:null, repo заполнен, pr:null', async () => {
  const info = createGhInfo({
    run: runFixture({
      repoView: ok('{"nameWithOwner":"lunev51/claude-cockpit"}'),
      prStatus: ok('{"createdBy":[],"needsReview":[]}'),
    }),
    cache: noCache(),
    now: () => 1,
  });
  const snap = await info.getRepo('C:\\repo');
  assert.strictEqual(snap.ok, true);
  assert.strictEqual(snap.error, null);
  assert.strictEqual(snap.repo, 'lunev51/claude-cockpit');
  assert.strictEqual(snap.pr, null);
});

test('getRepo: PR есть (образец currentBranch из cli/cli #13982) → pr заполнен, checks:passing', async () => {
  const currentBranch = {
    number: 13982,
    title: 'Add --latest-pre-release and --pin flags to gh extension upgrade',
    state: 'OPEN',
    isDraft: false,
    reviewDecision: 'CHANGES_REQUESTED',
    url: 'https://github.com/cli/cli/pull/13982',
    statusCheckRollup: PASSING_ROLLUP,
  };
  const info = createGhInfo({
    run: runFixture({
      prStatus: ok(JSON.stringify({ currentBranch, createdBy: [], needsReview: [] })),
    }),
    cache: noCache(),
    now: () => 1,
  });
  const snap = await info.getRepo('C:\\repo');
  assert.strictEqual(snap.ok, true);
  assert.deepStrictEqual(snap.pr, {
    number: 13982,
    title: 'Add --latest-pre-release and --pin flags to gh extension upgrade',
    state: 'OPEN',
    isDraft: false,
    checks: 'passing',
    reviewDecision: 'CHANGES_REQUESTED',
    url: 'https://github.com/cli/cli/pull/13982',
  });
});

test('getRepo: reviewDecision пустая строка (реальный образец PR #13957) → нормализуется в null', async () => {
  const currentBranch = {
    number: 13957, title: 't', state: 'OPEN', isDraft: false,
    reviewDecision: '', url: 'https://github.com/cli/cli/pull/13957', statusCheckRollup: [],
  };
  const info = createGhInfo({
    run: runFixture({ prStatus: ok(JSON.stringify({ currentBranch })) }),
    cache: noCache(),
    now: () => 1,
  });
  const snap = await info.getRepo('C:\\repo');
  assert.strictEqual(snap.pr.reviewDecision, null);
});

test('checks: все успешны (SUCCESS/SKIPPED, реальный образец cli/cli #13982) → passing', async () => {
  const currentBranch = { number: 1, title: 't', state: 'OPEN', isDraft: false, reviewDecision: null, url: 'u', statusCheckRollup: PASSING_ROLLUP };
  const info = createGhInfo({ run: runFixture({ prStatus: ok(JSON.stringify({ currentBranch })) }), cache: noCache(), now: () => 1 });
  const snap = await info.getRepo('C:\\repo');
  assert.strictEqual(snap.pr.checks, 'passing');
});

test('checks: есть FAILURE (реальный образец cli/cli #13788) → failing', async () => {
  const currentBranch = { number: 1, title: 't', state: 'OPEN', isDraft: false, reviewDecision: null, url: 'u', statusCheckRollup: FAILING_ROLLUP };
  const info = createGhInfo({ run: runFixture({ prStatus: ok(JSON.stringify({ currentBranch })) }), cache: noCache(), now: () => 1 });
  const snap = await info.getRepo('C:\\repo');
  assert.strictEqual(snap.pr.checks, 'failing');
});

test('checks: ACTION_REQUIRED (реальный образец vscode #327675) → трактуется как failing', async () => {
  const currentBranch = { number: 1, title: 't', state: 'OPEN', isDraft: false, reviewDecision: null, url: 'u', statusCheckRollup: ACTION_REQUIRED_ROLLUP };
  const info = createGhInfo({ run: runFixture({ prStatus: ok(JSON.stringify({ currentBranch })) }), cache: noCache(), now: () => 1 });
  const snap = await info.getRepo('C:\\repo');
  assert.strictEqual(snap.pr.checks, 'failing');
});

test('checks: есть IN_PROGRESS/conclusion:"" (реальный образец vscode #327769) → pending', async () => {
  const currentBranch = { number: 1, title: 't', state: 'OPEN', isDraft: false, reviewDecision: null, url: 'u', statusCheckRollup: PENDING_ROLLUP };
  const info = createGhInfo({ run: runFixture({ prStatus: ok(JSON.stringify({ currentBranch })) }), cache: noCache(), now: () => 1 });
  const snap = await info.getRepo('C:\\repo');
  assert.strictEqual(snap.pr.checks, 'pending');
});

test('checks: statusCheckRollup пуст/отсутствует → none', async () => {
  const currentBranch = { number: 1, title: 't', state: 'OPEN', isDraft: false, reviewDecision: null, url: 'u', statusCheckRollup: [] };
  const info = createGhInfo({ run: runFixture({ prStatus: ok(JSON.stringify({ currentBranch })) }), cache: noCache(), now: () => 1 });
  const snap = await info.getRepo('C:\\repo');
  assert.strictEqual(snap.pr.checks, 'none');

  const currentBranch2 = { number: 1, title: 't', state: 'OPEN', isDraft: false, reviewDecision: null, url: 'u' };
  const info2 = createGhInfo({ run: runFixture({ prStatus: ok(JSON.stringify({ currentBranch: currentBranch2 })) }), cache: noCache(), now: () => 1 });
  const snap2 = await info2.getRepo('C:\\repo');
  assert.strictEqual(snap2.pr.checks, 'none');
});

test('getRepo: не git-репозиторий вообще (реальная фикстура "failed to run git: ... not a git repository", код 1) → ok:true, error:no-remote', async () => {
  const info = createGhInfo({
    run: runFixture({
      repoView: fail('failed to run git: fatal: not a git repository (or any of the parent directories): .git\n'),
      prStatus: fail('failed to run git: fatal: not a git repository (or any of the parent directories): .git\n'),
    }),
    cache: noCache(),
    now: () => 1,
  });
  const snap = await info.getRepo('C:\\not-a-repo');
  assert.strictEqual(snap.ok, true);
  assert.strictEqual(snap.error, 'no-remote');
  assert.strictEqual(snap.repo, null);
  assert.strictEqual(snap.pr, null);
});

test('getRepo: git-репозиторий БЕЗ remote (реальная фикстура "no git remotes found", код 1) → ok:true, error:no-remote', async () => {
  const info = createGhInfo({
    run: runFixture({
      repoView: fail('no git remotes found\n'),
      prStatus: fail('no git remotes found\n'),
    }),
    cache: noCache(),
    now: () => 1,
  });
  const snap = await info.getRepo('C:\\repo-no-remote');
  assert.strictEqual(snap.ok, true);
  assert.strictEqual(snap.error, 'no-remote');
});

test('getRepo: gh не установлен (ENOENT из run) → ok:false, error:no-gh, не бросает наружу', async () => {
  const info = createGhInfo({
    run: async () => { const err = new Error('spawn gh ENOENT'); err.code = 'ENOENT'; throw err; },
    cache: noCache(),
    now: () => 1,
  });
  const snap = await info.getRepo('C:\\repo');
  assert.strictEqual(snap.ok, false);
  assert.strictEqual(snap.error, 'no-gh');
  assert.strictEqual(snap.repo, null);
});

test('getRepo: no-gh кэшируется НАДОЛГО: повторный вызов через 5с (дольше обычного ttlMs=3000) НЕ зовёт run снова', async () => {
  let calls = 0;
  let t = 0;
  const run = async () => { calls++; const err = new Error('ENOENT'); err.code = 'ENOENT'; throw err; };
  const info = createGhInfo({ run, cache: noCache(), now: () => t, ttlMs: 3000 });

  await info.getRepo('C:\\repo');
  const callsAfterFirst = calls;
  t = 5000; // дольше ttlMs=3000, но короче GH_MISSING_TTL_MS (10 минут)
  const snap = await info.getRepo('C:\\repo');
  assert.strictEqual(calls, callsAfterFirst, 'run() не должен был вызваться повторно так скоро после no-gh');
  assert.strictEqual(snap.error, 'no-gh');
});

test('getRepo: no-gh — force:true всё равно вызывает run() заново', async () => {
  let calls = 0;
  const run = async () => { calls++; const err = new Error('ENOENT'); err.code = 'ENOENT'; throw err; };
  const info = createGhInfo({ run, cache: noCache(), now: () => 1 });

  await info.getRepo('C:\\repo');
  const callsAfterFirst = calls;
  await info.getRepo('C:\\repo', { force: true });
  assert.ok(calls > callsAfterFirst);
});

test('getRepo: не авторизован (реальная фикстура "gh auth login" в stderr, код 4) → ok:false, error:auth', async () => {
  const authFail = fail('To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.\n', 4);
  const info = createGhInfo({
    run: runFixture({ repoView: authFail, prStatus: authFail }),
    cache: noCache(),
    now: () => 1,
  });
  const snap = await info.getRepo('C:\\repo');
  assert.strictEqual(snap.ok, false);
  assert.strictEqual(snap.error, 'auth');
});

test('getRepo: прочий сбой (code!=0, текст не про git-repo/remote/auth) → ok:false, error:failed', async () => {
  const info = createGhInfo({
    run: runFixture({ prStatus: fail('something else entirely broke') }),
    cache: noCache(),
    now: () => 1,
  });
  const snap = await info.getRepo('C:\\repo');
  assert.strictEqual(snap.ok, false);
  assert.strictEqual(snap.error, 'failed');
});

test('getRepo: run() бросает неожиданное исключение (не ENOENT) → ok:false, error:failed, не бросает наружу', async () => {
  const info = createGhInfo({
    run: async () => { throw new Error('какой-то другой сбой'); },
    cache: noCache(),
    now: () => 1,
  });
  const snap = await info.getRepo('C:\\repo');
  assert.strictEqual(snap.ok, false);
  assert.strictEqual(snap.error, 'failed');
});

test('getRepo: TTL — второй вызов внутри ttlMs не зовёт run() повторно, отдаёт тот же результат', async () => {
  const calls = [];
  let t = 1000;
  const info = createGhInfo({
    run: runFixture({ calls }),
    cache: noCache(),
    now: () => t,
    ttlMs: 3000,
  });
  const first = await info.getRepo('C:\\repo');
  const callsAfterFirst = calls.length;
  t += 1000;
  const second = await info.getRepo('C:\\repo');
  assert.strictEqual(calls.length, callsAfterFirst, 'второй getRepo() внутри TTL не должен был звать run()');
  assert.deepStrictEqual(second, first);
});

test('getRepo: TTL — вызов ПОСЛЕ истечения ttlMs зовёт run() заново', async () => {
  const calls = [];
  let t = 1000;
  const info = createGhInfo({ run: runFixture({ calls }), cache: noCache(), now: () => t, ttlMs: 3000 });
  await info.getRepo('C:\\repo');
  const callsAfterFirst = calls.length;
  t += 3001;
  await info.getRepo('C:\\repo');
  assert.strictEqual(calls.length, callsAfterFirst * 2, 'run() должен был вызваться заново после истечения TTL');
});

test('getRepo: force:true игнорирует свежесть TTL и зовёт run() заново', async () => {
  const calls = [];
  const info = createGhInfo({ run: runFixture({ calls }), cache: noCache(), now: () => 1, ttlMs: 3000 });
  await info.getRepo('C:\\repo');
  const callsAfterFirst = calls.length;
  await info.getRepo('C:\\repo', { force: true });
  assert.strictEqual(calls.length, callsAfterFirst * 2, 'force:true должен был вызвать run() заново несмотря на свежий кэш');
});

test('getRepo: кэш ведётся ПО CWD: разные пути не делят кэш друг с другом', async () => {
  const calls = [];
  const info = createGhInfo({ run: runFixture({ calls }), cache: noCache(), now: () => 1 });
  await info.getRepo('C:\\repo-a');
  const callsAfterFirst = calls.length;
  await info.getRepo('C:\\repo-b');
  const callsAfterSecond = calls.length;
  await info.getRepo('C:\\repo-a'); // всё ещё свежий кэш repo-a
  assert.strictEqual(callsAfterSecond, callsAfterFirst * 2, 'новый cwd должен был вызвать run() заново');
  assert.strictEqual(calls.length, callsAfterSecond, 'повторный getRepo() для repo-a внутри TTL не должен был звать run()');
});

test('getRepo: форма результата — fetchedAt проставлен из now()', async () => {
  const info = createGhInfo({ run: runFixture(), cache: noCache(), now: () => 424242 });
  const snap = await info.getRepo('C:\\repo');
  assert.strictEqual(snap.fetchedAt, 424242);
});

// --------------------------------------------------------------- getGlobal --

test('getGlobal: реальный образец — 0 открытых PR/issues, 0 уведомлений', async () => {
  const info = createGhInfo({
    run: runFixture({ searchPrs: ok('[]'), searchIssues: ok('[]'), notifications: ok('0') }),
    cache: noCache(),
    now: () => 1,
  });
  const snap = await info.getGlobal();
  assert.strictEqual(snap.ok, true);
  assert.strictEqual(snap.error, null);
  assert.deepStrictEqual(snap.prs, []);
  assert.deepStrictEqual(snap.issues, []);
  assert.strictEqual(snap.notifications, 0);
});

test('getGlobal: PR из search (реальная форма repository {name,nameWithOwner}) + добор checks через gh pr view', async () => {
  const searchPrsOut = JSON.stringify([
    { number: 13982, repository: { name: 'cli', nameWithOwner: 'cli/cli' }, title: 'Add --latest-pre-release and --pin flags to gh extension upgrade', url: 'https://github.com/cli/cli/pull/13982' },
  ]);
  const info = createGhInfo({
    run: runFixture({
      searchPrs: ok(searchPrsOut),
      prView: (args) => {
        assert.deepStrictEqual(args, ['pr', 'view', '13982', '--repo', 'cli/cli', '--json', 'statusCheckRollup']);
        return ok(JSON.stringify({ statusCheckRollup: PASSING_ROLLUP }));
      },
    }),
    cache: noCache(),
    now: () => 1,
  });
  const snap = await info.getGlobal();
  assert.deepStrictEqual(snap.prs, [
    { repo: 'cli/cli', number: 13982, title: 'Add --latest-pre-release and --pin flags to gh extension upgrade', checks: 'passing', url: 'https://github.com/cli/cli/pull/13982' },
  ]);
});

test('getGlobal: issues из search (реальная форма repository) разбираются в {repo,number,title,url}', async () => {
  const searchIssuesOut = JSON.stringify([
    { number: 13968, repository: { name: 'cli', nameWithOwner: 'cli/cli' }, title: 'gh extension upgrade should support upgrading to the "latest" prerelease', url: 'https://github.com/cli/cli/issues/13968' },
  ]);
  const info = createGhInfo({
    run: runFixture({ searchIssues: ok(searchIssuesOut) }),
    cache: noCache(),
    now: () => 1,
  });
  const snap = await info.getGlobal();
  assert.deepStrictEqual(snap.issues, [
    { repo: 'cli/cli', number: 13968, title: 'gh extension upgrade should support upgrading to the "latest" prerelease', url: 'https://github.com/cli/cli/issues/13968' },
  ]);
});

test('getGlobal: notifications парсится из числовой строки (gh api notifications --jq length)', async () => {
  const info = createGhInfo({
    run: runFixture({ notifications: ok('5') }),
    cache: noCache(),
    now: () => 1,
  });
  const snap = await info.getGlobal();
  assert.strictEqual(snap.notifications, 5);
});

test('getGlobal: сбой добора checks для одного PR (gh pr view упал) НЕ роняет всю выдачу — checks:"none" для этого PR', async () => {
  const searchPrsOut = JSON.stringify([
    { number: 1, repository: { name: 'r', nameWithOwner: 'me/r' }, title: 't1', url: 'u1' },
    { number: 2, repository: { name: 'r', nameWithOwner: 'me/r' }, title: 't2', url: 'u2' },
  ]);
  const info = createGhInfo({
    run: runFixture({
      searchPrs: ok(searchPrsOut),
      prView: (args) => {
        if (args[2] === '1') return fail('boom', 1);
        return ok(JSON.stringify({ statusCheckRollup: FAILING_ROLLUP }));
      },
    }),
    cache: noCache(),
    now: () => 1,
  });
  const snap = await info.getGlobal();
  assert.strictEqual(snap.ok, true, 'сбой добора checks одного PR — best-effort, вся выдача остаётся ok:true');
  const byNumber = Object.fromEntries(snap.prs.map((p) => [p.number, p]));
  assert.strictEqual(byNumber[1].checks, 'none');
  assert.strictEqual(byNumber[2].checks, 'failing');
});

test('getGlobal: gh не установлен (ENOENT) → ok:false, error:no-gh', async () => {
  const info = createGhInfo({
    run: async () => { const err = new Error('spawn gh ENOENT'); err.code = 'ENOENT'; throw err; },
    cache: noCache(),
    now: () => 1,
  });
  const snap = await info.getGlobal();
  assert.strictEqual(snap.ok, false);
  assert.strictEqual(snap.error, 'no-gh');
  assert.deepStrictEqual(snap.prs, []);
  assert.deepStrictEqual(snap.issues, []);
  assert.strictEqual(snap.notifications, 0);
});

test('getGlobal: не авторизован (реальная фикстура "gh auth login", код 4) → ok:false, error:auth', async () => {
  const authFail = fail('To get started with GitHub CLI, please run:  gh auth login\n', 4);
  const info = createGhInfo({
    run: runFixture({ searchPrs: authFail, searchIssues: authFail, notifications: authFail }),
    cache: noCache(),
    now: () => 1,
  });
  const snap = await info.getGlobal();
  assert.strictEqual(snap.ok, false);
  assert.strictEqual(snap.error, 'auth');
});

test('getGlobal: прочий сбой (code!=0, неизвестный текст) → ok:false, error:failed', async () => {
  const info = createGhInfo({
    run: runFixture({ notifications: fail('rate limited or whatever') }),
    cache: noCache(),
    now: () => 1,
  });
  const snap = await info.getGlobal();
  assert.strictEqual(snap.ok, false);
  assert.strictEqual(snap.error, 'failed');
});

test('getGlobal: TTL — второй вызов внутри ttlMs не зовёт run() повторно', async () => {
  const calls = [];
  let t = 1000;
  const info = createGhInfo({ run: runFixture({ calls }), cache: noCache(), now: () => t, ttlMs: 3000 });
  const first = await info.getGlobal();
  const callsAfterFirst = calls.length;
  t += 1000;
  const second = await info.getGlobal();
  assert.strictEqual(calls.length, callsAfterFirst, 'второй getGlobal() внутри TTL не должен был звать run()');
  assert.deepStrictEqual(second, first);
});

test('getGlobal: TTL — вызов ПОСЛЕ истечения ttlMs зовёт run() заново', async () => {
  const calls = [];
  let t = 1000;
  const info = createGhInfo({ run: runFixture({ calls }), cache: noCache(), now: () => t, ttlMs: 3000 });
  await info.getGlobal();
  const callsAfterFirst = calls.length;
  t += 3001;
  await info.getGlobal();
  assert.strictEqual(calls.length, callsAfterFirst * 2, 'run() должен был вызваться заново после истечения TTL');
});

test('getGlobal: force:true игнорирует свежесть TTL и зовёт run() заново', async () => {
  const calls = [];
  const info = createGhInfo({ run: runFixture({ calls }), cache: noCache(), now: () => 1, ttlMs: 3000 });
  await info.getGlobal();
  const callsAfterFirst = calls.length;
  await info.getGlobal({ force: true });
  assert.strictEqual(calls.length, callsAfterFirst * 2, 'force:true должен был вызвать run() заново несмотря на свежий кэш');
});

test('getGlobal: кэш ОБЩИЙ — не зависит от того, вызывался ли getRepo, и не делится с ним ключом', async () => {
  const calls = [];
  const info = createGhInfo({ run: runFixture({ calls }), cache: noCache(), now: () => 1 });
  await info.getRepo('C:\\repo');
  const callsAfterRepo = calls.length;
  await info.getGlobal();
  const callsAfterGlobalFirst = calls.length;
  assert.ok(callsAfterGlobalFirst > callsAfterRepo, 'getGlobal() должен был выполнить собственные вызовы run(), не переиспользуя кэш getRepo()');
  await info.getGlobal(); // тот же кэш, внутри TTL
  assert.strictEqual(calls.length, callsAfterGlobalFirst, 'повторный getGlobal() внутри TTL не должен звать run()');
});

test('getGlobal: форма результата — fetchedAt проставлен из now()', async () => {
  const info = createGhInfo({ run: runFixture(), cache: noCache(), now: () => 999999 });
  const snap = await info.getGlobal();
  assert.strictEqual(snap.fetchedAt, 999999);
});
