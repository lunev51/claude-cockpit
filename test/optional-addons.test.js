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
//
// Рубеж — не какая-то одна строка boot(), а ВСЕ пути к initTerminal. Первая
// редакция стража брала за рубеж createTabStore («все пути требуют
// tabStore»), и это неправда: openTab/attachTab зовут initTerminal раньше,
// чем трогают tabStore, — подписка tabs.onChanged, поставленная выше
// ожидания, прошла бы мимо стража (ревью ветки, мутация выжила).
//
// Поэтому граф: какие функции верхнего уровня app.js транзитивно доходят до
// initTerminal(. Любое упоминание такой функции в boot() обязано стоять после
// `await <загрузка аддонов>` — и вызов (bootWorkspace), и подписка
// (tabs.onChanged → syncTabsFromMain), и колбэк при создании UI-объекта
// (createBrowse с openTab, createPalette с buildPaletteActions).
//
// Сами UI-объекты (browse, palette…) в граф НЕ входят: «+ Проект» и горячие
// клавиши доходят до терминала только через них, а до своего создания в boot
// они null — browse.open() бросит, palette?.open() промолчит, вкладка не
// появится. Сеть через упоминание объекта, наоборот, утянула бы в граф всё
// подряд (activateTab зовёт palette?.close()) и сделала бы правило
// невыполнимым. Поэтому раньше ожидания можно привязать кнопку или хоткей, но
// нельзя создать объект с колбэком на путь к терминалу.

// Комментарии и строки — до разбора: цитата кода в комментарии и строка
// '[boot] …' в логе выглядели бы как вызов.
const codeOnly = (src) => src
  .replace(/\/\/.*$/gm, '')
  .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, "''");

const mention = (name) => new RegExp(`(?<![.\\w$])${name.replace(/\$/g, '\\$')}\\b`, 'g');
const mentions = (body, name) => [...body.matchAll(mention(name))].map((m) => m.index);

// Узлы графа — объявления верхнего уровня (с колонки 0): function и
// const/let (обёртки вроде singleFlight(async () => …) тоже функции).
function topUnits(appCode) {
  const top = [];
  let cur = null;
  for (const line of appCode.split(/\r?\n/)) {
    const m = line.match(/^(?:async\s+)?function\s+([\w$]+)|^(?:const|let|var)\s+([\w$]+)/);
    if (m) { cur = { name: m[1] || m[2], body: '' }; top.push(cur); }
    if (cur) cur.body += `${line}\n`;
  }
  return top;
}

