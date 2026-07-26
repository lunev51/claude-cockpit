'use strict';
// Оркестрация renderer: вкладки ↔ пул терминалов ↔ адресный IPC.

import { initTerminal } from './terminal.js';
import { createTabStore } from './tabs.js';

const $ = (id) => document.getElementById(id);

const views = new Map(); // tabId → {view, container}
let config = null;
let tabStore = null;

const statusPty = () => $('status-pty');
const statusFont = () => $('status-font');

// Создать вкладку: контейнер + xterm + запись в стор. activate — переключиться сразу.
// command/args — оверрайд команды на этот спавн (Task 4: staggered-resume
// шлёт 'claude' + ['--resume', sessionId] при восстановлении воркспейса).
async function openTab(cwd, {
  activate = true, command = null, args = null, preludeText = null,
} = {}) {
  const tab = await window.api.tabs.open({ cwd, command, args });
  if (!tab) return null;

  const container = document.createElement('div');
  container.className = 'term-view hidden';
  $('terminal-host').appendChild(container);

  const entry = { view: null, container, lastPtyStatus: '', fontSize: config.terminal.fontSize };
  views.set(tab.tabId, entry);

  const view = initTerminal(container, config, {
    tabId: tab.tabId,
    preludeText,
    onPtyStatus: (s) => {
      entry.lastPtyStatus = s;
      if (tabStore.activeId === tab.tabId) statusPty().textContent = `⌨ ${s}`;
    },
    onFontSize: (px) => {
      entry.fontSize = px;
      if (tabStore.activeId === tab.tabId) statusFont().textContent = `A ${px}`;
    },
  });
  entry.view = view;

  tabStore.add(tab);
  refreshConnectBadge(tab.tabId);
  if (activate) activateTab(tab.tabId);
  return tab;
}

function activateTab(tabId) {
  const entry = views.get(tabId);
  if (!entry) return;
  for (const [id, v] of views) v.container.classList.toggle('hidden', id !== tabId);
  tabStore.setActive(tabId);
  window.api.workspace.setActive(tabId); // main пересчитает activeIndex манифеста
  // Статус-бар должен отражать активную вкладку, а не последнюю, что его обновляла.
  statusPty().textContent = entry.lastPtyStatus ? `⌨ ${entry.lastPtyStatus}` : '⌨ …';
  statusFont().textContent = `A ${entry.fontSize ?? config.terminal.fontSize}`;
  // fit после показа: скрытый контейнер имеет нулевые размеры (рефит запускает
  // ResizeObserver в terminal.js сам, когда контейнер становится видимым).
  requestAnimationFrame(() => {
    entry.view.term.focus();
  });
}

// Ghost-буфер (Task 5): сериализовать буфер вкладки и отдать main на запись.
// main сам резолвит ghostId по tabId (manager.list()) — здесь просто снимок.
function saveGhost(tabId) {
  const entry = views.get(tabId);
  if (!entry || !entry.view) return;
  window.api.ghost.save(tabId, entry.view.serialize());
}

async function closeTab(tabId) {
  const entry = views.get(tabId);
  if (!entry) return;
  const wasActive = tabStore.activeId === tabId;
  // Сосед считаем ДО tabStore.remove — после удаления ряда его позиции в order() уже нет.
  const fallback = tabStore.neighborOf(tabId);
  await window.api.tabs.close(tabId);
  entry.view.term.dispose();
  entry.container.remove();
  views.delete(tabId);
  tabStore.remove(tabId);
  // Переключаемся на соседнюю вкладку, только если закрыли активную —
  // закрытие фоновой вкладки не должно перебивать фокус пользователя.
  if (!wasActive) return;
  if (fallback) activateTab(fallback);
  else statusPty().textContent = '⌨ нет вкладок';
}

// Клик по ⚡: прописать хуки Cockpit в .claude/settings.json проекта вкладки.
async function connectProject(tabId) {
  try {
    const res = await window.api.project.connect(tabId);
    if (res && res.connected) tabStore.setConnectVisible(tabId, false);
    else console.warn(`[connect] не удалось: ${res && res.error}`);
  } catch (err) {
    console.warn('[connect] ошибка IPC', err);
  }
}

// Показать ⚡, если проект ещё не подключён к хукам (статусы будут молчать).
async function refreshConnectBadge(tabId) {
  try {
    const { connected } = await window.api.project.status(tabId);
    tabStore.setConnectVisible(tabId, !connected);
  } catch (err) {
    console.warn('[connect] ошибка при обновлении статуса', err);
  }
}

