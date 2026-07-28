'use strict';
// Оркестрация renderer: вкладки ↔ пул терминалов ↔ адресный IPC.

import { initTerminal } from './terminal.js';
import { createTabStore } from './tabs.js';
import { renderBadge } from './badge.js';
import { createPeek } from './peek.js';
import { createPalette } from './palette.js';
import { createDashboard } from './dashboard.js';
import { renderRings } from './rings.js';
import { createDiffPanel } from './diffpanel.js';
import { createSearch } from './search.js';

const $ = (id) => document.getElementById(id);

const views = new Map(); // tabId → {view, container}
let config = null;
let tabStore = null;
let peek = null;
// Task 4 фазы 4: палитра команд (Ctrl+P) — createPalette сама владеет своим
// DOM-оверлеем (см. palette.js), здесь только держим ссылку для bindHotkeys.
let palette = null;
// Task 4 фазы 5: дашборд лимитов и расходов — createDashboard сама владеет
// своим DOM (см. dashboard.js), здесь только держим ссылку для bindHotkeys/
// панели действий/палитры и для проброса свежих usage-снапшотов, пока открыт.
let dashboard = null;
// Task 2 фазы 6: панель диффа — НЕ оверлей (см. diffpanel.js), createDiffPanel
// сама владеет своим DOM внутри #diff-panel (строится один раз при boot()).
let diffPanel = null;
// Task 3 фазы 7 (глобальный поиск истории): оверлей Ctrl+Shift+H —
// createSearch сама владеет своим DOM (см. search.js), здесь только ссылка
// для bindHotkeys/взаимного исключения с palette/dashboard/peek.
let historySearch = null;
// Task 3 фазы 4 (peek): tabId, для которого сейчас открыт поповер (или null).
// Нужен, чтобы обработчик tab:status закрывал peek ТОЛЬКО когда статус меняет
// именно ту вкладку, что сейчас показана в поповере — peek.hide() идемпотентна,
// так что устаревшее значение здесь безвредно (см. app.js/onPeek и tab:status).
let peekedTabId = null;
// FIX 3 (carryover 3): пока оверлей restore на экране и решение ещё не принято,
// здесь лежит функция «начать пусто» этого оверлея — null, если оверлея нет
// или он уже решён. Оверлей накрывает только #main (position:absolute; inset:0
// внутри него), а кнопка «+ Проект» живёт в сайдбаре ВНЕ этой области — без
// этого крючка пользователь мог открыть вкладку мимо оверлея, пока решение
// по восстановлению ещё не принято (см. btn-new-tab ниже и showRestoreOverlay).
let restoreOverlaySkip = null;
// Task 3 фазы 5 (кольца лимитов): последний известный ответ usage:get/
// usage:refresh/usage:update — {limits, spend}. null до первого разрешившегося
// usage.get() (см. boot()); redrawLimits() сама терпит null (rings.js рисует
// прочерки, не ломая вёрстку).
let lastUsage = null;
// Task 4 фазы 6 (раздел GitHub дашборда): последний ответ gh:global —
// {ok, error, prs, issues, notifications, fetchedAt} или null ДО первого
// открытия дашборда (лениво, тот же приём, что и ccusage — см.
// fetchUsageOnDashboardOpen). Отдельно от lastUsage, потому что источник другой
// (gh-info.js, не usage-oauth/ccusage), но передаётся в dashboard.render()
// вместе с ним как поле .gh (см. redrawUsageViews/getData ниже).
let lastGh = null;
// FINDING 2 (ревью, fix round 1): пока предыдущий usage:refresh не разрешился,
// повторный клик/автоповтор Enter-Space по #limits не должен запускать
// параллельный ещё один — main и сам защищён (single-flight + троттлинг, см.
// ipc.js), но лишний IPC-вызов вообще не имеет смысла посылать. Флаг + класс
// .busy (opacity/cursor:progress, см. app.css) — видимая обратная связь.
let usageRefreshing = false;

// Task 1 фазы 7 (очередь промптов): tabId → string[], зеркало server-side
// очереди (main/sessions.js), собираемое ИСКЛЮЧИТЕЛЬНО из queue:changed
// событий (см. boot() — window.api.queue.onChanged) — тот же приём, что
// tabStore зеркалит tab:status. Нет отдельного «queue:get» IPC: до первого
// enqueue для вкладки записи просто нет, что структурно совпадает с «очередь
// пуста» (renderQueueBar() ниже трактует отсутствующий tabId как []).
const queueByTab = new Map();
// Поле ввода очереди (#queue-input, Ctrl+Q) — открыто/закрыто. Отдельно от
// queueByTab: поле может быть открыто даже при пустой очереди (это и есть
// способ добавить самый первый элемент).
let queueInputOpen = false;

// Fix 8 (ревью): точка в титлбаре терракотовая, только пока есть хотя бы одна
// вкладка в статусе waiting.
// Task 5 carryover фазы 4/5: раньше здесь был отдельный локальный Set
// (waitingTabs), который приходилось вручную держать в синхроне с реальным
// статусом строк (add/remove/setStatus) — источник рассинхронизации по
// построению. Теперь агрегат структурно совпадает с инвариантом «бейдж =
// число строк в секции „Ждут тебя“»: tabStore.waitingCount() считает ровно
// то же самое поле r.status, что и placeRow() при решении, в какую секцию
// класть строку (см. tabs.js).
const titlebarDot = document.querySelector('#titlebar .dot');
function updateTitlebarAlert() {
  titlebarDot?.classList.toggle('alert', tabStore.waitingCount() > 0);
}

// Task 1 фазы 4: тот же агрегат — для main-процесса (overlay-иконка таскбара
// + заголовок окна, см. main/attention.js). renderBadge рисует canvas здесь,
// в renderer — main про canvas не знает.
function pushAttention() {
  const n = tabStore.waitingCount();
  window.api.attention.update(n, renderBadge(n));
}

// Task 4 фазы 6 (бейдж PR): «вид ошибки» уже залогирован — не спамим консоль
// на каждый тик 3-минутного таймера/активацию вкладки (папка без remote,
// отсутствующий gh и т.п. не меняются от вызова к вызову).
const loggedGhErrors = new Set();
function logGhErrorOnce(kind, detail) {
  if (loggedGhErrors.has(kind)) return;
  loggedGhErrors.add(kind);
  console.warn(`[gh] ${kind}${detail ? `: ${detail}` : ''}`);
}

