'use strict';
// Проводка эстафеты. registerIpc целиком под node --test не запускается
// (require('electron') вне настоящего рантайма не даёт объект), поэтому
// проверяем ту самую функцию, которую зовёт прод, — не копию для теста.
// Тот же приём, что у bufferTermData в ipc-output-buffer-wiring.test.js.
const { test } = require('node:test');
const assert = require('node:assert');
const { applyHandoffSize } = require('../src/main/ipc');
const { createSessionManager } = require('../src/main/sessions');

// Форма вкладки здесь ОБЯЗАНА совпадать с manager.list() из sessions.js —
// поле называется tabId. Фикстура с чужим именем ключа однажды уже сделала
// главный тест этого файла холостым: applyHandoffSize читал tab.id, фикстура
// его же и подсовывала, а прод молча ресайзил undefined.
function fakeManager(tabs) {
  for (const t of tabs) {
    if (!t || typeof t.tabId !== 'string') {
      throw new Error('фикстура вкладки без tabId — она разъехалась с manager.list() из sessions.js');
    }
  }
  const calls = [];
  return {
    calls,
    list: () => tabs,
    resize: (tabId, cols, rows) => calls.push({ tabId, cols, rows }),
  };
}

// НАСТОЯЩИЙ менеджер сессий с фейковой фабрикой pty — тот же приём, что в
// test/sessions.test.js. Нужен здесь именно настоящий: главный тест ниже
// раньше кормил applyHandoffSize фикстурой {id: 'T1'}, а прод отдаёт {tabId},
// и функция молча ресайзила undefined. Тест был зелёным, переразмер при
// пересадке не работал ни разу — поймать это могла только настоящая форма
// списка (живой замер 09.08: фоновая вкладка оставалась в размере ушедшего).
function realManager() {
  const spawned = [];
  const ptyFactory = (opts) => {
    const proc = {
      opts,
      pid: 1000 + spawned.length,
      cols: null,
      rows: null,
      write() {},
      resize(c, r) { this.cols = c; this.rows = r; },
      kill() {},
      onData() {},
      onExit() {},
    };
    spawned.push(proc);
    return proc;
  };
  const mgr = createSessionManager({
    ptyFactory,
    getTermConfig: () => ({ command: 'claude', args: [], useConpty: true, useConptyDll: true }),
    onEvent: () => {},
    now: () => 0,
  });
  return { mgr, spawned };
}

test('смена владельца переразмеривает ВСЕ живые вкладки под его терминал', () => {
  // Все вкладки рисуются в одну и ту же область окна, значит размер у них
  // общий: подогнать только активную — оставить остальные в чужой раскладке,
  // и Claude Code в них перерисуется криво при первом же переключении.
  //
  // Проверяем на настоящем менеджере и по настоящему следствию — размеру,
  // доехавшему до самого pty. Так тест не может разъехаться с формой списка.
  const { mgr, spawned } = realManager();
  const ids = ['A', 'B', 'C'].map((name) => mgr.open({ cwd: `C:\\${name}` }).tabId);
  for (const tabId of ids) mgr.start(tabId, 80, 24);
  assert.strictEqual(spawned.length, 3, 'фейковая фабрика pty не отработала — тест проверял бы пустоту');

  applyHandoffSize({ manager: mgr, size: { cols: 120, rows: 40 } });

  assert.deepStrictEqual(
    spawned.map((p) => ({ cols: p.cols, rows: p.rows })),
    [
      { cols: 120, rows: 40 },
      { cols: 120, rows: 40 },
      { cols: 120, rows: 40 },
    ],
    'размер нового владельца доехал не до всех pty: вкладки, кроме активной, остались в чужой раскладке',
  );
});

test('без размера не трогаем ничего', () => {
  // Кривой размер ХУЖЕ прежнего: ConPTY на нулевых колонках ломает
  // перерисовку Claude Code, и вкладка остаётся с мусором на экране.
  const manager = fakeManager([{ tabId: 'T1' }]);
  applyHandoffSize({ manager, size: null });
  applyHandoffSize({ manager, size: undefined });
  applyHandoffSize({ manager, size: { cols: 0, rows: 0 } });
  applyHandoffSize({ manager, size: { cols: 80 } });
  applyHandoffSize({ manager, size: { rows: 24 } });
  applyHandoffSize({ manager, size: { cols: -5, rows: 24 } });
  assert.deepStrictEqual(manager.calls, []);
});

