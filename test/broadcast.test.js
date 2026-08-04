'use strict';
// Одна точка исходящих событий. До неё события уходили прямыми
// win.webContents.send из нескольких мест — сетевому клиенту пришлось бы
// перехватывать каждое, и любое новое место молча прошло бы мимо сети.
const test = require('node:test');
const assert = require('node:assert');
const { createBroadcast } = require('../src/main/broadcast');

const fakeWin = () => {
  const sent = [];
  return { sent, isDestroyed: () => false, webContents: { send: (c, p) => sent.push([c, p]) } };
};

test('emit доставляет и в окно, и в сетевых клиентов', () => {
  const win = fakeWin();
  const b = createBroadcast({ getWindow: () => win });
  const got = [];
  b.addClient((c, p) => got.push([c, p]));

  b.emit('tab:status', { tabId: 'T1', status: 'working' });

  assert.deepStrictEqual(win.sent, [['tab:status', { tabId: 'T1', status: 'working' }]]);
  assert.deepStrictEqual(got, [['tab:status', { tabId: 'T1', status: 'working' }]]);
});

test('уничтоженное окно не роняет рассылку — сетевые клиенты получают событие', () => {
  const win = fakeWin();
  win.isDestroyed = () => true;
  const b = createBroadcast({ getWindow: () => win });
  const got = [];
  b.addClient((c) => got.push(c));

  b.emit('term:data', { tabId: 'T1', data: 'привет' });

  assert.deepStrictEqual(win.sent, [], 'в мёртвое окно не пишем');
  assert.deepStrictEqual(got, ['term:data']);
});

test('падение одного клиента не мешает остальным', () => {
  // Оборванный сокет бросает на запись. Один упавший макбук не должен
  // останавливать поток вывода в локальное окно и другие клиенты.
  const win = fakeWin();
  const b = createBroadcast({ getWindow: () => win });
  const got = [];
  b.addClient(() => { throw new Error('сокет закрыт'); });
  b.addClient((c) => got.push(c));

  b.emit('tab:status', {});

  assert.deepStrictEqual(got, ['tab:status']);
  assert.strictEqual(win.sent.length, 1);
});

test('removeClient отписывает', () => {
  const b = createBroadcast({ getWindow: () => fakeWin() });
  const got = [];
  const fn = (c) => got.push(c);
  b.addClient(fn);
  b.removeClient(fn);
  b.emit('tab:status', {});
  assert.deepStrictEqual(got, []);
  assert.strictEqual(b.clientCount(), 0);
});

test('окна нет вовсе (сервер без интерфейса) — не падаем', () => {
  const b = createBroadcast({ getWindow: () => null });
  const got = [];
  b.addClient((c) => got.push(c));
  b.emit('tab:status', {});
  assert.deepStrictEqual(got, ['tab:status']);
});

// Ре-ревью задачи 3 (мелочь): try/catch вокруг win.webContents.send и
// [...clients] были заявлены комментариями, но ни один тест их не проверял —
// мутация, снимающая try/catch (или копию набора), проходила зелёной. Два
// теста ниже закрывают ровно эти два инварианта.
test('send в окно бросает — сетевые клиенты всё равно получают событие', () => {
  const win = fakeWin();
  win.webContents.send = () => { throw new Error('окно уходит между проверкой и отправкой'); };
  const b = createBroadcast({ getWindow: () => win });
  const got = [];
  b.addClient((c) => got.push(c));

  b.emit('tab:status', { tabId: 'T1' });

  assert.deepStrictEqual(got, ['tab:status'], 'падение send() в окно не должно останавливать рассылку клиентам');
});

test('клиент отписывает ДРУГОГО клиента прямо во время emit — тот всё равно получает ТЕКУЩЕЕ событие', () => {
  // [...clients] снимает копию набора ДО обхода: отписка, случившаяся из
  // колбэка (например, второй клиент решил отвалиться сам или его отписал
  // первый), не должна вырезать его из уже идущей рассылки — только из
  // следующей.
  const b = createBroadcast({ getWindow: () => fakeWin() });
  const got = [];
  const second = (c) => got.push(c);
  b.addClient(() => b.removeClient(second));
  b.addClient(second);

  b.emit('tab:status', {});

  assert.deepStrictEqual(got, ['tab:status'], 'second должен получить это же событие, несмотря на отписку в процессе');
  assert.strictEqual(b.clientCount(), 1, 'но на СЛЕДУЮЩИЙ emit second уже не позовётся — отписка сработала');
});
