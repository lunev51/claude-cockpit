'use strict';
// Глобальный поиск по истории сессий (Ctrl+Shift+H, Task 3 фазы 7) — оверлей
// по центру окна, тот же скелет DOM/фокуса, что и palette.js (единственный
// владелец своего оверлея; previousActive/fallbackFocus — фокус возвращается
// терминалу активной вкладки при закрытии, см. комментарий в palette.js/open).
//
// Поиск НЕ бесплатный (ревью задачи 2: 1.5–2.2с на 47 реальных сессиях, файлы
// читаются построчно до первого совпадения или до конца) — поэтому здесь
// ОБЯЗАТЕЛЬНЫ: дебаунс ввода, индикатор «Ищу…» и отмена устаревших ответов по
// номеру запроса (requestSeq — растёт на каждый реальный вызов API; ответ,
// чей номер не совпал с текущим requestSeq на момент разрешения промиса,
// молча отбрасывается — новый запрос уже в пути или уже пришёл). Поиск
// запускается только от 2+ символов (MIN_QUERY_LEN).
//
// history:search (main/ipc.js) лениво строит индекс при первом реальном
// вызове (не здесь и не на старте приложения — см. main/ipc.js) и возвращает
// {results, indexSize} — indexSize нужен ЭТОМУ модулю только для того, чтобы
// отличить «ничего не найдено по этому запросу» от «в истории вообще нет ни
// одной сессии» (пустой индекс) — четыре состояния по брифу: «введите 2+
// символа», «ищу…», «ничего не найдено», «индекс пуст».

import { formatShortDate } from './format.js';

const MIN_QUERY_LEN = 2;
const DEBOUNCE_MS = 350; // в диапазоне 300–400мс, требуемом ревью задачи 2
const RESULT_LIMIT = 30;

// Имя проекта — последний сегмент cwd. Renderer не имеет доступа к Node
// 'path' (contextIsolation, nodeIntegration:false) — руками, оба разделителя
// (Windows-транскрипты — основной случай на этой машине, POSIX — на всякий
// случай, если история когда-нибудь переедет), тот же результат, что и
// path.basename(cwd) (см. main/sessions.js — там ровно это для имени вкладки).
function projectNameFromCwd(cwd) {
  if (typeof cwd !== 'string' || !cwd) return null;
  const trimmed = cwd.replace(/[\\/]+$/, '');
  if (!trimmed) return cwd;
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || cwd;
}

// firstUserText/snippet.text теоретически могут нести переносы строк (это
// текст реального сообщения, не наша разметка) — сплющиваем в одну строку
// для превью; CSS (white-space:nowrap + text-overflow:ellipsis) сам обрежет
// визуально, но необрезанные '\n' внутри непрерывной строки не нужны.
function singleLine(text) {
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
}

