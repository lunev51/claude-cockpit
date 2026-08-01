'use strict';
// Шпаргалка горячих клавиш (живая приёмка фазы 7: «не хватает кнопочки, где
// можно посмотреть комбинации клавиш»). Статичный оверлей: список собран
// руками и обязан обновляться вместе с bindHotkeys()/terminal.js — источника
// правды в рантайме нет (хоткеи зашиты в обработчиках, не в конфиге).
// createHotkeysOverlay — единственный владелец своего DOM, тот же контракт
// open/close/isOpen/toggle, что у dashboard/palette/search: app.js регистрирует
// его в overlayFlags() (иначе повторится класс дыры I1 финального ревью —
// оверлей, о котором не знают остальные).

const GROUPS = [
  {
    title: 'Окна',
    keys: [
      ['Ctrl+P', 'Палитра команд (рецепты, воркспейсы, действия)'],
      ['Ctrl+D', 'Дашборд лимитов и расходов'],
      ['Ctrl+G', 'Панель диффа'],
      ['Ctrl+Q', 'Очередь промптов (печатать, пока Claude занят)'],
      ['Ctrl+Shift+H', 'Поиск по истории всех сессий'],
      ['Esc', 'Закрыть открытое окно'],
    ],
  },
  {
    title: 'Вкладки',
    keys: [
      ['Ctrl+1…9', 'Перейти к вкладке по номеру'],
      ['Ctrl+Tab / Ctrl+Shift+Tab', 'Следующая / предыдущая вкладка'],
      ['💬 на строке «ждёт» (или Space)', 'Ответить не переключаясь (peek); клик по строке — открыть вкладку'],
    ],
  },
  {
    title: 'Терминал',
    keys: [
      ['Ctrl+Shift+R', 'Перезапустить завершённую сессию'],
      ['Ctrl+Shift+F', 'Поиск по буферу текущего терминала'],
      ['Ctrl+Shift+C / Ctrl+Shift+V', 'Копировать / вставить (в т.ч. скриншот)'],
      // I2 (ревью финальной волны фазы 9): без этой строки фичу невозможно
      // обнаружить — push-to-talk на правом Shift нигде больше не упомянут
      // (нет кнопки 🎤, нет пункта в палитре, см. voice-input-design.md/«Вне
      // скоупа»).
      ['Правый Shift (удерживать)', 'Голосовой ввод — говори, отпусти для отправки'],
    ],
  },
];

export function createHotkeysOverlay({ host }) {
  let isOpenFlag = false;
  let overlayEl = null;

  function build() {
    const overlay = document.createElement('div');
    overlay.className = 'hotkeys-overlay';
    // Клик по подложке закрывает — тот же паттерн, что у палитры/поиска.
    overlay.addEventListener('mousedown', (ev) => {
      if (ev.target === overlay) close();
    });

    const panel = document.createElement('div');
    panel.className = 'hotkeys-panel';

    const title = document.createElement('div');
    title.className = 'hotkeys-title';
    title.textContent = 'Горячие клавиши';
    panel.appendChild(title);

    for (const group of GROUPS) {
      const groupTitle = document.createElement('div');
      groupTitle.className = 'hotkeys-group-title';
      groupTitle.textContent = group.title;
      panel.appendChild(groupTitle);

      for (const [combo, desc] of group.keys) {
        const row = document.createElement('div');
        row.className = 'hotkeys-row';
        const kbd = document.createElement('span');
        kbd.className = 'hotkeys-combo';
        kbd.textContent = combo;
        const text = document.createElement('span');
        text.className = 'hotkeys-desc';
        text.textContent = desc;
        row.append(kbd, text);
        panel.appendChild(row);
      }
    }

    overlay.appendChild(panel);
    return overlay;
  }

  // Esc — на document в capture-фазе, регистрируется только пока оверлей
  // открыт. Capture-обработчик restore зарегистрирован раньше (boot), но при
  // открытой шпаргалке выходит без действия — она в overlayFlags(), поэтому
  // otherOverlayOpen() у restore истинен. stopPropagation — чтобы тот же Esc
  // не долетел до поля очереди/терминала и не закрыл ещё что-нибудь заодно.
  function onDocKeydown(ev) {
    if (ev.key !== 'Escape') return;
    ev.preventDefault();
    ev.stopPropagation();
    close();
  }

  function open() {
    if (isOpenFlag) return;
    overlayEl = build();
    host.appendChild(overlayEl);
    document.addEventListener('keydown', onDocKeydown, true);
    isOpenFlag = true;
  }

  function close() {
    if (!isOpenFlag) return;
    isOpenFlag = false;
    document.removeEventListener('keydown', onDocKeydown, true);
    overlayEl?.remove();
    overlayEl = null;
  }

  function toggle() {
    if (isOpenFlag) close();
    else open();
  }

  function isOpen() {
    return isOpenFlag;
  }

  return { open, close, toggle, isOpen };
}