test('вкладок нет — не падаем', () => {
  const manager = fakeManager([]);
  applyHandoffSize({ manager, size: { cols: 80, rows: 24 } });
  assert.deepStrictEqual(manager.calls, []);
});

// --- Сама проводка ---------------------------------------------------------
// Ревью показало, чего стоила её непокрытость: СЕМЬ мутаций подряд оставляли
// прогон зелёным — гард пускал всех, переразмер не вызывался, события не
// рассылались, ownership не доезжал ни до сетевого сервера, ни наружу. То есть
// эстафету можно было вырезать из прод-сборки целиком, и 918 тестов молчали.
// Лечится тем же приёмом, что и bufferTermData: проводка — отдельная функция,
// которую прод действительно зовёт, и она проверяется здесь напрямую.

const { createHandoffWiring } = require('../src/main/ipc');

function makeWiring(tabs = [{ tabId: 'T1' }, { tabId: 'T2' }]) {
  const manager = fakeManager(tabs);
  const events = [];
  const owners = [];
  const wiring = createHandoffWiring({
    manager,
    broadcast: { emit: (channel, payload) => events.push({ channel, payload }) },
    onOwnerChange: (owner) => owners.push(owner),
  });
  return {
    manager, events, owners, ...wiring,
  };
}

test('гард: чтение всем, запись только владельцу', () => {
  const { guard, ownership } = makeWiring();
  assert.strictEqual(guard({ channel: 'usage:get', who: 'c1' }), true, 'чтение свободно');
  assert.strictEqual(guard({ channel: 'term:write', who: 'c1' }), false, 'чужая запись под запретом');
  assert.strictEqual(guard({ channel: 'term:write', who: 'local' }), true, 'владелец пишет');

  ownership.claim('c1', { cols: 80, rows: 24 });
  assert.strictEqual(guard({ channel: 'term:write', who: 'c1' }), true, 'новый владелец пишет');
  assert.strictEqual(guard({ channel: 'term:write', who: 'local' }), false, 'бывший владелец больше нет');
});

test('смена владельца переразмеривает pty, рассылает событие и говорит окну', () => {
  const {
    ownership, manager, events, owners,
  } = makeWiring();
  ownership.claim('c1', { cols: 120, rows: 40 });

  assert.deepStrictEqual(manager.calls, [
    { tabId: 'T1', cols: 120, rows: 40 },
    { tabId: 'T2', cols: 120, rows: 40 },
  ], 'pty подгоняется под нового владельца');
  assert.deepStrictEqual(events, [
    { channel: 'owner:changed', payload: { owner: 'c1', online: true } },
  ], 'клиенты узнают о смене владельца');
  assert.deepStrictEqual(owners, ['c1'], 'окно узнаёт, что управление ушло');
});

test('уход владельца рассылается как «не на связи», владельца не меняя', () => {
  // Раньше drop менял только внутренний флаг: строка трея «(не на связи)» и
  // тот же текст на заглушке были недостижимы в проде — тесты стерегли
  // мёртвый код.
  const { ownership, events, owners } = makeWiring();
  ownership.claim('c1', { cols: 80, rows: 24 });
  events.length = 0;
  owners.length = 0;

  ownership.drop('c1');
  assert.deepStrictEqual(events, [
    { channel: 'owner:changed', payload: { owner: 'c1', online: false } },
  ], 'о пропаже владельца обязаны узнать все');
  assert.deepStrictEqual(owners, [], 'это не смена владельца — окно трогать нельзя');

  events.length = 0;
  ownership.claim('c1', { cols: 80, rows: 24 });
  assert.deepStrictEqual(events, [
    { channel: 'owner:changed', payload: { owner: 'c1', online: true } },
  ], 'и о его возвращении тоже');
});

test('уход НЕ владельца никого не беспокоит', () => {
  const { ownership, events } = makeWiring();
  ownership.claim('c1', { cols: 80, rows: 24 });
  events.length = 0;
  ownership.drop('c2');
  assert.deepStrictEqual(events, []);
});

