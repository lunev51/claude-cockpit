# Cockpit Phase 9 — Голосовой ввод Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Push-to-talk на правый Shift: локальное распознавание whisper.cpp (порт готового стека из Claude Companion), текст в активную вкладку + Enter.

**Architecture:** `stt.js` — порт Companion-модуля на конвенцию кокпита (фабрика с инжекцией, реестр процессов); `recorder.js`/`pcm-worklet.js` — копия как есть; обвязка ipc.js + Shift-обработка в app.js. Спека: `docs/superpowers/specs/2026-07-29-voice-input-design.md` — источник правды, читать при любой неясности. Источник порта: `C:\Users\Lunev\AssistClaude\claude-companion` — ТОЛЬКО ЧТЕНИЕ.

**Tech Stack:** Electron 29 (пиннут), node --test, whisper.cpp (готовые exe из Companion), никаких новых npm-зависимостей.

## Global Constraints

- Никаких новых npm-зависимостей и НИКАКИХ нативных модулей (spawn готового exe — не нативный модуль).
- Чистые модули с инжекцией всех эффектов; тесты `node --test` без Electron и без реальных процессов/сети.
- Никогда не бросать наружу; сбой → лог + деградация (тост из обвязки).
- В smoke не спавнить процессы, не трогать userData; stt-хендлеры отвечают заглушкой.
- Только токены дизайна v2; комментарии по-русски.
- Голый CR в pty запрещён; доставка текста — через существующий гард статуса (writeCommandToTab-семейство) + normalizeForPty.
- Решения пользователя (менять нельзя): текст сразу в терминал + Enter; активация ТОЛЬКО зажатый правый Shift; отпускание <300 мс — отмена.
- Стек НЕ копировать: конфиг `stt.stackRoots`, кандидаты `[appRoot кокпита, 'C:\\Users\\Lunev\\AssistClaude\\claude-companion']`, валиден первый с `whisper-server.exe` И файлом модели.
- Порт сервера кокпита: **48753** (Companion на 48752 — параллельная работа).
- Каждая задача: `npm test` + `npm run smoke` (оба exit 0) → commit. Работать СИНХРОННО, без фоновых прогонов.

---

### Task 1: stt.js — ядро распознавания (порт с инжекцией, TDD)

**Files:** Create `src/main/stt.js`, `test/stt.test.js`. Источник порта (читать целиком, 299 строк): `C:\Users\Lunev\AssistClaude\claude-companion\src\main\stt.js`.

**Interfaces (Produces для Task 2):**
- `createStt({ spawnProc, httpGet, httpPost, fs, now, setTimer, clearTimer, registerProcess, config, log })` → `{ transcribeWav(wavBuffer) → Promise<string>, ensureServer() → Promise<void>, status() → {available, backend, warm}, dispose() }`
  - `spawnProc(exe, args)` → child-подобный объект `{pid, on(), removeAllListeners(), kill()}`;
  - `httpGet(port, path, timeoutMs)` → Promise<{status}> (пинг готовности);
  - `httpPost(port, path, headers, bodyBuffer, timeoutMs)` → Promise<{status, body}> (инференс);
  - `registerProcess(child)` — регистрация в реестре runners.js (Task 2 передаст настоящую, тесты — фейк);
  - `config` = секция `stt` (см. Global Constraints + `{model:'large-v3-turbo-q5_0', language:'ru', threads:6, serverPort:48753}`).
