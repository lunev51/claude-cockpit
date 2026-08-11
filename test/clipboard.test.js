'use strict';
// Копирование в буфер обмена из терминала. Живая жалоба 09.08: «command+V даёт
// вставку, но я не могу копировать текст в окне кокпита с мака».
//
// Причина та же, что была у вставки, только зеркальная: страница на макбуке
// отдаётся по http, а Clipboard API живёт лишь в защищённом контексте — там
// navigator.clipboard попросту НЕ СУЩЕСТВУЕТ. Прежний код звал
// navigator.clipboard.writeText(...).catch(() => {}), то есть обращался к
// свойству undefined: исключение синхронное, и .catch его не ловит. Копирование
// падало совершенно молча, включая copyOnSelect и правый клик.
//
// Запасной путь — execCommand('copy') через временное поле. Он объявлен
// устаревшим, но работает в незащищённом контексте, и другого способа для
// http-страницы нет.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const url = pathToFileURL(
  path.join(__dirname, '..', 'src', 'renderer', 'js', 'clipboard.js'),
).href;

// Минимальный поддельный документ: ровно то, чем пользуется запасной путь.
// activeElement/contains добавлены под возврат фокуса (ревью 09.08, B2): без
// них ветка восстановления не исполнялась вовсе, и мутация «захватить фокус
// ПОСЛЕ area.focus()» — то есть запомнить само временное поле и потерять
// настоящего владельца — оставалась зелёной.
function fakeDoc({ execOk = true, activeElement = null, живВDOM = true } = {}) {
  const calls = {
    created: [], appended: 0, removed: 0, exec: [], selected: 0, restored: 0,
  };
  const doc = {
    calls,
    activeElement,
    createElement(tag) {
      calls.created.push(tag);
      const area = {
        style: {},
        value: '',
        setAttribute() {},
        focus() { doc.activeElement = area; },
        select() { calls.selected += 1; },
        setSelectionRange() {},
        remove() { calls.removed += 1; },
      };
      return area;
    },
    body: { appendChild() { calls.appended += 1; } },
    contains() { return живВDOM; },
    execCommand(cmd) { calls.exec.push(cmd); return execOk; },
  };
  return doc;
}

// Тот, у кого копирование забирает фокус: считает, сколько раз его вернули.
function фокусируемый(doc) {
  const el = {
    focus() {
      doc.calls.restored += 1;
      doc.activeElement = el;
    },
  };
  return el;
}

test('когда Clipboard API есть — пользуемся им', async () => {
  const { copyText } = await import(url);
  const written = [];
  const doc = fakeDoc();
  const ok = await copyText('привет', {
    clipboard: { writeText: async (t) => { written.push(t); } },
    doc,
  });
  assert.strictEqual(ok, true);
  assert.deepStrictEqual(written, ['привет']);
  assert.deepStrictEqual(doc.calls.exec, [], 'запасной путь трогать незачем');
});

test('без Clipboard API копируем запасным путём', async () => {
  // Ровно случай макбука: страница по http, navigator.clipboard отсутствует.
  const { copyText } = await import(url);
  const doc = fakeDoc();
  const ok = await copyText('привет', { clipboard: undefined, doc });
  assert.strictEqual(ok, true);
  assert.deepStrictEqual(doc.calls.exec, ['copy']);
  assert.strictEqual(doc.calls.selected, 1, 'без выделения копировать нечего');
  assert.strictEqual(doc.calls.removed, 1, 'временное поле обязано убраться');
});

test('отказ Clipboard API тоже уводит на запасной путь', async () => {
  // API есть, но отказал: нет разрешения, документ не в фокусе.
  const { copyText } = await import(url);
  const doc = fakeDoc();
  const ok = await copyText('привет', {
    clipboard: { writeText: async () => { throw new Error('Document is not focused'); } },
    doc,
  });
  assert.strictEqual(ok, true);
  assert.deepStrictEqual(doc.calls.exec, ['copy']);
});

test('когда не сработало ничего — говорим false, а не бросаем', async () => {
  const { copyText } = await import(url);
  const doc = fakeDoc({ execOk: false });
  const ok = await copyText('привет', { clipboard: undefined, doc });
  assert.strictEqual(ok, false);
  assert.strictEqual(doc.calls.removed, 1, 'поле убирается даже при неудаче');
});

test('пустой текст не трогает буфер обмена', async () => {
  const { copyText } = await import(url);
  const doc = fakeDoc();
  const written = [];
  for (const empty of ['', null, undefined]) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await copyText(empty, { clipboard: { writeText: async (t) => written.push(t) }, doc });
    assert.strictEqual(ok, false);
  }
  assert.deepStrictEqual(written, []);
  assert.deepStrictEqual(doc.calls.exec, []);
});

test('временное поле убирается, даже если execCommand бросил', async () => {
  const { copyText } = await import(url);
  const doc = fakeDoc();
  doc.execCommand = () => { throw new Error('нельзя'); };
  const ok = await copyText('привет', { clipboard: undefined, doc });
  assert.strictEqual(ok, false);
  assert.strictEqual(doc.calls.removed, 1, 'иначе поле останется висеть в DOM');
});

