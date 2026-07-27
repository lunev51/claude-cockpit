'use strict';
// Палитра команд (Phase 4, Task 4): Ctrl+P, как в редакторах — быстрый доступ
// к переключению вкладок и разовым действиям без мыши. createPalette —
// единственный владелец DOM оверлея; список действий приходит через
// инжектированный getActions() (см. app.js/buildPaletteActions) — сам модуль
// про вкладки/терминалы ничего не знает (тот же стиль, что peek.js).

import { filterActions } from './palette-filter.js';

export function createPalette({ root, getActions }) {
  let isOpenFlag = false;
  let overlayEl = null;
  let inputEl = null;
  let listEl = null;
  let actions = [];
  let filtered = [];
  let selected = 0;
  // Элемент, у которого был фокус ДО открытия палитры (как правило — скрытая
  // textarea xterm активной вкладки, раз Ctrl+P перехватывается именно оттуда,
  // см. app.js/bindHotkeys). Восстановление фокуса на него при close() и есть
  // «фокус возвращается терминалу активной вкладки» из брифа — без явного
  // знания о терминалах внутри самого palette.js.
  let previousActive = null;

  function renderRow(action, index) {
    const row = document.createElement('div');
    row.className = 'palette-row';
    row.classList.toggle('active', index === selected);

    const title = document.createElement('div');
    title.className = 'palette-row-title';
    title.textContent = action.title;
    row.appendChild(title);

    if (action.hint) {
      const hint = document.createElement('div');
      hint.className = 'palette-row-hint';
      hint.textContent = action.hint;
      row.appendChild(hint);
    }

    // mousedown-preventDefault — тот же приём, что action-btn/peek-option:
    // без него клик по строке отбирает фокус у поля ввода раньше click.
    row.addEventListener('mousedown', (ev) => ev.preventDefault());
    row.addEventListener('click', () => runAt(index));
    return row;
  }

  function render() {
    listEl.textContent = '';
    if (!filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'palette-empty';
      empty.textContent = 'Ничего не найдено';
      listEl.appendChild(empty);
      return;
    }
    filtered.forEach((action, i) => listEl.appendChild(renderRow(action, i)));
    listEl.querySelector('.palette-row.active')?.scrollIntoView({ block: 'nearest' });
  }

  function moveSelection(delta) {
    if (!filtered.length) return;
    selected = (selected + delta + filtered.length) % filtered.length;
    render();
  }

  function runAt(index) {
    const action = filtered[index];
    if (!action) return;
    // close() ДО run() (тот же порядок, что peek.js: hide() перед onSend/
    // onOpenTab) — оверлей уходит с экрана и фокус уже вернулся терминалу
    // раньше, чем действие начнёт что-то делать (написать в pty, открыть
    // диалог папки и т.п.).
    close();
    try {
      action.run();
    } catch (err) {
      console.warn('[palette] действие упало:', err);
    }
  }

  function runSelected() {
    runAt(selected);
  }

  function onInput() {
    filtered = filterActions(actions, inputEl.value);
    selected = 0;
    render();
  }

  function onInputKeydown(ev) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      close();
    } else if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      moveSelection(1);
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      moveSelection(-1);
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      runSelected();
    }
  }

  // Клик по фону оверлея (не по панели) закрывает палитру — панель лежит
  // внутри overlayEl, поэтому клик именно по фону имеет ev.target === overlayEl.
  function onOverlayMousedown(ev) {
    if (ev.target === overlayEl) close();
  }

  function build() {
    const overlay = document.createElement('div');
    overlay.className = 'palette-overlay';

    const panel = document.createElement('div');
    panel.className = 'palette-panel';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'palette-input';
    input.placeholder = 'Команда или имя вкладки…';
    input.addEventListener('input', onInput);
    input.addEventListener('keydown', onInputKeydown);
    panel.appendChild(input);
    inputEl = input;

    const list = document.createElement('div');
    list.className = 'palette-list';
    panel.appendChild(list);
    listEl = list;

    overlay.appendChild(panel);
    overlay.addEventListener('mousedown', onOverlayMousedown);

    return overlay;
  }

  function open() {
    if (isOpenFlag) return; // повторный Ctrl+P — app.js сам решает закрыть (toggle)
    previousActive = document.activeElement;
    actions = getActions() || [];
    filtered = filterActions(actions, '');
    selected = 0;
    isOpenFlag = true;

    overlayEl = build();
    root.appendChild(overlayEl);
    render();
    inputEl.focus();
  }

  function close() {
    if (!isOpenFlag) return;
    isOpenFlag = false;
    overlayEl?.remove();
    overlayEl = null;
    inputEl = null;
    listEl = null;
    actions = [];
    filtered = [];

    const toFocus = previousActive;
    previousActive = null;
    toFocus?.focus?.();
  }

  function isOpen() {
    return isOpenFlag;
  }

  return { open, close, isOpen };
}
