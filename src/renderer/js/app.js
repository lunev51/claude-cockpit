'use strict';
// Бутстрап renderer: конфиг → один терминал на всё окно.
// Task 3-4 фазы 1 заменят это на пул вкладок.

import { initTerminal } from './terminal.js';

const $ = (id) => document.getElementById(id);

async function boot() {
  const config = await window.api.config.get();

  const statusPty = $('status-pty');
  const statusFont = $('status-font');

  initTerminal($('terminal'), config, {
    onPtyStatus: (s) => { statusPty.textContent = `⌨ ${s}`; },
    onFontSize: (px) => { statusFont.textContent = `A ${px}`; },
  });
  statusFont.textContent = `A ${config.terminal.fontSize}`;

  // Тосты из main (например, битый config.json).
  window.api.app.onNotice(({ text }) => {
    console.warn(`[notice] ${text}`);
  });
}

boot();
