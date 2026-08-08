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
function fakeDoc({ execOk = true } = {}) {
  const calls = { created: [], appended: 0, removed: 0, exec: [], selected: 0 };
  return {
    calls,
    createElement(tag) {
      calls.created.push(tag);
      return {
        style: {},
        value: '',
        setAttribute() {},
        focus() {},
        select() { calls.selected += 1; },
        setSelectionRange() {},
        remove() { calls.removed += 1; },
      };
    },
    body: { appendChild() { calls.appended += 1; } },
    execCommand(cmd) { calls.exec.push(cmd); return execOk; },
  };
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
