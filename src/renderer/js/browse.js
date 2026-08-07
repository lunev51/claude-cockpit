'use strict';
// Файловый обзор: выбор папки для НОВОЙ сессии. Один и тот же экран в окне на
// ПК и в браузере на макбуке — системный диалог при удалённой работе открылся
// бы на машине, где никого нет (а окно кокпита в этот момент спрятано в трей).
//
// Решения (сортировка, крошки, пометки, недавние) живут в browse-view.js под
// тестами; здесь только DOM и разговор с main.
import {
  crumbs, markOpen, recentFolders, normalizeInput,
} from './browse-view.js';

export function createBrowse({ onOpenHere, onSystemDialog, isElectron = true }) {
  const root = document.getElementById('browse-root');
  let current = '';
  // Последняя папка, которую УДАЛОСЬ прочитать. Отдельно от current, потому что
  // current показывает и нечитаемый путь (человек должен видеть, что он ввёл),
  // а начинать следующее открытие обзора с папки, которой нет, бессмысленно.
  let lastGood = '';
  let lastFocus = null;
  // Поколение отрисовки. render() ходит в main трижды (каталог, затем вкладки+
  // воркспейсы+диски), и порядок ответов не совпадает с порядком кликов —
  // особенно у сетевого клиента, где это три сетевых round-trip'а. Без счётчика
  // два быстрых клика по папкам давали строку пути от одной, а список — от
  // другой, и «Открыть сессию здесь» заводил сессию не там, куда человек
  // смотрит. Каждый render() запоминает своё поколение и после КАЖДОГО await
  // проверяет, что оно ещё актуально; устаревший выходит молча, не трогая ни
  // current, ни DOM, ни фокус.
  let gen = 0;

  // I-1 ре-ревью. Раньше ВЕСЬ DOM оверлея создавался ПОСЛЕ обоих await, а
  // isOpen() — это `!!root.firstChild`. То есть всё время чтения (секунды:
  // каталог, потом вкладки+воркспейсы+диски) обзор для реестра оверлеев
  // app.js/overlayFlags() не существовал, хотя человек его уже вызвал:
  //   · Esc не доходил до close() — оверлей всё равно всплывал ПОСЛЕ нажатия;
  //   · хуже, Esc доставался чужому слою: при открытом оверлее восстановления
  //     его capture-обработчик (otherOverlayOpen('restore') не видел обзора)
  //     понимал Escape как «начать пусто» — список проектов терялся насовсем;
  //   · Ctrl+O не закрывал обзор, а запускал ВТОРОЙ render() — лишние
  //     параллельные чтения выедают пул потоков main, и живая локальная папка
  //     получает ложное «папка не отвечает»;
  //   · Ctrl+Q/Ctrl+G разворачивали свои панели, которые обзор тут же накрывал.
  // Лечение структурное: каркас оверлея (карточка, строка пути, низ) строится
  // СИНХРОННО в момент вызова — до единого await, — и root.firstChild
  // появляется сразу. Данные каталога доезжают позже и заполняют уже видимый
  // каркас. Побочно это же чинит M-4: input больше не пересоздаётся на каждом
  // ответе, значит набранный путь не затирается и фокус не выдёргивается.
  let ui = null;
  // Идёт ли чтение прямо сейчас: гасит «Открыть сессию здесь» (в этот момент
  // current — ещё старая папка) и запрещает повторному open() плодить чтения.
  let busy = false;
  let busyTimer = null;
  let busyPath = '';
  // Тронул ли человек строку пути руками с начала текущей навигации. Пришедший
  // ответ подставляет свой путь только если НЕ тронул (M-4): иначе ответ
  // трёхсекундного чтения стирал ровно то, что в этот момент печатали.
  let inputDirty = false;
  let openable = false;

  const isOpen = () => !!root.firstChild;

  function stopBusyTicker() {
    if (busyTimer) clearInterval(busyTimer);
    busyTimer = null;
  }

  function close() {
    // Закрытие отменяет всё, что в полёте: иначе незавершённый render()
    // дорисовывал оверлей уже ПОСЛЕ Esc (или после «Открыть сессию здесь») и
    // забирал фокус в строку пути поверх только что заведённой вкладки.
    gen += 1;
    stopBusyTicker();
    busy = false;
    busyPath = '';
    inputDirty = false;
    openable = false;
    ui = null;
    root.innerHTML = '';
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
    lastFocus = null;
  }

  // Кнопка «Открыть сессию здесь» гасится, а не игнорирует нажатие: человек
  // должен видеть, ПОЧЕМУ нельзя. Инлайновый стиль повторяет .curtain-take:
  // disabled — у .sidebar-btn своего disabled-вида в app.css нет, а иначе
  // кнопка выглядит рабочей.
  function setOpenEnabled(ok, reason) {
    openable = !!ok;
    if (!ui) return;
    ui.openBtn.disabled = !ok;
    ui.openBtn.style.opacity = ok ? '' : '0.45';
    ui.openBtn.style.cursor = ok ? '' : 'default';
    ui.openBtn.title = ok ? '' : (reason || '');
  }

  // Видимый признак работы. Без него «+ Проект» на медленной папке выглядит
  // как «кнопка не работает» — и человек жмёт ещё раз, добавляя main лишнее
  // параллельное чтение. Точек три: бегущее «чтение…» справа от строки пути
  // (видно всегда, список можно и прокрутить), строка «читаю <путь>…» в самом
  // списке и подсказка внизу. Анимация точками — самая дешёвая «оно живое»:
  // своей CSS-анимации в app.css нет, а app.css в этой задаче не мой файл.
  function setBusy(on, dirPath) {
    busy = !!on;
    if (!ui) return;
    if (!on) {
      stopBusyTicker();
      busyPath = '';
      ui.busyTag.style.display = 'none';
      if (ui.busyNote.parentNode) ui.busyNote.remove();
      return;
    }
    busyPath = typeof dirPath === 'string' ? dirPath : '';
    let n = 0;
    const tick = () => {
      const dots = '.'.repeat(n % 4);
      n += 1;
      ui.busyTag.textContent = `чтение${dots}`;
      ui.busyNote.textContent = busyPath ? `читаю ${busyPath}${dots}` : `читаю папку${dots}`;
    };
    tick();
    stopBusyTicker();
    busyTimer = setInterval(tick, 400);
    ui.busyTag.style.display = '';
    if (!ui.busyNote.parentNode) ui.list.insertBefore(ui.busyNote, ui.list.firstChild);
    setOpenEnabled(false, 'идёт чтение папки — подождите');
    ui.hint.textContent = 'идёт чтение папки · Esc — закрыть';
  }

  // Каркас строится ОДИН раз на открытие и живёт до close(): строка пути,
  // крошки, тело, низ. Всё, что меняется от ответа к ответу, заполняет
  // fill() — сам input при этом не пересоздаётся (M-4).
  function ensureShell(dirPath) {
    if (ui) return ui;
    const overlay = document.createElement('div');
    overlay.className = 'browse-overlay';
    const card = document.createElement('div');
    card.className = 'browse-card';
    overlay.appendChild(card);

    // --- строка пути ---
    const head = document.createElement('div');
    head.className = 'browse-head';
    const input = document.createElement('input');
    input.className = 'browse-path';
    input.value = typeof dirPath === 'string' ? dirPath : '';
    input.spellcheck = false;
    input.addEventListener('input', () => { inputDirty = true; });
    input.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      const next = normalizeInput(input.value);
      if (next) render(next);
    });
    head.appendChild(input);
    const busyTag = document.createElement('span');
    busyTag.style.cssText = 'align-self:center;flex:none;font-size:11px;color:var(--text-dim);white-space:nowrap;';
    busyTag.style.display = 'none';
    head.appendChild(busyTag);
    card.appendChild(head);

    // --- хлебные крошки ---
    const crumbBar = document.createElement('div');
    crumbBar.className = 'browse-crumbs';
    card.appendChild(crumbBar);

    // --- тело: слева недавние и диски, справа содержимое ---
    const body = document.createElement('div');
    body.className = 'browse-body';
    const side = document.createElement('div');
    side.className = 'browse-side';
    body.appendChild(side);
    const list = document.createElement('div');
    list.className = 'browse-list';
    body.appendChild(list);
    card.appendChild(body);

    // Строка «идёт чтение» живёт отдельно от содержимого списка: список
    // пересобирается целиком на каждом ответе, а она переживает пересборку.
    // Цвет перебиваем на приглушённый — .browse-note предупреждающе-жёлтая, а
    // тут ничего плохого не происходит.
    const busyNote = document.createElement('div');
    busyNote.className = 'browse-note';
    busyNote.style.color = 'var(--text-dim)';

    // --- низ: открыть здесь / системное окно / закрыть ---
    const foot = document.createElement('div');
    foot.className = 'browse-foot';
    const openBtn = document.createElement('button');
    openBtn.className = 'sidebar-btn';
    openBtn.id = 'browse-open-here';
    openBtn.textContent = 'Открыть сессию здесь';
    openBtn.addEventListener('click', () => {
      if (!openable) return;
      const target = current;
      close();
      onOpenHere(target);
    });
    foot.appendChild(openBtn);

    if (isElectron && typeof onSystemDialog === 'function') {
      // Только в окне на ПК: в браузере системный диалог показать негде.
      const sysBtn = document.createElement('button');
      sysBtn.className = 'sidebar-btn';
      sysBtn.textContent = 'Системное окно';
      sysBtn.addEventListener('click', () => {
        close();
        onSystemDialog();
      });
      foot.appendChild(sysBtn);
    }

    const hint = document.createElement('div');
    hint.className = 'grow';
    foot.appendChild(hint);
    card.appendChild(foot);

    overlay.addEventListener('mousedown', (ev) => {
      if (ev.target === overlay) { close(); return; }
      // Клик по строке каталога — обычный div, и Chromium на mousedown уводит
      // фокус на <body>. Раньше это лечилось само собой: render() в конце
      // дёргал input.focus(). Теперь фокус не трогаем (M-4), поэтому просто не
      // отдаём его — иначе следующий Escape пошёл бы мимо оверлея (обработчик
      // ниже висит на overlay и ловит клавиши только пока фокус ВНУТРИ него).
      const t = ev.target;
      const tag = t && t.tagName;
      if (tag === 'INPUT' || tag === 'BUTTON' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      ev.preventDefault();
    });
    // Escape ловим ЗДЕСЬ, а не в общем обработчике app.js: палитра и поиск
    // устроены так же — каждый оверлей закрывает себя сам, и порядок между
    // ними не приходится согласовывать вручную. capture, чтобы клавиша не
    // ушла в поле ввода пути раньше нас.
    overlay.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      close();
    }, true);

    root.appendChild(overlay);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    ui = {
      overlay, card, input, busyTag, crumbBar, side, list, busyNote, openBtn, hint,
    };
    return ui;
  }

  function fillCrumbs(dirPath) {
    ui.crumbBar.innerHTML = '';
    crumbs(dirPath).forEach((c, i, all) => {
      const el = document.createElement('span');
      el.className = 'browse-crumb';
      el.textContent = c.name;
      el.addEventListener('click', () => render(c.path));
      ui.crumbBar.appendChild(el);
      if (i < all.length - 1) {
        const sep = document.createElement('span');
        sep.textContent = '›';
        ui.crumbBar.appendChild(sep);
      }
    });
  }

  function fillSide(live, workspaces, drives) {
    ui.side.innerHTML = '';
    const addSideTitle = (text) => {
      const t = document.createElement('div');
      t.className = 'browse-side-title';
      t.textContent = text;
      ui.side.appendChild(t);
    };
    const addSideRow = (label, target, hint) => {
      const r = document.createElement('div');
      r.className = 'browse-row dir';
      r.textContent = label;
      if (hint) r.title = hint;
      r.addEventListener('click', () => render(target));
      ui.side.appendChild(r);
    };
    const recents = recentFolders({ tabs: live, workspaces });
    if (recents.length) {
      addSideTitle('Недавние');
      recents.forEach((r) => addSideRow(r.label, r.path, r.path));
    }
    addSideTitle('Диски');
    (Array.isArray(drives) ? drives : []).forEach((d) => addSideRow(d, d));
  }

  function fillList(res, rows, readable) {
    ui.list.innerHTML = '';
    if (res.error) {
      const err = document.createElement('div');
      err.className = 'browse-note';
      err.textContent = res.error;
      ui.list.appendChild(err);
    }
    if (res.parent) {
      const up = document.createElement('div');
      up.className = 'browse-row dir';
      up.textContent = '..';
      up.addEventListener('click', () => render(res.parent));
      ui.list.appendChild(up);
    }
    rows.forEach((e) => {
      const r = document.createElement('div');
      r.className = `browse-row ${e.dir ? 'dir' : 'file'}`;
      const name = document.createElement('span');
      name.textContent = e.name;
      r.appendChild(name);
      if (e.open) {
        // Иначе легко завести вторую сессию в том же проекте, не заметив первой.
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = '· открыт';
        r.appendChild(badge);
      }
      if (e.dir) r.addEventListener('click', () => render(`${res.path}\\${e.name}`));
      ui.list.appendChild(r);
    });
    // Файлы показываются как раз ради «отличить пустую папку от не туда зашёл»,
    // но по-настоящему пустая папка рисовалась одной строкой '..' — молча, и
    // выглядело это как не догрузившийся список.
    if (readable && !rows.length) {
      const note = document.createElement('div');
      note.className = 'browse-note';
      note.textContent = 'папка пуста';
      ui.list.appendChild(note);
    }
    if (res.truncated) {
      const note = document.createElement('div');
      note.className = 'browse-note';
      note.textContent = 'показана первая тысяча записей — уточните путь в строке сверху';
      ui.list.appendChild(note);
    }
  }

  async function render(dirPath) {
    const my = (gen += 1);
    // Каркас — синхронно, ДО единого await: с этой секунды isOpen() === true,
    // то есть обзор есть в реестре оверлеев app.js, Esc идёт в его close(),
    // Ctrl+O его закрывает, а Ctrl+Q/Ctrl+G не разворачивают панели под ним.
    ensureShell(dirPath);
    if (!ui.crumbBar.childElementCount) fillCrumbs(dirPath);
    // Началась навигация по воле человека — предыдущий набранный текст
    // (если был) он бросил сам, кликнув мимо строки; следующее нажатие клавиши
    // в строке снова взведёт флаг.
    inputDirty = false;
    setBusy(true, dirPath);

    // Отказ канала — не то же самое, что отказ файловой системы. В окне на ПК
    // fs:list не реджектится вовсе, а у сетевого клиента при оборванном сокете
    // он бросает — и без этого перехвата open() падал бы необработанным
    // отказом, оверлей просто не появлялся, и человек не понимал бы, почему
    // «+ Проект» ничего не делает (находка живой проверки задачи 4).
    // Дальше рисуем обычным путём: пустой список плюс строка ошибки — ровно
    // так же выглядит папка без прав.
    let res;
    try {
      res = await window.api.fs.list(dirPath);
    } catch (err) {
      res = {
        path: typeof dirPath === 'string' ? dirPath : '',
        parent: null,
        entries: [],
        truncated: false,
        error: `не удалось прочитать папку: ${(err && err.message) || 'нет связи с кокпитом'}`,
      };
    }
    // Устаревший (или отменённый close()) — выходим молча и НЕ снимаем busy:
    // им теперь владеет более свежий render(), а close() гасит его сам.
    if (my !== gen) return;
    if (!res || typeof res !== 'object') {
      res = {
        path: '', parent: null, entries: [], truncated: false, error: 'кокпит не ответил',
      };
    }

    const [live, workspaces, drives] = await Promise.all([
      window.api.tabs.list().catch(() => []),
      window.api.recipes.listWorkspaces().catch(() => []),
      window.api.fs.drives().catch(() => []),
    ]);
    if (my !== gen) return;

    // Только здесь, когда отрисовка точно последняя и дальше нет ни одного
    // await: current объявляем ровно той папкой, чьи крошки и содержимое сейчас
    // окажутся на экране. Кнопка «Открыть сессию здесь» читает current — путь,
    // крошки, список и кнопка обязаны быть из одного ответа.
    current = res.path || '';
    // Папка, которую только что не удалось прочитать, — не место для сессии:
    // раньше отсюда заводилась вкладка с cwd несуществующего каталога и сразу
    // умирала (status:"dead"). Системный диалог такой путь не отдавал вовсе.
    const readable = !res.error;
    if (readable && res.path) lastGood = res.path;
    const openCwds = (Array.isArray(live) ? live : []).map((t) => t.cwd).filter(Boolean);
    const rows = markOpen(res.entries, res.path, openCwds);

    setBusy(false);
    // M-4: строку пути перезаписываем, только если человек в неё не печатал,
    // пока шло чтение. Раньше input пересоздавался целиком — набранное
    // пропадало вместе со старым узлом.
    if (!inputDirty) {
      ui.input.value = current;
      if (document.activeElement === ui.input) {
        ui.input.setSelectionRange(ui.input.value.length, ui.input.value.length);
      }
    }
    fillCrumbs(current);
    fillSide(live, workspaces, drives);
    fillList(res, rows, readable);
    setOpenEnabled(readable, readable ? '' : `сессию здесь завести нельзя: ${res.error}`);
    ui.hint.textContent = readable
      ? 'Enter в строке пути — перейти · Esc — закрыть'
      : `${res.error} — сессию здесь завести нельзя`;
    // Фокус НЕ отбираем: он и так внутри карточки, а на медленном ответе
    // отбирать его — значит бить по рукам печатающему (M-4). Возвращаем, только
    // если он всё-таки утёк наружу, иначе Escape пойдёт мимо оверлея.
    if (!ui.card.contains(document.activeElement)) ui.input.focus();
  }

  return {
    isOpen,
    close,
    async open(startPath) {
      // Повторный open() поверх уже открытого обзора (двойной клик по
      // «+ Проект») перетирал lastFocus строкой ввода самого обзора — и Esc
      // возвращал фокус в неё же, а не туда, откуда открывали.
      if (isOpen()) {
        // …а во время чтения он ещё и запускал ВТОРОЕ параллельное чтение
        // (I-1): пул потоков main не резиновый, и лишние чтения оборачивались
        // ложным «папка не отвечает» на живой локальной папке.
        if (busy) return;
      } else {
        lastFocus = document.activeElement;
      }
      await render(startPath || lastGood || 'C:\\');
    },
  };
}
