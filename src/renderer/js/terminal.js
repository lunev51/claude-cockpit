// Терминал на xterm.js. UMD-сборки подключены в index.html,
// поэтому берём глобали window.Terminal и window.FitAddon (не import).
//
// copyText — своё копирование с запасным путём: на странице по http (браузер на
// макбуке) Clipboard API не существует, и прямой вызов writeText там падал
// синхронно, мимо .catch (см. clipboard.js).
// createCopyReporter — то же копирование, но с жалобой при отказе: copyText
// возвращал false, и этот false никто не смотрел (см. clipboard.js).
import { createCopyReporter } from './clipboard.js';

// Тост из модуля, который про DOM интерфейса ничего не знает: app.js слушает
// это событие и показывает (тот же приём, что у api-boot.js — импортировать
// app.js отсюда нельзя, будет цикл).
function toast(text, level = 'warn') {
  window.dispatchEvent(new CustomEvent('cockpit:toast', { detail: { text, level } }));
}

// Тема терминала v2: нейтральный чёрный + ANSI-палитра Warp default_dark (MIT).
const THEME = {
  background: '#0F0F0F',
  foreground: '#d8d8d8',
  cursor: '#D97757',
  cursorAccent: '#0F0F0F',
  selectionBackground: '#2A2A2A',
  black: '#181818',
  red: '#ab4642',
  green: '#a1b56c',
  yellow: '#f7ca88',
  blue: '#7cafc2',
  magenta: '#ba8baf',
  cyan: '#86c1b9',
  white: '#d8d8d8',
  brightBlack: '#585858',
  brightRed: '#ab4642',
  brightGreen: '#a1b56c',
  brightYellow: '#f7ca88',
  brightBlue: '#7cafc2',
  brightMagenta: '#ba8baf',
  brightCyan: '#86c1b9',
  brightWhite: '#f8f8f8',
};

// FIX 6 (ревью): SerializeAddon вставляет SGR-сброс (\x1b[0m — возврат к
// дефолтным атрибутам) внутри сериализованного текста при каждом переходе на
// "обычные" атрибуты — это разрушает нашу внешнюю обёртку \x1b[2m ... \x1b[0m
// уже на первом же таком переходе, и «вчерашний» ghost-текст горит в полную
// яркость вместо приглушённой вместо того, чтобы явно отличаться от живого
// вывода. Чиним вырезанием ВСЕХ escape-последовательностей из prelude целиком
// (и CSI-формы вроде цветов/курсора, и OSC-формы вроде заголовка окна) —
// ghost-буфер сознательно платит потерей исходных цветов и стилей ради того,
// чтобы гарантированно остаться монохромно-приглушённым: единственная задача
// этого текста — быть узнаваемо «не живым выводом», а не выглядеть красиво.
function stripAnsi(text) {
  return text
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '');
}

