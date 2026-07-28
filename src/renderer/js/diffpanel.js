'use strict';
// Панель диффа (Task 2 фазы 6): справа внутри #main, рядом с #terminal-host в
// общем flex-ряду #main-row — НЕ оверлей (см. index.html/app.css). Оверлеев в
// приложении уже четыре (restore/dashboard/palette/peek), и они дерутся за
// Escape — эта панель просто раздвигает/сдвигает layout, как обычный
// flex-сосед терминала (класс .hidden убирает её из ряда целиком).
//
// DOM строится ОДИН РАЗ при создании (в отличие от dashboard.js/palette.js,
// которые пересобирают свой оверлей на каждый open()) — панель постоянный
// элемент layout'а, открытие/закрытие только переключает .hidden и запускает
// refresh(). Владелец состояния «какая вкладка активна сейчас» — app.js,
// сообщает через setActiveTab(tabId) при каждом переключении.
//
// Источники обновления (бриф): (1) открытие панели, (2) переключение
// вкладки, (3) git:changed от PostToolUse с дебаунсом 1500мс, (4) кнопка
// «Обновить» (force:true, игнорирует TTL-кэш gitInfo в main).

const STATUS_TITLE = {
  M: 'изменён',
  A: 'добавлен',
  D: 'удалён',
  R: 'переименован',
  '?': 'новый (не отслеживается)',
  U: 'конфликт',
};

const GIT_CHANGED_DEBOUNCE_MS = 1500;

function statusClass(status) {
  if (status === 'D') return 'diff-status-del';
  if (status === 'A' || status === '?') return 'diff-status-add';
  if (status === 'U') return 'diff-status-conflict';
  return 'diff-status-mod'; // M, R и любой прочий будущий код — нейтральный
}

// Раскраска строки диффа (бриф): '+' → --ok, '-' → --err, '@@' → --text-dim,
// остальное → --text-muted. Порядок проверок важен: '@@' не начинается ни с
// '+', ни с '-', так что порядок между первыми тремя не критичен, но '@@'
// проверяем первым для ясности чтения.
function classifyDiffLine(line) {
  if (line.startsWith('@@')) return 'diff-line-hunk';
  if (line.startsWith('+')) return 'diff-line-add';
  if (line.startsWith('-')) return 'diff-line-del';
  return 'diff-line-context';
}

// "diff --git a/<old> b/<new>" → <new> (путь ПОСЛЕ ренейма, если он есть —
// тот же путь, что git-info.js кладёт в files[].path через numstat). Жадный
// .+ в первой группе сам вытолкнет разбор к ПОСЛЕДНЕМУ " b/" в строке — для
// подавляющего большинства путей (без буквального " b/" внутри имени) это
// даёт верный результат даже при пробелах/кириллице в пути (diff/numstat их
// не квотят, см. git-info.js).
const DIFF_GIT_HEADER_RE = /^diff --git a\/.+ b\/(.+)$/;

function extractNewPathFromDiffHeader(line) {
  const m = DIFF_GIT_HEADER_RE.exec(line);
  return m ? m[1] : null;
}

// Та же логика, что truncateDiff() в git-info.js: финальный '\n' не считаем
// отдельной строкой — иначе счётчик «показано N из M» разошёлся бы с тем, что
// реально насчитал main при обрезке (см. truncated.lines).
function splitDiffLines(diffText) {
  const text = diffText || '';
  if (!text) return [];
  const endsWithNl = text.endsWith('\n');
  const rawLines = text.split('\n');
  return endsWithNl ? rawLines.slice(0, -1) : rawLines;
}

function sumCounts(files, key) {
  return files.reduce((sum, f) => sum + (Number(f[key]) || 0), 0);
}

// Untracked-файл, для которого main НЕ смог добрать реальный дифф (бинарник/
// лимит MAX_NEW_FILE_DIFFS/сбой запроса — см. git-info.js). added/removed у
// такого файла — не «настоящий ноль», а «не измеряли» — включать его в общую
// сумму +N −M или в общий счётчик файлов БЕЗ оговорки значило бы молча
// соврать (находка 1, главная тема ревью: «интерфейс утверждает то, чего нет»).
function isUndiffedNewFile(f) {
  return f.status === '?' && !!f.newFileDiffMissing;
}

