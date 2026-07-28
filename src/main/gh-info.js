'use strict';
// Чистое ядро gh-info для панели GitHub (Task 3, фаза 6): статус PR текущего
// репозитория + сводка по всем открытым PR/issues пользователя + число
// непрочитанных уведомлений. Модуль ЧИСТЫЙ — run/cache/now инжектируются,
// никакого child_process/electron внутри. Проводка run(args, cwd) — дело
// вызывающего кода: в проде это execFile('gh', args, {cwd, shell:true, ...})
// — shell:true нужен на Windows по тем же причинам, что и для npx в
// ipc.js/runCcusage (gh.exe тоже может быть обёрнут батником/шимом на
// некоторых установках — используем ту же защиту, что и там).
//
// РЕАЛЬНЫЕ ОБРАЗЦЫ (сняты 28.07.2026, gh version 2.94.0, аккаунт lunev51;
// полный протокол экспериментов, включая коды возврата — в task-3-report.md):
//
//   gh pr status --json number,title,state,isDraft,statusCheckRollup,reviewDecision,url
//     (ветка БЕЗ своего PR, ветка phase6-insight в claude-cockpit)
//     {"createdBy":[],"needsReview":[]}
//     — ВАЖНО: ключ "currentBranch" в объекте ПОЛНОСТЬЮ ОТСУТСТВУЕТ, когда
//     для текущей ветки нет PR (не null — просто нет ключа). "currentBranch"
//     как имя JSON-поля НЕДОСТУПНО во флаге --json (список полей чисто
//     PR-уровня: number, title, state, isDraft, reviewDecision, url,
//     statusCheckRollup, ... без repository) — поэтому имя репозитория
//     ("owner/name") этой командой не получить вообще, нужна вторая команда.
//
//   gh repo view --json nameWithOwner   (в cwd проекта)
//     {"nameWithOwner":"lunev51/claude-cockpit"}
//
//   gh pr list --repo cli/cli --limit 1 --json number,title,state,isDraft,statusCheckRollup,reviewDecision,url
//     (чужой публичный репозиторий — образец ФОРМЫ currentBranch, когда PR
//     ЕСТЬ; сама выдача gh pr status оборачивает точно такой же объект в
//     ключ "currentBranch", если для текущей ветки открыт PR)
//     {"number":13982,"title":"Add --latest-pre-release and --pin flags...",
//      "state":"OPEN","isDraft":false,"reviewDecision":"CHANGES_REQUESTED",
//      "url":"https://github.com/cli/cli/pull/13982", statusCheckRollup:[...]}
//     — reviewDecision, если решения нет вообще, приходит как "" (ПУСТАЯ
//     СТРОКА, не null) — см. PR #13957 того же репозитория; в нашем выводе
//     нормализуем "" → null (контракт: string|null).
//
//   statusCheckRollup[] — два разных __typename:
//     CheckRun (обычные GitHub Actions джобы):
//       {"__typename":"CheckRun","status":"COMPLETED","conclusion":"SUCCESS",...}
//       в процессе (реальный образец, microsoft/vscode PR #327769):
//       {"__typename":"CheckRun","status":"IN_PROGRESS","conclusion":"",...}
//       провал (реальный образец, cli/cli PR #13788): conclusion:"FAILURE"
//       требует действия (реальный образец, vscode PR #327675):
//       conclusion:"ACTION_REQUIRED" — трактуем как провал (в UI GitHub это
//       красный крест, не жёлтая точка)
//     StatusContext (внешние статусы не через Actions, напр. Commit Status
//       API) — своей живой выдачи не поймали (в личных репозиториях только
//       Actions), но поле называется "state", а не "status"/"conclusion" —
//       по документации API: EXPECTED/ERROR/FAILURE/PENDING/SUCCESS.
//       Разбираем по этому же принципу «на всякий случай», не как
//       проверенный факт.
//
//   gh search prs --author=@me --state=open --json repository,number,title,url --limit 20
//     (в момент снятия образца — 0 открытых PR у пользователя)  []
//     ВАЖНО: --json НЕ поддерживает поле statusCheckRollup для search prs
//     (список валидных полей: assignees, author, authorAssociation, body,
//     closedAt, commentsCount, createdAt, id, isDraft, isLocked,
//     isPullRequest, labels, number, repository, state, title, updatedAt,
//     url — без statusCheckRollup). Чтобы всё равно заполнить checks в
//     getGlobal(), после search делаем best-effort второй вызов на каждый
//     найденный PR: gh pr view <number> --repo <owner/name> --json
//     statusCheckRollup (проверено вручную — работает, код 0). Сбой этого
//     точечного добора НЕ роняет всю выдачу — просто checks:'none' для
//     этого PR.
//     Образец repository: {"name":"cli","nameWithOwner":"cli/cli"} (снято
//     с gh search prs --repo=cli/cli — форма поля идентична).
//
//   gh search issues --assignee=@me --state=open --json repository,number,title,url --limit 20
//     []  (0 открытых issues у пользователя на момент снятия образца)
//
//   gh api notifications --jq length
//     0
//
// Правила деградации (никогда не бросаем наружу):
//  - ENOENT от run() (gh не установлен/не найден в PATH) → error:'no-gh',
//    ok:false; кэшируется НАДОЛГО (GH_MISSING_TTL_MS), как git-missing в
//    git-info.js — иначе поллинг раз в несколько секунд долбит
//    несуществующий gh на каждый тик. force:true всё равно пробует заново.
//  - не авторизован: code!=0 + текст "gh auth login" в stderr (реальный
//    образец, снят через GH_CONFIG_DIR на пустой каталог — код возврата 4,
//    stderr: "To get started with GitHub CLI, please run:  gh auth login\n
//    Alternatively, populate the GH_TOKEN environment variable...") →
//    error:'auth', ok:false.
//  - не репозиторий / нет remote → error:'no-remote', ok:true (это НЕ
//    сбой запроса, а нормальное состояние — открыли папку без git или без
//    настроенного remote). Реальные образцы:
//      не git-репозиторий вообще (код 1): "failed to run git: fatal: not
//        a git repository (or any of the parent directories): .git"
//      git-репозиторий БЕЗ remote (код 1): "no git remotes found"
//  - любой другой сбой (code!=0 без узнаваемого текста, неожиданное
//    исключение, невалидный JSON в stdout и т.п.) → error:'failed',
//    ok:false.

