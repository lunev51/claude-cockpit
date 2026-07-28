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
//      отменяется явно (см. комментарий в disarm()) — сам себя оборвёт.
//
// Ядро НИКОГДА не бросает наружу: каждый публичный метод — try/catch,
// сбой пишется в журнал как {type:'internal-error', detail: err.message}.

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
// нет вовсе (getTabStatus вернул null).
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
}) {
  // Переданный config мержится ПОВЕРХ дефолтов — так же, как config.js
  // мержит оверлей поверх DEFAULTS: пользовательские значения (какие есть)
  // выигрывают, недостающие ключи достраиваются дефолтами.
  const cfg = { ...DEFAULT_CONFIG, ...(config || {}) };

  let armed = false;
  let resetsHandled = 0; // счётчик ПРОБУЖДЕНИЙ за текущий взвод (не вкладок) — потолок maxResets
  let pending = []; // [{ tabId, detectedAt, resetsAt }] — вкладки, встали по лимиту, ждут сброса
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

  // === arm/disarm — единственные два места, меняющие armed ===

  function arm() {
    try {
      if (armed) return; // повторный вызов — no-op, взвод не начинается заново поверх текущего
      armed = true;
      resetsHandled = 0;
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
      stopWaitTimer(); // «снять таймер» — единственный таймер ожидания/ретрая
      pending = [];
      // ВАЖНО (тонкость 3 брифа): staggerTimer НЕ трогаем/не отменяем здесь.
      // Если сейчас идёт стаггер-проход резюма, его собственный колбэк сам
      // увидит armed:false на следующем тике, запишет {type:'aborted'} и
      // сам сбросит wakePassInFlight — если бы мы явно сняли этот таймер
      // (clearTimer) отсюда, колбэк вообще не выстрелил бы и запись
      // 'aborted' никогда не попала бы в журнал. dispose() — другое дело
      // (там действительно снимаем ВСЕ таймеры, см. ниже).
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

  async function onTabStop(tabId, prevStatus) {
    try {
      // Гарды по порядку (буквально из брифа) — первый несовпавший тихо
      // выходит, кроме явно указанных случаев с записью в журнал.
      if (!armed) return;
      if (prevStatus !== 'working') return;
      if (resetsHandled >= cfg.maxResets) {
        appendJournal({ type: 'cap-reached', tabId });
        emitChange();
        return;
      }
      if (pending.some((p) => p.tabId === tabId)) return; // уже ждём эту же вкладку — не плодим дубль

      let usage;
      let rejected = false;
      try {
        usage = await refreshUsage();
      } catch {
        rejected = true; // отдельно от ok:false — разные записи в журнале ниже
      }

      // Тонкость 1 брифа: ПОСЛЕ await ОБЯЗАТЕЛЬНО перепроверяем armed —
      // пользователь мог disarm-нуть, пока промис висел. Если разоружили —
      // ничего не происходит вообще, даже журнал не трогаем.
      if (!armed) return;

      if (rejected) {
        appendJournal({ type: 'usage-error', tabId });
        emitChange();
        return;
      }
      if (!usage || !usage.ok) {
        appendJournal({ type: 'no-usage-data', tabId });
        emitChange();
        return;
      }
      if (usage.sevenDay && usage.sevenDay.percent >= 99) {
        appendJournal({ type: 'weekly-limit', tabId });
        emitChange();
        return;
      }
      if (!usage.fiveHour || usage.fiveHour.percent < cfg.fiveHourThreshold) {
        return; // обычное завершение задачи — тишина, никакой записи
      }
      if (usage.fiveHour.resetsAt == null) {
        appendJournal({ type: 'no-resets-at', tabId });
        emitChange();
        return;
      }

      // Это остановка по лимиту. Если pending был пуст — начинается новый
      // цикл ожидания, старые ретраи прошлого (уже завершившегося) цикла в
      // счёт не идут.
      if (pending.length === 0) retries = 0;
      pending.push({ tabId, detectedAt: now(), resetsAt: usage.fiveHour.resetsAt });
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
  // другой. На КАЖДОМ шаге (включая самый первый) проверяем armed заново —
  // если режим успели выключить посреди цепочки, хвост не стреляет вовсе:
  // записываем {type:'aborted'} и обрываемся. Статус вкладки читаем именно
  // тут, в момент выстрела — не при планировании.
  //
  // Обёрнута в try/catch целиком: вызывается не только синхронно из doWake
  // (там уже есть свой try/catch), но и позже — как самостоятельный колбэк
  // таймера — где чужого try/catch над ней уже нет.
  function runStagger(list, index, total, resumedCount) {
    try {
      if (!armed) {
        appendJournal({ type: 'aborted' });
        wakePassInFlight = false;
        updateBlocker();
        emitChange();
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
        staggerTimer = setTimer(() => {
          staggerTimer = null;
          runStagger(list, index + 1, total, newCount);
        }, cfg.staggerMs);
      } else {
        wakePassInFlight = false;
        appendJournal({ type: 'wake-complete', detail: `${newCount} of ${total}` });
        updateBlocker();
        emitChange();
      }
    } catch (err) {
      appendJournal({ type: 'internal-error', detail: err && err.message });
      emitChange();
    }
  }

  // Контрольный опрос лимитов по будильнику (ожидание ИЛИ ретрай — одна и
  // та же функция обслуживает оба случая, т.к. это один и тот же
  // «следующий момент проверки»).
  async function doWake() {
    waitTimer = null;
    wakeAt = null;
    try {
      let usage;
      try {
        usage = await refreshUsage();
      } catch {
        usage = null;
      }

      // Тонкость 1 брифа применима и здесь: перепроверяем armed сразу после await.
      if (!armed) return;

      const windowReset = !!(usage && usage.ok && usage.fiveHour && usage.fiveHour.percent < cfg.fiveHourThreshold);

      if (windowReset) {
        resetsHandled += 1; // потолок считается по пробуждениям, не по вкладкам (тонкость 5 брифа)
        retries = 0;
        wakePassInFlight = true; // держит блокер весь стаггер-проход, даже когда pending уже опустошён ниже
        const list = pending;
        pending = [];
        updateBlocker();
        emitChange();
        runStagger(list, 0, list.length, 0);
      } else {
        retries += 1;
        if (retries <= cfg.maxRetries) {
          appendJournal({ type: 'retry', detail: String(retries) });
          scheduleWaitAt(now() + cfg.retryMs);
          emitChange();
        } else {
          appendJournal({ type: 'gave-up' });
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
    } catch (err) {
      appendJournal({ type: 'internal-error', detail: err && err.message });
      emitChange();
    }
  }

  return {
    arm, disarm, isArmed, onTabStop, onUserInput, snapshot, dispose,
  };
}

module.exports = { createNightWatch };
