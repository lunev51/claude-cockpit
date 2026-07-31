'use strict';
// Task 3 фазы 9, ревью финальной волны (I4): конечный автомат push-to-talk
// (src/renderer/js/voice/voice-machine.js) — самая гоночная часть ветки
// (пережила C3/N1 трёх раундов ревью), раньше проверенная только зондами
// ревьюеров, не попавшими в репозиторий. Тест — CommonJS (node --test) с
// динамическим import() внутри async-теста, тот же мост, что
// test/night-format.test.js/test/voice-guards.test.js. Фейковый recorder —
// управляемые вручную промисы (deferred), фейковый setTimer/clearTimer —
// без единой секунды реального ожидания (тот же приём, что main/stt.js).

const test = require('node:test');
const assert = require('node:assert');

// Промис, чьи resolve/reject управляются извне — recorder.start()/stop()
// в реальности асинхронны (getUserMedia/AudioContext.close()), тесты должны
// уметь держать их «в полёте» произвольно долго, чтобы проверять гонки.
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makeFakeRecorder() {
  const calls = []; // {op: 'start'|'stop'} — в порядке РЕАЛЬНОГО вызова (после сериализации)
  let startDef = null;
  let stopDef = null;
  return {
    recorder: {
      start() {
        calls.push({ op: 'start' });
        startDef = deferred();
        return startDef.promise;
      },
      stop() {
        calls.push({ op: 'stop' });
        stopDef = deferred();
        return stopDef.promise;
      },
    },
    calls,
    resolveStart: () => startDef.resolve(),
    rejectStart: (err) => startDef.reject(err),
    resolveStop: (wav) => stopDef.resolve(wav),
  };
}

function makeFakeTimer() {
  const pending = []; // {id, fn}
  let nextId = 1;
  return {
    setTimer: (fn) => {
      const id = nextId++;
      pending.push({ id, fn });
      return id;
    },
    clearTimer: (id) => {
      const idx = pending.findIndex((t) => t.id === id);
      if (idx !== -1) pending.splice(idx, 1);
    },
    // Имитирует «minHoldMs истёк» — вызывает ВСЕ текущие отложенные fn (в
    // норме — ровно один, сам pendingTimer requestStart()).
    fireAll: () => {
      const toFire = pending.splice(0, pending.length);
      for (const t of toFire) t.fn();
    },
    pendingCount: () => pending.length,
  };
}

// Сериализация (chain.then внутри runOnRecorder) откладывает РЕАЛЬНЫЙ вызов
// recorder.start()/stop() минимум на один микротаск после того, как fn был
// поставлен в очередь — flush() прогоняет несколько тиков event loop'а,
// чтобы дать цепочке промисов и async-функциям машины продвинуться до
// следующей точки ожидания, прежде чем тест проверяет результат.
function flush(times = 5) {
  let p = Promise.resolve();
  for (let i = 0; i < times; i += 1) {
    p = p.then(() => new Promise((r) => { setTimeout(r, 0); }));
  }
  return p;
}

async function makeHarness(createVoiceMachine, overrides = {}) {
  const fakeRecorder = makeFakeRecorder();
  const fakeTimer = makeFakeTimer();
  const indicatorCalls = [];
  const deliverCalls = [];
  let activeTabId = 'tab-A';
  let transcribeImpl = async () => ({ text: 'привет мир' });

  const machine = createVoiceMachine({
    recorder: fakeRecorder.recorder,
    transcribe: (wav) => transcribeImpl(wav),
    deliver: (tabId, decision) => {
      deliverCalls.push({ tabId, decision });
    },
    indicator: (state) => indicatorCalls.push(state),
    setTimer: fakeTimer.setTimer,
    clearTimer: fakeTimer.clearTimer,
    getActiveTabId: () => activeTabId,
    minHoldMs: 300,
    ...overrides,
  });

  return {
    machine,
    fakeRecorder,
    fakeTimer,
    indicatorCalls,
    deliverCalls,
    flush,
    setActiveTabId: (id) => { activeTabId = id; },
    setTranscribeImpl: (fn) => { transcribeImpl = fn; },
  };
}