const GH_MISSING_TTL_MS = 10 * 60 * 1000; // 10 минут — не долбим отсутствующий gh каждые несколько секунд
const GLOBAL_LIMIT = 20;
// Минорная находка 6 (ревью фазы 6): `gh api notifications --jq length` без
// явного per_page считает только ОДНУ (первую) страницу — по умолчанию до
// 50 штук на странице у этого эндпоинта. Явный per_page делает границу
// детерминированной: если пришло ровно NOTIFICATIONS_PAGE_SIZE, честно
// считаем это «как минимум столько» (см. notificationsAtLimit ниже), а не
// выдаём точное число, которое может быть заниженным.
const NOTIFICATIONS_PAGE_SIZE = 50;
const PR_STATUS_JSON_FIELDS = 'number,title,state,isDraft,statusCheckRollup,reviewDecision,url';
const SEARCH_PRS_JSON_FIELDS = 'repository,number,title,url';
const SEARCH_ISSUES_JSON_FIELDS = 'repository,number,title,url';

function isGhMissingError(err) {
  if (!err) return false;
  if (err.code === 'ENOENT') return true;
  return /ENOENT/.test(String(err.message || err));
}

function isAuthErrorResult(res) {
  return !!res && res.code !== 0 && /gh auth login/i.test(res.stderr || '');
}

function isNoRemoteResult(res) {
  if (!res || res.code === 0) return false;
  const stderr = res.stderr || '';
  return /not a git repository/i.test(stderr) || /no git remotes found/i.test(stderr);
}

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text || '');
  } catch (err) {
    return fallback;
  }
}

