'use strict';
// Каскады выхода: каждый шаг сам по себе (ревью 09.08, C25).
//
// disposeSessions (ipc.js) и обработчики выхода (main.js) — цепочки вызовов
// без единого try/catch. Исключение в любом звене (ночная смена, мост хуков)
// обрывало всё, что ниже: manager.disposeAll() не доходил до живых
// claude.exe, stt.dispose() — до whisper-server, и они переживали кокпит.
// runSteps гонит каждый шаг в своём try/catch; эти тесты держат и сам
// механизм, и то, что каскады действительно идут через него.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { runSteps } = require('../src/main/run-steps');

test('упавший шаг не обрывает каскад, а попадает в лог со своей меткой', () => {
  const ran = [];
  const logged = [];
  const boom = new Error('ночная смена упала');
  runSteps([
    ['first', () => ran.push('first')],
    ['second', () => { ran.push('second'); throw boom; }],
    ['third', () => ran.push('third')],
  ], (label, err) => logged.push([label, err]));

  assert.deepStrictEqual(ran, ['first', 'second', 'third'], 'шаг после упавшего не выполнен — живые процессы остались бы сиротами');
  assert.strictEqual(logged.length, 1, 'лог должен получить ровно один сбой');
  assert.strictEqual(logged[0][0], 'second', 'в лог ушла не та метка — по логу не понять, какой шаг выхода упал');
  assert.strictEqual(logged[0][1], boom, 'в лог ушла не та ошибка');
});

test('без сбоев лог молчит, шаги идут по порядку', () => {
  const ran = [];
  const logged = [];
  runSteps([
    ['a', () => ran.push('a')],
    ['b', () => ran.push('b')],
  ], (label) => logged.push(label));
  assert.deepStrictEqual(ran, ['a', 'b']);
  assert.deepStrictEqual(logged, []);
});

test('сломанный лог тоже не обрывает каскад', () => {
  // Лог на выходе — console.error в процесс, у которого вывод уже мог
  // закрыться. Логгер, бросивший на первом сбое, иначе сделал бы ровно то,
  // от чего runSteps защищает: остальные шаги не выполнились бы.
  const ran = [];
  runSteps([
    ['bad', () => { throw new Error('x'); }],
    ['after', () => ran.push('after')],
  ], () => { throw new Error('лог упал'); });
  assert.deepStrictEqual(ran, ['after']);
});

// --- проводка: каскады действительно идут через runSteps ---------------------

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', 'src', 'main', ...parts), 'utf8');

// Комментарии выкидываем: у шагов каскада подробные комментарии с именами
// тех же вызовов («рядом с nightWatch.dispose() выше»). Страж, читающий их,
// остался бы зелёным после удаления самого вызова.
const codeOnly = (source) => source
  .split(/\r?\n/)
  .filter((line) => !/^\s*\/\//.test(line))
  .map((line) => line.replace(/\s\/\/\s.*$/, ''))
  .join('\n');

// Текст от `start` (позиция открывающей скобки) до парной закрывающей, со
// скобками. Строки в кавычках пропускаем — в них бывают скобки.
function balanced(text, start) {
  const open = text[start];
  const close = { '(': ')', '[': ']', '{': '}' }[open];
  assert.ok(close, `ожидалась открывающая скобка в позиции ${start}`);
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\'' || ch === '"' || ch === '`') {
      const end = text.indexOf(ch, i + 1);
      assert.notStrictEqual(end, -1, 'незакрытая строка');
      i = end;
    } else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  assert.fail(`не найдена парная скобка для позиции ${start}`);
}

// Элементы массива шагов верхнего уровня: '[[a, f], [b, g]]' → ['[a, f]', '[b, g]'].
function stepsOf(callText) {
  const arrStart = callText.indexOf('[');
  assert.notStrictEqual(arrStart, -1, 'runSteps зовётся без массива шагов');
  const arr = balanced(callText, arrStart);
  const items = [];
  let i = 1;
  while (i < arr.length - 1) {
    const next = arr.indexOf('[', i);
    if (next === -1 || next >= arr.length - 1) break;
    const item = balanced(arr, next);
    items.push(item);
    i = next + item.length;
  }
  return items;
}

