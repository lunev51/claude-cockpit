'use strict';
// Эстафета: кто владеет управлением. Чистое ядро — Electron и сокеты сюда
// не входят, поэтому всё поведение проверяется прямыми вызовами.
const { test } = require('node:test');
const assert = require('node:assert');
const { createOwnership } = require('../src/main/ownership');

// Собираем вызовы onChange списком: «сколько раз позвали» — половина
// проверяемых правил (повторный захват тем же клиентом обязан молчать).
function make() {
  const changes = [];
  const own = createOwnership({ onChange: (info) => changes.push(info) });
  return { own, changes };
}

test('на старте владеет локальное окно, писать может только оно', () => {
  const { own, changes } = make();
  assert.strictEqual(own.owner(), 'local');
  assert.strictEqual(own.canWrite('local'), true);
  assert.strictEqual(own.canWrite('c1'), false);
  assert.strictEqual(own.size(), null);
  assert.deepStrictEqual(changes, []);
});

test('захват сетевым клиентом переносит владение и его размер', () => {
  const { own, changes } = make();
  assert.strictEqual(own.claim('c1', { cols: 80, rows: 24 }), true);
  assert.strictEqual(own.owner(), 'c1');
  assert.deepStrictEqual(own.size(), { cols: 80, rows: 24 });
  assert.strictEqual(own.canWrite('local'), false);
  assert.strictEqual(own.canWrite('c1'), true);
  assert.strictEqual(changes.length, 1);
  assert.deepStrictEqual(changes[0], {
    owner: 'c1', previous: 'local', size: { cols: 80, rows: 24 },
  });
});

test('повторный захват тем же клиентом не событие, но размер обновляет', () => {
  const { own, changes } = make();
  own.claim('c1', { cols: 80, rows: 24 });
  assert.strictEqual(own.claim('c1', { cols: 100, rows: 30 }), false);
  assert.strictEqual(changes.length, 1);
  assert.deepStrictEqual(own.size(), { cols: 100, rows: 30 });
});

test('повторный захват без размера сохраняет СВОЙ прежний размер', () => {
  // Тест раньше утверждал обратное — что захват без размера наследует размер
  // предыдущего владельца. Так и было задумано в первой редакции плана, пока
  // не выяснилось, что возврат управления на ПК происходит именно без размера
  // (main.js забирает его при показе окна) и наследование натягивало бы на
  // терминал ширину макбука.
  const { own } = make();
  own.claim('c1', { cols: 80, rows: 24 });
  own.claim('c1');
  assert.deepStrictEqual(own.size(), { cols: 80, rows: 24 });
});

test('уход НЕ владельца ничего не меняет', () => {
  const { own, changes } = make();
  own.claim('c1', { cols: 80, rows: 24 });
  assert.strictEqual(own.drop('c2'), false);
  assert.strictEqual(own.owner(), 'c1');
  assert.strictEqual(own.ownerOnline(), true);
  assert.strictEqual(changes.length, 1);
});

test('уход владельца не отдаёт управление, но помечает его офлайн', () => {
  const { own, changes } = make();
  own.claim('c1', { cols: 80, rows: 24 });
  assert.strictEqual(own.drop('c1'), true);
  assert.strictEqual(own.owner(), 'c1', 'обрыв связи не равен потере управления');
  assert.strictEqual(own.ownerOnline(), false);
  assert.strictEqual(own.canWrite('local'), false, 'окно ПК не забирает управление само');
  assert.strictEqual(changes.length, 1, 'уход владельца — не смена владельца');
});

test('вернувшийся владелец снова онлайн без события смены', () => {
  const { own, changes } = make();
  own.claim('c1', { cols: 80, rows: 24 });
  own.drop('c1');
  assert.strictEqual(own.claim('c1', { cols: 80, rows: 24 }), false);
  assert.strictEqual(own.ownerOnline(), true);
  assert.strictEqual(changes.length, 1);
});

test('локальное окно забирает управление обратно', () => {
  const { own, changes } = make();
  own.claim('c1', { cols: 80, rows: 24 });
  assert.strictEqual(own.claim('local', { cols: 200, rows: 50 }), true);
  assert.strictEqual(own.owner(), 'local');
  assert.strictEqual(own.ownerOnline(), true);
  assert.deepStrictEqual(changes[1], {
    owner: 'local', previous: 'c1', size: { cols: 200, rows: 50 },
  });
});

