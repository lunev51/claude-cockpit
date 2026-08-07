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
  let lastFocus = null;

  function close() {
    root.innerHTML = '';
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
    lastFocus = null;
  }

  const isOpen = () => !!root.firstChild;

  async function render(dirPath) {
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
    if (!res || typeof res !== 'object') {
      res = {
        path: '', parent: null, entries: [], truncated: false, error: 'кокпит не ответил',
      };
    }
    if (res.path) current = res.path;

    const [live, workspaces, drives] = await Promise.all([
      window.api.tabs.list().catch(() => []),
      window.api.recipes.listWorkspaces().catch(() => []),
      window.api.fs.drives().catch(() => []),
    ]);
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
    openBtn.addEventListener('click', () => {
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
    grow.textContent = 'Enter в строке пути — перейти · Esc — закрыть';
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
      lastFocus = document.activeElement;
      await render(startPath || current || 'C:\\');
    },
  };
}
