'use strict';
// Оркестрация renderer: вкладки ↔ пул терминалов ↔ адресный IPC.

// ПЕРВЫЙ импорт нарочно — не убирать и не переставлять ниже. api-boot.js
// внутри ждёт top-level await (или ничего не делает, если мы в Electron и
// window.api уже собран preload'ом). ES-модули исполняют импортируемые
// модули ДО тела импортирующего — значит boot() ниже (которая на первой
// же строке зовёт window.api.config.get()) гарантированно увидит готовый
// window.api. Раньше этот же await жил в отдельном <script type="module">
// рядом в index.html — независимый параллельный модуль его не дожидался
// вообще, и в браузере (не в Electron, где смоук ничего не ловит) app.js
// стартовал раньше api-boot.js: TypeError на чтении .config у undefined
// (ревью задачи 6, Critical 1, подтверждено живым Chromium).
import './api-boot.js';
// Второй импорт ТОГО ЖЕ модуля — не оплошность: строка выше обязана остаться
// дословной и первой (её стережёт test/renderer-boot-guard.js, см. её
// обоснование там же), а состояние связи всё равно нужно взять именно оттуда.
// Повторный import того же пути не исполняет модуль заново — порядок и
// top-level await из первой строки сохраняются. linkState/onLinkChange (I3
// ревью): в браузере api-boot.js сам переподключается с нарастающим
// интервалом, а интерфейс обязан показать обрыв, а не замереть молча.
// RELOAD_MARK_KEY (C2 ре-ревью): метка «страницу перезагрузил не человек, а
// сам клиент после обрыва» — ставится там же, где живёт reload (api-boot.js),
// читается здесь ровно один раз (takeAutoReloadMark ниже).
import { linkState, onLinkChange, RELOAD_MARK_KEY } from './api-boot.js';
import { initTerminal } from './terminal.js';
import {
  curtainState, selfId, controlBlock, shouldClaimOnLoad,
} from './handoff-view.js';
import { createTabStore } from './tabs.js';
import { renderBadge } from './badge.js';
import { createPeek } from './peek.js';
import { createPalette } from './palette.js';
import { createBrowse } from './browse.js';
import { diffTabs } from './tabs-sync.js';
import { createDashboard } from './dashboard.js';
import { renderRings } from './rings.js';
import { createDiffPanel } from './diffpanel.js';
import { createSearch } from './search.js';
import { createRecipeForm } from './recipe-form.js';
import { createHotkeysOverlay } from './hotkeys.js';
import { pluralTabs } from './format.js';
import { shouldMarkSeen } from './seen.js';
// Important (ре-ревью фикс-волны): подключение к вкладке без живого процесса
// не должно его поднимать — обоснование в самом модуле.
import { shouldStartPty } from './attach-guards.js';
// Task 3 фазы 9 (голосовой ввод, push-to-talk по правому Shift): recorder —
// портирован из Companion как есть (src/renderer/js/voice/recorder.js, см.
// комментарий там же — ни одного изменённого пути импорта не понадобилось,
// структура renderer совпадает 1-в-1; I3 ревью финальной волны — точечный
// try/catch внутри start(), см. сам файл). voice-guards.js — чистые гарды
// (resolveStartBlock — можно ли стартовать запись), вынесенные отдельно ради
// node --test (см. test/voice-guards.test.js). voice-machine.js (I4 ревью
// финальной волны) — конечный автомат push-to-talk (start/stop/cancel,
// сериализация на recorder, M3 — таймер minHoldMs); app.js теперь только
// связывает DOM-события с методами машины (см. bindVoiceHotkey ниже).
import { VoiceRecorder } from './voice/recorder.js';
import { resolveStartBlock } from './voice/voice-guards.js';
import { createVoiceMachine } from './voice/voice-machine.js';

const $ = (id) => document.getElementById(id);

const views = new Map(); // tabId → {view, container}
let config = null;
let tabStore = null;
let peek = null;
// Task 4 фазы 4: палитра команд (Ctrl+P) — createPalette сама владеет своим
// DOM-оверлеем (см. palette.js), здесь только держим ссылку для bindHotkeys.
let palette = null;
// План 3: файловый обзор (Ctrl+O и кнопка «+ Проект») — createBrowse сама
// владеет своим DOM (см. browse.js), здесь только ссылка. Один и тот же экран
// в окне на ПК и в браузере на макбуке: системный диалог выбора папки при
// удалённой работе открылся бы на машине, где никого нет, да ещё поверх окна,
// спрятанного в трей.
let browse = null;
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
// Task 4 фазы 7 (рецепты промптов + именованные воркспейсы): createRecipeForm
// сама владеет своим DOM-оверлеем (мини-форма ввода, см. recipe-form.js) —
// здесь только ссылка для взаимного исключения с прочими оверлеями (тот же
// приём, что historySearch/dashboard/palette выше).
let recipeForm = null;
let hotkeysOverlay = null; // шпаргалка клавиш (живая приёмка фазы 7) — участник overlayFlags()
// Локальные зеркала server-side библиотек (main/recipes.js) — тот же приём,
// что queueByTab/lastUsage/lastGh ниже: buildPaletteActions() должна быть
// СИНХРОННОЙ (palette.js зовёт getActions() без await, см. palette.js/open()),
// а recipes:list/recipes:listWorkspaces — асинхронные IPC-вызовы. Кэш
// заполняется при boot() и обновляется сразу после «Сохранить воркспейс…»
// (см. saveCurrentWorkspace) — палитра не отстаёт больше чем на один клик.
let recipesCache = [];
let workspacesCache = [];
// Important 2 (ревью раунд 1): реентерабельность openWorkspace() — стаггер
// открытия воркспейса живёт несколько секунд (1500мс × N вкладок) БЕЗ единой
// визуальной блокировки UI; повторный вызов, пока первый ещё не закончился
// (второй клик по «Открыть воркспейс…», в т.ч. на ДРУГОМ сохранённом
// воркспейсе), запускал бы второй closeAllTabs()/стаггер поверх первого —
// закрывал бы только что открытые первым циклом вкладки, а его собственный
// setTimeout-хвост продолжал бы доливать вкладки уже после этого. Флаг
// проверяется САМОЙ ПЕРВОЙ строкой openWorkspace() (раньше даже диалога
// подтверждения) и снимается в finally — единственная ошибка внутри цикла не
// должна навсегда заблокировать открытие воркспейсов до перезапуска.
let workspaceOpenInFlight = false;
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
// C1 ре-ревью: снять оверлей restore, НЕ приняв решения — руль ушёл к соседу, и
// решает теперь он. null, если оверлея на экране нет. Отдельно от
// restoreOverlaySkip: тот означает «решение принято, начинаем пусто» (и зовёт
// workspace:ready), а здесь решение как раз откладывается.
let restoreOverlayDismiss = null;
// C1 ре-ревью: подъём воркспейса отложен — мы невладелец, а поднимать вкладки
// (tabs:open) имеет право только тот, кто за рулём. Доигрывается в
// afterControlGained(), как только управление окажется у нас.
let workspaceBootPending = false;
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
// Task 3 фазы 8 («Ночная смена»): последний известный снапшот night:get/
// night:toggle/night:changed — {armed, pendingCount, wakeAt, resetsHandled,
// journal} или null до первого разрешившегося night.get() (см. boot()).
// В отличие от lastGh, обновляется НЕ только лениво при открытии дашборда —
// push night:changed (main/night-watch.js/emitChange) держит кэш живым
// постоянно (кнопка 🌙/заголовок действия палитры должны быть верны в любой
// момент, не только пока открыт дашборд) — см. applyNightState.
let nightState = null;
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

// Task 3 фазы 9 (голосовой ввод, push-to-talk): voiceRecorder создаётся в
// boot() (VoiceRecorder — start()/stop() сами открывают/закрывают
// AudioContext на КАЖДУЮ запись, см. voice/recorder.js), voiceMachine — в
// bindVoiceHotkey() (I4, ревью финальной волны: сам конечный автомат —
// start/stop/cancel/сериализация на recorder — переехал в
// voice/voice-machine.js; здесь остаётся только тонкая привязка DOM-событий
// к его методам). sttAvailable — кэш stt:status().available, снятый один
// раз при boot() и обновляемый лениво: keydown-гард НЕ ходит в IPC на
// каждое нажатие Shift (латентность старта записи иначе выросла бы на круг
// до main и обратно) — см. boot()/refreshSttStatus.
let voiceRecorder = null;
let voiceMachine = null;
let voiceIndicatorEl = null;
let sttAvailable = true;
let sttUnavailableToastShown = false; // ОДИН тост за сессию, ТОЛЬКО для причины «стек не найден» (спека) — дальше no-op до перезапуска

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

