'use strict';
// «Ночная смена» (Фаза 8): чистое ядро авто-продолжения вкладок после сброса
// 5-часового лимита Claude. Модуль ЧИСТЫЙ — ни Electron, ни fs, ни реального
// таймера внутри: ВСЕ внешние эффекты (клок, таймеры, опрос лимитов, статус
// вкладки, запись в pty, оповещение renderer'а, power-blocker, журнал) —
// инжектируемые зависимости. Тесты дёргают фейковые таймеры руками, без
// реальных ожиданий (node --test).
//
// Жизненный цикл (docs/superpowers/specs/2026-07-29-night-watch-design.md,
// раздел «Жизненный цикл» — источник правды при любой неясности):
//   1. arm() — взвод: armed=true, новый журнал, счётчик сбросов обнулён.
//   2. onTabStop() на каждом Stop-хуке (working→done) — если вкладка встала
//      именно по лимиту (5-часовой процент ≥ порога), кладём её в pending и
//      планируем один таймер на «resetsAt всех pending + запас».
//   3. Ожидание: пока pending непуст и режим взведён — держим power-blocker
//      (не даём системе уснуть, чтобы дождаться сброса).
//   4. Пробуждение по таймеру — контрольный опрос: сброс подтверждён →
//      по очереди (со стаггером) отправляем «продолжай» в живые, не
//      перехваченные пользователем вкладки; не подтверждён → ретраи с
//      потолком; исчерпали — сдаёмся.
//   5. Потолок maxResets — считается ПО ПРОБУЖДЕНИЯМ, а не по вкладкам.
//   6. disarm() — только вручную; снимает таймер ожидания, чистит pending,
//      снимает блокер. Хвост уже запланированного стаггер-прохода НЕ
//      отменяется явно (см. комментарий в disarm()) — сам себя оборвёт
//      (см. generation ниже).
//
// Ядро НИКОГДА не бросает наружу: каждый публичный метод — try/catch,
// сбой пишется в журнал как {type:'internal-error', detail: err.message}.
//
// === ПОКОЛЕНИЕ ВЗВОДА (фикс-раунд 1, Critical 1) ===
// У onTabStop() и doWake() есть await посреди работы (refreshUsage) —
// пока промис висит, пользователь может disarm(), а то и disarm()+arm()
// СНОВА (armed опять true, но это уже ДРУГОЙ взвод с ДРУГИМ, только что
// сброшенным журналом). Проверки одного только `armed` после await
// недостаточно: если между началом await и его резолвом произошёл
// disarm()+arm(), armed на момент проверки снова true, и стейл-результат
// старого взвода (лимит, детектированный ДО disarm) утёк бы в журнал
// НОВОГО взвода как будто это его собственное событие. Аналогично —
// хвост стаггер-цепочки (тонкость 3 брифа): проверка одного `armed`
// не отличает «просто disarm, хвост честно обрывается записью aborted»
// от «disarm+arm, хвост принадлежит уже несуществующему, чужому журналу».
//
// Фикс: монотонный счётчик `generation`, инкрементируемый В arm(), disarm()
// И dispose() — КАЖДЫЙ переход состояния бьёт по нему. Любая асинхронная
// операция фиксирует `gen = generation` до await/до планирования колбэка и
// сверяет `generation` с этим `gen` после. Т.к. arm()/disarm() строго
// чередуются (arm() — no-op, если уже armed; disarm() — no-op, если уже не
// armed), разница `generation - gen`, замеренная у ещё живой (armed на
// момент старта) операции, однозначно говорит:
//   0        — ничего не изменилось, работаем как обычно;
//   1        — случился РОВНО один disarm(), arm() ещё не было — это ТОТ ЖЕ
//              журнал (journal.reset() не звался), можно честно записать
//              {type:'aborted'} — ровно то поведение, которого требует
//              тонкость 3 брифа для простого disarm() посреди цепочки;
//   >=2      — было МИНИМУМ ещё одно arm() — журнал уже ЧУЖОЙ (сброшен под
//              новый взвод) — писать в него о судьбе старого прохода нельзя,
//              тонем молча, не трогая НИКАКОЕ разделяемое состояние текущей
//              (новой) сессии.

