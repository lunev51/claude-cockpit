'use strict';
// Стор вкладок + рендер рядов сайдбара. Чистый DOM, без фреймворков.
// Статусы: working / waiting / done / error / idle (фаза 1 использует
// working и error; остальные готовы для машины статусов фазы 2).

export function createTabStore({ container, onActivate, onClose }) {
  const rows = new Map(); // tabId → {row, dot, sub, name, cwd, status}
  const order = [];       // порядок вкладок для Ctrl+1..9
  let activeId = null;

  function add({ tabId, name, cwd }) {
    const row = document.createElement('div');
    row.className = 'tab-row';

    const dot = document.createElement('span');
    dot.className = 'tab-dot working';

    const info = document.createElement('div');
    info.className = 'tab-info';

    const nameEl = document.createElement('div');
    nameEl.className = 'tab-name';
    nameEl.textContent = name;

    const sub = document.createElement('div');
    sub.className = 'tab-sub';
    sub.textContent = cwd;
    sub.title = cwd;

    info.append(nameEl, sub);

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.textContent = '✕';
    close.title = 'Закрыть вкладку';
    close.addEventListener('click', (ev) => {
      ev.stopPropagation();
      onClose(tabId);
    });

    row.append(dot, info, close);
    row.addEventListener('click', () => onActivate(tabId));
    container.appendChild(row);

    rows.set(tabId, { row, dot, sub, name, cwd, status: 'working' });
    order.push(tabId);
  }

  function remove(tabId) {
    const r = rows.get(tabId);
    if (!r) return;
    r.row.remove();
    rows.delete(tabId);
    const i = order.indexOf(tabId);
    if (i !== -1) order.splice(i, 1);
    if (activeId === tabId) activeId = null;
  }

  function setActive(tabId) {
    for (const [id, r] of rows) r.row.classList.toggle('active', id === tabId);
    activeId = tabId;
  }

  function setStatus(tabId, status, subtitle) {
    const r = rows.get(tabId);
    if (!r) return;
    r.status = status;
    r.dot.className = `tab-dot ${status === 'idle' ? '' : status}`.trim();
    r.row.classList.toggle('waiting', status === 'waiting');
    if (typeof subtitle === 'string') {
      r.sub.textContent = subtitle;
      r.sub.title = subtitle;
    }
  }

  return {
    add,
    remove,
    setActive,
    setStatus,
    order: () => [...order],
    get activeId() { return activeId; },
  };
}