// --- Короткое нажатие (M3: микрофон не тронут вовсе) ---

test('тап-отпустил-тап 150мс (keyup ДО истечения minHoldMs) — recorder.start()/stop() не вызываются вовсе (M3)', async () => {
  const { createVoiceMachine } = await import('../src/renderer/js/voice/voice-machine.js');
  const h = await makeHarness(createVoiceMachine);
  h.machine.requestStart();
  assert.strictEqual(h.machine.state, 'pending');
  h.machine.requestStop(); // keyup до того, как таймер minHoldMs выстрелил
  assert.strictEqual(h.machine.state, 'idle');
  assert.strictEqual(h.fakeRecorder.calls.length, 0, 'микрофон не должен был открываться вовсе');
  assert.strictEqual(h.fakeTimer.pendingCount(), 0, 'таймер должен быть снят (clearTimer)');
  assert.deepStrictEqual(h.indicatorCalls, ['pending', 'idle']);
});

test('тройной короткий тап подряд — каждый раз чисто возвращается в idle, микрофон ни разу не тронут', async () => {
  const { createVoiceMachine } = await import('../src/renderer/js/voice/voice-machine.js');
  const h = await makeHarness(createVoiceMachine);
  for (let i = 0; i < 3; i += 1) {
    h.machine.requestStart();
    assert.strictEqual(h.machine.state, 'pending');
    h.machine.requestStop();
    assert.strictEqual(h.machine.state, 'idle');
  }
  assert.strictEqual(h.fakeRecorder.calls.length, 0);
});

test('cancel() во время pending (посторонний keydown/мышь/blur ДО истечения таймера) — тот же тихий возврат в idle', async () => {
  const { createVoiceMachine } = await import('../src/renderer/js/voice/voice-machine.js');
  const h = await makeHarness(createVoiceMachine);
  h.machine.requestStart();
  h.machine.cancel();
  assert.strictEqual(h.machine.state, 'idle');
  assert.strictEqual(h.fakeRecorder.calls.length, 0);
  assert.strictEqual(h.fakeTimer.pendingCount(), 0);
});

// --- N1/C3: keyup до резолва start(), сериализация на recorder ---

test('keyup приходит ДО резолва recorder.start() — запись останавливается корректно без доставки, вторая (stop) операция ждёт первую (start)', async () => {
  const { createVoiceMachine } = await import('../src/renderer/js/voice/voice-machine.js');
  const h = await makeHarness(createVoiceMachine);
  h.machine.requestStart();
  h.fakeTimer.fireAll(); // minHoldMs истёк — beginRealStart() зовёт recorder.start()
  assert.strictEqual(h.machine.state, 'starting');
  await h.flush();
  assert.strictEqual(h.fakeRecorder.calls.length, 1);
  assert.strictEqual(h.fakeRecorder.calls[0].op, 'start');

  h.machine.requestStop(); // keyup, пока recorder.start() ЕЩЁ НЕ разрешился
  assert.strictEqual(h.machine.state, 'stopping');
  assert.strictEqual(h.fakeRecorder.calls.length, 1, 'stop ещё не должен был реально вызваться — ждёт своей очереди за start()');

  h.fakeRecorder.resolveStart(); // getUserMedia наконец разрешился
  await h.flush();
  // N1 (сериализация): stop выполняется РЕАЛЬНО только теперь, СРАЗУ после start
  assert.strictEqual(h.fakeRecorder.calls.length, 2);
  assert.strictEqual(h.fakeRecorder.calls[1].op, 'stop');
  assert.strictEqual(h.machine.state, 'stopping', 'beginRealStart не должен был тронуть state — решение уже принято requestStop');

  h.fakeRecorder.resolveStop(null); // <0.3с реального звука — recorder.js сам вернул бы null
  await h.flush();
  assert.strictEqual(h.machine.state, 'idle');
  assert.strictEqual(h.deliverCalls.length, 0, 'нечего доставлять — wav был null');
});