// Тело функции верхнего уровня: от объявления до закрывающей скобки в начале строки.
function topLevelBody(source, signature, file) {
  const start = source.indexOf(signature);
  assert.notStrictEqual(start, -1, `в ${file} не найдено «${signature}» — страж разъехался с исходником`);
  const rest = source.slice(start);
  const end = rest.search(/\n\}/);
  assert.notStrictEqual(end, -1, `не найден конец «${signature}» в ${file}`);
  return rest.slice(0, end);
}

// Каждый опасный вызов — внутри runSteps и в СВОЁМ шаге. Два вызова в одном
// шаге — снова каскад: сбой первого молча отменяет второй.
function assertEachInOwnStep(body, calls, where) {
  const at = body.indexOf('runSteps(');
  assert.notStrictEqual(at, -1, `${where} не идёт через runSteps — одно исключение снова обрывает весь выход`);
  const call = balanced(body, at + 'runSteps'.length);
  const outside = body.slice(0, at) + body.slice(at + 'runSteps'.length + call.length);
  const steps = stepsOf(call);
  const owners = new Map();
  for (const c of calls) {
    assert.ok(!outside.includes(c), `${where}: ${c} зовётся мимо runSteps — его сбой оборвёт выход`);
    const idx = steps.findIndex((s) => s.includes(c));
    assert.notStrictEqual(idx, -1, `${where}: ${c} пропал из шагов выхода`);
    assert.ok(
      !owners.has(idx),
      `${where}: ${c} и ${owners.get(idx)} в одном шаге — сбой первого молча отменит второй`,
    );
    owners.set(idx, c);
  }
}

test('disposeSessions гасит каждого держателя процессов отдельным шагом', () => {
  const body = topLevelBody(codeOnly(read('ipc.js')), 'function disposeSessions(', 'ipc.js');
  assertEachInOwnStep(body, [
    'usagePoller.stop()',
    'nightWatch.dispose()',
    'stt.dispose()',
    'stopBridge',
    'manager.disposeAll()',
    'runners.killAllTracked()',
  ], 'disposeSessions');
});

test('flushWorkspace отрезает запись манифеста, даже если flush упал', () => {
  // Каскад теперь идёт дальше упавшего шага: если flush() бросит, а
  // markQuitting() не выполнится, disposeSessions закроет вкладки, и каждое
  // закрытие запишет в pending всё более пустой список — второй flush на
  // before-quit сохранил бы пустой воркспейс вместо вчерашнего.
  const body = topLevelBody(codeOnly(read('ipc.js')), 'function flushWorkspace(', 'ipc.js');
  assert.match(
    body,
    /try\s*\{\s*wsync\.flush\(\);?\s*\}\s*finally\s*\{\s*wsync\.markQuitting\(\);?\s*\}/,
    'markQuitting() не в finally после flush(): упавший flush оставит манифест открытым для пустого списка',
  );
});

test('выход из main.js идёт через один каскад шагов', () => {
  const code = codeOnly(read('main.js'));
  const body = topLevelBody(code, 'function teardown(', 'main.js');
  assertEachInOwnStep(body, [
    'destroyTray',
    'flushWorkspace',
    'disposeSessions',
    'netServer.stop()',
  ], 'teardown');

  // Три двери выхода, и каждая обязана пройти через teardown — а не через
  // свою копию цепочки, где первый же сбой снова обрывает остальное.
  const doors = [
    ["app.on('window-all-closed'", 'app.quit()'],
    ["app.on('before-quit'", null],
    ["process.on('uncaughtException'", 'app.exit(1)'],
  ];
  for (const [door, last] of doors) {
    const start = code.indexOf(door);
    assert.notStrictEqual(start, -1, `в main.js не найден обработчик «${door}»`);
    const handler = code.slice(start, start + code.slice(start).search(/\n\}\);/));
    const t = handler.indexOf('teardown()');
    assert.notStrictEqual(t, -1, `${door}: выход идёт мимо teardown()`);
    for (const direct of ['flushWorkspace()', 'disposeSessions()', 'netServer.stop()']) {
      assert.ok(!handler.includes(direct), `${door}: ${direct} зовётся напрямую, мимо каскада шагов`);
    }
    if (last) {
      const q = handler.indexOf(last);
      assert.ok(q > t, `${door}: ${last} должен идти ПОСЛЕ teardown() — иначе выход случится до уборки`);
    }
  }
});
