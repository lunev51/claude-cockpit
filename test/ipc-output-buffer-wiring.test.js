'use strict';
// Important 1 (ревью задачи 4): проводка буфера вывода (наполнение на
// term:data, очистка на tabs:close) жила ИНЛАЙНОМ прямо внутри onEvent и
// обработчика tabs:close в ipc.js. Ревьюер вырезал обе строки и прогнал
// полный набор — 784 теста, 0 падений: смысл задачи 4 не в модуле
// output-buffer.js (он был покрыт отдельно), а именно в ЭТИХ ДВУХ ТОЧКАХ
// проводки. bufferTermData/dropTabOutputBuffer (ipc.js) — РОВНО те функции,
// которые registerIpc() зовёт из onEvent/tabs:close с реальным outputBuffer
// (см. комментарий у их определения в ipc.js) — тесты здесь зовут ту же
// самую реализацию, а не копию.
//
// ipc.js целиком (registerIpc) под node --test не поднимается — require('electron')
// вне настоящего Electron-рантайма не даёт объект (см. комментарий в шапке
// ipc-smoke-gate.test.js) — поэтому здесь, как и там, тестируются вынесенные
// функции напрямую, с фейковым outputBuffer вместо настоящего.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { bufferTermData, dropTabOutputBuffer } = require('../src/main/ipc');
const { createOutputBuffer } = require('../src/main/output-buffer');

test('bufferTermData: эмитим term:data — get() возвращает вывод', () => {
  const outputBuffer = createOutputBuffer({ maxBytes: 1024 });
  bufferTermData({
    channel: 'term:data',
    payload: { tabId: 'T1', data: 'привет из pty' },
    outputBuffer,
  });
  assert.strictEqual(outputBuffer.get('T1'), 'привет из pty');
});

test('bufferTermData: копит несколько событий term:data подряд, как реальный поток pty', () => {
  const outputBuffer = createOutputBuffer({ maxBytes: 1024 });
  bufferTermData({ channel: 'term:data', payload: { tabId: 'T1', data: 'первая часть ' }, outputBuffer });
  bufferTermData({ channel: 'term:data', payload: { tabId: 'T1', data: 'вторая часть' }, outputBuffer });
  assert.strictEqual(outputBuffer.get('T1'), 'первая часть вторая часть');
});

test('bufferTermData: прочие каналы onEvent (tab:status и т.п.) буфер не трогают', () => {
  const outputBuffer = createOutputBuffer({ maxBytes: 1024 });
  bufferTermData({ channel: 'tab:status', payload: { tabId: 'T1', status: 'working' }, outputBuffer });
  assert.strictEqual(outputBuffer.get('T1'), '');
});

test('dropTabOutputBuffer: закрываем вкладку — get() пуст', () => {
  const outputBuffer = createOutputBuffer({ maxBytes: 1024 });
  bufferTermData({ channel: 'term:data', payload: { tabId: 'T1', data: 'вывод до закрытия' }, outputBuffer });
  assert.notStrictEqual(outputBuffer.get('T1'), ''); // страховка: буфер реально был непустым до drop
  dropTabOutputBuffer({ tabId: 'T1', outputBuffer });
  assert.strictEqual(outputBuffer.get('T1'), '');
  assert.strictEqual(outputBuffer.totalBytes(), 0);
});

test('dropTabOutputBuffer: закрытие одной вкладки не трогает буфер других открытых', () => {
  const outputBuffer = createOutputBuffer({ maxBytes: 1024 });
  bufferTermData({ channel: 'term:data', payload: { tabId: 'T1', data: 'вкладка 1' }, outputBuffer });
  bufferTermData({ channel: 'term:data', payload: { tabId: 'T2', data: 'вкладка 2' }, outputBuffer });
  dropTabOutputBuffer({ tabId: 'T1', outputBuffer });
  assert.strictEqual(outputBuffer.get('T1'), '');
  assert.strictEqual(outputBuffer.get('T2'), 'вкладка 2');
});

// Ре-ревью (Important, НЕ закрыта первым фиксом): предыдущие тесты выше
// проверяют, что bufferTermData/dropTabOutputBuffer ведут себя верно как
// САМОСТОЯТЕЛЬНЫЕ функции — но не проверяют, что onEvent/tabs:close в
// ipc.js их РЕАЛЬНО зовут. Ре-ревьюер продемонстрировал матрицу диверсий:
// удаление САМОЙ СТРОКИ вызова из onEvent или из tabs:close, а также подмена
// вызова на захардкоженный tabId — НИ ОДНА не ловилась (809 pass). Приём —
// тот же, что test/command-registry.coverage.test.js уже использует для
// похожей проблемы (обработчик зарегистрирован не в реестре, а напрямую в
// ipcMain): читаем ИСХОДНЫЙ ТЕКСТ ipc.js и требуем, чтобы у каждой функции
// было МИНИМУМ ДВА вхождения её точной сигнатуры вызова — одно в
// `function ...(...) {` (определение), второе — в самой строке вызова
// (`...(...);`). Одно вхождение (осталось только определение) означает, что
// строку вызова вырезали или подменили на что-то другое (например, на
// захардкоженный tabId вместо реального payload/tabId) — оба случая меняют
// точный текст вызова и роняют счётчик обратно до 1.
const ipcSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ipc.js'), 'utf8');

function countOccurrences(text, substr) {
  return text.split(substr).length - 1;
}

