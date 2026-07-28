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
// Полный фикс находки 1 (ревью фазы 6): untracked-файлы НЕ проходят через
// `git diff HEAD`/`--numstat HEAD` вообще (git их не диффит против HEAD, им
// просто нечего сравнивать) — без отдельного шага строка untracked-файла
// всегда показывала бы +0 −0 (выглядит как «нет изменений», хотя на самом
// деле весь файл новый) и не имела бы содержимого в тексте диффа. Лимит —
// не хотим спавнить по 2 git-процесса на каждый из потенциально сотен
// untracked-файлов (например, node_modules, случайно не в .gitignore).
const MAX_NEW_FILE_DIFFS = 50;

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

// Полный фикс находки 1: содержимое ОДНОГО untracked-файла через
// `git diff --no-index` против /dev/null — READ-ONLY (никакого `add -N`,
// индекс вообще не трогаем). `--no-index` возвращает 0 (идентичны — сюда
// недостижимо, /dev/null и реальный файл всегда различаются хотя бы
// существованием) или 1 (есть отличия — ОЖИДАЕМЫЙ путь, а не сбой); любой
// другой код (>1) — настоящая ошибка (например, путь исчез между status и
// этим вызовом). Возвращает null (пропустить — бинарник/сбой/неразбираемый
// вывод) либо {added, removed, diffText}.
function isExpectedNoIndexCode(res) {
  return !!res && (res.code === 0 || res.code === 1);
}

async function fetchUntrackedFileDiff(execGit, cwd, filePath) {
  let numstatRes;
  try {
    numstatRes = await execGit(['diff', '--no-index', '--numstat', '--', '/dev/null', filePath], cwd);
  } catch {
    return null; // ENOENT и т.п. — best-effort, сбой ОДНОГО файла не должен ронять всю выдачу
  }
  if (!isExpectedNoIndexCode(numstatRes)) return null;

  const firstLine = (numstatRes.stdout || '').split('\n')[0] || '';
  const tab1 = firstLine.indexOf('\t');
  const tab2 = tab1 === -1 ? -1 : firstLine.indexOf('\t', tab1 + 1);
  if (tab1 === -1 || tab2 === -1) return null; // пустой/неразбираемый вывод

  const addedRaw = firstLine.slice(0, tab1);
  const removedRaw = firstLine.slice(tab1 + 1, tab2);
  // Бинарник ("-\t-\t...", тот же образец, что и обычный numstat, см. шапку
  // файла) — числа диффа недоступны, содержимое НЕ тянем (бриф).
  if (addedRaw === '-' || removedRaw === '-') return null;
  const added = Number(addedRaw) || 0;
  const removed = Number(removedRaw) || 0;

  let diffRes;
  try {
    diffRes = await execGit(['diff', '--no-index', '--', '/dev/null', filePath], cwd);
  } catch {
    return null;
  }
  if (!isExpectedNoIndexCode(diffRes)) return null;

  return { added, removed, diffText: diffRes.stdout || '' };
}

// Склеивает основной дифф (`git diff HEAD`) с патчами untracked-файлов —
// каждый кусок гарантированно завершается '\n' перед конкатенацией, иначе
// заголовок следующего файла слипся бы с последней строкой предыдущего.
function joinDiffChunks(chunks) {
  return chunks
    .filter((c) => !!c)
    .map((c) => (c.endsWith('\n') ? c : `${c}\n`))
    .join('');
}