test('размер помнится ПО ВЛАДЕЛЬЦУ — вернувшийся получает свой, а не чужой', () => {
  // Окно ПК на весь экран и браузер на макбуке — это два разных размера.
  // main.js забирает управление обратно БЕЗ размера (renderer в этот момент
  // ещё не успел сказать своё слово), и подставить сюда размер макбука
  // означало бы перерисовать Claude Code в чужой ширине на каждом возврате.
  const { own } = make();
  own.claim('local', { cols: 200, rows: 50 });
  own.claim('c1', { cols: 80, rows: 24 });
  assert.deepStrictEqual(own.size(), { cols: 80, rows: 24 });

  own.claim('local');
  assert.deepStrictEqual(own.size(), { cols: 200, rows: 50 }, 'вернулся размер окна ПК');

  own.claim('c1');
  assert.deepStrictEqual(own.size(), { cols: 80, rows: 24 }, 'и размер макбука тоже свой');
});

test('захват с пустым размером {cols:null, rows:null} — как без размера (C1 ревью)', () => {
  // Renderer шлёт claim(null, null), когда у него нет подогнанного терминала
  // (загрузка страницы до первой вкладки). Раньше любой объект считался
  // размером: {null, null} затирал запомненный размер владельца, и следующая
  // пересадка раздавала сессиям мусор.
  const { own, changes } = make();
  own.claim('c1', { cols: 279, rows: 69 });
  own.claim('c1', { cols: null, rows: null });
  assert.deepStrictEqual(own.size(), { cols: 279, rows: 69 }, 'пустой размер затёр настоящий');
  own.claim('c1', { cols: undefined });
  own.claim('c1', {});
  assert.deepStrictEqual(own.size(), { cols: 279, rows: 69 });

  // И при смене владельца: вернувшийся без размера получает СВОЙ прежний.
  own.claim('local', { cols: 200, rows: 50 });
  own.claim('c1', { cols: null, rows: null });
  assert.deepStrictEqual(own.size(), { cols: 279, rows: 69 });
  assert.deepStrictEqual(changes[changes.length - 1].size, { cols: 279, rows: 69 });
});

test('захват с кривым размером не запоминается — те же границы, что у pty (2..500, целые)', () => {
  const { own, changes } = make();
  for (const bad of [
    { cols: 0, rows: 0 }, { cols: 1, rows: 24 }, { cols: 80, rows: 1 }, { cols: 501, rows: 24 },
    { cols: 80.5, rows: 24 }, { cols: '80', rows: '24' }, { cols: NaN, rows: NaN }, 'мусор', 42,
  ]) {
    own.claim('c9', bad);
    assert.strictEqual(own.size(), null, `запомнен кривой размер ${JSON.stringify(bad)}`);
  }
  assert.strictEqual(changes[0].size, null, 'onChange получил кривой размер вместо null');
});

test('узкий размер (уже порога раздачи) не запоминается ни захватом, ни noteSize', () => {
  // Запомненный размер владельца нужен только для раздачи ВСЕМ вкладкам
  // (пересадка — applyHandoffSize, старт скрытой вкладки — resolveStartSize).
  // Узкий размер видимой вкладки (ре-ревью: 14×27 при ~720px с диф-панелью)
  // раздавать нельзя — значит и запоминать нельзя: иначе следующая пересадка
  // разошлёт его всем сессиям.
  const { own, changes } = make();
  own.claim('c1', { cols: 200, rows: 50 });
  own.noteSize({ cols: 14, rows: 27 });
  assert.deepStrictEqual(own.size(), { cols: 200, rows: 50 }, 'noteSize запомнил узкий размер');
  own.claim('c1', { cols: 14, rows: 27 });
  assert.deepStrictEqual(own.size(), { cols: 200, rows: 50 }, 'захват запомнил узкий размер');

  own.claim('c9', { cols: 14, rows: 27 });
  assert.strictEqual(own.size(), null);
  assert.strictEqual(changes[changes.length - 1].size, null, 'пересадка получила узкий размер для раздачи всем');
});

