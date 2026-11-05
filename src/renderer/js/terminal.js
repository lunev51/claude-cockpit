// Терминал на xterm.js. UMD-сборки подключены в index.html,
// поэтому берём глобали window.Terminal и window.FitAddon (не import).
//
// copyText — своё копирование с запасным путём: на странице по http (браузер на
// макбуке) Clipboard API не существует, и прямой вызов writeText там падал
// синхронно, мимо .catch (см. clipboard.js).
// createCopyReporter — то же копирование, но с жалобой при отказе: copyText
// возвращал false, и этот false никто не смотрел (см. clipboard.js).
import { createCopyReporter } from './clipboard.js';
// fittedSize — «подогнан ли терминал»: в pty уходит только такой размер (см.
// measure() ниже и term-size.js).
import { fittedSize } from './term-size.js';

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
// молча. Перезапуск мёртвой вкладки — решение человека (Ctrl+Shift+R), а не
// побочный эффект подключения; почему — в shouldStartPty (attach-guards.js).
//
// onPtyStatus/onFontSize — необязательные: строку состояния и размер шрифта
// сейчас никто не показывает (app.js их не передаёт, ревью 09.08, C19).
export function initTerminal(container, config, {
  tabId, onPtyStatus = () => {}, onFontSize = () => {}, preludeText = null, autoStart = true,
  // Перезапуск по Ctrl+Shift+R отдаём наружу: проверка управления и объяснение
  // отказа живут в app.js, а импортировать его отсюда нельзя — цикл.
  onRestartRequest = null,
  // Подогнанная сетка этой вкладки, только что отправленная в pty, — наружу:
  // app.js раздаёт её скрытым вкладкам (adoptGrid ниже).
  onGrid = () => {},
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

  // Подогнать терминал под контейнер и сказать, удалось ли. null — НЕ подогнан
  // (контейнер скрыт или нулевой), и тогда сообщать pty нечего: term.cols в
  // этот момент — умолчание xterm 80×24, а не размер окна. Запись кадров на
  // стенде 05.11: именно такие 80×24 уходили из term:start скрытой вкладки и
  // из её ResizeObserver, и main раздавал их сессиям.
  //
  // fit() — только ПОСЛЕ проверки: на контейнере 0×0 (свёрнутое окно) FitAddon
  // предлагает 2×1 и честно ужал бы сам xterm, переложив буфер в две колонки.
  //
  // Область под клетки — по СОДЕРЖИМОМУ контейнера, из того же
  // getComputedStyle, что читает FitAddon (при box-sizing: content-box у
  // .term-view это область без отступа; у display:none — 'auto', то есть NaN).
  // НЕ clientWidth/clientHeight: они включают отступ .term-view (4px 0 0 8px),
  // и ревью в Chrome поймало цену — хост 0×0 давал 8×4, хост 0×500 — 8×500, и
  // зажатые 2×1 / 2×29 уходили в pty, а A6 разносил их по скрытым вкладкам.
  // Полоса прокрутки вычитается так же, как в addon-fit 0.11.0
  // (proposeDimensions): 0 без прокрутки, иначе ширина overviewRuler или 14.
  const cellArea = () => {
    const cs = getComputedStyle(container);
    const scrollbar = term.options.scrollback === 0 ? 0 : (term.options.overviewRuler?.width || 14);
    return { width: parseFloat(cs.width) - scrollbar, height: parseFloat(cs.height) };
  };
  // Ячейка, по которой FitAddon считает сетку (_core в нём же, см. addon-fit).
  const cellNow = () => {
    const c = term._core?._renderService?.dimensions?.css?.cell;
    return c ? { width: c.width, height: c.height } : null;
  };
  // Размер СИМВОЛА последней подгонки — по нему посчитана текущая сетка.
  // Сверяет его onFontsLoaded ниже: xterm перемеряет символ и сам (после
  // ресайза), и тогда «до и после моего замера» уже одинаковы, хотя сетка
  // посчитана по старому.
  //
  // Символ (_charSizeService), а не ячейка рендера: ячейку DOM-рендерер
  // пересчитывает от числа колонок — round(device.cell · cols / dpr) / cols
  // (DomRenderer._updateDimensions, xterm 6.0.0), — и после любой подгонки
  // она «изменилась» сама по себе. Ре-ревью: догрузка чужого шрифта слала
  // ресайз в 186 случаях из 200. Символ от сетки не зависит — только от
  // шрифта.
  const charNow = () => {
    const c = term._core?._charSizeService;
    return c ? { width: c.width, height: c.height } : null;
  };
  let fittedChar = null;
  const measure = () => {
    const char = charNow();
    const size = fittedSize(fit.proposeDimensions(), cellArea(), cellNow());
    if (size) {
      fit.fit();
      fittedChar = char;
    }
    return size;
  };

  // Единственная дверь размера в pty — и только с результатом measure().
  // Тот же размер уходит наружу (onGrid): main применяет его ко ВСЕМ pty
  // (termResizeHandler в ipc.js), и скрытые xterm должны стоять в той же
  // сетке, иначе вывод фоновой сессии ляжет в чужую.
  const sendSize = (s) => {
    window.api.term.resize(tabId, s.cols, s.rows);
    onGrid(s);
  };

  measure();

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
    // Ревью 09.08 (C10): Enter/Esc панели слушает только поле ввода, а клик
    // по кнопке на mousedown уводил фокус на неё — после ▼ мышью клавиши
    // были мертвы. preventDefault — тот же приём, что строки палитры и
    // кнопка дашборда; click доходит как обычно.
    // focus() в поле — не лишний (ревью ветки): без него фокус остаётся, где
    // был. Кликнул в терминал, потом ▼, потом Esc — и Esc уходит в claude как
    // \x1b, прерывая генерацию. Клик по кнопке панели — работа с панелью.
    b.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      searchInput.focus();
    });
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
  const persistFontSize = () => {
    persistTimer = null;
    window.api.config.set({ terminal: { fontSize } });
  };
  const setFontSize = (size) => {
    fontSize = Math.min(32, Math.max(8, Math.round(size)));
    term.options.fontSize = fontSize;
    const s = measure();
    if (s) sendSize(s);
    onFontSize(fontSize);
    // Персист размера шрифта в конфиг с дебаунсом.
    clearTimeout(persistTimer);
    persistTimer = setTimeout(persistFontSize, 400);
  };

  term.attachCustomKeyEventHandler((ev) => {
    // Клавиша уже обработана выше по пути (ре-ревью ветки): оверлей поверх
    // терминала закрылся по Esc и позвал preventDefault. xterm сам
    // defaultPrevented не смотрит — _keyDown зовёт этот обработчик и дальше
    // шлёт в pty. Без этой строки при фокусе в терминале тот же Esc уходил в
    // claude как \x1b и прерывал генерацию. preventDefault без stopPropagation
    // до терминала зовут только Esc оверлеев, Enter/Esc restore и Ctrl+Enter
    // peek — все не для pty; хоткеи bindHotkeys сюда не доходят вовсе.
    if (ev.defaultPrevented) return false;
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
  //
  // Размер — только подогнанный, иначе null: вкладка создаётся в СКРЫТОМ
  // контейнере (app.js: 'term-view hidden'), и term.cols здесь почти всегда
  // умолчание 80×24. Без размера main поднимет процесс в размере владельца
  // (resolveStartSize в ipc.js), а первый видимый fit его уточнит.
  if (autoStart) {
    onPtyStatus('запускается…');
    const started = measure();
    window.api.term.start(tabId, started ? started.cols : null, started ? started.rows : null);
  } else {
    // Процесса нет и поднимать его мы не просим. alive остаётся false — ввод
    // заблокирован (см. term.onData ниже), человек сам решит, перезапускать
    // ли вкладку: Ctrl+Shift+R резюмит известную сессию, а без неё откроет
    // пикер --resume (sessions.js/restart) — чистой новой молча не заведёт.
    //
    // Это ТОЛЬКО состояние для вызывающего, и сейчас его никто не
    // отображает. Видимую подпись пишет в сам терминал attachTab — после
    // истории, чтобы она не уехала вверх (см. app.js).
    onPtyStatus('процесс не запущен — Ctrl+Shift+R для перезапуска');
  }

  // Двусторонний поток: клавиатура → PTY (только при живом процессе), PTY → экран.
  term.onData((data) => { if (alive) window.api.term.write(tabId, data); });

  // Подгонка размеров при изменении контейнера (с дебаунсом ~100 мс).
  //
  // Наблюдатель срабатывает и у СКРЫТОЙ вкладки — переход в display:none тоже
  // смена размера (в 0×0). Раньше размер уходил безусловно: fit() там no-op, и
  // pty получал умолчание xterm 80×24, а main запоминал его как размер
  // владельца. Теперь скрытая вкладка молчит, а при показе наблюдатель
  // сработает снова — уже на настоящем контейнере.
  let resizeTimer = null;
  const observer = new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const s = measure();
      if (s) sendSize(s);
    }, 100);
  });
  observer.observe(container);

  // Шрифт догрузился ПОСЛЕ замера ячейки. xterm 6 перемеряет ячейку только в
  // _afterResize, при смене опций шрифта и смене DPR — догрузку вшитого
  // JetBrains Mono он не замечает. Ячейка остаётся посчитанной по запасному
  // шрифту (Menlo на маке ниже на ~12% по высоте строки), fit считает строки
  // по ней, и нижние строки — статус-бар Claude Code — уезжают за край.
  // app.js ждёт шрифт до первого терминала (waitForFont), но ожидание
  // ограничено 3 с: медленная сеть до макбука догрузит его позже — это ловим
  // здесь.
  //
  // Публичного перемера в xterm 6 нет. _core._charSizeService.measure() —
  // ровно то, что xterm зовёт сам (open, _afterResize, смена DPR); синхронно
  // обновляет размеры рендера через onCharSizeChange, после чего
  // proposeDimensions уже видит новую ячейку. В _core ходит и сам FitAddon
  // (_renderService.dimensions), так что зависимость не новая; optional
  // chaining — чтобы другая версия xterm без этого поля не роняла терминал.
  //
  // Событие приходит на ЛЮБОЙ догруженный шрифт (Inter интерфейса, жирное
  // начертание при первом жирном тексте) — шлём размер, только если символ
  // отличается от того, по которому посчитана текущая сетка (fittedChar в
  // measure): иначе каждый такой шрифт гонял бы ресайз всех pty.
  //
  // Сверка именно с символом последней подгонки, а не «до и после своего
  // замера» (замечание ревью): если между догрузкой и событием прошёл ресайз,
  // xterm уже перемерил символ сам (_afterResize), а строки fit посчитал по
  // старому. Замер здесь тогда ничего не меняет — но сетка всё равно неверна.
  // Ни разу не подогнанному терминалу пересчитывать нечего: его первая
  // подгонка возьмёт уже новый символ.
  const onFontsLoaded = () => {
    term._core?._charSizeService?.measure?.();
    if (!fittedChar) return;
    const char = charNow();
    if (!char || (char.width === fittedChar.width && char.height === fittedChar.height)) return;
    const s = measure();
    if (s) sendSize(s);
    term.refresh(0, term.rows - 1);
  };
  document.fonts?.addEventListener?.('loadingdone', onFontsLoaded);

  // Приём маршрутизированных событий (диспатч по tabId делает app.js).
  const handlers = {
    onData: (data) => term.write(data),
    onStarted: ({ pid }) => {
      alive = true;
      onPtyStatus(`работает · pid ${pid}`);
    },
    // print:false — состояние сразу, строку о выходе печатает вызывающий
    // позже: app.js ставит её в очередь после истории, пока та едет
    // (deliverTermExit в attach-guards.js, ревью ветки screen-mirror, m4).
    onExit: ({ exitCode }, { print = true } = {}) => {
      alive = false;
      onPtyStatus(`процесс завершён (код ${exitCode})`);
      const banner = `\r\n\x1b[31m[процесс завершён (код ${exitCode}) — Ctrl+Shift+R для перезапуска]\x1b[0m\r\n`;
      if (print) term.write(banner);
      return banner;
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
    // Возвращает применённый размер {cols, rows} — или null, если терминал не
    // подогнан (контейнер скрыт/нулевой): тогда в pty не ушло ничего, и
    // вызывающий (app.js: termSize для захвата управления) обязан считать, что
    // размера у него нет, а не подставлять умолчание xterm.
    refit: () => {
      const s = measure();
      if (s) sendSize(s);
      return s;
    },
    // Сетка видимой вкладки — для СКРЫТОЙ. Подогнаться сама скрытая вкладка не
    // может (контейнер display:none), а её pty main уже переразмерил вместе со
    // всеми (termResizeHandler в ipc.js). Без этого вывод фоновой сессии ложился
    // в чужую сетку (у ни разу не показанной — 80×24), а при показе ресайз pty
    // выходил пустым — размер-то уже тот, — и Claude Code не перерисовывался
    // поверх испорченного экрана. В pty отсюда не уходит ничего: размер решает
    // видимая вкладка. Подогнанная чужую сетку не берёт — у неё своя.
    adoptGrid: (size) => {
      if (!size) return;
      if (fittedSize(fit.proposeDimensions(), cellArea(), cellNow())) return;
      if (term.cols !== size.cols || term.rows !== size.rows) term.resize(size.cols, size.rows);
    },
    // Ghost-снимок буфера (Task 5): scrollback:2000 — достаточно контекста для
    // «о чём мы говорили», не раздувая ghost-файл на диске.
    serialize: () => serializeAddon.serialize({ scrollback: 2000 }),
    // Task 6: закрытие вкладки должно гасить и ResizeObserver — он раньше
    // не отключался (наблюдатель на удалённом из DOM container продолжал
    // жить, утечка на каждое закрытие/переоткрытие вкладки).
    dispose: () => {
      observer.disconnect();
      // Взведённые таймеры живут дольше вкладки (ревью 09.08, C12): дебаунс
      // ресайза звал бы fit() на мёртвом xterm и слал term:resize вкладке,
      // которой в main уже нет. Отложенное сохранение шрифта не гасим, а
      // пишем сразу: человек нажал Ctrl+«+» и закрыл вкладку — размер его.
      clearTimeout(resizeTimer);
      if (persistTimer) {
        clearTimeout(persistTimer);
        persistFontSize();
      }
      // Подписка на document.fonts живёт дольше вкладки: без снятия закрытая
      // вкладка держала бы свой xterm в памяти, а догрузка шрифта будила бы её.
      document.fonts?.removeEventListener?.('loadingdone', onFontsLoaded);
      term.dispose();
    },
  };
}