// Перезапуск сессии активной вкладки — ОДНА реализация на все точки входа:
// кнопку ⟳ в панели действий и действие палитры. Раньше их было две, и вели
// они себя по-разному: кнопка проверяла управление и объясняла отказ тостом, а
// палитра слала term:restart напрямую — у клиента без управления действие
// молча не срабатывало (ревью 09.08, B1). Тот же класс, что чинили в I2
// ревью: две двери в один экран, ведущие себя противоположно.
//
// Хоткей Ctrl+Shift+R сюда не относится: он живёт в terminal.js и работает
// внутри уже открытого терминала.
// tabId необязателен: кнопка и палитра работают с активной вкладкой, а хоткей
// внутри терминала — со своей (фокус может держать только она, но полагаться
// на это незачем).
function restartSession(tabId = null) {
  const id = tabId || tabStore.activeId;
  // Молча не выходим: живая проверка показала случай, когда активной вкладки
  // нет (вкладки приехали синхронизацией от соседа — они подключаются БЕЗ
  // активации), и кнопка не делала ровно ничего.
  if (!id) {
    showToast('Перезапустить нечего: нет активной вкладки', 'warn');
    return;
  }
  if (!requireControl('Перезапустить сессию')) return;
  window.api.term.restart(id);
  // Фокус обратно в терминал: перезапущенная сессия должна принимать ввод
  // сразу, без лишнего клика.
  views.get(id)?.view.focus();
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
  // Живая приёмка фазы 7: кнопка ⌨ — шпаргалка горячих клавиш. Тот же
  // паттерн, что 📊/± выше (пересборка на renderActionBar, mousedown-
  // preventDefault против кражи фокуса у терминала).
  const keysBtn = document.createElement('button');
  keysBtn.type = 'button';
  keysBtn.id = 'btn-hotkeys';
  keysBtn.className = 'action-btn';
  keysBtn.textContent = '⌨';
  keysBtn.title = 'Горячие клавиши';
  keysBtn.addEventListener('mousedown', (e) => e.preventDefault());
  keysBtn.addEventListener('click', () => toggleHotkeys());
  host.appendChild(keysBtn);
  // Task 3 фазы 8 («Ночная смена»): кнопка 🌙 — ПОСЛЕ ⌨ (бриф), тот же
  // паттерн (пересборка на renderActionBar, mousedown-preventDefault). Класс
  // .armed/title обновляются ИСКЛЮЧИТЕЛЬНО из applyNightState (см. выше) —
  // здесь только дефолтный «выключено» вид на момент создания кнопки, ДО
  // первого night:get (см. boot()).
  const nightBtn = document.createElement('button');
  nightBtn.type = 'button';
  nightBtn.id = 'btn-night';
  nightBtn.className = 'action-btn';
  nightBtn.textContent = '🌙';
  nightBtn.title = 'Ночная смена: выкл';
  nightBtn.addEventListener('mousedown', (e) => e.preventDefault());
  nightBtn.addEventListener('click', () => toggleNight());
  host.appendChild(nightBtn);
  // Просьба 09.08: перезапуск сессии кнопкой, чтобы не жать Ctrl+Shift+R
  // каждый раз. Делает РОВНО то же самое — тот же канал term:restart, что у
  // хоткея и у действия палитры; отдельной логики перезапуска не заводим.
  //
  // Канал пишущий: у клиента без управления он отклонится гардом эстафеты,
  // поэтому спрашиваем заранее и отвечаем словами, а не молчанием.
  const restartBtn = document.createElement('button');
  restartBtn.type = 'button';
  restartBtn.id = 'btn-restart';
  restartBtn.className = 'action-btn';
  restartBtn.textContent = '⟳';
  restartBtn.title = 'Перезапустить сессию активной вкладки (Ctrl+Shift+R)';
  restartBtn.addEventListener('mousedown', (e) => e.preventDefault());
  restartBtn.addEventListener('click', () => restartSession());
  host.appendChild(restartBtn);
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
        // C1 (ревью финальной волны): гард статуса — см. writeCommandToTab.
        writeCommandToTab(id, command);
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
// Task 3 фазы 8: .night — nightState целиком (уже актуален, см. applyNightState) —
// в отличие от .gh, отдельного ленивого запроса при открытии дашборда не нужно.
function dashboardSnapshot() {
  return { ...(lastUsage || {}), gh: lastGh, night: nightState };
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
  // Task 4 фазы 7: та же логика — мини-форма рецепта/воркспейса тоже не
  // должна остаться висеть «за спиной» (close() — no-op, если форма закрыта).
  recipeForm?.close();
  hotkeysOverlay?.close(); // живая приёмка фазы 7: шпаргалка — такой же слой 60
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
  // Task 4 фазы 7: та же логика, что toggleDashboard() выше.
  recipeForm?.close();
  hotkeysOverlay?.close(); // живая приёмка фазы 7: шпаргалка — такой же слой 60
  if (historySearch.isOpen()) historySearch.close();
  else historySearch.open(views.get(tabStore.activeId)?.view);
}

// Живая приёмка фазы 7: тумблер шпаргалки клавиш (кнопка ⌨/действие палитры) —
// тот же паттерн взаимного исключения, что toggleDashboard()/toggleHistory-
// Search() выше: оба слоя z-60, стопка запрещена реестром overlayFlags.
function toggleHotkeys() {
  peek?.hide();
  if (palette.isOpen()) palette.close();
  dashboard?.close();
  if (historySearch?.isOpen()) historySearch.close();
  recipeForm?.close();
  hotkeysOverlay?.toggle();
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

// Task 3 фазы 8 («Ночная смена»): применяет свежий снапшот night:get/
// night:toggle/night:changed к модульному кэшу nightState И к кнопке 🌙
// панели действий — ЕДИНСТВЕННАЯ точка, которая их трогает (правило брифа:
// состояние обновляется ТОЛЬКО из ответа/события, кнопка НИКОГДА не
// переключает свой класс сама — рассинхрон с реальным armed опаснее лишнего
// тика задержки). snapshot может быть null (smoke-гейт main, см. ipc.js/
// nightGetHandler/nightToggleHandler — headless-прогон не создаёт nightWatch
// вовсе) — трактуем как «выключена», кнопка остаётся в дефолтном виде.
// Дашборд перерисовывается, только если сейчас открыт (тот же приём, что
// redrawUsageViews выше) — секция «Ночная смена» не должна отставать от
// детекта/пробуждения, пока пользователь на неё смотрит.
function applyNightState(snapshot) {
  nightState = snapshot || null;
  const btn = $('btn-night');
  if (btn) {
    const armed = !!(nightState && nightState.armed);
    btn.classList.toggle('armed', armed);
    btn.title = armed
      ? 'Ночная смена: вооружена — продолжу вкладки после сброса лимита'
      : 'Ночная смена: выкл';
  }
  if (dashboard?.isOpen()) dashboard.render(dashboardSnapshot(), Date.now());
}

// Тумблер armed — общий для кнопки 🌙 панели действий (renderActionBar) и
// одноимённого действия палитры (buildPaletteActions) — обе точки входа
// зовут ТОЛЬКО api.night.toggle(), никогда не решая за main состояние сами.
function toggleNight() {
  window.api.night.toggle().then(applyNightState).catch((err) => {
    console.warn('[night] night:toggle не удался:', err);
  });
}

// Создать вкладку: контейнер + xterm + запись в стор. activate — переключиться сразу.
// command/args — явный оверрайд конкретного спавна (не используется восстановлением
// воркспейса — см. sessionId ниже, FIX 3 ревью).
async function openTab(cwd, {
  activate = true, command = null, args = null, preludeText = null, ghostId = null, sessionId = null,
  // I3 (ревью 01.08): «название» сессии из манифеста — восстановленная
  // вкладка подписана с первой отрисовки, а не через минуту-две (главный
  // сценарий пользователя: утром десяток --resume вкладок в одной папке).
  sessionLabel = null,
} = {}) {
  // ghostId (Task 5, ревью finding 1a) — восстановление передаёт исходный id
  // вкладки, иначе main всегда минтит новый и старый ghost-файл осиротеет.
  // sessionId (FIX 3, ревью) — восстановление передаёт session_id из манифеста
  // ОТДЕЛЬНО от command/args: main/sessions.js сам достроит --resume поверх
  // конфигурационных args вкладки, не подменяя их и не игнорируя
  // config.terminal.command (раньше это делал сам restoreFlow, см. ниже).
  const tab = await window.api.tabs.open({
    cwd, command, args, ghostId, sessionId, sessionLabel,
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
    onRestartRequest: (id) => restartSession(id),
  });
  entry.view = view;

  tabStore.add(tab);
  refreshConnectBadge(tab.tabId);
  if (activate) activateTab(tab.tabId);
  return tab;
}

// --- подключение к УЖЕ живым вкладкам (C1/C2 финального ревью ветки) ---
//
// Отличие от openTab() ровно одно и главное: НИ ОДНОГО tabs:open. Вкладка уже
// существует в менеджере со своим tabId, своим pty и своей сессией Claude —
// от неё нужен только экран. Раньше этой ветки не было вовсе: любой клиент
// (браузер с макбука, второе окно, перезагрузка renderer по Ctrl+R при живом
// main) шёл через оверлей восстановления и звал tabs:open, а тот минтит НОВЫЙ
// tabId — на ПК поднимался второй `claude --resume <тот же sessionId>`, два
// процесса писали в один транскрипт и один ghost-файл, манифест удваивался и
// переживал перезапуск, следующее подключение давало ×4.
//
// Передача управления между машинами (кто владеет экраном, кого выселяют) —
// отдельный план; здесь ровно одно: подключение вместо дублирования.
async function attachTab(t, { activate = false } = {}) {
  const container = document.createElement('div');
  container.className = 'term-view hidden';
  $('terminal-host').appendChild(container);

  const entry = {
    view: null,
    container,
    lastPtyStatus: '',
    fontSize: config.terminal.fontSize,
    // Живой вывод, пришедший ПОКА едет история (см. replayHistory ниже и
    // диспатч term:data в boot()): пишем его в терминал только ПОСЛЕ истории,
    // иначе хвост буфера лёг бы поверх более свежих строк и экран показал бы
    // прошлое как настоящее. null = истории больше не ждём, пишем сразу.
    pendingOutput: [],
  };
  views.set(t.tabId, entry);

  // preludeText НЕ используем: он для ghost-буфера (вчерашний вывод —
  // приглушённый, с вырезанными escape-последовательностями, с подписью
  // «сессия поднимается»). Здесь же приезжает ЖИВАЯ история работающего pty —
  // её надо напечатать как есть, со всеми цветами (см. replayHistory).
  //
  // autoStart (Important ре-ревью): подключение НЕ имеет права поднимать
  // процесс вкладке, у которой он уже умер — обоснование и цена ошибки в
  // shouldStartPty (attach-guards.js). На живой вкладке значение true, и
  // тогда term.start внутри initTerminal делает ровно одно: заставляет
  // sessions.js/start() повторить 'term:started', без которого terminal.js
  // держал бы ввод за флагом alive навсегда («запускается…» и проглоченные
  // нажатия) — второго pty при этом не появляется (см. sessions.js/start).
  const view = initTerminal(container, config, {
    tabId: t.tabId,
    preludeText: null,
    autoStart: shouldStartPty(t),
    onPtyStatus: (s) => {
      entry.lastPtyStatus = s;
    },
    onFontSize: (px) => {
      entry.fontSize = px;
    },
    // Ctrl+Shift+R внутри терминала — третья дверь к перезапуску; ведём её в
    // ту же функцию, что кнопку ⟳ и палитру.
    onRestartRequest: (id) => restartSession(id),
  });
  entry.view = view;

  tabStore.add(t);
  // Статус из менеджера — вкладка сразу встаёт в свою секцию сайдбара
  // («Ждут тебя»/«Работают»/…), а не ждёт следующего хука Claude Code,
  // которого на спокойной вкладке может не быть часами.
  if (t.status) {
    tabStore.setStatus(t.tabId, t.status, t.subtitle, t.waitingText, t.waitingKind, t.sessionLabel);
  }
  refreshConnectBadge(t.tabId);
  if (activate) activateTab(t.tabId);

  await replayHistory(t.tabId);
  // Мёртвой вкладке говорим об этом ПРЯМО В ТЕРМИНАЛЕ, и только здесь —
  // после истории (иначе подпись легла бы выше неё и уехала бы вверх) и
  // единственным видимым способом: onPtyStatus в terminal.js кладёт строку в
  // entry.lastPtyStatus, а это поле во всём проекте больше нигде не читается
  // (отладочная статус-строка убрана ещё в фазе панели действий). Строка
  // сайдбара показывает «процесс завершён (код N)», но человек, открывший
  // вкладку, смотрит в терминал — и без этой строки видит просто застывший
  // экран, на который не реагирует клавиатура.
  if (!shouldStartPty(t)) {
    views.get(t.tabId)?.view.term.write(
      '\r\n\x1b[2m— процесс не запущен · Ctrl+Shift+R продолжит сессию —\x1b[0m\r\n',
    );
  }
  return t;
}

// История вывода вкладки (C2 финального ревью): net:buffer есть на сервере с
// задачи 4, но его никто не звал — подключившийся клиент видел пустой
// терминал, то есть пункт спеки «видно, на чём остановилась работа» не
// работал вовсе.
//
// Порядок здесь и есть вся суть: сначала печатаем историю, потом — живой
// вывод, накопленный за время её доставки (entry.pendingOutput). Пустая
// история — НОРМА (вкладка только создана, вывода ещё не было), а не ошибка.
// Отказ канала тоже не повод оставить вкладку без экрана: логируем и работаем
// дальше с живым выводом.
async function replayHistory(tabId) {
  const entry = views.get(tabId);
  if (!entry) return;
  let history = '';
  try {
    history = await window.api.net.buffer(tabId);
  } catch (err) {
    console.warn(`[attach] история вкладки ${tabId} не приехала:`, err);
  }
  // Вкладку могли закрыть, пока история ехала.
  const live = views.get(tabId);
  if (!live || live !== entry) return;
  const pending = entry.pendingOutput || [];
  entry.pendingOutput = null; // с этого момента живой вывод идёт напрямую
  if (typeof history === 'string' && history) entry.view.term.write(history);
  for (const chunk of pending) entry.view.term.write(chunk);
}

// Подключение ко всем вкладкам менеджера подряд. Стаггер здесь не нужен (в
// отличие от restoreFlow): ни одного НОВОГО процесса не поднимается — живой
// вкладке term.start лишь возвращает 'term:started' (второго pty не будет,
// см. sessions.js/start), а мёртвой мы его вовсе не шлём (shouldStartPty,
// Important ре-ревью: раньше подключение стартовало ей чистую сессию БЕЗ
// --resume и теряло старую, а N мёртвых вкладок давали N одновременных
// спавнов). Остаётся завести xterm'ы и попросить историю.
//
// Ошибка на одной вкладке не должна оставить остальные без экрана — тот же
// принцип, что в restoreFlow.
// Разобрать экран вкладки, которой больше нет в main. ТОЛЬКО интерфейс: сам
// tabs:close уже случился (либо у нас, либо у соседа — тогда мы узнали об этом
// событием tabs:changed). Вынесено из closeTab, чтобы у обоих путей была одна
// уборка: половинчатая оставляет то осиротевший xterm, то строку в сайдбаре.
function detachTabLocal(tabId) {
  const entry = views.get(tabId);
  if (entry) {
    entry.view.dispose(); // отключает ResizeObserver и сам term (Task 6)
    entry.container.remove();
    views.delete(tabId);
  }
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
}

// Состав вкладок изменился — свериться с main и догнать разницу.
//
// Живая жалоба 08.08: «открыл новую сессию на маке, вернулся на компьютер — её
// там нет, хотя она даже не пустая». Событие tabs:changed main рассылал всем
// клиентам с самого начала фазы, но подписки не было: состав вкладок расходился
// между машинами до перезагрузки страницы.
//
// Решение «кого добавить, кого убрать» живёт в чистом tabs-sync.js под тестами.
// Здесь — только применение. Вкладки соседа подключаем БЕЗ активации: человек
// смотрит на свою, и перебрасывать его на чужую новую сессию нельзя.
let tabsSyncRun = null;
async function syncTabsFromMain() {
  // Одноразовость: событий может прийти несколько подряд (открытие вкладки —
  // это два tabs:changed: сама вкладка и привязка сессии), а каждый заход
  // ходит в main и заводит xterm'ы.
  if (tabsSyncRun) return tabsSyncRun;
  tabsSyncRun = (async () => {
    let live;
    try {
      live = await window.api.tabs.list();
    } catch (err) {
      // Обрыв связи: разбирать экран по неответу нельзя (см. diffTabs).
      console.warn('[вкладки] сверка не удалась:', err.message);
      return;
    }
    const { add, remove, changed } = diffTabs(live, [...views.keys()]);
    if (!changed) return;
    for (const tabId of remove) detachTabLocal(tabId);
    if (add.length) await attachLiveTabs(add, { activate: false });
  })();
  try {
    await tabsSyncRun;
  } finally {
    tabsSyncRun = null;
  }
  return undefined;
}

async function attachLiveTabs(liveTabs, { activate = true } = {}) {
  // Живая жалоба 09.08: «вернулся на комп — сессии задвоились, а при попытке
  // закрыть дубли кокпит завис». Воспроизведено: 4 строки при 2 вкладках.
  //
  // Подключение обязано быть ИДЕМПОТЕНТНЫМ, потому что путей сюда два, и они
  // легко встречаются на одной вкладке:
  //   1) сверка составов (tabs:changed → syncTabsFromMain) — работает, пока мы
  //      зрители, и вкладки соседа приезжают на экран сами;
  //   2) отложенный подъём воркспейса (workspaceBootPending → bootWorkspace),
  //      который доигрывается в afterControlGained, когда руль вернулся к нам.
  // Зритель без своих вкладок откладывает (2), получает вкладки через (1), а
  // потом забирает управление — и (2) заходит на УЖЕ подключённые вкладки.
  //
  // Без фильтра второй заход звал attachTab на тот же tabId: tabStore.add
  // давал вторую строку в сайдбаре, а views.set перетирал первый xterm —
  // осиротевший терминал оставался висеть в DOM со своим ResizeObserver.
  // Дальше закрытие дубля било по tabId, которого в main уже нет.
  //
  // Фильтруем тем же diffTabs, что и сверка составов: одно правило «кого
  // добавить» на оба пути, а не два похожих.
  const { add } = diffTabs(liveTabs, [...views.keys()]);
  let firstAttached = null;
  for (const t of add) {
    try {
      // activate:false — путь сверки составов: вкладку завёл сосед, и
      // перебрасывать человека на неё нельзя, он смотрит на свою.
      // eslint-disable-next-line no-await-in-loop
      await attachTab(t, { activate: activate && !firstAttached });
      if (!firstAttached) firstAttached = t;
    } catch (err) {
      console.warn(`[attach] не удалось подключиться к вкладке ${t.cwd}:`, err);
    }
  }
  return firstAttached;
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
  // Task 4 фазы 7: та же логика — переключение вкладки (в т.ч. Ctrl+1..9/
  // Ctrl+Tab, минуя визуальную блокировку оверлея) не должно оставить мини-
  // форму рецепта/воркспейса висеть «за спиной» с чужим недописанным вводом.
  recipeForm?.close();
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
  // Переключился на вкладку — значит смотришь её результат (живая приёмка
  // 01.08). Гард внутри: чужие/неактивные и не-'done' не тронет.
  markSeenIfWatching(tabId);
}

// «Пользователь сейчас видит результат этой вкладки» — тот же смысл, что у
// isSuppressed в main/toasts.js («не уведомляем о том, на что и так
// смотришь»), только проверяется в renderer: document.hasFocus() честнее
// любого зеркала состояния окна, активная вкладка — локальное знание, а какой
// оверлей сейчас накрывает терминал, в main вообще не известно.
// Сам предикат — в seen.js (чистый, под тестом): решение принимают три разные
// точки, и разъезжаться им нельзя. Ядро на сообщении двигает 'done' → 'ready'.
function markSeenIfWatching(tabId) {
  const visible = shouldMarkSeen({
    tabId,
    activeId: tabStore.activeId,
    hasFocus: document.hasFocus(),
    // queue и peek исключены: строка очереди и поповер терминал не
    // перекрывают — тот же список исключений, что уже применён к Ctrl+G.
    overlayCovering: otherOverlayOpen('queue', 'peek'),
  });
  if (!visible) return;
  window.api.tabs.markSeen(tabId);
}

// Ghost-буфер (Task 5): сериализовать буфер вкладки и отдать main на запись.
// main сам резолвит ghostId по tabId (manager.list()) — здесь просто снимок.
function saveGhost(tabId) {
  const entry = views.get(tabId);
  if (!entry || !entry.view) return;
  // I1 ревью: ghost:save — ПИШУЩИЙ канал, а зовут его таймер 30с и переход
  // вкладки в done/waiting, то есть само по себе, без единого действия
  // человека. У невладельца сервер отклонял каждый такой вызов, и в консоли
  // капало по unhandled rejection каждые полминуты. Автоматика не ломится
  // туда, куда ей нельзя; .catch — на гонку (управление могло уйти между этой
  // проверкой и ответом сервера) и на обрыв связи.
  if (!hasControl()) return;
  window.api.ghost.save(tabId, entry.view.serialize())
    .catch((err) => console.warn('[ghost] снимок буфера не сохранён:', err.message));
}

async function closeTab(tabId) {
  const entry = views.get(tabId);
  if (!entry) return;
  // I2 ревью: ✕ на строке вкладки у невладельца отклонялся протоколом молча —
  // всё после await не выполнялось, строка оставалась на месте, следа не было
  // никакого. Отказываем ДО того, как что-либо тронуто.
  if (!requireControl('Закрыть вкладку')) return;
  const wasActive = tabStore.activeId === tabId;
  // Сосед считаем ДО tabStore.remove — после удаления ряда его позиции в order() уже нет.
  const fallback = tabStore.neighborOf(tabId);
  try {
    await window.api.tabs.close(tabId);
  } catch (err) {
    // Гонка (управление ушло между гардом выше и ответом) или обрыв связи:
    // main вкладку не закрыл — значит и мы не имеем права разбирать её экран,
    // иначе строка исчезнет из сайдбара при живом pty.
    console.warn(`[tabs] закрыть вкладку ${tabId} не удалось:`, err.message);
    showToast('Вкладку закрыть не удалось — попробуй ещё раз', 'warn');
    return;
  }
  detachTabLocal(tabId);
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
  // I2 ревью: поповер — способ ОТВЕТИТЬ Claude, то есть запись в pty
  // (term:write). Открывать его невладельцу значит предложить набрать текст,
  // который молча никуда не уйдёт.
  if (!requireControl('Ответить из сайдбара')) return;
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

// Тост из модуля, который про DOM ничего не знает и импортировать app.js не
// может (api-boot.js грузится ПЕРВЫМ, до всего остального, — циклический
// импорт). Единственный такой случай сегодня: браузер отказался открыть
// ссылку попапом (см. api-boot.js/openExternal).
window.addEventListener('cockpit:toast', (e) => {
  const detail = (e && e.detail) || {};
  if (typeof detail.text === 'string') showToast(detail.text, detail.level);
});

// C1 (ревью финальной волны фазы 7, критично): единый гард перед записью
// команды/текста + '\r' в pty вкладки — если целевая вкладка сейчас 'waiting'
// (ждёт ответа на диалог разрешения Claude Code), завершающий '\r' молча
// подтвердил бы подсвеченный вариант диалога, а сам текст команды/рецепта
// был бы потерян. Сценарий из ревью: Claude спрашивает «Bash: rm -rf build —
// 1. Yes / 2. No» → статус waiting → Ctrl+P → «Рецепт: Отревьюй мои
// изменения» → Enter → голый '\r' выбирает вариант №1, инструмент выполняется
// без ревью. Используется ВЕЗДЕ, где renderer пишет команду в pty НЕ как
// осознанный ответ на конкретный диалог: рецепты (runRecipe), кнопки панели
// действий (renderActionBar), палитровые «Отправить /compact»/
// «/remote-control» (buildPaletteActions). НЕ используется в sendPeek() —
// peek.js СПЕЦИАЛЬНО предназначен для ответа НА ЭТОТ waiting-диалог, у него
// СВОЙ гард другой смысловой природы (непустой текст, см. peek.js/send() —
// не даёт голому Enter молча подтвердить дефолт диалога; статус вкладки его
// не касается, потому что peek и есть штатный способ ответить, пока статус
// waiting).
//
// C2 (Critical, ревью финальной волны фазы 9): 'waiting' САМ ПО СЕБЕ больше
// не блокирует безусловно — см. isTabBlockedByDialog ниже. Claude Code шлёт
// idle_prompt (~раз в 60с без фокуса терминала), пока просто простаивает у
// промпта — это ПИШУЩИЙ статус, та же семантика, что уже применяет ночная
// смена (main/ipc.js вбрасывает туда «продолжай»), а вовсе не диалог
// разрешения с вариантами Yes/No. Блокируем ТОЛЬКО waitingKind==='permission'
// (и неизвестные значения — консервативный дефолт, см. classifyNotification
// в sessions.js).
function isTabBlockedByDialog(tabId) {
  return tabStore.statusOf(tabId) === 'waiting' && tabStore.waitingKindOf(tabId) !== 'idle';
}

function writeCommandToTab(tabId, command) {
  if (!tabId) return false;
  if (isTabBlockedByDialog(tabId)) {
    showToast('Вкладка ждёт ответа на диалог — команда не отправлена', 'warn');
    return false;
  }
  window.api.term.write(tabId, `${command}\r`);
  return true;
}

// --- Task 3 фазы 9: голосовой ввод (push-to-talk по правому Shift) ---
// I4 (ревью финальной волны): сам конечный автомат (start/stop/cancel,
// сериализация на recorder, M3 — таймер minHoldMs) переехал в
// voice/voice-machine.js БЕЗ изменения поведения — здесь остаётся только
// тонкая привязка DOM-событий к его методам, плюс индикатор/доставка,
// которые машина не знает как рисовать/куда писать (инжектируются в неё).

// Индикатор в #action-right: «🎤 запись…» пока идёт запись (в т.ч. пока
// getUserMedia ещё грузится, 'starting', и пока идёт сам стоп, 'stopping' —
// пользователю не нужно различать эти состояния на глаз, вся троица длится
// от миллисекунд до долей секунды), «🎤 …» пока распознаётся, скрыт в покое
// (включая 'pending' — M3, микрофон ещё не тронут, показывать «запись…» было
// бы неправдой). Рамка вокруг #action-bar — дешёвый доп.сигнал (бриф), в те
// же моменты, что и бейдж «запись…». Вызывается машиной на КАЖДЫЙ переход
// состояния (indicator, см. createVoiceMachine).
function updateVoiceIndicatorForState(state) {
  if (!voiceIndicatorEl) return;
  const recordingLike = state === 'starting' || state === 'recording' || state === 'stopping';
  if (recordingLike) {
    voiceIndicatorEl.textContent = '🎤 запись…';
    voiceIndicatorEl.classList.remove('hidden');
  } else if (state === 'transcribing') {
    voiceIndicatorEl.textContent = '🎤 …';
    voiceIndicatorEl.classList.remove('hidden');
  } else {
    voiceIndicatorEl.classList.add('hidden');
  }
  $('action-bar')?.classList.toggle('recording', recordingLike);
}

// Бейдж создаётся программно в #action-right (тот же приём, что кнопки
// #action-commands в renderActionBar выше) — бриф модифицирует только app.js/
// app.css, не index.html.
function initVoiceIndicator() {
  const host = $('action-right');
  if (!host) return;
  voiceIndicatorEl = document.createElement('span');
  voiceIndicatorEl.id = 'voice-indicator';
  voiceIndicatorEl.className = 'hidden';
  host.insertBefore(voiceIndicatorEl, host.firstChild);
}

// Ревью Task 3, Minor 2: при обнаруженной недоступности стека на keydown
// (см. bindVoiceHotkey) перечитываем status() заново, лениво и
// fire-and-forget — стек, скопированный ПОСЛЕ boot() (пользователь долил
// vendor/models, пока кокпит уже открыт), подхватится со следующего же
// нажатия Shift, а не только после перезапуска приложения.
function refreshSttStatus() {
  window.api.stt.status().then((s) => {
    sttAvailable = !!(s && s.available);
  }).catch((err) => {
    console.warn('[voice] stt:status не удался:', err);
    sttAvailable = false; // сбой похода в main — безопаснее считать стек недоступным, чем оптимистичным true по умолчанию
  });
}

// Инжектируется в voiceMachine как `deliver` — вызывается ЛИБО с тостом
// (микрофон недоступен/пусто/ошибка распознавания — tabId будет null,
// см. resolveTranscribeResult в voice-guards.js/voice-machine.js), ЛИБО с
// решением «доставить текст» (decision.action==='deliver'). tabId — снимок
// activeId, сделанный машиной СИНХРОННО на keyup (C1, Critical, ревью
// финальной волны) — а НЕ на момент вызова этой функции (после
// stt:transcribe: до 2×20с подъёма сервера + 60с инференса, с ретраем до
// ~200с суммарно). Тот же принцип, что runRecipe (ниже) резолвит tabId ДО
// await с явным комментарием «даже если он успеет переключиться» — без
// этого пользователь мог продиктовать в A, переключиться в B (Ctrl+Tab/клик
// по Windows-тосту), пока горит «🎤 …», и текст+Enter ушёл бы в ЧУЖОЙ проект.
async function deliverVoiceOutcome(tabId, decision) {
  if (decision.action === 'toast') {
    showToast(decision.message, decision.level);
    return;
  }
  // decision.action === 'deliver' — непустой распознанный текст.
  // C1: вкладка могла закрыться, пока шло распознавание, ИЛИ её вообще не
  // было в момент keyup (statusOf(null) тоже вернёт null) — тост, не отправляем.
  if (!tabId || tabStore.statusOf(tabId) === null) {
    showToast('Вкладка закрыта — текст не отправлен', 'warn');
    return;
  }
  const text = await window.api.recipes.normalizeForPty(decision.text);
  if (isTabBlockedByDialog(tabId)) {
    // C2, смягчение (ревью финальной волны): waiting+permission блокирует
    // обычную доставку — но распознанный текст не должен пропадать
    // безвозвратно только потому, что вкладка сейчас ждёт ответа человека на
    // СОВСЕМ ДРУГОЙ вопрос. Буфер обмена — fire-and-forget, без await на
    // весь показ тоста (навигатор сам управляет своим таймингом).
    try {
      await navigator.clipboard.writeText(text);
      showToast('Вкладка ждёт диалога — текст скопирован в буфер обмена', 'warn');
    } catch (err) {
      console.warn('[voice] clipboard.writeText упал:', err);
      showToast('Вкладка ждёт диалога — команда не отправлена', 'warn');
    }
    return;
  }
  // M1 (ревью финальной волны): focus() ТОЛЬКО при реально успешной записи —
  // writeCommandToTab возвращает false и на случай гонки (isTabBlockedByDialog
  // выше уже сказал «нет», но состояние вкладки успело измениться между этой
  // проверкой и самой записью) — фокус терминала не должен перескакивать на
  // вкладку, в которую текст фактически не попал.
  if (writeCommandToTab(tabId, text)) views.get(tabId)?.view.focus();
}

// keydown/keyup правого Shift — ОТДЕЛЬНЫЙ обработчик от bindHotkeys() (бриф):
// Shift сам по себе ничего не печатает в терминал, а Shift+буква должен
// продолжать работать штатно — БЕЗ preventDefault/stopPropagation, в отличие
// от Ctrl-комбинаций в bindHotkeys(). capture-фаза — та же, что и там, чтобы
// открытые оверлеи (которые тоже слушают keydown) не перехватили событие
// первыми — хотя запись и так не стартует, пока открыт хоть один (см.
// resolveStartBlock, voice-guards.js).
//
// Ревью раунда 1: C2 (Alt+ShiftRight — смена раскладки Windows, Ctrl+Shift+*)
// и I1 (печать другой клавиши во время удержания — заглавные буквы штатным
// Shift+буква) — оба решаются здесь. C2: модификатор УЖЕ зажат в момент
// нажатия ShiftRight — проверяем ev.ctrlKey/altKey/metaKey ПЕРВЫМ делом после
// repeat, до старта записи. I1 и «модификатор нажат ПОСЛЕ ShiftRight»
// (Shift нажат первым, затем Ctrl/Alt/любая буква) — единый случай: ЛЮБОЙ
// keydown с ev.code, отличным от holdKey, пока машина не idle — тихая отмена
// (voiceMachine.cancel(), она сама no-op'ает, если нечего отменять), это не
// диктовка. Ревью финальной волны: I1 (мышь — mousedown/wheel, штатное
// выделение в xterm Shift+клик/Shift+колесо) и C4 (blur/visibilitychange) —
// тот же voiceMachine.cancel(), привязанный отдельными слушателями ниже —
// машине всё равно, КТО попросил отменить.
function bindVoiceHotkey() {
  const holdKey = config.stt?.holdKey || 'ShiftRight';
  const minHoldMs = Number.isFinite(config.stt?.minHoldMs) ? config.stt.minHoldMs : 300;

  voiceMachine = createVoiceMachine({
    recorder: voiceRecorder,
    transcribe: (wav) => window.api.stt.transcribe(wav),
    deliver: deliverVoiceOutcome,
    indicator: updateVoiceIndicatorForState,
    getActiveTabId: () => tabStore.activeId,
    minHoldMs,
    // N-1 (ре-ревью финальной волны): диагностика в DevTools — смоук считает
    // только level 'error', warn его не ломает.
    log: (msg, err) => console.warn(msg, err),
  });

  window.addEventListener('keydown', (ev) => {
    if (ev.code !== holdKey) {
      voiceMachine.cancel();
      return;
    }
    if (ev.repeat) return; // авто-повтор зажатой клавиши — не должен перезапускать запись
    if (ev.ctrlKey || ev.altKey || ev.metaKey) return; // C2: Alt+ShiftRight (смена раскладки)/Ctrl+Shift+* — модификатор зажат ДО ShiftRight, это не push-to-talk
    if (voiceMachine.state !== 'idle') return; // занято: предыдущий цикл ещё не осел (N1)
    const hasActiveTab = !!tabStore.activeId;
    const overlaysOpen = Object.values(overlayFlags()).some(Boolean);
    const block = resolveStartBlock({ overlaysOpen, hasActiveTab, sttAvailable });
    if (!block.allowed) {
      if (block.reason === 'stt-unavailable') {
        refreshSttStatus(); // Minor 2: лениво подхватить стек, скопированный ПОСЛЕ boot(), без перезапуска приложения
        if (!sttUnavailableToastShown) {
          sttUnavailableToastShown = true; // ОДИН тост за сессию, ТОЛЬКО для причины «стек не найден» — дальше no-op до перезапуска
          showToast(block.toast.message, block.toast.level);
        }
      }
      return;
    }
    voiceMachine.requestStart();
  }, { capture: true });

  window.addEventListener('keyup', (ev) => {
    if (ev.code !== holdKey) return;
    // Оверлей открылся ВО ВРЕМЯ записи (спека) — тихая отмена, тот же исход,
    // что и короткое нажатие/печать другой клавиши. Проверяется здесь (а не
    // внутри машины), т.к. только app.js знает, что такое «оверлей».
    const overlaysOpen = Object.values(overlayFlags()).some(Boolean);
    if (overlaysOpen) voiceMachine.cancel();
    else voiceMachine.requestStop();
  }, { capture: true });

  // C4 (ревью раунда 2): потеря фокуса окна (Alt+Tab, клик по другому
  // приложению) или скрытие вкладки браузера — keyup, отпускающий ShiftRight,
  // уйдёт уже ДРУГОМУ окну/вкладке и никогда не долетит до обработчика выше.
  window.addEventListener('blur', () => voiceMachine.cancel());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) voiceMachine.cancel();
  });

  // Живая приёмка 01.08: третий момент «прочитано» — окно вернуло фокус, а на
  // экране всё это время висела вкладка, которая успела ответить. Первые два —
  // переключение на вкладку (activateTab) и ответ, пришедший на активной
  // вкладке (обработчик onStatus). Без этого результат, дождавшийся тебя из
  // Alt+Tab, навсегда остался бы в «Готово».
  window.addEventListener('focus', () => {
    // Отсрочка — не косметика. Окно могло подняться кликом по тосту ЧУЖОЙ
    // вкладки: main делает win.focus(), а 'tab:activate' шлёт следующей
    // строкой (main.js/focusTab), и оба доезжают сюда асинхронно — порядок не
    // гарантирован. Без паузы прочитанной пометилась бы вкладка, которая была
    // активна ДО клика, то есть та, на которую как раз НЕ смотрели.
    // markSeenIfWatching перечитывает activeId в момент срабатывания.
    setTimeout(() => {
      if (tabStore.activeId) markSeenIfWatching(tabStore.activeId);
    }, 400);
  });
  // I1 (ревью финальной волны): мышь с зажатым Shift — штатное выделение
  // текста в xterm (Shift+клик выделяет диапазон, Shift+колесо — горизонтальный
  // скролл), НЕ диктовка. Без этого удержанный Shift во время обычной работы
  // мышью тихо копил бы тишину/шум комнаты, и whisper (large-v3) на тишине
  // регулярно галлюцинирует читаемый, но бессмысленный текст («Продолжение
  // следует…», «Субтитры сделал…») — который улетел бы с Enter в терминал.
  // passive:true на wheel — мы не зовём preventDefault, скролл не должен тормозить.
  window.addEventListener('mousedown', () => voiceMachine.cancel(), { capture: true });
  window.addEventListener('wheel', () => voiceMachine.cancel(), { capture: true, passive: true });
}

