'use strict';
// Стор вкладок + рендер сайдбара с группировкой по срочности (спека, мокап B):
// Ждут тебя → Работают → Готово → Проблемы (stuck+dead) → Наготове. Пустые
// секции скрыты; порядок и раскладка — в tab-group.js.
// Порядок вкладок для Ctrl+1..9 — порядок создания, группировка чисто визуальная.

// Раскладка по секциям (включая «Наготове», живая приёмка 01.08) живёт в
// отдельном чистом модуле — здесь её нельзя было бы проверить тестом, а
// ошибка в ней и есть та самая жалоба «работают, хотя вкладка просто открыта».
// Раньше тут же стояла заглушка `idle: 'working'` с пометкой «реальный idle
// появится в 2b»: статус 'idle' не ставил никто, и нетронутые вкладки
// раздували счётчик «Работают». Теперь это настоящий статус 'ready'.
import { groupOf, GROUP_ORDER } from './tab-group.js';

// Task 4 фазы 6 (бейдж PR): классификация checks ('passing'|'failing'|'pending'|
// 'none') → CSS-модификатор .tab-pr-badge. Черновик (isDraft) визуально
// приглушаем так же, как 'none' (нет проверок) — бриф требует единого
// приглушённого стиля для «нет проверок/черновик» (app.css/.tab-pr-badge.none,
// --text-muted + заливка color-mix от --text-muted после carryover фазы 6:
// --bg-card сливался с фоном активной строки), не выделяя эти два случая
// цветом отдельно.
function prBadgeClass(pr) {
  if (pr.isDraft) return 'none';
  return pr.checks === 'passing' || pr.checks === 'failing' || pr.checks === 'pending'
    ? pr.checks
    : 'none';
}