- Внутренняя логика — 1-в-1 из Companion, обязательные к сохранению тонкости:
  1. Выбор корня стека: первый из `config.stackRoots`, где есть хотя бы один `vendor/whisper*/whisper-server.exe` И `models/whisper/ggml-<model>.bin`. Ни одного → `status().available=false`, `ensureServer()` реджектит с внятным сообщением.
  2. Бекенды в порядке: `whisper-cuda` → `whisper`; CUDA получает доп-аргументы `--no-flash-attn --no-fallback`.
  3. Аргументы сервера: `-m <model> -t <threads> -l <language> --host 127.0.0.1 --port <port> -nt`.
  4. Готовность: поллинг `httpGet(port,'/')` раз в 300 мс, дедлайн 20000 мс; провал → killProc → следующий бекенд; `readyPromise` восстанавливается между итерациями (параллельные ensureServer ждут один перебор, не плодят второй сервер).
  5. `killProc`: снять exit-хендлер ДО kill (иначе отложенный exit затирает состояние нового сервера); `kill()` + контрольный `spawnProc('taskkill', ['/PID', pid, '/T', '/F'])`.
  6. Multipart вручную (без зависимостей): part `file` (a.wav, audio/wav) + part `response_format`=json; кириллица безопасна только в UTF-8-теле — никакого argv-пути для текста.
  7. `transcribeWav`: `ensureServer()` → POST `/inference` (таймаут 60000) → JSON `{text}` → trim. Не-200/таймаут → ОДИН ретрай: killProc → ensureServer → повторный POST; второй провал → reject.
  8. Упавший сервер (exit) обнуляет состояние — следующий transcribeWav стартует заново.
  9. `dispose()`: killProc, все таймеры сняты. Никогда не бросает.
- CLI-фоллбэк Companion (`transcribeViaCli`) НЕ портируем — YAGNI: серверный путь + ретрай покрывают отказ, а cp1251-грабли argv в спеке зафиксированы как причина.

- [ ] Тесты (фейковые spawnProc/httpGet/httpPost/fs/таймеры, дёргаются руками): выбор корня (первый валидный из двух; только второй валидный; ни одного → available=false и reject); перебор бекендов (CUDA поднялся; CUDA не поднялся → CPU; оба нет → reject с последней ошибкой); CUDA-аргументы содержат --no-flash-attn/--no-fallback, CPU — нет; ready-поллинг (готов со 2-го пинга; дедлайн истёк → следующий бекенд); параллельные ensureServer → один spawnProc; multipart (boundary в заголовке и теле, части file/response_format, кириллица в теле байт-в-байт UTF-8); transcribeWav happy-path → текст; не-200 → ретрай с killProc и НОВЫМ spawnProc → успех; двойной провал → reject; exit сервера → следующий вызов спавнит заново; killProc снимает exit-хендлер до kill (фейковый child фиксирует порядок вызовов); registerProcess зван для КАЖДОГО spawnProc (включая ретрай); dispose идемпотентен.
- [ ] RED → порт → GREEN → `npm test` + `npm run smoke` → commit `feat: stt core — whisper server lifecycle, transcription (port from Companion)`.

---

### Task 2: Обвязка main — IPC, конфиг, smoke, реестр процессов

**Files:** Modify `src/main/ipc.js`, `src/main/config.js`, `src/preload/preload.js`; Test: дополнить `test/ipc-smoke-gate.test.js`.

**Interfaces:**
- Consumes: `createStt` из Task 1 (сигнатура дословно выше).
- `config.js`: секция `stt` с дефолтами `{ stackRoots: [<appRoot>, 'C:\\Users\\Lunev\\AssistClaude\\claude-companion'], model: 'large-v3-turbo-q5_0', language: 'ru', threads: 6, serverPort: 48753, holdKey: 'ShiftRight', minHoldMs: 300 }` (deepMerge; `<appRoot>` вычисляется в рантайме, не литерал в DEFAULTS — см. как paths.js отдаёт корень).
- `preload.js`: `stt: { transcribe: (wav) => invoke('stt:transcribe', wav), status: () => invoke('stt:status') }`.
- Produces для Task 3: IPC `stt:transcribe` (ArrayBuffer/Uint8Array WAV → string; ошибки → `{error: string}` вместо reject — renderer показывает тост), `stt:status` (→ `{available, backend, warm}`).
- Обвязка в ipc.js: инстанс `createStt` с реальными зависимостями (`spawnProc` → child_process.spawn с windowsHide; `httpGet`/`httpPost` → node:http, как в night-watch нет — писать мелкие обёртки прямо в ipc.js; `registerProcess` — реестр runners.js, тот же, что для gh/git); гейт `smoke`: хендлеры отвечают `{error:'smoke'}`/`{available:false}` БЕЗ создания инстанса; хендлеры — экспортируемые функции (паттерн gitGetHandler) + смоук-гейт тесты с бросающими заглушками; `stt.dispose()` в teardown рядом с nightWatch.dispose(); конфиг читается раз при registerIpc с гардом `|| {}` (урок nightWatch:null).

