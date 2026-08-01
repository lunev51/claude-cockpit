'use strict';
// Распознавание речи через whisper.cpp (Фаза 9, Task 1, фикс-раунд 1 после
// ревью) — порт рабочего src/main/stt.js из claude-companion (299 строк,
// читать целиком — C:\Users\Lunev\AssistClaude\claude-companion\src\main\
// stt.js) на конвенцию кокпита: чистая фабрика, ВСЕ внешние эффекты (спавн
// процесса, HTTP, fs, часы, таймеры, реестр процессов, лог) инжектируются —
// ни Electron, ни child_process, ни http внутри модуля нет. Тесты
// (node --test) дёргают фейковые таймеры руками, без единой секунды
// реального ожидания.
//
// Основной путь — долгоживущий whisper-server.exe (модель грузится один раз,
// остаётся тёплой), запросы идут HTTP POST /inference (multipart, собранный
// вручную — без зависимостей). CLI-фоллбэк Companion (whisper-cli.exe,
// transcribeViaCli) СОЗНАТЕЛЬНО не портирован (YAGNI, план фазы): серверный
// путь + один ретрай покрывают отказ, а cp1251-грабли argv-пути в спеке
// зафиксированы как причина не трогать этот путь вообще.
//
// Логика перебора бекендов/ready-поллинга/multipart/killProc сохранена 1-в-1
// с Companion, ВКЛЮЧАЯ сериализацию конкурентных transcribeWav() цепочкой
// промисов (Companion :288-292, chain) — ревью раунда 1 (B1) указало, что моя
// первоначальная попытка это осознанно выпилить была НЕВЕРНОЙ: push-to-talk
// на renderer-стороне (Task 3) запрещает две ЗАПИСИ одновременно, но НЕ
// запрещает повторное нажатие Shift, пока идёт РАСПОЗНАВАНИЕ предыдущей
// (бейдж «🎤 …») — то есть конкурентные вызовы transcribeWav() ДОСТИЖИМЫ, и
// без сериализации второй вызов бьёт по серверу, который killProc первого
// вызова как раз убивает под ретрай (потеря диктовки + лишние спавны сервера
// с загрузкой модели ~1ГБ каждый). См. `chain`/`transcribeWavImpl` ниже.
//
// ЕДИНСТВЕННОЕ функциональное отличие от Companion (см. спеку, раздел
// «Технические контракты»): выбор КОРНЯ стека — Companion использует
// фиксированный appRoot(), кокпит перебирает config.stackRoots и берёт
// первый корень, где есть И хотя бы один vendor/whisper*/whisper-server.exe,
// И models/whisper/ggml-<model>.bin.

const path = require('path');

// Кандидаты каталогов с бинарями whisper внутри выбранного корня, в порядке
// предпочтения. vendor/whisper-cuda — CUDA-сборка (cuBLAS), vendor/whisper —
// CPU-сборка (фоллбэк). При провале старта одного пробуем следующий.
//
// Minor-2 (ревью раунд 1): «vendor/whisper*/» в брифе — это ГЛОБ-ФОРМА
// записи, а не намёк на произвольный набор каталогов; фактических кандидатов
// РОВНО два, буквально как в эталоне Companion (тот же массив BACKENDS) — ни
// один другой каталог, начинающийся на whisper*, этим модулем не
// подхватывается и не должен.
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
// Minor-1 ревью инцидент-фикса: демоция бекенда (CUDA умер на инференсе —
// VRAM была занята) не навсегда: причина транзиентна (игру закрыли — память
// свободна). Холодный старт спустя этот интервал пробует CUDA снова.
const BACKEND_RETRY_AFTER_MS = 5 * 60000;
// Инцидент 8ГБ (01.08): простой, после которого тёплый whisper-server
// глушится (возврат ~1ГБ ОЗУ); следующая диктовка прогревает заново (~2с).
const STT_IDLE_STOP_MS = 10 * 60000;
const PING_TIMEOUT_MS = 1000; // таймаут ОДНОГО GET / внутри поллинга готовности, не деталь READY_TIMEOUT_MS