function formatSummary(snap) {
  const files = snap.files;
  const undiffedNew = files.filter(isUndiffedNewFile);
  // Сумма +N −M — только по файлам, где числа реальные (обычные + успешно
  // добранные untracked); «без диффа» файлы дали бы ложный вклад 0/0, будто
  // у них и правда нет изменений.
  const countedFiles = undiffedNew.length ? files.filter((f) => !isUndiffedNewFile(f)) : files;

  const parts = [];
  parts.push(snap.branch || '(без ветки)');
  parts.push(`+${sumCounts(countedFiles, 'added')} −${sumCounts(countedFiles, 'removed')}`);

  // Находка 9 (ревью фазы 6, минор): formatSummary суммирует по уже
  // урезанному truncateFiles() массиву (макс. 200) — «200 файлов» без
  // оговорки читается как ПОЛНЫЙ итог, хотя ниже панель отдельно показывает
  // «показано 200 из N» ровно затем, чтобы так не получалось.
  const hiddenFiles = (snap.truncated && snap.truncated.files) || 0;
  const filesLabel = `${files.length} ${filesWord(files.length)}${hiddenFiles ? ' (показано)' : ''}`;
  parts.push(filesLabel);

  // Находка 1 (главная тема ревью): вместо того чтобы молча включать
  // «непродифференные» untracked-файлы в общий счёт, называем их отдельно —
  // «· N новых» — та же честность, что и остальные пометки truncated ниже.
  if (undiffedNew.length) parts.push(`${undiffedNew.length} ${newFilesWord(undiffedNew.length)}`);

  if (snap.ahead || snap.behind) {
    const arrows = [];
    if (snap.ahead) arrows.push(`↑${snap.ahead}`);
    if (snap.behind) arrows.push(`↓${snap.behind}`);
    parts.push(arrows.join(' '));
  }
  return parts.join(' · ');
}

// Склонение «файл/файла/файлов» — по-русски, без библиотек (тот же класс
// задачи, что format.js уже решает для токенов/дат в другом месте кода).
function filesWord(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'файл';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'файла';
  return 'файлов';
}

// Склонение «новый/новых» — то же правило, что filesWord() выше, для
// пометки «· N новых» (находка 1).
function newFilesWord(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'новый';
  return 'новых';
}

