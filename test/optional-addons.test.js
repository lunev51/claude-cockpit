'use strict';
// Аддоны xterm по флагу конфига (ревью 09.08, C15).
//
// addon-webgl (~248 КБ) и addon-unicode11 (~52 КБ) грузились тегами index.html
// всегда, хотя обе фичи выключены по умолчанию (terminal.webgl:false,
// unicode11 не задан). По сети это ~300 КБ на каждую загрузку страницы
// браузером на макбуке — ради кода, который не исполняется. Теперь их грузит
// optional-addons.js из boot() — только по флагу и до первого терминала:
// terminal.js читает window.WebglAddon/window.Unicode11Addon синхронно при
// создании вкладки.
//
// Проверяется на четырёх уровнях — порознь любой можно обойти, оставив
// остальные зелёными:
//   1. разметка: двух тегов нет, обязательные на месте;
//   2. загрузчик на подделках: что грузит, когда молчит, как деградирует;
//   3. манифест загрузчика совпадает с тем, что читает terminal.js, а пути из
//      него НАСТОЯЩИЙ сервер на НАСТОЯЩЕЙ карте корней отдаёт как скрипт с
//      той самой глобалью;
//   4. boot() дожидается загрузки раньше, чем может появиться первый терминал.
const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createNetServer } = require('../src/main/net-server');
const { createCommandRegistry } = require('../src/main/command-registry');
const { createBroadcast } = require('../src/main/broadcast');
const { createOutputBuffer } = require('../src/main/output-buffer');
const { rendererStaticRoots } = require('../src/main/ipc');

const REPO = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(REPO, ...parts), 'utf8');
const modUrl = pathToFileURL(path.join(REPO, 'src', 'renderer', 'js', 'optional-addons.js')).href;

const INDEX_HTML = read('src', 'renderer', 'index.html');
const TERMINAL_JS = read('src', 'renderer', 'js', 'terminal.js');
const APP_JS = read('src', 'renderer', 'js', 'app.js');

// --- 1. разметка ---

test('index.html не грузит webgl и unicode11 статически, обязательные аддоны на месте', () => {
  const scripts = [...INDEX_HTML.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 5, `тегов script с src найдено ${scripts.length} — разбор расклеился с разметкой`);
  for (const lib of ['addon-webgl', 'addon-unicode11']) {
    assert.ok(!scripts.some((s) => s.includes(lib)), `${lib} снова грузится тегом на каждую загрузку страницы`);
  }
  // Эти terminal.js берёт безусловно — без них не создастся ни одна вкладка.
  for (const lib of ['xterm/lib/xterm.js', 'addon-fit', 'addon-web-links', 'addon-search', 'addon-serialize']) {
    assert.ok(scripts.some((s) => s.includes(lib)), `обязательный ${lib} пропал из index.html`);
  }
});

// --- 2. загрузчик на подделках ---

function fakeLoader({ fail = [], hang = [], noGlobal = [] } = {}) {
  const loaded = new Set();
  const calls = [];
  const warns = [];
  return {
    calls,
    warns,
    opts: {
      loadScript: (src) => {
        calls.push(src);
        if (hang.some((s) => src.includes(s))) return new Promise(() => {});
        if (fail.some((s) => src.includes(s))) return Promise.reject(new Error('404'));
        if (!noGlobal.some((s) => src.includes(s))) {
          loaded.add(src.includes('webgl') ? 'WebglAddon' : 'Unicode11Addon');
        }
        return Promise.resolve();
      },
      isLoaded: (name) => loaded.has(name),
      warn: (...a) => warns.push(a.join(' ')),
    },
  };
}

test('neededAddons: только флаг === true, как в terminal.js', async () => {
  const { neededAddons } = await import(modUrl);
  const flags = (cfg) => neededAddons(cfg).map((a) => a.flag);
  assert.deepStrictEqual(flags({ webgl: false }), [], 'умолчание config.js тянет аддоны');
  assert.deepStrictEqual(flags({}), []);
  assert.deepStrictEqual(flags(undefined), []);
  assert.deepStrictEqual(flags({ webgl: true }), ['webgl']);
  assert.deepStrictEqual(flags({ unicode11: true }), ['unicode11']);
  assert.deepStrictEqual(flags({ webgl: true, unicode11: true }).sort(), ['unicode11', 'webgl']);
  // terminal.js включает фичу только по === true: строка из руками
  // поправленного конфига аддон не включит — и грузить его незачем.
  assert.deepStrictEqual(flags({ webgl: 'true', unicode11: 1 }), []);
});

test('по умолчанию не грузится ничего', async () => {
  const { loadOptionalAddons } = await import(modUrl);
  const f = fakeLoader();
  const outcome = await loadOptionalAddons({ webgl: false }, f.opts);
  assert.deepStrictEqual(f.calls, [], 'выключенная фича всё равно качается');
  assert.deepStrictEqual(outcome, {});
  assert.deepStrictEqual(f.warns, []);
});

