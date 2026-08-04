'use strict';
// Страж браузерного пути загрузки страницы. Тот же жанр, что
// test/broadcast-guard.test.js (прямой webContents.send мимо broadcast) и
// test/command-registry.coverage.test.js (прямой ipcMain мимо реестра):
// читает исходники и требует инварианта, который иначе держится только на
// комментарии.
//
// Зачем (I1 финального ревью ветки): ревьюер прогнал по ветке девять диверсий,
// и СЕМЬ из них оставили все 856 тестов зелёными:
//   1. import './api-boot.js' перестал быть ПЕРВЫМ импортом app.js
//   2. импорт api-boot.js удалён вовсе
//   3. условие if (!window.api) инвертировано
//   4. мост стучится не в /ws
//   5. тег script с app.js удалён из index.html
//   6. .js отдаётся как text/plain
//   7. корень /node_modules убран из staticRoots
// Первая — это ровно тот Critical задачи 6, который стоил отдельного круга
// ревью и был доказан в живом Chromium (независимый <script type="module"> НЕ
// дожидается top-level await соседнего модуля; импорт — дожидается). Смоук
// поймать ничего из этого не может по построению: в Electron window.api даёт
// preload, и ветка сборки сетевого моста не выполняется вовсе.
//
// Проверки 1-4 — сканом исходников. Проверка «типы файлов и состав корней
// статики покрывают всё, на что ссылается разметка» — НАСТОЯЩИМ сервером на
// НАСТОЯЩЕЙ карте корней (rendererStaticRoots из ipc.js, та же функция, что
// зовёт registerIpc), потому что любая её копия в тесте разъехалась бы с
// продом молча.
const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createNetServer } = require('../src/main/net-server');
const { createCommandRegistry } = require('../src/main/command-registry');
const { createBroadcast } = require('../src/main/broadcast');
const { createOutputBuffer } = require('../src/main/output-buffer');
const { rendererStaticRoots } = require('../src/main/ipc');

const REPO = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(REPO, ...parts), 'utf8');

const APP_JS = read('src', 'renderer', 'js', 'app.js');
const API_BOOT_JS = read('src', 'renderer', 'js', 'api-boot.js');
const INDEX_HTML = read('src', 'renderer', 'index.html');
const NET_SERVER_JS = read('src', 'main', 'net-server.js');
const TERMINAL_JS = read('src', 'renderer', 'js', 'terminal.js');

// --- 1. порядок загрузки моста ---