// Один элемент statusCheckRollup → «успешен ли», «провален ли», «в процессе
// ли». CheckRun: конкретные значения conclusion (реальные образцы — в шапке
// файла). StatusContext: поле "state" вместо "status"/"conclusion" (по
// документации GraphQL API, живого образца не поймали — см. шапку).
const FAILING_CONCLUSIONS = new Set(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE']);
const FAILING_STATES = new Set(['FAILURE', 'ERROR']);
const PENDING_STATES = new Set(['PENDING', 'EXPECTED']);

// passing/failing/pending/none. Провал перекрывает "в процессе" независимо
// от порядка элементов в массиве (в реальной выдаче GitHub красный крест
// важнее жёлтой точки).
function classifyChecks(rollup) {
  if (!Array.isArray(rollup) || rollup.length === 0) return 'none';
  let hasPending = false;
  for (const item of rollup) {
    if (!item) continue;
    // Различаем CheckRun/StatusContext по __typename — полю, которое --json
    // statusCheckRollup отдаёт ВСЕГДА (см. шапку файла), а не по отсутствию
    // поля status, как было раньше (находка 2, ревью carryover фазы 6):
    // прежняя эвристика ошибочно доверяла форме объекта. Если бы
    // StatusContext когда-нибудь тоже нёс поле status (документацией это не
    // исключено), старая проверка молча приняла бы его за CheckRun и
    // проигнорировала бы провал (conclusion для StatusContext всегда
    // undefined, не входит в FAILING_CONCLUSIONS). __typename — явный
    // дискриминатор API, ему доверяем безусловно; незнакомый/отсутствующий
    // __typename (другая версия gh) — трактуем как CheckRun, самый частый и
    // документированный случай, не бросаем и не роняем всю классификацию.
    const isStatusContext = item.__typename === 'StatusContext';
    if (isStatusContext) {
      if (FAILING_STATES.has(item.state)) return 'failing';
      if (PENDING_STATES.has(item.state)) hasPending = true;
      continue;
    }
    if (item.status && item.status !== 'COMPLETED') { hasPending = true; continue; }
    if (FAILING_CONCLUSIONS.has(item.conclusion)) return 'failing';
  }
  return hasPending ? 'pending' : 'passing';
}

// ПЛЮС находки 3 (триаж, ревью фазы 6): таймер обновления бейджа PR в app.js
// тикает раз в 180000мс (3 мин) — при ttlMs, РАВНОМ этому же периоду, каждый
// тик оказывается гонкой «успел ли кэш протухнуть строго ДО тика» (зависит
// от точного момента первого fetchedAt относительно старта таймера). TTL
// короче периода таймера на детерминированный запас — тик ГАРАНТИРОВАННО
// застаёт кэш просроченным, а не иногда.
function createGhInfo({ run, now = Date.now, cache, ttlMs = 150000 }) {
  const cacheMap = cache || new Map();

  function execGh(args, cwd) {
    return run(args, cwd);
  }

  function noRemoteRepoResult(fetchedAt) {
    return { ok: true, error: 'no-remote', repo: null, pr: null, fetchedAt };
  }

  function failedRepoResult(errorKind, fetchedAt) {
    return { ok: false, error: errorKind, repo: null, pr: null, fetchedAt };
  }

  function buildRepoOkResult(repoName, prRaw, fetchedAt) {
    const pr = prRaw ? {
      number: prRaw.number,
      title: prRaw.title,
      state: prRaw.state,
      isDraft: !!prRaw.isDraft,
      checks: classifyChecks(prRaw.statusCheckRollup),
      reviewDecision: prRaw.reviewDecision || null,
      url: prRaw.url,
    } : null;
    return { ok: true, error: null, repo: repoName || null, pr, fetchedAt };
  }

  async function fetchRepoFresh(cwd) {
    let repoRes;
    let prRes;
    try {
      [repoRes, prRes] = await Promise.all([
        execGh(['repo', 'view', '--json', 'nameWithOwner'], cwd),
        execGh(['pr', 'status', '--json', PR_STATUS_JSON_FIELDS], cwd),
      ]);
    } catch (err) {
      return { kind: isGhMissingError(err) ? 'no-gh' : 'failed' };
    }

    if (isAuthErrorResult(repoRes) || isAuthErrorResult(prRes)) return { kind: 'auth' };
    if (isNoRemoteResult(repoRes) || isNoRemoteResult(prRes)) return { kind: 'no-remote' };
    if (!repoRes || repoRes.code !== 0 || !prRes || prRes.code !== 0) return { kind: 'failed' };

    const repoParsed = safeJsonParse(repoRes.stdout, null);
    const prParsed = safeJsonParse(prRes.stdout, null);
    if (!repoParsed || !prParsed) return { kind: 'failed' };

    return { kind: 'ok', repoName: repoParsed.nameWithOwner || null, prRaw: prParsed.currentBranch || null };
  }

  // Находка 3 (ревью фазы 6): та же защита, что и в git-info.js — автоповтор
  // клавиши (Ctrl+Tab/Ctrl+1..9, таймер бейджа PR в app.js) может позвать
  // getRepo()/getGlobal() быстрее, чем успевает разрешиться предыдущий
  // вызов; без single-flight каждый повтор стартовал бы СВОЮ пару
  // gh-процессов (repo view + pr status = 2 под shell:true = до 4 процессов
  // на Windows) поверх ещё летящей. Ключ — тот же, что у cacheMap, общая
  // карта на getRepo и getGlobal (ключи 'repo:<cwd>' и 'global' не пересекаются).
  const inFlightMap = new Map();

  async function getRepo(cwd, { force = false } = {}) {
    const key = `repo:${cwd}`;
    const startMs = now();
    const cached = cacheMap.get(key);

    if (!force && cached) {
      const ttl = cached.kind === 'no-gh' ? GH_MISSING_TTL_MS : ttlMs;
      if ((startMs - cached.fetchedAt) < ttl) return cached.result;
    }

    const existing = inFlightMap.get(key);
    if (existing) return existing;

    const promise = (async () => {
      const outcome = await fetchRepoFresh(cwd);
      // Находка 3: fetchedAt — ПОСЛЕ await, не в момент вызова (см. тот же
      // комментарий в git-info.js/get()) — иначе запись в кэше рождается уже
      // просроченной на медленной сети.
      const fetchedAt = now();

      let result;
      if (outcome.kind === 'no-gh') result = failedRepoResult('no-gh', fetchedAt);
      else if (outcome.kind === 'auth') result = failedRepoResult('auth', fetchedAt);
      else if (outcome.kind === 'no-remote') result = noRemoteRepoResult(fetchedAt);
      else if (outcome.kind === 'failed') result = failedRepoResult('failed', fetchedAt);
      else result = buildRepoOkResult(outcome.repoName, outcome.prRaw, fetchedAt);

      cacheMap.set(key, { result, fetchedAt, kind: outcome.kind });
      return result;
    })();

    inFlightMap.set(key, promise);
    try {
      return await promise;
    } finally {
      inFlightMap.delete(key);
    }
  }

  function failedGlobalResult(errorKind, fetchedAt) {
    return {
      ok: false,
      error: errorKind,
      prs: [],
      issues: [],
      notifications: 0,
      prsAtLimit: false,
      issuesAtLimit: false,
      notificationsAtLimit: false,
      fetchedAt,
    };
  }

  // Точечный добор чек-статуса одного PR (gh search prs не отдаёт
  // statusCheckRollup вообще, см. шапку файла). Сбой этого добора —
  // best-effort, не должен ронять всю выдачу getGlobal.
  //
  // Минорная находка 5 (ревью фазы 6): раньше провал самого добора (gh pr
  // view упал/вернул code!=0) оставлял checks:'none' — а UI рисует 'none'
  // тем же приглушённым цветом, что и «у PR и правда нет проверок». Красный
  // (реально failing) PR, для которого просто не удалось узнать статус
  // (сеть моргнула, таймаут), выглядел неотличимо от зелёного «без CI».
  // 'unknown' — отдельное значение: «не удалось узнать», не «точно нет».
  // Если repoName/number вообще отсутствуют (совсем нет данных, добор не
  // предпринимался), 'none' остаётся — это иной, куда более редкий случай.
  async function enrichPrChecks(p) {
    const repoName = p.repository ? p.repository.nameWithOwner : null;
    let checks = 'none';
    if (repoName && p.number != null) {
      checks = 'unknown'; // до попытки — провал ниже (исключение ИЛИ code!=0) оставит именно это
      try {
        const viewRes = await execGh(['pr', 'view', String(p.number), '--repo', repoName, '--json', 'statusCheckRollup']);
        if (viewRes && viewRes.code === 0) {
          const viewParsed = safeJsonParse(viewRes.stdout, null);
          checks = viewParsed ? classifyChecks(viewParsed.statusCheckRollup) : 'unknown';
        }
      } catch (err) {
        // best-effort: оставляем checks:'unknown', не бросаем наружу
      }
    }
    return { repo: repoName, number: p.number, title: p.title, checks, url: p.url };
  }

  async function fetchGlobalFresh() {
    let prsRes;
    let issuesRes;
    let notifRes;
    try {
      [prsRes, issuesRes, notifRes] = await Promise.all([
        execGh(['search', 'prs', '--author=@me', '--state=open', '--json', SEARCH_PRS_JSON_FIELDS, '--limit', String(GLOBAL_LIMIT)]),
        execGh(['search', 'issues', '--assignee=@me', '--state=open', '--json', SEARCH_ISSUES_JSON_FIELDS, '--limit', String(GLOBAL_LIMIT)]),
        // Минорная находка 6: per_page явный (см. константу выше) — без него
        // граница «одна страница» негласная и могла молча сместиться вместе
        // с дефолтом API. ВАЖНО (поймано живой проверкой): per_page ПЕРЕДАЁМ
        // строкой query, а НЕ через `-f`/`-F` — у `gh api` эти флаги молча
        // переключают метод запроса на POST, если --method не задан явно
        // (документированное поведение `gh api --help`), а POST на
        // /notifications отвечает 404 — вся выдача getGlobal() ошибочно
        // становилась error:'failed'. Проверено вживую на реальном gh 2.94.0:
        // `gh api notifications -f per_page=50` → 404; `gh api
        // "notifications?per_page=50"` → корректный результат.
        execGh(['api', `notifications?per_page=${NOTIFICATIONS_PAGE_SIZE}`, '--jq', 'length']),
      ]);
    } catch (err) {
      return { kind: isGhMissingError(err) ? 'no-gh' : 'failed' };
    }

    if (isAuthErrorResult(prsRes) || isAuthErrorResult(issuesRes) || isAuthErrorResult(notifRes)) {
      return { kind: 'auth' };
    }
    if (!prsRes || prsRes.code !== 0 || !issuesRes || issuesRes.code !== 0 || !notifRes || notifRes.code !== 0) {
      return { kind: 'failed' };
    }

    const prsParsed = safeJsonParse(prsRes.stdout, null);
    const issuesParsed = safeJsonParse(issuesRes.stdout, null);
    if (!Array.isArray(prsParsed) || !Array.isArray(issuesParsed)) return { kind: 'failed' };

    const notifications = Number(String(notifRes.stdout || '0').trim());

    const prs = await Promise.all(prsParsed.map(enrichPrChecks));
    const issues = issuesParsed.map((i) => ({
      repo: i.repository ? i.repository.nameWithOwner : null,
      number: i.number,
      title: i.title,
      url: i.url,
    }));

    // Минорная находка 7: `--limit 20` без пометки «показано 20 из N» — та же
    // немота, которой панель диффа принципиально избегает (Task 1). Точного
    // общего числа search/notifications нам не отдают без лишнего запроса —
    // честная эвристика: ровно упёрлись в лимит страницы → «как минимум
    // столько», это уже даёт dashboard.js основание показать «+».
    return {
      kind: 'ok',
      prs,
      issues,
      notifications: Number.isFinite(notifications) ? notifications : 0,
      prsAtLimit: prsParsed.length >= GLOBAL_LIMIT,
      issuesAtLimit: issuesParsed.length >= GLOBAL_LIMIT,
      notificationsAtLimit: Number.isFinite(notifications) && notifications >= NOTIFICATIONS_PAGE_SIZE,
    };
  }

  async function getGlobal({ force = false } = {}) {
    const key = 'global';
    const startMs = now();
    const cached = cacheMap.get(key);

    if (!force && cached) {
      const ttl = cached.kind === 'no-gh' ? GH_MISSING_TTL_MS : ttlMs;
      if ((startMs - cached.fetchedAt) < ttl) return cached.result;
    }

    const existing = inFlightMap.get(key);
    if (existing) return existing;

    const promise = (async () => {
      const outcome = await fetchGlobalFresh();
      const fetchedAt = now(); // находка 3: после await, см. комментарий в getRepo()

      let result;
      if (outcome.kind === 'no-gh') result = failedGlobalResult('no-gh', fetchedAt);
      else if (outcome.kind === 'auth') result = failedGlobalResult('auth', fetchedAt);
      else if (outcome.kind === 'failed') result = failedGlobalResult('failed', fetchedAt);
      else {
        result = {
          ok: true,
          error: null,
          prs: outcome.prs,
          issues: outcome.issues,
          notifications: outcome.notifications,
          prsAtLimit: outcome.prsAtLimit,
          issuesAtLimit: outcome.issuesAtLimit,
          notificationsAtLimit: outcome.notificationsAtLimit,
          fetchedAt,
        };
      }

      cacheMap.set(key, { result, fetchedAt, kind: outcome.kind });
      return result;
    })();

    inFlightMap.set(key, promise);
    try {
      return await promise;
    } finally {
      inFlightMap.delete(key);
    }
  }

  return { getRepo, getGlobal };
}

module.exports = { createGhInfo };