- [ ] Смоук-гейт тесты: `stt:transcribe`/`stt:status` при smoke:true не зовут ни createStt, ни spawn (заглушки бросают).
- [ ] Реализация → `npm test` + `npm run smoke` → commit `feat: stt wiring — IPC, config, process registry`.

---

### Task 3: Renderer — запись по Shift, индикатор, доставка

**Files:** Create `src/renderer/js/voice/recorder.js`, `src/renderer/js/voice/pcm-worklet.js` (копия из `C:\Users\Lunev\AssistClaude\claude-companion\src\renderer\js\voice\` как есть; допустимы только правки путей импорта); Modify `src/renderer/js/app.js`, `src/renderer/css/app.css`.

**Interfaces:**
- Consumes: `window.api.stt.{transcribe, status}` из Task 2; `VoiceRecorder` из recorder.js (`.start()`, `.stop()` → WAV, `.recording`); существующие в app.js: `overlayFlags()`, `writeCommandToTab`-гард, `showToast`, `tabStore.activeId`, `normalizeForPty`-путь доставки рецептов (найти и переиспользовать ТОТ ЖЕ путь).
- Поведение (спека, раздел Renderer — дословно):
  - keydown `ev.code==='ShiftRight'` (window, capture, без repeat) → гарды: есть активная вкладка; НИ один оверлей из overlayFlags() не открыт; stt доступен (`status().available` — кэшировать при boot, обновлять лениво). Провал гарда доступности → ОДИН тост за сессию «Голосовой стек не найден…», дальше no-op.
  - keyup ShiftRight → стоп записи; длительность <`minHoldMs`(300) → отмена молча; иначе WAV → `stt.transcribe` → текст.
  - Оверлей открылся во время записи → отмена без отправки.
  - Доставка: непустой текст → нормализация переводов строк → гард статуса вкладки (waiting → тост, не отправлять) → `текст+\r` в pty активной вкладки. Пустой → тост «Не расслышал».
  - `{error}` от transcribe → тост с текстом ошибки.
  - Индикатор: во время записи — бейдж «🎤 запись…» в панели действий (создать элемент в #action-bar, класс с токенами v2: фон `--bg-card`, текст `--accent`); во время распознавания — «🎤 …»; скрыт в покое. Плюс класс на #action-bar для рамки записи, если дёшево.
  - Чистые хелперы (решение «старт записи разрешён?» по флагам оверлеев/наличию вкладки/доступности) вынести в экспортируемую функцию и покрыть тестом через динамический import() (паттерн night-format).
- [ ] Реализация → `npm test` + `npm run smoke` (renderer-errors=0) → commit `feat: voice input UI — push-to-talk, indicator, delivery`.
- [ ] Живая приёмка — НЕ имплементером (координатор с пользователем, 5 пунктов из спеки).

---

## Приёмка фазы (руками)

1. Зажать правый Shift → «🎤 запись…» → фраза → отпустить → текст в терминале + отправлен.
2. Короткий Shift (<300 мс) → ничего.
3. Диктовка во вкладку с диалогом разрешения → тост, текст не ушёл.
4. Первая запись за сессию: «🎤 …» пока грузится модель, текст доехал.
5. Companion параллельно → оба работают (48752/48753).

## Self-Review (выполнен)

1. **Coverage:** ядро+контракты whisper (T1) ✓, конфиг/IPC/smoke/реестр/dispose (T2) ✓, Shift/индикатор/гарды/доставка/тосты (T3) ✓; «не копировать стек» — stackRoots в T1/T2; порт 48753 — конфиг T2; отмена <300мс и оверлей-во-время-записи — T3. Спека закрыта.
2. **Placeholders:** нет; все аргументы, тайминги и форматы — точными значениями из спеки.
3. **Type consistency:** сигнатура createStt в T1 (produces) = T2 (consumes); IPC-контракт T2 = T3; имена конфиг-ключей единые (stackRoots/model/language/threads/serverPort/holdKey/minHoldMs).