test('проводка: bufferTermData зовётся из onEvent РОВНО с реальными channel/payload/outputBuffer (не только определена)', () => {
  const signature = 'bufferTermData({ channel, payload, outputBuffer })';
  const count = countOccurrences(ipcSrc, signature);
  // 1 = только определение функции (`function bufferTermData({ channel, payload, outputBuffer }) {`)
  // осталось голым — строку вызова из onEvent вырезали или подменили
  // (например, на захардкоженный tabId вместо реального payload).
  assert.ok(count >= 2, `в ipc.js только ${count} вхождение(й) "${signature}" — вызов из onEvent пропал или подменён (диверсии г/е ре-ревью)`);
});

test('проводка: dropTabOutputBuffer зовётся из tabs:close РОВНО с реальными tabId/outputBuffer (не только определена)', () => {
  const signature = 'dropTabOutputBuffer({ tabId, outputBuffer })';
  const count = countOccurrences(ipcSrc, signature);
  assert.ok(count >= 2, `в ipc.js только ${count} вхождение(й) "${signature}" — вызов из tabs:close пропал или подменён (диверсия д ре-ревью)`);
});

// Ревью 09.08 (TDZ). outputBuffer объявлялся на ~200 строк НИЖЕ замыкания
// onEvent, которое его зовёт. Сегодня это работает только потому, что ни одно
// событие не приходит синхронно в этом промежутке, то есть корректность держится
// на тайминге, а не на коде: правка, эмитящая term:data синхронно при создании
// менеджера сессий, дала бы ReferenceError на старте ВСЕГО приложения — и
// только в проде, потому что registerIpc под node --test не запускается.
// Ровно от этого класса broadcast в своё время подняли в начало registerIpc
// (см. комментарий у его объявления), для outputBuffer приём не применили.
//
// Проверяем текстом: объявление обязано идти РАНЬШЕ первого использования.
// Жалоба 05.11: подключившийся клиент получал сырой хвост 256 КБ, и у вкладки,
// долго крутившей спиннер, пропадали рамки и статус-бар (полная перерисовка
// ConPTY ушла за хвост). Теперь история — зеркало экрана (screen-mirror.js),
// и смысл держится на двух вещах в registerIpc, которые под node --test не
// исполняются: что создаётся именно зеркало, и что его размер — размер pty
// из менеджера. sizeOf, всегда отдающий null, тихо выключил бы зеркало
// целиком: push ничего не пишет, клиент видит пустой экран.
test('история вкладок в registerIpc — зеркало экрана с размером pty из manager.size (жалоба 05.11)', () => {
  const code = ipcSrc.split(/\r?\n/).filter((line) => !line.trim().startsWith('//')).join('\n');
  const declarations = [...code.matchAll(/const outputBuffer = (\w+)\((\{[^\n]*\})\);/g)];
  assert.strictEqual(declarations.length, 1, `объявлений outputBuffer в коде ipc.js: ${declarations.length}, ждали одно — страж разъехался с исходником`);
  const [, factory, options] = declarations[0];
  assert.strictEqual(factory, 'createTabHistory', `история вкладок снова ${factory} — клиент получит сырой хвост вместо экрана`);
  assert.match(
    options,
    /^\{ sizeOf: \(tabId\) => \(manager \? manager\.size\(tabId\) : null\) \}$/,
    `размер зеркала берётся не из manager.size: ${options}`,
  );
  // Импорт — тоже только текстом: ipc.js под тестом загружается, но
  // registerIpc не исполняется, и пропавший require дал бы ReferenceError
  // лишь в проде, на старте всего приложения (мутация «удалить require»
  // без этой строки выживала).
  assert.match(code, /^const \{ createTabHistory \} = require\('\.\/screen-mirror'\);$/m, 'createTabHistory не импортирован в ipc.js');
});

test('outputBuffer и broadcast объявлены раньше, чем ими пользуются замыкания', () => {
  const start = ipcSrc.indexOf('function registerIpc(');
  assert.notStrictEqual(start, -1, 'не найдена registerIpc — страж разъехался с исходником');

  // Обе позиции — НОМЕРА СТРОК и обе с одинаковой зачисткой комментариев.
  // Замечание ревью фикса: сначала объявление искалось сырым indexOf, а
  // употребление — с пропуском комментариев. В этом файле комментарии
  // регулярно цитируют код дословно, так что комментарий с текстом
  // объявления выше первого употребления делал стража слепым ровно к той
  // мине, ради которой он написан.
  const lines = ipcSrc.slice(start).split(/\r?\n/);
  const codeOf = (line) => line.replace(/^\s*\/\/.*/, '').replace(/\/\/.*$/, '');

  for (const [name, declaration] of [
    ['outputBuffer', 'const outputBuffer = createTabHistory('],
    ['broadcast', 'const broadcast = createBroadcast('],
  ]) {
    let declaredLine = -1;
    let firstUseLine = -1;
    for (let i = 0; i < lines.length; i += 1) {
      const code = codeOf(lines[i]);
      if (declaredLine === -1 && code.includes(declaration)) { declaredLine = i; continue; }
      // Имя как часть другого идентификатора (outputBufferSize) тоже считаем
      // употреблением: ложная тревога здесь громкая и дешёвая, а пропуск
      // настоящей мины стоит падения приложения на старте.
      if (firstUseLine === -1 && code.includes(name)) firstUseLine = i;
      if (declaredLine !== -1 && firstUseLine !== -1) break;
    }

    assert.notStrictEqual(declaredLine, -1, `в registerIpc не найдено объявление ${name}`);
    if (firstUseLine === -1) continue; // имя больше нигде не используется

    assert.ok(
      declaredLine < firstUseLine,
      `${name} используется раньше своего объявления (TDZ-мина): объявление на строке ${declaredLine} `
      + `тела registerIpc, первое употребление — на ${firstUseLine}. Синхронный вызов такого замыкания `
      + 'уронил бы старт всего приложения, и только в проде — registerIpc под node --test не запускается.',
    );
  }
});