function bindHotkeys() {
  window.addEventListener('keydown', (ev) => {
    // Ctrl+1..9 — вкладка по индексу.
    if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && ev.key >= '1' && ev.key <= '9') {
      // preventDefault+stopPropagation — для ЛЮБОГО Ctrl+цифра, даже если
      // вкладки с таким индексом нет: xterm.evaluateKeyboardEvent маппит
      // Ctrl+3..8 на ESC/FS/GS/RS/US/DEL и шлёт их в pty независимо от
      // defaultPrevented, если событие дошло до textarea терминала (Ctrl+3
      // отправлял ESC и обрывал генерацию Claude в фокусной вкладке).
      ev.preventDefault();
      ev.stopPropagation();
      const idx = Number(ev.key) - 1;
      const ids = tabStore.order();
      if (ids[idx]) activateTab(ids[idx]);
      return;
    }
    // Ctrl+Tab / Ctrl+Shift+Tab — циклическое переключение.
    if (ev.ctrlKey && ev.key === 'Tab') {
      ev.preventDefault();
      // stopPropagation обязателен: иначе событие всё равно доходит до
      // textarea xterm, и evaluateKeyboardEvent шлёт \t/ESC[Z в pty вкладки,
      // которую мы как раз покидаем.
      ev.stopPropagation();
      const ids = tabStore.order();
      if (!ids.length) return;
      const cur = ids.indexOf(tabStore.activeId);
      const next = ev.shiftKey
        ? (cur - 1 + ids.length) % ids.length
        : (cur + 1) % ids.length;
      activateTab(ids[next]);
    }
  }, { capture: true });
}

// --- Экран восстановления воркспейса (Task 4) ---

// Строит список чекбоксов оверлея из манифеста; возвращает чекбоксы в
// порядке manifest.tabs (индекс совпадает — нужно для маппинга activeIndex).
function renderRestoreList(tabs) {
  const list = $('restore-list');
  list.innerHTML = '';
  const checkboxes = [];
  tabs.forEach((t) => {
    const row = document.createElement('label');
    row.className = 'restore-row';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;

    const info = document.createElement('div');
    info.className = 'restore-row-info';
    const name = document.createElement('div');
    name.className = 'restore-row-name';
    name.textContent = t.name || t.cwd;
    const cwd = document.createElement('div');
    cwd.className = 'restore-row-cwd';
    cwd.textContent = t.cwd;
    cwd.title = t.cwd;
    info.append(name, cwd);

    row.append(cb, info);

    if (t.sessionId) {
      const badge = document.createElement('span');
      badge.className = 'restore-badge';
      badge.textContent = 'сессия сохранена';
      row.appendChild(badge);
    }

    list.appendChild(row);
    checkboxes.push(cb);
  });
  return checkboxes;
}