export function createSearch({ root, api, onOpenResult }) {
  let isOpenFlag = false;
  let overlayEl = null;
  let inputEl = null;
  let listEl = null;
  let previousActive = null;

  let results = [];
  let selected = 0;
  let debounceTimer = null;
  let requestSeq = 0;      // растёт на каждый РЕАЛЬНО отправленный history:search
  let lastIndexSize = null; // null — ещё ни разу не искали; иначе indexSize последнего ответа
  let phase = 'short';      // 'short' | 'searching' | 'results' | 'empty'

  function clearDebounce() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  // snippet.text кусками textContent + <span class="search-hit"> по
  // snippet.ranges (позиции ВНУТРИ snippet.text, см. history-index.js) —
  // НИКАКОГО innerHTML (бриф). Диапазоны от history-index.js уже отсортированы
  // и не пересекаются (buildSnippet/mergeRanges) — защитные проверки здесь
  // просто не дают упасть на гипотетически некорректном ответе IPC.
  function buildSnippetFragment(snippet) {
    const frag = document.createDocumentFragment();
    if (!snippet || typeof snippet.text !== 'string') return frag;
    const { text } = snippet;
    const ranges = Array.isArray(snippet.ranges) ? snippet.ranges : [];
    let cursor = 0;
    for (const r of ranges) {
      if (!Array.isArray(r) || r.length !== 2) continue;
      const [s, e] = r;
      if (typeof s !== 'number' || typeof e !== 'number' || s < cursor || e <= s || e > text.length) continue;
      if (s > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, s)));
      const mark = document.createElement('span');
      mark.className = 'search-hit';
      mark.textContent = text.slice(s, e);
      frag.appendChild(mark);
      cursor = e;
    }
    if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)));
    return frag;
  }

  function renderRow(entry, index) {
    const row = document.createElement('div');
    row.className = 'search-row';
    row.classList.toggle('active', index === selected);
    if (entry.cwd) row.title = entry.cwd;

    const head = document.createElement('div');
    head.className = 'search-row-head';

    const name = document.createElement('span');
    name.className = 'search-row-name';
    name.textContent = projectNameFromCwd(entry.cwd) || 'неизвестный проект';
    head.appendChild(name);

    const date = document.createElement('span');
    date.className = 'search-row-date';
    date.textContent = formatShortDate(entry.mtime);
    head.appendChild(date);
    row.appendChild(head);

    const first = document.createElement('div');
    first.className = 'search-row-first';
    first.textContent = singleLine(entry.firstUserText) || '(без текста)';
    row.appendChild(first);

    const snip = document.createElement('div');
    snip.className = 'search-row-snippet';
    snip.appendChild(buildSnippetFragment(entry.snippet));
    row.appendChild(snip);

    // mousedown-preventDefault — тот же приём, что palette-row: без него
    // клик по строке отбирает фокус у поля ввода раньше click.
    row.addEventListener('mousedown', (ev) => ev.preventDefault());
    row.addEventListener('click', () => openAt(index));
    return row;
  }

  function renderStatus(text) {
    listEl.textContent = '';
    const el = document.createElement('div');
    el.className = 'search-status';
    el.textContent = text;
    listEl.appendChild(el);
  }

  function render() {
    if (phase === 'searching') {
      renderStatus('Ищу…');
      return;
    }
    if (phase === 'short') {
      renderStatus(lastIndexSize === 0 ? 'Индекс пуст' : 'Введите 2+ символа');
      return;
    }
    if (phase === 'empty') {
      renderStatus(lastIndexSize === 0 ? 'Индекс пуст' : 'Ничего не найдено');
      return;
    }
    // phase === 'results'
    listEl.textContent = '';
    results.forEach((entry, i) => listEl.appendChild(renderRow(entry, i)));
    listEl.querySelector('.search-row.active')?.scrollIntoView({ block: 'nearest' });
  }

  function moveSelection(delta) {
    if (phase !== 'results' || !results.length) return;
    selected = (selected + delta + results.length) % results.length;
    render();
  }

  function openAt(index) {
    const entry = results[index];
    if (!entry) return;
    // close() ДО открытия вкладки — тот же порядок, что palette.js/runAt:
    // оверлей уходит с экрана раньше, чем действие начнёт что-то делать.
    close();
    if (!entry.cwd) {
      // history-index.js документирует cwd:null как валидный (реальная
      // сессия без единой записи с полем cwd) — крайне редкий случай на
      // практике (см. task-2-report.md: 47/47 реальных сессий разрешили cwd),
      // но без него --resume некуда открывать.
      console.warn(`[search] у сессии ${entry.sessionId} не разрешился cwd — открыть вкладку невозможно`);
      return;
    }
    // I2 ре-ревью: onOpenResult ОТКРЫВАЕТ ВКЛАДКУ, то есть возвращает промис —
    // синхронный try/catch его reject не видел вовсе, и отказ канала (у
    // невладельца tabs:open отклоняет гард) уходил в unhandled rejection: с
    // точки зрения человека оверлей просто закрывался и не происходило ничего.
    // Promise.resolve — потому что колбэк вправе быть и синхронным.
    try {
      Promise.resolve(onOpenResult(entry.cwd, entry.sessionId)).catch((err) => {
        console.warn('[search] не удалось открыть результат:', err);
      });
    } catch (err) {
      console.warn('[search] не удалось открыть результат:', err);
    }
  }

  function openSelected() {
    if (phase === 'results') openAt(selected);
  }

  async function runSearch(query, seq) {
    let res = null;
    try {
      res = await api.history.search(query, { limit: RESULT_LIMIT });
    } catch (err) {
      console.warn('[search] history:search не удался:', err);
    }
    // Устаревший ответ — новый запрос уже в пути/уже пришёл раньше этого,
    // либо оверлей успел закрыться (close() тоже инкрементит requestSeq) —
    // отбрасываем молча, listEl/inputEl к этому моменту могут быть уже null.
    if (seq !== requestSeq) return;
    if (res && Array.isArray(res.results)) {
      results = res.results;
      if (Number.isInteger(res.indexSize)) lastIndexSize = res.indexSize;
    } else {
      results = [];
    }
    selected = 0;
    phase = results.length ? 'results' : 'empty';
    render();
  }

  function scheduleSearch(query) {
    clearDebounce();
    debounceTimer = setTimeout(() => {
      requestSeq += 1;
      const seq = requestSeq;
      phase = 'searching';
      render();
      runSearch(query, seq);
    }, DEBOUNCE_MS);
  }

  function onInput() {
    const q = inputEl.value.trim();
    if (q.length < MIN_QUERY_LEN) {
      clearDebounce();
      requestSeq += 1; // инвалидируем любой запрос в полёте — его ответ больше не актуален
      results = [];
      selected = 0;
      phase = 'short';
      render();
      return;
    }
    scheduleSearch(q);
  }

  function onInputKeydown(ev) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      close();
    } else if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      moveSelection(1);
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      moveSelection(-1);
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      openSelected();
    }
  }

  // Клик по фону оверлея (не по панели) закрывает поиск — тот же приём, что palette.js.
  function onOverlayMousedown(ev) {
    if (ev.target === overlayEl) close();
  }

  function build() {
    const overlay = document.createElement('div');
    overlay.className = 'search-overlay';

    const panel = document.createElement('div');
    panel.className = 'search-panel';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'search-input';
    input.placeholder = 'Поиск по истории сессий…';
    input.addEventListener('input', onInput);
    input.addEventListener('keydown', onInputKeydown);
    panel.appendChild(input);
    inputEl = input;

    const list = document.createElement('div');
    list.className = 'search-list';
    panel.appendChild(list);
    listEl = list;

    overlay.appendChild(panel);
    overlay.addEventListener('mousedown', onOverlayMousedown);
    return overlay;
  }

  // open(fallbackFocus): тот же контракт, что palette.js/open — fallbackFocus
  // используется, только если document.activeElement на момент открытия не
  // годится сам по себе (см. подробный разбор в palette.js).
  function open(fallbackFocus = null) {
    if (isOpenFlag) return; // повторный Ctrl+Shift+H — app.js сам решает закрыть (toggle)
    const active = document.activeElement;
    previousActive = (active && active !== document.body && document.contains(active))
      ? active
      : fallbackFocus;

    results = [];
    selected = 0;
    phase = 'short';
    isOpenFlag = true;

    overlayEl = build();
    root.appendChild(overlayEl);
    render();
    inputEl.focus();
  }

  function close() {
    if (!isOpenFlag) return;
    isOpenFlag = false;
    clearDebounce();
    // Инвалидирует любой запрос в полёте — его ответ (если ещё придёт) не
    // должен трогать DOM оверлея, который сейчас уходит (listEl/inputEl → null).
    requestSeq += 1;
    overlayEl?.remove();
    overlayEl = null;
    inputEl = null;
    listEl = null;
    results = [];

    const toFocus = previousActive;
    previousActive = null;
    toFocus?.focus?.();
  }

  function isOpen() {
    return isOpenFlag;
  }

  return { open, close, isOpen };
}
