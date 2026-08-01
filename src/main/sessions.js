'use strict';
// Менеджер сессий: tabId → pty + машина статусов (спека §5.2).
// Чистый Node-модуль без Electron: фабрика pty, конфиг, клок и env инжектятся.
// Статусы приходят ТОЛЬКО из хуков Claude Code и жизненного цикла pty —
// вывод терминала не парсится никогда (хрупко, ломается о каждый релиз CLI).

const path = require('path');
const crypto = require('crypto');
// M2 (ревью финальной волны фазы 7): normalizeForPty — та же чистая функция,
// которой уже прогоняется путь рецептов (app.js/runRecipe → IPC
// recipes:normalizeForPty → эта же функция) — recipes.js остаётся ЧИСТЫМ
// модулем (никакого fs/electron на верхнем уровне, только инжектируемые
// зависимости внутри createRecipeStore), так что требовать его отсюда
// безопасно и не ломает "чистоту" sessions.js. Два пути записи текста в pty
// (рецепт и очередь) должны быть захардены ОДИНАКОВО — см. enqueue() ниже.
const { normalizeForPty } = require('./recipes');

// 'ready' («Наготове», живая приёмка 01.08) — сессия поднята и стоит у
// промпта: никто ничего не поручал, ждать нечего, смотреть не на что. До этого
// такие вкладки жили в «Работают», и счётчик «Работают · 10» после утреннего
// восстановления выглядел так, будто десять сессий жгут лимит.
const STATUSES = ['working', 'waiting', 'done', 'stuck', 'dead', 'ready'];

// Мягкая деградация провала резюма (спека §6): процесс с оверрайдом (--resume
// <id>/--resume), проживший меньше этого порога и умерший, не привязав
// сессию, считается «фантомным» провалом (сессия протухла/транскрипт так и
// не создался) — кокпит авто-восстанавливает вкладку. Дольше — считаем, что
// процесс был живым и умер сам по себе; авто-восстановление не триггерим.
const AUTO_RECOVER_MAX_LIFETIME_MS = 15000;

// C1 (Critical, ревью финальной волны фазы 8): Claude Code шлёт хук
// Notification НЕ только на permission_prompt («нужно разрешение на
// инструмент»), но и на idle_prompt («жду вашего ввода» — раз в ~60с, пока
// терминал не в фокусе; режим 1004 у нас реально включён, см. terminal.js/
// hasRealUserInput выше по фазе). connector.js регистрирует Notification БЕЗ
// matcher'а (EVENTS без разбивки на подтипы) — оба вида хука приходят как
// ОДНО и то же событие, различать приходится по содержимому message.
//
// Без этой классификации ночная смена ломается НАВСЕГДА в основном сценарии:
// 23:00 лимит → детект; 23:01 idle_prompt (терминал не в фокусе всю ночь) →
// статус 'waiting'; 03:01 пробуждение → NO_RESUME_STATUSES считает ЛЮБОЙ
// 'waiting' непродолжаемым → «пропущена: ждёт ответа на диалог» — хотя ждать
// там было нечего, кроме собственного idle-пинга CLI.
//
// НЕИЗВЕСТНЫЙ текст (кастомный prompt инструмента, будущая версия CLI,
// локализация) → консервативно 'permission': пропуск резюма безопаснее
// случайного Enter в диалог подтверждения (той же осторожности требует и
// брифом заказанная трактовка usage-error/no-usage-data в night-watch.js).
//
// N2 (ре-ревью финальной волны): payload хука несёт ТОЧНОЕ поле
// notification_type ('idle_prompt'/'permission_prompt' — сверено с бинарём
// CLI 2.1.220), cockpit-hook.js прокидывает stdin-JSON целиком. Оно —
// первый сигнал; подстрока message — фолбэк для старых/изменённых версий,
// где поля нет. Смена английского текста при живом поле больше не уводит
// фичу обратно в C1.
// Живая приёмка (01.08, отзыв пользователя): «в одной папке бывает несколько
// сессий, нечем их различить» — вкладке нужна своя строка-«название».
//
// ИСТОЧНИКОВ ТРИ, в порядке приоритета:
//   1) Имя, заданное пользователем командой `/rename` (запись custom-title
//      ближе к концу транскрипта).
//   2) Автозаголовок Claude Code (запись ai-title в начале транскрипта).
//      Оба читаются из ФАЙЛА, а не из payload хука, и оба приходят
//      АСИНХРОННО, поэтому применяются отдельным путём — см.
//      requestSessionTitle ниже. Почему не поле session_title из хука,
//      почему читаются и начало и конец файла и почему не читается файл
//      целиком — в шапке session-title.js.
//   3) Фолбэк «первый промпт» — мгновенная метка для сессии, у которой
//      заголовка ещё нет (CLI генерирует его после первого обмена);
//      применяется в applyPromptFallback ниже.
// Настоящий заголовок ВСЕГДА перебивает фолбэк; пустое значение никогда не
// затирает уже показанную метку.
const SESSION_LABEL_MAX = 48;

function truncateForLabel(text) {
  // \s+ → пробел: многострочная вставка/диктовка не должна ломать одну
  // строку сайдбара. Это ЧИСТО косметическое усечение — не путать с
  // normalizeForPty (импорт выше), которая готовит текст к ОТПРАВКЕ в pty.
  // M2 ревью: срезаем заведомо лишний хвост ДО regex — промпт бывает и на
  // 100 КБ (вставка файла), гонять по нему схлопывание пробелов незачем.
  const head = String(text == null ? '' : text).slice(0, SESSION_LABEL_MAX * 4);
  const squashed = head.replace(/\s+/g, ' ').trim();
  if (!squashed) return '';
  return squashed.length > SESSION_LABEL_MAX
    ? `${squashed.slice(0, SESSION_LABEL_MAX - 1)}…`
    : squashed;
}

// Сброс ИДЕНТИЧНОСТИ метки: «показанное имя больше не наше». Три вызывающих,
// по одному на каждый способ сменить сессию внутри живущей вкладки (D1
// ре-ревью раунда 2 — третий путь был пропущен и воспроизводил исходный
// симптом):
//   1) bindSession — пришёл ДРУГОЙ session_id (`/clear` в том же pty);
//   2) restart без известного sessionId — голый `--resume`, пикер приведёт
//      любую сессию;
//   3) onExit/failedOverride — резюм провалился, сейчас поднимется чистая
//      новая сессия (здесь sessionId вот-вот станет null, и гарда (1) уже
//      не сможет сработать).
// labelGen++ ЗАОДНО обесценивает висящее чтение старого транскрипта: гарда
// по tab.gen для этого не годится — pty во всех трёх случаях может не
// меняться вовсе.
function resetLabelIdentity(tab) {
  tab.sessionLabel = '';
  tab.sessionLabelFromTitle = false;
  tab.titleReadInFlight = false;
  tab.labelGen += 1;
}

// Фолбэк-метка из текста промпта. Ставится ТОЛЬКО если метки ещё нет вовсе
// и настоящий заголовок ещё не приходил (иначе он был бы затёрт сегодняшней
// репликой). Возвращает true, если метка изменилась.
function applyPromptFallback(tab, data) {
  if (tab.sessionLabelFromTitle || tab.sessionLabel) return false;
  const fromPrompt = truncateForLabel(data && data.prompt);
  if (!fromPrompt) return false;
  tab.sessionLabel = fromPrompt;
  return true;
}

function classifyNotification(message, notificationType) {
  if (notificationType === 'idle_prompt') return 'idle';
  if (notificationType === 'permission_prompt') return 'permission';
  const text = String(message || '').toLowerCase();
  if (text.includes('waiting for your input')) return 'idle';
  return 'permission';
}