test('N1: две RAZ подряд короткие попытки не порождают конкурентных вызовов recorder.start() — второй requestStart() блокируется, пока первый цикл не идёт до idle', async () => {
  const { createVoiceMachine } = await import('../src/renderer/js/voice/voice-machine.js');
  const h = await makeHarness(createVoiceMachine);
  h.machine.requestStart();
  h.fakeTimer.fireAll();
  await h.flush();
  assert.strictEqual(h.fakeRecorder.calls.length, 1);

  h.machine.requestStop(); // state='stopping' — НЕ idle
  // Второй keydown приходит, пока первый цикл ещё не осел (state!=='idle')
  h.machine.requestStart();
  assert.strictEqual(h.machine.state, 'stopping', 'второй requestStart() должен был проигнорироваться целиком');
  assert.strictEqual(h.fakeTimer.pendingCount(), 0, 'второй pending-таймер не должен был быть поставлен');

  h.fakeRecorder.resolveStart();
  await h.flush();
  h.fakeRecorder.resolveStop(null);
  await h.flush();
  assert.strictEqual(h.machine.state, 'idle');
  assert.strictEqual(h.fakeRecorder.calls.length, 2, 'ровно одна пара start/stop — второй requestStart() не добавил своего start()');
});

// --- reject start (микрофон недоступен) ---

test('recorder.start() отклоняется (permission denied) — deliver(null, toast «Микрофон недоступен»)', async () => {
  const { createVoiceMachine } = await import('../src/renderer/js/voice/voice-machine.js');
  const h = await makeHarness(createVoiceMachine);
  h.machine.requestStart();
  h.fakeTimer.fireAll();
  await h.flush();
  assert.strictEqual(h.fakeRecorder.calls.length, 1);
  h.fakeRecorder.rejectStart(new Error('NotAllowedError'));
  await h.flush();
  assert.strictEqual(h.machine.state, 'idle');
  assert.strictEqual(h.deliverCalls.length, 1);
  assert.deepStrictEqual(h.deliverCalls[0], {
    tabId: null,
    decision: { action: 'toast', message: 'Микрофон недоступен', level: 'error' },
  });
});

test('recorder.start() отклоняется, но цикл уже был отменён (cancel во время starting) — тост НЕ показывается (решение уже принято)', async () => {
  const { createVoiceMachine } = await import('../src/renderer/js/voice/voice-machine.js');
  const h = await makeHarness(createVoiceMachine);
  h.machine.requestStart();
  h.fakeTimer.fireAll();
  await h.flush();
  h.machine.cancel(); // state='stopping' до резолва start()
  h.fakeRecorder.rejectStart(new Error('NotAllowedError'));
  await h.flush();
  assert.strictEqual(h.deliverCalls.length, 0, 'отменённый цикл не должен показывать «Микрофон недоступен» постфактум');
});

// --- Отмена (I1/C2-после-старта/C4/мышь) — единый cancel() ---

test('cancel() во время starting — тихая отмена без доставки', async () => {
  const { createVoiceMachine } = await import('../src/renderer/js/voice/voice-machine.js');
  const h = await makeHarness(createVoiceMachine);
  h.machine.requestStart();
  h.fakeTimer.fireAll();
  await h.flush();
  assert.strictEqual(h.machine.state, 'starting');
  h.machine.cancel();
  assert.strictEqual(h.machine.state, 'stopping');
  h.fakeRecorder.resolveStart();
  await h.flush();
  h.fakeRecorder.resolveStop(new ArrayBuffer(8));
  await h.flush();
  assert.strictEqual(h.machine.state, 'idle');
  assert.strictEqual(h.deliverCalls.length, 0);
});

