'use strict';
// Стор вкладок + рендер сайдбара с группировкой по срочности (спека, мокап B):
// Ждут тебя → Работают → Готово → Проблемы (stuck+dead). Пустые секции скрыты.
// Порядок вкладок для Ctrl+1..9 — порядок создания, группировка чисто визуальная.

const GROUP_OF = {
  waiting: 'waiting',
  working: 'working',
  done: 'done',
  stuck: 'trouble',
  dead: 'trouble',
  idle: 'working', // idle пока живёт в «Работают» (реальный idle появится в 2b)
};

export function createTabStore({ root, onActivate, onClose, onConnect }) {
  const rows = new Map(); // tabId → {row, dot, sub, connectBtn, name, cwd, status}
  const order = [];
  let activeId = null;

  const bodyOf = (group) => root.querySelector(`[data-body="${group}"]`);
  const headOf = (group) => root.querySelector(`[data-group="${group}"]`);

  function refreshGroups() {
    for (const group of ['waiting', 'working', 'done', 'trouble']) {
      const body = bodyOf(group);
      const head = headOf(group);
      const n = body.children.length;
      head.classList.toggle('hidden', n === 0);
      head.querySelector('.count').textContent = String(n);
    }
  }

  function placeRow(r) {
    bodyOf(GROUP_OF[r.status] || 'working').appendChild(r.row);
    refreshGroups();
  }

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

    // ⚡ — проект не подключён к хукам (статусы «молчат»); клик прописывает их.
    const connectBtn = document.createElement('button');
    connectBtn.className = 'tab-connect hidden';
    connectBtn.textContent = '⚡';
    connectBtn.title = 'Статусы молчат: подключить хуки Cockpit к проекту';
    connectBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      onConnect(tabId);
    });

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.textContent = '✕';
    close.title = 'Закрыть вкладку';
    close.addEventListener('click', (ev) => {
      ev.stopPropagation();
      onClose(tabId);
    });

    row.append(dot, info, connectBtn, close);
    row.addEventListener('click', () => onActivate(tabId));

    const r = { row, dot, sub, connectBtn, name, cwd, status: 'working' };
    rows.set(tabId, r);
    order.push(tabId);
    placeRow(r);
  }

  function remove(tabId) {
    const r = rows.get(tabId);
    if (!r) return;
    r.row.remove();
    rows.delete(tabId);
    const i = order.indexOf(tabId);
    if (i !== -1) order.splice(i, 1);
    if (activeId === tabId) activeId = null;
    refreshGroups();
  }

  function setActive(tabId) {
    for (const [id, r] of rows) r.row.classList.toggle('active', id === tabId);
    activeId = tabId;
  }

  function setStatus(tabId, status, subtitle) {
    const r = rows.get(tabId);
    if (!r) return;
    const regroup = GROUP_OF[r.status] !== GROUP_OF[status];
    r.status = status;
    r.dot.className = `tab-dot ${status}`;
    r.row.classList.toggle('waiting', status === 'waiting');
    if (typeof subtitle === 'string' && subtitle !== '') {
      r.sub.textContent = subtitle;
      r.sub.title = subtitle;
    } else if (typeof subtitle === 'string') {
      r.sub.textContent = r.cwd;
      r.sub.title = r.cwd;
    }
    if (regroup) placeRow(r);
  }

  function setConnectVisible(tabId, visible) {
    const r = rows.get(tabId);
    if (r) r.connectBtn.classList.toggle('hidden', !visible);
  }

  // Сосед по порядку создания: предыдущий, иначе следующий (carryover 4).
  function neighborOf(tabId) {
    const i = order.indexOf(tabId);
    if (i === -1) return null;
    return order[i - 1] || order[i + 1] || null;
  }

  return {
    add,
    remove,
    setActive,
    setStatus,
    setConnectVisible,
    neighborOf,
    order: () => [...order],
    get activeId() { return activeId; },
  };
}
