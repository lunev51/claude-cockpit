'use strict';
// Шов «сколько каналов зарегистрировано» ↔ «сколько попало в реестр».
// Забытая команда не ломает локальный кокпит и потому незаметна — она молча
// не работает только по сети.
//
// Ревью 09.08 нашло у этого стража ДВА люфта, оба закрыты ниже:
//   1) он читал ТОЛЬКО ipc.js, тогда как симметричный broadcast-guard обходит
//      весь src/main. Прямой ipcMain.handle в main.js (где electron и так
//      импортирован) проходил мимо обоих тестов — а такой канал не только
//      мёртв по сети, он ещё и обходит гард владения, который живёт внутри
//      createCommandRegistry: локальное окно смогло бы писать в обход
//      эстафеты;
//   2) порог «не меньше 43» был точным числом на момент написания, а сейчас
//      каналов 49 — то есть до шести регистраций можно было удалить, и
//      прогон оставался зелёным. Порог заменён сверкой с формой api.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const MAIN_DIR = path.join(__dirname, '..', 'src', 'main');
const src = fs.readFileSync(path.join(MAIN_DIR, 'ipc.js'), 'utf8');

// Имена каналов нужны только для реестровой стороны. Формы вызова:
// handle/handleOnce/on/once — все четыре кладут обработчик на канал; кавычки
// '/"/` — все три допустимые в JS для строкового литерала.
//
// Important (ревью задачи 2): регэксп ловил канал ТОЛЬКО в одинарных кавычках —
// `handle("net:secret", ...)` в двойных (или в обратных) молча проходил бы
// мимо. Линтера, принуждающего к единому стилю кавычек, в проекте нет.
function channelsCalledOn(obj, text) {
  const re = new RegExp(`\\b${obj}\\.(handle|handleOnce|on|once)\\(\\s*['"\`]([^'"\`]+)['"\`]`, 'g');
  return [...text.matchAll(re)].map((m) => m[2]);
}

// Строки кода без комментариев: и реестровая сверка, и поиск обходов должны
// смотреть на живой код. Закомментированная `// registry.handle('x', …)`
// иначе замаскировала бы удаление настоящей регистрации.
function codeLines(text) {
  return text.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
}

// Единственный файл, которому положено звать ipcMain напрямую: там это и есть
// реализация реестра.
const REGISTRY_FILE = 'command-registry.js';

// Стражу имя канала не нужно — нужен ФАКТ прямого вызова. Поэтому здесь, в
// отличие от реестровой сверки, литерал не требуется: замечание ревью фикса —
// требование кавычки на той же строке пропускало и перенос по длине строки
// (`ipcMain.handle(\n  'x:y', …`), и канал-переменную (`ipcMain.handle(CH, …)`).
// Тот же приём, что у CALL_RE в broadcast-guard.test.js.
const DIRECT_CALL_RE = /\bipcMain\.(handle|handleOnce|on|once|addListener|prependListener)\s*\(/;

test('прямых ipcMain.handle/on нет НИГДЕ в src/main, кроме самого реестра', () => {
  const violations = [];
  for (const name of fs.readdirSync(MAIN_DIR)) {
    if (!name.endsWith('.js') || name === REGISTRY_FILE) continue;
    const text = fs.readFileSync(path.join(MAIN_DIR, name), 'utf8');
    // Построчно и без строк-комментариев — тот же приём, что в
    // broadcast-guard.test.js: в кодовой базе ipcMain упоминается в
    // пояснительных комментариях.
    text.split('\n').forEach((line, i) => {
      if (line.trim().startsWith('//')) return;
      if (DIRECT_CALL_RE.test(line)) violations.push(`${name}:${i + 1}`);
    });
  }
  assert.deepStrictEqual(
    violations, [],
    `здесь ipcMain зовут напрямую, мимо реестра — такой канал мёртв по сети И обходит гард владения:\n${violations.join('\n')}`,
  );
});

test('форма api и реестр совпадают поимённо', async () => {
  // Сверка с ФОРМОЙ API вместо порога-числа: удаление любой регистрации
  // краснеет поимённо, а не «стало на одну меньше, но всё ещё больше сорока
  // трёх».
  //
  // Исключений нет намеренно. Первая редакция выводила из сверки net:buffer
  // как «живёт только на сервере» — и это была ошибка: сетевой сервер
  // перехватывает его до реестра, но в ipc.js есть И реестровый обработчик,
  // обслуживающий локальную перезагрузку renderer при живом main. Исключение
  // прикрыло бы его удаление, то есть завело новый люфт вместо закрытого.
  // То же и с owner:claim/owner:get: у них две половины, локальная — в реестре.
  const { API_SHAPE } = await import('../src/renderer/js/api-shape.js');
  const viaRegistry = new Set(channelsCalledOn('registry', codeLines(src)));

  const missing = [];
  const commandChannels = new Set();
  for (const [name, spec] of Object.entries(API_SHAPE)) {
    if (spec.kind === 'event') continue; // события идут через broadcast, не через реестр
    commandChannels.add(spec.channel);
    if (!viaRegistry.has(spec.channel)) missing.push(`${name} (${spec.channel})`);
  }
  assert.deepStrictEqual(
    missing, [],
    `эти команды объявлены в форме api, но не зарегистрированы в ipc.js — по сети они мертвы:\n${missing.join('\n')}`,
  );

  // Обратная сторона: канал в реестре, которого нет в форме api, недостижим ни
  // из браузера, ни из локального окна (preload сверяется с формой в обе
  // стороны — см. net-api.test.js), то есть это сирота после неполного
  // удаления команды.
  const extras = [...viaRegistry].filter((c) => !commandChannels.has(c));
  assert.deepStrictEqual(
    extras, [],
    `эти каналы зарегистрированы, но в форме api их нет — позвать их некому:\n${extras.join('\n')}`,
  );
});

test('канал не регистрируется дважды', () => {
  const viaRegistry = channelsCalledOn('registry', codeLines(src));
  const seen = new Set();
  const dupes = viaRegistry.filter((c) => (seen.has(c) ? true : (seen.add(c), false)));
  assert.deepStrictEqual(dupes, [], `эти каналы зарегистрированы дважды: ${dupes.join(', ')}`);
});