// === возврат фокуса (ревью 09.08, B2) ======================================
//
// Запасной путь фокусирует временное поле — иначе execCommand нечего
// копировать. Если фокус не вернуть, он падает на body: клавиатура перестаёт
// попадать в терминал, пока человек не кликнет мышью. Бьёт это по основному
// сетевому сценарию (по http Clipboard API нет, а «копировать выделением»
// включено по умолчанию), то есть ввод терялся после каждого выделения мышью.

// === жалоба при отказе (11.08) =============================================
//
// copyText честно возвращает false, но в terminal.js этот false не смотрел
// никто: человек выделял текст, ничего не происходило, и нигде — ни тоста, ни
// строчки. Тот же класс, что B3 в api-boot.js. Репортёр добавляет жалобу и
// глушилку для «копировать выделением»: xterm зовёт onSelectionChange на каждое
// изменение выделения, за одну протяжку — десятки раз.

test('удачное копирование молчит', async () => {
  const { createCopyReporter } = await import(url);
  const сказано = [];
  const copyOrComplain = createCopyReporter({
    copy: async () => true,
    notify: (t) => сказано.push(t),
  });
  assert.strictEqual(await copyOrComplain('привет'), true);
  assert.deepStrictEqual(сказано, [], 'успех не повод беспокоить человека');
});

test('провал копирования виден человеку', async () => {
  // copy асинхронный НАРОЧНО: без await результат — Promise, всегда истинный,
  // и жалоба не прозвучит никогда (мина, на которой уже ловили B3).
  const { createCopyReporter } = await import(url);
  const сказано = [];
  const copyOrComplain = createCopyReporter({
    copy: async () => false,
    notify: (t) => сказано.push(t),
  });
  assert.strictEqual(await copyOrComplain('привет'), false);
  assert.strictEqual(сказано.length, 1, 'отказ копирования обязан быть слышен');
  assert.match(сказано[0], /скопировать/i);
});

test('копирование выделением не спамит жалобами, но и не глохнет навсегда', async () => {
  const { createCopyReporter } = await import(url);
  const сказано = [];
  let время = 1000;
  const copyOrComplain = createCopyReporter({
    copy: async () => false,
    notify: (t) => сказано.push(t),
    now: () => время,
    quietMs: 10000,
  });

  await copyOrComplain('раз', { throttle: true });
  await copyOrComplain('два', { throttle: true });
  время += 5000;
  await copyOrComplain('три', { throttle: true });
  assert.strictEqual(сказано.length, 1, 'одна протяжка мышью — одна жалоба, а не десятки');

  время += 6000; // окно тишины вышло
  await copyOrComplain('четыре', { throttle: true });
  assert.strictEqual(сказано.length, 2, 'через окно тишины отказ снова обязан быть слышен');
});

test('явное действие жалуется каждый раз', async () => {
  // Cmd+C и правый клик — человек нажал и ждёт результата: молчать нельзя даже
  // один раз, глушилка тут не к месту.
  const { createCopyReporter } = await import(url);
  const сказано = [];
  const время = 1000;
  const copyOrComplain = createCopyReporter({
    copy: async () => false,
    notify: (t) => сказано.push(t),
    now: () => время,
  });
  await copyOrComplain('раз');
  await copyOrComplain('два');
  assert.strictEqual(сказано.length, 2, 'каждое нажатие обязано получить ответ');
});

test('фокус возвращается тому, у кого его забрали', async () => {
  const { copyText } = await import(url);
  const doc = fakeDoc();
  const владелец = фокусируемый(doc);
  doc.activeElement = владелец;

  const ok = await copyText('привет', { clipboard: undefined, doc });

  assert.strictEqual(ok, true);
  assert.strictEqual(doc.calls.restored, 1, 'фокус не вернулся — ввод уйдёт в body');
  assert.strictEqual(doc.activeElement, владелец, 'фокус остался на удалённом временном поле');
});

test('фокус возвращается и когда копирование не удалось', async () => {
  const { copyText } = await import(url);
  const doc = fakeDoc({ execOk: false });
  const владелец = фокусируемый(doc);
  doc.activeElement = владелец;

  const ok = await copyText('привет', { clipboard: undefined, doc });

  assert.strictEqual(ok, false);
  assert.strictEqual(doc.calls.restored, 1, 'при неудаче фокус тоже обязан вернуться');
});

test('исчезнувшему из DOM владельцу фокус не навязываем', async () => {
  // Прежний владелец мог быть удалён, пока шло копирование (закрыли оверлей,
  // перерисовали сайдбар). Тогда возвращать фокус некому — и focus() на
  // оторванном узле только увёл бы его в никуда.
  const { copyText } = await import(url);
  const doc = fakeDoc({ живВDOM: false });
  const владелец = фокусируемый(doc);
  doc.activeElement = владелец;

  await copyText('привет', { clipboard: undefined, doc });

  assert.strictEqual(doc.calls.restored, 0, 'фокус вернули элементу, которого уже нет в документе');
});
