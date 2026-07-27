'use strict';
// Peek-поповер (Phase 4, Task 3): ответить Claude из сайдбара, не переключая
// активную вкладку. createPeek — единственный владелец DOM поповера; вся
// «сеть» (запись в pty, переключение вкладки) идёт через инжектированные
// onSend/onOpenTab — сам модуль про терминалы/вкладки ничего не знает.

import { parseOptions } from './peek-parse.js';

const MARGIN = 8; // отступ от края окна при упоре

export function createPeek({
  root, onSend, onOpenTab, onHide,
}) {
  let open = false;
  let currentTabId = null;
  let popoverEl = null;
  let inputEl = null;
  let bodyEl = null;
  let optionsEl = null;
  let currentAnchorEl = null; // запоминаем anchorEl show() — update() может перепозиционировать
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
    bodyEl = body;

    const options = buildOptions(text);
    if (options) el.appendChild(options);
    optionsEl = options; // может быть null — update() это учитывает

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
    // Fix (ревью, критично): пустой Enter в поле — это НЕ «ничего не отправить»,
    // а голый '\r' в pty ждущей вкладки. Для обычного текстового промпта это
    // безобидно, но для ПРАВ-промпта Claude Code (permission prompt) голый
    // Enter — это «согласиться с вариантом по умолчанию», причём БЕЗ единого
    // сигнала пользователю: поповер просто молча закрывается. Рефлекторный
    // Enter (закрыть поповер, как Esc) стал бы самым опасным из возможных
    // отказов этой фичи — молчаливым одобрением чужого выбора за пользователя.
    // Кнопки-варианты шлют цифру ('1'..'9') — их эта проверка не касается.
    if (!String(text).trim()) return;
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
    currentAnchorEl = anchorEl;
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
    currentAnchorEl = null;
    if (onDocKeydown) document.removeEventListener('keydown', onDocKeydown, true);
    if (onDocMousedown) document.removeEventListener('mousedown', onDocMousedown, true);
    onDocKeydown = null;
    onDocMousedown = null;
    popoverEl?.remove();
    popoverEl = null;
    inputEl = null;
    bodyEl = null;
    optionsEl = null;
    // Fix (ревью): закрытие поповера (Esc / клик вне / автозакрытие при смене
    // статуса — все три пути идут через этот же hide()) удаляет из DOM
    // сфокусированный <input>, и фокус браузером откатывается на <body> —
    // дальше набор идёт в никуда, пока пользователь не кликнет в терминал
    // руками. onHide — единая точка, куда app.js кладёт возврат фокуса
    // терминалу активной вкладки (тот же приём, что и после отправки —
    // views.get(tabStore.activeId)?.view.focus()), не завязывая сам peek.js
    // на знание о вкладках/терминалах.
    onHide?.();
  }

  // update(text): вкладка, чей поповер уже открыт, прислала ВТОРОЙ вопрос,
  // пока пользователь ещё не ответил на первый (Fix ledger-пункт) — старый
  // текст на экране рискует остаться неверным, если менять только .peek-text
  // в обход этой функции. Меняем ТОЛЬКО текст вопроса и перерисовываем
  // кнопки-варианты под него — черновик, который пользователь уже начал
  // печатать в .peek-input, не трогаем ни на символ.
  function update(text) {
    if (!open || !popoverEl) return;
    if (bodyEl) bodyEl.textContent = text;

    const fresh = buildOptions(text);
    optionsEl?.remove();
    optionsEl = fresh;
    if (optionsEl) {
      // Та же позиция, что при первой сборке в build(): после .peek-text,
      // перед .peek-input.
      popoverEl.insertBefore(optionsEl, inputEl);
    }

    // Текст мог измениться в длине (короче/длиннее исходного) — попап мог
    // выйти за край окна или перестать в него упираться; пересчитываем
    // позицию тем же anchorEl, что и при открытии.
    if (currentAnchorEl) position(currentAnchorEl);
  }

  function isOpen() {
    return open;
  }

  return {
    show, hide, update, isOpen,
  };
}