// Клик по ⚡: прописать хуки Cockpit в .claude/settings.json проекта вкладки.
async function connectProject(tabId) {
  // I2 ревью: project:connect — СВОБОДНЫЙ канал (чтение статуса и запись хуков
  // живут в одной паре), то есть у невладельца он не отклонялся, а честно
  // переписывал .claude/settings.json в проекте владельца. Гард здесь, в
  // единственной точке входа кнопки ⚡/действия палитры.
  if (!requireControl('Подключить хуки')) return;
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
  // I2 ревью: у невладельца «+ Проект» открывал СИСТЕМНЫЙ диалог выбора папки
  // на машине владельца — окно которой в этот момент спрятано в трей (диалог
  // модальный, и человек за ПК получал бы его в лицо неизвестно от кого).
  // Дальше tabs:open всё равно отклонился бы. Не зовём то, что заведомо
  // отклонится, и говорим почему.
  // План 3: вместо системного диалога — свой обзор, одинаковый в окне и в
  // браузере. Гард управления здесь СНЯТ намеренно: сам обзор — это чтение,
  // листать каталоги может и зритель. Отказ невладельцу выдаёт кнопка
  // «Открыть сессию здесь» внутри обзора (см. onOpenHere в boot).
  await browse.open(browseStartPath());
}