function reachingInitTerminal(top) {
  const reach = new Set(top.filter((u) => /(?<![.\w$])initTerminal\s*\(/.test(u.body)).map((u) => u.name));
  // boot — корень, его никто не зовёт; распространять от него нечего.
  const spreads = () => [...reach].filter((n) => n !== 'boot');
  for (let grown = true; grown;) {
    grown = false;
    for (const u of top) {
      if (!reach.has(u.name) && spreads().some((n) => mentions(u.body, n).length)) {
        reach.add(u.name);
        grown = true;
      }
    }
  }
  return reach;
}

test('boot() запускает аддоны после конфига, параллельно со шрифтом, и ждёт их до любого пути к initTerminal', () => {
  assert.match(APP_JS, /import\s*\{\s*loadOptionalAddons\s*\}\s*from\s*'\.\/optional-addons\.js'/, 'загрузчик не импортирован');
  const top = topUnits(codeOnly(APP_JS));
  const unit = (n) => {
    const found = top.find((x) => x.name === n);
    assert.ok(found, `в app.js не найдено объявление ${n} — страж разъехался`);
    return found.body;
  };
  const body = unit('boot');
  const cfgAt = body.indexOf('config = await window.api.config.get()');
  const start = body.match(/const (\w+) = loadOptionalAddons\(config\.terminal\)/);
  const fontAt = body.indexOf('await waitForFont(');
  assert.ok(cfgAt !== -1 && start && fontAt !== -1, 'в boot не найдены чтение конфига, запуск аддонов или ожидание шрифта — страж разъехался');
  const awaitAt = body.indexOf(`await ${start[1]};`);
  assert.ok(awaitAt !== -1, 'загрузку аддонов никто не ждёт — первый терминал создастся без WebglAddon');
  assert.ok(cfgAt < start.index, 'загрузка аддонов запущена до чтения конфига — флагов ещё нет');
  // Параллельность: аддоны уходят в сеть раньше, чем boot сядет ждать шрифт,
  // иначе их загрузка прибавится к его 3 с ожидания вместо того, чтобы идти
  // одновременно.
  assert.ok(start.index < fontAt, 'аддоны грузятся только после шрифта — их время прибавляется к ожиданию шрифта');

  const reach = reachingInitTerminal(top);
  // Страховка от холостого графа: эти пути к терминалу есть сегодня точно.
  for (const n of ['openTab', 'attachTab', 'syncTabsFromMain', 'bootWorkspace', 'buildPaletteActions', 'showRestoreOverlay']) {
    assert.ok(reach.has(n), `граф не видит путь к initTerminal через ${n} — разбор расклеился с app.js`);
  }
  // И UI-объекты с колбэками на терминал правило видит через их аргументы.
  for (const obj of ['browse', 'palette', 'historySearch']) {
    const at = body.search(new RegExp(`^ {2}${obj} = create\\w+\\(`, 'm'));
    assert.ok(at !== -1, `в boot не найдено создание ${obj} — страж разъехался`);
    const stmt = body.slice(at, body.indexOf('\n  });', at));
    assert.ok([...reach].some((n) => n !== 'boot' && mentions(stmt, n).length), `создание ${obj} не упоминает путь к терминалу — его ранний перенос правило не заметит`);
  }

  // До ожидания разрешены ровно эти: подписки эстафеты ставятся первым делом
  // (M1 ревью). До initTerminal они доходят только через bootWorkspace за
  // гейтом workspaceBootPending, а его поднимает лишь сам bootWorkspace (или
  // afterControlLost при открытом оверлее восстановления, который показывает
  // тоже он). Гейт проверяется ниже по коду, а не на слово.
  const GATED = new Set(['afterControlGained', 'claimControl']);
  const early = [];
  for (const n of reach) {
    if (n === 'boot' || GATED.has(n)) continue;
    for (const at of mentions(body, n)) if (at < awaitAt) early.push(n);
  }
  assert.deepStrictEqual(early, [], `boot() трогает путь к initTerminal до ожидания аддонов: ${early.join(', ')}`);

  const reachIn = (n) => [...reach].filter((r) => r !== n && r !== 'boot' && mentions(unit(n), r).length);
  assert.deepStrictEqual(reachIn('claimControl'), ['afterControlGained'], 'claimControl дошёл до терминала мимо гейта afterControlGained');
  assert.deepStrictEqual(reachIn('afterControlGained'), ['bootWorkspace'], 'afterControlGained дошёл до терминала мимо bootWorkspace');
  const gained = unit('afterControlGained');
  const gateAt = gained.search(/if \(!workspaceBootPending\) return;/);
  assert.ok(gateAt !== -1 && gateAt < gained.search(/(?<![.\w$])bootWorkspace\(/), 'afterControlGained зовёт bootWorkspace без гейта workspaceBootPending');
  const raisers = top.filter((x) => /workspaceBootPending\s*=\s*true/.test(x.body)).map((x) => x.name).sort();
  assert.deepStrictEqual(raisers, ['afterControlLost', 'bootWorkspace'], 'workspaceBootPending поднимает кто-то ещё — гейт больше не держит «до первого bootWorkspace»');
  const lost = unit('afterControlLost');
  assert.ok(lost.indexOf('if (!restoreOverlayDismiss) return;') < lost.search(/workspaceBootPending\s*=\s*true/), 'afterControlLost поднимает гейт без открытого оверлея восстановления');
  const dismissSetters = top.filter((x) => /restoreOverlayDismiss\s*=\s*\(/.test(x.body)).map((x) => x.name);
  assert.deepStrictEqual(dismissSetters, ['showRestoreOverlay'], 'оверлей восстановления взводится не только из showRestoreOverlay');
  assert.ok(reach.has('showRestoreOverlay'), 'showRestoreOverlay выпал из графа — его ранний вызов не будет пойман');
});
