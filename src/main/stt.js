'use strict';
// Распознавание речи через whisper.cpp (Фаза 9, Task 1) — порт рабочего
// src/main/stt.js из claude-companion (299 строк, читать целиком —
// C:\Users\Lunev\AssistClaude\claude-companion\src\main\stt.js) на конвенцию
// кокпита: чистая фабрика, ВСЕ внешние эффекты (спавн процесса, HTTP, fs,
// часы, таймеры, реестр процессов, лог) инжектируются — ни Electron, ни
// child_process, ни http внутри модуля нет. Тесты (node --test) дёргают
// фейковые таймеры руками, без единой секунды реального ожидания.
//
// Основной путь — долгоживущий whisper-server.exe (модель грузится один раз,
// остаётся тёплой), запросы идут HTTP POST /inference (multipart, собранный
// вручную — без зависимостей). CLI-фоллбэк Companion (whisper-cli.exe,
// transcribeViaCli) СОЗНАТЕЛЬНО не портирован (YAGNI, план фазы): серверный
// путь + один ретрай покрывают отказ, а cp1251-грабли argv-пути в спеке
// зафиксированы как причина не трогать этот путь вообще.
//
// Логика перебора бекендов/ready-поллинга/multipart/killProc сохранена 1-в-1
// с Companion. ЕДИНСТВЕННОЕ функциональное отличие (см. спеку, раздел
// «Технические контракты»): выбор КОРНЯ стека — Companion использует
// фиксированный appRoot(), кокпит перебирает config.stackRoots и берёт
// первый корень, где есть И хотя бы один vendor/whisper*/whisper-server.exe,
// И models/whisper/ggml-<model>.bin.
//
// Сериализация конкурентных transcribeWav() (у Companion — цепочка промисов
// chain, т.к. whisper-server однопоточный) НЕ портирована: контракт push-to-
// talk (спека) гарантирует не более одной активной записи одновременно —
// реальных конкурентных вызовов не бывает, а тащить лишний стейт без сценария
// его проявления — не 1-в-1 порт, а самостоятельное усложнение.

const path = require('path');

// Кандидаты каталогов с бинарями whisper внутри выбранного корня, в порядке
// предпочтения. vendor/whisper-cuda — CUDA-сборка (cuBLAS), vendor/whisper —
// CPU-сборка (фоллбэк). При провале старта одного пробуем следующий.
//
// ВАЖНО (Pascal / GTX 10xx, compute 6.1, снято с рабочего Companion): CUDA-
// бинарь заводится, но flash-attention на Pascal не имеет оптимизированных
// ядер и тормозит энкодер в ~9 раз. Поэтому для CUDA-бекенда передаём
// --no-flash-attn (и --no-fallback, чтобы убрать редкие 10-15с провалы на
// temperature-fallback).
const BACKENDS = [
  { dir: 'whisper-cuda', cuda: true },
  { dir: 'whisper', cuda: false },
];

const DEFAULT_PORT = 48753; // кокпит; Companion живёт на 48752 — оба могут работать одновременно
const READY_TIMEOUT_MS = 20000; // large-модель грузится дольше small — запас на весь размер
const POLL_INTERVAL_MS = 300;
const INFER_TIMEOUT_MS = 60000;
const PING_TIMEOUT_MS = 1000; // таймаут ОДНОГО GET / внутри поллинга готовности, не деталь READY_TIMEOUT_MS