test('cancel() во время recording (посторонний keydown/мышь/blur/C4) — тихая отмена, ДАЖЕ если recorder.stop() вернул полноценный WAV', async () => {
  const { createVoiceMachine } = await import('../src/renderer/js/voice/voice-machine.js');
  const h = await makeHarness(createVoiceMachine);
  h.machine.requestStart();
  h.fakeTimer.fireAll();
  await h.flush(); // дать chain.then() реально вызвать recorder.start(), чтобы startDef успел присвоиться
  h.fakeRecorder.resolveStart();
  await h.flush();
  assert.strictEqual(h.machine.state, 'recording');
  // Единая точка входа для I1 (мышь mousedown/wheel — штатное выделение в
  // xterm), C2-после-старта (Ctrl/Alt добрались уже после ShiftRight), C4
  // (blur/visibilitychange) — app.js маршрутизирует ВСЕ их в один и тот же
  // cancel(), машине не важно, кто именно попросил отменить.
  h.machine.cancel();
  assert.strictEqual(h.machine.state, 'stopping');
  await h.flush(); // дать chain.then() реально вызвать recorder.stop()
  h.fakeRecorder.resolveStop(new ArrayBuffer(8)); // полноценная запись
  await h.flush();
  assert.strictEqual(h.machine.state, 'idle');
  assert.strictEqual(h.deliverCalls.length, 0, 'cancel() ВСЕГДА отбрасывает результат, даже непустой WAV');
});

// --- «transcribing поверх нового тапа» (сценарий (б) закрыт целиком) ---

test('requestStart() во время transcribing — no-op: второй цикл не может начаться, пока первый ещё распознаётся', async () => {
  const { createVoiceMachine } = await import('../src/renderer/js/voice/voice-machine.js');
  const h = await makeHarness(createVoiceMachine);
  h.setTranscribeImpl(() => new Promise(() => {})); // никогда не резолвится — держим 'transcribing' навечно для теста
  h.machine.requestStart();
  h.fakeTimer.fireAll();
  await h.flush(); // дать chain.then() реально вызвать recorder.start(), чтобы startDef успел присвоиться
  h.fakeRecorder.resolveStart();
  await h.flush();
  h.machine.requestStop();
  await h.flush(); // дать chain.then() реально вызвать recorder.stop()
  h.fakeRecorder.resolveStop(new ArrayBuffer(8));
  await h.flush();
  assert.strictEqual(h.machine.state, 'transcribing');
  const callsBefore = h.fakeRecorder.calls.length;

  h.machine.requestStart(); // попытка начать НОВУЮ запись поверх ещё не осевшей первой
  assert.strictEqual(h.machine.state, 'transcribing', 'состояние не должно было измениться');
  assert.strictEqual(h.fakeRecorder.calls.length, callsBefore, 'recorder.start() не должен был вызваться повторно');
});

// --- C1 (Critical, ревью финальной волны): tabId захвачен на keyup ---

test('C1: tabId захватывается на keyup (requestStop) — переключение активной вкладки ПОСЛЕ этого не меняет цель доставки', async () => {
  const { createVoiceMachine } = await import('../src/renderer/js/voice/voice-machine.js');
  const h = await makeHarness(createVoiceMachine);
  h.setActiveTabId('tab-A');
  h.machine.requestStart();
  h.fakeTimer.fireAll();
  await h.flush(); // дать chain.then() реально вызвать recorder.start(), чтобы startDef успел присвоиться
  h.fakeRecorder.resolveStart();
  await h.flush();
  assert.strictEqual(h.machine.state, 'recording');

  h.machine.requestStop(); // снимок tabId='tab-A' делается ИМЕННО сейчас, синхронно
  h.setActiveTabId('tab-B'); // пользователь успел переключиться (Ctrl+Tab/Windows-тост), пока идёт stop()/распознавание
  await h.flush(); // дать chain.then() реально вызвать recorder.stop()
  h.fakeRecorder.resolveStop(new ArrayBuffer(8));
  await h.flush();
  await h.flush(); // ещё один прогон — дать transcribe()/deliver() продвинуться

  assert.strictEqual(h.deliverCalls.length, 1);
  assert.strictEqual(
    h.deliverCalls[0].tabId,
    'tab-A',
    'доставка должна была уйти в ТУ вкладку, что была активна на момент keyup, а не туда, куда переключились позже',
  );
  assert.deepStrictEqual(h.deliverCalls[0].decision, { action: 'deliver', text: 'привет мир' });
});