// autoStart (Important ре-ревью фикс-волны финального ревью) — поднимать ли
// pty этой вкладке. true (умолчание) — прежнее поведение: вкладку только что
// создал tabs:open, процесс ей и правда нужен. false — ПОДКЛЮЧЕНИЕ к вкладке,
// у которой процесса уже нет (см. attachTab в app.js): её нельзя стартовать
// молча. sessions.js/start() на вкладке без proc делает spawn БЕЗ --resume —
// флаг resumeOnFirstSpawn одноразовый и давно израсходован, — то есть вместо
// продолжения работы поднялась бы чистая новая сессия, а старая потерялась
// бы. Штатный Ctrl+Shift+R (term.restart) сессию бережёт: он резюмит
// известный sessionId. Подключение не имеет права вести себя хуже рестарта.
export function initTerminal(container, config, {
  tabId, onPtyStatus, onFontSize = () => {}, preludeText = null, autoStart = true,
  // Перезапуск по Ctrl+Shift+R отдаём наружу: проверка управления и объяснение
  // отказа живут в app.js, а импортировать его отсюда нельзя — цикл.
  onRestartRequest = null,
}) {
  const cfg = config.terminal;
  const term = new window.Terminal({
    fontSize: cfg.fontSize,
    fontFamily: cfg.fontFamily,
    scrollback: cfg.scrollback,
    cursorBlink: true,
    allowProposedApi: true,
    theme: THEME,
    // Выделение мышью, когда приложение перехватило мышь. Claude Code включает
    // отслеживание мыши (в потоке pty: CSI ?1000h/?1002h/?1003h/?1006h), и с
    // этого момента xterm отдаёт мышь приложению, а своё выделение не строит:
    // протяжка мышью НИЧЕГО не выделяет, значит копировать нечего — молчат и
    // «копировать выделением», и Cmd+C (getSelection пуст).
    //
    // Обойти перехват можно только «форсированным» выделением, и клавиша у
    // него разная: xterm смотрит `isMac ? altKey && macOptionClickForcesSelection
    // : shiftKey`. На Windows Shift+протяжка работает всегда, а на маке — ТОЛЬКО
    // с этой опцией, у которой дефолт false. Без неё на макбуке выделить текст
    // в работающей сессии Claude Code нельзя ничем (живая жалоба 11.08:
    // «при выделении ничего в буфер не уходит, правой кнопкой копируется
    // только слово» — слово даёт rightClickSelectsWord, он на macOS включён
    // по умолчанию и подменяет выделение словом под курсором).
    macOptionClickForcesSelection: true,
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

  // Сериализация буфера в ANSI-текст (Task 5, ghost-буферы) — лёгкий аддон,
  // грузим безусловно (без конфиг-флага): app.js использует его снимки при
  // сохранении «вчерашнего вывода» и восстановлении вкладки.
  const serializeAddon = new window.SerializeAddon.SerializeAddon();
  term.loadAddon(serializeAddon);

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
  // Fix 6 (ревью): инлайн-стили были зашиты хексами мимо дизайн-токенов —
  // cssText прекрасно принимает custom properties, заменяем на var(--...).
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
    'background:var(--bg-panel)',
    'border:1px solid var(--border)',
    'border-radius:6px',
    'color:var(--text)',
    'font-family:var(--font-ui)',
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
    'color:var(--text)',
    'font-size:12px',
  ].join(';');

  const mkBtn = (label) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = [
      'border:none',
      'background:transparent',
      'color:var(--text-dim)',
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
  //
  // copyText вместо navigator.clipboard.writeText напрямую (жалоба 09.08: с
  // макбука нельзя скопировать текст). На странице по http Clipboard API не
  // существует вовсе, и прежний вызов обращался к свойству undefined —
  // исключение синхронное, .catch() его не ловил, копирование падало молча.
  // Одна жалоба на все пути копирования этой вкладки: у репортёра есть память
  // о последнем тосте, и «копировать выделением» не спамит (см. clipboard.js).
  const copyOrComplain = createCopyReporter({ notify: (text) => toast(text) });

  if (cfg.copyOnSelect) {
    term.onSelectionChange(() => {
      const sel = term.getSelection();
      // throttle: xterm зовёт это на каждое изменение выделения — за одну
      // протяжку мышью десятки раз.
      if (sel) copyOrComplain(sel, { throttle: true });
    });
  }

  // --- правый клик: копировать выделение или вставить (rightClickPaste) ---
  container.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    if (term.hasSelection()) {
      copyOrComplain(term.getSelection());
      term.clearSelection();
    } else if (cfg.rightClickPaste) {
      // По сети страница отдаётся по http, а Clipboard API живёт только в
      // защищённом контексте: navigator.clipboard там НЕ СУЩЕСТВУЕТ, и это
      // обращение к свойству undefined — синхронный TypeError мимо .catch.
      // Тот же баг, что чинили для записи (#30), для чтения оставался: правый
      // клик без выделения тихо падал с исключением. Гард такой же, как в
      // ветке Ctrl+V ниже, но здесь ещё и объясняем, чем вставлять.
      if (!navigator.clipboard || !navigator.clipboard.readText) {
        toast('вставка правым кликом работает только в окне на ПК — по сети жми Cmd+V (Ctrl+V)');
        return;
      }
      navigator.clipboard.readText()
        .then((text) => { if (text) term.paste(text); })
        .catch((err) => console.warn('[вставка] буфер обмена недоступен:', err && err.message));
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

    // Ctrl+Shift+R — перезапуск завершённого процесса. Идёт через колбэк, а не
    // напрямую в window.api: это ТРЕТЬЯ дверь к одному действию (кнопка ⟳ и
    // палитра — первые две), и она обязана проверять управление и объяснять
    // отказ теми же словами. Раньше слала term:restart сама и у клиента без
    // управления молча не срабатывала — ровно находка B1, только замеченная
    // уже на ревью её фикса.
    //
    // Колбэк, а не импорт: app.js импортирует этот модуль, обратный импорт дал
    // бы цикл. Тот же приём, что у autoStart/onPtyStatus выше.
    if (ev.ctrlKey && ev.shiftKey && !ev.altKey && !ev.metaKey
        && (ev.key === 'R' || ev.key === 'r' || ev.code === 'KeyR')) {
      ev.preventDefault();
      if (typeof onRestartRequest === 'function') onRestartRequest(tabId);
      else window.api.term.restart(tabId); // модуль подняли без колбэка — прежнее поведение
      return false;
    }

    // Ctrl+Shift+C — копировать выделение. И Cmd+C для макбука: там Ctrl+C
    // остаётся прерыванием (SIGINT), как в любом терминале, а копирование
    // человек жмёт командной клавишей. Раньше эта комбинация не
    // обрабатывалась вовсе — xterm держит выделение своё, а не документа,
    // поэтому браузеру на Cmd+C копировать было нечего.
    if (((ev.ctrlKey && ev.shiftKey) || (ev.metaKey && !ev.ctrlKey)) && !ev.altKey
        && (ev.key === 'C' || ev.key === 'c' || ev.code === 'KeyC')) {
      const sel = term.getSelection();
      if (sel) {
        // Без throttle: человек нажал клавишу и ждёт результата — молчать
        // здесь нельзя даже один раз.
        copyOrComplain(sel);
        ev.preventDefault();
        return false;
      }
      // Выделения нет — не мешаем: Cmd+C без выделения человек жмёт не нам.
      return true;
    }

    // Вставка из буфера обмена. Task 4 фазы 4: сначала пробуем скриншот —
    // screenshot:paste смотрит cwd этой вкладки и решает, картинка в буфере
    // или нет (renderer напрямую этого не узнает, Clipboard API из текста
    // картинку не отличает). Путь вставляем БЕЗ \r — пользователь сам допишет
    // остаток строки и отправит. null (не картинка) или ошибка IPC — падаем
    // на прежнюю текстовую вставку.
    //
    // Ctrl+V (без Shift) добавлен 05.08 по жалобе пользователя. По умолчанию
    // xterm поступает как классический терминал: шлёт Ctrl+V в pty
    // управляющим символом (0x16, literal-next), и вставки не происходит.
    // Привычка же у человека из редакторов и Claude Code Desktop — там Ctrl+V
    // вставляет. Ctrl+Shift+V остаётся, он привычен из терминалов.
    // Цена: 0x16 в pty больше не отправить с клавиатуры. Это осознанно —
    // literal-next в Claude Code не используется, а вставка нужна постоянно.
    if (ev.ctrlKey && !ev.altKey && !ev.metaKey
        && (ev.key === 'V' || ev.key === 'v' || ev.code === 'KeyV')) {
      // Браузер на макбуке получает страницу по http:// — а Clipboard API живёт
      // только в защищённом контексте (https или localhost), там
      // navigator.clipboard попросту undefined. Перехватывать в такой среде
      // нельзя: мы бы отменили ЕДИНСТВЕННЫЙ рабочий путь. Возврат false без
      // preventDefault означает «xterm, не трогай эту клавишу» — браузер
      // вставит сам, а xterm поймает готовое событие paste на своей textarea.
      // (Пока не сделан HTTPS через Tailscale Serve — это план 4 — так и
      // работает вставка на удалённой машине.)
      if (!navigator.clipboard || !navigator.clipboard.readText) return false;
      ev.preventDefault();
      window.api.screenshot.paste(tabId)
        .catch(() => null)
        .then((res) => {
          if (res && res.path) {
            // Fix (ревью): проект в папке с пробелом в имени («My Projects»)
            // даёт Claude ДВА аргумента вместо одного пути — без кавычек
            // командная строка (и сам Claude Code) режет путь по пробелу.
            const p = res.path;
            term.paste(/\s/.test(p) ? `"${p}"` : p);
            return;
          }
          navigator.clipboard.readText()
            .then((text) => { if (text) term.paste(text); })
            // Молчать здесь нельзя: ровно так вставка и умерла незаметно —
            // обработчик разрешений отклонял clipboard-read, а .catch(() => {})
            // прятал NotAllowedError. Теперь отказ виден хотя бы в консоли.
            .catch((err) => console.warn('[вставка] буфер обмена недоступен:', err && err.message));
        });
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

  // Ghost-буфер (Task 5): вчерашний скроллбек, приглушённый, ДО старта живого
  // pty — восстановленная вкладка мгновенно показывает контекст, пока за
  // кулисами поднимается (или резюмится) настоящая сессия Claude Code.
  if (preludeText) {
    term.write('\x1b[2m');
    term.write(stripAnsi(preludeText));
    term.write('\x1b[0m\r\n\x1b[2m— вчерашний вывод · сессия поднимается —\x1b[0m\r\n');
  }

  // --- статус и запуск PTY ---
  // Единственное место, откуда renderer вообще просит поднять процесс, —
  // поэтому гард стоит здесь, а не у вызывающего: любой будущий путь создания
  // терминала проходит через эту строку.
  if (autoStart) {
    onPtyStatus('запускается…');
    window.api.term.start(tabId, term.cols, term.rows);
  } else {
    // Процесса нет и поднимать его мы не просим. alive остаётся false — ввод
    // заблокирован (см. term.onData ниже), человек сам решит, перезапускать
    // ли вкладку: Ctrl+Shift+R резюмит её сессию, а не заводит новую.
    //
    // Это ТОЛЬКО состояние для вызывающего: onPtyStatus кладёт строку в
    // entry.lastPtyStatus (app.js), а его сейчас никто не отображает. Видимую
    // подпись пишет в сам терминал attachTab — после истории, чтобы она не
    // уехала вверх (см. app.js).
    onPtyStatus('процесс не запущен — Ctrl+Shift+R для перезапуска');
  }

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
  return {
    term,
    search,
    setFontSize,
    focus: () => term.focus(),
    openSearch,
    handlers,
    // Пересчитать геометрию и сообщить её pty ПРИНУДИТЕЛЬНО. ResizeObserver
    // выше срабатывает только когда меняется сам контейнер, а при возврате
    // управления с другой машины он не меняется вовсе: окно то же, размеры те
    // же. При этом pty всё это время стоял в размере макбука, и весь вывод
    // Claude Code форматировался под него — в окне ПК картинка разъезжалась,
    // и лечилось это лишь ручным ресайзом окна (живая жалоба 05.08).
    // Возвращает применённый размер, чтобы вызывающий мог его залогировать.
    refit: () => {
      fit.fit();
      window.api.term.resize(tabId, term.cols, term.rows);
      return { cols: term.cols, rows: term.rows };
    },
    // Ghost-снимок буфера (Task 5): scrollback:2000 — достаточно контекста для
    // «о чём мы говорили», не раздувая ghost-файл на диске.
    serialize: () => serializeAddon.serialize({ scrollback: 2000 }),
    // Task 6: закрытие вкладки должно гасить и ResizeObserver — он раньше
    // не отключался (наблюдатель на удалённом из DOM container продолжал
    // жить, утечка на каждое закрытие/переоткрытие вкладки).
    dispose: () => {
      observer.disconnect();
      term.dispose();
    },
  };
}