test('noteSize: размер за пределами 2..500 не запоминается', () => {
  const { own } = make();
  own.claim('local', { cols: 100, rows: 30 });
  own.noteSize({ cols: 1, rows: 1 });
  own.noteSize({ cols: 9999, rows: 30 });
  own.noteSize({ cols: null, rows: null });
  assert.deepStrictEqual(own.size(), { cols: 100, rows: 30 });
});

test('незнакомый владелец без размера не тащит чужой', () => {
  const { own, changes } = make();
  own.claim('local', { cols: 200, rows: 50 });
  own.claim('c9');
  assert.strictEqual(own.size(), null, 'о размере c9 мы ничего не знаем — лучше ничего, чем чужое');
  assert.strictEqual(changes[changes.length - 1].size, null);
});

test('onChange получает размер НОВОГО владельца, а не прежнего', () => {
  const { own, changes } = make();
  own.claim('local', { cols: 200, rows: 50 });
  own.claim('c1', { cols: 80, rows: 24 });
  own.claim('local');
  assert.deepStrictEqual(changes[changes.length - 1], {
    owner: 'local', previous: 'c1', size: { cols: 200, rows: 50 },
  });
});

// --- Живая жалоба 05.08: «при возврате на ПК размер ломается» --------------
// Размер попадал в память владения ТОЛЬКО при захвате, то есть с загрузки
// страницы. Дальше человек разворачивает окно, тянет край, меняет размер
// шрифта — всё это уезжает в pty через term:resize, мимо владения. Возврат
// управления ставил pty в размер полугодичной давности, и Claude Code
// перерисовывался под чужую ширину: пользователю приходилось дёргать окно
// руками, чтобы наблюдатель прислал настоящий размер.

test('noteSize обновляет размер ТЕКУЩЕГО владельца', () => {
  const { own } = make();
  own.claim('local', { cols: 100, rows: 30 });
  own.noteSize({ cols: 200, rows: 50 });
  assert.deepStrictEqual(own.size(), { cols: 200, rows: 50 });
});

test('запомненный размер переживает уход к соседу и обратно', () => {
  const { own } = make();
  own.claim('local', { cols: 100, rows: 30 });
  own.noteSize({ cols: 200, rows: 50 }); // человек развернул окно на ПК
  own.claim('c1', { cols: 80, rows: 24 }); // руль ушёл на макбук
  own.noteSize({ cols: 90, rows: 26 }); // на маке тоже поменяли размер

  assert.deepStrictEqual(own.size(), { cols: 90, rows: 26 }, 'сейчас за рулём мак');
  own.claim('local');
  assert.deepStrictEqual(
    own.size(), { cols: 200, rows: 50 },
    'вернулись на ПК — размер тот, что был там на самом деле, а не с момента загрузки',
  );
});

test('noteSize не меняет владельца и не рождает событий', () => {
  const { own, changes } = make();
  own.claim('c1', { cols: 80, rows: 24 });
  changes.length = 0;
  own.noteSize({ cols: 120, rows: 40 });
  assert.strictEqual(own.owner(), 'c1');
  assert.deepStrictEqual(changes, []);
});

test('кривой размер в noteSize игнорируется', () => {
  // Скрытое окно даёт контейнер нулевого размера, и подгонка терминала
  // посчитала бы 0×0. Запомнить такое — значит вернуться к нему при следующем
  // захвате.
  const { own } = make();
  own.claim('local', { cols: 100, rows: 30 });
  own.noteSize({ cols: 0, rows: 0 });
  own.noteSize({ cols: -5, rows: 20 });
  own.noteSize({ cols: 80 });
  own.noteSize(null);
  own.noteSize(undefined);
  assert.deepStrictEqual(own.size(), { cols: 100, rows: 30 });
});