function createStt({
  spawnProc, httpGet, httpPost, fs, now, setTimer, clearTimer, registerProcess, config, log = () => {},
}) {
  const cfg = config || {};

  let proc = null; // живой child-подобный объект текущего сервера
  let serverPort = 0; // порт текущего сервера
  let readyPromise = null; // ожидание готовности сервера (in-flight или уже готовый)
  let activeBackendDir = null; // 'whisper-cuda' | 'whisper' | null — на чём поднят/поднимается текущий сервер
  let warm = false; // сервер прошёл ready-поллинг и (предположительно) ещё жив
  let pollTimerId = null; // текущий таймер poll-цикла waitReady — снимается в dispose()

  // Список доступных бекендов (существующих каталогов с whisper-server.exe)
  // ВНУТРИ заданного корня.
  function availableBackendsAt(root) {
    const out = [];
    for (const b of BACKENDS) {
      const serverExe = path.join(root, 'vendor', b.dir, 'whisper-server.exe');
      if (fs.existsSync(serverExe)) out.push({ ...b, serverExe });
    }
    return out;
  }

  // Выбор корня стека (НОВОЕ относительно Companion — см. шапку файла):
  // первый root из cfg.stackRoots, где есть И хотя бы один
  // vendor/whisper*/whisper-server.exe, И models/whisper/ggml-<model>.bin.
  // Ни одного подходящего root → null (ensureServer/status() трактуют как
  // «стек не найден»).
  function resolveRoot() {
    const roots = Array.isArray(cfg.stackRoots) ? cfg.stackRoots : [];
    for (const root of roots) {
      const backs = availableBackendsAt(root);
      if (backs.length === 0) continue; // ни одного бекенда в этом корне — пробуем следующий
      const modelPath = path.join(root, 'models', 'whisper', `ggml-${cfg.model}.bin`);
      if (!fs.existsSync(modelPath)) continue; // бекенд есть, а модели нет — этот корень не годится
      return { root, backs, modelPath };
    }
    return null;
  }

  // Убивает текущий серверный процесс. ПОРЯДОК КРИТИЧЕН (тонкость 1 брифа):
  // снимаем exit-хендлер ДО kill() — иначе его отложенное срабатывание
  // затирает состояние УЖЕ НОВОГО сервера (proc/serverPort/readyPromise),
  // если respawn успел произойти раньше, чем event loop доставил старый exit.
  // Контрольный taskkill — как в src/main/tts/silero.js у Companion: kill()
  // на Windows может не добить процесс с загруженной моделью. taskkill —
  // отдельный процесс-уборщик, НЕ регистрируем его через registerProcess
  // (тонкость 4 брифа: registerProcess — для процессов, которым нужен
  // watchdog/уборка на выходе кокпита; taskkill сам себе уборщик и живёт
  // доли секунды).
  function killProc() {
    if (proc) {
      const pid = proc.pid;
      try { proc.removeAllListeners('exit'); } catch { /* фейковый/чужой child может не поддержать — не критично */ }
      try { proc.kill(); } catch { /* процесс мог уже умереть сам */ }
      try { spawnProc('taskkill', ['/PID', String(pid), '/T', '/F']); } catch { /* best-effort уборка */ }
    }
    proc = null;
    serverPort = 0;
    readyPromise = null;
    activeBackendDir = null;
    warm = false;
  }

  // Поллинг GET / раз в POLL_INTERVAL_MS до готовности или дедлайна.
  // httpGet резолвится ЛЮБЫМ завершённым ответом (сервер слушает — значит
  // готов, статус не важен) и реджектится на сетевой сбой/таймаут — тот же
  // контракт, что был у ping() в Companion, только эффект инжектирован.
  function waitReady(port, deadline) {
    return new Promise((resolve, reject) => {
      function attempt() {
        httpGet(port, '/', PING_TIMEOUT_MS).then(
          () => { pollTimerId = null; resolve(); },
          () => {
            if (now() > deadline) {
              pollTimerId = null;
              reject(new Error('whisper-server: таймаут готовности (20с)'));
              return;
            }
            pollTimerId = setTimer(attempt, POLL_INTERVAL_MS);
          },
        );
      }
      attempt();
    });
  }

  // Лениво стартует сервер; повторные вызовы (включая параллельные — тонкость
  // 2 брифа) возвращают ОДИН И ТОТ ЖЕ in-flight промис, не плодя второй
  // spawnProc. Перебирает бекенды (CUDA → CPU) внутри выбранного корня: при
  // провале готовности одного — следующий.
  //
  // self — ссылка на этот же промис: killProc() между итерациями обнуляет
  // module-level readyPromise (см. комментарий killProc выше — это ЕГО
  // побочный эффект, не отдельная логика), поэтому явно восстанавливаем его
  // ПОСЛЕ killProc(), чтобы параллельные вызовы ensureServer(), случившиеся
  // ПОКА мы перебираем бекенды, дожидались ЭТОГО ЖЕ перебора, а не запускали
  // свой собственный второй сервер.
  function ensureServer() {
    if (readyPromise) return readyPromise;

    let resolved;
    try {
      resolved = resolveRoot();
    } catch (err) {
      return Promise.reject(err);
    }
    if (!resolved) {
      return Promise.reject(new Error(
        'Голосовой стек не найден: ни в одном из stt.stackRoots нет vendor/whisper*/whisper-server.exe '
        + `+ models/whisper/ggml-${cfg.model}.bin`,
      ));
    }

    const port = Number(cfg.serverPort) || DEFAULT_PORT;

    const self = (async () => {
      let lastErr = null;
      for (let i = 0; i < resolved.backs.length; i++) {
        const backend = resolved.backs[i];
        const args = [
          '-m', resolved.modelPath,
          '-t', String(cfg.threads || 6),
          '-l', cfg.language || 'ru',
          '--host', '127.0.0.1',
          '--port', String(port),
          '-nt', // без таймстампов
        ];
        // CUDA на Pascal: гасим flash-attn (нет оптимизированных ядер) и
        // temperature-fallback (редкие 10-15с провалы инференса).
        if (backend.cuda) args.push('--no-flash-attn', '--no-fallback');

        log(`[stt] старт whisper-server [${backend.dir}] на 127.0.0.1:${port} (модель ${cfg.model})`);
        const child = spawnProc(backend.serverExe, args);
        proc = child;
        serverPort = port;
        activeBackendDir = backend.dir;
        warm = false;
        registerProcess(child); // КАЖДЫЙ spawnProc сервера — включая повторные попытки/ретраи

        child.on('exit', () => {
          // Упавший сервер обнуляет состояние — следующий вызов стартует заново.
          proc = null;
          serverPort = 0;
          readyPromise = null;
          activeBackendDir = null;
          warm = false;
        });

        const deadline = now() + READY_TIMEOUT_MS;
        try {
          await waitReady(port, deadline);
          warm = true;
          log(`[stt] whisper-server готов: бекенд ${backend.dir}${backend.cuda ? ' (CUDA)' : ' (CPU)'}, порт ${port}`);
          return;
        } catch (err) {
          lastErr = err;
          log(`[stt] бекенд ${backend.dir} не поднялся (${err.message})`);
          killProc(); // снимает exit-хендлер, добивает процесс, обнуляет readyPromise
          readyPromise = self; // восстанавливаем in-flight промис для следующей итерации/параллельных вызовов
        }
      }
      throw lastErr || new Error('whisper-server: не удалось запустить ни один бекенд');
    })();

    readyPromise = self;
    return readyPromise;
  }

  // Собираем multipart/form-data тело вручную (без зависимостей): part file
  // (filename="a.wav", audio/wav) + part response_format=json. Тонкость 3
  // брифа: WAV-буфер входит в Buffer.concat КАК ЕСТЬ, без строкового
  // преобразования — единственный способ передать бинарные данные байт-в-
  // байт (никакого argv-пути для текста в этом модуле нет вовсе).
  function buildMultipart(buffer) {
    const boundary = `----ccstt${now().toString(16)}${Math.random().toString(16).slice(2)}`;
    const CRLF = '\r\n';
    const head = Buffer.from(
      `--${boundary}${CRLF}`
      + `Content-Disposition: form-data; name="file"; filename="a.wav"${CRLF}`
      + `Content-Type: audio/wav${CRLF}${CRLF}`,
      'utf8',
    );
    const mid = Buffer.from(
      `${CRLF}--${boundary}${CRLF}`
      + `Content-Disposition: form-data; name="response_format"${CRLF}${CRLF}`
      + 'json',
      'utf8',
    );
    const tail = Buffer.from(`${CRLF}--${boundary}--${CRLF}`, 'utf8');
    return { body: Buffer.concat([head, buffer, mid, tail]), boundary };
  }

  function bodyToText(body) {
    if (body == null) return '';
    return Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
  }

  // POST WAV на /inference, ждём JSON {text}. Кириллица в ответе безопасна
  // ТОЛЬКО потому, что мы явно декодируем тело как UTF-8 (bodyToText) — тот
  // же принцип, что и у отправляемого multipart-тела (тонкость 3 брифа).
  async function postInference(buffer) {
    const { body, boundary } = buildMultipart(buffer);
    const headers = {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(body.length),
    };
    const res = await httpPost(serverPort, '/inference', headers, body, INFER_TIMEOUT_MS);
    if (!res || res.status !== 200) {
      const text = bodyToText(res && res.body).slice(0, 200);
      throw new Error(`whisper-server HTTP ${res && res.status}: ${text}`);
    }
    let json;
    try {
      json = JSON.parse(bodyToText(res.body));
    } catch (err) {
      throw new Error(`whisper-server: невалидный JSON: ${err.message}`);
    }
    return (json.text || '').trim();
  }

  // transcribeWav(buffer) → Promise<string>. buffer — WAV (whisper.cpp сам
  // ресемплит). Тонкость 7 брифа: не-200/таймаут /inference → ОДИН ретрай
  // (killProc → ensureServer → повторный POST); второй провал — reject
  // (никакого CLI-фоллбэка, см. шапку файла).
  async function transcribeWav(buffer) {
    try {
      await ensureServer();
      return await postInference(buffer);
    } catch (err) {
      log(`[stt] сервер недоступен (${err.message}), перезапуск`);
      killProc();
      try {
        await ensureServer();
        return await postInference(buffer);
      } catch (err2) {
        log(`[stt] сервер снова недоступен (${err2.message})`);
        killProc();
        throw err2;
      }
    }
  }

  // {available, backend, warm}. available — найден ли стек ХОТЯ БЫ где-то
  // (не зависит от того, запущен ли сейчас сервер); backend/warm — про
  // ТЕКУЩИЙ живой процесс, если он есть.
  function status() {
    try {
      let resolved = null;
      try {
        resolved = resolveRoot();
      } catch { /* битый fs/config — трактуем как «не найден», не бросаем */ }
      return { available: !!resolved, backend: activeBackendDir, warm };
    } catch {
      return { available: false, backend: null, warm: false };
    }
  }

  // Убить серверный процесс и снять все таймеры (teardown приложения —
  // рядом с nightWatch.dispose()). Никогда не бросает наружу.
  function dispose() {
    try {
      if (pollTimerId !== null) {
        clearTimer(pollTimerId);
        pollTimerId = null;
      }
      killProc();
    } catch (err) {
      try { log(`[stt] dispose упал: ${err.message}`); } catch { /* лог тоже мог быть чужой и упасть */ }
    }
  }

  return {
    transcribeWav, ensureServer, status, dispose,
  };
}

module.exports = { createStt };
