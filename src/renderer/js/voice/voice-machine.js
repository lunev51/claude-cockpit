'use strict';
import { resolveTranscribeResult } from './voice-guards.js';

// Task 3 фазы 9, ревью финальной волны (I4): конечный автомат push-to-talk,
// вынесенный ОТДЕЛЬНЫМ модулем из app.js — та же самая, уже отревьюженная
// логика трёх предыдущих раундов (C3/N1 — сериализация start()/stop() через
// цепочку промисов + явное состояние 'stopping', C1 — снимок tabId на
// keyup, а не на момент доставки), переехавшая сюда БЕЗ изменения поведения,
// плюс M3 (открытие микрофона по таймеру minHoldMs, а не сразу на keydown).
// Ничего про DOM — все внешние эффекты инжектируются, app.js остаётся
// тонкой привязкой DOM-событий (keydown/keyup/blur/mousedown/wheel) к
// методам машины. Тестируется напрямую через динамический import() с
// фейковым рекордером/таймерами (см. test/voice-machine.test.js).
//
// Состояния: idle → pending → starting → recording → stopping →
// (transcribing → idle | idle).
//   'pending'  — Shift зажат, таймер minHoldMs тикает, микрофон ЕЩЁ НЕ
//                тронут вовсе (M3) — ни getUserMedia, ни AudioContext. Короткое
//                нажатие (печать заглавных буквы Shift+буква) отпускает Shift
//                раньше, чем таймер выстрелит — устройство не мигает, гарнитура
//                не щёлкает, ничего не открывалось и нечего закрывать.
//   'starting' — таймер выстрелил, recorder.start() (getUserMedia + AudioContext
//                + addModule) в полёте — самая долгая асинхронная операция
//                цикла, единственная, где решение по циклу может «опоздать».
//   'recording'— микрофон реально пишет.
//   'stopping' — реальный recorder.stop() в полёте, решение «отправлять на
//                распознавание или отбросить» ещё не принято. КЛЮЧЕВОЕ для N1:
//                state НЕ 'idle' здесь — новая запись не может начаться, пока
//                это состояние не разрешится.
//   'transcribing' — WAV уже ушёл на stt:transcribe, ждём {text}|{error}.
//
// ИНВАРИАНТ (N1, ре-ревью раунда 2, критично — держит вся конструкция):
// requestStart() отклоняет любой вызов, пока state !== 'idle'; ВСЕ обращения
// к recorder.start()/recorder.stop() идут через runOnRecorder — сериализация
// в порядке поступления (тот же приём, что `chain` в src/main/stt.js для
// конкурентных transcribeWav()). Вместе это гарантирует: на recorder в любой
// момент времени выполняется НЕ БОЛЕЕ ОДНОЙ операции, и новая start не
// начинается, пока предыдущая пара start/stop не завершилась ПОЛНОСТЬЮ —
// ни на уровне состояния машины, ни на уровне самого recorder-инстанса.
//
// Инжектируемые зависимости: recorder ({start(), stop()} — VoiceRecorder или
// фейк), transcribe(wav) => Promise<{text}|{error}>, deliver(tabId, decision)
// => void|Promise<void> — decision это ЛИБО {action:'toast', message, level}
// (пусто/ошибка/«микрофон недоступен» — tabId будет null), ЛИБО
// {action:'deliver', text} (см. resolveTranscribeResult, voice-guards.js —
// импортирована напрямую, она чистая и не нуждается в инъекции), indicator(state)
// => void — вызывается на КАЖДЫЙ переход состояния, setTimer(fn, ms) => id /
// clearTimer(id) — тот же контракт, что main/stt.js, ради M3-таймера без
// реальных задержек в тестах, getActiveTabId() => string|null — снимок
// активной вкладки (app.js: () => tabStore.activeId).
//
// `now`, упомянутый ревьюером в списке инжектируемых зависимостей, СОЗНАТЕЛЬНО
// не добавлен: раньше (раунды 1-3) heldMs = now() - keydown сравнивался с
// minHoldMs при ОТПУСКАНИИ — после M3 сам факт «мы дошли до 'starting'»
// ДОКАЗЫВАЕТ, что таймер minHoldMs уже отработал (setTimer гарантирует «не
// раньше», раньше он бы не выстрелил), так что отдельная проверка героя
// длительности стала tautological (всегда true) и была бы мёртвым кодом.
// Единственный оставшийся критерий «было что отправлять» — recorder.stop()
// вернул непустой wav (сам recorder.js отбрасывает < 0.3с, см. recorder.js) —
// M3 явно называет это закрытием долга «heldMs от keydown», а не задачей
// сохранить параллельную проверку.
function createVoiceMachine({
  recorder,
  transcribe,
  deliver,
  indicator,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  getActiveTabId = () => null,
  minHoldMs = 300,
} = {}) {
  let state = 'idle';
  let pendingTimer = null;
  let chain = Promise.resolve();

  function setState(next) {
    state = next;
    indicator(state);
  }

  // Прогоняет fn СТРОГО после того, как предыдущая операция на recorder
  // осела (успехом или ошибкой) — возвращает промис именно этого fn, а не
  // промис всей цепочки, чтобы вызывающий код мог дождаться результата СВОЕЙ
  // операции, не заботясь о чужих.
  function runOnRecorder(fn) {
    const result = chain.then(fn, fn);
    chain = result.catch(() => {});
    return result;
  }

  // keydown ShiftRight (после гарда overlays/activeTab/sttAvailable — тот
  // гард живёт в app.js, resolveStartBlock, voice-guards.js). M3: микрофон
  // НЕ трогаем прямо сейчас — ставим таймер на minHoldMs; если Shift
  // отпустят раньше (requestStop) или отменят (cancel) — таймер снимается,
  // recorder.start() не вызывается вовсе.
  function requestStart() {
    if (state !== 'idle') return;
    setState('pending');
    pendingTimer = setTimer(() => {
      pendingTimer = null;
      beginRealStart();
    }, minHoldMs);
  }

  // Ревью раунда 1/2 (C3, N1, критично): voiceState — 'starting' на время
  // await recorder.start(). Если решение по ЭТОЙ попытке уже принято, пока
  // getUserMedia грузился (requestStop/cancel перевели state в 'stopping'),
  // ОНИ САМИ уже поставили recorder.stop() в ТУ ЖЕ очередь runOnRecorder —
  // он гарантированно выполнится СРАЗУ ПОСЛЕ этого start() (порядок FIFO) и
  // закроет поток, если тот всё-таки успел открыться. Здесь ничего
  // дополнительно закрывать не нужно и НЕЛЬЗЯ трогать state — она уже
  // принадлежит чужому (более позднему) решению.
  async function beginRealStart() {
    setState('starting');
    let started = false;
    try {
      await runOnRecorder(() => recorder.start());
      started = true;
    } catch (err) {
      // тихо — обработка ниже, по факту started=false
    }
    if (state !== 'starting') return;
    if (!started) {
      setState('idle');
      deliver(null, { action: 'toast', message: 'Микрофон недоступен', level: 'error' });
      return;
    }
    setState('recording');
  }

  // keyup ShiftRight — «пользователь закончил диктовать, попробуй отправить».
  // Решение «отправлять или нет» здесь по строгому таймеру-МИКРОФОНА (M3):
  // wav === null (recorder.js сам отбрасывает < 0.3с реального звука) —
  // тихая отмена; иначе — распознавание. app.js решает ВЫЗЫВАТЬ ли эту
  // функцию или cancel() (если во время записи открылся оверлей — тот же
  // исход, что и отмена, но это решение app.js, машина о нём не знает).
  function requestStop() {
    if (state === 'pending') {
      // M3: таймер ещё не выстрелил — микрофон НЕ трогали вовсе, нечего
      // закрывать (короткое нажатие/печать заглавных буквы Shift+буква).
      clearTimer(pendingTimer);
      pendingTimer = null;
      setState('idle');
      return;
    }
    if (state !== 'starting' && state !== 'recording') return;
    // C1 (Critical, ревью финальной волны): снимок активной вкладки ИМЕННО
    // СЕЙЧАС, на момент keyup — а НЕ на момент фактической доставки (после
    // stt:transcribe: до 2×20с подъёма сервера + 60с инференса, с ретраем до
    // ~200с суммарно). Без этого пользователь мог продиктовать в A,
    // переключиться в B, пока горит «🎤 …», и текст+Enter ушёл бы в ЧУЖОЙ
    // проект — тот же принцип, что runRecipe (app.js) резолвит tabId ДО await.
    const tabId = getActiveTabId();
    setState('stopping');
    runOnRecorder(() => recorder.stop()).then((wav) => {
      if (wav) {
        setState('transcribing');
        return transcribeAndDeliver(wav, tabId);
      }
      setState('idle'); // нечего отправлять — recorder.js сам решил, что звука недостаточно
      return undefined;
    }).catch(() => {
      setState('idle');
    });
  }

  // Тихая отмена БЕЗ доставки — используется, когда причина остановки НЕ
  // «пользователь закончил диктовать» (тот случай — requestStop выше), а
  // «это была не диктовка вовсе»: печать другой клавиши во время удержания
  // Shift, смена раскладки/Ctrl-комбинации, потеря фокуса окна, скрытие
  // вкладки браузера, мышь (mousedown/wheel) — штатное выделение в xterm,
  // оверлей, открывшийся во время записи. Результат ВСЕГДА отбрасывается.
  function cancel() {
    if (state === 'pending') {
      clearTimer(pendingTimer);
      pendingTimer = null;
      setState('idle');
      return;
    }
    if (state !== 'starting' && state !== 'recording') return;
    setState('stopping');
    runOnRecorder(() => recorder.stop()).then(() => {
      setState('idle');
    }).catch(() => {
      setState('idle');
    });
  }

  // WAV → main (stt:transcribe) → {text}|{error} → resolveTranscribeResult
  // (voice-guards.js, чистая функция) решает, что дальше — деталь передаётся
  // ЦЕЛИКОМ инжектированному deliver(tabId, decision): тост (пусто/ошибка)
  // или доставка распознанного текста app.js сам решает по полю decision.action.
  async function transcribeAndDeliver(wav, tabId) {
    let result;
    try {
      result = await transcribe(wav);
    } catch (err) {
      // Контракт (preload.js/main/ipc.js, Task 2): stt:transcribe НИКОГДА не
      // reject-ится, ошибки приходят полем {error}. Подстраховка на случай
      // сбоя самого IPC-моста.
      result = { error: err && err.message ? err.message : String(err) };
    }
    setState('idle');
    const decision = resolveTranscribeResult(result);
    await deliver(tabId, decision);
  }

  return {
    requestStart,
    requestStop,
    cancel,
    get state() { return state; },
  };
}

export { createVoiceMachine };
