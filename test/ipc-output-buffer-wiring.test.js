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