test('сбой побочного эффекта не отменяет смену владельца', () => {
  // Побочные эффекты идут ВНУТРИ смены состояния, и на локальном пути их
  // исключение улетает в обработчик события Electron, а оттуда — в
  // uncaughtException, который делает app.exit(1). Клик по значку в трее не
  // имеет права убивать приложение.
  const manager = {
    list: () => { throw new Error('менеджер сессий упал'); },
    resize: () => {},
  };
  const events = [];
  const { ownership } = createHandoffWiring({
    manager,
    broadcast: { emit: (channel, payload) => events.push({ channel, payload }) },
    onOwnerChange: () => { throw new Error('окно упало'); },
  });

  assert.doesNotThrow(() => ownership.claim('c1', { cols: 80, rows: 24 }));
  assert.strictEqual(ownership.owner(), 'c1', 'владелец сменился, несмотря на сбой');
  assert.deepStrictEqual(events, [
    { channel: 'owner:changed', payload: { owner: 'c1', online: true } },
  ], 'падение переразмера не должно глушить рассылку');
});

// Тесты выше проверяют саму проводку, но не то, что registerIpc её ЗОВЁТ и
// раздаёт результат по местам. Вырезать вызов — и всё выше останется зелёным,
// а эстафеты в приложении не будет. registerIpc под node --test не
// запускается (require('electron') вне рантайма не даёт объект), поэтому
// стережём по исходнику — тем же приёмом, что broadcast-guard.test.js и
// ipc-net-boot.test.js (там это уже спасало: подменённый дефолт host
// оставлял 828 тестов зелёными).
const fs = require('node:fs');
const path = require('node:path');

// Первая редакция этого стража была ХОЛОСТОЙ на трёх мутациях (ре-ревью):
// `guard: () => true` прямо в реестре, удалённый `ownership` из возврата
// registerIpc и переименованная переменная в деструктуризации — всё проходило
// зелёным. Причина в том, что проверки искали ПРИЗНАКИ (слово `guard:`,
// «где-то есть return с ownership») по всему файлу, а не связь между
// объявлением и использованием внутри самой registerIpc. Тот же класс ошибки,
// ради которого страж и писался: проверка, которая выглядит проверкой.
//
// Теперь: вырезаем ТЕЛО registerIpc, вытаскиваем настоящее имя переменной из
// деструктуризации и требуем, чтобы именно оно приехало в реестр.
function registerIpcBody() {
  const text = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ipc.js'), 'utf8');
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.startsWith('function registerIpc('));
  assert.ok(start >= 0, 'в ipc.js больше нет функции registerIpc — страж потерял цель');
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^(function |module\.exports)/.test(lines[i])) { end = i; break; }
  }
  // Строки-комментарии выкидываем: про эстафету в этом файле написано много,
  // и упоминание в тексте не должно сходить за живой код.
  return lines.slice(start, end).filter((line) => !line.trim().startsWith('//')).join('\n');
}

test('registerIpc собирает эстафету и отдаёт гард РЕАЛЬНОМУ реестру', () => {
  const body = registerIpcBody();

  const wiring = body.match(/const\s*\{\s*ownership\s*,\s*guard:\s*(\w+)\s*\}\s*=\s*createHandoffWiring\(/);
  assert.ok(wiring, 'registerIpc не собирает проводку эстафеты (createHandoffWiring)');

  const guardName = wiring[1];
  const registry = body.match(/createCommandRegistry\(\{([^}]*)\}\)/);
  assert.ok(registry, 'реестр команд в registerIpc не собирается вовсе');
  assert.match(
    registry[1],
    new RegExp(`guard:\\s*${guardName}\\b`),
    `реестр получает не тот гард: ожидали ${guardName} из проводки эстафеты, а там ${registry[1].trim()}`,
  );
});

test('term:resize запоминает размер за владельцем', () => {
  // Живая жалоба 05.08: «при возврате на ПК размер ломается». Владение знало
  // размер только с момента захвата, а реальные ресайзы окна идут этим каналом
  // мимо него. Без этой строки возврат снова начнёт ставить pty в размер,
  // снятый при загрузке страницы, — и тесты выше этого не заметят: они про
  // ownership, а не про то, что его кто-то уведомляет.
  //
  // Сам обработчик вынесен в termResizeHandler (его поведение — тесты ниже),
  // здесь стережём, что registerIpc зовёт именно его и отдаёт ему ownership.
  const body = registerIpcBody();
  const handler = body.match(/registry\.on\('term:resize'[\s\S]*?\n {2}\}\);/);
  assert.ok(handler, 'обработчик term:resize в registerIpc не найден');
  assert.match(
    handler[0],
    /termResizeHandler\(\{[^}]*\bownership\b[^}]*\}\)/,
    'term:resize в registerIpc не зовёт termResizeHandler с ownership — размер не уедет ни во владение, ни во вкладки',
  );
});