// Последовательный подъём отмеченных вкладок со стаггером: Claude CLI
// успевает прочитать свою сессию/хуки до того, как поднимется следующая —
// параллельный залп на несколько вкладок наблюдался нестабильным.
async function restoreFlow(chosen, activeIndex, overlay) {
  // Прячем оверлей СРАЗУ, не дожидаясь даже первой вкладки: решение уже
  // принято, а гарантия «оверлей не должен зависнуть» так проще и надёжнее,
  // чем прятать его условно внутри цикла (ревью, finding 2b).
  overlay.classList.add('hidden');

  let restoredActive = null;  // вкладка с исходным manifest.activeIndex, если восстановлена
  let firstRestored = null;

  for (let idx = 0; idx < chosen.length; idx++) {
    const { t, i } = chosen[idx];
    let tab = null;
    try {
      // Ghost-буфер (Task 5): вчерашний скроллбек этой вкладки, если сохранён —
      // initTerminal впечатает его приглушённым до старта живого pty.
      const preludeText = t.ghostId ? await window.api.ghost.load(t.ghostId) : null;
      tab = await openTab(t.cwd, {
        // Первая УСПЕШНО поднятая вкладка становится видимой сразу — иначе
        // при 2+ вкладках пользователь весь стаггер смотрит в пустой терминал
        // (ревью, finding 1). Остальные — activate:false, финальная активация
        // ниже решает, какая вкладка останется на экране.
        activate: !firstRestored,
        command: 'claude',
        args: t.sessionId ? ['--resume', t.sessionId] : null,
        preludeText,
      });
    } catch (err) {
      // Одна упавшая вкладка не должна обрывать восстановление остальных
      // (ревью, finding 2a) — пропускаем и идём дальше.
      console.warn(`[restore] не удалось открыть вкладку ${t.cwd}:`, err);
    }
    if (tab) {
      if (!firstRestored) firstRestored = tab;
      if (i === activeIndex) restoredActive = tab;
    }
    if (idx < chosen.length - 1) {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  // Может повторно активировать ту же вкладку, что уже показана первой
  // (безвредно, activateTab идемпотентна) — либо переключить на вкладку
  // исходного manifest.activeIndex, если она восстановилась позже первой.
  const toActivate = restoredActive || firstRestored;
  if (toActivate) activateTab(toActivate.tabId);
}

// Показывает оверлей restore, слушает Enter/Esc и кнопки. Разрешается, когда
// пользователь принял решение (сам подъём вкладок восстановления идёт дальше
// асинхронно — оверлей к этому моменту уже спрятан либо прячется сам).
function showRestoreOverlay(manifest) {
  const overlay = $('restore-overlay');
  const btnAll = $('btn-restore-all');
  const btnNone = $('btn-restore-none');
  const checkboxes = renderRestoreList(manifest.tabs);
  overlay.classList.remove('hidden');

  function detach() {
    document.removeEventListener('keydown', onKey, true);
    btnAll.removeEventListener('click', startRestore);
    btnNone.removeEventListener('click', startEmpty);
  }

  function startEmpty() {
    detach();
    overlay.classList.add('hidden');
    // Манифест НЕ трогаем — следующее открытие/закрытие вкладки перепишет
    // его естественным образом (syncWorkspace в main реагирует на tabs:changed).
    statusPty().textContent = '⌨ нет вкладок';
  }

  function startRestore() {
    detach();
    const chosen = manifest.tabs
      .map((t, i) => ({ t, i }))
      .filter(({ i }) => checkboxes[i].checked);
    if (!chosen.length) {
      overlay.classList.add('hidden');
      statusPty().textContent = '⌨ нет вкладок';
      return;
    }
    // restoreFlow — fire-and-forget; per-tab ошибки уже гасятся внутри неё
    // (finding 2a), но подстраховка на случай непредвиденного throw снаружи
    // цикла (finding 2c) — необработанный reject не должен уйти в консоль
    // как unhandledrejection незамеченным.
    restoreFlow(chosen, manifest.activeIndex, overlay).catch((err) => {
      console.warn('[restore] restoreFlow упал:', err);
    });
  }

  function onKey(ev) {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      startRestore();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      startEmpty();
    }
  }

  // Горячие клавиши активны, только пока оверлей на экране.
  document.addEventListener('keydown', onKey, true);
  btnAll.addEventListener('click', startRestore);
  btnNone.addEventListener('click', startEmpty);
}

async function boot() {
  config = await window.api.config.get();

  tabStore = createTabStore({
    root: $('tab-groups'),
    onActivate: activateTab,
    onClose: closeTab,
    onConnect: connectProject,
  });

  // Глобальный диспатч событий терминалов по tabId.
  window.api.term.onData(({ tabId, data }) => views.get(tabId)?.view.handlers.onData(data));
  window.api.term.onStarted((p) => {
    views.get(p.tabId)?.view.handlers.onStarted(p);
  });
  window.api.term.onExit((p) => {
    views.get(p.tabId)?.view.handlers.onExit(p);
  });
  // Статусы приходят из хуков Claude Code (sessions.js) — единый источник,
  // term:started/term:exit статус больше не выставляют (был двойной источник).
  window.api.tab.onStatus(({ tabId, status, subtitle }) => {
    tabStore.setStatus(tabId, status, subtitle);
    // Ghost-буфер (Task 5): переход в done/waiting — момент «Claude закончил
    // ход», самый ценный кадр скроллбека — сериализуем именно эту вкладку
    // сразу, не дожидаясь общего 30-секундного таймера ниже.
    if (status === 'done' || status === 'waiting') saveGhost(tabId);
  });

  $('btn-new-tab').addEventListener('click', async () => {
    const folder = await window.api.tabs.chooseFolder();
    if (folder) openTab(folder);
  });

  bindHotkeys();

  // Ghost-буфер (Task 5): периодический снимок ТОЛЬКО активной вкладки —
  // сериализация всех открытых вкладок каждые 30с дорога при нескольких
  // терминалах, а точечный снимок при переходе в done/waiting (см. onStatus
  // выше) уже ловит самый ценный кадр для фоновых вкладок.
  setInterval(() => {
    if (tabStore.activeId) saveGhost(tabStore.activeId);
  }, 30000);

  // Манифест воркспейса (Task 3): пуст/отсутствует — старое поведение
  // (стартовая вкладка из конфига). Непуст — оверлей restore (Task 4).
  const manifest = await window.api.workspace.get();
  if (!manifest || !Array.isArray(manifest.tabs) || manifest.tabs.length === 0) {
    await openTab(config.terminal.cwd || '.');
  } else {
    showRestoreOverlay(manifest);
  }

  window.api.app.onNotice(({ text }) => console.warn(`[notice] ${text}`));
}

boot();