// === Контракты инжектируемых эффектов (Important-3, ревью раунд 1) ===
// Раньше контракт httpGet был размазан по комментарию внутри waitReady, а
// httpPost не описан нигде — здесь ОДНО место правды для Task 2 (реализация
// эффектов) и для ревью (что именно спрашивать со сторонней реализации).
//
// spawnProc(exe, args) → {pid, on(event,cb), removeListener?(event,cb),
//   removeAllListeners(event), kill()} — child-подобный объект. Сам spawnProc
//   НЕ бросает синхронно (сбой запуска — дело вызывающего кода дальше по
//   цепочке, этот модуль 'error' не слушает). ОБЯЗАН не оставлять
//   непрочитанных пайпов: stdio:'ignore' (предпочтительно) либо дренаж ОБОИХ
//   потоков (stdout/stderr) — иначе при дефолтном stdio:'pipe' буфер ~64КБ
//   переполнится через сотни запросов и whisper-server зависнет посреди
//   инференса (Important-2, ревью раунд 1: в эталоне Companion этот дренаж
//   был — `proc.stdout.on('data', () => {})` — но там был РЕАЛЬНЫЙ
//   child_process; здесь spawnProc чужой, и ответственность на нём).
// httpGet(port, path, timeoutMs) → Promise<{status}> — РЕЗОЛВ на ЛЮБОЙ
//   завершённый HTTP-ответ (даже 404/500 — критерий готовности «порт
//   слушает», а не «ответил 200»), REJECT ТОЛЬКО на сетевой сбой/таймаут.
//   Important-3 (ревью раунд 1): если реализация вместо этого реджектит на
//   не-200, ready-поллинг НИКОГДА не увидит готовность на сборках, где
//   whisper-server отвечает не-200 на голый GET / — «оба бекенда не
//   поднялись» на полностью исправном стеке.
// httpPost(port, path, headers, bodyBuffer, timeoutMs) → Promise<{status,
//   body: Buffer}> — тот же принцип: резолв на ЛЮБОЙ код (код разбирает сам
//   stt.js, см. postInference), reject только на сетевой сбой/таймаут.
// fs.existsSync(path) → boolean, синхронно, не бросает.
// now() → number (мс, монотонно не обязателен, но не убывает в рамках
//   одного прогона). setTimer(fn, ms) → id. clearTimer(id) — безопасен на
//   уже сработавший/несуществующий id (как обычный clearTimeout).
// registerProcess(child) — регистрация в реестре runners.js (Task 2):
//   РЕАЛИЗАЦИЯ ВПРАВЕ повесить СВОЙ 'exit'-слушатель на child (как
//   trackChild в runners.js) — killProc ОБЯЗАН пережить его: снимает ТОЛЬКО
//   свой собственный обработчик, не все листенеры события 'exit' целиком
//   (B3, ревью раунд 1 — см. killProc ниже). НЕ зовётся для служебного
//   spawnProc('taskkill', ...) — тот сам себе уборщик и живёт доли секунды.
// log(msg) — не бросает (или бросок безопасно проглатывается вызывающей
//   стороной) — этот модуль сам никогда не даёт логированию уронить себя.