// Выпиливает унаследованные маркеры родительского Claude Code из process.env
// (Task 6). Если кокпит запущен из-под ДРУГОГО Claude Code (например, так
// делают тестовые прогоны), переменные вроде CLAUDE_CODE_CHILD_SESSION /
// CLAUDECODE / CLAUDE_CODE_* наследуются вниз по процессу — claude во
// вкладке считает себя дочерней сессией: рисует урезанный монохромный UI,
// не пишет транскрипт и наследует bypass-permissions родителя. Копируем
// process.env и убираем всё, что начинается на CLAUDE_CODE (регистронезависимо),
// плюс отдельно CLAUDECODE — ДО того как добавить свои COCKPIT_*.
function sanitizedProcessEnv() {
  const clean = { ...process.env };
  for (const key of Object.keys(clean)) {
    const upper = key.toUpperCase();
    if (upper.startsWith('CLAUDE_CODE') || upper === 'CLAUDECODE') {
      delete clean[key];
    }
  }
  return clean;
}

// ptyFactory(opts) → {write, resize, kill, pid} — в проде createPty из pty.js.
// getTermConfig() → config.terminal; onEvent(channel, payload) → webContents.send.
// now() — клок (тестам нужен управляемый); stuckAfterMs — порог зависания;
// getExtraEnv() — доп. env для pty (порт hook-bridge, Task 2).
// holdQueueFor(tabId) — I3 (ревью финальной волны фазы 8): НЕОБЯЗАТЕЛЬНАЯ
// зависимость, (tabId) => bool. Если передана и вернула true на Stop — очередь
// НЕ вбрасывается (элемент остаётся ждать следующего живого Stop). Без неё
// (default null) поведение прежнее — Stop всегда вбрасывает, как раньше.
function createSessionManager({
  ptyFactory,
  getTermConfig,
  onEvent,
  now = Date.now,
  stuckAfterMs = 5 * 60 * 1000,
  getExtraEnv = () => ({}),
  holdQueueFor = null,
  // Живая приёмка 01.08: (transcriptPath) => Promise<string> — чтение
  // настоящего заголовка сессии (ai-title) из транскрипта. НЕОБЯЗАТЕЛЬНАЯ
  // зависимость: без неё метка деградирует до фолбэка «первый промпт», всё
  // остальное работает как раньше. Реализация — session-title.js (ipc.js).
  readSessionTitle = null,
}) {
  const tabs = new Map();
  // Global-счётчик поколений (Important 1, ревью раунд 1 задачи 5 фазы 7):
  // ДО этого фикса каждая вкладка нумеровала свои поколения С НУЛЯ независимо
  // (tab.gen: 0 в открытии, tab.gen += 1 на каждом spawn/restart/close) — то
  // есть у ЛЮБЫХ двух вкладок первый спавн ОБЕИХ давал одинаковое gen:1.
  // Гард в applyHookEvent ниже сравнивает переданный gen с tab.gen НАЙДЕННОЙ
  // (замаршрутизированной по tabId/session_id) вкладки — а маршрутизация в
  // hook-bridge.js умеет уйти в ДРУГУЮ вкладку (findBySessionId: пользователь
  // закрыл вкладку A ровно в момент, когда её Stop-хук уже в полёте, открыл
  // новую вкладку B с ТОЙ ЖЕ сессией — опоздавший POST от A, несущий tabId,
  // которого мост уже не знает, находит B по session_id). Если у A и B первые
  // спавны совпали числом (оба 1 — типичный случай, не редкость), опоздавшее
  // событие A прошло бы гард B как «текущее поколение» — ровно тот побочный
  // эффект (вброс очереди в чужую сессию), ради которого гард и заводился.
  // genSeq — ОДИН на весь менеджер (ВСЕ вкладки шарят одну и ту же
  // возрастающую последовательность) — гарантирует, что gen НИКОГДА не
  // повторяется ни у одной пары спавнов за всё время жизни менеджера, даже
  // между разными (в т.ч. уже закрытыми) вкладками.
  let genSeq = 0;
  // Токены чтений заголовка сессии (Minor 2 ревью) — один счётчик на менеджер:
  // каждое чтение метит своё «занято», чтобы гасить только его (см.
  // requestSessionTitle).
  let titleReadSeq = 0;

  function open({
    cwd, command = null, args = null, smoke = false, ghostId = null, sessionId = null,
    // I3 (ревью 01.08): метка из манифеста — восстановленная вкладка
    // подписана СРАЗУ, ещё до первого хука. Настоящий заголовок из
    // транскрипта её потом подтвердит/уточнит (requestSessionTitle).
    sessionLabel = null,
  }) {
    const tabId = crypto.randomUUID();
    const name = path.basename(cwd) || cwd;
    // id ghost-буфера вкладки (Task 5) — стабилен на весь жизненный цикл вкладки.
    // Восстановление (Task 4/5) передаёт исходный ghostId из манифеста явно —
    // иначе каждый restore минтил бы новый id, а старый ghost-файл осиротевал
    // бы навсегда (ревью, finding 1a). Новая вкладка (без ghostId) получает
    // свежий как раньше.
    const resolvedGhostId = typeof ghostId === 'string' && ghostId ? ghostId : crypto.randomUUID();
    tabs.set(tabId, {
      tabId, cwd, name, smoke, ghostId: resolvedGhostId,
      command, args,           // per-tab переопределение (явный оверрайд конкретного спавна)
      proc: null, cols: 80, rows: 24, alive: false,
      gen: 0,                  // поколение спавна: гардит все колбэки от гонок
      // FIX 3 (ревью): sessionId восстановления передаётся ОТДЕЛЬНО от args —
      // раньше restoreFlow слал command:'claude'+args:['--resume', id], что (а)
      // подменяло конфигурационные args вкладки (--model и т.п. молча терялись)
      // и (б) игнорировало config.terminal.command. Теперь spawn() сам достраивает
      // ['--resume', sessionId] ПОВЕРХ базовых args на первый же спавн вкладки.
      sessionId: sessionId || null,
      resumeOnFirstSpawn: !!sessionId, // одноразовый флаг: спавн #1 добавит --resume <id>
      sessionBound: false,     // true, только когда SessionStart реально привязал сессию (bindSession)
      status: null, subtitle: '', waitingText: '',
      // C1 (ревью финальной волны фазы 8): вид последнего Notification —
      // 'idle'|'permission'|'' (ещё не было ни одного). Проставляется в
      // applyHookEvent/case 'Notification' (classifyNotification выше),
      // чистится вместе с waitingText при уходе из 'waiting' (см. setStatus).
      waitingKind: '',
      // Живая приёмка (01.08): «название» сессии для сайдбара — источники и
      // их приоритет описаны в шапке файла (`/rename`, автозаголовок,
      // фолбэк на первый промпт). Сбрасывается в restart() — новая жизнь
      // вкладки заслуживает новую метку.
      // M4 (ре-ревью): метка из манифеста проходит тот же усекатель, что и
      // живые источники — правленый вручную/старый манифест не должен
      // приносить в сайдбар многострочную простыню.
      sessionLabel: truncateForLabel(sessionLabel),
      sessionLabelFromTitle: false, // метка пришла из НАСТОЯЩЕГО заголовка (ai-title) — фолбэк-промпт её больше не трогает
      titleReadInFlight: false,     // идёт асинхронное чтение заголовка — не плодим параллельные
      // C1 (ре-ревью 01.08): токен ИДЕНТИЧНОСТИ МЕТКИ. Гарда по tab.gen
      // недостаточно: `/clear` заводит НОВУЮ сессию в ТОМ ЖЕ pty (SessionStart
      // с source:'clear' и новым session_id — сверено со схемой хука CLI
      // 2.1.220), поколение при этом не меняется, и висящее чтение СТАРОГО
      // транскрипта спокойно приземлилось бы на новую сессию. Счётчик растёт
      // при каждой смене того, «чьё имя мы показываем».
      labelGen: 0,
      lastOutputAt: now(),
      // Очередь промптов (Task 1 фазы 7): ввод для КОНКРЕТНОЙ сессии этой
      // вкладки — переживает обычное переключение вкладок, но НЕ переживает
      // close()/restart() (см. соответствующие функции ниже). Вбрасывается
      // строго по одному элементу на каждый хук Stop, только если pty жив
      // (см. applyHookEvent) — статус после вброса не подделывается, он
      // придёт следующим хуком от самого CLI.
      queue: [],
      pendingExtraArgs: null,  // одноразовый оверрайд args на следующий spawn() (хотфикс restart, спека §3.14)
      overrideFailed: false,   // true = процесс с оверрайдом (--resume <id>/--resume) умер, а SessionStart так и не привязал сессию
      spawnedAt: 0,            // now() на момент последнего spawn() — мерило «быстрой смерти» для авто-восстановления
      autoRecovered: false,    // true = авто-восстановление уже сработало на этой вкладке (не более раза; сброс в bindSession/restart)
      // Идле-арминг детекта зависаний (Task 6): без подключённых хуков «working»
      // означает лишь «терминал открыт» — вкладка, спокойно стоящая у промпта
      // (пользователь ещё не подключил хуки), не должна уезжать в «Проблемы».
      // Взводится ЛЮБЫМ хук-событием в applyHookEvent и живёт до конца вкладки.
      hookActive: false,
      // Живая приёмка 01.08: «работает» бывает двух очень разных сортов, и
      // детект зависаний имеет право только на второй.
      //   • «сессия запущена» — процесс поднялся и стоит у промпта. Никто
      //     ничего не просил, молчать он может сутками.
      //   • «думает…»/«Bash…» — человек дал поручение и ждёт ответа. Вот
      //     здесь молчание дольше порога и есть зависание.
      // Флаг взводится поручением (UserPromptSubmit/PreToolUse) и снимается,
      // когда ждать перестали: ответ пришёл (Stop), спросили разрешения
      // (Notification), сессия сменилась (SessionStart) или процесс
      // перезапустили (spawn). Без него нетронутые после запуска кокпита
      // вкладки уезжали в «Проблемы» с надписью «нет вывода 5м», а клик по
      // ним (перерисовка → вывод) возвращал обратно — и так по кругу.
      awaitingReply: false,
      // Подпись, с которой вкладка ушла в «зависла» — чтобы вернуть её при
      // первом же выводе, а не оставлять «нет вывода Nм» на работающей.
      subtitleBeforeStuck: '',
    });
    onEvent('tabs:changed', {}); // состав вкладок изменился — main пересоберёт манифест
    // sessionLabel в ответе (I3, ревью 01.08) — renderer рисует метку сразу
    // при добавлении строки, не дожидаясь первого tab:status.
    return { tabId, cwd, name, sessionLabel: tabs.get(tabId).sessionLabel };
  }

  // extra (Important 1, ревью Task 2 фазы 8) — необязательный объект,
  // домешиваемый в payload 'tab:status' ПОВЕРХ обычных полей. Единственный
  // вызывающий, который его передаёт, — ветка 'Stop' в applyHookEvent ниже
  // (поле genProven — см. подробный комментарий там). Остальные вызовы
  // setStatus() не передают extra вовсе, так что их payload не меняется НИ
  // НА БАЙТ — `...(extra || {})` от undefined добавляет пустой объект.
  function setStatus(tab, status, subtitle, extra) {
    tab.status = status;
    if (typeof subtitle === 'string') tab.subtitle = subtitle;
    // C1: waitingKind — та же судьба, что waitingText (оба относятся к
    // ПОСЛЕДНЕМУ Notification; уход из 'waiting' в ЛЮБОЙ другой статус
    // делает их прошлым состоянием, а не текущим).
    if (status !== 'waiting') { tab.waitingText = ''; tab.waitingKind = ''; }
    // C2 (Critical, ревью финальной волны фазы 9): waitingKind уже считался
    // (classifyNotification выше) и уже уходит наружу через list() (для
    // ipc.js/ночной смены), но НИКОГДА не попадал в сам payload 'tab:status' —
    // renderer (Task 3 фазы 9, голосовой ввод) не мог отличить «ждёт
    // idle_prompt» (пишущий статус, та же семантика, что ночная смена уже
    // признаёт) от «ждёт диалога разрешения» (блокирующий), и блокировал
    // ЛЮБОЙ 'waiting'. Лишний ключ инертен для остальных потребителей payload
    // (тот же прецедент, что genProven чуть выше по функции).
    onEvent('tab:status', {
      tabId: tab.tabId, status, subtitle: tab.subtitle, waitingText: tab.waitingText,
      waitingKind: tab.waitingKind, sessionLabel: tab.sessionLabel,
      ...(extra || {}),
    });
  }

  function spawn(tab) {
    const t = getTermConfig();
    // pendingExtraArgs — одноразовый оверрайд от restart() (--resume <id> или
    // голый --resume), потребляется здесь и сбрасывается, чтобы следующий
    // обычный спавн был «голым».
    let extraArgs = tab.pendingExtraArgs;
    tab.pendingExtraArgs = null;
    let usedOverride = extraArgs !== null; // этот спавн ушёл с оверрайдом --resume
    const baseArgs = tab.args || t.args;
    // FIX 3 (ревью): если restart() не заказал явный оверрайд, а вкладка
    // восстановлена с известным sessionId и это её самый первый спавн —
    // достраиваем --resume <id> ПОВЕРХ конфигурационных baseArgs (а не вместо
    // них, как раньше делал restoreFlow через args:['--resume', id]). Флаг
    // одноразовый — второй и далее спавны этой вкладки идут без него.
    if (extraArgs === null && tab.resumeOnFirstSpawn && tab.sessionId) {
      extraArgs = ['--resume', tab.sessionId];
      tab.resumeOnFirstSpawn = false;
      usedOverride = true;
    }
    const spec = tab.smoke
      ? { command: 'cmd.exe', args: ['/c', 'echo PTY_OK'] }
      : { command: tab.command || t.command, args: extraArgs ? [...baseArgs, ...extraArgs] : baseArgs };
    // Новый процесс никто ни о чём не просил — ожидание ответа снимаем ЗДЕСЬ,
    // а не в SessionStart: резюм может не подтвердиться вовсе (провал
    // --resume), и тогда SessionStart не придёт, а флаг остался бы взведённым
    // от прошлой жизни вкладки — и она уехала бы в «Проблемы» ни за что.
    tab.awaitingReply = false;
    // Поколение растёт ДО вызова фабрики: синхронные колбэки нового процесса
    // проходят гард, а все колбэки предыдущего поколения — отсекаются.
    // GLOBAL-счётчик genSeq (Important 1, ревью раунд 1) — не += 1 у самой
    // вкладки: см. подробное обоснование у объявления genSeq выше по файлу.
    tab.gen = ++genSeq;
    const myGen = tab.gen;
    tab.spawnedAt = now(); // момент ЭТОГО спавна — мерило «быстрой смерти» ниже, в onExit
    try {
      const proc = ptyFactory({
        ...spec,
        cwd: tab.cwd,
        cols: tab.cols,
        rows: tab.rows,
        useConpty: t.useConpty !== false,
        useConptyDll: t.useConptyDll !== false,
        env: {
          ...sanitizedProcessEnv(),
          COCKPIT: '1',
          COCKPIT_TAB_ID: tab.tabId,
          // Гард поколения для хуков (доп. пункт ревью Task 1, фаза 7): поколение
          // ИМЕННО ЭТОГО спавна — hook-bridge.js прокидывает его обратно в
          // applyHookEvent() (см. ниже), чтобы отличить хук-событие текущего
          // процесса от опоздавшего события уже убитого/перезапущенного (см.
          // подробный комментарий у applyHookEvent).
          COCKPIT_TAB_GEN: String(myGen),
          ...getExtraEnv(),
        },
        onData: (data) => {
          if (myGen !== tab.gen) return; // хвост убитого процесса
          tab.lastOutputAt = now();
          // Ожила — вернуть не только статус, но и осмысленную подпись.
          // Раньше сюда передавалась tab.subtitle, то есть САМА надпись
          // «нет вывода Nм»: вкладка возвращалась в «Работают», продолжая
          // уверять, что вывода нет — прямо в тот момент, когда он пришёл.
          if (tab.status === 'stuck') setStatus(tab, 'working', tab.subtitleBeforeStuck || 'работает…');
          onEvent('term:data', { tabId: tab.tabId, data });
        },
        onExit: (exitCode) => {
          if (myGen !== tab.gen) return; // stale exit после рестарта/close() (или намеренный kill — см. гард в restart())
          // Провал резюма/continue: процесс с оверрайдом умер естественной смертью,
          // а SessionStart так и не привязал сессию за время его жизни —
          // следующий restart() уйдёт в голые args (не зацикливаемся). FIX 3
          // (ревью): проверяем ПО ФАКТУ привязки (sessionBound), а не по
          // наличию sessionId — иначе восстановленная вкладка (у которой
          // sessionId уже был известен ДО спавна, из манифеста) никогда не
          // считалась бы провалившейся, даже если resume реально не удался.
          const failedOverride = usedOverride && !tab.sessionBound;
          if (failedOverride) {
            tab.overrideFailed = true;
            // D1 (ре-ревью раунда 2): «мы больше не эта сессия» доказано
            // ЗДЕСЬ — резюм провалился, сейчас поднимется чистая новая
            // сессия. Сбрасываем идентичность метки ДО обнуления sessionId:
            // иначе гарда в bindSession (она сравнивает СТАРЫЙ id с новым)
            // увидит уже null, не сработает, и вкладка навсегда останется
            // подписана именем сессии, которой в ней больше нет — причём
            // sessionLabelFromTitle остался бы true, и своё имя новая сессия
            // не прочитала бы уже никогда. Бьёт по главному сценарию фичи:
            // утренняя восстановленная вкладка с протухшим id.
            resetLabelIdentity(tab);
            // Обнуляем протухший sessionId — иначе он уедет в манифест и
            // следующий запуск снова попробует резюмить уже мёртвую сессию.
            tab.sessionId = null;
            // FIX 4 (carryover 3): manager.list() отдаёт sessionId, но
            // syncWorkspace в ipc.js пересобирает манифест только по событию
            // 'tabs:changed' — а его здесь не было. Без этой строки протухший
            // id оставался бы в manifest.tabs (обнулился только в памяти),
            // и следующий запуск снова попытался бы --resume уже мёртвую
            // сессию. restart() (см. ниже) шлёт tabs:changed сам по себе,
            // но это НЕ покрывает провал самого первого спавна восстановленной
            // вкладки (open() с sessionId из манифеста → start() → сюда) —
            // restart() в этом пути ещё не вызывался.
            onEvent('tabs:changed', {});
          }
          tab.proc = null;
          tab.alive = false;

          // Мягкая деградация (спека §6): «фантомная» сессия — SessionStart
          // отдал session_id, но claude был закрыт до первого сообщения, и
          // транскрипт так и не создался. Следующий запуск резюмит id,
          // которого не существует, claude падает почти сразу (exit 1), и
          // раньше вкладка так и оставалась dead — чинить приходилось руками
          // (Ctrl+Shift+R). Гарды: (1) процесс должен быть короткоживущим —
          // долгую сессию, умершую саму по себе, авто-перезапускать нельзя;
          // (2) не более одного раза на вкладку (autoRecovered), иначе при
          // системной проблеме (например, бинарник claude сломан) получим
          // бесконечный цикл спавнов. Гард по поколению (проверка myGen
          // выше) уже отсекает этот путь, если вкладку в это время закрывают
          // (close() бампает gen ДО kill()) — авто-спавн после close() не
          // выстрелит.
          const livedMs = now() - tab.spawnedAt;
          if (failedOverride && !tab.autoRecovered && livedMs < AUTO_RECOVER_MAX_LIFETIME_MS) {
            tab.autoRecovered = true;
            onEvent('term:data', {
              tabId: tab.tabId,
              data: '\r\n\x1b[2m[сессия не найдена — открываю новую]\x1b[0m\r\n',
            });
            // I3 (ревью финальной волны фазы 7): очередь — ввод для СТАРОЙ
            // (протухшей) сессии; авто-восстановление поднимает НОВУЮ,
            // контекстно ПУСТУЮ сессию — тот же принцип, что уже применён в
            // restart() чуть ниже по файлу (clearQueue перед новым spawn),
            // просто не был перенесён на этот, отдельный путь автоматического
            // перезапуска. Без этой строки первый живой Stop новой сессии
            // (поколение будет уже корректным — гард Task 5/Important 1 тут
            // бессилен по построению, событие СВОЁ, не чужое) вбросил бы,
            // например, «удали ветку feature/x» в процесс, который вообще не
            // видел этого контекста.
            clearQueue(tab.tabId);
            spawn(tab);
            return;
          }

          setStatus(tab, 'dead', `процесс завершён (код ${exitCode})`);
          onEvent('term:exit', { tabId: tab.tabId, exitCode });
        },
      });
      // Синхронный exit из фабрики мог уже пометить смерть — не воскрешаем.
      if (myGen === tab.gen && tab.status !== 'dead') {
        tab.proc = proc;
        tab.alive = true;
        // Процесс поднят — но он ещё ничего не делает: 'ready' («Наготове»),
        // не 'working'. Important 1 ревью 01.08: правку статуса сделали только
        // в обработчике SessionStart и забыли, что первый статус ставит сам
        // спавн. Для проекта БЕЗ подключённых хуков (штатное состояние, ⚡ в
        // сайдбаре) SessionStart не придёт никогда — и вкладка висела в
        // «Работают» до закрытия кокпита, то есть ровно та жалоба, ради
        // которой всё затевалось. Плюс восстановление десятка вкладок больше
        // не гоняет счётчик «Работают» весь стаггер.
        setStatus(tab, 'ready', 'сессия запущена');
        onEvent('term:started', { tabId: tab.tabId, pid: proc.pid });
      }
    } catch (err) {
      tab.proc = null;
      tab.alive = false;
      setStatus(tab, 'dead', 'не запустился');
      onEvent('term:data', {
        tabId: tab.tabId,
        data: `\x1b[31m[не удалось запустить ${spec.command}: ${err.message}]\x1b[0m\r\n`,
      });
      onEvent('term:exit', { tabId: tab.tabId, exitCode: -1 });
    }
  }

  function start(tabId, cols, rows) {
    const tab = tabs.get(tabId);
    if (!tab || tab.proc) return;
    tab.cols = cols;
    tab.rows = rows;
    spawn(tab);
  }

  function write(tabId, data) {
    const tab = tabs.get(tabId);
    if (tab && tab.proc) tab.proc.write(data);
  }

  function resize(tabId, cols, rows) {
    const tab = tabs.get(tabId);
    if (!tab) return;
    tab.cols = cols;
    tab.rows = rows;
    if (tab.proc) tab.proc.resize(cols, rows);
  }

  // --- очередь промптов (Task 1 фазы 7) ---

  // Пустой/пробельный текст молча игнорируется — не плодим бессмысленные
  // элементы очереди и лишние queue:changed.
  //
  // M2 (ревью финальной волны фазы 7): normalizeForPty(text) — тот же
  // хардинг, что уже применяется к тексту рецепта ПЕРЕД записью в pty
  // (app.js/runRecipe). Без этого внутренний перенос строки в тексте,
  // положенном в очередь напрямую (без рецепта, просто через Ctrl+Q/поле
  // ввода), ушёл бы отдельным Enter при вбросе — injectQueuedOnStop пишет
  // `${text}\r` ОДНОЙ командой, а терминал интерпретирует внутренний '\n'
  // как ЕЩЁ один Enter, так что первая строка ушла бы самостоятельным
  // промптом раньше остальных (и диалог разрешения — молча подтверждён) —
  // ровно та же ловушка, что уже чинили у рецептов (Minor 8, ревью раунд 1).
  // Два пути записи в pty (рецепт и очередь) должны быть захардены одинаково.
  function enqueue(tabId, text) {
    const tab = tabs.get(tabId);
    if (!tab) return;
    if (typeof text !== 'string' || !text.trim()) return;
    tab.queue.push(normalizeForPty(text));
    onEvent('queue:changed', { tabId, queue: tab.queue.slice() });
  }

  function removeFromQueue(tabId, index) {
    const tab = tabs.get(tabId);
    if (!tab) return;
    if (!Number.isInteger(index) || index < 0 || index >= tab.queue.length) return;
    tab.queue.splice(index, 1);
    onEvent('queue:changed', { tabId, queue: tab.queue.slice() });
  }

  // Опустошает очередь; на уже пустой — no-op (не эмитит лишнее queue:changed).
  // Переиспользуется close()/restart() ниже — очередь это ввод для конкретной
  // сессии вкладки, не переживает ни закрытие, ни рестарт.
  function clearQueue(tabId) {
    const tab = tabs.get(tabId);
    if (!tab || !tab.queue.length) return;
    tab.queue = [];
    onEvent('queue:changed', { tabId, queue: [] });
  }

  // Возвращает ВЕСЬ текущий массив очереди и опустошает её — в отличие от
  // clearQueue (которая просто чистит), отдаёт вызывающему код снятое
  // содержимое (на будущее — сценарии вроде «показать, что было в очереди»).
  function dequeueAll(tabId) {
    const tab = tabs.get(tabId);
    if (!tab) return [];
    const drained = tab.queue;
    tab.queue = [];
    onEvent('queue:changed', { tabId, queue: [] });
    return drained;
  }

  // Вброс РОВНО ОДНОГО элемента очереди на хук Stop (спека задачи 1 фазы 7):
  // только если pty жив — мёртвый процесс не должен терять текст пользователя,
  // элемент остаётся в очереди до следующего живого Stop (после restart()
  // очередь уже будет расчищена — см. restart() ниже, так что зависшие
  // элементы этой веткой не разрастаются бесконечно). Статус НЕ трогаем —
  // 'done', выставленный самим Stop чуть выше по applyHookEvent, останется,
  // пока реальный CLI не пришлёт следующий хук (UserPromptSubmit/PreToolUse).
  function injectQueuedOnStop(tab) {
    if (!tab.proc || !tab.queue.length) return;
    const text = tab.queue[0];
    tab.proc.write(`${text}\r`);
    tab.queue.shift();
    onEvent('queue:changed', { tabId: tab.tabId, queue: tab.queue.slice() });
  }

  // Рестарт «на месте» (Ctrl+Shift+R) не должен терять сессию — три уровня
  // деградации из спеки §3.14:
  function restart(tabId) {
    const tab = tabs.get(tabId);
    if (!tab) return;

    // Очередь — ввод для СТАРОЙ сессии этой вкладки; новая жизнь (новый
    // spawn ниже) не должна унаследовать чужой недоотправленный текст.
    clearQueue(tabId);

    // Поколение растёт ДО kill() — так же, как в close(). Если фабрика (реальный
    // node-pty) синхронно зовёt onExit прямо из kill(), этот exit уже попадёт на
    // старое поколение и будет отсечён гардом внутри spawn() — намеренный рестарт
    // не должен путать себя с провалом resume/continue и не должен слать dead-статус.
    // GLOBAL-счётчик (Important 1, ревью раунд 1) — см. genSeq выше по файлу.
    tab.gen = ++genSeq;

    const boundSessionId = tab.sessionId;

    if (tab.proc) {
      try { tab.proc.kill(); } catch { /* мог уже завершиться */ }
      tab.proc = null;
      tab.alive = false;
    }

    tab.sessionId = null; // новая жизнь — новый SessionStart перебиндит
    tab.sessionBound = false; // FIX 3: привязка тоже сбрасывается — новый спавн ещё не подтверждён
    tab.autoRecovered = false; // ручной рестарт — гард одноразовости авто-восстановления взводится заново
    // I1 (ревью 01.08): метку стираем ТОЛЬКО если рестарт реально меняет
    // сессию. При сохранённом boundSessionId ниже спавнится `--resume
    // <тот же id>` — сессия та же, и обнуление переименовывало бы вкладку
    // следующим промптом («почини тесты» → «прогони линтер») без всякой
    // причины. Голый `--resume` (интерактивный пикер) может привести ЛЮБУЮ
    // сессию — вот там метка обязана уйти, чтобы не подписывать вкладку
    // чужим именем.
    if (!boundSessionId) {
      resetLabelIdentity(tab);
    } else {
      // Сессия та же (--resume того же id) — саму метку НЕ гасим, чтобы
      // сайдбар не мигал пустотой. Но заголовок ПЕРЕЧИТЫВАЕМ: Ctrl+Shift+R —
      // выбранный пользователем момент подхвата нового имени из `/rename`
      // (запрос 01.08: «пускай обновляется когда я перезапускаю сессию»).
      // Без сброса флага requestSessionTitle рано вышел бы и новое имя
      // осталось бы невидимым до перезапуска всего кокпита.
      tab.sessionLabelFromTitle = false;
      tab.titleReadInFlight = false; // висящее чтение отсечётся по gen
    }

    if (boundSessionId) {
      // 1. session_id уже известен (из прошлого SessionStart) — резюмируем именно его.
      tab.pendingExtraArgs = ['--resume', boundSessionId];
    } else if (tab.overrideFailed) {
      // 3. Предыдущий спавн с оверрайдом (--resume <id> либо голый --resume) реально
      //    умер, не привязав сессию — не зацикливаемся на вечных попытках, голые args.
      tab.pendingExtraArgs = null;
      tab.overrideFailed = false;
    } else {
      // 2. session_id ещё нет, и прошлый оверрайд не проваливался (либо его не
      //    было, либо процесс всё ещё жив). Раньше здесь был --continue —
      //    но он берёт «самую свежую» сессию ЭТОЙ cwd вслепую, а cwd бывает
      //    общей (несколько вкладок/CLI-сессий в одной папке): --continue мог
      //    подцепить ЧУЖУЮ, живую сессию пользователя, и она падает при
      //    попытке её загрузить (exit 1). Голый --resume вместо этого
      //    открывает интерактивный пикер сессий Claude Code прямо во вкладке —
      //    пользователь выбирает нужную сессию визуально, никакой угадайки.
      tab.pendingExtraArgs = ['--resume'];
    }

    spawn(tab);
    // sessionId вкладки мог обнулиться (провал резюма) — манифест должен это
    // узнать, иначе следующий запуск приложения снова попробует резюмить уже
    // протухший id и уйдёт в тот же фейл-луп (Task 4, ревью Task 3).
    onEvent('tabs:changed', {});
  }

  function close(tabId) {
    const tab = tabs.get(tabId);
    if (!tab) return;
    // Очередь — ввод для ЭТОЙ сессии; закрытие вкладки не должно оставлять
    // висящий queue:changed на несуществующий tabId ни у кого из подписчиков.
    clearQueue(tabId);
    tab.gen = ++genSeq; // отсекаем любые будущие колбэки процесса; GLOBAL-счётчик, Important 1
    if (tab.proc) {
      try { tab.proc.kill(); } catch { /* мог уже завершиться */ }
    }
    tabs.delete(tabId);
    onEvent('tabs:changed', {}); // состав вкладок изменился — main пересоберёт манифест
  }

  // --- привязка session_id и события хуков ---

  function bindSession(tabId, sessionId) {
    const tab = tabs.get(tabId);
    if (tab) {
      // C1 (ре-ревью 01.08): пришёл ДРУГОЙ session_id — сессия подменилась
      // внутри той же вкладки (`/clear` в том же pty). Старое имя стало
      // чужим — см. resetLabelIdentity() выше по файлу.
      if (tab.sessionId && sessionId && sessionId !== tab.sessionId) {
        resetLabelIdentity(tab);
      }
      tab.sessionId = sessionId;
      tab.sessionBound = true; // FIX 3: единственное место, где привязка считается ПОДТВЕРЖДЁННОЙ
      tab.autoRecovered = false; // резюм реально удался — авто-восстановление снова доступно на будущее
    }
    onEvent('tabs:changed', {}); // sessionId вкладки мог измениться — манифест должен это узнать
  }

  // Знает ли менеджер такой tabId вообще (для точной адресации хуков по
  // COCKPIT_TAB_ID в hook-bridge.js — см. Фикс 2, спека приоритета маршрутизации).
  function has(tabId) {
    return tabs.has(tabId);
  }

  function findBySessionId(sessionId) {
    for (const tab of tabs.values()) {
      if (tab.sessionId === sessionId) return tab.tabId;
    }
    return null;
  }

  function findUnboundByCwd(cwd) {
    for (const tab of tabs.values()) {
      if (!tab.sessionId && tab.cwd === cwd) return tab.tabId;
    }
    return null;
  }
  // Запрос настоящего заголовка сессии (ai-title из транскрипта) — живая
  // приёмка 01.08. Асинхронный, поэтому обвешан гардами: между запросом и
  // ответом вкладка могла закрыться, перезапуститься (Ctrl+Shift+R) или
  // сменить сессию — ровно тот класс гонки, что уже дважды кусал этот файл
  // (гард поколения pty, вброс очереди в чужую сессию). Снимок gen на входе
  // + сверка на выходе; чужой/устаревший ответ молча выбрасывается.
  //
  // Гарды до чтения: нет readSessionTitle (зависимость необязательна — тесты
  // и старые вызывающие живут без неё) / нет пути / настоящий заголовок уже
  // получен / чтение по этому пути уже летит.
  function requestSessionTitle(tab, transcriptPath) {
    if (!readSessionTitle || typeof transcriptPath !== 'string' || !transcriptPath) return;
    if (tab.sessionLabelFromTitle) return; // настоящий заголовок уже есть — второй раз не читаем
    if (tab.titleReadInFlight) return; // не плодим параллельные чтения на каждый промпт
    // Minor 2 (ревью): в поле лежит ТОКЕН конкретного чтения, а не просто
    // «идёт/не идёт». Иначе запоздавший ответ старого чтения (после
    // Ctrl+Shift+R, который сбрасывает поле и стартует новое) гасил бы флаг
    // УЖЕ ИДУЩЕГО чтения, и следующий промпт запускал бы третье параллельно.
    // Токен же снимает только своё — а сверять его с поколением нельзя:
    // обычный spawn() тоже растит gen, и такая сверка вернула бы защёлку M1.
    titleReadSeq += 1;
    const myRead = titleReadSeq;
    tab.titleReadInFlight = myRead;
    // Снимок ОБЕИХ идентичностей: gen — «тот же процесс», labelGen — «та же
    // сессия» (C1: `/clear` меняет сессию, не трогая процесс).
    const myGen = tab.gen;
    const myLabelGen = tab.labelGen;
    const myTabId = tab.tabId;
    // M1 (ре-ревью): флаг обязан сниматься на ЛЮБОМ исходе, включая ранний
    // выход по протухшему снимку — иначе односторонняя защёлка навсегда
    // глушила бы чтения этой вкладки (достижимо через авто-респавн).
    // Снимаем занятость, только если в поле всё ещё НАШ токен: чужое
    // (уже стартовавшее) чтение гасить нельзя, а своё — обязаны на ЛЮБОМ
    // исходе, включая протухший снимок (M1: иначе односторонняя защёлка).
    const done = () => {
      const live = tabs.get(myTabId);
      if (live && live === tab && live.titleReadInFlight === myRead) {
        live.titleReadInFlight = false;
      }
    };
    const mySessionId = tab.sessionId;
    Promise.resolve()
      .then(() => readSessionTitle(transcriptPath, mySessionId))
      .then((title) => {
        const live = tabs.get(myTabId);
        done();
        // Вкладка закрыта / перезапущена (новое поколение pty) / сменила
        // сессию в том же pty (новый labelGen) — ответ протух.
        if (!live || live !== tab || live.gen !== myGen || live.labelGen !== myLabelGen) return;
        const clean = truncateForLabel(title);
        if (!clean) return;
        // I1 (ре-ревью): флаг взводим, КАК ТОЛЬКО получен непустой заголовок,
        // ещё до сравнения с текущей меткой. Иначе главный сценарий (метка из
        // манифеста уже РАВНА ai-title) не считался бы «заголовок получен», и
        // чтение повторялось бы на каждом промпте до конца сессии.
        live.sessionLabelFromTitle = true;
        if (clean === live.sessionLabel) return;
        live.sessionLabel = clean;
        // Рассылаем метку тем же каналом, что и статусы: статус НЕ меняем —
        // передаём текущий. labelOnly (I2 ре-ревью) помечает событие как
        // «изменилась ТОЛЬКО метка»: потребители с побочными эффектами
        // (Windows-тосты, сохранение ghost-буфера) обязаны его пропустить —
        // статус-то не менялся, а повторный тост «готово» пользователю не
        // нужен.
        setStatus(live, live.status, live.subtitle, { labelOnly: true });
        // M3 (ре-ревью): метка изменилась — манифест должен это узнать сам, а
        // не ждать попутного чужого события (иначе для сессий без ai-title
        // фолбэк-метка могла не дожить до утра).
        onEvent('tabs:changed', {});
      })
      .catch(() => {
        done();
      });
  }


  // Переходы машины статусов по событиям хуков (спека §5.2). gen — поколение
  // pty, которое ПОРОДИЛО это событие (см. COCKPIT_TAB_GEN в spawn() выше и
  // маршрутизацию в hook-bridge.js/cockpit-hook.js) — необязательный
  // параметр: вызовы без него (внутренние тесты, гипотетический старый
  // хук-скрипт без gen) не гардятся, ведут себя как раньше.
  //
  // ДОП. НАХОДКА (ревью Task 1 фазы 7, не входила в бриф Task 5, добавлена
  // отдельно координатором): маршрутизация хуков была привязана только к
  // tabId/session_id, но НЕ к поколению pty — опоздавший Stop уже убитого
  // (restart()/close()) процесса мог долететь ПОСЛЕ того, как в этой же
  // вкладке уже поднялась новая сессия (новый tab.gen), и applyHookEvent
  // применил бы его к ТЕКУЩЕМУ (чужому для этого события) состоянию вкладки.
  // Раньше это было почти безобидно (статус просто перезаписывался тем же
  // значением, максимум — лишний git:changed), но очередь промптов (Task 1
  // фазы 7) впервые повесила на Stop ЖИВОЙ побочный эффект — вброс текста в
  // pty (injectQueuedOnStop ниже) — и опоздавший Stop старого поколения мог
  // бы вбросить чужой элемент очереди не в свою сессию. Гардим здесь же, тем
  // же приёмом, что онData/onExit в spawn() выше: событие с чужим (не
  // текущим) поколением отбрасывается ЦЕЛИКОМ, а не только вброс очереди —
  // это закрывает более широкий класс гонок в рамках ОДНОЙ вкладки (включая
  // гипотетическую опоздавшую SessionStart, которая иначе могла бы
  // перепривязать sessionId вкладки на чужую сессию), а не только тот
  // единственный сценарий, где нашёлся живой побочный эффект.
  //
  // Important 1 (ревью раунд 1, обязательная правка): широкий гард выше
  // сам по себе НЕДОСТАТОЧЕН без ГЛОБАЛЬНОЙ уникальности gen (см. genSeq в
  // начале файла) — маршрутизация в hook-bridge.js умеет уйти в ДРУГУЮ
  // вкладку (findBySessionId, если исходная уже закрыта), а до этого фикса
  // gen нумеровался С НУЛЯ у КАЖДОЙ вкладки независимо — первый спавн любых
  // двух вкладок обычно давал ОДИНАКОВЫЙ gen:1, и опоздавшее событие закрытой
  // вкладки A с gen:1 прошло бы гард gen:1 совершенно другой вкладки B (та же
  // сессия, найдена по session_id) как «текущее поколение». genSeq делает
  // gen уникальным не только внутри вкладки, а на весь менеджер — только
  // тогда сравнение `gen !== tab.gen` действительно доказывает «это
  // поколение ЭТОЙ КОНКРЕТНОЙ вкладки, а не чьё-то ещё».
  //
  // I4 (ревью финальной волны фазы 7): gen===null/undefined («доказательства
  // ВООБЩЕ нет») раньше полностью выключал гард — а маршрутизация по
  // session_id (см. hook-bridge.js) доступна и процессам ВНЕ кокпита: та же
  // сессия S открыта во вкладке B кокпита И в обычном терминале снаружи, оба
  // шлют хуки одного и того же проекта (.claude/settings.json один на
  // проект), у внешнего нет COCKPIT_TAB_GEN → gen:null → мост находит B по
  // session_id → старый гард пропускал это как «событие для B» безусловно —
  // Stop внешнего процесса печатал очередной элемент очереди в pty вкладки
  // B, которая к этому не имеет отношения.
  //
  // Фикс — УЗКИЙ, не откат маршрутизации: сторонние сессии ДОЛЖНЫ продолжать
  // двигать статусы вкладки (заявленная фича port-file, см. шапку
  // hook-bridge.js) — только ЖИВОЙ побочный эффект (injectQueuedOnStop —
  // запись пользовательских клавиш в чужой pty) требует ДОКАЗАННОГО поколения
  // (gen — число, и оно совпало с tab.gen). genProven ниже — единственное
  // место, которое это доказательство проверяет; статус-переходы (switch
  // ниже) им НЕ гейтятся вовсе.
  function applyHookEvent(tabId, event, data = {}, gen = null) {
    const tab = tabs.get(tabId);
    if (!tab) return;
    if (gen !== null && gen !== undefined && gen !== tab.gen) return; // ДОКАЗАННО чужое поколение — блокируем всё
    // I4: истинно, только если gen — число И оно совпало с tab.gen. Ложно и
    // при отсутствии gen (null/undefined — недоказано), и при мисматче (уже
    // отсечён строкой выше, до этой точки такой случай не доходит вовсе).
    const genProven = gen !== null && gen !== undefined && gen === tab.gen;
    // Любое хук-событие — доказательство, что хуки Cockpit подключены к
    // проекту и статусы вкладки отныне честны; взводим idle-арминг один раз.
    tab.hookActive = true;
    switch (event) {
      case 'SessionStart':
        if (data.session_id) {
          bindSession(tabId, data.session_id);
          tab.overrideFailed = false; // resume/continue подтверждён хуком — попытка удалась
        }
        // Живая приёмка 01.08: настоящий заголовок сессии живёт в
        // транскрипте (ai-title), путь к которому CLI кладёт прямо в payload
        // (transcript_path). Читаем асинхронно — это главный источник метки,
        // и именно он подписывает утренние --resume вкладки.
        requestSessionTitle(tab, data.transcript_path);
        // Сессия только поднялась — поручения нет, ждать нечего (в т.ч. после
        // `/clear`: новая сессия не наследует ожидание старой).
        //
        // ИСКЛЮЧЕНИЕ — source:'compact'. Сжатие контекста происходит ПОСРЕДИ
        // выполнения поручения, и работа продолжается сразу после него: гасить
        // здесь ожидание значило бы ослепить детект ровно в том месте, где
        // зависнуть проще всего. Установленный CLI (2.1.220) такого события не
        // шлёт — проверено по бинарнику: все шесть эмиссий session-start идут с
        // source:"startup" (включая путь --resume), а у сжатия свои события
        // PreCompact/PostCompact, на которые кокпит не подписан (connector.js).
        // Но контракт хука такой source допускает, CLI обновляется по несколько
        // раз в неделю, а цена страховки — одна строка (ревью 01.08).
        if (data.source !== 'compact') {
          tab.awaitingReply = false;
          // Не 'working': поднявшаяся сессия ещё ничего не делает (см. STATUSES).
          setStatus(tab, 'ready', 'сессия запущена');
        } else {
          setStatus(tab, 'working', 'сжимает контекст…');
        }
        break;
      case 'UserPromptSubmit':
        applyPromptFallback(tab, data);
        // Заголовок мог сгенерироваться уже ПОСЛЕ SessionStart (новая сессия:
        // на старте его в транскрипте ещё нет) — перепроверяем на каждом
        // промпте, пока не получим настоящий (гард внутри — см. функцию).
        requestSessionTitle(tab, data.transcript_path);
        tab.awaitingReply = true; // вот теперь ответа реально ждут
        setStatus(tab, 'working', 'думает…');
        break;
      case 'PreToolUse':
        // Работа инструментом — тоже доказательство, что ответ в процессе.
        // Взводим и здесь: промпт мог уйти мимо кокпита (сторонний процесс той
        // же сессии, маршрутизация по session_id), а зависнуть на инструменте
        // такая работа может ровно так же.
        tab.awaitingReply = true;
        setStatus(tab, 'working', data.tool_name ? `${data.tool_name}…` : 'работает…');
        break;
      case 'Notification': {
        tab.waitingText = String(data.message || '');
        // C1 (Critical, ревью финальной волны): idle_prompt vs
        // permission_prompt — см. classifyNotification() выше по файлу.
        //
        // N2 (ре-ревью финальной волны), «липкий permission»: если вкладка
        // УЖЕ ждёт диалога разрешения, поздний idle-пинг поверх открытого
        // диалога НЕ понижает permission → idle — иначе ночное «продолжай\r»
        // ушло бы прямо в диалог и подтвердило подсвеченный вариант.
        // Понижение возможно только после выхода из 'waiting' (setStatus
        // чистит waitingKind при любом другом статусе).
        const kind = classifyNotification(tab.waitingText, data.notification_type);
        if (!(tab.status === 'waiting' && tab.waitingKind === 'permission' && kind === 'idle')) {
          tab.waitingKind = kind;
        }
        tab.status = 'waiting';
        // Ждут уже человека, а не машину: молчание здесь нормально и
        // зависанием не является, сколько бы ни длилось.
        tab.awaitingReply = false;
        tab.subtitle = tab.waitingText.slice(0, 120);
        // C2 (Critical, ревью финальной волны фазы 9): та же правка, что в
        // setStatus() выше по файлу — waitingKind в payload, renderer больше
        // не путает idle_prompt с permission_prompt.
        onEvent('tab:status', {
          tabId: tab.tabId,
          status: 'waiting',
          subtitle: tab.subtitle,
          waitingText: tab.waitingText,
          waitingKind: tab.waitingKind,
          sessionLabel: tab.sessionLabel,
        });
        break;
      }
      case 'Stop':
        // Important 1 (ревью Task 2 фазы 8, «Ночная смена»): night-watch.js
        // детектит остановку по лимиту через working→done на 'tab:status', а
        // не через собственный гард поколения — до этого фикса он доверял
        // ЛЮБОМУ working→done, включая пришедший от СТОРОННЕГО процесса той
        // же сессии (маршрутизация по session_id, gen:null — заявленная
        // фича port-file, см. I4 выше). Сценарий отказа: сессия S открыта во
        // вкладке B кокпита И в обычном терминале снаружи; внешний процесс
        // завершает СВОЮ задачу и шлёт Stop без COCKPIT_TAB_GEN → статус B
        // уезжает в 'done', хотя B всё это время реально работала над своей —
        // ночная смена посчитала бы это остановкой по лимиту и позже вбросила
        // бы «продолжай» в живой ввод B. genProven здесь — ТОТ ЖЕ флаг, что
        // уже гейтит injectQueuedOnStop чуть ниже (см. его определение выше
        // по функции) — прокидываем его же в payload 'tab:status', чтобы
        // обвязка ipc.js могла потребовать ДОКАЗАННОЕ поколение и для детекта
        // ночной смены, тем же приёмом, что уже защищает вброс очереди.
        tab.awaitingReply = false; // ответ пришёл — ждать больше нечего
        setStatus(tab, 'done', '', { genProven });
        // Task 1 фазы 7 (очередь промптов): вбрасываем СТРОГО один элемент
        // очереди на этот Stop — не всю очередь разом. Гарды (pty жив,
        // очередь непуста) — внутри injectQueuedOnStop(). I4 (ревью финальной
        // волны): плюс гард ДОКАЗАННОГО поколения здесь же — недоказанное
        // (gen:null, сторонний процесс) не даёт права писать в pty.
        //
        // I3 (ревью финальной волны фазы 8, шов с фазой 7): вкладка, которая
        // сейчас в pending ночной смены (встала по лимиту, ждёт сброса окна),
        // НЕ должна получать очередной элемент очереди на каждый Stop — CLI
        // на исчерпанном лимите отбивает вброс мгновенно, следующий Stop
        // вбрасывает СЛЕДУЮЩИЙ элемент, и вся очередь Ctrl+Q сгорает в стену
        // за секунды, задолго до самого пробуждения (первый элемент, ушедший
        // ДО детекта, этим не спасти — см. отчёт). holdQueueFor — НЕОБЯЗАТЕЛЬНАЯ
        // зависимость (по умолчанию null): без неё — поведение прежнее.
        if (genProven) {
          const held = typeof holdQueueFor === 'function' && holdQueueFor(tab.tabId);
          if (!held) injectQueuedOnStop(tab);
        }
        break;
      case 'PostToolUse':
        // Task 2 фазы 6 (панель диффа): PostToolUse — не сигнал ожидания и не
        // «работает» (это уже сказал PreToolUse чуть раньше), а факт «файлы
        // проекта могли измениться». Статус НЕ трогаем, только даём renderer'у
        // знать, что панели диффа стоит обновиться (см. diffpanel.js — дебаунс
        // 1500мс живёт уже там, не здесь).
        onEvent('git:changed', { tabId });
        break;
      default:
        break; // незнакомые события молча игнорируем — контракт CLI может расти
    }
  }

  // «Пользователь прочитал результат» — вкладка уезжает из «Готово» в
  // «Наготове» (живая приёмка 01.08: «Готово» — список НЕПРОЧИТАННОГО).
  //
  // Решает НЕ ядро, а renderer: только он знает, что сейчас на экране и есть
  // ли у окна фокус (тот же смысл, что у isSuppressed в toasts.js — «смотрит
  // именно на эту вкладку прямо сейчас»). Здесь — узкий гард: трогаем ровно
  // 'done'. Работающую вкладку взгляд не сбивает, ждущую диалога — не
  // «отвечает» за человека, мёртвую не воскрешает.
  function markSeen(tabId) {
    const tab = tabs.get(tabId);
    if (!tab || tab.status !== 'done') return;
    setStatus(tab, 'ready', '');
  }

  // Детект зависания: работа НАД ПОРУЧЕНИЕМ без вывода дольше порога.
  // Зовётся таймером main.
  function checkStuck() {
    const ts = now();
    for (const tab of tabs.values()) {
      // Идле-арминг (Task 6): без единого хук-события «working» не отличить
      // от «терминал просто открыт и стоит у промпта» — честно пропускаем.
      if (!tab.hookActive) continue;
      // Живая приёмка 01.08: и с хуками «working» ещё не значит «работает над
      // моим вопросом» — сессия могла просто запуститься. Молчание считаем
      // зависанием, только пока ждём ответа на поручение (см. awaitingReply).
      if (!tab.awaitingReply) continue;
      if (tab.status === 'working' && tab.proc && ts - tab.lastOutputAt > stuckAfterMs) {
        const min = Math.max(1, Math.round((ts - tab.lastOutputAt) / 60000));
        // Запоминаем, ЧЕМ вкладка была занята («думает…», «Bash…»): когда
        // вывод вернётся, ей нужно вернуть эту подпись, а не оставить
        // «нет вывода» (см. onData в spawn).
        tab.subtitleBeforeStuck = tab.subtitle;
        setStatus(tab, 'stuck', `нет вывода ${min}м`);
      }
    }
  }

  function list() {
    // waitingKind (C1) — нужен обвязке ipc.js, чтобы отличить резюмируемый
    // idle_prompt от блокирующего permission_prompt (resumableTabStatus).
    // gen (M2) — текущее поколение pty вкладки; обвязка передаёт его снимок
    // в nightWatch.onTabStop() на момент детекта, ядро сверяет его же на
    // пробуждении через getTabGen — pty мог смениться (авто-респавн/ручной
    // рестарт в интерактивный пикер сессий) между детектом и пробуждением.
    // sessionLabel (живая приёмка 01.08) — «название» сессии; уходит в
    // манифест воркспейса (workspace-sync.js), чтобы утренние восстановленные
    // вкладки были различимы СРАЗУ, не дожидаясь чтения транскрипта.
    return [...tabs.values()].map(({
      tabId, cwd, name, alive, status, subtitle, sessionId, ghostId, waitingKind, gen, sessionLabel,
    }) => (
      {
        tabId, cwd, name, alive, status, subtitle, sessionId, ghostId, waitingKind, gen, sessionLabel,
      }
    ));
  }

  function disposeAll() {
    for (const tabId of [...tabs.keys()]) close(tabId);
  }

  return {
    open, start, write, resize, restart, close, list, disposeAll,
    bindSession, has, findBySessionId, findUnboundByCwd, applyHookEvent, checkStuck, markSeen,
    enqueue, removeFromQueue, clearQueue, dequeueAll,
  };
}

module.exports = { createSessionManager, STATUSES };
