'use strict';
// HTTP-статика + WebSocket: через них кокпит открывается на другой машине.
//
// Статика — ТОТ ЖЕ src/renderer, без правок разметки. Проверено на живом
// браузере: ссылка ../../node_modules/... из index.html схлопывается в
// /node_modules/..., поэтому достаточно отдать нужные корни (renderer,
// node_modules, assets — см. задачу 7).
//
// Протокол намеренно примитивный: кадр-запрос с id, кадр-ответ с тем же id,
// кадр-событие без id. Ничего, кроме JSON, — отлаживается глазами в консоли
// браузера.
//
// История правок — в комментариях у конкретных мест, не здесь: раунд 1
// закрыл traversal/percent-encoding/CORS, раунд 2 — падение процесса на
// занятом порту и зависание stop(), раунд 3 — DNS-rebinding в проверке Origin.
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

// Кэширование статики. Раньше заголовков не было вовсе, и вшитый шрифт
// терминала (JetBrainsMono NF, 1 МБ) браузер на макбуке качал заново на
// каждой загрузке страницы — xterm успевал измерить ячейку по запасному
// шрифту, и статус-бар Claude Code уезжал за край (план «размер терминала»).
//
// Шрифты и картинки меняются только с обновлением самого кокпита — неделя.
// Всё остальное (разметка, скрипты, стили, json, карты) — no-cache: браузер
// хранит копию, но КАЖДЫЙ раз перепроверяет её по ETag. Старый app.js после
// обновления не залипает, а перепроверка без изменений — пустой 304.
const LONG_CACHE = new Set(['.woff2', '.ico', '.png', '.svg']);

function cacheControlFor(file) {
  return LONG_CACHE.has(path.extname(file).toLowerCase()) ? 'max-age=604800' : 'no-cache';
}

