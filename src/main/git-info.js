'use strict';
// Чистое ядро git-info для панели диффа (Task 1, фаза 6): состояние
// репозитория (ветка/ahead/behind/список изменённых файлов) + текст unified-
// диффа, урезанный по лимитам. Модуль ЧИСТЫЙ — run/cache/now инжектируются,
// никакого child_process/electron внутри (проводка run(args, cwd) — дело
// вызывающего кода, по образцу usage-ccusage.js: execFile('git', args, cwd,
// {...}) — здесь этого нет вообще).
//
// РЕАЛЬНЫЕ ОБРАЗЦЫ (сняты 28.07.2026 на claude-cockpit, git 2.54.0.windows.1;
// полный протокол экспериментов — в task-1-report.md):
//
//   git -c core.quotepath=false status --porcelain=v1 -b
//     ## main...origin/main [ahead 1]
//     ## tmp-local...tmp-upstream [ahead 1, behind 1]
//     ## tmp-behind-local...tmp-behind-upstream [behind 1]
//     ## tmp-no-upstream-test                       (нет upstream — без [..])
//     ## HEAD (no branch)                           (detached HEAD)
//     ## No commits yet on main                     (свежий репозиторий)
//      D src/main/notify.js                         (не в индексе, удалено)
//      M src/main/paths.js                          (не в индексе, изменено)
//     A  tmp-staged-new.txt                         (в индексе, добавлено)
//     RM src/main/toasts.js -> src/main/toasts-renamed.js  (переименовано
//                                          В ИНДЕКСЕ + доп. правка в рабочем
//                                          дереве; путь — только НОВЫЙ)
//     ?? src/main/тест-кириллица.js       (кириллица — сырой UTF-8 текст,
//                                          core.quotepath=false ОБЯЗАТЕЛЕН:
//                                          без него это же имя приезжает как
//                                          "\320\242\320\265\321\201...")
//     ?? "tmp file with spaces.txt"       (ВАЖНО, эмпирически подтверждено:
//                                          git status квотит путь в "..." при
//                                          пробеле/табе/кавычке/бэкслеше —
//                                          НЕЗАВИСИМО от core.quotepath, это
//                                          отдельное правило; unquote нужен
//                                          всегда, а не только «на всякий»)
//
//   git -c core.quotepath=false diff --numstat HEAD
//     0	24	src/main/notify.js
//     1	0	src/main/paths.js
//     1	0	src/main/{toasts.js => toasts-renamed.js}   (переименование —
//                                          скобочная нотация с общим
//                                          префиксом/суффиксом; при полностью
//                                          разных путях — "old => new" без
//                                          скобок. ВАЖНО: numstat/diff НИКОГДА
//                                          не квотят путь, даже с пробелом
//                                          или кириллицей — это отдельное от
//                                          status поведение, подтверждено
//                                          экспериментально)
//     -	-	tmp-binary.bin              (бинарный файл — дефис вместо чисел)
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
//
// Правила деградации (никогда не бросаем наружу):
//  - ENOENT от run() (git не установлен/не найден в PATH) →
//    {ok:false, error:'git-missing'}; этот факт кэшируется НАДОЛГО
//    (GIT_MISSING_TTL_MS), независимо от переданного ttlMs — иначе поллинг
//    раз в 3с долбит несуществующий git на каждый тик. force:true всё равно
//    пробует заново (явный ручной запрос пользователя).
//  - code!=0 + "not a git repository" в stderr → {ok:true, isRepo:false,
//    error:'not-a-repo'} — это НЕ сбой запроса, а нормальное состояние
//    (открыли папку, которая не является git-репозиторием). diff/numstat в
//    этом случае вообще не вызываются — незачем.
//  - свежий репозиторий без единого коммита ("No commits yet on X"): status
//    успешен, но diff/--numstat HEAD упадут (нет ref HEAD) — это НЕ общий
//    сбой, деградируем локально (diff:'', added/removed:0), а не роняем
//    весь ok:false.
//  - любой другой сбой (code!=0 без узнаваемого текста, неожиданное
//    исключение и т.п.) → {ok:false, error:'failed'}.