function createStt({
  spawnProc, httpGet, httpPost, fs, now, setTimer, clearTimer, registerProcess, config, log = () => {},
}) {
  const cfg = config || {};

  let proc = null; // живой child-подобный объект текущего сервера
  let exitHandler = null; // ИМЕННО наш обработчик 'exit' текущего proc — B3: снимается точечно, не всей пачкой
  let serverPort = 0; // порт текущего сервера
  let readyPromise = null; // ожидание готовности сервера (in-flight или уже готовый)
  let activeBackendDir = null; // 'whisper-cuda' | 'whisper' | null — на чём поднят/поднимается текущий сервер
  // Живая приёмка фазы 9 (боевой инцидент): CUDA-сервер может успешно
  // ЗАГРУЗИТЬ модель («готов») и умереть на ПЕРВОМ инференсе — рабочие
  // буферы (~360МБ VRAM) не влезли, потому что видеокарту в этот момент
  // держит игра/браузер. Старый перебор бекендов срабатывал только при
  // провале СТАРТА — ретрай инференса крутил один и тот же падающий CUDA
  // по кругу (слепая зона, унаследованная от Companion). preferredBackendIdx
  // — «с какого бекенда начинать следующий перебор»: успешный старт
  // закрепляет свой индекс, смерть НА ИНФЕРЕНСЕ сдвигает на следующий
  // (CUDA умер → дальше пробуем CPU; CPU последний — остаёмся на нём).
  let preferredBackendIdx = 0;
  let lastBacksCount = 0; // сколько бекендов видел последний resolveRoot — потолок для сдвига
  let demotedAt = null; // now() последней демоции, null = не было — 0 НЕ сигнальное значение (фейковые часы тестов стартуют с 0)
  let idleTimer = null; // таймер глушения тёплого сервера по простою (инцидент 8ГБ) — перевзводится каждым transcribeWav
  let warm = false; // сервер прошёл ready-поллинг и (предположительно) ещё жив
  let pollTimerId = null; // текущий таймер poll-цикла waitReady — снимается в dispose()
  let pendingReject = null; // reject ТЕКУЩЕГО waitReady (если есть) — Important-1(C): dispose() будит его напрямую
  let disposed = false; // Important-1: терминальный флаг — после dispose() модуль больше не спавнит

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
  //
  // Возвращает {ok:true, root, backs, modelPath} либо {ok:false, diag} —
  // Minor-1 (ревью раунд 1): diag — по строке НА КАЖДЫЙ проверенный корень с
  // тем, чего именно в нём не хватило, чтобы отказ ensureServer() был
  // диагностируем без похода в код (раньше сообщение просто называло модель
  // и молчало, ГДЕ конкретно искали).
  //
  // Minor-3 (ревью раунд 1): cfg.model ниже используется БЕЗ фоллбэка — в
  // отличие от cfg.threads/cfg.language/cfg.serverPort (у которых инлайновый
  // дефолт есть, см. ensureServer). Это НАМЕРЕННАЯ асимметрия, 1-в-1 с
  // эталоном Companion (тот же `ggml-${cfg.model}.bin` без fallback): модель
  // — единственный параметр, для которого дефолт ('large-v3-turbo-q5_0')
  // назначает НЕ этот модуль, а config.js (Task 2, DEFAULTS.stt по спеке) —
  // владелец дефолта модели ровно один, и это конфиг-слой, а не ядро.
  function resolveRoot() {
    const roots = Array.isArray(cfg.stackRoots) ? cfg.stackRoots : [];
    const diag = [];
    for (const root of roots) {
      const backs = availableBackendsAt(root);
      if (backs.length === 0) {
        diag.push(`${root}: нет ни одного vendor/whisper*/whisper-server.exe`);
        continue;
      }
      const modelPath = path.join(root, 'models', 'whisper', `ggml-${cfg.model}.bin`);
      if (!fs.existsSync(modelPath)) {
        diag.push(`${root}: бекенд(ы) [${backs.map((b) => b.dir).join(', ')}] есть, но нет модели ${modelPath}`);
        continue;
      }
      return {
        ok: true, root, backs, modelPath,
      };
    }
    if (roots.length === 0) diag.push('config.stt.stackRoots пуст');
    return { ok: false, diag };
  }

  // Убивает текущий серверный процесс. ПОРЯДОК КРИТИЧЕН (тонкость 1 брифа):
  // снимаем exit-хендлер ДО kill() — иначе его отложенное срабатывание
  // затирает состояние УЖЕ НОВОГО сервера (proc/serverPort/readyPromise),
  // если respawn успел произойти раньше, чем event loop доставил старый exit.
  //
  // B3 (ревью раунд 1): снимаем ТОЛЬКО НАШ exitHandler (proc.removeListener),
  // а не removeAllListeners('exit') — registerProcess() (runners.js,
  // Task 2) вешает на этот же child СВОЙ once('exit') для чистки реестра
  // liveChildren; removeAllListeners() сносил бы и его тоже, оставляя мёртвый
  // pid в реестре навсегда → killAllTracked на выходе бил бы taskkill по уже
  // не существующему pid, который Windows успела переиспользовать под
  // посторонний процесс. removeListener — не универсальный метод (не все
  // EventEmitter-подобные реализации его гарантируют) — фоллбэк на
  // removeAllListeners, если его нет.
  //
  // Контрольный taskkill — как в src/main/tts/silero.js у Companion: kill()
  // на Windows может не добить процесс с загруженной моделью. taskkill —
  // отдельный процесс-уборщик, НЕ регистрируем его через registerProcess
  // (тонкость 4 брифа: registerProcess — для процессов, которым нужен
  // watchdog/уборка на выходе кокпита; taskkill сам себе уборщик и живёт
  // доли секунды).
  function killProc() {
    if (proc) {
      const pid = proc.pid;
      const handler = exitHandler;
      try {
        if (handler && typeof proc.removeListener === 'function') {
          proc.removeListener('exit', handler);
        } else {
          proc.removeAllListeners('exit');
        }
      } catch { /* фейковый/чужой child может не поддержать — не критично */ }
      try { proc.kill(); } catch { /* процесс мог уже умереть сам */ }
      try { spawnProc('taskkill', ['/PID', String(pid), '/T', '/F']); } catch { /* best-effort уборка */ }
    }
    proc = null;
    exitHandler = null;
    serverPort = 0;
    readyPromise = null;
    activeBackendDir = null;
    warm = false;
  }

  // Поллинг GET / раз в POLL_INTERVAL_MS до готовности или дедлайна.
  // httpGet резолвится ЛЮБЫМ завершённым ответом (сервер слушает — значит
  // готов, статус не важен) и реджектится на сетевой сбой/таймаут — см.
  // блок контрактов выше.
  //
  // Important-1 (ревью раунд 1): pendingReject хранит reject ЭТОГО ожидания,
  // чтобы dispose() мог разбудить его напрямую (зонд C — иначе
  // transcribeWav/ensureServer висят PENDING навсегда после teardown); флаг
  // disposed проверяется В КАЖДОЙ continuation ПЕРЕД планированием нового
  // таймера (зонд B — иначе уже запущенный, но ещё не отработавший httpGet
  // планирует таймер УЖЕ ПОСЛЕ dispose(), и поллинг переживает teardown).
  // stillAlive (необязателен) — «наш ли ребёнок всё ещё жив»: ensureLoop
  // передаёт `() => proc === child`, см. боевой инцидент в комментариях attempt().
  function waitReady(port, deadline, stillAlive) {
    return new Promise((resolve, reject) => {
      pendingReject = reject;
      function attempt() {
        httpGet(port, '/', PING_TIMEOUT_MS).then(
          () => {
            if (pendingReject === reject) pendingReject = null;
            pollTimerId = null;
            // Боевой инцидент фазы 9: пинг ответил, но НАШ ребёнок уже умер
            // (мгновенный краш/порт занят) — значит, на порту сидит ЧУЖОЙ
            // процесс (осиротевший сервер прошлого запуска, другое
            // приложение). Считать его «готовым» нельзя: его /inference
            // сбросит соединение, и цикл «готов → reset → перезапуск»
            // крутился бы вечно. Честный отказ этой попытки.
            if (typeof stillAlive === 'function' && !stillAlive()) {
              reject(new Error('whisper-server умер при старте (порт занят чужим процессом или мгновенный краш)'));
              return;
            }
            resolve();
          },
          () => {
            if (pendingReject === reject) pendingReject = null;
            if (disposed) {
              pollTimerId = null;
              reject(new Error('stt: dispose() во время ready-поллинга'));
              return;
            }
            // Тот же боевой инцидент: ребёнок умер, пока мы поллим, — нет
            // смысла ждать дедлайн 20с, порт больше некому открыть.
            if (typeof stillAlive === 'function' && !stillAlive()) {
              pollTimerId = null;
              reject(new Error('whisper-server умер при старте (мгновенный выход — краш или порт занят)'));
              return;
            }
            if (now() > deadline) {
              pollTimerId = null;
              reject(new Error('whisper-server: таймаут готовности (20с)'));
              return;
            }
            pendingReject = reject; // ждём следующего тика — восстанавливаем ссылку для dispose()
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
  //
  // Important-1: если модуль уже disposed — отказываем СРАЗУ, ни одного
  // spawnProc. Это не только следствие teardown, но и то, что закрывает
  // потенциальную дыру «retry внутри transcribeWav оживляет новый сервер
  // сразу после dispose()» — см. transcribeWavImpl ниже.
  function ensureServer() {
    if (disposed) {
      return Promise.reject(new Error('stt: dispose() уже вызван — модуль больше не используется'));
    }
    if (readyPromise) return readyPromise;

    let resolved;
    try {
      resolved = resolveRoot();
    } catch (err) {
      return Promise.reject(err);
    }
    if (!resolved.ok) {
      const detail = resolved.diag.length ? resolved.diag.join('; ') : '(нет данных)';
      return Promise.reject(new Error(`Голосовой стек не найден. Проверено: ${detail}`));
    }

    // Ре-проба демотированного бекенда (Minor-1 ревью инцидент-фикса):
    // только на ХОЛОДНОМ старте (сюда не попасть, пока жив сервер или идёт
    // подъём — readyPromise вернулся бы выше) и только спустя
    // BACKEND_RETRY_AFTER_MS. Внутри-диктовочный ретрай приходит через
    // секунды после демоции — интервал его отсекает, откат предпочтения
    // ему не грозит.
    if (preferredBackendIdx > 0 && demotedAt !== null && now() - demotedAt >= BACKEND_RETRY_AFTER_MS) {
      preferredBackendIdx = 0;
      demotedAt = null;
      log('[stt] интервал после отказа бекенда вышел — пробуем CUDA снова');
    }

    const port = Number(cfg.serverPort) || DEFAULT_PORT;

    const self = (async () => {
      // Ре-ревью раунда 1 (хвост B2): весь цикл — под catch-обёрткой.
      // Синхронный бросок из пролога итерации (spawnProc вернул null →
      // child.on кинул TypeError; registerProcess упал) происходил ДО
      // строки-фикса B2 — readyPromise оставался навсегда реджектнутым,
      // тот самый паралич модуля, ради которого B2 был Critical.
      //
      // `await undefined` первым делом — НЕ косметика: он откладывает всё
      // тело (включая синхронные броски пролога) в микрозадачу, которая
      // выполняется ПОСЛЕ `readyPromise = self` ниже и после завершения
      // инициализации const self. Без него catch при синхронном броске
      // работал бы во время инициализации self (TDZ → ReferenceError), а
      // `readyPromise = self` после конструирования всё равно установил бы
      // уже реджектнутый промис.
      await undefined;
      try {
        return await ensureLoop();
      } catch (err) {
        if (readyPromise === self) readyPromise = null;
        throw err;
      }
    })();

    async function ensureLoop() {
      let lastErr = null;
      lastBacksCount = resolved.backs.length;
      // Перебор стартует с preferredBackendIdx (см. объявление): после смерти
      // CUDA на инференсе следующая попытка не тратит время на него снова.
      const startIdx = Math.min(preferredBackendIdx, resolved.backs.length - 1);
      for (let i = startIdx; i < resolved.backs.length; i++) {
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

        // Именованный хендлер + сохранённая ссылка (exitHandler) — killProc
        // снимает ИМЕННО его через removeListener, не трогая чужие 'exit'-
        // слушатели (B3). Guard `proc !== child` — защита на случай, если
        // хендлер всё же переживёт killProc (нестандартный child без
        // removeListener и без стандартного removeAllListeners): не даём
        // ЧУЖОМУ, уже неактуальному событию затереть состояние уже нового
        // сервера.
        const onExit = () => {
          if (proc !== child) return;
          proc = null;
          exitHandler = null;
          serverPort = 0;
          readyPromise = null;
          activeBackendDir = null;
          warm = false;
        };
        child.on('exit', onExit);
        exitHandler = onExit;

        const deadline = now() + READY_TIMEOUT_MS;
        try {
          await waitReady(port, deadline, () => proc === child);
          warm = true;
          preferredBackendIdx = i; // успешный старт закрепляет бекенд для следующих переборов
          log(`[stt] whisper-server готов: бекенд ${backend.dir}${backend.cuda ? ' (CUDA)' : ' (CPU)'}, порт ${port}`);
          return;
        } catch (err) {
          lastErr = err;
          log(`[stt] бекенд ${backend.dir} не поднялся (${err.message})`);
          killProc(); // снимает НАШ exit-хендлер, добивает процесс, обнуляет readyPromise
          if (disposed) throw err; // Important-1: teardown посреди перебора — не продолжаем со следующим бекендом
          readyPromise = self; // восстанавливаем in-flight промис для следующей итерации/параллельных вызовов
        }
      }
      // B2 (ревью раунд 1, Critical): очистка readyPromise при провале
      // ВСЕГО перебора — теперь живёт в catch-обёртке self выше (хвост
      // ре-ревью: синхронные броски из пролога итерации тоже должны её
      // проходить). Иначе readyPromise навсегда остаётся УЖЕ РЕДЖЕКТНУТЫМ
      // промисом (truthy → короткое замыкание `if (readyPromise) return
      // readyPromise;`), и модуль отравлен до перезапуска кокпита одним
      // моргнувшим драйвером при прогреве. У Companion это было
      // замаскировано приватностью модуля — здесь ensureServer() публичен,
      // чиним внутри, не полагаясь на вызывающий код.
      throw lastErr || new Error('whisper-server: не удалось запустить ни один бекенд');
    }

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
    let res;
    try {
      res = await httpPost(serverPort, '/inference', headers, body, INFER_TIMEOUT_MS);
    } catch (err) {
      // Ревью инцидент-фикса, Critical-1: транспортный провал (сокет
      // сброшен/таймаут = сервер НЕ ОТВЕТИЛ ВООБЩЕ) метится явно. Полагаться
      // на `proc === null` в вызывающем catch нельзя: reject сокета —
      // микрозадача, а событие exit ребёнка на Windows едет через
      // threadpool-хоп и приходит ПОЗЖЕ всегда (20/20 замеров зонда) —
      // критерий «сервер умер» по одному proc не срабатывал бы никогда.
      if (err && typeof err === 'object') err.sttTransport = true;
      throw err;
    }
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

  // transcribeWavImpl(buffer) → Promise<string> — фактическая логика одного
  // распознавания (buffer — WAV, whisper.cpp сам ресемплит). Тонкость 7
  // брифа: не-200/таймаут /inference → ОДИН ретрай (killProc → ensureServer
  // → повторный POST); второй провал — reject (никакого CLI-фоллбэка, см.
  // шапку файла). Вызывать НАПРЯМУЮ нельзя — только через transcribeWav()
  // ниже (сериализация, B1).
  async function transcribeWavImpl(buffer) {
    // Ревью инцидент-фикса, Important-1: различаем «упал СТАРТ» (started
    // false — ensureServer реджектнул, бекенды перебраны там, демотировать
    // нечего и не за что) и «умер НА ИНФЕРЕНСЕ» (started true + транспортный
    // провал POST — сервер поднялся, но не пережил работу: VRAM занята,
    // зависший инференс). Только второе — вина бекенда.
    let started = false;
    try {
      await ensureServer();
      started = true;
      return await postInference(buffer);
    } catch (err) {
      // Боевой инцидент фазы 9: сервер умер на инференсе (рабочие буферы
      // CUDA не влезли в занятую VRAM) — ретрай на том же бекенде
      // бессмыслен, он умрёт так же. Критерий — транспортная метка POST
      // (сокет сброшен/таймаут; см. Critical-1 у postInference) ЛИБО уже
      // обнулённый proc (exit всё-таки успел). Живой сервер с не-200/битым
      // JSON — НЕ смерть, бекенд не виноват. CPU последний — остаёмся.
      const diedOnInference = started && (proc === null || (err && err.sttTransport === true));
      if (diedOnInference && lastBacksCount > 0 && preferredBackendIdx < lastBacksCount - 1) {
        preferredBackendIdx += 1;
        demotedAt = now();
        log(`[stt] сервер умер на инференсе (${err.message}) — пробую следующий бекенд`);
      } else {
        log(`[stt] сервер недоступен (${err.message}), перезапуск`);
      }
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

  // B1 (Critical, ревью раунд 1) — сериализация конкурентных transcribeWav()
  // цепочкой промисов, портировано из эталона Companion (:288-292, `chain`)
  // буквально: whisper-server ОДНОПОТОЧНЫЙ, а push-to-talk на renderer-
  // стороне (Task 3) запрещает только две одновременные ЗАПИСИ — но НЕ
  // повторное нажатие Shift, пока идёт РАСПОЗНАВАНИЕ предыдущей (индикатор
  // «🎤 …», спека). Без сериализации: конкурентный вызов №1 (POST вернул 500)
  // и вызов №2 (висит на POST к ТОМУ ЖЕ серверу) гонятся друг за другом —
  // killProc ретрая №1 убивает сервер, на котором висит POST №2 → тот тоже
  // проваливается → его СОБСТВЕННЫЙ ретрай убивает уже НОВЫЙ (только что
  // поднятый вызовом №1) сервер → как минимум одна диктовка теряется, а
  // моделей (~1ГБ каждая) грузится втрое больше нужного. Цепочка гарантирует
  // строго последовательное выполнение — второй вызов даже не начинает свой
  // POST, пока не осядет (успехом или неудачей) первый целиком, включая его
  // собственный ретрай.
  let chain = Promise.resolve();
  // Инцидент 8ГБ (01.08): тёплый whisper-server держит ~1ГБ ОЗУ вечно —
  // «тёплый до выхода» из спеки на 8ГБ-машине превращается в постоянный
  // дефицит памяти. Глушим сервер после STT_IDLE_STOP_MS простоя (перевзвод
  // таймера на каждом transcribeWav) — следующая диктовка просто прогреется
  // заново (~2с на CUDA). Таймер снимается в dispose().
  function armIdleShutdown() {
    if (disposed) return;
    if (idleTimer !== null) clearTimer(idleTimer);
    idleTimer = setTimer(() => {
      idleTimer = null;
      if (disposed || !proc) return;
      log(`[stt] простой ${Math.round(STT_IDLE_STOP_MS / 60000)} мин — глушим whisper-server (возврат ~1ГБ ОЗУ)`);
      killProc();
    }, STT_IDLE_STOP_MS);
  }

  function transcribeWav(buffer) {
    const result = chain.catch(() => {}).then(() => transcribeWavImpl(buffer));
    // Перевзвод idle-таймера ПОСЛЕ оседания (успех или провал — сервер тёплый
    // в обоих случаях); в chain кладём хвост с уже проглоченной ошибкой,
    // чтобы вызывающий получил СВОЙ result с честным reject.
    chain = result.catch(() => {}).then(() => armIdleShutdown());
    return result;
  }

  // {available, backend, warm}. available — найден ли стек ХОТЯ БЫ где-то
  // (не зависит от того, запущен ли сейчас сервер); backend/warm — про
  // ТЕКУЩИЙ живой процесс, если он есть.
  function status() {
    try {
      let resolved = { ok: false };
      try {
        resolved = resolveRoot();
      } catch { /* битый fs/config — трактуем как «не найден», не бросаем */ }
      return { available: !!resolved.ok, backend: activeBackendDir, warm };
    } catch {
      return { available: false, backend: null, warm: false };
    }
  }

  // Убить серверный процесс и снять все таймеры (teardown приложения —
  // рядом с nightWatch.dispose()). Никогда не бросает наружу.
  //
  // Important-1 (ревью раунд 1): помимо снятия pollTimerId (уже было),
  // ставим терминальный disposed=true (см. ensureServer()/waitReady выше —
  // блокирует и новые спавны, и планирование новых таймеров в continuation
  // уже летящих httpGet) И явно будим pendingReject, если ensureServer()
  // сейчас висит в ожидании готовности — иначе вызывающий (transcribeWav)
  // остаётся PENDING навсегда, а renderer — в «🎤 …» до ручной перезагрузки.
  function dispose() {
    try {
      disposed = true;
      if (idleTimer !== null) {
        clearTimer(idleTimer);
        idleTimer = null;
      }
      if (pollTimerId !== null) {
        clearTimer(pollTimerId);
        pollTimerId = null;
      }
      if (pendingReject) {
        const reject = pendingReject;
        pendingReject = null;
        reject(new Error('stt: dispose() вызван во время ожидания готовности сервера'));
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
