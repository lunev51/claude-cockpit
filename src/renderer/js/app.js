'use strict';
// Бутстрап renderer: одна стартовая вкладка через адресное API.
// Мульти-вкладочный UI — задача 4.

import { initTerminal } from './terminal.js';

const $ = (id) => document.getElementById(id);
const views = new Map(); // tabId → view из initTerminal

async function boot() {
  const config = await window.api.config.get();
  const statusPty = $('status-pty');
  const statusFont = $('status-font');

  // Глобальный диспатч событий терминалов по tabId.
  window.api.term.onData(({ tabId, data }) => views.get(tabId)?.handlers.onData(data));
  window.api.term.onStarted((p) => views.get(p.tabId)?.handlers.onStarted(p));
  window.api.term.onExit((p) => views.get(p.tabId)?.handlers.onExit(p));

  // Стартовая вкладка: cwd из конфига (пустой → домашняя папка подставится в main).
  const cwd = config.terminal.cwd || '.';
  const tab = await window.api.tabs.open({ cwd });
  if (!tab) return;

  const view = initTerminal($('terminal'), config, {
    tabId: tab.tabId,
    onPtyStatus: (s) => { statusPty.textContent = `⌨ ${s}`; },
    onFontSize: (px) => { statusFont.textContent = `A ${px}`; },
  });
  views.set(tab.tabId, view);
  statusFont.textContent = `A ${config.terminal.fontSize}`;

  window.api.app.onNotice(({ text }) => console.warn(`[notice] ${text}`));
}

boot();
