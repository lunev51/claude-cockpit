'use strict';
// Оркестрация renderer: вкладки ↔ пул терминалов ↔ адресный IPC.

import { initTerminal } from './terminal.js';
import { createTabStore } from './tabs.js';
import { renderBadge } from './badge.js';

const $ = (id) => document.getElementById(id);

const views = new Map(); // tabId → {view, container}
let config = null;
let tabStore = null;
// FIX 3 (carryover 3): пока оверлей restore на экране и решение ещё не принято,
// здесь лежит функция «начать пусто» этого оверлея — null, если оверлея нет
// или он уже решён. Оверлей накрывает только #main (position:absolute; inset:0
// внутри него), а кнопка «+ Проект» живёт в сайдбаре ВНЕ этой области — без
// этого крючка пользователь мог открыть вкладку мимо оверлея, пока решение
// по восстановлению ещё не принято (см. btn-new-tab ниже и showRestoreOverlay).
let restoreOverlaySkip = null;

// Fix 8 (ревью): точка в титлбаре терракотовая, только пока есть хотя бы одна
// вкладка в статусе waiting — локальный Set, потому что удобного агрегата
// «сколько вкладок ждут» у tabStore нет.
const waitingTabs = new Set();
const titlebarDot = document.querySelector('#titlebar .dot');
function updateTitlebarAlert() {
  titlebarDot?.classList.toggle('alert', waitingTabs.size > 0);
}

// Task 1 фазы 4: тот же waitingTabs.size — агрегат для main-процесса
// (overlay-иконка таскбара + заголовок окна, см. main/attention.js).
// renderBadge рисует canvas здесь, в renderer — main про canvas не знает.
function pushAttention() {
  window.api.attention.update(waitingTabs.size, renderBadge(waitingTabs.size));
}

// Панель действий: кнопки шлют слэш-команду в pty активной вкладки (фича 23/26).
function renderActionBar() {
  const host = $('action-commands');
  host.textContent = '';
  // deepMerge (config.js) при частичном оверрайде массива объектом даёт
  // {0:…,1:…} вместо массива — Array.isArray отсекает такой и любой другой
  // некорректный actionBar.commands, чтобы не уронить boot() на итерации.
  const raw = config.actionBar?.commands;
  const rawArray = Array.isArray(raw) ? raw : [];
  if (raw !== undefined && !Array.isArray(raw)) {
    console.warn('[actionBar] config.actionBar.commands не массив — панель действий пуста', raw);
  }
  // Fix 4 (ревью): гард выше проверял только сам массив, а не его элементы —
  // commands: [null] бросал TypeError на деструктуризации { label, command }
  // ДО регистрации всего остального в boot() (хоткеи, IPC-подписки и т.д.).
  const commands = rawArray.filter(
    (c) => c && typeof c.command === 'string' && typeof c.label === 'string',
  );
  for (const { label, command } of commands) {
    const btn = document.createElement('button');
    btn.className = 'action-btn';
    btn.textContent = label;
    btn.title = `Отправить ${command} в активную вкладку`;
    // Fix 3 (ревью): без preventDefault на mousedown кнопка забирает фокус
    // ДО click — обычный ввод в терминал перестаёт работать, а рефлекторный
    // Enter повторно жмёт кнопку и шлёт команду второй раз.
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      const id = tabStore.activeId;
      if (id) {
        window.api.term.write(id, `${command}\r`);
        // Возвращаем фокус терминалу активной вкладки на случай, если он
        // всё же ушёл на кнопку (например, при активации с клавиатуры).
        views.get(id)?.view.focus();
      }
    });
    host.appendChild(btn);
  }
}

