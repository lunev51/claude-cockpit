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
async function openTab(cwd, { activate = true } = {}) {
  const tab = await window.api.tabs.open({ cwd });
  if (!tab) return null;

  const container = document.createElement('div');
  container.className = 'term-view hidden';
  $('terminal-host').appendChild(container);

  const entry = { view: null, container, lastPtyStatus: '', fontSize: config.terminal.fontSize };
  views.set(tab.tabId, entry);

  const view = initTerminal(container, config, {
    tabId: tab.tabId,
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
  // Статус-бар должен отражать активную вкладку, а не последнюю, что его обновляла.
  statusPty().textContent = entry.lastPtyStatus ? `⌨ ${entry.lastPtyStatus}` : '⌨ …';
  statusFont().textContent = `A ${entry.fontSize ?? config.terminal.fontSize}`;
  // fit после показа: скрытый контейнер имеет нулевые размеры (рефит запускает
  // ResizeObserver в terminal.js сам, когда контейнер становится видимым).
  requestAnimationFrame(() => {
    entry.view.term.focus();
  });
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
  const res = await window.api.project.connect(tabId);
  if (res && res.connected) tabStore.setConnectVisible(tabId, false);
  else console.warn(`[connect] не удалось: ${res && res.error}`);
}

// Показать ⚡, если проект ещё не подключён к хукам (статусы будут молчать).
async function refreshConnectBadge(tabId) {
  const { connected } = await window.api.project.status(tabId);
  tabStore.setConnectVisible(tabId, !connected);
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
  });

  $('btn-new-tab').addEventListener('click', async () => {
    const folder = await window.api.tabs.chooseFolder();
    if (folder) openTab(folder);
  });

  bindHotkeys();

  // Стартовая вкладка: cwd из конфига.
  await openTab(config.terminal.cwd || '.');

  window.api.app.onNotice(({ text }) => console.warn(`[notice] ${text}`));
}

boot();