// Слабая метка из размера и времени изменения — тот же приём, что у
// express/serve-static: хэш содержимого потребовал бы читать файл на каждую
// перепроверку. Обновление файла меняет mtime, а с ним и метку.
function etagFor(stat) {
  return `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
}

// If-None-Match: список меток через запятую или «*»; сравнение слабое
// (RFC 9110 §13.1.2) — префикс W/ не учитывается.
function etagMatches(header, etag) {
  if (typeof header !== 'string' || !header) return false;
  const bare = (tag) => tag.trim().replace(/^W\//, '');
  const want = bare(etag);
  return header.split(',').some((tag) => tag.trim() === '*' || bare(tag) === want);
}

// Разбираем URL-путь на сегменты по ЛЮБОМУ разделителю ('/' или '\'), а не
// только по '/'. Причина: итоговый path.join() всё равно работает с
// ОС-семантикой, а на Windows он трактует '\' как разделитель независимо от
// того, что мы «думали» об URL. Если резать только по '/', обратный слэш в
// декодированном пути проскакивает мимо разбора одним сегментом-как-есть и
// на path.join снова превращается в переход по каталогу — проверено:
// '/foo/..\\..\\..\\KEYS.md' без такого разбора улетает вплоть до C:\.
function splitSegments(p) {
  return p.split(/[/\\]+/);
}

// Гасим '.' и '..' вручную, сегмент за сегментом, не давая уйти выше начала
// списка. pop() на пустом массиве и без охраны ничего не делает (не
// бросает) — отдельная проверка перед ним была бессмысленной. Это
// единственный источник защиты от traversal: она работает ДО path.join, а
// не проверяется постфактум строкой startsWith (та проверка добавляла
// ложное чувство безопасности, но реальной работы не делала).
//
// Сегмент с ':' отбрасываем целиком (не как файл, не как проход): на NTFS
// синтаксис 'файл::$DATA' читает тот же файл через альтернативный поток —
// за корень это не выводит, но обходит определение MIME-типа по расширению
// и обойдёт любой будущий фильтр, завязанный на path.extname.
//
// ВАЖНО: эта функция — только для ПУТИ ЗАПРОСА (недоверенный ввод). Для
// префиксов staticRoots ниже используется отдельная splitPrefixSegments —
// без запрета на ':' и без схлопывания '..'. Раньше здесь была одна функция
// на оба случая, и префикс с ':' (пусть и маловероятный, но валидный ключ
// объекта) тихо получал prefixSegs === null и навсегда переставал
// совпадать — корень умирал без единой ошибки в логе. Доверенная
// конфигурация не должна страдать от защиты, рассчитанной на чужой ввод.
function collapseSegments(segments) {
  const out = [];
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    if (seg.includes(':')) return null;
    out.push(seg);
  }
  return out;
}

// Префикс staticRoots — часть кода/конфига, не запроса: не подчищаем '..'
// (в нём его и не будет) и не отбрасываем ':' — просто убираем пустые
// сегменты, чтобы сравнение по сегментам ниже совпадало 1-в-1 с тем, что
// даёт collapseSegments на пути запроса.
function splitPrefixSegments(prefix) {
  return splitSegments(prefix).filter((seg) => seg !== '' && seg !== '.');
}

// '0.0.0.0' и '::' — адрес «слушать на всех интерфейсах», а не имя, по
// которому реально пришёл запрос. Включить их в белый список Host означало
// бы разрешить буквально любой заголовок Host, который умеет подделать
// кто угодно, — то есть выключить проверку целиком именно тогда, когда
// сервер слушает шире всего.
const LISTEN_ANYWHERE = new Set(['0.0.0.0', '::', '::0']);

// Потолок размера ВХОДЯЩЕГО кадра. Библиотека ws по умолчанию разрешает
// 100 МиБ — на машине с 8 ГБ ОЗУ это неприемлемо: один кадр держит в памяти
// сырой буфер, его копию строкой и результат JSON.parse, то есть кратно
// больше самого кадра. Отправить такой может и сбойный клиент, и честная
// вставка гигантского текста в терминал браузера.
//
// 16 МиБ выбраны с запасом к самому тяжёлому ЗАКОННОМУ кадру.
// Самый тяжёлый — ghost:save: снимок скроллбека вкладки, serialize({scrollback:
// 2000}) в terminal.js, то есть 2000 строк с escape-последовательностями
// (главный ограничитель — GHOST_MAX_BYTES в ipc.js режет уже принятое до
// 512 КБ). Реальный тяжёлый буфер — единицы МБ; патологический (truecolor на
// каждую клетку) подходит к потолку вплотную, и это осознанно: обрыв такого
// кадра не теряет работу, а своп теряет всю машину. Второй по весу —
// вставка текста в term:write.
//
// Голосовой WAV в расчёт НЕ входит: по сети он не ездит вовсе (JSON.stringify
// от ArrayBuffer даёт {}), это отдельная поломка голоса в браузере — см.
// docs/review-fable-2026-08-09.md.
//
// Превышение не теряет работу: ws закрывает соединение кодом 1009, клиент
// переподключается сам (reconnectLoop в api-boot.js) и получает текущий экран
// вкладки через net:buffer — тот же путь, что при любом обрыве связи.
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

// Каналы, которые сервер обслуживает сам, до реестра, — то есть МИМО гарда
// владения. Поэтому сюда можно только каналы из FREE_CHANNELS
// (write-channels.js). Список один и явный (C3 ревью): onFrame перехватывает
// только по нему, а тесты требуют SERVER_CHANNELS ⊂ FREE_CHANNELS и не дают
// прочесть канал кадра в обход списка — раньше перехват жил цепочкой if, и
// новый ('net:exec') проходил мимо всех тестов.
const SERVER_CHANNELS = new Set(['net:buffer', 'owner:claim', 'owner:get']);

// Белый список Host и проверка Origin — чистые функции уровня модуля, а не
// замыкания createNetServer: так их видит тест (C5 ревью). Поведение на
// порту 80 настоящим сервером не проверить — порт привилегированный или
// занят, а именно там браузер шлёт Host без порта.

// Литерал IPv6 в заголовке Host/URI ОБЯЗАН быть в квадратных скобках
// (RFC 3986) — браузер шлёт 'Host: [::1]:порт', а не '::1:порт'. Без
// обёртки адрес Tailscale IPv6 (выдаётся всегда, кроме IPv4) отрезал бы
// браузер целиком, оставляя рабочим только заход по localhost. Признак
// «это IPv6, а не DNS-имя с портом внутри» — двоеточие в самом имени:
// легитимное DNS-имя/allowedHosts-запись их не содержит (формат — см.
// комментарий у allowedHosts ниже), так что эвристика безопасна.
function bracketed(name) {
  return name.includes(':') && !name.startsWith('[') ? `[${name}]` : name;
}

function withPort(name, boundPort) {
  return `${bracketed(name)}:${boundPort}`;
}

// C5 ревью: порт по умолчанию для схемы браузер в Host и Origin не пишет
// (http://имя/ → 'Host: имя'), и на port: 80 белый список из одних
// 'имя:80' отклонял каждый апгрейд. Голое имя добавляем ТОЛЬКО для 80:
// сервер без TLS, 443 значил бы https-фронт, а Origin https:// ниже
// отклоняется всё равно. Защиту от DNS-rebinding это не ослабляет — в
// списке те же разрешённые имена, меняется лишь запись порта.
const DEFAULT_HTTP_PORT = 80;

// Белый список Host собирается ОДИН раз, когда становится известен
// реальный порт (после listen — port:0 отдаёт эфемерный). Источники:
// сам host конфигурации (кроме 0.0.0.0/:: — «везде», не имя), 127.0.0.1
// и localhost всегда, и необязательный allowedHosts — доп. имена. Он
// нужен, потому что к машине приходят и по IP, и по имени в тайлнете
// одновременно, а в конфиге записан обычно один адрес: без allowedHosts
// человек пропишет IP, зайдёт по имени — и получит тот же отказ, который
// мы чиним, только с другой стороны.
//
// Формат каждой записи (host и элементы allowedHosts) — ГОЛОЕ имя или
// адрес, БЕЗ порта и без квадратных скобок вокруг IPv6 (те добавляются
// здесь сами): 'cockpit-desktop.tailXXXX.ts.net', '100.120.245.85',
// 'fd7a:115c::1'. Порт в значении ('example.com:9999') не отрезается —
// такая запись просто никогда не совпадёт, это на совести того, кто
// писал конфиг, а не повод гадать, что имелось в виду.
function buildHostAllowlist(boundPort, { host, allowedHosts } = {}) {
  const names = new Set(['127.0.0.1', 'localhost']);
  // Пробелы по краям и 0.0.0.0/:: — источник МОЛЧАЛИВО мёртвой записи:
  // валидацию (это просто непустая строка) значение проходит, но никогда
  // ни с чем не совпадёт. Фильтр общий для host и allowedHosts — раньше
  // 0.0.0.0 отсекался только для host, а в allowedHosts проходил как есть.
  const addName = (raw) => {
    if (!raw) return;
    const trimmed = String(raw).trim();
    if (!trimmed || LISTEN_ANYWHERE.has(trimmed)) return;
    names.add(trimmed);
  };
  addName(host);
  for (const extra of allowedHosts || []) addName(extra);
  const list = new Set();
  for (const name of names) {
    const lower = name.toLowerCase();
    list.add(withPort(lower, boundPort));
    if (boundPort === DEFAULT_HTTP_PORT) list.add(bracketed(lower));
  }
  return list;
}

// Разрешаем подключаться только странице, реально загруженной С ЭТОГО
// сервера. Без этой проверки любая вкладка, открытая в браузере на том же
// ПК, могла бы подключиться к сокету и вызвать ЛЮБУЮ команду реестра —
// включая запись в терминал. WebSocket не подчиняется CORS/same-origin
// сам по себе, это надо проверять руками на этапе апгрейда.
//
// DNS-rebinding: заголовок Host целиком контролирует клиент — браузер
// ставит туда то имя, по которому его отправили, а не то, куда реально
// подключился TCP-сокет. Атака: домен атакующего с коротким TTL сначала
// указывает на его сервер (страница грузится и открывает ws на то же
// имя), затем DNS перепривязывается на адрес кокпита — Origin и Host
// совпадают, ОБА равны вредоносному имени. Проверка «Origin == Host» в
// одиночку это ПРОПУСКАЕТ: оба совпадают именно потому, что оба
// подделаны. Поэтому Host сверяется с белым списком ПЕРВЫМ (имя, которое
// мы реально ожидаем), и только потом Origin — с уже проверенным Host.
//
// Origin отсутствует — не браузер (тестовый клиент, будущий нативный
// инструмент): пропускаем. Подделать сам заголовок со страницы браузер
// не даёт, риск именно в случаях, когда Origin ЕСТЬ и он чужой.
function isAllowedOrigin(origin, requestHost, hostAllowlist) {
  if (!origin) return true;
  if (!requestHost || !hostAllowlist.has(requestHost.toLowerCase())) return false;
  let originUrl;
  try { originUrl = new URL(origin); } catch { return false; }
  // Сервер не поднимает TLS: Origin со схемой https:// не может быть
  // «нами», даже если имя и порт совпали — сравнение host было бы верным
  // технически, но перестало бы означать «страницу отдали мы же».
  if (originUrl.protocol !== 'http:') return false;
  return originUrl.host.toLowerCase() === requestHost.toLowerCase();
}

// ownership — необязательный параметр: без него сервер работает ровно как
// раньше (эстафеты нет, каждый кадр идёт в реестр как есть).
// maxFrameBytes вынесен в параметры ради теста: слать настоящие 16 МиБ, чтобы
// проверить потолок, — само по себе то расточительство, от которого потолок и
// защищает.
function createNetServer({
  registry, ownership, broadcast, outputBuffer, staticRoots, port = 48300, host = '127.0.0.1', allowedHosts = [],
  maxFrameBytes = MAX_FRAME_BYTES,
}) {
  let server = null;
  let wss = null;
  let hostAllowlist = null; // Set<'имя:порт'> (на 80-м и голое имя) в нижнем регистре — заполняется после listen()
  const clients = new Set();
  const heartbeats = new Map(); // ws → жив ли с прошлого пинга
  // Имя клиента живёт ровно столько, сколько сокет: переподключившийся
  // макбук — НОВЫЙ клиент и захватывает управление заново. Считать его тем
  // же было бы неверно (браузер мог быть закрыт и открыт на другой машине).
  let nextClientId = 1;

  // C6 ревью: раньше каждый сокет подписывался на рассылку сам, и событие
  // сериализовалось столько раз, сколько открыто вкладок браузера, — а term:data
  // идёт на каждый кусок вывода pty. Теперь у сервера ОДНА подписка (с start()
  // до stop()): JSON.stringify один раз, дальше та же строка во все сокеты.
  function fanOut(event, payload) {
    // Сервер поднят всегда, а вывод идёт непрерывно — для пустого зала не
    // сериализуем вовсе (раньше без сокетов не было и подписчиков).
    if (clients.size === 0) return;
    const frame = JSON.stringify({ event, payload });
    for (const ws of clients) {
      // Упавший сокет не лишает события остальных — раньше это давал
      // try/catch на клиента внутри broadcast.emit.
      try { ws.send(frame); } catch { /* мёртвый сокет отвалится сам */ }
    }
  }

  // Корни приводим к абсолютному виду ОДИН раз, здесь. Если этого не
  // сделать, относительный root (например 'src/renderer' вместо полного
  // пути) даёт на выходе path.join() относительный путь, а старая проверка
  // сравнивала его с path.resolve(root) — абсолютным — и никогда не
  // совпадала: сервер тихо отдавал 404 на всё, без единой ошибки в логе.
  //
  // Сортируем по убыванию длины префикса: без этого порядок ключей в
  // объекте staticRoots был бы значим — подпапка с именем, совпадающим с
  // ДРУГИМ префиксом (например '/assets/node_modules' при отдельном корне
  // '/assets'), могла бы затенить более специфичный префиксный корень,
  // если он объявлен раньше в переборе. Длинный префикс — всегда более
  // специфичный, его проверяем первым независимо от порядка объявления.
  const roots = Object.entries(staticRoots || {})
    .map(([prefix, root]) => [prefix, path.resolve(root)])
    .sort((a, b) => b[0].length - a[0].length);

  function resolveFile(decodedPath) {
    const clean = collapseSegments(splitSegments(decodedPath.split('?')[0]));
    if (clean === null) return null; // ':' в сегменте пути — потенциальный ADS-обход
    for (const [rawPrefix, root] of roots) {
      let rest;
      if (rawPrefix === '/') {
        rest = clean;
      } else {
        // Сравнение ПО СЕГМЕНТАМ, а не по началу строки: префикс '/assets'
        // не имеет права подхватить запрос к '/assets-private/...' — это
        // была бы утечка соседнего корня через похожее имя.
        const prefixSegs = splitPrefixSegments(rawPrefix);
        const matches = prefixSegs.length <= clean.length
          && prefixSegs.every((seg, i) => clean[i] === seg);
        if (!matches) continue;
        rest = clean.slice(prefixSegs.length);
      }
      const abs = rest.length ? path.join(root, ...rest) : path.join(root, 'index.html');
      // ОДНА проверка вместо пары existsSync+statSync. Пара была не только
      // лишним системным вызовом на каждый запрос, но и незакрытым путём
      // падения: между вызовами файл успевает исчезнуть (пересборка renderer,
      // npm install поверх node_modules, антивирус), а на Windows statSync
      // бросает EPERM и на существующем файле. Исключение отсюда улетает из
      // обработчика запроса в process.on('uncaughtException') → app.exit(1),
      // то есть один HTTP-запрос в неудачный момент убивает кокпит со всеми
      // живыми pty. Тот же класс в этом файле уже закрыт для битого
      // %-escape и для ошибки потока чтения — поиск файла был последним.
      //
      // Сбой на одном корне не повод обрывать поиск: ведём себя ровно как
      // при обычном отсутствии файла и пробуем следующий корень.
      let stat = null;
      try {
        stat = fs.statSync(abs);
      } catch (err) {
        // ENOENT — самый обычный исход (файла в этом корне нет), ENOTDIR —
        // запрос вида /index.html/хвост, где компонент пути оказался файлом.
        // Раньше оба гасил existsSync, и логировать их значит писать строку
        // на КАЖДЫЙ промах. Остальное (EPERM/EACCES от антивируса или ACL,
        // битый путь) — редкое и важное: без строки в логе закрытый правами
        // корень выглядит как обычный 404, и причину ищут в префиксах.
        // Рядом тот же приём у ошибки чтения потока.
        if (err && err.code !== 'ENOENT' && err.code !== 'ENOTDIR') {
          console.log(`[net] не удалось проверить ${abs}: ${err.message}`);
        }
        continue;
      }
      // stat отдаём вместе с путём: из него ETag и Last-Modified (повторный
      // statSync в onHttp был бы тем же лишним вызовом и тем же окном гонки,
      // что закрыто выше).
      if (stat.isFile()) return { file: abs, stat };
      // Файла тут нет — пробуем СЛЕДУЮЩИЙ корень, а не сдаёмся сразу: иначе
      // первый совпавший по префиксу, но безуспешный корень обрывал бы
      // поиск в остальных.
    }
    return null;
  }

  function onHttp(req, res) {
    const rawUrl = req.url === '/' ? '/index.html' : req.url;
    let decoded;
    try {
      decoded = decodeURIComponent(rawUrl.split('?')[0]);
    } catch {
      // %zz, одинокий '%' и подобная битая percent-escape-последовательность
      // — ошибка клиента (опечатка в адресе на макбуке, сканер портов), а не
      // повод ронять процесс. Без try/catch это необработанное исключение
      // валит ВЕСЬ Electron вместе со всеми pty открытых вкладок.
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('битый путь');
      return;
    }
    const found = resolveFile(decoded);
    if (!found) { res.writeHead(404); res.end('нет такого'); return; }
    const { file, stat } = found;
    const cacheHeaders = {
      'cache-control': cacheControlFor(file),
      etag: etagFor(stat),
      'last-modified': stat.mtime.toUTCString(),
    };
    // Копия у браузера совпадает с файлом — тело не шлём вовсе.
    if (etagMatches(req.headers['if-none-match'], cacheHeaders.etag)) {
      res.writeHead(304, cacheHeaders);
      res.end();
      return;
    }
    // .pipe() слушает ошибки только на ПРИЁМНИКЕ (res), не на источнике —
    // ошибка чтения (EBUSY: антивирус, npm install поверх node_modules,
    // автообновление, редактор с открытым файлом — злоумышленник для этого
    // не нужен) становится необработанным исключением и валит ВЕСЬ процесс
    // Electron (main.js ловит это как критический сбой и делает app.exit(1)),
    // тот же класс, что и битый %-escape в задаче 1, просто другой триггер.
    // Слушаем 'error' прямо на читающем потоке. 'open' — сигнал, что файл
    // реально открылся: заголовки шлём ТОЛЬКО после него, поэтому если
    // ошибка случится ДО открытия, клиент получает честный 500, а не
    // оборванное "200 OK" без тела; если файл открылся и чтение упало на
    // середине — заголовки уже ушли, соединение просто рвём (res.destroy),
    // чтобы клиент не принял обрезанные данные за целый файл.
    const stream = fs.createReadStream(file);
    stream.on('error', (err) => {
      console.log(`[net] ошибка чтения ${file}: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('ошибка чтения файла');
      } else {
        res.destroy();
      }
    });
    stream.on('open', () => {
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', ...cacheHeaders });
    });
    stream.pipe(res);
  }

  // Ответ на канал из SERVER_CHANNELS — зовётся только для них.
  function serveOwn(channel, args, clientId) {
    if (channel === 'net:buffer') {
      // История — свойство соединения, локальному окну она не нужна (у него
      // свой xterm). С 05.11 это снимок зеркала экрана (screen-mirror.js), и
      // get отдаёт промис — onFrame обязан его дождаться (см. там).
      return outputBuffer.get(args[0]);
    }
    // owner:claim / owner:get: только сервер знает, ЧЕЙ это сокет. Реестр
    // получил бы кадр без личности и не отличил бы захват макбуком от захвата
    // локальным окном.
    if (!ownership) throw new Error('эстафета не подключена');
    if (channel === 'owner:claim') ownership.claim(clientId, args[0]);
    return { owner: ownership.owner(), self: clientId, online: ownership.ownerOnline() };
  }

  async function onFrame(ws, raw, clientId) {
    let msg;
    // Битый кадр не имеет права ронять сервер: на другом конце браузер,
    // который может прислать что угодно при обрыве. Если распарсить вообще
    // не удалось — отвечать нечем (id неизвестен), просто молчим.
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;

    const hasId = Object.prototype.hasOwnProperty.call(msg, 'id');
    // Сериализация тела ответа может САМА бросить (BigInt, циклическая
    // ссылка в результате канала) — такой канал мог исправно работать по
    // локальному IPC (там structured clone, не JSON), но по сети JSON
    // единственный формат. Без отдельного try здесь клиент не получил бы
    // вообще ничего и завис бы на промисе навсегда, хотя протокол обещает
    // ok:false на любую свою ошибку.
    //
    // Без id отвечать некому — молчим (C7 ревью). Раньше это проверяли только
    // ветки ошибок протокола, а успех и ошибка обработчика уходили кадром без
    // id и без event, который браузерному мосту некуда деть. Проверка одна,
    // здесь, — чтобы новая ветка не забыла её снова.
    const reply = (body) => {
      if (!hasId) return;
      let payload;
      try {
        payload = JSON.stringify({ id: msg.id, ...body });
      } catch (err) {
        payload = JSON.stringify({ id: msg.id, ok: false, error: `результат не сериализуется в JSON: ${err.message}` });
      }
      try { ws.send(payload); } catch { /* сокет ушёл */ }
    };

    // Протокол обещает {id, ok:false, error} на любую свою ошибку, а не
    // тишину: браузерный мост держит промис по id, и без ответа он повис бы
    // навсегда. Кадр без id reply сам оставит без ответа (см. выше).
    if (typeof msg.channel !== 'string') {
      reply({ ok: false, error: 'протокол: нет канала' });
      return;
    }
    if (msg.args !== undefined && !Array.isArray(msg.args)) {
      reply({ ok: false, error: 'протокол: args должен быть массивом' });
      return;
    }
    const args = Array.isArray(msg.args) ? msg.args : [];
    try {
      // Перехват — только по SERVER_CHANNELS: всё, что сервер обслуживает сам,
      // идёт мимо гарда реестра. Других обращений к msg.channel здесь нет и
      // быть не должно (страж в test/net-server.test.js).
      //
      // await на обеих ветках: serveOwn для net:buffer отдаёт промис снимка
      // экрана. Без него промис ушёл бы в JSON.stringify и доехал до клиента
      // как {} — браузер после подключения остался бы без экрана (жалоба 05.11).
      const result = SERVER_CHANNELS.has(msg.channel)
        ? await serveOwn(msg.channel, args, clientId)
        : await registry.call(msg.channel, args, clientId);
      reply({ ok: true, result: result === undefined ? null : result });
    } catch (err) {
      // denied — штатный отказ эстафеты, а не поломка: браузерный мост по
      // этому полю молчит вместо показа ошибки (спека: отклонение молчаливое).
      const body = { ok: false, error: String((err && err.message) || err) };
      if (err && err.denied) body.denied = true;
      reply(body);
    }
  }

  return {
    start() {
      return new Promise((resolve, reject) => {
        server = http.createServer(onHttp);
        wss = new WebSocket.Server({
          server,
          path: '/ws',
          maxPayload: maxFrameBytes,
          verifyClient: (info, callback) => {
            const ok = isAllowedOrigin(info.origin, info.req.headers.host, hostAllowlist);
            callback(ok, ok ? undefined : 403, ok ? undefined : 'чужой origin/host');
          },
        });
        wss.on('connection', (ws) => {
          const clientId = `c${nextClientId}`;
          nextClientId += 1;
          // В clients — значит и в рассылке (fanOut), отдельной подписки на
          // сокет больше нет (C6).
          clients.add(ws);
          heartbeats.set(ws, true);
          // Своё имя клиент обязан узнать ДО первого кадра: без него он не
          // может понять, у него сейчас управление или у соседа. Без эстафеты
          // (ownership не передан) имя не значит ничего, и лишний кадр сразу
          // после подключения менял бы наблюдаемое поведение старых клиентов —
          // поэтому молчим: сервер без ownership работает ровно как раньше.
          if (ownership) {
            try { ws.send(JSON.stringify({ event: 'net:hello', payload: { clientId } })); } catch { /* сокет ушёл сразу */ }
          }
          ws.on('message', (raw) => onFrame(ws, raw, clientId));
          ws.on('pong', () => heartbeats.set(ws, true));
          const forget = () => {
            clients.delete(ws);
            heartbeats.delete(ws);
            // Ушедший владелец управление НЕ теряет (спека: обрыв ≠ потеря),
            // ownership.drop лишь помечает его офлайн.
            if (ownership) ownership.drop(clientId);
          };
          ws.on('close', forget);
          ws.on('error', forget);
        });
        // Полуоткрытые соединения (закрыли крышку макбука посреди сессии)
        // иначе не обнаруживаются до таймаута TCP — вкладка выглядела бы
        // подключённой, а событий и ответов не было бы никогда.
        const heartbeat = setInterval(() => {
          for (const ws of clients) {
            if (heartbeats.get(ws) === false) { ws.terminate(); continue; }
            heartbeats.set(ws, false);
            try { ws.ping(); } catch { /* сокет уже уходит */ }
          }
        }, 30000);
        heartbeat.unref(); // не держит процесс живым, если забыли позвать stop()

        // ВАЖНО: WebSocket.Server({server}) сам переизлучает ЛЮБУЮ ошибку
        // http-сервера как wss.emit('error', err) — см.
        // ws/lib/websocket-server.js (слушатель ставится в конструкторе
        // САМОГО wss, то есть раньше, чем что-либо наше). Слушаем ошибку
        // ТОЛЬКО на wss, а не отдельно ещё и на server: второй слушатель
        // на том же исходном событии удваивал бы лог ПОСЛЕ старта (одна
        // ошибка — две строки), а до старта без слушателя на wss этот
        // 'error' остаётся необработанным на своём, отдельном пути —
        // EventEmitter бросает его синхронно, и process падает ДО того,
        // как успевает сработать reject() (EADDRINUSE — не гипотетический
        // сценарий, у пользователя уже был конфликт портов).
        const onStartError = (err) => { clearInterval(heartbeat); reject(err); };
        wss.on('error', onStartError);
        server.listen(port, host, () => {
          wss.removeListener('error', onStartError);
          wss.on('error', (err) => console.log(`[net] ошибка сервера: ${err.message}`));
          hostAllowlist = buildHostAllowlist(server.address().port, { host, allowedHosts });
          broadcast.addClient(fanOut);
          server._cockpitHeartbeat = heartbeat; // чтобы stop() мог его погасить
          resolve({ port: server.address().port });
        });
      });
    },
    stop() {
      return new Promise((resolve) => {
        broadcast.removeClient(fanOut);
        if (server && server._cockpitHeartbeat) clearInterval(server._cockpitHeartbeat);
        for (const ws of clients) { try { ws.terminate(); } catch { /* уже мёртв */ } }
        clients.clear();
        heartbeats.clear();
        // wss.close() снимает собственные слушатели ('upgrade' и т.д.) с
        // http-сервера — без этого объект wss продолжал бы висеть в памяти
        // и реагировать на апгрейды даже после того, как http-сервер лёг.
        if (wss) { try { wss.close(); } catch { /* уже закрыт */ } }
        if (!server) { resolve(); return; }
        // closeAllConnections рвёт ЖИВЫЕ HTTP-соединения, включая
        // keep-alive: без этого server.close() ждёт, пока браузер сам
        // отпустит связь, — тумблер «выключить сеть» и выход из Electron
        // подвисали бы на секунды на каждой открытой вкладке браузера.
        // Утечки в этом нет (соединение уже не обслуживается), только
        // задержка завершения.
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        server.close(() => resolve());
      });
    },
    clientCount: () => clients.size,
    // Адрес для меню трея и для показа человеку: сервер знает и реальный порт
    // (при port:0 он эфемерный), и то, поднялся ли он вообще.
    //
    // Отдельный случай — '0.0.0.0'/'::' в конфиге: это не имя машины, а «слушаю
    // на всех интерфейсах». Такой адрес на макбуке бесполезен, а пункт меню
    // существует ровно затем, чтобы человек его оттуда взял (и клик по строке
    // открыл бы http://0.0.0.0:порт в браузере). Подставляем первое имя из
    // allowedHosts — это ровно те имена, по которым к нам и приходят, — а если
    // и их нет, честный localhost: он хотя бы работает на этой машине.
    address: () => {
      if (!server || !server.listening) return null;
      const boundPort = server.address().port;
      let name = host;
      if (LISTEN_ANYWHERE.has(String(host).trim())) {
        const hint = (allowedHosts || []).map((h) => String(h).trim()).find(Boolean);
        name = hint || '127.0.0.1';
      }
      // Скобки вокруг IPv6 — те же, что в белом списке Host (withPort).
      return `http://${withPort(name, boundPort)}`;
    },
  };
}

// MAX_FRAME_BYTES экспортируется ради теста: без него мутация «вернуть дефолт
// 100 МиБ» проходила незамеченной — тесты задают потолок явным параметром, а
// само значение по умолчанию не проверял никто. buildHostAllowlist и
// isAllowedOrigin — тоже ради теста (порт 80, см. их шапку выше),
// SERVER_CHANNELS — ради сверки с FREE_CHANNELS.
module.exports = {
  createNetServer, MAX_FRAME_BYTES, buildHostAllowlist, isAllowedOrigin, SERVER_CHANNELS,
};