// Создать вкладку: контейнер + xterm + запись в стор. activate — переключиться сразу.
// command/args — явный оверрайд конкретного спавна (не используется восстановлением
// воркспейса — см. sessionId ниже, FIX 3 ревью).
async function openTab(cwd, {
  activate = true, command = null, args = null, preludeText = null, ghostId = null, sessionId = null,
} = {}) {
  // ghostId (Task 5, ревью finding 1a) — восстановление передаёт исходный id
  // вкладки, иначе main всегда минтит новый и старый ghost-файл осиротеет.
  // sessionId (FIX 3, ревью) — восстановление передаёт session_id из манифеста
  // ОТДЕЛЬНО от command/args: main/sessions.js сам достроит --resume поверх
  // конфигурационных args вкладки, не подменяя их и не игнорируя
  // config.terminal.command (раньше это делал сам restoreFlow, см. ниже).
  const tab = await window.api.tabs.open({
    cwd, command, args, ghostId, sessionId,
  });
  if (!tab) return null;

  const container = document.createElement('div');
  container.className = 'term-view hidden';
  $('terminal-host').appendChild(container);

  const entry = { view: null, container, lastPtyStatus: '', fontSize: config.terminal.fontSize };
  views.set(tab.tabId, entry);

  const view = initTerminal(container, config, {
    tabId: tab.tabId,
    preludeText,
    // Отладочная статус-строка убрана (панель действий заняла её место), но
    // initTerminal всё равно безусловно зовёт эти колбэки — оставляем их
    // валидными функциями, поля entry просто больше никуда не выводятся.
    onPtyStatus: (s) => {
      entry.lastPtyStatus = s;
    },
    onFontSize: (px) => {
      entry.fontSize = px;
    },
  });
  entry.view = view;

  tabStore.add(tab);
  refreshConnectBadge(tab.tabId);
  if (activate) activateTab(tab.tabId);
  return tab;
}

function activateTab(tabId) {
  const entry = views.get(tabId);
  if (!entry) return;
  for (const [id, v] of views) v.container.classList.toggle('hidden', id !== tabId);
  tabStore.setActive(tabId);
  window.api.workspace.setActive(tabId); // main пересчитает activeIndex манифеста
  // fit после показа: скрытый контейнер имеет нулевые размеры (рефит запускает
  // ResizeObserver в terminal.js сам, когда контейнер становится видимым).
  requestAnimationFrame(() => {
    entry.view.term.focus();
  });
}

// Ghost-буфер (Task 5): сериализовать буфер вкладки и отдать main на запись.
// main сам резолвит ghostId по tabId (manager.list()) — здесь просто снимок.
function saveGhost(tabId) {
  const entry = views.get(tabId);
  if (!entry || !entry.view) return;
  window.api.ghost.save(tabId, entry.view.serialize());
}

async function closeTab(tabId) {
  const entry = views.get(tabId);
  if (!entry) return;
  const wasActive = tabStore.activeId === tabId;
  // Сосед считаем ДО tabStore.remove — после удаления ряда его позиции в order() уже нет.
  const fallback = tabStore.neighborOf(tabId);
  await window.api.tabs.close(tabId);
  entry.view.dispose(); // отключает ResizeObserver и сам term (Task 6)
  entry.container.remove();
  views.delete(tabId);
  tabStore.remove(tabId);
  // Fix 8: закрытая вкладка больше не может «ждать» — иначе терракота в
  // титлбаре могла бы залипнуть, если закрыли последнюю waiting-вкладку.
  waitingTabs.delete(tabId);
  updateTitlebarAlert();
  pushAttention();
  // Переключаемся на соседнюю вкладку, только если закрыли активную —
  // закрытие фоновой вкладки не должно перебивать фокус пользователя.
  if (!wasActive) return;
  if (fallback) activateTab(fallback);
}

// Клик по ⚡: прописать хуки Cockpit в .claude/settings.json проекта вкладки.
async function connectProject(tabId) {
  try {
    const res = await window.api.project.connect(tabId);
    if (res && res.connected) tabStore.setConnectVisible(tabId, false);
    else console.warn(`[connect] не удалось: ${res && res.error}`);
  } catch (err) {
    console.warn('[connect] ошибка IPC', err);
  }
}

// Показать ⚡, если проект ещё не подключён к хукам (статусы будут молчать).
async function refreshConnectBadge(tabId) {
  try {
    const { connected } = await window.api.project.status(tabId);
    tabStore.setConnectVisible(tabId, !connected);
  } catch (err) {
    console.warn('[connect] ошибка при обновлении статуса', err);
  }
}