test('term:start в registerIpc идёт через termStartHandler с ownership', () => {
  // Без ownership термин «размер владельца» для старта без размера пуст: main
  // снова поднимал бы процесс в 80×24 или не поднимал вовсе.
  const body = registerIpcBody();
  const handler = body.match(/registry\.on\('term:start'[\s\S]*?\n {2}\}\);/);
  assert.ok(handler, 'обработчик term:start в registerIpc не найден');
  assert.match(
    handler[0],
    /termStartHandler\(\{[^}]*\bownership\b[^}]*\}\)/,
    'term:start в registerIpc не зовёт termStartHandler с ownership',
  );
});

// --- Размер на старте и на ресайзе (план «размер терминала», задача A3) ----
// Запись кадров на стенде 05.11: renderer слал term:start и term:resize из
// СКРЫТЫХ вкладок с умолчанием xterm 80×24. Теперь он шлёт только подогнанный
// размер, а скрытая вкладка стартует без размера — значит размер для неё
// выбирает main, и размер видимой вкладки main раздаёт всем.

const { resolveStartSize, termStartHandler, termResizeHandler } = require('../src/main/ipc');
const { createOwnership } = require('../src/main/ownership');

test('resolveStartSize: свой размер, иначе размер владельца, иначе 80×24', () => {
  assert.deepStrictEqual(resolveStartSize(120, 40, { cols: 279, rows: 69 }), { cols: 120, rows: 40 }, 'свой валидный размер главнее');
  assert.deepStrictEqual(resolveStartSize(null, null, { cols: 279, rows: 69 }), { cols: 279, rows: 69 }, 'без размера — размер владельца');
  assert.deepStrictEqual(resolveStartSize(undefined, undefined, { cols: 279, rows: 69 }), { cols: 279, rows: 69 });
  assert.deepStrictEqual(resolveStartSize(null, null, null), { cols: 80, rows: 24 }, 'не знаем ничего — умолчание терминала');
  // Кривой «свой» размер — как отсутствующий, а не повод молча не стартовать.
  assert.deepStrictEqual(resolveStartSize(0, 0, { cols: 279, rows: 69 }), { cols: 279, rows: 69 });
  assert.deepStrictEqual(resolveStartSize(120, null, { cols: 279, rows: 69 }), { cols: 279, rows: 69 }, 'половина размера — не размер');
  assert.deepStrictEqual(resolveStartSize(9999, 40, null), { cols: 80, rows: 24 });
  // Кривой размер владельца тоже не берём.
  assert.deepStrictEqual(resolveStartSize(null, null, { cols: 1, rows: 1 }), { cols: 80, rows: 24 });
  assert.deepStrictEqual(resolveStartSize(null, null, { cols: '279', rows: '69' }), { cols: 80, rows: 24 });
});

test('term:start без размера поднимает процесс в размере владельца', () => {
  const { mgr, spawned } = realManager();
  const { tabId } = mgr.open({ cwd: 'C:\\A' });
  const ownership = createOwnership();
  ownership.claim('local', { cols: 279, rows: 69 }); // тот же владелец — только запоминает размер

  termStartHandler({ manager: mgr, ownership, payload: { tabId, cols: null, rows: null } });

  assert.strictEqual(spawned.length, 1, 'без размера процесс не поднялся вовсе — раньше term:start так и выходил молча');
  assert.deepStrictEqual(
    { cols: spawned[0].opts.cols, rows: spawned[0].opts.rows },
    { cols: 279, rows: 69 },
    'скрытая вкладка поднялась не в размере владельца',
  );
});

test('term:start без размера и без размера владельца — 80×24, но процесс поднят', () => {
  const { mgr, spawned } = realManager();
  const { tabId } = mgr.open({ cwd: 'C:\\A' });
  termStartHandler({ manager: mgr, ownership: createOwnership(), payload: { tabId } });
  assert.strictEqual(spawned.length, 1);
  assert.deepStrictEqual({ cols: spawned[0].opts.cols, rows: spawned[0].opts.rows }, { cols: 80, rows: 24 });
});