export function createTabStore({
  root, onActivate, onClose, onConnect, onPeek, api,
}) {
  const rows = new Map(); // tabId → {row, dot, sub, connectBtn, name, cwd, status, waitingText}
  const order = [];
  let activeId = null;

  const bodyOf = (group) => root.querySelector(`[data-body="${group}"]`);
  const headOf = (group) => root.querySelector(`[data-group="${group}"]`);

  function refreshGroups() {
    for (const group of GROUP_ORDER) {
      const body = bodyOf(group);
      const head = headOf(group);
      const n = body.children.length;
      head.classList.toggle('hidden', n === 0);
      head.querySelector('.count').textContent = String(n);
    }
  }

  function placeRow(r) {
    bodyOf(groupOf(r.status)).appendChild(r.row);
    refreshGroups();
  }

  function add({ tabId, name, cwd, sessionLabel }) {
    const row = document.createElement('div');
    row.className = 'tab-row';

    const dot = document.createElement('span');
    dot.className = 'tab-dot ready';

    const info = document.createElement('div');
    info.className = 'tab-info';
    const nameEl = document.createElement('div');
    nameEl.className = 'tab-name';
    nameEl.textContent = name;
    // Живая приёмка (01.08, отзыв пользователя): «в одной папке бывает
    // несколько сессий — нечем различить». sessionLabelEl — стабильное
    // «название» вкладки (первый промпт этой сессии, sessions.js), между
    // именем проекта и путём; скрыт, пока метка не пришла (см. setStatus).
    const sessionLabelEl = document.createElement('div');
    sessionLabelEl.className = 'tab-session-label hidden';
    // I3 (ревью 01.08): восстановленная вкладка приходит с меткой из
    // манифеста — рисуем сразу, до первого tab:status.
    if (typeof sessionLabel === 'string' && sessionLabel) {
      sessionLabelEl.textContent = sessionLabel;
      sessionLabelEl.title = sessionLabel;
      sessionLabelEl.classList.remove('hidden');
    }
    const sub = document.createElement('div');
    sub.className = 'tab-sub';
    sub.textContent = cwd;
    sub.title = cwd;
    info.append(nameEl, sessionLabelEl, sub);

    // Task 4 фазы 6 (бейдж PR): маленький значок «#123» справа от имени, перед
    // кнопками ⚡/✕ (см. порядок row.append ниже) — скрыт, пока setPr(tabId, ...)
    // не принесёт данные (нет PR на текущей ветке/gh не установлен/ошибка).
    // stopPropagation — клик по бейджу не должен переключать вкладку (row сам
    // слушает click для activate/peek, см. trigger() ниже).
    const prBadge = document.createElement('span');
    prBadge.className = 'tab-pr-badge hidden';
    // Находка 12 (ревью фазы 6, минор): бейдж был кликабелен только мышью —
    // <span> без tabIndex/role внутри уже фокусируемой строки (row.tabIndex
    // ниже) недостижим с клавиатуры отдельно от неё. tabIndex=0 безвреден,
    // пока бейдж скрыт (.hidden → display:none, не участвует в табуляции) —
    // становится реальным табстопом ровно тогда, когда setPr() его показывает.
    prBadge.tabIndex = 0;
    prBadge.setAttribute('role', 'button');
    function openPrUrl(ev) {
      ev.stopPropagation();
      if (r.prUrl) api.shell.openExternal(r.prUrl);
    }
    prBadge.addEventListener('click', openPrUrl);
    prBadge.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') {
        ev.preventDefault();
        openPrUrl(ev);
      }
    });

    // ⚡ — проект не подключён к хукам (статусы «молчат»); клик прописывает их.
    const connectBtn = document.createElement('button');
    connectBtn.className = 'tab-connect hidden';
    connectBtn.textContent = '⚡';
    // Находка 4а (ревью фазы 6): ужесточение isConnected() (см. connector.js)
    // заставило ⚡ загораться и на проектах, подключённых ДО появления
    // PostToolUse, — там статусы РАБОТАЮТ (хуки шлют события), не хватает
    // только PostToolUse (обновление панели диффа при каждом вызове
    // инструмента). Старый текст «статусы молчат» в этом (самом частом
    // теперь) случае был прямой ложью.
    connectBtn.title = 'Хуки Cockpit неполные (нет PostToolUse) — подключить';
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

    // Кнопка 💬 — явный вход в peek (видна только на waiting-строке, см.
    // setStatus ниже): быстрый ответ на диалог без переключения — теперь
    // осознанный выбор, а не навязанный дефолт (живая приёмка 01.08).
    const peekBtn = document.createElement('button');
    peekBtn.className = 'tab-peek hidden';
    peekBtn.textContent = '💬';
    peekBtn.title = 'Ответить не переключаясь (peek); Space на строке — то же';
    peekBtn.addEventListener('mousedown', (ev) => ev.preventDefault());
    peekBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      onPeek(tabId, row);
    });

    row.append(dot, info, prBadge, peekBtn, connectBtn, close);

    // Живая приёмка (01.08, отзыв пользователя): клик по строке ВСЕГДА
    // переключает на вкладку — в том числе для waiting. Прежнее поведение
    // фазы 4 (клик по waiting открывал peek ВМЕСТО перехода) на практике
    // неудобно: в поповере только короткий текст уведомления без контекста
    // сессии — отвечать вслепую нечего, а самое частое действие «открой и
    // покажи, что там» превращалось в двухходовку (клик → Ctrl+Enter).
    // Peek остаётся ДОПОЛНИТЕЛЬНЫМ путём: кнопка 💬 на waiting-строке
    // (ниже) и Space на сфокусированной строке — для быстрого ответа на
    // диалог разрешения, когда контекст и так ясен.
    function trigger() {
      onActivate(tabId);
    }
    row.tabIndex = 0;
    row.addEventListener('click', trigger);
    row.addEventListener('keydown', (ev) => {
      if (ev.key === ' ' || ev.key === 'Spacebar') {
        ev.preventDefault();
        if (r.status === 'waiting') onPeek(tabId, row);
        else trigger();
      }
    });

    const r = {
      row, dot, sub, connectBtn, name, cwd, status: 'ready', waitingText: '',
      // C2 (Critical, ревью финальной волны фазы 9): waitingKind — та же
      // судьба, что waitingText (см. setStatus/waitingKindOf ниже) — зеркало
      // tab.waitingKind из sessions.js, нужное writeCommandToTab (app.js),
      // чтобы отличить idle_prompt (пишущий статус) от диалога разрешения.
      waitingKind: '',
      prBadge, prUrl: null, peekBtn,
      // Живая приёмка 01.08: зеркало tab.sessionLabel из sessions.js —
      // «название» сессии под именем проекта (в одной папке живёт несколько
      // сессий, различить их иначе нечем).
      sessionLabelEl, sessionLabel: typeof sessionLabel === 'string' ? sessionLabel : '',
    };
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

  function setStatus(tabId, status, subtitle, waitingText, waitingKind, sessionLabel) {
    const r = rows.get(tabId);
    if (!r) return;
    const regroup = groupOf(r.status) !== groupOf(status);
    r.status = status;
    r.dot.className = `tab-dot ${status}`;
    r.row.classList.toggle('waiting', status === 'waiting');
    // Кнопка 💬 (peek) видна только пока вкладка реально ждёт ответа.
    r.peekBtn.classList.toggle('hidden', status !== 'waiting');
    if (typeof subtitle === 'string' && subtitle !== '') {
      r.sub.textContent = subtitle;
      r.sub.title = subtitle;
    } else if (typeof subtitle === 'string') {
      r.sub.textContent = r.cwd;
      r.sub.title = r.cwd;
    }
    // Task 3 фазы 4 (peek): полный текст вопроса из хука Notification —
    // sessions.js сам чистит его на стороне main, когда статус уходит от
    // waiting (tab.waitingText = ''), так что здесь просто зеркалим payload.
    if (typeof waitingText === 'string') r.waitingText = waitingText;
    // C2 (Critical, ревью финальной волны фазы 9): та же судьба, что
    // waitingText выше — sessions.js уже чистит tab.waitingKind на выходе из
    // 'waiting' (эмитит ''), здесь только зеркалим payload, тем же приёмом.
    if (typeof waitingKind === 'string') r.waitingKind = waitingKind;
    // Живая приёмка 01.08: «название» сессии.
    // I2 (ревью): различаем ДВА разных «нет значения». undefined — payload
    // вообще без поля (событие не про метку) → не трогаем показанное. Пустая
    // строка — ЯВНАЯ очистка из main (restart сменил сессию через пикер:
    // старое имя стало чужим) → прячем, иначе вкладка осталась бы подписана
    // именем сессии, которой в ней больше нет.
    if (typeof sessionLabel === 'string' && sessionLabel !== r.sessionLabel) {
      r.sessionLabel = sessionLabel;
      r.sessionLabelEl.textContent = sessionLabel;
      r.sessionLabelEl.title = sessionLabel;
      r.sessionLabelEl.classList.toggle('hidden', !sessionLabel);
    }
    if (regroup) placeRow(r);
  }

  // Peek (Task 3 фазы 4): имя проекта + полный текст вопроса по tabId —
  // всё, что нужно createPeek().show() для отрисовки поповера. cwd (Task 4
  // фазы 4) добавлен туда же — палитра команд (buildPaletteActions в app.js)
  // переиспользует этот геттер для строки «Перейти: <имя>» с подсказкой-путём;
  // peek.js этот новый филд просто игнорирует, так что ничего не ломает.
  function peekInfo(tabId) {
    const r = rows.get(tabId);
    if (!r) return null;
    return {
      name: r.name, cwd: r.cwd, waitingText: r.waitingText,
    };
  }

  // C1 (ревью финальной волны фазы 7): текущий статус вкладки по tabId — или
  // null, если вкладка неизвестна/уже закрыта. app.js использует это перед
  // ЛЮБОЙ записью команды+'\r' в pty АКТИВНОЙ вкладки (рецепт/панель действий/
  // палитровые «/compact»,«/remote-control») — если вкладка сейчас 'waiting'
  // (ждёт ответа на диалог разрешения Claude Code), завершающий '\r' молча
  // подтвердил бы подсвеченный вариант диалога, а сам текст команды был бы
  // потерян. Тот же r.status, что уже использует placeRow()/trigger() выше —
  // не отдельный источник правды.
  function statusOf(tabId) {
    const r = rows.get(tabId);
    return r ? r.status : null;
  }

  // C2 (Critical, ревью финальной волны фазы 9): «какого рода» текущее
  // waiting — 'idle' (Claude Code простаивает у промпта дольше ~60с без
  // фокуса, шлёт idle_prompt — ПИШУЩИЙ статус, та же семантика, что уже
  // признаёт ночная смена, см. main/ipc.js) или 'permission'/'' (реальный
  // диалог разрешения либо вкладка не в waiting вовсе). app.js использует
  // это вместе со statusOf() в isTabBlockedByDialog — писать в waiting+idle
  // безопасно, блокировать нужно только permission.
  function waitingKindOf(tabId) {
    const r = rows.get(tabId);
    return r ? r.waitingKind : '';
  }

  function setConnectVisible(tabId, visible) {
    const r = rows.get(tabId);
    if (r) r.connectBtn.classList.toggle('hidden', !visible);
  }

  // Task 4 фазы 6 (бейдж PR): pr — {number, checks, title, url, isDraft} или
  // null (нет PR на текущей ветке/gh не установлен/репозиторий без remote/
  // сбой запроса — app.js сам решает, когда звать это с null, см. app.js).
  // Молча игнорируем неизвестный/уже закрытый tabId — тот же приём, что и
  // setStatus/setConnectVisible выше (звонок может прилететь позже закрытия
  // вкладки, гонка неважна).
  function setPr(tabId, pr) {
    const r = rows.get(tabId);
    if (!r) return;
    if (!pr || typeof pr !== 'object' || typeof pr.number !== 'number') {
      r.prUrl = null;
      r.prBadge.className = 'tab-pr-badge hidden';
      r.prBadge.textContent = '';
      r.prBadge.title = '';
      return;
    }
    r.prUrl = typeof pr.url === 'string' ? pr.url : null;
    r.prBadge.textContent = `#${pr.number}`;
    r.prBadge.title = typeof pr.title === 'string' ? pr.title : '';
    r.prBadge.className = `tab-pr-badge ${prBadgeClass(pr)}`;
  }

  // Сосед по порядку создания: предыдущий, иначе следующий (carryover 4).
  function neighborOf(tabId) {
    const i = order.indexOf(tabId);
    if (i === -1) return null;
    return order[i - 1] || order[i + 1] || null;
  }

  // waitingCount() (Task 5 carryover фазы 4/5): агрегат «сколько вкладок
  // сейчас waiting» — считаем по ТОЙ ЖЕ карте rows и тому же полю r.status,
  // которое placeRow() уже использует, чтобы решить, класть ли строку в
  // секцию «Ждут тебя» (groupOf('waiting') === 'waiting', см. tab-group.js) —
  // структурно тот же
  // критерий, а не отдельный Set в app.js, который нужно было вручную держать
  // в синхроне (add/remove/setStatus) и который однажды рассинхронизировался
  // бы сам по себе. Дёшево: вкладок обычно единицы, полный проход по rows на
  // каждый пересчёт бейджа/точки в титлбаре не создаёт заметной нагрузки.
  function waitingCount() {
    let n = 0;
    for (const r of rows.values()) {
      if (r.status === 'waiting') n += 1;
    }
    return n;
  }

  return {
    add,
    remove,
    setActive,
    setStatus,
    statusOf,
    waitingKindOf,
    setConnectVisible,
    setPr,
    neighborOf,
    peekInfo,
    waitingCount,
    order: () => [...order],
    get activeId() { return activeId; },
  };
}