// Откуда открывать обзор. Без этого он стартовал бы от корня диска (живая
// проверка задачи 4): пусто → фолбэк на 'C:\\'. Полезнее начинать рядом с тем,
// над чем человек работает, — папка активной вкладки почти всегда соседствует
// с той, которую он собирается открыть. Нет вкладок — пусть решает сам обзор
// (он помнит последнюю посещённую папку за сеанс).
function browseStartPath() {
  const info = tabStore?.peekInfo(tabStore.activeId);
  return (info && info.cwd) || '';
}

// Прежний путь «+ Проект» через системный диалог — оставлен точкой входа для
// кнопки «Системное окно» внутри обзора (только в окне на ПК).
async function newProjectViaSystemDialog() {
  if (!requireControl('Новый проект')) return;
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

// Task 4 фазы 7 (библиотека рецептов промптов): перечитать recipesCache из
// main. Fire-and-forget, тот же приём, что usage.get()/gh.global() в boot() —
// список рецептов не меняется в этой задаче в обход самого файла на диске
// (палитра только читает), так что одного обновления при старте достаточно.
async function refreshRecipesCache() {
  try {
    recipesCache = await window.api.recipes.list();
  } catch (err) {
    console.warn('[recipes] recipes:list не удался:', err);
    recipesCache = [];
  }
}

async function refreshWorkspacesCache() {
  try {
    workspacesCache = await window.api.recipes.listWorkspaces();
  } catch (err) {
    console.warn('[recipes] recipes:listWorkspaces не удался:', err);
    workspacesCache = [];
  }
}

// Действие палитры «Рецепт: <title>» (Task 4 фазы 7): при наличии
// плейсхолдеров — сперва мини-форма ввода (recipeForm), затем подстановка
// (main/recipes.js:fillPrompt, единственный источник истины для этой логики —
// не дублируем regex здесь) и запись в pty АКТИВНОЙ на момент запуска действия
// вкладки. tabId резолвим ДО возможного await формы — так что запись уйдёт
// именно туда, где пользователь фактически выбрал действие, даже если он
// успеет переключиться на другую вкладку, пока форма ещё на экране.
async function runRecipe(recipe) {
  const tabId = tabStore.activeId;
  if (!tabId) return; // нет ни одной вкладки — писать некуда
  let text = recipe.text;
  const placeholders = Array.isArray(recipe.placeholders) ? recipe.placeholders : [];
  if (placeholders.length) {
    const fields = placeholders.map((name) => ({ key: name, label: name }));
    const values = await recipeForm.open({ title: recipe.title, fields });
    if (!values) return; // Esc/клик вне формы — пользователь отменил
    text = await window.api.recipes.fillPrompt(recipe.text, values);
  }
  // Minor 8 (ревью раунд 1): БЕЗУСЛОВНО (даже без плейсхолдеров) — внутренний
  // перенос строки в тексте рецепта терминал воспринимает как отдельный
  // Enter (первая строка ушла бы САМОСТОЯТЕЛЬНЫМ промптом раньше остальных, а
  // диалог разрешения — молча подтверждён), та же проектная ловушка, что
  // голый '\r'. normalizeForPty — чистая функция main/recipes.js, единственный
  // источник истины (не дублируем regex здесь).
  text = await window.api.recipes.normalizeForPty(text);
  // Ловушка из брифа: пустой/пробельный текст — НЕ отправляем голый '\r' в pty
  // (для диалога разрешения Claude Code это молчаливое согласие с вариантом
  // по умолчанию) — тот же guard, что peek.js/send().
  if (!text || !text.trim()) return;
  // C1 (ревью финальной волны, критично): гард статуса — см. writeCommandToTab.
  // Рецепт — НЕ ответ на конкретный диалог waiting; в отличие от peek.js,
  // здесь нет иного пути узнать, что пользователь на самом деле хотел ответить
  // именно на подсвеченный вариант, а не отправить рецепт позже.
  writeCommandToTab(tabId, text);
  views.get(tabId)?.view.focus();
}

// Действие палитры «Сохранить воркспейс…» (Task 4 фазы 7): спросить имя через
// ту же мини-форму (одно поле), взять ТЕКУЩИЙ состав вкладок из tabStore
// (cwd+name — то же, что переживает restart/restore, см. tabs.js/peekInfo) и
// отдать main на запись. workspacesCache обновляется сразу же — следующее же
// открытие палитры увидит «Открыть воркспейс: <имя>» без перезапуска кокпита.
async function saveCurrentWorkspace() {
  const values = await recipeForm.open({
    title: 'Сохранить воркспейс',
    fields: [{ key: 'name', label: 'Имя воркспейса' }],
  });
  if (!values) return; // отменено
  const tabs = tabStore.order().map((tabId) => {
    const info = tabStore.peekInfo(tabId);
    return { cwd: info ? info.cwd : '', name: info ? info.name : '' };
  }).filter((t) => t.cwd);
  const saved = await window.api.recipes.saveWorkspace(values.name, tabs);
  if (saved) await refreshWorkspacesCache(); // пустое/пробельное имя → saved:null, кэш не трогаем
}

// Действие палитры «Открыть воркспейс: <name>» (Task 4 фазы 7): закрыть ВСЕ
// текущие вкладки, затем поднять состав именованного воркспейса со стаггером
// 1500мс между вкладками — тот же интервал и тот же повод (Claude CLI должен
// успеть прочитать хуки/сессию, прежде чем поднимется следующая вкладка), что
// и restoreFlow() выше, но написан ОТДЕЛЬНО от неё: restoreFlow заточена под
// восстановление манифеста при старте (ghost-буферы, sessionId резюма,
// activeIndex, сигнал workspace.ready() наружу) — эти сущности здесь не при
// делах (именованный воркспейс хранит только {cwd, name}, без сессии), а
// трогать уже несколько раз отревьюженный restoreFlow ради нового сценария
// рискованнее, чем повторить сам стаггер-цикл в компактном виде.
async function closeAllTabs() {
  // Последовательно — closeTab мутирует общий tabStore/views, параллельный
  // close() нескольких вкладок сразу рискует гонкой (neighborOf/activateTab
  // внутри closeTab читают tabStore, который в этот же момент меняет другой
  // параллельный вызов).
  for (const tabId of tabStore.order()) {
    await closeTab(tabId);
  }
}

async function openWorkspace(ws) {
  // Important 2 (ревью раунд 1): гард — САМАЯ ПЕРВАЯ строка, раньше даже
  // restoreOverlaySkip()/диалога подтверждения ниже. Повторный вызов, пока
  // предыдущий стаггер ещё не завершился, — молчаливый no-op (см. подробности
  // у объявления workspaceOpenInFlight выше).
  if (workspaceOpenInFlight) return;

  // N2 (ре-ревью раунда 1): состав профиля проверяем ДО закрытия чего-либо и
  // до диалога. Иначе существует путь «закрыли всё, не открыли ничего»:
  // запись с нулём валидных вкладок (их разрешала сохранять сборка до Minor 6,
  // и в чужой библиотеке такие остались) убивала бы все живые сессии, а
  // манифест перезаписывался бы пустым составом. Пустой профиль — не ошибка,
  // а бесполезное действие: говорим об этом и выходим, ничего не тронув.
  const tabs = (Array.isArray(ws && ws.tabs) ? ws.tabs : [])
    .filter((t) => t && typeof t.cwd === 'string' && t.cwd);
  if (!tabs.length) {
    showToast(`В воркспейсе «${ws.name}» нет ни одной вкладки`, 'warn');
    return;
  }

  const currentCount = tabStore.order().length;
  if (currentCount > 0) {
    // Требование (не из автоматического ревью, но блокирующее): действие
    // необратимо — убивает N живых сессий Claude, а манифест воркспейса тут
    // же перезаписывается пустым составом по мере закрытия каждой вкладки
    // (tabs:changed → syncWorkspace), то есть sessionId для --resume из него
    // исчезают безвозвратно. Один Enter не должен уметь это сделать без
    // явного подтверждения. Нулевой текущий состав — спрашивать нечего.
    const phrase = currentCount === 1
      ? 'Текущая вкладка будет закрыта'
      : `Текущие ${currentCount} ${pluralTabs(currentCount)} будут закрыты`;
    const confirmed = await recipeForm.open({
      title: `Открыть воркспейс «${ws.name}»? ${phrase}`,
      fields: [],
    });
    if (!confirmed) return; // Esc/«Отмена»/клик вне — пользователь передумал
  }

  // Important 1 (ревью раунд 1): оверлей restore мог всё ещё быть на экране
  // (решение не принято, wsync инертен) — палитра рисуется ПОВЕРХ него
  // (z-index 60 против 30 у restore) и технически доступна раньше решения по
  // восстановлению. Открытие именованного воркспейса = неявный отказ от
  // restore (тот же приём, что newProject() выше) — иначе стаггер этой
  // функции и ПОЗЖЕ принятое «Восстановить всё» доливают вкладки друг на
  // друга (дубли вкладок И дубли живых сессий Claude в тех же cwd).
  //
  // N1 (ре-ревью раунда 1): вызов стоит ПОСЛЕ отменяемого диалога — раньше
  // он был первой строкой функции, и Esc в диалоге оставлял пользователя с
  // уже похороненным списком восстановления.
  //
  // [Приведено в соответствие после I2, ревью финальной волны фазы 7]: до
  // фикса I2 инвариант «пока restoreOverlaySkip не null, tabStore пуст» здесь
  // был ошибочно назван невыполнимым — результат поиска по истории
  // (Ctrl+Shift+H, historySearch/onOpenResult) действительно открывал вкладку
  // мимо оверлея restore, ЭТО и было находкой I2, теперь исправленной там же.
  // После фикса каждый ИЗВЕСТНЫЙ путь, поднимающий вкладку (newProject,
  // openWorkspace здесь же, historySearch.onOpenResult), сам гасит
  // restoreOverlaySkip ДО открытия — так что к моменту, когда мы доходим
  // ДО ЭТОЙ строки, tabStore пуст, если только restore ещё не решён. Вызов
  // здесь остаётся НУЖНЫМ по ДРУГОЙ причине: «Открыть воркспейс: <name>» —
  // действие палитры, а палитра (z-index выше restore) доступна ЛЮБОМУ
  // пользователю в ЛЮБОЙ момент, в т.ч. пока restore ещё висит на экране И
  // tabStore ещё пуст (currentCount===0 → диалог подтверждения выше
  // пропускается вовсе) — restoreOverlaySkip() здесь гасит именно ЭТОТ,
  // палитровый путь, независимый от historySearch.
  if (restoreOverlaySkip) restoreOverlaySkip();

  workspaceOpenInFlight = true;
  try {
    await closeAllTabs();
    let firstOpened = null;
    for (let idx = 0; idx < tabs.length; idx++) {
      const t = tabs[idx];
      try {
        // Первая успешно поднятая вкладка становится видимой сразу — та же
        // причина, что в restoreFlow (иначе пользователь смотрит в пустой
        // терминал весь стаггер).
        const tab = await openTab(t.cwd, { activate: !firstOpened });
        if (tab && !firstOpened) firstOpened = tab;
      } catch (err) {
        // Одна неоткрывшаяся вкладка не должна обрывать открытие остальных —
        // та же логика, что finding 2a у restoreFlow.
        console.warn(`[workspace] не удалось открыть вкладку ${t.cwd}:`, err);
      }
      if (idx < tabs.length - 1) {
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  } finally {
    // Important 2: флаг обязан сброситься даже при непредвиденной ошибке
    // внутри цикла (per-tab ошибки уже гасятся выше, но подстраховка снаружи —
    // тот же приём, что restoreFlow/finally) — иначе одна ошибка навсегда
    // блокирует «Открыть воркспейс» до перезапуска кокпита.
    workspaceOpenInFlight = false;
  }
}

// Действие палитры «Удалить воркспейс: <name>» (Minor 6, ревью раунд 1): без
// него дубли/устаревшие записи в workspaces-library.json (например, от старой
// схемы именования до дедупа saveWorkspace по имени) можно было почистить
// только руками через файл.
//
// N3 (ре-ревью раунда 1): подтверждение обязательно. Живые сессии действие не
// трогает, но состав папок восстановить неоткуда, если этих вкладок сейчас нет
// на экране, а в палитре строка стоит СРАЗУ под безобидным близнецом «Открыть
// воркспейс: <name>» и матчится тем же фильтром — промах стрелкой плюс Enter
// стирал запись молча и безвозвратно.
async function deleteNamedWorkspace(ws) {
  const confirmed = await recipeForm.open({
    title: `Удалить воркспейс «${ws.name}» из библиотеки? Отменить это нельзя`,
    fields: [],
  });
  if (!confirmed) return;
  await window.api.recipes.deleteWorkspace(ws.id);
  await refreshWorkspacesCache();
}

// Task 4 фазы 4 (палитра команд): полный список действий, собирается заново
// при КАЖДОМ открытии палитры (palette.js зовёт getActions() внутри open()) —
// состав вкладок мог измениться с прошлого раза. Действия над «активной»
// вкладкой (restart/hooks/compact/remote-control) добавляются, только если
// активная вкладка вообще есть — иначе им нечего делать.
function buildPaletteActions() {
  // Minor 5 (ревью раунд 1): пользователь правит prompts.json руками —
  // единственный способ пополнить библиотеку рецептов в этой задаче.
  // Fire-and-forget — buildPaletteActions() обязана остаться СИНХРОННОЙ
  // (palette.js зовёт getActions() без await, см. palette.js/open()), так
  // что эта правка обновит recipesCache уже к СЛЕДУЮЩЕМУ открытию палитры,
  // без перезапуска кокпита.
  refreshRecipesCache();

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

  // Живая приёмка фазы 7: шпаргалка клавиш — доступна и из палитры, и
  // кнопкой ⌨ на панели действий (renderActionBar).
  actions.push({
    id: 'hotkeys',
    title: 'Горячие клавиши',
    hint: 'шпаргалка',
    run: () => toggleHotkeys(),
  });

  // Task 3 фазы 8 («Ночная смена»): заголовок зависит от ТЕКУЩЕГО состояния
  // кэша nightState (обновляется исключительно из ответа toggle()/
  // night:changed — см. applyNightState), не от локального предположения.
  actions.push({
    id: 'night',
    title: nightState?.armed ? 'Ночная смена: выключить' : 'Ночная смена: включить',
    hint: '🌙',
    run: () => toggleNight(),
  });

  // Task 4 фазы 7 (библиотека рецептов промптов): по одному действию на
  // рецепт из recipesCache (см. refreshRecipesCache — заполняется при boot()).
  // hint показывает имена плейсхолдеров, если они есть, — то же, зачем
  // мини-форма вообще понадобится при запуске (runRecipe).
  for (const r of recipesCache) {
    const placeholders = Array.isArray(r.placeholders) ? r.placeholders : [];
    actions.push({
      id: `recipe:${r.id}`,
      title: `Рецепт: ${r.title}`,
      hint: placeholders.length ? `{{${placeholders.join('}}, {{')}}}` : '',
      run: () => runRecipe(r),
    });
  }

  // «Сохранить воркспейс…» — не привязано к активной вкладке, доступно
  // всегда (берёт ВЕСЬ текущий состав вкладок, а не только активную).
  actions.push({
    id: 'save-workspace',
    title: 'Сохранить воркспейс…',
    hint: 'текущий состав вкладок',
    run: () => saveCurrentWorkspace(),
  });

  // По одному действию «Открыть воркспейс: <name>» на сохранённый профиль
  // (см. refreshWorkspacesCache).
  for (const w of workspacesCache) {
    const n = Array.isArray(w.tabs) ? w.tabs.length : 0;
    actions.push({
      id: `workspace:${w.id}`,
      title: `Открыть воркспейс: ${w.name}`,
      hint: `${n} ${pluralTabs(n)}`,
      run: () => openWorkspace(w),
    });
    // Minor 6 (ревью раунд 1): «Удалить воркспейс: <name>» — без него
    // накопленный мусор (дубли до дедупа saveWorkspace по имени, устаревшие
    // профили) можно было почистить только руками через файл.
    actions.push({
      id: `workspace-delete:${w.id}`,
      title: `Удалить воркспейс: ${w.name}`,
      hint: 'из библиотеки, не трогает открытые вкладки',
      run: () => deleteNamedWorkspace(w),
    });
  }

  const activeId = tabStore.activeId;
  if (activeId) {
    actions.push({
      id: 'restart-session',
      title: 'Перезапустить сессию',
      hint: 'Ctrl+Shift+R',
      // Та же функция, что у кнопки ⟳ и у Ctrl+Shift+R (см. restartSession):
      // управления и объяснение отказа обязаны быть одинаковыми у обеих
      // дверей — раньше палитра слала term:restart напрямую и молчала.
      run: () => restartSession(),
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
      // C1 (ревью финальной волны): гард статуса — см. writeCommandToTab.
      run: () => writeCommandToTab(activeId, '/compact'),
    });
    actions.push({
      id: 'send-remote-control',
      title: 'Отправить /remote-control',
      hint: '/remote-control',
      run: () => writeCommandToTab(activeId, '/remote-control'),
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

// I1 (ревью финальной волны фазы 7): единый реестр «что из оверлееподобного
// сейчас открыто» — раньше это было ПЯТЬ РАЗНЫХ инлайн-списков (гард Ctrl+G,
// гард Ctrl+Q, локальный otherOverlayOpen() внутри showRestoreOverlay, …),
// каждый со своим НЕПОЛНЫМ набором проверяемых сущностей: restore не знал
// про queueInputOpen, а Ctrl+Q — про открытый оверлей restore (сценарий
// ревью: непустой манифест на старте → оверлей restore → Ctrl+Q разворачивает
// #queue-input-row — он БЕЗ z-index, обычный элемент потока внутри #main, —
// ПОД restore (z-index 30), невидимо, и забирает фокус → Esc → capture-
// обработчик restore видит Escape ПЕРВЫМ (его otherOverlayOpen() не знал про
// открытую очередь) → startEmpty(): решение «начать пусто» принято ЗА
// пользователя, список проектов на восстановление потерян безвозвратно).
// Единственный источник правды — обход ЭТОГО объекта, а не N ручных копий
// одного и того же списка, которые легко развести при следующем изменении
// (что и произошло: #diff-panel по Ctrl+G — обычный flex-сосед внутри того
// же #main, что и restore, и без проверки restore имел бы ТОЧНО ТАКОЙ ЖЕ
// «открывается невидимо под оверлеем» баг, просто без явного отчёта о нём).
function overlayFlags() {
  return {
    dashboard: !!dashboard?.isOpen(),
    palette: !!palette?.isOpen(),
    peek: !!peek?.isOpen(),
    historySearch: !!historySearch?.isOpen(),
    recipeForm: !!recipeForm?.isOpen(),
    hotkeys: !!hotkeysOverlay?.isOpen(),
    queue: queueInputOpen,
    // restoreOverlaySkip не null ровно пока оверлей restore на экране и
    // решение по восстановлению ещё не принято (см. showRestoreOverlay).
    restore: !!restoreOverlaySkip,
    // План 2: заглушка эстафеты накрывает терминал, пока управление на другой
    // машине. Регистрируется здесь по тому же правилу, что и остальные
    // оверлеи (дыра I1): без этого вкладка под заглушкой считалась бы
    // прочитанной (seen.js) и Ctrl+Q открывал бы поле ввода под ней —
    // невидимо и без всякого смысла, писать всё равно нельзя.
    handoff: curtainState(handoffInputs()).visible,
    // План 3: файловый обзор — такой же модальный слой, как палитра. Без
    // регистрации Ctrl+Q развернул бы поле очереди невидимо под ним, а вкладка
    // под открытым обзором считалась бы прочитанной (seen.js).
    browse: !!browse?.isOpen(),
  };
}

// «Есть ли какой-то ДРУГОЙ модальный элемент открыт прямо сейчас» — excludes
// (необязательны) исключают из проверки элементы, которым закономерно можно
// быть открытыми: сам спрашивающий (закрытие/повторный тумблер — не помеха
// самому себе) и элементы, ГЕОМЕТРИЧЕСКИ не конфликтующие с действием
// (ре-ревью финальной волны: поле очереди и peek не перекрывают #diff-panel —
// блокировать Ctrl+G из-за них означало тихий no-op хоткея без причины).
function otherOverlayOpen(...excludes) {
  return Object.entries(overlayFlags()).some(([key, val]) => val && !excludes.includes(key));
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
      // C1 ревью (критично): палитра рисуется НАД заглушкой эстафеты (слой 60
      // против 31) и забирает фокус в своё поле ввода — живой прогон показал
      // activeElement:"palette-input" под заглушкой, то есть человек печатал
      // вслепую в список, где лежат удаление воркспейса и перезапуск вкладки.
      // Палитра — действия, а не чтение: невладельцу она не открывается вовсе.
      // Дашборд (Ctrl+D) и поиск истории (Ctrl+Shift+H) ниже — чтение, они
      // остаются доступными: заглушка их больше не перекрывает.
      if (!requireControl('Палитра команд')) return;
      peek?.hide();
      // Task 4 фазы 5: взаимное исключение оверлеев — дашборд не должен
      // остаться висеть «за спиной» открывшейся палитры.
      dashboard?.close();
      // Task 3 фазы 7: та же логика — оверлей поиска истории тоже не должен
      // остаться висеть «за спиной» открывшейся палитры.
      if (historySearch?.isOpen()) historySearch.close();
      // Task 4 фазы 7: та же логика — мини-форма рецепта/воркспейса тоже не
      // должна остаться висеть «за спиной».
      recipeForm?.close();
      // Живая приёмка фазы 7: шпаргалка клавиш — такой же слой 60.
      hotkeysOverlay?.close();
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
    // Ctrl+O — файловый обзор (план 3): выбор папки для новой сессии. Тот же
    // паттерн preventDefault/stopPropagation, что у Ctrl+P выше, иначе xterm
    // получил бы 'o'/'O' в активный терминал.
    //
    // Гарда управления здесь НЕТ намеренно: листать каталоги — чтение, оно
    // доступно и зрителю. Отказ выдаст кнопка «Открыть сессию здесь» внутри.
    // А вот открывать обзор поверх другого модального слоя нельзя — он ляжет
    // под ним (ровно тот класс дыры, что уже ловили с заглушкой эстафеты).
    //
    // I2 ревью: заглушка эстафеты тоже зарегистрирована в overlayFlags, и
    // из-за неё Ctrl+O у зрителя становился тихим no-op — при том что кнопка
    // «+ Проект» обзор открывала (он рисуется слоем 60, выше заглушки 31).
    // Две точки входа в один экран вели себя противоположно. Заглушку из
    // проверки исключаем: обзор поверх неё — ровно то, что задумано.
    if (ev.ctrlKey && !ev.shiftKey && !ev.altKey
        && (ev.key === 'o' || ev.key === 'O' || ev.code === 'KeyO')) {
      ev.preventDefault();
      ev.stopPropagation();
      if (browse?.isOpen()) browse.close();
      else if (!otherOverlayOpen('browse', 'handoff')) browse?.open(browseStartPath());
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
      // I1 (ревью финальной волны): otherOverlayOpen() — единый реестр (см.
      // определение выше), теперь включает и restore — #diff-panel лежит
      // ВНУТРИ #main, ровно там же, где restore-overlay (z-index 30,
      // position:absolute inset:0), и без этой строки Ctrl+G точно так же
      // разворачивал бы панель НЕВИДИМО под ним, как Ctrl+Q разворачивал
      // #queue-input-row (тот же класс дыры, просто без отдельного отчёта).
      // Исключения 'queue'/'peek' (ре-ревью волны): #queue-input-row — in-flow
      // сосед #main-row без z-index, peek — поповер 420px у строки сайдбара;
      // ни тот ни другой панель диффа не перекрывают, панель отлично видна —
      // блокировка давала бы тихий no-op хоткея при открытом поле очереди.
      // C1 ревью: заглушка эстафеты входит в этот же реестр и раньше гасила
      // Ctrl+G молча. Панель диффа живёт ВНУТРИ #main, то есть под заглушкой —
      // разворачивать её невидимо смысла нет, но и молчать нельзя.
      if (!requireControl('Панель диффа')) return;
      if (otherOverlayOpen('queue', 'peek')) return;
      toggleDiffPanel();
      return;
    }
    // Ctrl+Q — поле ввода очереди промптов (Task 1 фазы 7), тот же паттерн
    // preventDefault/stopPropagation/toggle, что Ctrl+P/Ctrl+D/Ctrl+G выше:
    // иначе xterm получил бы 'q'/'Q' в активный терминал. Гард — тот же
    // единый otherOverlayOpen(), что и у Ctrl+G выше (I1, ревью финальной
    // волны): не открывать поле НЕВИДИМО под другим оверлеем, который
    // перехватывает терминальную область целиком, — ВКЛЮЧАЯ restore (раньше
    // Ctrl+Q ничего не знал про открытый оверлей restore: непустой манифест
    // на старте → restore на экране → Ctrl+Q разворачивал #queue-input-row
    // ПОД ним, невидимо, забирая фокус — следующий Esc доставался capture-
    // обработчику restore, а не полю ввода, и «начать пусто» срабатывало за
    // спиной пользователя). exclude:'queue' — собственное состояние очереди
    // не должно мешать сама себе переключиться.
    if (ev.ctrlKey && !ev.shiftKey && !ev.altKey
        && (ev.key === 'q' || ev.key === 'Q' || ev.code === 'KeyQ')) {
      ev.preventDefault();
      ev.stopPropagation();
      // C1/I2 ревью: очередь промптов — пишущий канал (queue:add). Проверяем
      // ДО otherOverlayOpen: заглушка эстафеты и так входит в реестр оверлеев
      // и молча гасила бы хоткей, а молчание здесь и есть та самая «кокпит
      // сломался» — теперь человеку говорят, почему.
      if (!requireControl('Очередь промптов')) return;
      if (otherOverlayOpen('queue')) return;
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
          // I3 (ревью 01.08): «название» сессии из манифеста — вкладка
          // подписана сразу, не дожидаясь хуков/чтения транскрипта.
          sessionLabel: t.sessionLabel,
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
    restoreOverlayDismiss = null;
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
    restoreOverlayDismiss = null;
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
  // тому, кто ЕГО реально должен обработать.
  //
  // I1 (ревью финальной волны): локальная копия этого списка ЗАМЕНЕНА на
  // общий otherOverlayOpen(exclude) (см. определение выше по файлу, рядом с
  // bindHotkeys) — раньше у ЭТОЙ копии не было queueInputOpen в списке:
  // Ctrl+Q успевал развернуть #queue-input-row ПОД restore ДО того, как
  // Ctrl+Q сам научился отказывать (см. фикс гарда Ctrl+Q выше) — тогда
  // Escape долетал бы именно сюда первым (эта копия про очередь не знала) и
  // startEmpty() срабатывал бы за спиной пользователя. Теперь оба места
  // читают ОДИН и тот же реестр — пропустить будущий новый оверлей в одном
  // из них, забыв про другое, структурно невозможно.
  function onKey(ev) {
    if (otherOverlayOpen('restore')) return;
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
  // C1 ре-ревью: и второй крючок — «убрать оверлей, решения не принимая».
  // Зовётся, когда управление уходит к соседу (afterControlLost): решение по
  // восстановлению принимает тот, кто за рулём, а брошенная на экране кнопка
  // «Восстановить» подняла бы дубли вкладок поверх уже поднятых соседом.
  // workspace:ready отсюда НЕ зовём намеренно: восстановление не завершено, а
  // разблокировать запись манифеста в main имеет право только тот, кто принял
  // решение (её и разблокирует новый владелец своей веткой).
  restoreOverlayDismiss = () => {
    detach();
    restoreOverlaySkip = null;
    restoreOverlayDismiss = null;
    overlay.classList.add('hidden');
  };
}

// --- Эстафета управления (план 2 фазы «кокпит по сети») -------------------
// Управление в каждый момент у одного клиента: окна ПК или одного браузера.
// Решение «показывать ли заглушку» живёт в чистом handoff-view.js (он под
// тестами), здесь — только DOM и разговор с main.
let ownerState = { owner: null, self: 'local', online: true };
// Ключ памяти вкладки о своей роли (см. shouldClaimOnLoad): переподключение
// делает полную перезагрузку страницы, и без него вкладка-зритель отбирала бы
// управление у ПК на каждом обрыве связи.
const CLAIM_INTENT_KEY = 'cockpit.claimIntent';

// sessionStorage в Electron (file://) в принципе может бросить SecurityError —
// память о роли не настолько важна, чтобы ронять из-за неё загрузку.
function readClaimIntent() {
  try { return window.sessionStorage.getItem(CLAIM_INTENT_KEY); } catch { return null; }
}

function rememberClaimIntent(weOwn) {
  try { window.sessionStorage.setItem(CLAIM_INTENT_KEY, weOwn ? 'claim' : 'view'); } catch { /* переживём */ }
}

// C2 ре-ревью: была ли ЭТА загрузка автоматической (api-boot.js перезагрузил
// страницу сам, когда кокпит снова ответил). Метку сразу снимаем — она про
// одну конкретную загрузку, а не про вкладку.
//
// Уточнение (M3 второго ре-ревью): снятая метка НЕ означает, что следующая
// загрузка заберёт руль. У вкладки-зрителя остаётся второй тормоз — память о
// роли (intent в sessionStorage), и он сильнее: страница не отличает ручную F5
// от восстановления вкладок браузером после краша, а ошибиться в эту сторону
// дешевле (клик по кнопке на заглушке) , чем в обратную (у человека за ПК молча
// отбирают управление). Разбор — в handoff-view.js/shouldClaimOnLoad.
function takeAutoReloadMark() {
  try {
    const mark = window.sessionStorage.getItem(RELOAD_MARK_KEY);
    window.sessionStorage.removeItem(RELOAD_MARK_KEY);
    return mark === '1';
  } catch { return false; }
}

// Всё, что нужно чистым решателям handoff-view.js: владелец + наша личность +
// живой ли сокет до кокпита.
function handoffInputs() {
  return { ...ownerState, linked: linkState.online };
}

function hasControl() {
  return !controlBlock(handoffInputs());
}

// Владеем ли мы рулём ПО СУЩЕСТВУ, независимо от того, жив ли сейчас сокет.
// Ровно это запоминается для перезагрузки после обрыва: владелец, у которого
// пропала связь, обязан вернуть себе управление сам, а не превратиться в
// зрителя только потому, что в момент обрыва писать было некуда.
function ownsControl() {
  return !controlBlock({ ...ownerState, linked: true });
}

// I2 ревью: единственная точка, где действие невладельца превращается в
// понятный человеку отказ, а не в молчаливый unhandled rejection. Возвращает
// true, если действие можно выполнять.
function requireControl(action) {
  const block = controlBlock(handoffInputs());
  if (!block) return true;
  showToast(`${action}: ${block.message}`, 'warn');
  return false;
}

// Увести фокус из-под заглушки на единственное, что здесь можно нажать.
// Иначе он остаётся в textarea xterm ПОД ней: человек печатает вслепую в
// никуда (ввод отклонит гард главного процесса, но выглядит это как
// сломанная клавиатура), а кнопка «Забрать управление» фокус теряет — и
// Enter больше не возвращает руль.
//
// Вынесено из renderCurtain, потому что нужно в двух местах: при появлении
// заглушки и ПОСЛЕ закрытия оверлеев в afterControlLost — каждый из них
// (палитра, peek, мини-форма, поле очереди) на закрытии возвращает фокус в
// терминал, то есть отменяет парковку, сделанную мгновением раньше.
function parkFocusOnCurtain() {
  const take = $('curtain-take');
  document.activeElement?.blur?.();
  if (take && !take.disabled) take.focus();
}

// Размер берём у терминала активной вкладки: pty переразмеривается ровно под
// того, кто за рулём. Вкладок может не быть вовсе (пустой кокпит) — тогда
// захват всё равно обязан пройти, отсюда запасной размер.
function termSize() {
  const term = views.get(tabStore?.activeId)?.view?.term;
  return term ? { cols: term.cols, rows: term.rows } : { cols: 80, rows: 24 };
}

function renderCurtain() {
  const el = $('handoff-curtain');
  if (!el) return;
  const state = curtainState(handoffInputs());
  const wasVisible = el.classList.contains('visible');
  el.classList.toggle('visible', state.visible);
  el.querySelector('.curtain-title').textContent = state.title;
  el.querySelector('.curtain-hint').textContent = state.hint;
  // C1 ревью: кнопка «Забрать управление себе» при мёртвом сокете писала в
  // консоль и не меняла ничего — человек жал её бесконечно. disabled, а не
  // скрытие: пропадающая кнопка выглядит как ещё одна поломка.
  const take = $('curtain-take');
  if (take) take.disabled = !state.canTake;
  // Сайдбар намеренно НЕ накрыт заглушкой (статусы полезно видеть) — но его
  // действия невладельцу недоступны, и это должно быть видно ДО клика, а не
  // только тостом после (см. app.css/body.no-control).
  document.body.classList.toggle('no-control', !hasControl());
  rememberClaimIntent(ownsControl());
  if (state.visible === wasVisible) return;
  if (state.visible) {
    parkFocusOnCurtain();
  } else if (tabStore?.activeId) {
    // Minor ре-ревью: раньше снятие заглушки уводило фокус в терминал
    // БЕЗУСЛОВНО. Дашборд и поиск истории невладельцу разрешены намеренно
    // («чтение свободно»), и возврат управления выдёргивал бы фокус из их
    // полей прямо во время набора. Забираем фокус, только если он никому не
    // нужен: либо припаркован на body, либо стоит на самой заглушке (её мы
    // сфокусировали сами кнопкой «Забрать управление», и она сейчас уходит).
    const active = document.activeElement;
    const parked = !active || active === document.body || el.contains(active);
    if (parked) views.get(tabStore.activeId)?.view.focus();
  }
}

// Управление вернулось к нам. Пока его не было, term:start отклонялся гардом
// (пишущий канал) — и xterm остался с alive:false: ввод молча не доходил бы до
// pty, хотя заглушка уже убрана (живая проверка: браузер подключался зрителем,
// забирал управление и не мог печатать до F5). Просим main повторить
// 'term:started' — второго pty при этом не появляется (sessions.js/start), а
// мёртвые вкладки не трогаем вовсе: тот же гард shouldStartPty, что и при
// подключении (спавн без --resume потерял бы сессию).
async function resumeInputAfterClaim() {
  let live = [];
  try {
    live = await window.api.tabs.list();
  } catch (err) {
    console.warn('[эстафета] tabs:list после захвата не ответил:', err.message);
    return;
  }
  for (const t of Array.isArray(live) ? live : []) {
    const entry = views.get(t.tabId);
    if (!entry || !shouldStartPty(t)) continue;
    window.api.term.start(t.tabId, entry.view.term.cols, entry.view.term.rows);
  }
}

// Пересчитать геометрию всех терминалов и сообщить её pty. Живая жалоба 05.08:
// «при возврате на ПК размер ломается, приходится менять размер окна руками».
// Пока рулил макбук, pty стоял в ЕГО размере, и весь вывод Claude Code
// форматировался под него — включая тот, что приходил в окно ПК. При возврате
// сам собой этот перекос не чинится: ResizeObserver в terminal.js реагирует на
// изменение контейнера, а контейнер не менялся (окно то же). Ручной ресайз
// окна будил наблюдателя — отсюда и «приходится дёргать».
//
// Только активная вкладка: у скрытых контейнер нулевой (.term-view.hidden —
// display:none), подгонка по нему посчитала бы мусор, а их собственный
// ResizeObserver всё равно сработает при переключении — контейнер перейдёт из
// нуля в реальный размер. У pty размер общий, так что достаточно одного.
function refitActiveTerminal() {
  const entry = views.get(tabStore?.activeId);
  if (!entry) return;
  try {
    entry.view.refit();
  } catch (err) {
    console.warn('[эстафета] пересчёт размера терминала не удался:', err && err.message);
  }
}

// Управление пришло к нам — и разблокировкой ввода дело не ограничивается.
// C1 ре-ревью: если при загрузке мы были зрителем без единой живой вкладки,
// подъём воркспейса ждал именно этого момента (см. bootWorkspace) — иначе
// человек, забравший управление, оставался с пустым сайдбаром.
//
// Зовётся ДВУМЯ путями сразу, и это намеренно: своим захватом (claimControl) и
// событием owner:changed — второе приходит и когда руль вернулся без нашего
// участия (показ окна ПК из трея, уход соседа). Ре-ревью замерило, что на
// явном захвате срабатывают оба: main рассылает owner:changed синхронно внутри
// обработчика owner:claim, то есть broadcast обгоняет ответ на invoke, и в
// сокет уходили три tabs:list вместо одного. Вреда сегодня нет (bootWorkspace
// гасит флаг первой строкой), но «случится ровно один раз» держалось на
// порядке ответов, а не на коде. Держим оба пути — они разной природы — и
// делаем сам проход одноразовым: повторный вызов дожидается уже идущего.
let controlGainedRun = null;
async function afterControlGained() {
  if (controlGainedRun) return controlGainedRun;
  controlGainedRun = (async () => {
    // Первым делом — геометрия: пока рулил сосед, pty стоял в ЕГО размере, и
    // вывод в наших терминалах разъехался. Именно этот перекос пользователь
    // лечил ручным ресайзом окна.
    refitActiveTerminal();
    await resumeInputAfterClaim();
    if (!workspaceBootPending) return;
    try {
      await bootWorkspace();
    } catch (err) {
      console.warn('[boot] подъём воркспейса после получения управления не удался:', err);
    }
  })();
  try {
    await controlGainedRun;
  } finally {
    controlGainedRun = null;
  }
  return undefined;
}

// Управление ушло к соседу, пока мы решали вопрос восстановления. Оверлей
// restore обязан уйти вместе с рулём: решение принимает тот, кто за рулём, а
// оставленная кнопка «Восстановить» подняла бы ВТОРЫЕ вкладки на те же
// sessionId уже после того, как их поднял новый владелец (второй
// `claude --resume <тот же id>` в один транскрипт). Решение не потеряно —
// доиграем его, когда руль вернётся.
function afterControlLost() {
  // Руль забрал сосед — закрываем всё, что предлагает действия, которых у нас
  // больше нет. Раньше уходил только оверлей восстановления, а палитра, peek и
  // мини-форма рецепта переживали смену владельца (ревью 09.08, B4): палитра
  // лежит ВЫШЕ заглушки по z-index, сайдбар ею не накрыт намеренно — то есть
  // человек продолжал видеть кликабельные кнопки. Дальше «Перезапустить
  // сессию» отклонялась молча, «Удалить воркспейс» уходила в unhandled
  // rejection, ответ из peek пропадал впустую.
  //
  // Все close/hide идемпотентны — вызывать их безусловно безопасно.
  palette?.close();
  peek?.hide();
  peekedTabId = null;
  recipeForm?.close();
  closeQueueInput();
  // ОБЯЗАТЕЛЬНО после закрытия: каждый из этих оверлеев на закрытии возвращает
  // фокус в терминал, то есть отменяет парковку, которую renderCurtain сделал
  // мгновением раньше (owner:changed зовёт его первым). Без этой строки фикс
  // B4 сам создавал бы ту же беду, от которой парковка защищает: фокус в
  // textarea xterm ПОД заглушкой и кнопка «Забрать управление» без фокуса.
  parkFocusOnCurtain();

  if (!restoreOverlayDismiss) return;
  restoreOverlayDismiss();
  workspaceBootPending = true;
}

// Захват уезжает с размером НАШЕГО терминала, и main подгоняет под него все
// живые pty (applyHandoffSize). Если активной вкладки нет, termSize() отдаёт
// запасные 80×24 — и они применились бы ко ВСЕМ сессиям: широкое окно, а
// Claude Code перерисован в 80 колонок. А активной вкладки закономерно НЕ
// бывает у того, кому вкладки приехали синхронизацией (их завёл сосед —
// syncTabsFromMain подключает без активации, чтобы не дёргать человека).
//
// Поэтому перед захватом показываем вкладку: размер становится настоящим, и
// человек, забравший управление, видит терминал, а не пустой экран.
function ensureActiveTabForHandoff() {
  if (views.has(tabStore?.activeId)) return;
  const first = [...views.keys()][0];
  if (!first) return; // вкладок нет вовсе — запасной размер безвреден, ресайзить нечего
  activateTab(first);
  // refit синхронно: activateTab только показывает контейнер, а term.cols до
  // пересчёта остаётся прежним — в claim уехал бы размер скрытого терминала.
  try {
    views.get(first)?.view.refit();
  } catch (err) {
    console.warn('[эстафета] пересчёт размера показанной вкладки не удался:', err && err.message);
  }
}

async function claimControl() {
  ensureActiveTabForHandoff();
  const { cols, rows } = termSize();
  const hadControl = hasControl();
  try {
    const state = await window.api.owner.claim(cols, rows);
    // null приходит, когда main отклонил вызов гардом (такого для owner:claim
    // быть не должно — канал свободный), а undefined — если ответа нет вовсе.
    if (state) ownerState = { ...ownerState, ...state };
  } catch (err) {
    // Обрыв связи посреди захвата — не повод ронять интерфейс: следующее
    // owner:changed или переподключение всё поправят.
    console.warn('[эстафета] захват не удался:', err.message);
  }
  renderCurtain();
  if (!hadControl && hasControl()) await afterControlGained();
}

// M1 ревью: net:hello уходил в пустой список подписчиков (сервер шлёт его в
// момент подключения, а подписка ставилась в конце boot()) — личность клиента
// не доезжала вовсе, и держалось всё на том, что ответ на захват сам несёт
// self. Если захват не проходил (нет связи), клиент навсегда оставался
// 'local', а спросить было некого: owner:get renderer не звал ни разу.
// Спрашиваем прямо — это же закрывает M2 (владелец известен ДО того, как
// что-либо начнёт писать).
async function refreshOwner() {
  try {
    const state = await window.api.owner.get();
    if (state) ownerState = { ...ownerState, ...state };
  } catch (err) {
    console.warn('[эстафета] owner:get не ответил:', err.message);
  }
  renderCurtain();
}

// I3 ревью: обрыв связи не был показан ничем. Заглушка (curtainState видит
// linked:false) + один тост; переподключение с нарастающим интервалом и
// перезагрузка страницы после него живут в api-boot.js.
function bindLinkState() {
  onLinkChange((state) => {
    renderCurtain();
    if (!state.online && state.attempt === 0) {
      showToast('Связь с кокпитом потеряна — переподключаюсь', 'error');
    }
  });
}

// Чем занять окно: подключиться к живым вкладкам либо решить вопрос
// восстановления вчерашнего состава. Вынесено из boot() отдельной функцией
// (C1 ре-ревью), потому что играется НЕ ТОЛЬКО при загрузке: зритель без
// живых вкладок откладывает эту работу до момента, когда получит управление.
async function bootWorkspace() {
  workspaceBootPending = false;

  // C1 финального ревью ветки: ПЕРВЫМ делом спрашиваем, есть ли ЖИВЫЕ вкладки
  // в менеджере, и только потом смотрим на манифест. Манифест — это «что было
  // вчера», и восстанавливать его имеет смысл ровно тогда, когда сегодня ещё
  // ничего не работает. Если сессии уже подняты (браузер с макбука, второе
  // окно, перезагрузка renderer при живом main), любой tabs:open из оверлея
  // восстановления завёл бы ВТОРУЮ вкладку с новым tabId на ту же сессию
  // Claude — а следом второй `claude --resume <тот же id>` в тот же
  // транскрипт. Подключаемся к тому, что есть.
  //
  // tabs:list не ответил (старый main, отказ канала) — деградируем в прежнее
  // поведение: лучше показать оверлей, чем не показать ничего.
  let liveTabs = [];
  try {
    liveTabs = await window.api.tabs.list();
  } catch (err) {
    console.warn('[boot] tabs:list не ответил — иду по ветке восстановления:', err);
  }

  // Оверлея восстановления в этой ветке нет НАМЕРЕННО: восстанавливать нечего,
  // всё уже работает. Он остаётся ровно для случая, когда живых вкладок ноль.
  // Это же — единственный путь, которым вкладки достаются зрителю: чтение
  // (tabs:list, net:buffer) свободно, разрешения соседа для него не нужно.
  if (Array.isArray(liveTabs) && liveTabs.length) {
    try {
      await attachLiveTabs(liveTabs);
    } finally {
      // Та же страховка, что в ветке пустого манифеста ниже: sync манифеста
      // разблокируем в любом случае, иначе состав вкладок перестанет
      // сохраняться до конца сессии (см. workspace-sync.js/markReady).
      window.api.workspace.ready();
    }
    return;
  }

  // C1 ре-ревью. Живых вкладок нет — дальше речь о том, поднимать ли вчерашние,
  // а это ПИШУЩЕЕ решение (tabs:open), и принимает его тот, кто за рулём.
  // Раньше зрителю показывали оверлей восстановления «под заглушкой», но
  // решает-то другой клиент, и погасить этот оверлей было нечем: события
  // «вкладку открыли/закрыли» в форме api нет вовсе. Живая цепочка ревьюера:
  // зритель загрузился → владелец нажал «Начать пусто» → у зрителя оверлей жив
  // → зритель забрал управление → заглушка ушла, а кнопка «Восстановить»
  // осталась кликабельной над пустым сайдбаром; клик по ней при выборе
  // владельца «Восстановить» завёл бы ВТОРЫЕ вкладки на те же sessionId.
  //
  // Поэтому: зрителю оверлея нет вовсе, а работа откладывается до получения
  // управления (afterControlGained). Тогда мы пройдём здесь заново — и живые
  // вкладки, если сосед их успел поднять, заберём ровно тем же tabs:list →
  // attach, что и любой обычный клиент.
  //
  // workspace:ready в этой ветке НЕ зовём намеренно: гейт манифеста в main
  // общий (workspace-sync.js), и разблокировать запись имеет право только тот,
  // кто принял решение по восстановлению, — иначе стаггер восстановления у
  // соседа писал бы на диск неполный состав вкладок на каждом шаге.
  if (!hasControl()) {
    workspaceBootPending = true;
    return;
  }

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
    return;
  }
  try {
    showRestoreOverlay(manifest);
  } catch (err) {
    // FIX 2 (carryover 3): showRestoreOverlay сама НЕ зовёт ready() —
    // это делают её колбэки startEmpty/startRestore по решению пользователя
    // (см. ниже). Если она упадёт ДО того, как повесит эти обработчики
    // (например, DOM оверлея не найден), ready() больше НИКОГДА не придёт —
    // тот же эффект заморозки манифеста. Деградируем: считаем, что
    // восстанавливать нечего (как при отсутствии манифеста).
    console.warn('[restore] оверлей восстановления не показался:', err);
    // Fix 11 (ревью): showRestoreOverlay могла успеть показать оверлей
    // (overlay.classList.remove('hidden')) и упасть уже ПОСЛЕ этого,
    // внутри своего локального замыкания — без явного скрытия здесь
    // модалка залипала бы навсегда поверх главной области.
    $('restore-overlay')?.classList.add('hidden');
    window.api.workspace.ready();
  }
}

async function boot() {
  // Память вкладки о своей роли читается ДО первого renderCurtain(): тот же
  // ключ он и перезаписывает (см. rememberClaimIntent).
  const claimIntent = readClaimIntent();
  // C2 ре-ревью: и метка «эту загрузку затеял не человек» — тоже до первого
  // возможного reload'а (снимается чтением, см. takeAutoReloadMark).
  const autoReloaded = takeAutoReloadMark();

  // --- Эстафета: подписки, личность и владелец — САМЫМ ПЕРВЫМ делом ---------
  //
  // M1 ревью: подписки стояли в конце boot(), а сервер шлёт net:hello в момент
  // подключения — событие уходило в пустой список подписчиков (зонд поймал
  // потерю на 87 мс). Здесь они регистрируются ДО первого await, то есть в том
  // же синхронном куске, что и тело модуля: ни один кадр сокета обработаться
  // раньше не успеет.
  //
  // M2 ревью: до этого владелец становился известен только на ПОСЛЕДНЕЙ строке
  // boot(), после восстановления вкладок, — всё это время заглушки не было по
  // построению, интерфейс выглядел живым, а term.write в браузере пропадал
  // молча. Теперь владелец известен раньше, чем что-либо успевает написать.
  window.api.owner.onHello((p) => {
    ownerState = { ...ownerState, self: selfId(p || {}) };
    renderCurtain();
  });
  window.api.owner.onChanged((p) => {
    const hadControl = hasControl();
    ownerState = { ...ownerState, ...p };
    renderCurtain();
    // Управление вернулось не нашим захватом, а извне (показ окна ПК из трея,
    // уход соседа) — ввод в терминалах всё равно надо разблокировать.
    if (!hadControl && hasControl()) afterControlGained();
    // И обратная сторона (C1 ре-ревью): руль забрал сосед — незакрытый оверлей
    // восстановления у нас больше не наш вопрос.
    else if (hadControl && !hasControl()) afterControlLost();
  });
  $('curtain-take')?.addEventListener('click', () => { claimControl(); });
  bindLinkState();
  await refreshOwner();

  // Захват при загрузке — НЕ безусловный (Critical соседнего ревью): окно ПК
  // при автозапуске отбирало управление у макбука обратно и вылезало на экран.
  // C2 ре-ревью: и браузерная вкладка при АВТОМАТИЧЕСКОЙ перезагрузке после
  // обрыва тоже не забирает руль у живого соседа. Решение — в чистом
  // shouldClaimOnLoad (handoff-view.js); ownerState несёт owner/self/online.
  if (shouldClaimOnLoad({
    ...ownerState, intent: claimIntent, reloaded: autoReloaded,
  })) await claimControl();

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

  // План 3: файловый обзор вместо системного диалога выбора папки. Экран один
  // и тот же в окне на ПК и в браузере — разница только в кнопке «Системное
  // окно», которой в браузере нет (показать её негде, а канал tabs:chooseFolder
  // открыл бы модалку на машине владельца, спрятанной в трей).
  browse = createBrowse({
    onOpenHere: (cwd) => {
      // Заведение вкладки — пишущее действие: у невладельца оно отклонится
      // гардом эстафеты, поэтому спрашиваем заранее и говорим словами, а не
      // роняем в молчаливый unhandled rejection.
      if (!requireControl('Открыть сессию здесь')) return;
      // Тот же крючок, что у «+ Проект» до этой правки: открытие вкладки —
      // неявный отказ от восстановления воркспейса, если оно ещё не решено.
      if (restoreOverlaySkip) restoreOverlaySkip();
      openTab(cwd);
    },
    // Прежний путь целиком, без копии его логики: гард управления, диалог,
    // крючок restore и открытие вкладки — всё уже написано и отревьюжено.
    onSystemDialog: () => newProjectViaSystemDialog(),
    // window.__cockpitNetClient ставит сетевой мост (api-boot.js) — он
    // выполняется только в браузере, в Electron его ветка не работает вовсе.
    isElectron: !window.__cockpitNetClient,
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
    // Task 3 фазы 8 («Ночная смена»), Important 2 ревью раунда 1: резолвер
    // tabId→имя для журнала секции — tabStore.peekInfo(tabId) уже отдаёт null
    // для закрытой/неизвестной вкладки, night-format.js сам фолбэкается на
    // сырой tabId в этом случае (см. resolveName там же).
    resolveTabName: (tabId) => tabStore.peekInfo(tabId)?.name || null,
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
  //
  // I2 (ревью финальной волны фазы 7): restoreOverlaySkip() — ТОТ ЖЕ приём,
  // что уже есть в newProject() и openWorkspace(), раньше пропущенный именно
  // здесь. Сценарий А: старт с манифестом на 5 проектов → Ctrl+Shift+H →
  // Enter на результате → вкладка открыта ЗА оверлеем restore (палитра/поиск
  // рисуются ПОВЕРХ restore по z-index, см. Important 1 в openWorkspace() —
  // но решение по restore ЕЩЁ не принято) → Esc на оверлее → startEmpty() →
  // readyAndSync видит уже НЕПУСТОЙ tabStore (условие «пусто» не
  // выполняется) → манифест перезаписан ОДНОЙ вкладкой, вчерашний состав
  // потерян безвозвратно. Сценарий Б: вместо Esc — «Восстановить всё» →
  // дубли вкладок И дубли живых сессий Claude. Открытие результата поиска =
  // неявный отказ от restore, тот же принцип, что и у остальных действий,
  // способных поднять вкладку мимо оверлея.
  historySearch = createSearch({
    root: $('search-root'),
    api: window.api,
    //
    // I2 ре-ревью: сам поиск невладельцу открыт намеренно (чтение свободно), а
    // вот открытие вкладки — запись: tabs:open у него отклонит гард. Раньше
    // оверлей просто закрывался и не происходило НИЧЕГО, кроме unhandled
    // rejection в консоли. Отказ обязан быть видимым — та же requireControl,
    // что и у остальных пишущих действий; и reject openTab ловим здесь, потому
    // что синхронный try/catch в search.js/openAt его не видит.
    onOpenResult: (cwd, sessionId) => {
      if (!requireControl('Открыть найденную сессию')) return null;
      if (restoreOverlaySkip) restoreOverlaySkip();
      return openTab(cwd, { sessionId }).catch((err) => {
        console.warn('[search] не удалось открыть найденную сессию:', err);
        showToast(`Открыть найденную сессию не удалось: ${err.message}`, 'error');
        return null;
      });
    },
  });

  // Task 4 фазы 7 (рецепты промптов + именованные воркспейсы): мини-форма
  // ввода — единственный владелец своего DOM (см. recipe-form.js). Кэши
  // рецептов/воркспейсов — НЕ await, тот же приём, что usage.get() ниже: не
  // задерживаем остальной boot() ради пары дешёвых чтений с диска; палитра
  // просто увидит пустой список до разрешения промиса (getActions() зовётся
  // заново при каждом открытии, см. palette.js).
  recipeForm = createRecipeForm({ root: $('recipe-form-root') });
  hotkeysOverlay = createHotkeysOverlay({ host: $('hotkeys-root') });
  refreshRecipesCache();
  refreshWorkspacesCache();

  renderActionBar();

  // Task 3 фазы 9 (голосовой ввод): recorder — один инстанс на всё время
  // жизни окна (start()/stop() сами открывают/закрывают AudioContext на
  // каждую запись, см. voice/recorder.js). initVoiceIndicator() создаёт
  // бейдж программно в #action-right — ПОСЛЕ renderActionBar() (та стирает
  // #action-commands, но не #action-right, порядок здесь не критичен, только
  // для читаемости — оба относятся к панели действий).
  voiceRecorder = new VoiceRecorder();
  initVoiceIndicator();
  // Снимок status().available — см. bindVoiceHotkey/resolveStartBlock
  // (voice-guards.js). Fire-and-forget (refreshSttStatus, тот же приём, что
  // usage.get()/night.get() ниже) — не задерживаем boot() ради похода в
  // main; keydown-гард просто использует то, что есть на момент первого
  // нажатия (IPC-круг — миллисекунды, Shift физически не нажать раньше).
  refreshSttStatus();

  // Task 3 фазы 5 (кольца лимитов): первичный usage:get — НЕ await, чтобы
  // первый (потенциально небыстрый — ленивый ccusage.get() дёргает npx на
  // первом вызове, до 60с таймаута) запрос не задерживал остальной boot()
  // (восстановление воркспейса, открытие вкладок). Кольца просто показывают
  // прочерки (ok:false — snapshot ещё не пришёл), пока промис не разрешится.
  window.api.usage.get().then((payload) => {
    lastUsage = payload;
    redrawUsageViews();
  }).catch((err) => console.warn('[usage] usage:get не удался:', err));

  // Task 3 фазы 8 («Ночная смена»): первичный снимок armed/pending/журнала —
  // тот же fire-and-forget приём, что usage.get() выше — кнопка 🌙/палитра
  // просто остаются в дефолтном «выключено» виде, пока промис не разрешится.
  // onChanged — push на КАЖДОЕ последующее изменение (арминг, детект,
  // пробуждение, дизарм — main/night-watch.js зовёт emit() после любого из
  // них) — единственный источник истины после первого снимка.
  window.api.night.get().then(applyNightState)
    .catch((err) => console.warn('[night] night:get не удался:', err));
  window.api.night.onChanged(applyNightState);

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
  // pendingOutput (C2 финального ревью) — вкладка, к которой мы ТОЛЬКО ЧТО
  // подключились, ещё ждёт свою историю из net:buffer. Живой вывод, пришедший
  // в это окно, копим и печатаем ПОСЛЕ истории (см. replayHistory), иначе
  // хвост буфера лёг бы поверх более свежих строк.
  window.api.term.onData(({ tabId, data }) => {
    const entry = views.get(tabId);
    if (!entry) return;
    if (entry.pendingOutput) { entry.pendingOutput.push(data); return; }
    entry.view.handlers.onData(data);
  });
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

  // Состав вкладок изменился — у нас, у соседа или автоматикой. Живая жалоба
  // 08.08: сессия, заведённая с макбука, на ПК не появлялась вовсе, хотя main
  // рассылал это событие всем клиентам с начала фазы — подписки не было.
  window.api.tabs.onChanged(() => { syncTabsFromMain(); });

  // Статусы приходят из хуков Claude Code (sessions.js) — единый источник,
  // term:started/term:exit статус больше не выставляют (был двойной источник).
  window.api.tab.onStatus(({
    tabId, status, subtitle, waitingText, waitingKind, sessionLabel, labelOnly,
  }) => {
    // C2 (Critical, ревью финальной волны фазы 9): waitingKind зеркалится в
    // tabStore ровно тем же приёмом, что waitingText — см. tabs.js/setStatus,
    // app.js/isTabBlockedByDialog (голосовой ввод/writeCommandToTab).
    // sessionLabel (живая приёмка 01.08) — та же схема зеркалирования.
    tabStore.setStatus(tabId, status, subtitle, waitingText, waitingKind, sessionLabel);
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
    // I2 (ре-ревью 01.08): labelOnly-событие статус НЕ меняло (дочитался
    // заголовок сессии) — лишняя сериализация полумегабайтного буфера на
    // диск здесь ни к чему.
    if (!labelOnly && (status === 'done' || status === 'waiting')) saveGhost(tabId);
    // «Готово» — список НЕПРОЧИТАННОГО (живая приёмка 01.08). Если ответ
    // пришёл, пока пользователь смотрел именно на эту вкладку, он его уже
    // видит — в список непрочитанного ей попадать незачем.
    if (status === 'done') markSeenIfWatching(tabId);
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
  bindVoiceHotkey();

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

  await bootWorkspace();

  // Находка 4б (ревью фазы 6): раньше это был единственный потребитель
  // app:notice — и он ТОЛЬКО логировал в консоль, ни один визуальный сигнал
  // пользователю не показывался. showToast (см. выше) — простой тост.
  window.api.app.onNotice(({ text, level }) => {
    console.warn(`[notice] ${text}`);
    showToast(text, level);
  });

  // Захват в начале boot() ушёл с запасными 80×24 — терминалов тогда ещё не
  // было. Повторный owner:claim ТЕМ ЖЕ владельцем не меняет владельца и не
  // трогает pty (ownership.js: who === owner → без onChange), он только
  // запоминает НАСТОЯЩИЙ размер этого клиента — чтобы возврат управления сюда
  // позже переразмерил pty правильно, а не в запасную раскладку.
  if (hasControl()) await claimControl();
}

// Необработанный reject/throw внутри boot() раньше гас молча — приложение
// оставалось полумёртвым (окно есть, но без вкладок/хоткеев) без единой
// строки в консоли. Ловим явно.
boot().catch((err) => console.error('[boot] не удалось инициализировать renderer:', err));
