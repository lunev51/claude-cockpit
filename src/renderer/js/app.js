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

  const view = initTerminal(container, config, {
    tabId: tab.tabId,
    onPtyStatus: (s) => {
      if (tabStore.activeId === tab.tabId) statusPty().textContent = `⌨ ${s}`;
    },
    onFontSize: (px) => { statusFont().textContent = `A ${px}`; },
  });

  views.set(tab.tabId, { view, container });
  tabStore.add(tab);
  if (activate) activateTab(tab.tabId);
  return tab;
}

function activateTab(tabId) {
  const entry = views.get(tabId);
  if (!entry) return;
  for (const [id, v] of views) v.container.classList.toggle('hidden', id !== tabId);
  tabStore.setActive(tabId);
  // fit после показа: скрытый контейнер имеет нулевые размеры.
  requestAnimationFrame(() => {
    entry.view.term.focus();
    window.dispatchEvent(new Event('resize'));
  });
}

async function closeTab(tabId) {
  const entry = views.get(tabId);
  if (!entry) return;
  const wasActive = tabStore.activeId === tabId;
  await window.api.tabs.close(tabId);
  entry.view.term.dispose();
  entry.container.remove();
  views.delete(tabId);
  tabStore.remove(tabId);
  // Переключаемся на соседнюю вкладку, только если закрыли активную —
  // закрытие фоновой вкладки не должно перебивать фокус пользователя.
  if (!wasActive) return;
  const rest = tabStore.order();
  if (rest.length) activateTab(rest[rest.length - 1]);
  else statusPty().textContent = '⌨ нет вкладок';
}

function bindHotkeys() {
  window.addEventListener('keydown', (ev) => {
    // Ctrl+1..9 — вкладка по индексу.
    if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && ev.key >= '1' && ev.key <= '9') {
      const idx = Number(ev.key) - 1;
      const ids = tabStore.order();
      if (ids[idx]) {
        ev.preventDefault();
        activateTab(ids[idx]);
      }
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
    container: $('tab-list'),
    onActivate: activateTab,
    onClose: closeTab,
  });

  // Глобальный диспатч событий терминалов по tabId.
  window.api.term.onData(({ tabId, data }) => views.get(tabId)?.view.handlers.onData(data));
  window.api.term.onStarted((p) => {
    views.get(p.tabId)?.view.handlers.onStarted(p);
    tabStore.setStatus(p.tabId, 'working');
  });
  window.api.term.onExit((p) => {
    views.get(p.tabId)?.view.handlers.onExit(p);
    tabStore.setStatus(p.tabId, 'error', `процесс завершён (код ${p.exitCode})`);
  });

  $('btn-new-tab').addEventListener('click', async () => {
    const folder = await window.api.tabs.chooseFolder();
    if (folder) openTab(folder);
  });

  bindHotkeys();

  // Стартовая вкладка: cwd из конфига.
  await openTab(config.terminal.cwd || '.');

  statusFont().textContent = `A ${config.terminal.fontSize}`;
  window.api.app.onNotice(({ text }) => console.warn(`[notice] ${text}`));
}

boot();