test('флаг включён — грузится ровно его аддон, оба флага — оба сразу', async () => {
  const { loadOptionalAddons } = await import(modUrl);
  let f = fakeLoader();
  assert.deepStrictEqual(await loadOptionalAddons({ webgl: true }, f.opts), { webgl: 'loaded' });
  assert.strictEqual(f.calls.length, 1);
  assert.match(f.calls[0], /addon-webgl\/lib\/addon-webgl\.js$/);

  f = fakeLoader();
  const both = loadOptionalAddons({ webgl: true, unicode11: true }, f.opts);
  // Параллельно, а не друг за другом: оба запроса ушли до первого ответа.
  assert.strictEqual(f.calls.length, 2, 'второй аддон ждёт первого — лишняя задержка до первого терминала');
  assert.deepStrictEqual(await both, { webgl: 'loaded', unicode11: 'loaded' });
});

test('уже загруженный аддон повторно не качается', async () => {
  const { loadOptionalAddons } = await import(modUrl);
  const f = fakeLoader();
  f.opts.isLoaded = () => true;
  assert.deepStrictEqual(await loadOptionalAddons({ webgl: true }, f.opts), { webgl: 'loaded' });
  assert.deepStrictEqual(f.calls, []);
});

test('отказ загрузки не роняет boot — предупреждение и работа без фичи', async () => {
  const { loadOptionalAddons } = await import(modUrl);
  const f = fakeLoader({ fail: ['webgl'] });
  const outcome = await loadOptionalAddons({ webgl: true, unicode11: true }, f.opts);
  assert.deepStrictEqual(outcome, { webgl: 'failed', unicode11: 'loaded' }, 'отказ одного аддона утащил второй');
  assert.strictEqual(f.warns.length, 1);
  assert.match(f.warns[0], /WebglAddon/);
});

test('скрипт загрузился, а глобали нет — это отказ, а не успех', async () => {
  const { loadOptionalAddons } = await import(modUrl);
  const f = fakeLoader({ noGlobal: ['unicode11'] });
  assert.deepStrictEqual(await loadOptionalAddons({ unicode11: true }, f.opts), { unicode11: 'failed' });
  assert.strictEqual(f.warns.length, 1);
  assert.match(f.warns[0], /Unicode11Addon/);
});

test('зависшая загрузка не держит boot дольше потолка', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { loadOptionalAddons, ADDON_WAIT_MS } = await import(modUrl);
  const f = fakeLoader({ hang: ['webgl'] });
  let outcome = null;
  const p = loadOptionalAddons({ webgl: true }, f.opts).then((o) => { outcome = o; });
  await Promise.resolve();
  t.mock.timers.tick(ADDON_WAIT_MS - 1);
  await Promise.resolve();
  assert.strictEqual(outcome, null, 'загрузчик сдался раньше потолка');
  t.mock.timers.tick(1);
  await p;
  assert.deepStrictEqual(outcome, { webgl: 'timeout' });
  assert.strictEqual(f.warns.length, 1);
  assert.ok(ADDON_WAIT_MS >= 1000 && ADDON_WAIT_MS <= 10000, `потолок ${ADDON_WAIT_MS} мс — либо не успеет по сети, либо держит boot`);
});

test('без подделки loadScript — тег <script> с путём манифеста в head, исход по onload/onerror', async () => {
  const { loadOptionalAddons, OPTIONAL_ADDONS } = await import(modUrl);
  const appended = [];
  globalThis.document = {
    createElement: (tag) => ({ tag }),
    head: { appendChild: (el) => { appended.push(el); } },
  };
  try {
    const present = new Set();
    const warns = [];
    const p = loadOptionalAddons({ webgl: true, unicode11: true }, {
      isLoaded: (n) => present.has(n), warn: (m) => warns.push(m),
    });
    assert.deepStrictEqual(
      appended.map((el) => [el.tag, el.src]),
      OPTIONAL_ADDONS.map((a) => ['script', a.src]),
      'в head ушли не те теги',
    );
    present.add(OPTIONAL_ADDONS[0].global);
    appended[0].onload();
    appended[1].onerror();
    assert.deepStrictEqual(await p, { [OPTIONAL_ADDONS[0].flag]: 'loaded', [OPTIONAL_ADDONS[1].flag]: 'failed' });
    // Предупреждение называет путь: 404 по сети и сменённое имя глобали в
    // сборке — разные поломки, и чинят их в разных местах.
    assert.strictEqual(warns.length, 1);
    assert.ok(warns[0].includes(`не загрузился ${OPTIONAL_ADDONS[1].src}`), `предупреждение без пути: ${warns[0]}`);
  } finally {
    delete globalThis.document;
  }
});

// --- 3. манифест против terminal.js и живого сервера ---

