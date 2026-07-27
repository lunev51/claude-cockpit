'use strict';
// Peek-поповер (Phase 4, Task 3): ответить Claude из сайдбара, не переключая
// активную вкладку. createPeek — единственный владелец DOM поповера; вся
// «сеть» (запись в pty, переключение вкладки) идёт через инжектированные
// onSend/onOpenTab — сам модуль про терминалы/вкладки ничего не знает.

import { parseOptions } from './peek-parse.js';

const MARGIN = 8; // отступ от края окна при упоре

export function createPeek({ root, onSend, onOpenTab }) {
  let open = false;
  let currentTabId = null;
  let popoverEl = null;
  let inputEl = null;
  let onDocKeydown = null;
  let onDocMousedown = null;

  function buildOptions(text) {
    const options = parseOptions(text);
    if (!options.length) return null;
    const wrap = document.createElement('div');
    wrap.className = 'peek-options';
    for (const { digit, label } of options) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'peek-option';
      btn.textContent = `${digit}. ${label}`;
      // mousedown-preventDefault — по тому же паттерну, что action-btn
      // (app.js): без него кнопка отбирает фокус у поля ввода раньше клика.
      btn.addEventListener('mousedown', (ev) => ev.preventDefault());
      btn.addEventListener('click', () => send(digit));
      wrap.appendChild(btn);
    }
    return wrap;
  }

  function build({ name, text }) {
    const el = document.createElement('div');
    el.className = 'peek-popover';

    const header = document.createElement('div');
    header.className = 'peek-name';
    header.textContent = name;
    el.appendChild(header);

    const body = document.createElement('div');
    body.className = 'peek-text';
    body.textContent = text;
    el.appendChild(body);

    const optionsEl = buildOptions(text);
    if (optionsEl) el.appendChild(optionsEl);

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'peek-input';
    input.placeholder = 'Ответ Claude…';
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.ctrlKey) {
        ev.preventDefault();
        send(input.value);
      } else if (ev.key === 'Enter' && ev.ctrlKey) {
        // Ctrl+Enter — перейти во вкладку вместо отправки (см. onDocKeydown
        // ниже тоже ловит Ctrl+Enter глобально; дубль здесь безвреден —
        // preventDefault не даёт полю ввода вставить перевод строки).
        ev.preventDefault();
      }
    });
    el.appendChild(input);
    inputEl = input;

    const hint = document.createElement('div');
    hint.className = 'peek-hint';
    hint.textContent = 'Enter — отправить · Esc — закрыть · Ctrl+Enter — перейти во вкладку';
    el.appendChild(hint);

    return el;
  }

  // Позиционирование рядом с anchorEl (строка сайдбара): справа от неё, той
  // же верхней координатой; если поповер вылезает за нижний/правый край
  // окна — сдвигаем вверх/влево ровно настолько, чтобы влезть с MARGIN.
  function position(anchorEl) {
    const a = anchorEl.getBoundingClientRect();
    const p = popoverEl.getBoundingClientRect();

    let left = a.right + MARGIN;
    if (left + p.width > window.innerWidth - MARGIN) {
      left = Math.max(MARGIN, window.innerWidth - p.width - MARGIN);
    }

    let top = a.top;
    if (top + p.height > window.innerHeight - MARGIN) {
      top = Math.max(MARGIN, window.innerHeight - p.height - MARGIN);
    }

    popoverEl.style.left = `${left}px`;
    popoverEl.style.top = `${top}px`;
  }

  function send(text) {
    const tabId = currentTabId;
    if (!tabId) return;
    hide();
    onSend(tabId, text);
  }

  function openTab() {
    const tabId = currentTabId;
    if (!tabId) return;
    hide();
    onOpenTab(tabId);
  }

  function handleDocKeydown(ev) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      hide();
      return;
    }
    if (ev.ctrlKey && ev.key === 'Enter') {
      ev.preventDefault();
      openTab();
    }
  }

  function handleDocMousedown(ev) {
    if (popoverEl && !popoverEl.contains(ev.target)) hide();
  }

  function show({
    tabId, name, text, anchorEl,
  }) {
    hide(); // на случай если уже открыт другой peek — только один одновременно

    currentTabId = tabId;
    popoverEl = build({ name, text });
    root.appendChild(popoverEl);
    open = true;

    position(anchorEl);

    onDocKeydown = handleDocKeydown;
    // capture:true — Esc/Ctrl+Enter должны сработать, даже если фокус на
    // кнопке-варианте, а не в поле ввода.
    document.addEventListener('keydown', onDocKeydown, true);

    // Клик вне поповера закрывает его — вешаем ПОСЛЕ текущего тика: клик по
    // строке сайдбара, которым peek только что открылся, иначе сам себя
    // тут же закроет (тот же mousedown успевает дойти до document раньше,
    // чем этот listener навешен, — event loop уже отработал click к моменту
    // setTimeout(0), так что следующий клик снаружи ловится штатно).
    onDocMousedown = handleDocMousedown;
    setTimeout(() => {
      if (open) document.addEventListener('mousedown', onDocMousedown, true);
    }, 0);

    inputEl.focus();
  }

  function hide() {
    if (!open) return;
    open = false;
    currentTabId = null;
    if (onDocKeydown) document.removeEventListener('keydown', onDocKeydown, true);
    if (onDocMousedown) document.removeEventListener('mousedown', onDocMousedown, true);
    onDocKeydown = null;
    onDocMousedown = null;
    popoverEl?.remove();
    popoverEl = null;
    inputEl = null;
  }

  function isOpen() {
    return open;
  }

  return { show, hide, isOpen };
}