const GIT_MISSING_TTL_MS = 10 * 60 * 1000; // 10 минут — не долбим отсутствующий git каждые 3с
const MAX_FILES = 200;
const MAX_DIFF_LINES = 2000;

// XY-коды unmerged/conflict из документации porcelain v1 (это НЕ обязательно
// содержит букву 'U' — например DD/AA тоже конфликт, «оба удалили»/«оба
// добавили»).
const CONFLICT_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

function isGitMissingError(err) {
  if (!err) return false;
  if (err.code === 'ENOENT') return true;
  return /ENOENT/.test(String(err.message || err));
}

function isNotARepoResult(res) {
  return !!res && res.code !== 0 && /not a git repository/i.test(res.stderr || '');
}

// git status квотит путь в "..." при пробеле/табе/кавычке/бэкслеше —
// НЕЗАВИСИМО от core.quotepath (та настройка отвечает только за байты
// >=0x80, см. шапку файла). diff/numstat так не делают вообще — там unquote
// всегда no-op, но вызывать его безопасно в любом случае.
function unquotePath(raw) {
  if (raw.length >= 2 && raw[0] === '"' && raw[raw.length - 1] === '"') {
    const inner = raw.slice(1, -1);
    let out = '';
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (ch === '\\' && i + 1 < inner.length) {
        const next = inner[i + 1];
        if (next === '"') { out += '"'; i += 1; } else if (next === '\\') { out += '\\'; i += 1; } else if (next === 't') { out += '\t'; i += 1; } else if (next === 'n') { out += '\n'; i += 1; } else if (next >= '0' && next <= '7') {
          out += String.fromCharCode(parseInt(inner.slice(i + 1, i + 4), 8));
          i += 3;
        } else { out += next; i += 1; }
      } else {
        out += ch;
      }
    }
    return out;
  }
  return raw;
}

// Путь из "хвоста" строки статуса (после "XY "): для переименований формат
// "old -> new" — берём НОВЫЙ (после " -> "), для остального — путь целиком.
function parseStatusPath(rest) {
  const arrow = rest.indexOf(' -> ');
  if (arrow === -1) return unquotePath(rest);
  return unquotePath(rest.slice(arrow + 4));
}

function classifyStatus(xy) {
  if (CONFLICT_CODES.has(xy)) return 'U';
  if (xy === '??') return '?';
  const x = xy[0];
  const y = xy[1];
  // Предпочитаем индексный (staged) статус, если он есть, иначе — рабочего
  // дерева (см. реальный образец "RM": рена в индексе важнее, чем M сверху).
  return x !== ' ' ? x : y;
}

function isStagedCode(xy) {
  const x = xy[0];
  return x !== ' ' && x !== '?' && x !== '!';
}

// Разбор строки "## ...": варианты см. в шапке файла (реальные образцы).
function parseBranchLine(line) {
  if (!line || !line.startsWith('## ')) return { branch: null, ahead: 0, behind: 0 };
  let rest = line.slice(3);

  const noCommits = rest.match(/^No commits yet on (.+)$/);
  if (noCommits) rest = noCommits[1];

  if (rest === 'HEAD (no branch)') return { branch: null, ahead: 0, behind: 0 };

  let branch = rest;
  let ahead = 0;
  let behind = 0;

  const bracket = rest.match(/^(.*) \[([^\]]+)\]$/);
  if (bracket) {
    branch = bracket[1];
    const info = bracket[2]; // "ahead 2, behind 1" | "ahead 1" | "behind 3" | "gone"
    const aheadM = info.match(/ahead (\d+)/);
    const behindM = info.match(/behind (\d+)/);
    if (aheadM) ahead = Number(aheadM[1]);
    if (behindM) behind = Number(behindM[1]);
  }

  const dots = branch.indexOf('...');
  if (dots !== -1) branch = branch.slice(0, dots); // "main...origin/main" → "main"

  return { branch, ahead, behind };
}