test('C1: переключение вкладки ДО keydown (обычный случай) — доставка идёт в новую активную вкладку, как и раньше', async () => {
  const { createVoiceMachine } = await import('../src/renderer/js/voice/voice-machine.js');
  const h = await makeHarness(createVoiceMachine);
  h.setActiveTabId('tab-A');
  h.setActiveTabId('tab-B'); // переключились ДО начала записи
  h.machine.requestStart();
  h.fakeTimer.fireAll();
  await h.flush(); // дать chain.then() реально вызвать recorder.start(), чтобы startDef успел присвоиться
  h.fakeRecorder.resolveStart();
  await h.flush();
  h.machine.requestStop();
  await h.flush(); // дать chain.then() реально вызвать recorder.stop()
  h.fakeRecorder.resolveStop(new ArrayBuffer(8));
  await h.flush();
  await h.flush();
  assert.strictEqual(h.deliverCalls[0].tabId, 'tab-B');
});

// --- Полный успешный цикл — переходы состояния/индикатора ---

test('полный успешный цикл: idle → pending → starting → recording → stopping → transcribing → idle, доставка непустого текста', async () => {
  const { createVoiceMachine } = await import('../src/renderer/js/voice/voice-machine.js');
  const h = await makeHarness(createVoiceMachine);
  assert.strictEqual(h.machine.state, 'idle');
  h.machine.requestStart();
  h.fakeTimer.fireAll();
  await h.flush(); // дать chain.then() реально вызвать recorder.start(), чтобы startDef успел присвоиться
  h.fakeRecorder.resolveStart();
  await h.flush();
  assert.strictEqual(h.machine.state, 'recording');
  h.machine.requestStop();
  await h.flush(); // дать chain.then() реально вызвать recorder.stop()
  h.fakeRecorder.resolveStop(new ArrayBuffer(8));
  await h.flush();
  await h.flush();
  assert.strictEqual(h.machine.state, 'idle');
  assert.deepStrictEqual(
    h.indicatorCalls,
    ['pending', 'starting', 'recording', 'stopping', 'transcribing', 'idle'],
  );
  assert.strictEqual(h.deliverCalls.length, 1);
  assert.deepStrictEqual(h.deliverCalls[0].decision, { action: 'deliver', text: 'привет мир' });
});

test('transcribe() отдаёт {error} — deliver получает decision toast с текстом ошибки как есть', async () => {
  const { createVoiceMachine } = await import('../src/renderer/js/voice/voice-machine.js');
  const h = await makeHarness(createVoiceMachine);
  h.setTranscribeImpl(async () => ({ error: 'оба бекенда не поднялись' }));
  h.machine.requestStart();
  h.fakeTimer.fireAll();
  await h.flush(); // дать chain.then() реально вызвать recorder.start(), чтобы startDef успел присвоиться
  h.fakeRecorder.resolveStart();
  await h.flush();
  h.machine.requestStop();
  await h.flush(); // дать chain.then() реально вызвать recorder.stop()
  h.fakeRecorder.resolveStop(new ArrayBuffer(8));
  await h.flush();
  await h.flush();
  assert.strictEqual(h.deliverCalls.length, 1);
  assert.deepStrictEqual(h.deliverCalls[0].decision, {
    action: 'toast', level: 'error', message: 'оба бекенда не поднялись',
  });
});
