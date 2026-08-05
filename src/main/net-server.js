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

// ownership — необязательный параметр: без него сервер работает ровно как
// раньше (эстафеты нет, каждый кадр идёт в реестр как есть).
function createNetServer({
  registry, ownership, broadcast, outputBuffer, staticRoots, port = 48300, host = '127.0.0.1', allowedHosts = [],
}) {
  let server = null;
  let wss = null;
  let hostAllowlist = null; // Set<'имя:порт'> в нижнем регистре — заполняется после listen()
  const clients = new Set();
  const heartbeats = new Map(); // ws → жив ли с прошлого пинга
  // Имя клиента живёт ровно столько, сколько сокет: переподключившийся
  // макбук — НОВЫЙ клиент и захватывает управление заново. Считать его тем
  // же было бы неверно (браузер мог быть закрыт и открыт на другой машине).
  let nextClientId = 1;

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
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
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
    const file = resolveFile(decoded);
    if (!file) { res.writeHead(404); res.end('нет такого'); return; }
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
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    });
    stream.pipe(res);
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
    const reply = (body) => {
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
    // навсегда. Молчим только когда id вообще нет — отвечать некому.
    if (typeof msg.channel !== 'string') {
      if (hasId) reply({ ok: false, error: 'протокол: нет канала' });
      return;
    }
    if (msg.args !== undefined && !Array.isArray(msg.args)) {
      if (hasId) reply({ ok: false, error: 'протокол: args должен быть массивом' });
      return;
    }
    const args = Array.isArray(msg.args) ? msg.args : [];
    try {
      let result;
      if (msg.channel === 'net:buffer') {
        // net:buffer обслуживает сервер, а не реестр: история — свойство
        // соединения, локальному окну она не нужна (у него свой xterm).
        result = outputBuffer.get(args[0]);
      } else if (msg.channel === 'owner:claim' || msg.channel === 'owner:get') {
        // Тот же случай, что и net:buffer: только сервер знает, ЧЕЙ это
        // сокет. Реестр получил бы кадр без личности и не смог бы отличить
        // захват макбуком от захвата локальным окном.
        if (!ownership) throw new Error('эстафета не подключена');
        if (msg.channel === 'owner:claim') ownership.claim(clientId, args[0]);
        result = { owner: ownership.owner(), self: clientId, online: ownership.ownerOnline() };
      } else {
        result = await registry.call(msg.channel, args, clientId);
      }
      reply({ ok: true, result: result === undefined ? null : result });
    } catch (err) {
      // denied — штатный отказ эстафеты, а не поломка: браузерный мост по
      // этому полю молчит вместо показа ошибки (спека: отклонение молчаливое).
      const body = { ok: false, error: String((err && err.message) || err) };
      if (err && err.denied) body.denied = true;
      reply(body);
    }
  }

  // Литерал IPv6 в заголовке Host/URI ОБЯЗАН быть в квадратных скобках
  // (RFC 3986) — браузер шлёт 'Host: [::1]:порт', а не '::1:порт'. Без
  // обёртки адрес Tailscale IPv6 (выдаётся всегда, кроме IPv4) отрезал бы
  // браузер целиком, оставляя рабочим только заход по localhost. Признак
  // «это IPv6, а не DNS-имя с портом внутри» — двоеточие в самом имени:
  // легитимное DNS-имя/allowedHosts-запись их не содержит (формат — см.
  // комментарий у allowedHosts ниже), так что эвристика безопасна.
  function withPort(name, boundPort) {
    const bracketed = name.includes(':') && !name.startsWith('[') ? `[${name}]` : name;
    return `${bracketed}:${boundPort}`;
  }

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
  function buildHostAllowlist(boundPort) {
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
    return new Set([...names].map((n) => withPort(n.toLowerCase(), boundPort)));
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
  function isAllowedOrigin(origin, requestHost) {
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

  return {
    start() {
      return new Promise((resolve, reject) => {
        server = http.createServer(onHttp);
        wss = new WebSocket.Server({
          server,
          path: '/ws',
          verifyClient: (info, callback) => {
            const ok = isAllowedOrigin(info.origin, info.req.headers.host);
            callback(ok, ok ? undefined : 403, ok ? undefined : 'чужой origin/host');
          },
        });
        wss.on('connection', (ws) => {
          const clientId = `c${nextClientId}`;
          nextClientId += 1;
          const send = (event, payload) => ws.send(JSON.stringify({ event, payload }));
          clients.add(ws);
          heartbeats.set(ws, true);
          broadcast.addClient(send);
          // Своё имя клиент обязан узнать ДО первого кадра: без него он не
          // может понять, у него сейчас управление или у соседа. Без эстафеты
          // (ownership не передан) имя не значит ничего, и лишний кадр сразу
          // после подключения менял бы наблюдаемое поведение старых клиентов —
          // поэтому молчим: сервер без ownership работает ровно как раньше.
          if (ownership) {
            try { send('net:hello', { clientId }); } catch { /* сокет ушёл сразу */ }
          }
          ws.on('message', (raw) => onFrame(ws, raw, clientId));
          ws.on('pong', () => heartbeats.set(ws, true));
          const forget = () => {
            clients.delete(ws);
            heartbeats.delete(ws);
            broadcast.removeClient(send);
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
          hostAllowlist = buildHostAllowlist(server.address().port);
          server._cockpitHeartbeat = heartbeat; // чтобы stop() мог его погасить
          resolve({ port: server.address().port });
        });
      });
    },
    stop() {
      return new Promise((resolve) => {
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
    address: () => (server && server.listening
      ? `http://${host.includes(':') ? `[${host}]` : host}:${server.address().port}`
      : null),
  };
}

module.exports = { createNetServer };
