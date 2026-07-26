// Терминал на xterm.js. UMD-сборки подключены в index.html,
// поэтому берём глобали window.Terminal и window.FitAddon (не import).

// Тёплая тёмная палитра Cockpit (спека §7): фон окна, кремовый текст,
// терракотовый курсор. ANSI-цвета подогнаны под тёплую гамму.
const THEME = {
  background: '#141413',
  foreground: '#E8E6E1',
  cursor: '#D97757',
  cursorAccent: '#141413',
  selectionBackground: '#3A3733',
  black: '#1F1E1B',
  red: '#C64545',
  green: '#5DB872',
  yellow: '#E8A55A',
  blue: '#8CA8C8',
  magenta: '#B08BBF',
  cyan: '#5DB8A6',
  white: '#A09D96',
  brightBlack: '#57544E',
  brightRed: '#D97781',
  brightGreen: '#7BC98F',
  brightYellow: '#EFBE7E',
  brightBlue: '#A6BDD8',
  brightMagenta: '#C5A3D1',
  brightCyan: '#7FCDBD',
  brightWhite: '#FAF9F5',
};

export function initTerminal(container, config, { tabId, onPtyStatus, onFontSize = () => {} }) {
  const cfg = config.terminal;
  const term = new window.Terminal({
    fontSize: cfg.fontSize,
    fontFamily: cfg.fontFamily,
    scrollback: cfg.scrollback,
    cursorBlink: true,
    allowProposedApi: true,
    theme: THEME,
    // ВАЖНО: windowsPty/unicode11 НЕ включать — рассинхрон позиций с ConPTY
    // даёт осиротевшие глифы при перерисовке ghost-подсказок Claude Code.
  });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);

  // Кликабельные ссылки: открываем системным браузером через Electron-мост,
  // дефолтный window.open в Electron недопустим.
  term.loadAddon(new window.WebLinksAddon.WebLinksAddon(
    (event, uri) => window.api.shell.openExternal(uri),
  ));

  // Поиск по буферу (UI создаётся ниже динамически).
  const search = new window.SearchAddon.SearchAddon();
  term.loadAddon(search);

  // Unicode-11 ширины: ТОЛЬКО по явному флагу. ConPTY считает ширины по
  // собственной таблице — при расхождении xterm рисует символы в чужие клетки.
  if (cfg.unicode11 === true) {
    try {
      term.loadAddon(new window.Unicode11Addon.Unicode11Addon());
      term.unicode.activeVersion = '11';
    } catch (err) {
      console.warn('[terminal] unicode11 недоступен:', err.message);
    }
  }

  term.open(container);

  // WebGL-рендерер: быстрее DOM, но замечен артефакт с ghost-подсказками
  // Claude Code (первый введённый символ уезжает за поле ввода) —
  // поэтому отключаем по умолчанию; включение: terminal.webgl=true в конфиге.
  if (cfg.webgl === true) {
    try {
      const webgl = new window.WebglAddon.WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch (err) {
      console.warn('[terminal] WebGL недоступен, использую DOM-рендерер:', err.message);
    }
  }

  fit.fit();

  // --- состояние PTY: alive=true между onStarted и onExit ---
  let alive = false;

  // --- панель поиска (создаётся динамически внутри container) ---
  const searchBar = document.createElement('div');
  searchBar.style.cssText = [
    'position:absolute',
    'top:8px',
    'right:12px',
    'z-index:10',
    'display:none',
    'align-items:center',
    'gap:4px',
    'padding:4px 6px',
    'background:#1F1E1B',
    'border:1px solid #3A3733',
    'border-radius:6px',
    'color:#FAF9F5',
    'font-family:sans-serif',
    'font-size:12px',
  ].join(';');

  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = 'Поиск…';
  searchInput.style.cssText = [
    'width:180px',
    'border:none',
    'outline:none',
    'background:transparent',
    'color:#FAF9F5',
    'font-size:12px',
  ].join(';');

  const mkBtn = (label) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = [
      'border:none',
      'background:transparent',
      'color:#8F8D83',
      'cursor:pointer',
      'font-size:12px',
      'padding:2px 4px',
    ].join(';');
    return b;
  };
  const btnPrev = mkBtn('▲');
  const btnNext = mkBtn('▼');
  const btnClose = mkBtn('✕');

  searchBar.append(searchInput, btnPrev, btnNext, btnClose);
  // container должен быть позиционирован для абсолютной панели.
  if (getComputedStyle(container).position === 'static') {
    container.style.position = 'relative';
  }
  container.appendChild(searchBar);

  let searchOpen = false;
  const doFindNext = () => { if (searchInput.value) search.findNext(searchInput.value); };
  const doFindPrev = () => { if (searchInput.value) search.findPrevious(searchInput.value); };
  const openSearch = () => {
    searchOpen = true;
    searchBar.style.display = 'flex';
    searchInput.focus();
    searchInput.select();
  };
  const closeSearch = () => {
    searchOpen = false;
    searchBar.style.display = 'none';
    term.focus();
  };

  btnNext.addEventListener('click', doFindNext);
  btnPrev.addEventListener('click', doFindPrev);
  btnClose.addEventListener('click', closeSearch);
  searchInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      if (ev.shiftKey) doFindPrev(); else doFindNext();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      closeSearch();
    }
  });

  // --- копирование выделения в буфер обмена (copyOnSelect) ---
  if (cfg.copyOnSelect) {
    term.onSelectionChange(() => {
      const sel = term.getSelection();
      if (sel) navigator.clipboard.writeText(sel).catch(() => {});
    });
  }

  // --- правый клик: копировать выделение или вставить (rightClickPaste) ---
  container.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    if (term.hasSelection()) {
      navigator.clipboard.writeText(term.getSelection()).catch(() => {});
      term.clearSelection();
    } else if (cfg.rightClickPaste) {
      navigator.clipboard.readText()
        .then((text) => { if (text) term.paste(text); })
        .catch(() => {});
    }
  });

  // --- размер шрифта: Ctrl+«+»/«−»/«0» и Ctrl+колесо ---
  let fontSize = cfg.fontSize;
  let persistTimer = null;
  const setFontSize = (size) => {
    fontSize = Math.min(32, Math.max(8, Math.round(size)));
    term.options.fontSize = fontSize;
    fit.fit();
    window.api.term.resize(tabId, term.cols, term.rows);
    onFontSize(fontSize);
    // Персист размера шрифта в конфиг с дебаунсом.
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      window.api.config.set({ terminal: { fontSize } });
    }, 400);
  };

  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown') return true;

    // Ctrl+Shift+R — перезапуск завершённого процесса.
    if (ev.ctrlKey && ev.shiftKey && !ev.altKey && !ev.metaKey
        && (ev.key === 'R' || ev.key === 'r' || ev.code === 'KeyR')) {
      ev.preventDefault();
      window.api.term.restart(tabId);
      return false;
    }

    // Ctrl+Shift+C — копировать выделение.
    if (ev.ctrlKey && ev.shiftKey && !ev.altKey && !ev.metaKey
        && (ev.key === 'C' || ev.key === 'c' || ev.code === 'KeyC')) {
      const sel = term.getSelection();
      if (sel) {
        navigator.clipboard.writeText(sel).catch(() => {});
        ev.preventDefault();
        return false;
      }
      return true;
    }

    // Ctrl+Shift+V — вставить из буфера обмена.
    if (ev.ctrlKey && ev.shiftKey && !ev.altKey && !ev.metaKey
        && (ev.key === 'V' || ev.key === 'v' || ev.code === 'KeyV')) {
      ev.preventDefault();
      navigator.clipboard.readText()
        .then((text) => { if (text) term.paste(text); })
        .catch(() => {});
      return false;
    }

    // Ctrl+Shift+F — открыть поиск.
    if (ev.ctrlKey && ev.shiftKey && !ev.altKey && !ev.metaKey
        && (ev.key === 'F' || ev.key === 'f' || ev.code === 'KeyF')) {
      ev.preventDefault();
      openSearch();
      return false;
    }

    // Размер шрифта: Ctrl (без Shift/Alt/Meta), сравнение по key и code
    // (e.code независим от раскладки клавиатуры).
    if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && !ev.metaKey) {
      if (ev.key === '+' || ev.key === '=' || ev.code === 'Equal' || ev.code === 'NumpadAdd') {
        setFontSize(fontSize + 1); return false;
      }
      if (ev.key === '-' || ev.key === '_' || ev.code === 'Minus' || ev.code === 'NumpadSubtract') {
        setFontSize(fontSize - 1); return false;
      }
      if (ev.key === '0' || ev.code === 'Digit0' || ev.code === 'Numpad0') {
        setFontSize(cfg.fontSize); return false;
      }
    }

    return true;
  });

  container.addEventListener('wheel', (ev) => {
    if (!ev.ctrlKey) return;
    ev.preventDefault();
    setFontSize(fontSize + (ev.deltaY < 0 ? 1 : -1));
  }, { passive: false });

  // Фокус по клику на контейнер (если поиск не открыт).
  container.addEventListener('mousedown', (ev) => {
    if (searchOpen) return;
    if (searchBar.contains(ev.target)) return;
    term.focus();
  });

  // --- статус и запуск PTY ---
  onPtyStatus('запускается…');
  window.api.term.start(tabId, term.cols, term.rows);

  // Двусторонний поток: клавиатура → PTY (только при живом процессе), PTY → экран.
  term.onData((data) => { if (alive) window.api.term.write(tabId, data); });

  // Подгонка размеров при изменении контейнера (с дебаунсом ~100 мс).
  let resizeTimer = null;
  const observer = new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      fit.fit();
      window.api.term.resize(tabId, term.cols, term.rows);
    }, 100);
  });
  observer.observe(container);

  // Приём маршрутизированных событий (диспатч по tabId делает app.js).
  const handlers = {
    onData: (data) => term.write(data),
    onStarted: ({ pid }) => {
      alive = true;
      onPtyStatus(`работает · pid ${pid}`);
    },
    onExit: ({ exitCode }) => {
      alive = false;
      onPtyStatus(`процесс завершён (код ${exitCode})`);
      term.write(`\r\n\x1b[31m[процесс завершён (код ${exitCode}) — Ctrl+Shift+R для перезапуска]\x1b[0m\r\n`);
    },
  };
  term.focus();
  return { term, search, setFontSize, focus: () => term.focus(), openSearch, handlers };
}