function bindHotkeys() {
  window.addEventListener('keydown', (ev) => {
    // Ctrl+1..9 — вкладка по индексу.
    if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && ev.key >= '1' && ev.key <= '9') {
      // preventDefault+stopPropagation — для ЛЮБОГО Ctrl+цифра, даже если
      // вкладки с таким индексом нет: xterm.evaluateKeyboardEvent маппит
      // Ctrl+3..8 на ESC/FS/GS/RS/US/DEL и шлёт их в pty независимо от
      // defaultPrevented, если событие дошло до textarea терминала (Ctrl+3
      // отправлял ESC и обрывал генерацию Claude в фокусной вкладке).
      ev.preventDefault();
      ev.stopPropagation();
      const idx = Number(ev.key) - 1;
      const ids = tabStore.order();
      if (ids[idx]) activateTab(ids[idx]);
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

// --- Экран восстановления воркспейса (Task 4) ---

// Строит список чекбоксов оверлея из манифеста; возвращает чекбоксы в
// порядке manifest.tabs (индекс совпадает — нужно для маппинга activeIndex).
function renderRestoreList(tabs) {
  const list = $('restore-list');
  list.innerHTML = '';
  const checkboxes = [];
  tabs.forEach((t) => {
    const row = document.createElement('label');
    row.className = 'restore-row';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;

    const info = document.createElement('div');
    info.className = 'restore-row-info';
    const name = document.createElement('div');
    name.className = 'restore-row-name';
    name.textContent = t.name || t.cwd;
    const cwd = document.createElement('div');
    cwd.className = 'restore-row-cwd';
    cwd.textContent = t.cwd;
    cwd.title = t.cwd;
    info.append(name, cwd);

    row.append(cb, info);

    if (t.sessionId) {
      const badge = document.createElement('span');
      badge.className = 'restore-badge';
      badge.textContent = 'сессия сохранена';
      row.appendChild(badge);
    }

    list.appendChild(row);
    checkboxes.push(cb);
  });
  return checkboxes;
}

// Последовательный подъём отмеченных вкладок со стаггером: Claude CLI
// успевает прочитать свою сессию/хуки до того, как поднимется следующая —
// параллельный залп на несколько вкладок наблюдался нестабильным.
async function restoreFlow(chosen, activeIndex, overlay) {
  // Прячем оверлей СРАЗУ, не дожидаясь даже первой вкладки: решение уже
  // принято, а гарантия «оверлей не должен зависнуть» так проще и надёжнее,
  // чем прятать его условно внутри цикла (ревью, finding 2b).
  overlay.classList.add('hidden');

  let restoredActive = null;  // вкладка с исходным manifest.activeIndex, если восстановлена
  let firstRestored = null;

  try {
    for (let idx = 0; idx < chosen.length; idx++) {
      const { t, i } = chosen[idx];
      let tab = null;
      try {
        // Ghost-буфер (Task 5): вчерашний скроллбек этой вкладки, если сохранён —
        // initTerminal впечатает его приглушённым до старта живого pty.
        const preludeText = t.ghostId ? await window.api.ghost.load(t.ghostId) : null;
        tab = await openTab(t.cwd, {
          // Первая УСПЕШНО поднятая вкладка становится видимой сразу — иначе
          // при 2+ вкладках пользователь весь стаггер смотрит в пустой терминал
          // (ревью, finding 1). Остальные — activate:false, финальная активация
          // ниже решает, какая вкладка останется на экране.
          activate: !firstRestored,
          // FIX 3 (ревью): command/args больше НЕ передаём — раньше это было
          // command:'claude', args:['--resume', sessionId], что подменяло
          // конфигурационные args вкладки (--model и т.п.) и игнорировало
          // config.terminal.command. sessionId идёт отдельно — sessions.js
          // сам достраивает --resume поверх конфигурационных args.
          sessionId: t.sessionId,
          preludeText,
          ghostId: t.ghostId,
        });
      } catch (err) {
        // Одна упавшая вкладка не должна обрывать восстановление остальных
        // (ревью, finding 2a) — пропускаем и идём дальше.
        console.warn(`[restore] не удалось открыть вкладку ${t.cwd}:`, err);
      }
      if (tab) {
        if (!firstRestored) firstRestored = tab;
        if (i === activeIndex) restoredActive = tab;
      }
      if (idx < chosen.length - 1) {
        await new Promise((r) => setTimeout(r, 1500));
      }
    }

    // Может повторно активировать ту же вкладку, что уже показана первой
    // (безвредно, activateTab идемпотентна) — либо переключить на вкладку
    // исходного manifest.activeIndex, если она восстановилась позже первой.
    const toActivate = restoredActive || firstRestored;
    if (toActivate) activateTab(toActivate.tabId);
  } finally {
    // FIX 2 (ревью): sync манифеста разблокируется ТОЛЬКО теперь — весь
    // стаггер восстановления (успешный или нет) закончен. Раньше каждый
    // openTab() внутри цикла сразу писал в манифест текущий (неполный) состав
    // вкладок — закрытие/краш посреди стаггера безвозвратно терял вкладки,
    // которые ещё не успели подняться.
    window.api.workspace.ready();
  }
}

// Показывает оверлей restore, слушает Enter/Esc и кнопки. Разрешается, когда
// пользователь принял решение (сам подъём вкладок восстановления идёт дальше
// асинхронно — оверлей к этому моменту уже спрятан либо прячется сам).
function showRestoreOverlay(manifest) {
  const overlay = $('restore-overlay');
  const btnAll = $('btn-restore-all');
  const btnNone = $('btn-restore-none');
  const checkboxes = renderRestoreList(manifest.tabs);
  overlay.classList.remove('hidden');

  function detach() {
    document.removeEventListener('keydown', onKey, true);
    btnAll.removeEventListener('click', startRestore);
    btnNone.removeEventListener('click', startEmpty);
  }

  function startEmpty() {
    detach();
    restoreOverlaySkip = null; // FIX 3: решение принято — крючок для btn-new-tab больше не нужен
    overlay.classList.add('hidden');
    // Манифест НЕ трогаем — следующее открытие/закрытие вкладки перепишет
    // его естественным образом (syncWorkspace в main реагирует на tabs:changed).
    // FIX 2 (ревью): решение «начать пусто» тоже завершает восстановление —
    // разблокируем sync сразу, ждать здесь больше нечего.
    window.api.workspace.ready();
  }

  function startRestore() {
    detach();
    restoreOverlaySkip = null; // FIX 3: решение принято (восстанавливаем) — крючок больше не нужен
    const chosen = manifest.tabs
      .map((t, i) => ({ t, i }))
      .filter(({ i }) => checkboxes[i].checked);
    if (!chosen.length) {
      overlay.classList.add('hidden');
      // FIX 2 (ревью): пустой выбор — тоже финал восстановления, а не его начало.
      window.api.workspace.ready();
      return;
    }
    // restoreFlow — fire-and-forget; per-tab ошибки уже гасятся внутри неё
    // (finding 2a), но подстраховка на случай непредвиденного throw снаружи
    // цикла (finding 2c) — необработанный reject не должен уйти в консоль
    // как unhandledrejection незамеченным.
    restoreFlow(chosen, manifest.activeIndex, overlay).catch((err) => {
      console.warn('[restore] restoreFlow упал:', err);
    });
  }

  function onKey(ev) {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      startRestore();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      startEmpty();
    }
  }

  // Горячие клавиши активны, только пока оверлей на экране.
  document.addEventListener('keydown', onKey, true);
  btnAll.addEventListener('click', startRestore);
  btnNone.addEventListener('click', startEmpty);

  // FIX 3 (carryover 3): пока оверлей не решён — крючок для btn-new-tab,
  // чтобы открытие вкладки мимо оверлея вело себя как явный клик «начать
  // пусто» (та же ветка, что и Esc/кнопка «Начать пусто»), а не как молчаливая
  // запись на диск в обход нерешённого restore.
  restoreOverlaySkip = startEmpty;
}

async function boot() {
  config = await window.api.config.get();

  tabStore = createTabStore({
    root: $('tab-groups'),
    onActivate: activateTab,
    onClose: closeTab,
    onConnect: connectProject,
  });

  renderActionBar();

  // Глобальный диспатч событий терминалов по tabId.
  window.api.term.onData(({ tabId, data }) => views.get(tabId)?.view.handlers.onData(data));
  window.api.term.onStarted((p) => {
    views.get(p.tabId)?.view.handlers.onStarted(p);
  });
  window.api.term.onExit((p) => {
    views.get(p.tabId)?.view.handlers.onExit(p);
  });
  // Task 2 фазы 4: клик по Windows-тосту — main прислал {tabId}. activateTab
  // сама тихо игнорирует неизвестный/уже закрытый tabId (views.get → undefined
  // → return), так что здесь ничего дополнительно проверять не нужно.
  window.api.tab.onActivate(({ tabId }) => activateTab(tabId));

  // Статусы приходят из хуков Claude Code (sessions.js) — единый источник,
  // term:started/term:exit статус больше не выставляют (был двойной источник).
  window.api.tab.onStatus(({ tabId, status, subtitle }) => {
    tabStore.setStatus(tabId, status, subtitle);
    // Fix 8: терракота в титлбаре горит, только пока есть хотя бы одна
    // вкладка в статусе waiting — снимаем, когда ждущих не осталось.
    if (status === 'waiting') waitingTabs.add(tabId); else waitingTabs.delete(tabId);
    updateTitlebarAlert();
    pushAttention();
    // Ghost-буфер (Task 5): переход в done/waiting — момент «Claude закончил
    // ход», самый ценный кадр скроллбека — сериализуем именно эту вкладку
    // сразу, не дожидаясь общего 30-секундного таймера ниже.
    if (status === 'done' || status === 'waiting') saveGhost(tabId);
  });

  $('btn-new-tab').addEventListener('click', async () => {
    // Fix 5 (ревью): restoreOverlaySkip() раньше звался ДО chooseFolder() —
    // отмена системного диалога папки гасила оверлей без единой вкладки и
    // без возможности восстановиться. Сначала спрашиваем папку, и только при
    // реальном выборе (folder не null) гасим restore и открываем вкладку.
    //
    // FIX 3 (carryover 3): оверлей restore накрывает только #main, а эта
    // кнопка живёт в сайдбаре — без этого крючка можно было открыть вкладку,
    // пока решение по восстановлению ещё не принято, и ничего не писалось
    // бы на диск до решения. Открытие вкладки = неявный отказ от restore:
    // прогоняем ту же ветку «начать пусто», что и Esc/кнопка в оверлее.
    const folder = await window.api.tabs.chooseFolder();
    if (folder) {
      if (restoreOverlaySkip) restoreOverlaySkip();
      openTab(folder);
    }
  });

  bindHotkeys();

  // Ghost-буфер (Task 5): периодический снимок ТОЛЬКО активной вкладки —
  // сериализация всех открытых вкладок каждые 30с дорога при нескольких
  // терминалах, а точечный снимок при переходе в done/waiting (см. onStatus
  // выше) уже ловит самый ценный кадр для фоновых вкладок.
  setInterval(() => {
    if (tabStore.activeId) saveGhost(tabStore.activeId);
  }, 30000);

  // Манифест воркспейса (Task 3): пуст/отсутствует — старое поведение
  // (стартовая вкладка из конфига). Непуст — оверлей restore (Task 4).
  const manifest = await window.api.workspace.get();
  if (!manifest || !Array.isArray(manifest.tabs) || manifest.tabs.length === 0) {
    try {
      await openTab(config.terminal.cwd || '.');
    } finally {
      // FIX 2 (carryover 3): try/finally — раньше ready() шёл СРАЗУ после await
      // openTab(...) без страховки: исключение внутри (например, initTerminal)
      // обрывало boot() до вызова ready(), и wsync.sync() молчал бы НАВСЕГДА
      // (ready так и остался бы false до конца сессии) — состав вкладок
      // переставал сохраняться вообще. Манифеста не было вообще — восстанавливать
      // нечего, разблокируем sync в любом случае, даже если openTab упал.
      window.api.workspace.ready();
    }
  } else {
    try {
      showRestoreOverlay(manifest);
    } catch (err) {
      // FIX 2 (carryover 3): showRestoreOverlay сама НЕ зовёт ready() —
      // это делают её колбэки startEmpty/startRestore по решению пользователя
      // (см. ниже). Если она упадёт ДО того, как повесит эти обработчики
      // (например, DOM оверлея не найден), ready() больше НИКОГДА не придёт —
      // тот же эффект заморозки манифеста, что и в ветке выше. Деградируем:
      // считаем, что восстанавливать нечего (как при отсутствии манифеста).
      console.warn('[restore] оверлей восстановления не показался:', err);
      // Fix 11 (ревью): showRestoreOverlay могла успеть показать оверлей
      // (overlay.classList.remove('hidden')) и упасть уже ПОСЛЕ этого,
      // внутри своего локального замыкания — без явного скрытия здесь
      // модалка залипала бы навсегда поверх главной области.
      $('restore-overlay')?.classList.add('hidden');
      window.api.workspace.ready();
    }
  }

  window.api.app.onNotice(({ text }) => console.warn(`[notice] ${text}`));
}

// Необработанный reject/throw внутри boot() раньше гас молча — приложение
// оставалось полумёртвым (окно есть, но без вкладок/хоткеев) без единой
// строки в консоли. Ловим явно.
boot().catch((err) => console.error('[boot] не удалось инициализировать renderer:', err));