test('первый импорт app.js — api-boot.js (иначе window.api не готов к первой же строке boot)', () => {
  // Комментарии в проекте однострочные и начинаются с '//' — строка, целиком
  // начинающаяся с ключевого слова import, всегда настоящий импорт.
  const firstImport = APP_JS.split(/\r?\n/).find((line) => /^\s*import\s/.test(line));
  assert.ok(firstImport, 'в app.js не осталось ни одного import — разбор расклеился с форматом файла');
  assert.match(
    firstImport.trim(),
    /^import\s+['"]\.\/api-boot\.js['"];?$/,
    `первым импортом app.js должен быть './api-boot.js', а стоит: ${firstImport.trim()}. `
    + 'ES-модули исполняют импортируемые модули ДО тела импортирующего — только это и гарантирует, '
    + 'что top-level await внутри api-boot.js успеет собрать window.api до первой строки boot() '
    + '(ревью задачи 6, Critical 1, доказано в живом Chromium)',
  );
});

test('api-boot.js собирает мост ТОЛЬКО когда window.api ещё не собран preload’ом', () => {
  assert.match(
    API_BOOT_JS,
    /if\s*\(\s*!\s*window\.api\s*\)/,
    'гейт `if (!window.api)` пропал или инвертирован: с инверсией мост либо не строится в браузере '
    + '(страница пустая), либо перетирает мост preload в Electron',
  );
});

test('браузерный мост стучится в тот же путь сокета, который слушает сервер', () => {
  const inBoot = API_BOOT_JS.match(/new WebSocket\(`[^`]*\$\{location\.host\}([^`]*)`\)/);
  assert.ok(inBoot, 'в api-boot.js не найдена сборка адреса сокета от location.host');
  const onServer = NET_SERVER_JS.match(/path:\s*'(\/[^']*)'/);
  assert.ok(onServer, 'в net-server.js не найден путь WebSocket-сервера (path: ...)');
  assert.strictEqual(
    inBoot[1],
    onServer[1],
    'мост и сервер разошлись путём сокета — страница загрузится, а window.api не соберётся никогда',
  );
});

// --- 1a. подключение не поднимает процесс мёртвой вкладке ---
//
// Important (ре-ревью фикс-волны): подключение переиспользует обычный путь
// создания терминала, а тот звал term.start БЕЗУСЛОВНО — и sessions.js/start()
// на вкладке без живого процесса делал spawn. Живьём: вкладка была
// alive:false, после подключения браузера стала alive:true с новым процессом.
// Спавн уходил БЕЗ --resume (флаг одноразовый, уже израсходован), то есть
// вместо продолжения работы поднималась чистая новая сессия, а старая
// терялась — подключение вело себя хуже штатного Ctrl+Shift+R.
//
// Решение проверяется на трёх уровнях: сам предикат, его использование в
// app.js и гард внутри terminal.js. Порознь любой из трёх можно обойти,
// оставив два других зелёными.

test('shouldStartPty: процесс поднимаем ТОЛЬКО живой вкладке', async () => {
  const { shouldStartPty } = await import('../src/renderer/js/attach-guards.js');
  assert.strictEqual(shouldStartPty({ tabId: 'T1', alive: true }), true, 'живой вкладке term.start нужен — иначе её ввод навсегда заблокирован');
  assert.strictEqual(shouldStartPty({ tabId: 'T1', alive: false }), false, 'мёртвой вкладке спавн из подключения теряет её сессию');
  // Поле могло не доехать (старый main, урезанный ответ) — цена ошибки
  // несимметрична, поэтому «не знаю» = «не стартовать».
  assert.strictEqual(shouldStartPty({ tabId: 'T1' }), false);
  assert.strictEqual(shouldStartPty({ tabId: 'T1', alive: 'yes' }), false);
  assert.strictEqual(shouldStartPty(null), false);
  assert.strictEqual(shouldStartPty(undefined), false);
});

test('attachTab передаёт решение shouldStartPty в initTerminal (а не стартует безусловно)', () => {
  assert.match(
    APP_JS,
    /autoStart:\s*shouldStartPty\(t\)/,
    'подключение снова стартует pty безусловно: мёртвая вкладка получит чистую новую сессию БЕЗ --resume, '
    + 'а её собственная потеряется',
  );
  assert.match(APP_JS, /import\s+\{\s*shouldStartPty\s*\}\s+from\s+'\.\/attach-guards\.js'/, 'предикат больше не импортируется — значение autoStart взялось откуда-то ещё');
});

test('terminal.js просит поднять pty только под гардом autoStart', () => {
  const starts = [...TERMINAL_JS.matchAll(/window\.api\.term\.start\s*\(/g)];
  assert.strictEqual(starts.length, 1, `window.api.term.start встречается ${starts.length} раз(а) — гард стоит перед ОДНИМ вызовом, второй пройдёт мимо него`);
  assert.match(
    TERMINAL_JS,
    /if\s*\(\s*autoStart\s*\)[\s\S]{0,200}?window\.api\.term\.start\s*\(/,
    'вызов term.start больше не под `if (autoStart)` — подключение снова будет поднимать процесс мёртвым вкладкам',
  );
});

// --- 2. разметка ---

test('index.html подключает приложение модульным тегом script', () => {
  assert.match(
    INDEX_HTML,
    /<script\s+type="module"\s+src="\.\/js\/app\.js"\s*>\s*<\/script>/,
    'тег с app.js пропал из index.html — страница откроется полностью пустой, '
    + 'и ни один тест кроме этого об этом не скажет',
  );
});

// --- 3. статика: живой сервер на настоящей карте корней ---

// Ожидаемый тип содержимого по расширению. Отдельно от MIME-карты сервера
// НАРОЧНО: если сверять карту саму с собой, диверсия «.js как text/plain»
// правит обе стороны разом и остаётся зелёной.
const EXPECTED_TYPE = {
  '.html': /^text\/html\b/,
  '.js': /^text\/javascript\b/,
  '.css': /^text\/css\b/,
  '.woff2': /^font\/woff2\b/,
  '.png': /^image\/png\b/,
  '.svg': /^image\/svg\+xml\b/,
  '.json': /^application\/json\b/,
};

// Ссылки разметки: src=... и href=... Внешние схемы и якоря пропускаем —
// сервер за них не отвечает (в текущем index.html их и нет, CSP запрещает).
function markupRefs(html) {
  return [...html.matchAll(/(?:src|href)\s*=\s*"([^"]+)"/g)]
    .map((m) => m[1])
    .filter((ref) => !/^(?:https?:|data:|#|\/\/)/.test(ref));
}

// Ссылки внутри CSS: @import url(...) и src: url(...). Шрифт лежит в
// /assets — то есть отдельный корень статики проверяется именно отсюда.
function cssRefs(css) {
  return [...css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)]
    .map((m) => m[1])
    .filter((ref) => !/^(?:https?:|data:)/.test(ref));
}

let activeServers = [];
afterEach(async () => {
  const servers = activeServers;
  activeServers = [];
  await Promise.all(servers.map((s) => s.stop().catch(() => { /* мог быть остановлен телом теста */ })));
});

test('сервер отдаёт КАЖДЫЙ файл, на который ссылается разметка, с правильным типом содержимого', async () => {
  const server = createNetServer({
    registry: createCommandRegistry({ ipcMain: { handle: () => {}, on: () => {} } }),
    broadcast: createBroadcast({ getWindow: () => null }),
    outputBuffer: createOutputBuffer({}),
    // ТА ЖЕ функция, которую зовёт registerIpc() — не копия карты корней.
    staticRoots: rendererStaticRoots(REPO),
    port: 0,
    host: '127.0.0.1',
  });
  activeServers.push(server);
  const { port } = await server.start();
  const base = `http://127.0.0.1:${port}`;

  // Обход в ширину: страница → её ссылки → ссылки внутри полученных CSS.
  // Браузер схлопывает '..' сам (../../node_modules/... → /node_modules/...) —
  // new URL делает ровно то же самое, поэтому на провод уходит тот же путь,
  // что и от настоящего Chromium.
  const seen = new Set();
  const queue = ['/index.html'];
  const checked = [];

  while (queue.length) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);

    const ext = path.extname(url.split('?')[0]).toLowerCase();
    assert.ok(
      EXPECTED_TYPE[ext],
      `разметка ссылается на ${url} — расширение ${ext} не описано ни в MIME-карте сервера, `
      + 'ни в ожиданиях этого теста; добавить надо в оба места',
    );

    // eslint-disable-next-line no-await-in-loop
    const res = await fetch(base + url);
    assert.strictEqual(res.status, 200, `${url}: сервер ответил ${res.status} — файл не отдаётся (корень статики или сам файл пропал)`);
    const type = res.headers.get('content-type') || '';
    assert.match(
      type,
      EXPECTED_TYPE[ext],
      `${url}: тип содержимого «${type}» — браузер откажется исполнять/применять такой ответ`,
    );
    checked.push(url);

    if (ext === '.html' || ext === '.css') {
      // eslint-disable-next-line no-await-in-loop
      const body = await res.text();
      const refs = ext === '.html' ? markupRefs(body) : cssRefs(body);
      for (const ref of refs) queue.push(new URL(ref, base + url).pathname);
    }
  }

  // Страховка от ложного зелёного: если регулярки разъедутся с форматом
  // файлов, обход схлопнется в один /index.html и тест «пройдёт», ничего не
  // проверив. На момент написания живой обход даёт 15 файлов.
  assert.ok(
    checked.length >= 12,
    `обход нашёл всего ${checked.length} файлов (${checked.join(', ')}) — разбор ссылок расклеился с разметкой`,
  );
  // Оба префиксных корня действительно участвуют, а не «настроены на всякий
  // случай»: xterm приезжает из /node_modules, шрифт — из /assets.
  assert.ok(checked.some((u) => u.startsWith('/node_modules/')), 'ни одна ссылка не ушла в корень /node_modules');
  assert.ok(checked.some((u) => u.startsWith('/assets/')), 'ни одна ссылка не ушла в корень /assets');

  await server.stop();
});