function parseStatusOutput(stdout) {
  const lines = String(stdout || '')
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.length > 0);

  let header = { branch: null, ahead: 0, behind: 0 };
  const files = [];

  for (const line of lines) {
    if (line.startsWith('## ')) {
      header = parseBranchLine(line);
      continue;
    }
    if (line.length < 3) continue; // защита от мусорных/неполных строк

    const xy = line.slice(0, 2);
    const rest = line.slice(3);
    const path = parseStatusPath(rest);

    files.push({
      path,
      status: classifyStatus(xy),
      staged: isStagedCode(xy),
      added: 0,
      removed: 0,
    });
  }

  return { ...header, files };
}

// "prefix{old => new}suffix" или "old => new" (без общего префикса/суффикса)
// → новый полный путь. numstat никогда не квотит путь (даже с пробелом или
// кириллицей) — в отличие от status, эмпирически подтверждено.
function resolveNumstatNewPath(raw) {
  const open = raw.indexOf('{');
  const close = open === -1 ? -1 : raw.indexOf('}', open + 1);
  if (open !== -1 && close !== -1) {
    const prefix = raw.slice(0, open);
    const suffix = raw.slice(close + 1);
    const inner = raw.slice(open + 1, close);
    const arrow = inner.indexOf(' => ');
    if (arrow !== -1) return prefix + inner.slice(arrow + 4) + suffix;
  }
  const arrow = raw.indexOf(' => ');
  if (arrow !== -1) return raw.slice(arrow + 4);
  return raw;
}

// path → {added, removed}. Бинарные файлы приходят как "-\t-\tpath" — это
// не NaN, а осознанные 0/0 (числа диффа для бинарника недоступны).
function parseNumstat(stdout) {
  const map = new Map();
  for (const raw of String(stdout || '').split('\n')) {
    if (!raw) continue;
    const line = raw.replace(/\r$/, '');
    const tab1 = line.indexOf('\t');
    const tab2 = tab1 === -1 ? -1 : line.indexOf('\t', tab1 + 1);
    if (tab1 === -1 || tab2 === -1) continue;

    const addedRaw = line.slice(0, tab1);
    const removedRaw = line.slice(tab1 + 1, tab2);
    const pathRaw = line.slice(tab2 + 1);

    const added = addedRaw === '-' ? 0 : (Number(addedRaw) || 0);
    const removed = removedRaw === '-' ? 0 : (Number(removedRaw) || 0);

    map.set(resolveNumstatNewPath(pathRaw), { added, removed });
  }
  return map;
}

function applyNumstat(files, numstatMap) {
  return files.map((f) => {
    const counts = numstatMap.get(f.path);
    return counts ? { ...f, added: counts.added, removed: counts.removed } : f;
  });
}

// Лимит 200 файлов (бриф): режем files[], сколько скрыто — в truncated.files.
function truncateFiles(files) {
  if (files.length <= MAX_FILES) return { files, hidden: 0 };
  return { files: files.slice(0, MAX_FILES), hidden: files.length - MAX_FILES };
}

// Лимит 2000 строк диффа: финальный '\n' в конце текста не считаем отдельной
// «строкой» — иначе типичный дифф с ровно 2000 содержательными строками и
// завершающим переводом строки ложно считался бы превысившим лимит на 1.
function truncateDiff(diffText) {
  const text = diffText || '';
  if (!text) return { diff: '', hidden: 0 };
  const endsWithNl = text.endsWith('\n');
  const rawLines = text.split('\n');
  const lines = endsWithNl ? rawLines.slice(0, -1) : rawLines;
  if (lines.length <= MAX_DIFF_LINES) return { diff: text, hidden: 0 };
  const kept = lines.slice(0, MAX_DIFF_LINES);
  return { diff: kept.join('\n'), hidden: lines.length - MAX_DIFF_LINES };
}

function emptyOkFields() {
  return { branch: null, ahead: 0, behind: 0, files: [], diff: '', truncated: null };
}