test('манифест загрузчика — ровно то, что terminal.js читает под своим флагом', async () => {
  const { OPTIONAL_ADDONS } = await import(modUrl);
  assert.deepStrictEqual(OPTIONAL_ADDONS.map((a) => a.flag).sort(), ['unicode11', 'webgl']);
  for (const { flag, global } of OPTIONAL_ADDONS) {
    // Флаг и глобаль в одном блоке terminal.js: if (cfg.<flag> === true) { … window.<global>.<global> … }
    const block = new RegExp(`if \\(cfg\\.${flag} === true\\) \\{[\\s\\S]{0,300}?window\\.${global}\\.${global}\\b`);
    assert.match(TERMINAL_JS, block, `terminal.js под флагом ${flag} читает не window.${global} — загрузчик качает не то`);
  }
});

test('путь манифеста ведёт к файлу и от file://-страницы Electron', async () => {
  // По сети '..' над корнем схлопывается: и '../', и '../../' от /index.html
  // дают /node_modules/..., так что серверная проверка ниже путь на уровень
  // короче не заметит. Electron же грузит index.html через loadFile (file://),
  // и там такой путь ведёт в src/node_modules — аддон не найдётся.
  const { OPTIONAL_ADDONS } = await import(modUrl);
  const { fileURLToPath } = require('node:url');
  const page = pathToFileURL(path.join(REPO, 'src', 'renderer', 'index.html'));
  for (const { src } of OPTIONAL_ADDONS) {
    const file = fileURLToPath(new URL(src, page));
    assert.ok(fs.existsSync(file), `${src} от file://-страницы ведёт в ${file} — такого файла нет`);
  }
});

let activeServers = [];
afterEach(async () => {
  const servers = activeServers;
  activeServers = [];
  await Promise.all(servers.map((s) => s.stop().catch(() => {})));
});

test('сервер отдаёт каждый путь манифеста как скрипт с нужной глобалью', async () => {
  const { OPTIONAL_ADDONS } = await import(modUrl);
  const server = createNetServer({
    registry: createCommandRegistry({ ipcMain: { handle: () => {}, on: () => {} } }),
    broadcast: createBroadcast({ getWindow: () => null }),
    outputBuffer: createOutputBuffer({}),
    // ТА ЖЕ карта корней, что у registerIpc (см. renderer-boot-guard.test.js).
    staticRoots: rendererStaticRoots(REPO),
    port: 0,
    host: '127.0.0.1',
  });
  activeServers.push(server);
  const { port } = await server.start();
  const base = `http://127.0.0.1:${port}`;
  for (const { src, global } of OPTIONAL_ADDONS) {
    // <script src> относительный — браузер разрешает его от адреса СТРАНИЦЫ
    // (index.html), а не модуля, как и статические теги до этой правки.
    const url = new URL(src, `${base}/index.html`).pathname;
    // eslint-disable-next-line no-await-in-loop
    const res = await fetch(base + url);
    assert.strictEqual(res.status, 200, `${url}: ${res.status} — аддон не доедет до браузера`);
    assert.match(res.headers.get('content-type') || '', /^text\/javascript\b/, `${url}: браузер не исполнит такой ответ`);
    // eslint-disable-next-line no-await-in-loop
    const body = await res.text();
    // UMD-шапка сборки: exports.X=t():e.X=t()}(globalThis — X и есть глобаль.
    const umd = body.slice(0, 400).match(/exports\.(\w+)=t\(\):e\.\1=t\(\)\}\(globalThis\b/);
    assert.ok(umd, `${url}: UMD-шапка не разобрана — сборка аддона сменила формат`);
    assert.strictEqual(umd[1], global, `${url} кладёт window.${umd[1]}, а ждут window.${global}`);
  }
});

// --- 4. boot ждёт загрузку до первого терминала ---

test('boot() дожидается аддонов после конфига и до первого терминала', () => {
  assert.match(APP_JS, /import\s*\{\s*loadOptionalAddons\s*\}\s*from\s*'\.\/optional-addons\.js'/, 'загрузчик не импортирован');
  const boot = APP_JS.slice(APP_JS.indexOf('async function boot()'));
  assert.ok(boot.length < APP_JS.length, 'в app.js не найдено async function boot() — страж разъехался');
  const cfgAt = boot.indexOf('config = await window.api.config.get()');
  const start = boot.match(/const (\w+) = loadOptionalAddons\(config\.terminal\)/);
  assert.ok(cfgAt !== -1, 'в boot не найдено чтение конфига');
  assert.ok(start, 'boot не запускает загрузку аддонов по config.terminal');
  const startAt = start.index;
  const awaitAt = boot.indexOf(`await ${start[1]}`);
  // Все пути к initTerminal (bootWorkspace, восстановление, «+ Проект», палитра)
  // требуют tabStore — его создание и есть рубеж «терминалов ещё нет».
  const storeAt = boot.indexOf('tabStore = createTabStore(');
  assert.ok(storeAt !== -1, 'в boot не найдено создание tabStore — страж разъехался');
  assert.ok(cfgAt < startAt, 'загрузка аддонов запущена до чтения конфига — флагов ещё нет');
  assert.ok(awaitAt !== -1, 'загрузку аддонов никто не ждёт — первый терминал создастся без WebglAddon');
  assert.ok(startAt < awaitAt && awaitAt < storeAt, 'ожидание аддонов стоит после создания tabStore — первый терминал может их не застать');
});
