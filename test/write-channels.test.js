'use strict';
// Классификация каналов для эстафеты. Главный тест здесь — не «term:write
// запрещён», а ПОЛНОТА: канал, забытый при добавлении новой команды, обязан
// ронять сборку, а не тихо получать право писать в чужой терминал.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  isWriteChannel, WRITE_CHANNELS, FREE_CHANNELS,
} = require('../src/main/write-channels');

// api-shape.js — ES-модуль renderer'а; из CommonJS-теста он доступен только
// динамическим import() (тот же приём, что в net-api.test.js).
const shapeUrl = pathToFileURL(
  path.join(__dirname, '..', 'src', 'renderer', 'js', 'api-shape.js'),
).href;

test('ввод в терминал требует управления, чтение — нет', () => {
  assert.strictEqual(isWriteChannel('term:write'), true);
  assert.strictEqual(isWriteChannel('term:resize'), true);
  assert.strictEqual(isWriteChannel('tabs:open'), true);
  assert.strictEqual(isWriteChannel('queue:add'), true);
  assert.strictEqual(isWriteChannel('stt:transcribe'), true);
  assert.strictEqual(isWriteChannel('usage:get'), false);
  assert.strictEqual(isWriteChannel('net:buffer'), false);
  assert.strictEqual(isWriteChannel('tabs:list'), false);
});

test('невладелец не портит данные и настройки владельца', () => {
  // Ревью нашло это живьём: config:set от невладельца возвращал ok:true и
  // менял конфиг, а через terminal.command подменяется команда, которой
  // владелец поднимет следующую вкладку.
  assert.strictEqual(isWriteChannel('config:set'), true);
  assert.strictEqual(isWriteChannel('recipes:deletePrompt'), true);
  assert.strictEqual(isWriteChannel('recipes:deleteWorkspace'), true);
  assert.strictEqual(isWriteChannel('recipes:savePrompt'), true);
  assert.strictEqual(isWriteChannel('recipes:saveWorkspace'), true);
  // Переписывает .claude/settings.json в проекте владельца.
  assert.strictEqual(isWriteChannel('project:connect'), true);
  // Ночная смена сама вбрасывает промпты в чужие вкладки.
  assert.strictEqual(isWriteChannel('night:toggle'), true);
});

test('невладелец не открывает окон на машине владельца', () => {
  // Системный диалог выбора папки открывался бы поверх окна, которое в этот
  // момент спрятано в трей, — модалка там, где никого нет.
  assert.strictEqual(isWriteChannel('tabs:chooseFolder'), true);
  assert.strictEqual(isWriteChannel('shell:openExternal'), true);
  assert.strictEqual(isWriteChannel('app:devtools'), true);
});

test('чтение остаётся свободным — иначе заглушка слепая', () => {
  // Это ровно то, ради чего невладельцу вообще показывают интерфейс.
  for (const channel of [
    'config:get', 'tabs:list', 'net:buffer', 'usage:get', 'usage:refresh',
    'night:get', 'git:get', 'gh:repo', 'gh:global', 'history:search',
    'recipes:list', 'recipes:listWorkspaces', 'workspace:get', 'project:status',
    'ghost:load', 'stt:status', 'tabs:seen',
  ]) {
    assert.strictEqual(isWriteChannel(channel), false, `${channel} должен быть свободен`);
  }
});

test('захват управления невладельцу не запрещён — иначе его не забрать', () => {
  assert.strictEqual(isWriteChannel('owner:claim'), false);
  assert.strictEqual(isWriteChannel('owner:get'), false);
});

test('обзор файловой системы — чтение, доступен и невладельцу', () => {
  // Смотреть каталоги может кто угодно: это чтение, и на машине владельца
  // ничего не меняет. Спека фазы прямо говорит, что скрывать имена папок от
  // вошедшего бессмысленно — у него и так полный доступ к терминалу.
  // А вот завести вкладку из обзора — уже пишущее действие.
  assert.strictEqual(isWriteChannel('fs:list'), false);
  assert.strictEqual(isWriteChannel('fs:drives'), false);
  assert.strictEqual(isWriteChannel('tabs:open'), true);
});

test('неизвестный канал считается пишущим', () => {
  // Осторожная сторона по умолчанию: незнакомое имя скорее что-то меняет.
  assert.strictEqual(isWriteChannel('никогдатакогонебыло'), true);
});

test('списки не пересекаются', () => {
  const both = [...WRITE_CHANNELS].filter((c) => FREE_CHANNELS.has(c));
  assert.deepStrictEqual(both, [], 'канал не может быть одновременно и там, и там');
});

test('КАЖДЫЙ канал формы api классифицирован', async () => {
  const { API_SHAPE } = await import(shapeUrl);
  const missing = [];
  for (const [name, spec] of Object.entries(API_SHAPE)) {
    if (spec.kind === 'event') continue; // события идут в обратную сторону
    if (!WRITE_CHANNELS.has(spec.channel) && !FREE_CHANNELS.has(spec.channel)) {
      missing.push(`${name} (${spec.channel})`);
    }
  }
  assert.deepStrictEqual(
    missing, [],
    'новый канал не отнесён ни к пишущим, ни к свободным — допишите его в write-channels.js',
  );
});
