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