test('term:start со своим размером — свой размер', () => {
  const { mgr, spawned } = realManager();
  const { tabId } = mgr.open({ cwd: 'C:\\A' });
  const ownership = createOwnership();
  ownership.claim('local', { cols: 279, rows: 69 });
  termStartHandler({ manager: mgr, ownership, payload: { tabId, cols: 120, rows: 40 } });
  assert.deepStrictEqual({ cols: spawned[0].opts.cols, rows: spawned[0].opts.rows }, { cols: 120, rows: 40 });
});

test('term:start без tabId или с мусором вместо payload — ничего', () => {
  const { mgr, spawned } = realManager();
  mgr.open({ cwd: 'C:\\A' });
  const ownership = createOwnership();
  for (const payload of [null, undefined, 'T1', { cols: 80, rows: 24 }, { tabId: 5 }]) {
    assert.doesNotThrow(() => termStartHandler({ manager: mgr, ownership, payload }));
  }
  assert.strictEqual(spawned.length, 0);
});

test('term:resize владельца переразмеривает ВСЕ живые вкладки, не только свою', () => {
  // Все вкладки рисуются в одну и ту же область окна. Скрытые вкладки свой
  // размер больше не сообщают (у неподогнанного терминала его нет), поэтому
  // размер видимой — единственный источник для всех. Проверяем по
  // настоящему менеджеру и настоящему следствию — размеру, доехавшему до pty.
  const { mgr, spawned } = realManager();
  const ids = ['A', 'B', 'C'].map((name) => mgr.open({ cwd: `C:\\${name}` }).tabId);
  for (const tabId of ids) mgr.start(tabId, 80, 24);
  const ownership = createOwnership();

  termResizeHandler({ manager: mgr, ownership, payload: { tabId: ids[0], cols: 279, rows: 69 } });

  assert.deepStrictEqual(
    spawned.map((p) => ({ cols: p.cols, rows: p.rows })),
    [{ cols: 279, rows: 69 }, { cols: 279, rows: 69 }, { cols: 279, rows: 69 }],
    'размер видимой вкладки доехал не до всех pty — фоновые остались в 80×24',
  );
  assert.deepStrictEqual(ownership.size(), { cols: 279, rows: 69 }, 'размер не запомнен за владельцем');
});

test('term:resize: форма вкладок — та, что отдаёт manager.list() (tabId)', () => {
  // Фейковый менеджер проверяет форму фикстуры: tabId, а не id (урок
  // applyHandoffSize — фикстура {id} держала зелёным неработавший переразмер).
  const manager = fakeManager([{ tabId: 'T1' }, { tabId: 'T2' }]);
  termResizeHandler({ manager, ownership: createOwnership(), payload: { tabId: 'T2', cols: 100, rows: 30 } });
  assert.deepStrictEqual(manager.calls, [
    { tabId: 'T1', cols: 100, rows: 30 },
    { tabId: 'T2', cols: 100, rows: 30 },
  ]);
});

// Ре-ревью: браузер ~720px с диф-панелью → видимая вкладка 14×27. Раздача
// всем перерисовывала ВСЕ сессии Claude Code в 14 колонок и срезала прокрутку
// скрытых. Видимая вкладка свой узкий размер получает, остальные — нет.
test('узкий ресайз (уже порога раздачи) меняет только свою вкладку и не запоминается', () => {
  const { mgr, spawned } = realManager();
  const ids = ['A', 'B', 'C'].map((name) => mgr.open({ cwd: `C:\\${name}` }).tabId);
  for (const tabId of ids) mgr.start(tabId, 120, 40);
  const ownership = createOwnership();
  termResizeHandler({ manager: mgr, ownership, payload: { tabId: ids[0], cols: 120, rows: 40 } });
  const sizes = () => spawned.map((p) => ({ cols: p.cols, rows: p.rows }));
  assert.deepStrictEqual(sizes(), [{ cols: 120, rows: 40 }, { cols: 120, rows: 40 }, { cols: 120, rows: 40 }]);

  termResizeHandler({ manager: mgr, ownership, payload: { tabId: ids[0], cols: 14, rows: 27 } });
  assert.deepStrictEqual(
    sizes(),
    [{ cols: 14, rows: 27 }, { cols: 120, rows: 40 }, { cols: 120, rows: 40 }],
    'узкий размер видимой вкладки разослан всем — все сессии перерисуются в 14 колонок',
  );
  assert.deepStrictEqual(
    ownership.size(), { cols: 120, rows: 40 },
    'узкий размер запомнен за владельцем — следующая пересадка раздаст его всем',
  );

  termResizeHandler({ manager: mgr, ownership, payload: { tabId: ids[0], cols: 200, rows: 50 } });
  assert.deepStrictEqual(sizes(), [{ cols: 200, rows: 50 }, { cols: 200, rows: 50 }, { cols: 200, rows: 50 }], 'ширину вернули, а раздача не возобновилась');
  assert.deepStrictEqual(ownership.size(), { cols: 200, rows: 50 });
});

