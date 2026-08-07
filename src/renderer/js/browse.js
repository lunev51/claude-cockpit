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

  function close() {
    // Закрытие отменяет всё, что в полёте: иначе незавершённый render()
    // дорисовывал оверлей уже ПОСЛЕ Esc (или после «Открыть сессию здесь») и
    // забирал фокус в строку пути поверх только что заведённой вкладки.
    gen += 1;
    root.innerHTML = '';
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
    lastFocus = null;
  }

  const isOpen = () => !!root.firstChild;

  async function render(dirPath) {
    const my = (gen += 1);
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

    root.innerHTML = '';
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
    input.value = current;
    input.spellcheck = false;
    input.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      const next = normalizeInput(input.value);
      if (next) render(next);
    });
    head.appendChild(input);
    card.appendChild(head);

    // --- хлебные крошки ---
    const crumbBar = document.createElement('div');
    crumbBar.className = 'browse-crumbs';
    crumbs(current).forEach((c, i, all) => {
      const el = document.createElement('span');
      el.className = 'browse-crumb';
      el.textContent = c.name;
      el.addEventListener('click', () => render(c.path));
      crumbBar.appendChild(el);
      if (i < all.length - 1) {
        const sep = document.createElement('span');
        sep.textContent = '›';
        crumbBar.appendChild(sep);
      }
    });
    card.appendChild(crumbBar);

    // --- тело: слева недавние и диски, справа содержимое ---
    const body = document.createElement('div');
    body.className = 'browse-body';
    const side = document.createElement('div');
    side.className = 'browse-side';

    const addSideTitle = (text) => {
      const t = document.createElement('div');
      t.className = 'browse-side-title';
      t.textContent = text;
      side.appendChild(t);
    };
    const addSideRow = (label, target, hint) => {
      const r = document.createElement('div');
      r.className = 'browse-row dir';
      r.textContent = label;
      if (hint) r.title = hint;
      r.addEventListener('click', () => render(target));
      side.appendChild(r);
    };

    const recents = recentFolders({ tabs: live, workspaces });
    if (recents.length) {
      addSideTitle('Недавние');
      recents.forEach((r) => addSideRow(r.label, r.path, r.path));
    }
    addSideTitle('Диски');
    (Array.isArray(drives) ? drives : []).forEach((d) => addSideRow(d, d));
    body.appendChild(side);

    // --- содержимое каталога ---
    const list = document.createElement('div');
    list.className = 'browse-list';
    if (res.error) {
      const err = document.createElement('div');
      err.className = 'browse-note';
      err.textContent = res.error;
      list.appendChild(err);
    }
    if (res.parent) {
      const up = document.createElement('div');
      up.className = 'browse-row dir';
      up.textContent = '..';
      up.addEventListener('click', () => render(res.parent));
      list.appendChild(up);
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
      list.appendChild(r);
    });
    // Файлы показываются как раз ради «отличить пустую папку от не туда зашёл»,
    // но по-настоящему пустая папка рисовалась одной строкой '..' — молча, и
    // выглядело это как не догрузившийся список.
    if (readable && !rows.length) {
      const note = document.createElement('div');
      note.className = 'browse-note';
      note.textContent = 'папка пуста';
      list.appendChild(note);
    }
    if (res.truncated) {
      const note = document.createElement('div');
      note.className = 'browse-note';
      note.textContent = 'показана первая тысяча записей — уточните путь в строке сверху';
      list.appendChild(note);
    }
    body.appendChild(list);
    card.appendChild(body);

    // --- низ: открыть здесь / системное окно / закрыть ---
    const foot = document.createElement('div');
    foot.className = 'browse-foot';
    const openBtn = document.createElement('button');
    openBtn.className = 'sidebar-btn';
    openBtn.id = 'browse-open-here';
    openBtn.textContent = 'Открыть сессию здесь';
    if (!readable) {
      // Гасим, а не игнорируем нажатие: человек должен видеть, ПОЧЕМУ нельзя.
      // Инлайновый стиль повторяет .curtain-take:disabled — у .sidebar-btn
      // своего disabled-вида в app.css нет, а иначе кнопка выглядит рабочей.
      openBtn.disabled = true;
      openBtn.style.opacity = '0.45';
      openBtn.style.cursor = 'default';
      openBtn.title = `сессию здесь завести нельзя: ${res.error}`;
    }
    openBtn.addEventListener('click', () => {
      if (!readable) return;
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

    const grow = document.createElement('div');
    grow.className = 'grow';
    grow.textContent = readable
      ? 'Enter в строке пути — перейти · Esc — закрыть'
      : `${res.error} — сессию здесь завести нельзя`;
    foot.appendChild(grow);
    card.appendChild(foot);

    overlay.addEventListener('mousedown', (ev) => { if (ev.target === overlay) close(); });
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
  }

  return {
    isOpen,
    close,
    async open(startPath) {
      // Повторный open() поверх уже открытого обзора (двойной клик по
      // «+ Проект») перетирал lastFocus строкой ввода самого обзора — и Esc
      // возвращал фокус в неё же, а не туда, откуда открывали.
      if (!isOpen()) lastFocus = document.activeElement;
      await render(startPath || lastGood || 'C:\\');
    },
  };
}