// gh.repo(tabId) → бейдж PR строки сайдбара. ok:true+pr — рисуем бейдж; любой
// другой исход (нет PR на ветке, no-remote/no-gh/auth/failed, сбой самого IPC)
// молча гасит бейдж — setPr(tabId, null) уже умеет прятать его (см. tabs.js).
// gh-info.js кэширует по cwd (TTL 3 мин, дольше для 'no-gh') — повторные вызовы
// отсюда (активация вкладки/таймер ниже) не спавнят gh чаще, чем реально нужно.
async function refreshTabPr(tabId) {
  try {
    const res = await window.api.gh.repo(tabId);
    if (res && res.ok && res.pr) {
      tabStore.setPr(tabId, res.pr);
      return;
    }
    if (res && !res.ok) logGhErrorOnce(res.error || 'failed');
    else if (res && res.error === 'no-remote') logGhErrorOnce('no-remote');
    tabStore.setPr(tabId, null);
  } catch (err) {
    logGhErrorOnce('ipc-failed', err && err.message);
    tabStore.setPr(tabId, null);
  }
}

// Панель действий: кнопки шлют слэш-команду в pty активной вкладки (фича 23/26).
function renderActionBar() {
  const host = $('action-commands');
  host.textContent = '';
  // Task 4 фазы 5 (дашборд): кнопка 📊 — ПЕРВАЯ в #action-commands, отдельно
  // от списка слэш-команд из config.actionBar.commands ниже. host.textContent
  // выше стирает ВСЁ на каждый вызов renderActionBar() (вызывается один раз
  // за boot(), но пересобираем кнопку тут же, а не полагаемся на статичную
  // разметку в index.html — та была бы снесена этой же строкой).
  const dashBtn = document.createElement('button');
  dashBtn.type = 'button';
  dashBtn.id = 'btn-dashboard';
  dashBtn.className = 'action-btn';
  dashBtn.textContent = '📊';
  dashBtn.title = 'Дашборд лимитов и расходов (Ctrl+D)';
  dashBtn.addEventListener('mousedown', (e) => e.preventDefault());
  dashBtn.addEventListener('click', () => toggleDashboard());
  host.appendChild(dashBtn);
  // Task 2 фазы 6: кнопка «±» — тумблер панели диффа (та же логика, что
  // Ctrl+G, см. bindHotkeys). Тоже пересобирается на каждый renderActionBar()
  // (вызывается один раз за boot()), а не лежит статикой в index.html — тот
  // же приём, что и dashBtn выше.
  const diffBtn = document.createElement('button');
  diffBtn.type = 'button';
  diffBtn.id = 'btn-diffpanel';
  diffBtn.className = 'action-btn';
  diffBtn.textContent = '±';
  diffBtn.title = 'Панель диффа (Ctrl+G)';
  diffBtn.addEventListener('mousedown', (e) => e.preventDefault());
  diffBtn.addEventListener('click', () => toggleDiffPanel());
  host.appendChild(diffBtn);
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

// Task 1 фазы 7 (очередь промптов): перерисовать строку чипов #queue-bar
// из queueByTab для АКТИВНОЙ вкладки — очередь это ввод конкретной сессии,
// чужая вкладка не должна показывать свои чипы поверх текущей. Пустая
// очередь (или вкладки вообще нет) прячет строку целиком (бриф).
function renderQueueBar() {
  const host = $('queue-bar');
  if (!host) return;
  const tabId = tabStore.activeId;
  const queue = (tabId && queueByTab.get(tabId)) || [];
  host.textContent = '';
  if (!queue.length) {
    host.classList.add('hidden');
    return;
  }
  host.classList.remove('hidden');
  queue.forEach((text, index) => {
    const chip = document.createElement('span');
    chip.className = 'queue-chip';

    const label = document.createElement('span');
    label.className = 'queue-chip-text';
    label.textContent = `${index + 1} · ${text}`;
    label.title = text;
    chip.appendChild(label);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'queue-chip-remove';
    removeBtn.textContent = '✕';
    removeBtn.title = 'Убрать из очереди';
    // Fix 3 (ревью, тот же приём, что action-btn/tab-close): без preventDefault
    // на mousedown кнопка забирает фокус у терминала/поля ввода раньше клика.
    removeBtn.addEventListener('mousedown', (ev) => ev.preventDefault());
    removeBtn.addEventListener('click', () => {
      if (tabId) window.api.queue.remove(tabId, index);
    });
    chip.appendChild(removeBtn);

    host.appendChild(chip);
  });

  const hint = document.createElement('span');
  hint.className = 'queue-hint';
  hint.textContent = 'уйдёт, когда Claude освободится';
  host.appendChild(hint);
}

// Ctrl+Q открывает поле ввода очереди; Enter внутри него — enqueue и
// ОСТАВИТЬ поле открытым (удобно набивать несколько промптов подряд, бриф);
// Esc — закрыть и вернуть фокус терминалу активной вкладки (тот же приём
// возврата фокуса, что peek.js/onHide — см. createPeek в boot()).
function openQueueInput() {
  const row = $('queue-input-row');
  const input = $('queue-input');
  if (!row || !input) return;
  row.classList.remove('hidden');
  queueInputOpen = true;
  input.value = '';
  input.focus();
}

function closeQueueInput() {
  if (!queueInputOpen) return;
  const row = $('queue-input-row');
  row?.classList.add('hidden');
  queueInputOpen = false;
  const activeId = tabStore.activeId;
  if (activeId) views.get(activeId)?.view.focus();
}

// Task 3 фазы 5 (кольца лимитов): перерисовать #limits из lastUsage.limits.
// now инжектируется вызывающим кодом — локальный таймер 30с (см. boot()) зовёт
// это же саму функцию с новым Date.now(), чтобы обновить только отсчёт
// («сброс через …») без единого сетевого запроса, IPC или свежего снапшота.
function redrawLimits(now = Date.now()) {
  const host = $('limits');
  if (!host) return;
  renderRings(host, lastUsage ? lastUsage.limits : null, now);
}

// Task 4 фазы 5 (дашборд): единая точка «перерисовать все view usage-снапшота
// разом» — кольца сайдбара ВСЕГДА, дашборд — только если сейчас открыт
// (dashboard.render() сама не рисует ничего, если её DOM разобран, но зачем
// звать её вообще, если оверлея нет). Используется вместо голого redrawLimits()
// во всех трёх местах, где мог обновиться lastUsage: первичный usage:get в
// boot(), usage:update от main, локальный таймер 30с (см. ниже).
// Task 4 фазы 6: снапшот, который видит дашборд — {limits, spend} из lastUsage
// плюс отдельно подтянутое поле .gh (lastGh, null до первого открытия
// дашборда) — см. fetchUsageOnDashboardOpen. dashboard.js/render() и getData()
// (см. createDashboard ниже) используют ровно эту же форму.
function dashboardSnapshot() {
  return { ...(lastUsage || {}), gh: lastGh };
}

function redrawUsageViews(now = Date.now()) {
  redrawLimits(now);
  if (dashboard?.isOpen()) dashboard.render(dashboardSnapshot(), now);
}

// Клик/Enter/Space по #limits — форс-обновление обоих слоёв usage. Кнопка
// «Обновить» дашборда (Task 4 фазы 5) переиспользует ЭТУ ЖЕ функцию как
// onRefresh — тот же single-flight/троттлинг guard, что и у колец, не
// дублируется в dashboard.js.
//
// FINDING 2 (ревью, fix round 1): guard usageRefreshing — повторный вызов,
// пока предыдущий IPC-round-trip ещё не разрешился, попросту НЕ отправляется
// (main всё равно бы отбил его single-flight'ом/троттлингом, см. ipc.js, но
// незачем даже слать лишний usage:refresh). .busy — визуальная обратная связь
// (opacity + cursor:progress, app.css), пока запрос летит.
//
// Возвращает lastUsage — и на раннем guard-выходе, и в конце: дашборд зовёт
// refreshUsage() как onRefresh() и рендерит то, что она вернёт; undefined
// заставил бы его молча пропустить перерисовку кнопки «Обновить».
async function refreshUsage() {
  if (usageRefreshing) return lastUsage;
  usageRefreshing = true;
  const host = $('limits');
  host?.classList.add('busy');
  try {
    lastUsage = await window.api.usage.refresh();
  } catch (err) {
    console.warn('[usage] usage:refresh не удался:', err);
  } finally {
    usageRefreshing = false;
    host?.classList.remove('busy');
    redrawUsageViews();
  }
  return lastUsage;
}

// FIX 2 (ревью): дашборд открывался ИСКЛЮЧИТЕЛЬНО на lastUsage, снятом при
// первом usage:get() в boot() — если кокпит простоял открытым несколько
// часов, 10-минутный TTL внутри usage-ccusage.js в авто-режиме не мог
// сработать НИКОГДА (только явный клик «Обновить» вообще бил по сети), и
// пользователь в конце дня видел утренние цифры как актуальные, без единого
// намёка на возраст. Вызывается из dashboard.js/open() при КАЖДОМ открытии —
// window.api.usage.get() (НЕ usage:refresh!) сам уважает TTL: если кэш
// свежий, реального npx не будет, это дешёвый no-op. redrawUsageViews() уже
// умеет перерисовать дашборд, если он сейчас открыт, — а он открыт, раз это
// вообще было вызвано.
// Task 4 фазы 6: тем же обработчиком (тот же принцип «лениво, при каждом
// открытии») тянем сводку GitHub (gh:global). ВАЖНО: usage.get() и gh.global()
// запускаются НЕЗАВИСИМО (каждый — свой .then/.catch, тот же fire-and-forget
// приём, что и первичный usage.get() в boot()), а НЕ через один общий await —
// первый вызов usage.get() (ленивый ccusage.get() внутри может спавнить npx,
// до 60с по таймауту) не должен задерживать отрисовку раздела GitHub, если тот
// уже готов раньше. Каждый источник сам зовёт redrawUsageViews() по своему
// разрешению — раздел «загружаю…» (dashboard.js/buildGithubSection) сменится
// на реальные данные ровно тогда, когда придёт ИМЕННО его ответ, а не когда
// придут оба разом.
// FIX (ревью задачи 4 фазы 6, carryover в задачу 5): раньше оба .catch ниже
// только логировали ошибку в консоль — ни lastUsage/lastGh, ни перерисовка
// не трогались. window.api.usage.get()/gh.global() штатно НЕ бросают (main
// сам ловит любой сбой и отдаёт {ok:false,...} через .then) — .catch здесь
// это на случай РЕАЛЬНОГО отказа промиса (обрыв IPC-моста, исключение вне
// try/catch и т.п.). Без присвоения+редро в этой ветке плашка «загружаю…» у
// раздела GitHub (dashboard.js/buildGithubSection: gh===null → «загружаю…»)
// виснет навсегда до полного закрытия и повторного открытия дашборда — ни
// один последующий тик (usage:update, таймер 30с) её не перерисует, потому
// что lastGh как был null, так и остаётся. Синтетика ok:false — та же форма,
// что и настоящий error-путь usage-oauth.js/usage-ccusage.js/gh-info.js,
// dashboard.js уже умеет её рисовать («недоступны»/SPEND_UNAVAILABLE_TEXT/
// ghErrorText с фолбэком на неизвестный код).
function fetchUsageOnDashboardOpen() {
  window.api.usage.get().then((v) => {
    lastUsage = v;
    redrawUsageViews();
  }).catch((err) => {
    console.warn('[usage] usage:get при открытии дашборда не удался:', err);
    lastUsage = {
      limits: { ok: false, error: 'failed', fetchedAt: 0 },
      spend: { ok: false, error: 'failed' },
    };
    redrawUsageViews();
  });

  window.api.gh.global().then((v) => {
    lastGh = v;
    redrawUsageViews();
  }).catch((err) => {
    console.warn('[gh] gh:global при открытии дашборда не удался:', err);
    lastGh = {
      ok: false, error: 'failed', prs: [], issues: [], notifications: 0,
    };
    redrawUsageViews();
  });
}

// Task 4 фазы 5: тумблер Ctrl+D/кнопка панели действий/действие палитры —
// второе открытие, пока дашборд уже на экране, закрывает его вместо повторного
// открытия (тот же приём, что Ctrl+P у палитры, см. bindHotkeys). Взаимно
// исключаем с палитрой и peek — оба оверлея не должны показываться одновременно.
function toggleDashboard() {
  peek?.hide();
  if (palette.isOpen()) palette.close();
  // Task 3 фазы 7: та же логика — оверлей поиска не должен остаться висеть
  // «за спиной» открывающегося дашборда.
  if (historySearch?.isOpen()) historySearch.close();
  if (dashboard.isOpen()) dashboard.close();
  else dashboard.open();
}

// Task 3 фазы 7 (глобальный поиск истории): тумблер Ctrl+Shift+H — тот же
// паттерн, что toggleDashboard() выше (взаимное исключение со всеми прочими
// оверлеями, второе нажатие закрывает вместо повторного открытия).
function toggleHistorySearch() {
  peek?.hide();
  if (palette.isOpen()) palette.close();
  dashboard?.close();
  if (historySearch.isOpen()) historySearch.close();
  else historySearch.open(views.get(tabStore.activeId)?.view);
}

// Task 2 фазы 6: тумблер панели диффа (Ctrl+G/кнопка «±» панели действий) —
// НЕ оверлей (см. diffpanel.js), так что, в отличие от toggleDashboard() выше,
// не нужно закрывать peek/palette/dashboard — панель просто раздвигает layout
// рядом с терминалом, а не накрывает его. Состояние переживает перезапуск —
// пишем в config.ui.diffPanelOpen сразу после toggle().
function toggleDiffPanel() {
  diffPanel?.toggle();
  window.api.config.set({ ui: { diffPanelOpen: !!diffPanel?.isOpen() } });
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
  // Task 3 фазы 4 (peek): смена активной вкладки закрывает открытый поповер
  // безусловно — контекст (какая строка ждёт) сменился, отвечать «в сторону»
  // от текущего экрана не место.
  peek?.hide();
  // Task 5 carryover фазы 4/5: peekedTabId раньше не сбрасывался здесь — было
  // безопасно только благодаря внутренним гардам peek (peek.hide() идемпотентна,
  // а сверки tabId === peekedTabId в других местах не давали протухшему id
  // навредить), но сам факт «висит id уже закрытого поповера» — несогласованное
  // состояние. Сбрасываем для консистентности, раз поповер выше уже спрятан.
  peekedTabId = null;
  // Task 4 фазы 4 (палитра): та же логика — переключение вкладки (в т.ч. само
  // действие «Перейти: …» из палитры, которая к этому моменту уже закрыла
  // себя сама, см. palette.js/runAt) не должно оставлять палитру открытой
  // «за спиной». close() идемпотентна — безвредно, если она уже закрыта.
  palette?.close();
  // Task 4 фазы 5: та же логика — дашборд накрывает терминальную область
  // целиком, переключение вкладки под ним не должно оставлять его висеть.
  dashboard?.close();
  // Task 3 фазы 7: та же логика — оверлей поиска истории тоже накрывает окно
  // целиком (в т.ч. это естественный путь при открытии результата поиска:
  // openTab({sessionId}) → activateTab — оверлей к этому моменту уже закрыт
  // самим search.js/openAt, но close() идемпотентна, повторный вызов безвреден).
  historySearch?.close();
  // Task 1 фазы 7: очередь — ввод для КОНКРЕТНОЙ сессии; поле ввода, открытое
  // для одной вкладки, не должно молча остаться висеть (и слать текст уже не
  // в ту вкладку) после переключения на другую.
  closeQueueInput();
  for (const [id, v] of views) v.container.classList.toggle('hidden', id !== tabId);
  tabStore.setActive(tabId);
  window.api.workspace.setActive(tabId); // main пересчитает activeIndex манифеста
  // Task 2 фазы 6: переключение вкладки — один из триггеров обновления
  // панели диффа (бриф); setActiveTab сама не делает IPC, если панель сейчас
  // закрыта (см. diffpanel.js).
  diffPanel?.setActiveTab(tabId);
  // Task 1 фазы 7: строка чипов очереди — перерисовать под НОВУЮ активную
  // вкладку (queueByTab уже содержит её состояние, если хоть один
  // queue:changed для неё приходил раньше).
  renderQueueBar();
  // Task 4 фазы 6 (бейдж PR): активация вкладки — один из двух триггеров
  // обновления бейджа (второй — периодический таймер, см. boot()). Fire-and-
  // forget — сама функция никогда не бросает и обновляет tabStore асинхронно,
  // когда IPC разрешится.
  refreshTabPr(tabId);
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
  // Task 1 фазы 7: локальное зеркало server-side очереди (main уже почистил
  // свою половину внутри manager.close(), см. tabs:close в ipc.js) — без
  // этого закрытая вкладка (tabId никогда не переиспользуется, это UUID)
  // копилась бы в queueByTab до конца сессии кокпита.
  queueByTab.delete(tabId);
  // Fix 8 / Task 5 carryover: закрытая вкладка больше не может «ждать» —
  // раньше это гарантировалось отдельным waitingTabs.delete(tabId) здесь же;
  // теперь это следует структурно из tabStore.remove(tabId) — строка (и её
  // r.status) исчезает из rows ДО того, как ниже вызывается waitingCount().
  tabStore.remove(tabId);
  updateTitlebarAlert();
  pushAttention();
  // Task 3 фазы 4 (peek): закрытая вкладка не должна оставлять поповер,
  // указывающий на уже мёртвый tabId (закрытие вкладки — не единственный, но
  // реальный путь «из-под» открытого peek).
  if (peekedTabId === tabId) {
    peek?.hide();
    peekedTabId = null;
  }
  // Переключаемся на соседнюю вкладку, только если закрыли активную —
  // закрытие фоновой вкладки не должно перебивать фокус пользователя.
  if (!wasActive) return;
  if (fallback) {
    activateTab(fallback); // activateTab сама зовёт diffPanel?.setActiveTab(fallback)/renderQueueBar()
    return;
  }
  // Закрыли последнюю вкладку — панели диффа больше нечего показывать.
  diffPanel?.setActiveTab(null);
  // Task 1 фазы 7: и очереди тоже — ни поля ввода, ни строки чипов без единой
  // вкладки не должно оставаться (та же логика, что diffPanel выше).
  closeQueueInput();
  renderQueueBar();
}

// Task 3 фазы 4 (peek): клик (или Space) по строке waiting — открыть поповер
// вместо переключения вкладки. Текст вопроса и имя проекта уже лежат в
// tabStore (setStatus зеркалит waitingText из tab:status, см. boot()).
function openPeek(tabId, rowEl) {
  const info = tabStore.peekInfo(tabId);
  if (!info) return;
  peekedTabId = tabId;
  peek.show({
    tabId, name: info.name, text: info.waitingText, anchorEl: rowEl,
  });
}

// onSend поповера: дописать текст (или цифру варианта) в pty вкладки, ЧЬЁ
// имя показывал поповер — НЕ обязательно активной. Фокус терминала возвращает
// сам peek.hide() через onHide (см. boot()) — он уже отработал к этому
// моменту (send() внутри peek.js зовёт hide() ДО onSend).
function sendPeek(tabId, text) {
  window.api.term.write(tabId, `${text}\r`);
}

// Ctrl+Enter в поповере — перейти во вкладку вместо ответа из сайдбара.
function openTabFromPeek(tabId) {
  activateTab(tabId);
}

// Находка 4б (ревью фазы 6): app:notice (main/notify.js) раньше долетал до
// renderer, но показывался ИСКЛЮЧИТЕЛЬНО console.warn'ом (см. boot() ниже) —
// никакого визуального следа в самом приложении не было. showToast — простой
// тост в #toast-root (index.html/app.css): авто-исчезает через TOAST_TTL_MS,
// клик закрывает раньше. Используется и здесь (app:notice), и после успешного
// connectProject() ниже — тот же канал/тот же визуальный язык для обоих
// случаев «сообщить пользователю о важном факте, не блокируя его работу».
const TOAST_TTL_MS = 6000;
function showToast(text, level = 'info') {
  const root = $('toast-root');
  if (!root) return;
  const el = document.createElement('div');
  const cls = level === 'error' ? 'error' : (level === 'warn' ? 'warn' : 'info');
  el.className = `toast toast-${cls}`;
  el.textContent = text;
  el.setAttribute('role', 'status');
  el.addEventListener('click', () => el.remove());
  root.appendChild(el);
  setTimeout(() => el.remove(), TOAST_TTL_MS);
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

// «+ Проект»: выбор папки → новая вкладка. Вынесено в отдельную функцию
// (Task 4 фазы 4) — тот же сценарий запускают и кнопка сайдбара (boot()), и
// действие «Новый проект» в палитре команд (buildPaletteActions ниже).
async function newProject() {
  // Fix 5 (ревью): restoreOverlaySkip() раньше звался ДО chooseFolder() —
  // отмена системного диалога папки гасила оверлей без единой вкладки и без
  // возможности восстановиться. Сначала спрашиваем папку, и только при
  // реальном выборе (folder не null) гасим restore и открываем вкладку.
  //
  // FIX 3 (carryover 3): оверлей restore накрывает только #main, а точки
  // входа в это действие (кнопка сайдбара, палитра) живут вне этой области —
  // без этого крючка можно было открыть вкладку, пока решение по
  // восстановлению ещё не принято. Открытие вкладки = неявный отказ от
  // restore: прогоняем ту же ветку «начать пусто», что и Esc/кнопка в оверлее.
  const folder = await window.api.tabs.chooseFolder();
  if (folder) {
    if (restoreOverlaySkip) restoreOverlaySkip();
    openTab(folder);
  }
}

// Task 4 фазы 4 (палитра команд): полный список действий, собирается заново
// при КАЖДОМ открытии палитры (palette.js зовёт getActions() внутри open()) —
// состав вкладок мог измениться с прошлого раза. Действия над «активной»
// вкладкой (restart/hooks/compact/remote-control) добавляются, только если
// активная вкладка вообще есть — иначе им нечего делать.
function buildPaletteActions() {
  const actions = [];

  for (const tabId of tabStore.order()) {
    const info = tabStore.peekInfo(tabId);
    actions.push({
      id: `tab:${tabId}`,
      title: `Перейти: ${info ? info.name : tabId}`,
      hint: info ? info.cwd : '',
      run: () => activateTab(tabId),
    });
  }

  actions.push({
    id: 'new-project',
    title: 'Новый проект',
    hint: 'Открыть папку',
    run: () => newProject(),
  });

  // Task 4 фазы 5: действие «Дашборд» — не привязано к активной вкладке
  // (как «Новый проект» выше), доступно всегда.
  actions.push({
    id: 'dashboard',
    title: 'Дашборд',
    hint: 'Ctrl+D',
    run: () => toggleDashboard(),
  });

  // Task 3 фазы 7: действие «Поиск по истории» — тот же приём, что
  // «Дашборд» выше (не привязано к активной вкладке, доступно всегда).
  actions.push({
    id: 'history-search',
    title: 'Поиск по истории',
    hint: 'Ctrl+Shift+H',
    run: () => toggleHistorySearch(),
  });

  const activeId = tabStore.activeId;
  if (activeId) {
    actions.push({
      id: 'restart-session',
      title: 'Перезапустить сессию',
      hint: 'Ctrl+Shift+R',
      run: () => window.api.term.restart(activeId),
    });
    actions.push({
      id: 'connect-hooks',
      title: 'Подключить хуки',
      hint: '.claude/settings.json',
      run: () => connectProject(activeId),
    });
    actions.push({
      id: 'send-compact',
      title: 'Отправить /compact',
      hint: '/compact',
      run: () => window.api.term.write(activeId, '/compact\r'),
    });
    actions.push({
      id: 'send-remote-control',
      title: 'Отправить /remote-control',
      hint: '/remote-control',
      run: () => window.api.term.write(activeId, '/remote-control\r'),
    });
  }

  actions.push({
    id: 'devtools',
    title: 'Открыть DevTools',
    hint: 'F12',
    run: () => window.api.app.devtools(),
  });

  return actions;
}

function bindHotkeys() {
  window.addEventListener('keydown', (ev) => {
    // Ctrl+P — палитра команд (Task 4 фазы 4). preventDefault+stopPropagation —
    // тот же приём, что у Ctrl+Tab/Ctrl+1..9 ниже: иначе xterm получил бы
    // печатный символ 'p'/'P' в активный терминал. Второе нажатие, пока
    // палитра уже открыта, закрывает её (toggle) — открывать её заново тут
    // же бессмысленно.
    if (ev.ctrlKey && !ev.shiftKey && !ev.altKey
        && (ev.key === 'p' || ev.key === 'P' || ev.code === 'KeyP')) {
      ev.preventDefault();
      ev.stopPropagation();
      peek?.hide();
      // Task 4 фазы 5: взаимное исключение оверлеев — дашборд не должен
      // остаться висеть «за спиной» открывшейся палитры.
      dashboard?.close();
      // Task 3 фазы 7: та же логика — оверлей поиска истории тоже не должен
      // остаться висеть «за спиной» открывшейся палитры.
      if (historySearch?.isOpen()) historySearch.close();
      // Fix round 1 (ревью): peek?.hide() выше уже мог схлопнуть
      // document.activeElement на <body> (см. подробный разбор в palette.js/
      // open) — передаём терминал активной вкладки как fallback НА СЛУЧАЙ
      // именно этой ситуации; в обычном случае (Ctrl+P прямо из терминала)
      // palette.open() им не воспользуется, т.к. document.activeElement и так
      // валиден.
      if (palette.isOpen()) palette.close();
      else palette.open(views.get(tabStore.activeId)?.view);
      return;
    }
    // Ctrl+D — дашборд лимитов и расходов (Task 4 фазы 5), тот же паттерн, что
    // Ctrl+P выше (toggle + preventDefault/stopPropagation). ВНИМАНИЕ: это
    // перехватывает Ctrl+D раньше, чем событие дошло бы до textarea xterm —
    // родное значение Ctrl+D в терминале (EOF/выход из шелла) больше не
    // доходит до pty активной вкладки, пока это приложение в фокусе. То же
    // сознательное решение уже принято для Ctrl+P (перехватывает печатный
    // символ) — здесь оно явно предписано брифом задачи.
    if (ev.ctrlKey && !ev.shiftKey && !ev.altKey
        && (ev.key === 'd' || ev.key === 'D' || ev.code === 'KeyD')) {
      ev.preventDefault();
      ev.stopPropagation();
      toggleDashboard();
      return;
    }
    // Ctrl+G — панель диффа (Task 2 фазы 6), тот же паттерн preventDefault/
    // stopPropagation, что Ctrl+P/Ctrl+D выше: иначе xterm получил бы 'g'/'G'
    // в активный терминал.
    if (ev.ctrlKey && !ev.shiftKey && !ev.altKey
        && (ev.key === 'g' || ev.key === 'G' || ev.code === 'KeyG')) {
      ev.preventDefault();
      ev.stopPropagation();
      // Находка 14 (ревью фазы 6, минор): дашборд/палитра — оверлеи ПОВЕРХ
      // #main-row (где живёт #diff-panel, см. diffpanel.js) и перехватывают
      // это же сочетание раньше через bubble-обработчики самих оверлеев (у
      // них нет своего Ctrl+G) — этот обработчик висит на window в capture-
      // фазе, то есть срабатывает ПЕРВЫМ, даже когда сверху открыт другой
      // оверлей. Без гарда пользователь переключал (и сохранял в конфиг)
      // панель, невидимую под оверлеем — интерфейс молча менял состояние,
      // не показывая результат.
      if (dashboard?.isOpen() || palette?.isOpen() || historySearch?.isOpen()) return;
      toggleDiffPanel();
      return;
    }
    // Ctrl+Q — поле ввода очереди промптов (Task 1 фазы 7), тот же паттерн
    // preventDefault/stopPropagation/toggle, что Ctrl+P/Ctrl+D/Ctrl+G выше:
    // иначе xterm получил бы 'q'/'Q' в активный терминал. Гард по dashboard/
    // palette — тот же приём, что Ctrl+G («Находка 14» выше): не открывать
    // поле НЕВИДИМО под другим оверлеем, который перехватывает терминальную
    // область целиком.
    if (ev.ctrlKey && !ev.shiftKey && !ev.altKey
        && (ev.key === 'q' || ev.key === 'Q' || ev.code === 'KeyQ')) {
      ev.preventDefault();
      ev.stopPropagation();
      if (dashboard?.isOpen() || palette?.isOpen() || historySearch?.isOpen()) return;
      if (queueInputOpen) closeQueueInput();
      else openQueueInput();
      return;
    }
    // Ctrl+Shift+H — глобальный поиск по истории сессий (Task 3 фазы 7,
    // history-index.js). ВАЖНО: Ctrl+Shift+F уже занят поиском по буферу
    // ТЕКУЩЕГО терминала (см. terminal.js/attachCustomKeyEventHandler) —
    // технической коллизии нет (разные буквы, разные обработчики; этот висит
    // на window в capture-фазе и обрабатывает ТОЛЬКО 'h'/'H'/KeyH, до Ctrl+
    // Shift+F вообще не долетал бы, даже если бы совпадал), путаница была
    // только в исходном плане фазы (оба варианта ошибочно предлагались на
    // F) — решение зафиксировано в task-3-brief.md: глобальный поиск на H.
    if (ev.ctrlKey && ev.shiftKey && !ev.altKey && !ev.metaKey
        && (ev.key === 'h' || ev.key === 'H' || ev.code === 'KeyH')) {
      ev.preventDefault();
      ev.stopPropagation();
      toggleHistorySearch();
      return;
    }
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

  // FIX 4 (ревью): этот обработчик и обработчики дашборда/палитры/peek все
  // висят на document в capture-фазе, а этот зарегистрирован РАНЬШЕ (сразу в
  // boot(), см. вызов showRestoreOverlay ниже) — значит Escape/Enter при
  // нескольких открытых оверлеях сработал бы ЗДЕСЬ ПЕРВЫМ, даже если оверлей
  // restore к этому моменту визуально скрыт ПОД другим оверлеем. Сценарий:
  // старт с непустым манифестом → Ctrl+D (дашборд поверх restore) → Escape —
  // пользователь хотел закрыть дашборд, а получал startEmpty() (решение
  // «начать пусто» принято за спиной, весь список проектов потерян) и только
  // ВТОРЫМ уже закрывался сам дашборд. Игнорируем оба ключа, если сверху
  // открыт любой другой оверлей — тогда событие без preventDefault уходит
  // тому, кто ЕГО реально должен обработать (единый стек оверлеев — задача
  // следующей фазы, здесь достаточно точечной проверки).
  function otherOverlayOpen() {
    return !!(dashboard?.isOpen() || palette?.isOpen() || peek?.isOpen() || historySearch?.isOpen());
  }

  function onKey(ev) {
    if (otherOverlayOpen()) return;
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
    onPeek: openPeek,
    // Task 4 фазы 6 (бейдж PR): api — тот же приём, что diffPanel ниже
    // (createDiffPanel({..., api})) — клик по бейджу зовёт
    // api.shell.openExternal() напрямую, без отдельного колбэка на каждое действие.
    api: window.api,
  });

  // Task 3 фазы 4: peek — ответить Claude из сайдбара, не переключая вкладку.
  // onHide (ревью, фикс): закрытие поповера (Esc / клик вне / автозакрытие
  // при смене статуса вкладки — см. tab:status ниже) удаляет из DOM
  // сфокусированный <input> peek, и браузер откатывает фокус на <body> —
  // без этого набор шёл бы в никуда, пока пользователь не кликнет в терминал
  // руками. Та же строка, что уже возвращала фокус после отправки ответа.
  peek = createPeek({
    root: $('peek-root'),
    onSend: sendPeek,
    onOpenTab: openTabFromPeek,
    onHide: () => {
      const activeId = tabStore.activeId;
      if (activeId) views.get(activeId)?.view.focus();
    },
  });

  // Task 4 фазы 4: палитра команд (Ctrl+P) — getActions собирает свежий
  // список при каждом открытии (buildPaletteActions выше).
  palette = createPalette({
    root: $('palette-root'),
    getActions: buildPaletteActions,
  });

  // Task 4 фазы 5: дашборд лимитов и расходов (Ctrl+D). getData читает тот же
  // lastUsage, что и кольца сайдбара — отдельного usage:get дашборд не делает.
  // onRefresh переиспользует refreshUsage() (тот же single-flight/троттлинг
  // guard, что и клик по кольцам, см. выше). fallbackFocus — геттер, а не
  // статическое значение: активная вкладка на момент КАЖДОГО открытия
  // резолвится заново (та же проблема со «застывшим» значением, что решена в
  // palette.js/open(fallbackFocus)).
  dashboard = createDashboard({
    root: $('dashboard-root'),
    getData: dashboardSnapshot,
    onRefresh: refreshUsage,
    // FIX 2 (ревью): usage:get при каждом открытии — см. подробный комментарий
    // у fetchUsageOnDashboardOpen выше и в dashboard.js/open().
    onOpen: fetchUsageOnDashboardOpen,
    fallbackFocus: () => views.get(tabStore.activeId)?.view,
    // Task 4 фазы 6: клик по строке раздела GitHub открывает URL в браузере —
    // тот же приём, что и api в createTabStore выше (diffpanel.js тоже так
    // получает api целиком, а не по колбэку на каждое действие).
    api: window.api,
  });

  // Task 2 фазы 6 (панель диффа): состояние открыта/закрыта переживает
  // перезапуск (config.ui.diffPanelOpen, см. toggleDiffPanel). open() внутри
  // безопасен даже без единой открытой вкладки — setActiveTab(tabId) позже
  // (при первом activateTab внутри openTab/restoreFlow) сама подхватит и
  // обновит содержимое, раз панель уже открыта.
  diffPanel = createDiffPanel({ root: $('diff-panel'), api: window.api });
  if (config.ui?.diffPanelOpen) diffPanel.open();

  // Task 3 фазы 7 (глобальный поиск истории, Ctrl+Shift+H): onOpenResult —
  // открыть НОВУЮ вкладку с продолжением найденной сессии в её исходном cwd,
  // тот же openTab(cwd, {sessionId}), которым восстановление воркспейса
  // (restoreFlow выше) резюмит сессии — sessions.js сам достраивает
  // `--resume <sessionId>` поверх конфигурационных args (FIX 3, ревью).
  historySearch = createSearch({
    root: $('search-root'),
    api: window.api,
    onOpenResult: (cwd, sessionId) => openTab(cwd, { sessionId }),
  });

  renderActionBar();

  // Task 3 фазы 5 (кольца лимитов): первичный usage:get — НЕ await, чтобы
  // первый (потенциально небыстрый — ленивый ccusage.get() дёргает npx на
  // первом вызове, до 60с таймаута) запрос не задерживал остальной boot()
  // (восстановление воркспейса, открытие вкладок). Кольца просто показывают
  // прочерки (ok:false — snapshot ещё не пришёл), пока промис не разрешится.
  window.api.usage.get().then((payload) => {
    lastUsage = payload;
    redrawUsageViews();
  }).catch((err) => console.warn('[usage] usage:get не удался:', err));

  // main шлёт это после каждого успешно обнаруженного refresh поллера (см.
  // usageMonitorTimer в main/ipc.js) — payload той же формы {limits, spend}.
  // redrawUsageViews (Task 4 фазы 5) — заодно перерисовывает дашборд, если он
  // сейчас открыт (фоновый refresh не должен молчать под открытым оверлеем).
  window.api.usage.onUpdate((payload) => {
    lastUsage = payload;
    redrawUsageViews();
  });

  // Клик по кольцам — форс-обновление обоих слоёв usage (та же refreshUsage,
  // что зовёт кнопка «Обновить» дашборда). Enter/Space — та же клавиатурная
  // доступность, что и остальные интерактивные элементы сайдбара (tabindex=0
  // в index.html).
  const limitsEl = $('limits');
  limitsEl?.addEventListener('click', refreshUsage);
  limitsEl?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ' || ev.code === 'Space') {
      ev.preventDefault();
      refreshUsage();
    }
  });

  // Локальный таймер 30с — ТОЛЬКО обновление обратного отсчёта («сброс через
  // …»), без единого сетевого запроса: redrawUsageViews() просто перечитывает
  // уже известный lastUsage с новым Date.now() (и в кольцах, и в дашборде,
  // если он открыт).
  setInterval(() => redrawUsageViews(), 30000);

  // Глобальный диспатч событий терминалов по tabId.
  window.api.term.onData(({ tabId, data }) => views.get(tabId)?.view.handlers.onData(data));
  window.api.term.onStarted((p) => {
    views.get(p.tabId)?.view.handlers.onStarted(p);
  });
  window.api.term.onExit((p) => {
    views.get(p.tabId)?.view.handlers.onExit(p);
  });
  // Task 2 фазы 6 (панель диффа): PostToolUse (main/sessions.js) → git:changed.
  // diffPanel сама решает, актуально ли событие (открыта ли панель, та ли это
  // вкладка) и держит дебаунс 1500мс — здесь только проводка канала.
  window.api.git.onChanged(({ tabId }) => diffPanel?.handleGitChanged(tabId));

  // Task 1 фазы 7 (очередь промптов): queue:changed приходит и от enqueue/
  // remove/clear (клик по ✕, поле ввода), и от вброса по Stop в main/sessions.js —
  // единый источник истины, queueByTab всегда зеркалит server-side состояние
  // независимо от того, кто инициировал изменение. Перерисовываем строку
  // чипов, только если событие про СЕЙЧАС активную вкладку (чужой tabId не
  // должен трогать то, что на экране).
  window.api.queue.onChanged(({ tabId, queue }) => {
    queueByTab.set(tabId, queue);
    if (tabId === tabStore.activeId) renderQueueBar();
  });

  // Task 2 фазы 4: клик по Windows-тосту — main прислал {tabId}. activateTab
  // сама тихо игнорирует неизвестный/уже закрытый tabId (views.get → undefined
  // → return), так что здесь ничего дополнительно проверять не нужно.
  window.api.tab.onActivate(({ tabId }) => activateTab(tabId));

  // Статусы приходят из хуков Claude Code (sessions.js) — единый источник,
  // term:started/term:exit статус больше не выставляют (был двойной источник).
  window.api.tab.onStatus(({
    tabId, status, subtitle, waitingText,
  }) => {
    tabStore.setStatus(tabId, status, subtitle, waitingText);
    // Ledger-фикс (ревью): текст в поповере — статичный снимок на момент
    // открытия. Если Claude задаёт ВТОРОЙ вопрос той же вкладке, пока
    // поповер всё ещё открыт (статус остаётся waiting), пользователь рискует
    // ответить на вопрос №1, глядя на текст вопроса №1, хотя pty уже ждёт
    // ответа на №2. peek.update() меняет только текст/кнопки-варианты, не
    // трогая черновик пользователя в поле ввода — сверка tabId === peekedTabId
    // (та же, что и в закрытии ниже) защищает чужой поповер от чужого статуса.
    if (status === 'waiting' && tabId === peekedTabId) {
      const info = tabStore.peekInfo(tabId);
      if (info) peek?.update(info.waitingText);
    }
    // Task 3 фазы 4 (peek): вкладка, чей поповер сейчас на экране, перестала
    // ждать (ответили из терминала напрямую, стала stuck/dead и т.п.) —
    // закрываем поповер, чтобы он не молчал про уже неактуальный вопрос.
    // peekedTabId — «последний показанный», сверка по tabId защищает от
    // закрытия чужого (уже открытого позже, для другой вкладки) поповера.
    if (status !== 'waiting' && tabId === peekedTabId) {
      peek?.hide();
      peekedTabId = null;
    }
    // Fix 8: терракота в титлбаре горит, только пока есть хотя бы одна
    // вкладка в статусе waiting. tabStore.setStatus(...) выше уже обновил
    // r.status этой строки ДО этой точки — waitingCount() внутри
    // updateTitlebarAlert()/pushAttention() ниже увидит актуальное значение
    // без отдельного waitingTabs.add/delete (Task 5 carryover).
    updateTitlebarAlert();
    pushAttention();
    // Ghost-буфер (Task 5): переход в done/waiting — момент «Claude закончил
    // ход», самый ценный кадр скроллбека — сериализуем именно эту вкладку
    // сразу, не дожидаясь общего 30-секундного таймера ниже.
    if (status === 'done' || status === 'waiting') saveGhost(tabId);
  });

  // Task 4 фазы 4: обработчик вынесен в newProject() — тот же сценарий
  // запускает и действие «Новый проект» в палитре команд.
  $('btn-new-tab').addEventListener('click', newProject);

  // Task 1 фазы 7 (очередь промптов): Enter — поставить в очередь и ОСТАВИТЬ
  // поле открытым (бриф — удобно набивать несколько промптов подряд), Esc —
  // закрыть (closeQueueInput сама возвращает фокус терминалу активной
  // вкладки). Пустой/пробельный текст main всё равно проигнорирует
  // (sessions.js/enqueue), но очищаем поле в любом случае — так же, как peek
  // не оставляет чужой черновик висеть.
  const queueInputEl = $('queue-input');
  queueInputEl?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      const tabId = tabStore.activeId;
      const text = queueInputEl.value;
      if (tabId) window.api.queue.add(tabId, text);
      queueInputEl.value = '';
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      closeQueueInput();
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

  // Task 4 фазы 6 (бейдж PR): раз в 3 мин обновляем бейдж для ВСЕХ открытых
  // вкладок (бриф) — gh-info.js сам кэширует ответ по cwd (TTL 3 мин, дольше
  // при отсутствующем gh), так что реальный спавн gh произойдёт только там,
  // где кэш и правда успел устареть. Закрытые вкладки просто выпадают из
  // tabStore.order() — отдельная чистка таймера при закрытии не нужна (бриф).
  setInterval(() => {
    for (const tabId of tabStore.order()) refreshTabPr(tabId);
  }, 180000);

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

  // Находка 4б (ревью фазы 6): раньше это был единственный потребитель
  // app:notice — и он ТОЛЬКО логировал в консоль, ни один визуальный сигнал
  // пользователю не показывался. showToast (см. выше) — простой тост.
  window.api.app.onNotice(({ text, level }) => {
    console.warn(`[notice] ${text}`);
    showToast(text, level);
  });
}

// Необработанный reject/throw внутри boot() раньше гас молча — приложение
// оставалось полумёртвым (окно есть, но без вкладок/хоткеев) без единой
// строки в консоли. Ловим явно.
boot().catch((err) => console.error('[boot] не удалось инициализировать renderer:', err));