test('порог раздачи в main: ровно на пороге — всем, на единицу меньше — только своей', () => {
  const { MIN_SHARED_GRID: { cols: c, rows: r } } = require('../src/main/ownership');
  for (const [cols, rows, all] of [[c, r, true], [c - 1, r, false], [c, r - 1, false]]) {
    const manager = fakeManager([{ tabId: 'T1' }, { tabId: 'T2' }]);
    termResizeHandler({ manager, ownership: createOwnership(), payload: { tabId: 'T2', cols, rows } });
    assert.deepStrictEqual(
      manager.calls,
      all ? [{ tabId: 'T1', cols, rows }, { tabId: 'T2', cols, rows }] : [{ tabId: 'T2', cols, rows }],
      `${cols}×${rows}`,
    );
  }
});

test('applyHandoffSize: размер уже порога раздачи не раздаётся никому', () => {
  // Пересадка без размера раздаёт запомненный — а запомненным узкий быть не
  // должен; страховка на случай, если он придёт другим путём.
  const manager = fakeManager([{ tabId: 'T1' }, { tabId: 'T2' }]);
  applyHandoffSize({ manager, size: { cols: 14, rows: 27 } });
  assert.deepStrictEqual(manager.calls, []);
});

test('term:resize с кривым размером не трогает pty и не запоминается', () => {
  const manager = fakeManager([{ tabId: 'T1' }]);
  const ownership = createOwnership();
  ownership.claim('local', { cols: 120, rows: 40 });
  for (const payload of [
    null, 'T1', { tabId: 'T1' }, { tabId: 'T1', cols: 0, rows: 0 }, { tabId: 'T1', cols: 1, rows: 1 },
    { tabId: 'T1', cols: 9999, rows: 40 }, { tabId: 'T1', cols: 80.5, rows: 24 }, { cols: 80, rows: 24 },
  ]) {
    assert.doesNotThrow(() => termResizeHandler({ manager, ownership, payload }));
  }
  assert.deepStrictEqual(manager.calls, []);
  assert.deepStrictEqual(ownership.size(), { cols: 120, rows: 40 });
});

test('ownership доезжает до сетевого сервера и наружу, в main.js', () => {
  const body = registerIpcBody();

  // Без этого сетевой клиент не сможет ни захватить управление, ни получить
  // отказ: сервер обслуживает owner:claim сам и знает, чей пришёл кадр.
  const netServer = body.match(/createNetServer\(\{([\s\S]*?)\n\s*\}\)/);
  assert.ok(netServer, 'сетевой сервер в registerIpc не создаётся');
  assert.match(
    netServer[1],
    /\bownership\b/,
    'ownership не передан в createNetServer — сетевая половина эстафеты мертва',
  );

  // Возврат ИМЕННО registerIpc, а не любой return в файле: раньше проверку
  // удовлетворял `return { ownership, guard }` внутри самой createHandoffWiring.
  const returns = [...body.matchAll(/return \{[\s\S]*?\};/g)];
  assert.ok(returns.length > 0, 'registerIpc ничего не возвращает');
  const last = returns[returns.length - 1][0];
  assert.match(
    last,
    /\bownership\b/,
    'registerIpc не отдаёт ownership наружу — трею нечего показывать',
  );
});

test('createHandoffWiring не требует необязательных зависимостей', () => {
  const { ownership, guard } = createHandoffWiring({
    manager: fakeManager([{ tabId: 'T1' }]),
    broadcast: { emit: () => {} },
  });
  assert.doesNotThrow(() => ownership.claim('c1', { cols: 80, rows: 24 }));
  assert.strictEqual(guard({ channel: 'term:write', who: 'c1' }), true);
});