const DEFAULT_CONFIG = {
  fiveHourThreshold: 95,
  wakeMarginMs: 60000,
  staggerMs: 10000,
  maxResets: 4,
  retryMs: 300000,
  maxRetries: 3,
};

// Статусы вкладки, при которых «продолжай» отправлять нельзя (спека,
// раздел «Пробуждение»): ждёт ответа на диалог, мертва, либо вкладки уже
// нет вовсе (getTabStatus вернул null). ВАЖНО (Important 5а ревью): это
// СПИСОК ИСКЛЮЧЕНИЙ, не вайтлист — 'done' и 'stuck' (в бою вкладка после
// реального Stop-хука стоит именно в 'done', см. sessions.js) сюда НЕ
// входят и обязаны продолжаться так же, как 'working'.
const NO_RESUME_STATUSES = new Set(['waiting', 'dead']);

function createNightWatch({
  now,
  setTimer,
  clearTimer,
  refreshUsage,
  getTabStatus,
  writeToTab,
  emit,
  powerBlocker,
  journal,
  config,
  getTabGen, // M2 (ревью финальной волны): (tabId) => текущее поколение pty вкладки — НЕОБЯЗАТЕЛЬНАЯ зависимость, см. processResumeTab
}) {
  // Переданный config мержится ПОВЕРХ дефолтов — так же, как config.js
  // мержит оверлей поверх DEFAULTS: пользовательские значения (какие есть)
  // выигрывают, недостающие ключи достраиваются дефолтами.
  const cfg = { ...DEFAULT_CONFIG, ...(config || {}) };

  let armed = false;
  let generation = 0; // см. блок комментариев выше — бьётся в arm()/disarm()/dispose()
  let resetsHandled = 0; // счётчик ПРОБУЖДЕНИЙ за текущий взвод (не вкладок) — потолок maxResets
  // I1(б) (ревью финальной волны): 'cap-reached' — РОВНО ОДНА запись за взвод.
  // Потолок maxResets — норма за ночь (2-3 сброса), а не аномалия: КАЖДЫЙ Stop
  // ЛЮБОЙ вкладки после исчерпания потолка (проба ревьюера — 200 Stop подряд)
  // писал бы отдельную запись+emit(night:changed С ВЕСЬ ЖУРНАЛОМ) без этого
  // флага. Сбрасывается в arm() — новый взвод снова может залогировать потолок.
  let capReachedLogged = false;
  let pending = []; // [{ tabId, detectedAt, resetsAt, gen }] — вкладки, встали по лимиту, ждут сброса; gen — M2 ниже
  const lastInputAt = new Map(); // tabId → now() последнего onUserInput (живёт дольше одного взвода — безвредно, время монотонно растёт)

  let waitTimer = null; // таймер «когда в следующий раз проверить сброс» (ожидание ИЛИ ретрай) — ровно один активный
  let staggerTimer = null; // таймер следующего шага стаггер-цепочки резюма — независим от waitTimer
  let wakeAt = null; // now() запланированного следующего пробуждения — для snapshot()/дашборда, null когда не ждём
  let retries = 0; // счётчик неудачных пробуждений ТЕКУЩЕГО цикла ожидания (сбрасывается на новом цикле и на успехе)
  let wakePassInFlight = false; // true всё время стаггер-прохода резюма — держит power-blocker, даже когда pending уже пуст

  let blockerOn = false; // наше собственное знание «блокер сейчас включён нами» — чтобы не звать start()/stop() на каждый чих (сам powerBlocker идемпотентен, но незачем дёргать лишний раз)

  // Запись в журнал — ts всегда проставляет само ядро (never полагаемся на
  // вызывающий код). Обёрнуто отдельно, чтобы битый журнал (append бросает)
  // не мог уронить ядро — тонем молча, это и есть «деградация к бездействию»
  // из раздела «Обработка ошибок» спеки.
  function appendJournal(entry) {
    try {
      journal.append({ ts: now(), ...entry });
    } catch {
      // журнал сломан — молча проглатываем, ядро не падает из-за диска
    }
  }

  // emit после КАЖДОГО изменения состояния (правило спеки) — снапшот берём
  // прямо перед отправкой, emit сам по себе не должен уронить ядро.
  function emitChange() {
    try {
      emit('night:changed', snapshot());
    } catch {
      // emit — чужая функция (обычно webContents.send); её падение не должно
      // утянуть за собой ядро
    }
  }

  // Единственная точка правды для power-blocker (тонкость 4 брифа): держим
  // блокер, пока режим взведён И (есть что ждать ИЛИ идёт стаггер-проход
  // резюма — pending к этому моменту уже может быть пуст, но система ещё
  // не должна засыпать, пока мы дописываем «продолжай» по вкладкам).
  function updateBlocker() {
    const want = armed && (pending.length > 0 || wakePassInFlight);
    if (want && !blockerOn) {
      powerBlocker.start();
      blockerOn = true;
    } else if (!want && blockerOn) {
      powerBlocker.stop();
      blockerOn = false;
    }
  }

  function stopWaitTimer() {
    if (waitTimer !== null) {
      clearTimer(waitTimer);
      waitTimer = null;
    }
    wakeAt = null;
  }

  // Планирует ЕДИНСТВЕННЫЙ таймер ожидания на абсолютный момент времени
  // (снимает предыдущий, если был) — используется и для «ждём сброса»
  // (onTabStop), и для ретрая (doWake) — оба хотят один и тот же слот.
  function scheduleWaitAt(atMs) {
    stopWaitTimer();
    wakeAt = atMs;
    const delay = Math.max(0, atMs - now());
    waitTimer = setTimer(doWake, delay);
  }

  // === arm/disarm/dispose — здесь и только здесь меняются armed/generation ===

  function arm() {
    try {
      if (armed) return; // повторный вызов — no-op, взвод не начинается заново поверх текущего
      armed = true;
      generation += 1; // новый взвод обесценивает всё, что осталось от предыдущего
      resetsHandled = 0;
      capReachedLogged = false; // I1(б): новый взвод — потолок можно залогировать заново
      pending = [];
      retries = 0;
      wakePassInFlight = false;
      journal.reset();
      appendJournal({ type: 'armed' });
      updateBlocker(); // pending пуст — блокер и так должен быть выключен, но на всякий случай
      emitChange();
    } catch (err) {
      appendJournal({ type: 'internal-error', detail: err && err.message });
      emitChange();
    }
  }

  function disarm() {
    try {
      if (!armed) return; // симметрично arm(): повторный вызов не плодит лишних записей в журнале
      armed = false;
      generation += 1; // обесценивает зависшие await'ы (onTabStop/doWake) и «метит» хвост стаггера как «поколение N»
      stopWaitTimer(); // «снять таймер» — единственный таймер ожидания/ретрая
      pending = [];
      // ВАЖНО (тонкость 3 брифа): staggerTimer НЕ трогаем/не отменяем здесь.
      // Если сейчас идёт стаггер-проход резюма, его собственный колбэк сам
      // увидит смену generation на следующем тике и либо честно запишет
      // {type:'aborted'} (если arm() с тех пор не звался — см. runStagger),
      // либо, если пользователь успел ре-армить до того, как хвост
      // выстрелил, промолчит вовсе (чужой, уже сброшенный журнал). Если бы
      // мы явно сняли этот таймер (clearTimer) отсюда, колбэк вообще не
      // выстрелил бы, и в простом случае (без ре-арма) запись 'aborted'
      // никогда не попала бы в журнал. dispose() — другое дело (см. ниже).
      updateBlocker(); // armed:false → want всегда false → снимет блокер, если был включён
      appendJournal({ type: 'disarmed' });
      emitChange();
    } catch (err) {
      appendJournal({ type: 'internal-error', detail: err && err.message });
      emitChange();
    }
  }

  function isArmed() {
    try {
      return armed;
    } catch (err) {
      appendJournal({ type: 'internal-error', detail: err && err.message });
      emitChange();
      return false;
    }
  }

  // === детект остановки по лимиту ===

  // ptyGen (M2, ревью финальной волны) — поколение pty вкладки НА МОМЕНТ
  // детекта, для последующего сравнения с текущим на пробуждении (см.
  // processResumeTab/getTabGen). ВАЖНО: названо НЕ `gen` — ниже по функции
  // уже есть `const gen = generation` (поколение ВЗВОДА, Critical 1,
  // отревьюженный в Task 1 приём анти-гонки disarm/arm) в отдельном блоке
  // `try{}` — те же имена в разных блок-скоупах JS МОЛЧА разрешил бы затенение
  // без единой синтаксической ошибки, и pending получил бы номер поколения
  // ВЗВОДА вместо поколения PTY (найдено живым прогоном тестов при разработке
  // этого фикса — история сохранена как урок, не гипотеза).
  async function onTabStop(tabId, prevStatus, ptyGen) {
    try {
      // Гарды по порядку (буквально из брифа) — первый несовпавший тихо
      // выходит, кроме явно указанных случаев с записью в журнал.
      if (!armed) return;
      if (prevStatus !== 'working') return;
      if (resetsHandled >= cfg.maxResets) {
        // I1(б): один раз за взвод — см. объявление capReachedLogged выше.
        if (!capReachedLogged) {
          capReachedLogged = true;
          appendJournal({ type: 'cap-reached', tabId });
          emitChange();
        }
        return;
      }
      if (pending.some((p) => p.tabId === tabId)) return; // уже ждём эту же вкладку — не плодим дубль (быстрый путь, без похода в refreshUsage)

      const gen = generation; // Critical 1: фиксируем поколение взвода ДО await

      let usage;
      let rejected = false;
      try {
        usage = await refreshUsage();
      } catch {
        rejected = true; // отдельно от ok:false — разные записи в журнале ниже
      }

      // Critical 1 (заменяет старую проверку одного лишь armed): поколение
      // сменилось, пока ждали (disarm, или disarm+arm, или dispose) — эта
      // работа СТАРОГО взвода больше не в счёт. Молчим безусловно: даже
      // «просто disarm без rearm» здесь не пишет ничего — так же, как и
      // раньше (тест «disarm во время await → после резолва ничего не
      // происходит» не ждёт никакой записи, в отличие от стаггер-хвоста,
      // у которого есть явное 'aborted' — см. runStagger).
      if (generation !== gen) return;

      if (rejected) {
        appendJournal({ type: 'usage-error', tabId });
        emitChange();
        return;
      }
      // Critical 2: битые/протухшие данные (!ok) И устаревший кэш поллера
      // (stale:true — реальный процент мог уже быть совсем другим, пока
      // токен обновлялся) трактуем ОДИНАКОВО консервативно — ложное
      // «продолжай» хуже пропущенного детекта.
      if (!usage || !usage.ok || usage.stale) {
        appendJournal({ type: 'no-usage-data', tabId });
        emitChange();
        return;
      }
      if (!usage.fiveHour || usage.fiveHour.percent < cfg.fiveHourThreshold) {
        return; // обычное завершение задачи — тишина, никакой записи (Minor 1: и никакой проверки недельного лимита тоже)
      }
      // Minor 1: недельный лимит проверяем ТОЛЬКО внутри ветки «пятичасовой
      // тоже упёрся в порог» (было — независимо от fiveHour, засоряя журнал
      // на КАЖДОМ обычном завершении задачи при sevenDay>=99).
      if (usage.sevenDay && usage.sevenDay.percent >= 99) {
        appendJournal({ type: 'weekly-limit', tabId });
        emitChange();
        return;
      }
      if (usage.fiveHour.resetsAt == null) {
        appendJournal({ type: 'no-resets-at', tabId });
        emitChange();
        return;
      }
      // Critical 2, доп. санити-гард: resetsAt из уже устаревших (но
      // формально ok:true, stale:false — например, часы разошлись) данных
      // может оказаться в прошлом. Планировать пробуждение «в прошлое»
      // означало бы, что scheduleWaitAt тут же выстрелит немедленно —
      // честнее сразу отказаться от детекта, как от «нечем планировать».
      // N2 (ре-ревью раунда 1): сравниваем МОМЕНТ ПРОБУЖДЕНИЯ (resetsAt +
      // wakeMarginMs) с now(), а не сам resetsAt — иначе секундное
      // расхождение часов клиент/сервер (resetsAt «только что в прошлом»)
      // молча выбрасывало бы честный детект, и вкладка не продолжилась бы
      // за ночь, хотя будильник на now()+почти-минута полностью рабочий.
      if (usage.fiveHour.resetsAt + cfg.wakeMarginMs <= now()) {
        appendJournal({ type: 'no-resets-at', tabId, detail: 'resets-at-in-past' });
        emitChange();
        return;
      }
      // Important 1: гонка двух конкурентных Stop одной и той же вкладки —
      // оба могли пройти самый первый (синхронный) дубль-гард выше ДО того,
      // как хоть один из них допишет в pending (оба ещё видели pending
      // пустым/без этого tabId на момент своего входа). Перепроверяем
      // ПРЯМО ПЕРЕД мутацией pending — единственное место, где дубль
      // реально мог бы возникнуть.
      if (pending.some((p) => p.tabId === tabId)) return;

      // Это остановка по лимиту. Если pending был пуст — начинается новый
      // цикл ожидания, старые ретраи прошлого (уже завершившегося) цикла в
      // счёт не идут.
      if (pending.length === 0) retries = 0;
      // M2 (ревью финальной волны): pending.gen — поколение PTY вкладки НА
      // МОМЕНТ детекта (может быть undefined — вызывающий код необязан его
      // передавать, тогда gen-проверка на пробуждении просто пропускается,
      // см. processResumeTab). Явно `gen: ptyGen`, а НЕ shorthand `{ptyGen}` —
      // имя поля в pending исторически `gen` (читается в processResumeTab как
      // entry.gen), а параметр функции переименован в ptyGen ИМЕННО чтобы не
      // затереть локальный `const gen = generation` (взвод) чуть выше по
      // этому же try-блоку — см. комментарий у сигнатуры onTabStop.
      pending.push({
        tabId, detectedAt: now(), resetsAt: usage.fiveHour.resetsAt, gen: ptyGen,
      });
      appendJournal({ type: 'limit-stop', tabId, detail: String(usage.fiveHour.resetsAt) });

      // Один таймер на максимум resetsAt среди ВСЕХ pending (окно общее) + запас.
      const maxResetsAt = pending.reduce((m, p) => Math.max(m, p.resetsAt), -Infinity);
      scheduleWaitAt(maxResetsAt + cfg.wakeMarginMs);

      updateBlocker();
      emitChange();
    } catch (err) {
      appendJournal({ type: 'internal-error', detail: err && err.message });
      emitChange();
    }
  }

  function onUserInput(tabId) {
    try {
      // Дёшево и всегда, даже не armed — история ввода нужна на момент
      // будущего детекта, который может случиться уже после arm().
      lastInputAt.set(tabId, now());
    } catch (err) {
      appendJournal({ type: 'internal-error', detail: err && err.message });
      emitChange();
    }
  }

  // === пробуждение по таймеру ===

  // Обрабатывает ОДНУ вкладку стаггер-прохода и возвращает true, если в неё
  // реально ушло «продолжай» (для счётчика «N of M» в wake-complete).
  function processResumeTab(entry) {
    // M2 (ревью финальной волны): между детектом и пробуждением pty вкладки
    // мог смениться — авто-респавн (провал резюма, sessions.js) поднимает
    // НОВУЮ, контекстно ПУСТУЮ сессию; ручной Ctrl+Shift+R без известного
    // sessionId открывает интерактивный ПИКЕР сессий Claude Code, где голый
    // Enter (наше «продолжай\r») выбирает ПРОИЗВОЛЬНУЮ строку меню — резюм в
    // такую вкладку хуже пропущенного. getTabGen — НЕОБЯЗАТЕЛЬНАЯ зависимость
    // (нет её вовсе, либо entry.gen не был передан в onTabStop() вызывающим
    // кодом, — gen:undefined) → проверка просто пропускается, поведение
    // прежнее (бэкомпат с уже отревьюженным Task 1).
    if (typeof getTabGen === 'function' && entry.gen !== undefined) {
      const currentGen = getTabGen(entry.tabId);
      if (currentGen !== entry.gen) {
        appendJournal({ type: 'skipped', tabId: entry.tabId, detail: 'pty-restarted' });
        return false;
      }
    }
    const status = getTabStatus(entry.tabId);
    if (status == null || NO_RESUME_STATUSES.has(status)) {
      appendJournal({ type: 'skipped', tabId: entry.tabId, detail: `status:${status}` });
      return false;
    }
    // Тонкость 2 брифа: пропуск, только если ввод был ПОСЛЕ детекта (успел
    // перехватить вкладку уже после остановки). Ввод ДО детекта — обычная
    // история работы, не причина отменять продолжение.
    const inputAt = lastInputAt.get(entry.tabId);
    if (typeof inputAt === 'number' && inputAt > entry.detectedAt) {
      appendJournal({ type: 'skipped', tabId: entry.tabId, detail: 'user-took-over' });
      return false;
    }
    writeToTab(entry.tabId, 'продолжай');
    appendJournal({ type: 'resumed', tabId: entry.tabId });
    return true;
  }

  // Стаггер-цепочка (тонкость 3 брифа): первая вкладка — сразу (синхронно
  // внутри этого же вызова), следующие — через setTimer(staggerMs), одна за
  // другой. `gen` — поколение взвода НА МОМЕНТ, когда стартовал ЭТОТ
  // стаггер-проход (передано из doWake, где сброс был подтверждён) —
  // прокидывается по всей цепочке рекурсивных вызовов НЕИЗМЕННЫМ (не
  // перечитывается из текущего generation), чтобы отличить «работаем как
  // обычно» от «поколение сменилось, пока цепочка спала между тиками» на
  // КАЖДОМ шаге, включая самый первый. Статус вкладки читаем именно тут, в
  // момент выстрела — не при планировании.
  //
  // Обёрнута в try/catch целиком: вызывается не только синхронно из doWake
  // (там уже есть свой try/catch), но и позже — как самостоятельный колбэк
  // таймера — где чужого try/catch над ней уже нет.
  function runStagger(list, index, total, resumedCount, gen) {
    try {
      const delta = generation - gen; // Critical 1 — см. блок комментариев в шапке файла
      if (delta !== 0) {
        if (delta === 1) {
          // Ровно один disarm() с тех пор — journal.reset() не звался
          // (arm() ещё не было), это ТОТ ЖЕ журнал — честно фиксируем обрыв.
          appendJournal({ type: 'aborted' });
          wakePassInFlight = false;
          updateBlocker();
          emitChange();
        }
        // delta >= 2: было минимум ещё одно arm() — журнал уже ЧУЖОЙ
        // (принадлежит следующему взводу). Молчим безусловно и НЕ трогаем
        // pending/wakePassInFlight/блокер — это уже состояние НОВОЙ сессии,
        // которое ей не принадлежит менять постороннему, давно неактуальному
        // колбэку.
        return;
      }
      if (total === 0) {
        wakePassInFlight = false;
        appendJournal({ type: 'wake-complete', detail: '0 of 0' });
        updateBlocker();
        emitChange();
        return;
      }
      const entry = list[index];
      const didResume = processResumeTab(entry);
      const newCount = resumedCount + (didResume ? 1 : 0);
      emitChange();

      if (index + 1 < total) {
        // N1 (ре-ревью раунда 1): замыкание обнуляет staggerTimer ТОЛЬКО
        // если это всё ещё его собственный дескриптор — хвост прошлого
        // взвода (переживший disarm→arm) иначе затирал бы живой хендл
        // НОВОГО прохода, и dispose() тот таймер уже не снял бы.
        const id = setTimer(() => {
          if (staggerTimer === id) staggerTimer = null;
          runStagger(list, index + 1, total, newCount, gen);
        }, cfg.staggerMs);
        staggerTimer = id;
      } else {
        wakePassInFlight = false;
        appendJournal({ type: 'wake-complete', detail: `${newCount} of ${total}` });
        updateBlocker();
        emitChange();
      }
    } catch (err) {
      // Important 2: исключение (например, writeToTab бросил — мёртвый pty)
      // не должно залипать power-blocker навсегда — явно гасим
      // wakePassInFlight и пересчитываем блокер ДО записи/emit, а не только
      // логируем ошибку.
      appendJournal({ type: 'internal-error', detail: err && err.message });
      wakePassInFlight = false;
      updateBlocker();
      emitChange();
    }
  }

  // Контрольный опрос лимитов по будильнику (ожидание ИЛИ ретрай — одна и
  // та же функция обслуживает оба случая, т.к. это один и тот же
  // «следующий момент проверки»).
  async function doWake() {
    waitTimer = null;
    wakeAt = null;
    const gen = generation; // Critical 1: поколение на момент старта ЭТОГО пробуждения
    try {
      let usage;
      try {
        usage = await refreshUsage();
      } catch {
        usage = null;
      }

      // Critical 1: поколение сменилось за время await — молчим (та же
      // логика, что в onTabStop; конкретно про хвост стаггера заботится
      // runStagger, которому gen передаётся ниже).
      if (generation !== gen) return;

      // Critical 2: stale:true НЕ считаем подтверждённым сбросом окна, даже
      // если процент в кэше уже ниже порога — это цифры из прошлого,
      // токен/сеть могли всё ещё не восстановиться. Уходим в обычный ретрай.
      const windowReset = !!(usage && usage.ok && !usage.stale
        && usage.fiveHour && usage.fiveHour.percent < cfg.fiveHourThreshold);

      // N1 (ре-ревью финальной волны): forget() мог опустошить pending, пока
      // мы висели на await refreshUsage (пользователь закрыл последнюю
      // ждущую вкладку ровно во время сетевого запроса). Без этого гарда
      // ретрай-ветка ниже крутила бы фантомные повторы при пустом pending, а
      // ветка сброса — сожгла бы слот maxResets на «wake-complete: 0 of 0».
      // Тот же фантом, что чинил N3 раунда 1, — forget() открыл ему второй
      // вход.
      if (pending.length === 0) {
        stopWaitTimer();
        updateBlocker();
        emitChange();
        return;
      }

      if (windowReset) {
        // N3 (ре-ревью раунда 1): конкурентный детект, дорезолвившийся во
        // время НАШЕГО await выше, мог успеть добавиться в pending И
        // поставить свой waitTimer. Его вкладку заберёт текущий проход
        // (list ниже), а вот его будильник без этой строки остался бы жить:
        // выстрелил бы позже с пустым pending, сжёг слот maxResets и записал
        // фантомный «wake-complete: 0 of 0».
        stopWaitTimer();
        resetsHandled += 1; // потолок считается по пробуждениям, не по вкладкам (тонкость 5 брифа)
        retries = 0;
        wakePassInFlight = true; // держит блокер весь стаггер-проход, даже когда pending уже опустошён ниже
        const list = pending;
        pending = [];
        updateBlocker();
        emitChange();
        runStagger(list, 0, list.length, 0, gen);
      } else {
        retries += 1;
        // Minor 2: перечисляем tabId зависших вкладок в detail — утренний
        // отчёт должен показывать, КАКИЕ вкладки всё ещё ждут, а не только
        // порядковый номер попытки.
        const tabIds = pending.map((p) => p.tabId).join(', ');
        if (retries <= cfg.maxRetries) {
          appendJournal({ type: 'retry', detail: `${retries} (${tabIds})` });
          scheduleWaitAt(now() + cfg.retryMs);
          emitChange();
        } else {
          appendJournal({ type: 'gave-up', detail: tabIds });
          pending = [];
          updateBlocker();
          emitChange();
        }
      }
    } catch (err) {
      appendJournal({ type: 'internal-error', detail: err && err.message });
      emitChange();
    }
  }

  // I3 (ревью финальной волны): синхронный предикат «вкладка сейчас ждёт
  // сброса окна» — sessions.js прокидывает его как необязательную
  // holdQueueFor(tabId), чтобы НЕ вбрасывать элемент очереди Ctrl+Q в
  // вкладку, встретившую Stop на исчерпанном лимите (CLI отбивает вброс
  // мгновенно — вся очередь сгорела бы за секунды до самого пробуждения).
  // Никогда не бросает и не пишет в журнал — чистый читающий запрос, не
  // событие; вызывается потенциально на КАЖДОМ Stop любой вкладки.
  function isPending(tabId) {
    try {
      return pending.some((p) => p.tabId === tabId);
    } catch {
      return false;
    }
  }

  // M1+M3 (ревью финальной волны): закрытие вкладки, которая ждёт сброса —
  // резюм в закрытую вкладку (writeToTab на несуществующий pty) бесполезен, а
  // будильник/блокер, ждущие ТОЛЬКО эту вкладку, не должны продолжать ждать
  // впустую до конца цикла ретраев. Вызывается из ipc.js на 'tabs:close',
  // рядом с lastStatusByTab.delete(tabId). No-op (без журнала/emit), если
  // вкладка вообще не была в pending, — иначе КАЖДОЕ обычное закрытие любой
  // вкладки штамповало бы запись в журнал ночной смены, даже когда режим и
  // не думал об этой вкладке.
  function forget(tabId) {
    try {
      lastInputAt.delete(tabId); // история ввода закрытой вкладки больше не нужна никогда
      const wasPending = pending.some((p) => p.tabId === tabId);
      if (!wasPending) return;
      pending = pending.filter((p) => p.tabId !== tabId);
      appendJournal({ type: 'tab-closed', tabId });
      if (pending.length === 0) {
        // Нечего больше ждать — снимаем таймер ожидания/ретрая (stopWaitTimer
        // безопасен и когда waitTimer уже null, например во время
        // стаггер-прохода — тогда wakePassInFlight держит блокер сам по себе).
        stopWaitTimer();
        retries = 0;
      }
      updateBlocker();
      emitChange();
    } catch (err) {
      appendJournal({ type: 'internal-error', detail: err && err.message });
      emitChange();
    }
  }

  // === снимок и завершение ===

  function snapshot() {
    try {
      let journalCopy;
      try {
        // Копируем не только массив, но и КАЖДУЮ запись — инжектированный
        // journal.readAll() вполне может отдавать прямые ссылки на свои
        // внутренние объекты (как и делает fake в тестах); без поэлементного
        // клонирования мутация снаружи (snap.journal[0].type = ...) портила
        // бы настоящий журнал ядра (тонкость 6 брифа).
        journalCopy = journal.readAll().map((e) => ({ ...e }));
      } catch {
        journalCopy = [];
      }
      return {
        armed,
        pendingCount: pending.length,
        wakeAt,
        resetsHandled,
        journal: journalCopy,
      };
    } catch {
      // Даже тут не бросаем — отдаём заведомо безопасный «пустой» снимок.
      return {
        armed: false, pendingCount: 0, wakeAt: null, resetsHandled: 0, journal: [],
      };
    }
  }

  function dispose() {
    try {
      // В отличие от disarm() — здесь снимаем ВСЕ таймеры без исключения
      // (включая хвост стаггера): это финальная остановка (тесты/quit
      // приложения), а не штатный переход состояния, так что запись
      // 'aborted' тут не нужна и не появится.
      stopWaitTimer();
      if (staggerTimer !== null) {
        clearTimer(staggerTimer);
        staggerTimer = null;
      }
      powerBlocker.stop();
      blockerOn = false;
      // Important 3: синхронное состояние тоже гасим — до этого фикса
      // armed/pending переживали dispose(), и isArmed()/snapshot() продолжали
      // врать «всё ещё взведено» после закрытия приложения; а любой
      // повисший на await onTabStop, резолвнувшись уже ПОСЛЕ dispose(),
      // заново поднимал таймер и powerSaveBlocker на выходе из процесса.
      armed = false;
      pending = [];
      generation += 1; // обесценивает любую операцию (onTabStop/doWake), запущенную ДО dispose() и ещё не резолвнувшуюся
    } catch (err) {
      appendJournal({ type: 'internal-error', detail: err && err.message });
      emitChange();
    }
  }

  return {
    arm, disarm, isArmed, onTabStop, onUserInput, snapshot, dispose, isPending, forget,
  };
}

module.exports = { createNightWatch };