function createGitInfo({ run, now = Date.now, cache, ttlMs = 3000 }) {
  const cacheMap = cache || new Map();

  // Каждый вызов git ОБЯЗАН нести -c core.quotepath=false — иначе кириллица
  // (и вообще любые байты >=0x80) в путях приезжает octal-экранированной.
  function execGit(args, cwd) {
    return run(['-c', 'core.quotepath=false', ...args], cwd);
  }

  function buildOkResult(data, fetchedAt) {
    return {
      ok: true,
      isRepo: true,
      error: null,
      branch: data.branch,
      ahead: data.ahead,
      behind: data.behind,
      files: data.files.map((f) => ({ ...f })),
      diff: data.diff,
      truncated: data.truncated ? { ...data.truncated } : null,
      fetchedAt,
    };
  }

  function notARepoResult(fetchedAt) {
    return { ok: true, isRepo: false, error: 'not-a-repo', ...emptyOkFields(), fetchedAt };
  }

  function failedResult(errorKind, fetchedAt) {
    return { ok: false, isRepo: false, error: errorKind, ...emptyOkFields(), fetchedAt };
  }

  async function fetchFresh(cwd) {
    let statusRes;
    try {
      statusRes = await execGit(['status', '--porcelain=v1', '-b'], cwd);
    } catch (err) {
      return { kind: isGitMissingError(err) ? 'git-missing' : 'failed' };
    }
    if (!statusRes) return { kind: 'failed' };
    if (isNotARepoResult(statusRes)) return { kind: 'not-a-repo' };
    if (statusRes.code !== 0) return { kind: 'failed' };

    let numstatRes;
    let diffRes;
    try {
      [numstatRes, diffRes] = await Promise.all([
        execGit(['diff', '--numstat', 'HEAD'], cwd),
        execGit(['diff', 'HEAD'], cwd),
      ]);
    } catch (err) {
      return { kind: isGitMissingError(err) ? 'git-missing' : 'failed' };
    }

    // Свежий репозиторий без коммитов: diff/--numstat HEAD падают (нет ref
    // HEAD) — это НЕ общий сбой запроса, просто диффить не с чем ещё.
    const numstatOk = !!numstatRes && numstatRes.code === 0;
    const diffOk = !!diffRes && diffRes.code === 0;

    const parsedStatus = parseStatusOutput(statusRes.stdout);
    const numstatMap = numstatOk ? parseNumstat(numstatRes.stdout) : new Map();
    const filesWithCounts = applyNumstat(parsedStatus.files, numstatMap);
    const rawDiff = diffOk ? (diffRes.stdout || '') : '';

    const { files: limitedFiles, hidden: hiddenFiles } = truncateFiles(filesWithCounts);
    const { diff, hidden: hiddenLines } = truncateDiff(rawDiff);
    const truncated = (hiddenFiles > 0 || hiddenLines > 0) ? { files: hiddenFiles, lines: hiddenLines } : null;

    return {
      kind: 'ok',
      data: {
        branch: parsedStatus.branch,
        ahead: parsedStatus.ahead,
        behind: parsedStatus.behind,
        files: limitedFiles,
        diff,
        truncated,
      },
    };
  }

  async function get(cwd, { force = false } = {}) {
    const nowMs = now();
    const cached = cacheMap.get(cwd);

    if (!force && cached) {
      const ttl = cached.kind === 'git-missing' ? GIT_MISSING_TTL_MS : ttlMs;
      if ((nowMs - cached.fetchedAt) < ttl) return cached.result;
    }

    const outcome = await fetchFresh(cwd);

    let result;
    if (outcome.kind === 'git-missing') {
      result = failedResult('git-missing', nowMs);
    } else if (outcome.kind === 'not-a-repo') {
      result = notARepoResult(nowMs);
    } else if (outcome.kind === 'failed') {
      result = failedResult('failed', nowMs);
    } else {
      result = buildOkResult(outcome.data, nowMs);
    }

    cacheMap.set(cwd, { result, fetchedAt: nowMs, kind: outcome.kind });
    return result;
  }

  return { get };
}

module.exports = { createGitInfo };