test('уход и возвращение владельца — отдельное событие, не смена владельца', () => {
  // Раньше drop менял только внутренний флаг, наружу не выходило ничего: строка
  // трея «(не на связи)» и тот же текст на заглушке были в проде недостижимы,
  // хотя тесты на них проходили. Тесты, стерегущие мёртвый код.
  const changes = [];
  const presence = [];
  const own = createOwnership({
    onChange: (info) => changes.push(info),
    onPresence: (info) => presence.push(info),
  });

  own.claim('c1', { cols: 80, rows: 24 });
  assert.deepStrictEqual(presence, [], 'захват — это onChange, не присутствие');

  own.drop('c1');
  assert.deepStrictEqual(presence, [{ owner: 'c1', online: false }]);
  assert.strictEqual(changes.length, 1, 'владелец не менялся');

  own.claim('c1');
  assert.deepStrictEqual(presence[1], { owner: 'c1', online: true }, 'вернулся — сказать надо');
  assert.strictEqual(changes.length, 1);
});

test('повторный drop молчит — сообщать не о чем', () => {
  const presence = [];
  const own = createOwnership({ onPresence: (info) => presence.push(info) });
  own.claim('c1', { cols: 80, rows: 24 });
  own.drop('c1');
  own.drop('c1');
  assert.strictEqual(presence.length, 1, 'второй обрыв того же клиента — не новость');
});

test('уход не владельца не рождает событие присутствия', () => {
  const presence = [];
  const own = createOwnership({ onPresence: (info) => presence.push(info) });
  own.claim('c1', { cols: 80, rows: 24 });
  own.drop('c2');
  assert.deepStrictEqual(presence, []);
});

// --- C2 ревью 09.08: карта размеров росла на каждое переподключение ---------
// Имя клиента живёт ровно столько, сколько сокет (net-server.js: c1, c2, …),
// поэтому каждая перезагрузка страницы на макбуке — новый ключ в карте, и
// старые не уходили никогда. Последовательности вызовов ниже — те же, что
// делает net-server: claim из кадра owner:claim, drop из close/error сокета.

test('отключившийся НЕ владелец забывается: 100 таких клиентов карту не растят', () => {
  const { own } = make();
  own.claim('local', { cols: 200, rows: 50 });
  for (let i = 1; i <= 100; i += 1) {
    own.claim(`c${i}`, { cols: 80, rows: 24 }); // браузер забрал руль
    own.claim('local'); // окно ПК вернуло его себе
    own.drop(`c${i}`); // браузер закрыли — он уже не владелец
  }
  assert.ok(own.sizeCount() <= 1, `в карте ${own.sizeCount()} размеров после 100 ушедших клиентов`);
  assert.deepStrictEqual(own.size(), { cols: 200, rows: 50 }, 'размер окна ПК потерялся');
});

test('перезагрузки страницы владельцем карту не растят (100 циклов)', () => {
  // Живой сценарий: макбук за рулём, человек жмёт F5. Старый сокет уходит
  // ВЛАДЕЛЬЦЕМ (офлайн, размер держим), новый сокет — новое имя — забирает
  // руль. С этого момента прежнее имя не вернётся никогда: держать его
  // размер не для кого.
  const { own } = make();
  own.claim('local', { cols: 200, rows: 50 });
  for (let i = 1; i <= 100; i += 1) {
    own.claim(`c${i}`, { cols: 80 + (i % 5), rows: 24 });
    own.drop(`c${i}`);
  }
  assert.ok(own.sizeCount() <= 2, `в карте ${own.sizeCount()} размеров после 100 перезагрузок`);
  assert.deepStrictEqual(own.size(), { cols: 80, rows: 24 }, 'размер текущего (офлайн) владельца потерян');
  own.claim('local');
  assert.deepStrictEqual(own.size(), { cols: 200, rows: 50 }, 'размер окна ПК потерялся');
});

test('уход ВЛАДЕЛЬЦА его размер не стирает — руль у него, размер ещё нужен', () => {
  // Пока владелец офлайн, управление остаётся за ним, и по его размеру
  // стартуют скрытые вкладки (resolveStartSize в ipc.js).
  const { own } = make();
  own.claim('c1', { cols: 90, rows: 30 });
  own.drop('c1');
  assert.deepStrictEqual(own.size(), { cols: 90, rows: 30 });
});

test('createOwnership работает без onChange', () => {
  const own = createOwnership();
  assert.strictEqual(own.claim('c1', { cols: 80, rows: 24 }), true);
  assert.strictEqual(own.owner(), 'c1');
});