export function createDiffPanel({ root, api }) {
  let isOpenFlag = false;
  let activeTabId = null;
  let requestSeq = 0; // гард гонки: устаревший ответ (вкладка сменилась, пока летел IPC) не должен перетереть свежий
  let debounceTimer = null;
  let fileAnchors = new Map(); // path → DOM-элемент строки "diff --git" в тексте диффа (для скролла по клику)

  // --- DOM: строится один раз, дальше только точечно обновляется ---

  const headerEl = document.createElement('div');
  headerEl.className = 'diff-panel-header';

  const summaryEl = document.createElement('div');
  summaryEl.className = 'diff-panel-summary';

  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.className = 'action-btn diff-panel-refresh';
  refreshBtn.textContent = 'Обновить';
  // mousedown-preventDefault — тот же приём, что action-btn/dashboard-refresh-btn
  // по всему остальному renderer'у: без него кнопка забирает фокус раньше click.
  refreshBtn.addEventListener('mousedown', (ev) => ev.preventDefault());
  refreshBtn.addEventListener('click', () => refresh({ force: true }));

  headerEl.append(summaryEl, refreshBtn);

  const emptyEl = document.createElement('div');
  emptyEl.className = 'diff-panel-empty hidden';

  const filesEl = document.createElement('div');
  filesEl.className = 'diff-panel-files';

  const truncatedFilesEl = document.createElement('div');
  truncatedFilesEl.className = 'diff-panel-truncated hidden';

  const bodyEl = document.createElement('div');
  bodyEl.className = 'diff-panel-body';
  const diffTextEl = document.createElement('pre');
  diffTextEl.className = 'diff-panel-text';
  bodyEl.appendChild(diffTextEl);

  const truncatedLinesEl = document.createElement('div');
  truncatedLinesEl.className = 'diff-panel-truncated hidden';

  root.append(headerEl, emptyEl, filesEl, truncatedFilesEl, bodyEl, truncatedLinesEl);

  // --- Рендер содержимого ---

  function showEmpty(text) {
    emptyEl.textContent = text;
    emptyEl.classList.remove('hidden');
    filesEl.textContent = '';
    filesEl.classList.add('hidden');
    truncatedFilesEl.classList.add('hidden');
    diffTextEl.textContent = '';
    truncatedLinesEl.classList.add('hidden');
    bodyEl.classList.add('hidden');
    fileAnchors = new Map();
  }

  function hideEmpty() {
    emptyEl.classList.add('hidden');
    filesEl.classList.remove('hidden');
    bodyEl.classList.remove('hidden');
  }

  function scrollToFile(path) {
    const el = fileAnchors.get(path);
    if (el) el.scrollIntoView({ block: 'start' });
  }

  function renderFiles(files) {
    filesEl.textContent = '';
    for (const f of files) {
      const row = document.createElement('div');
      row.className = 'diff-file-row';
      row.tabIndex = 0;
      row.setAttribute('role', 'button');

      const statusEl = document.createElement('span');
      statusEl.className = `diff-file-status ${statusClass(f.status)}`;
      statusEl.textContent = f.status;
      statusEl.title = STATUS_TITLE[f.status] || f.status;

      const pathEl = document.createElement('span');
      pathEl.className = 'diff-file-path';
      pathEl.textContent = f.path;
      pathEl.title = f.path;

      const countsEl = document.createElement('span');
      countsEl.className = 'diff-file-counts';
      // Находка 1 (главная тема ревью): untracked-файл без реально добранного
      // диффа (бинарник/лимит/сбой, см. isUndiffedNewFile выше) НЕ должен
      // показывать «+0 −0» — это выглядит как «нет изменений», хотя на самом
      // деле файл целиком новый, просто содержимое не входит в дифф.
      const undiffedNew = isUndiffedNewFile(f);
      countsEl.textContent = undiffedNew ? 'новый' : `+${f.added} −${f.removed}`;

      row.append(statusEl, pathEl, countsEl);
      if (undiffedNew) {
        // Клик по такой строке — no-op (scrollToFile ниже сам не найдёт якорь,
        // раз для этого файла нет заголовка "diff --git" в тексте), но explicit
        // подсказка честнее, чем молчаливое бездействие.
        row.title = 'содержимое нового файла не входит в дифф';
      }
      row.addEventListener('click', () => scrollToFile(f.path));
      row.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ' || ev.code === 'Space') {
          ev.preventDefault();
          scrollToFile(f.path);
        }
      });
      filesEl.appendChild(row);
    }
  }

  // Рендерит текст диффа построчно (для раскраски + якорей "diff --git" под
  // клик по файлу) и возвращает Map(path → элемент строки заголовка).
  function renderDiffText(diffText) {
    diffTextEl.textContent = '';
    const anchors = new Map();
    const lines = splitDiffLines(diffText);
    for (const line of lines) {
      const div = document.createElement('div');
      div.className = `diff-line ${classifyDiffLine(line)}`;
      // Пустая строка без хотя бы одного пробельного узла схлопывается в
      // высоту 0 в некоторых браузерных движках — неразрывный пробел держит
      // строку видимой, не путается визуально с текстом благодаря white-space:pre.
      div.textContent = line.length ? line : ' ';
      const path = extractNewPathFromDiffHeader(line);
      if (path) anchors.set(path, div);
      diffTextEl.appendChild(div);
    }
    return { anchors, lineCount: lines.length };
  }

  function renderTruncatedNote(el, shown, hidden, unitSingular) {
    if (!hidden) {
      el.classList.add('hidden');
      return;
    }
    el.textContent = `показано ${shown} из ${shown + hidden} ${unitSingular}`;
    el.classList.remove('hidden');
  }

  function render(snap) {
    if (!isOpenFlag) return; // панель закрыта — рисовать некуда и незачем
    if (!snap) {
      // Находка 8 (ревью фазы 6, минор): без явной очистки здесь заголовок
      // ПРЕДЫДУЩЕЙ вкладки продолжал висеть над «нет данных» — единственная
      // ветка render(), которая раньше не трогала summaryEl вообще.
      summaryEl.textContent = '';
      showEmpty('нет данных');
      return;
    }
    if (!snap.ok) {
      summaryEl.textContent = '';
      showEmpty(snap.error === 'git-missing' ? 'git не найден в PATH' : 'не удалось получить статус git');
      return;
    }
    if (!snap.isRepo) {
      summaryEl.textContent = '';
      showEmpty('проект не под git');
      return;
    }

    summaryEl.textContent = formatSummary(snap);

    if (!snap.files.length) {
      showEmpty('изменений нет');
      return;
    }

    hideEmpty();
    renderFiles(snap.files);
    // ВАЖНО (ревью задачи 1): лимиты на список файлов и на текст диффа
    // независимы — при обрезке могут не совпадать, поэтому это ДВЕ отдельные
    // сверки, каждая со своим «показано X из Y».
    const hiddenFiles = (snap.truncated && snap.truncated.files) || 0;
    renderTruncatedNote(truncatedFilesEl, snap.files.length, hiddenFiles, filesWord(snap.files.length + hiddenFiles));

    const { anchors, lineCount } = renderDiffText(snap.diff);
    fileAnchors = anchors;
    const hiddenLines = (snap.truncated && snap.truncated.lines) || 0;
    renderTruncatedNote(truncatedLinesEl, lineCount, hiddenLines, 'строк диффа');
  }

  // --- IPC + обновление ---

  async function refresh({ force = false } = {}) {
    if (!activeTabId) {
      if (isOpenFlag) showEmpty('нет активной вкладки');
      return;
    }
    const seq = ++requestSeq;
    let snap = null;
    try {
      snap = await api.git.get(activeTabId, { force });
    } catch (err) {
      console.warn('[diffpanel] git:get не удался:', err);
      snap = null;
    }
    if (seq !== requestSeq) return; // вкладка сменилась/панель закрылась, пока летел запрос — ответ устарел
    render(snap);
  }

  function scheduleGitChangedRefresh() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      refresh({ force: false });
    }, GIT_CHANGED_DEBOUNCE_MS);
  }

  // --- Публичное API ---

  function open() {
    if (isOpenFlag) return;
    isOpenFlag = true;
    root.classList.remove('hidden');
    refresh({ force: false });
  }

  function close() {
    if (!isOpenFlag) return;
    isOpenFlag = false;
    root.classList.add('hidden');
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  function toggle() {
    if (isOpenFlag) close(); else open();
  }

  function isOpen() {
    return isOpenFlag;
  }

  // Переключение вкладки (app.js/activateTab, в т.ч. null при закрытии
  // последней вкладки) — обновляет содержимое, только если панель открыта;
  // если закрыта, просто запоминает activeTabId на будущее открытие.
  function setActiveTab(tabId) {
    activeTabId = tabId;
    if (isOpenFlag) refresh({ force: false });
  }

  // PostToolUse (см. main/sessions.js → git:changed) — обновляем ТОЛЬКО если
  // панель открыта и событие про ту вкладку, что сейчас показана: событие
  // для фоновой вкладки сейчас неактуально, придёт заново при переключении
  // на неё (setActiveTab уже сама зовёт refresh()).
  function handleGitChanged(tabId) {
    if (!isOpenFlag || tabId !== activeTabId) return;
    scheduleGitChangedRefresh();
  }

  return {
    open, close, toggle, isOpen, setActiveTab, handleGitChanged,
  };
}