// Добирает диффы untracked-файлов (до MAX_NEW_FILE_DIFFS штук, в порядке
// files[]) и возвращает {files: files с обновлёнными added/removed и
// newFileDiffMissing:true там, где добрать не удалось (бинарник/лимит/сбой),
// diffChunks: тексты патчей для склейки с основным диффом}.
async function enrichUntrackedFiles(execGit, cwd, files) {
  const untracked = files.filter((f) => f.status === '?');
  if (!untracked.length) return { files, diffChunks: [] };

  const toFetch = untracked.slice(0, MAX_NEW_FILE_DIFFS);
  const results = await Promise.all(toFetch.map((f) => fetchUntrackedFileDiff(execGit, cwd, f.path)));

  const byPath = new Map();
  toFetch.forEach((f, i) => byPath.set(f.path, results[i]));

  const diffChunks = [];
  const enrichedFiles = files.map((f) => {
    if (f.status !== '?') return f;
    const res = byPath.get(f.path);
    if (!res) return { ...f, newFileDiffMissing: true }; // за пределами лимита, бинарник или сбой
    if (res.diffText) diffChunks.push(res.diffText);
    return { ...f, added: res.added, removed: res.removed };
  });

  return { files: enrichedFiles, diffChunks };
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

    // Полный фикс находки 1 (ревью фазы 6): содержимое untracked-файлов не
    // приходит ни через numstat HEAD, ни через diff HEAD выше (git их против
    // HEAD не диффит) — добираем отдельно, независимо от numstatOk/diffOk
    // (реалистичный случай: свежий репозиторий без единого коммита, где ВСЕ
    // файлы untracked, — numstat/diff HEAD там вообще падают, см. ветку
    // "No commits yet" в правилах деградации, а untracked-содержимое всё
    // равно должно быть доступно).
    const { files: filesWithUntracked, diffChunks } = await enrichUntrackedFiles(execGit, cwd, filesWithCounts);
    const fullDiff = diffChunks.length ? joinDiffChunks([rawDiff, ...diffChunks]) : rawDiff;

    const { files: limitedFiles, hidden: hiddenFiles } = truncateFiles(filesWithUntracked);
    const { diff, hidden: hiddenLines } = truncateDiff(fullDiff);
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

  // Находка 3 (ревью фазы 6): автоповтор клавиши (Ctrl+Tab/Ctrl+1..9) может
  // позвать get() для того же cwd несколько раз подряд быстрее, чем успевает
  // разрешиться первый запрос, — без защиты каждый такой повтор стартовал бы
  // СВОЮ пару git-процессов поверх ещё летящей. inFlightMap (ключ — тот же
  // cwd, что и у cacheMap) — повторный вызов, пока promise ещё не разрешился,
  // получает ЕГО ЖЕ, второй fetchFresh() не запускается вовсе.
  const inFlightMap = new Map();

  async function get(cwd, { force = false } = {}) {
    const startMs = now();
    const cached = cacheMap.get(cwd);

    if (!force && cached) {
      const ttl = cached.kind === 'git-missing' ? GIT_MISSING_TTL_MS : ttlMs;
      if ((startMs - cached.fetchedAt) < ttl) return cached.result;
    }

    const existing = inFlightMap.get(cwd);
    if (existing) return existing;

    const promise = (async () => {
      const outcome = await fetchFresh(cwd);
      // Находка 3 (ревью фазы 6): fetchedAt штампуем ПОСЛЕ await fetchFresh(),
      // а не в момент вызова get() — на медленном репозитории (или под
      // нагрузкой) старое поведение (nowMs до await) рождало запись уже
      // «просроченной» относительно TTL ещё до того, как она вообще попала
      // в кэш, — следующий же вызов get() внутри той же секунды считал её
      // устаревшей и бил по git заново без всякой пользы.
      const fetchedAt = now();

      let result;
      if (outcome.kind === 'git-missing') {
        result = failedResult('git-missing', fetchedAt);
      } else if (outcome.kind === 'not-a-repo') {
        result = notARepoResult(fetchedAt);
      } else if (outcome.kind === 'failed') {
        result = failedResult('failed', fetchedAt);
      } else {
        result = buildOkResult(outcome.data, fetchedAt);
      }

      cacheMap.set(cwd, { result, fetchedAt, kind: outcome.kind });
      return result;
    })();

    inFlightMap.set(cwd, promise);
    try {
      return await promise;
    } finally {
      inFlightMap.delete(cwd);
    }
  }

  return { get };
}

module.exports = { createGitInfo };
