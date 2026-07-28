# Cockpit Phase 5 — Дашборд лимитов и расходов

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Лимиты всегда на виду — кольца 5-часового и недельного окна с обратным отсчётом в сайдбаре, плюс дашборд с расходами по проектам и моделям. Это третья исходная боль пользователя («лимиты вслепую»).

**Architecture:** Два слоя данных. Слой A (официальный, главный): `GET https://api.anthropic.com/api/oauth/usage` с OAuth-токеном из `~/.claude/.credentials.json` — даёт проценты 5ч/неделя, время сброса и разбивку по моделям. Слой B (оценка, вторичный): `npx ccusage daily --json` — токены и стоимость по проектам/дням. Оба слоя — чистые модули с инжектируемыми зависимостями; кэш в обычном JSON-файле с TTL (никакого SQLite и нативных модулей — пребилды pty трогать нельзя).

**ПРОВЕРЕНО ПЕРЕД ПЛАНИРОВАНИЕМ (28.07):** эндпоинт отвечает HTTP 200 и отдаёт
`five_hour.utilization/resets_at`, `seven_day.*`, массив `limits[]` (kind session/weekly_all/
weekly_scoped, percent, severity, resets_at, scope.model.display_name) и `spend`.
`npx ccusage@latest --version` → 20.0.19 (пакет в кэше npx). Токен лежит в
`.credentials.json` → `claudeAiOauth.accessToken`.

**ВАЖНО про statusline:** у пользователя УЖЕ настроен свой `statusLine` в
`~/.claude/settings.json` (powershell + statusline.ps1). Claude Code поддерживает только
одну statusline-команду, поэтому слой «statusline-tee» из спеки §5.3 в этой фазе НЕ
реализуем — не ломаем пользовательскую настройку. Слоя A достаточно для всех колец.

**Спека:** §3.6 (кольца лимитов), §3.9 (дашборд), §5.3 (источники данных — с поправкой выше).
**Carryover фазы 4:** `docs/superpowers/plans/2026-07-27-phase5-carryover-notes.md` — пункты 1 (утечка карт в toasts), 2 (Ctrl+R в DevTools) закрываются в Task 5; остальные переносятся.

## Global Constraints

- Electron 29.4.6; НИКАКИХ новых npm-зависимостей (никакого better-sqlite3 — нативные модули сломают пребилды pty). Кэш — обычный JSON-файл в `app.getPath('userData')`.
- ТОКЕН НИКОГДА не покидает main-процесс: не логируется, не уходит в renderer, не пишется в кэш. В renderer уезжают только проценты, метки времени и агрегаты.
- Сеть только к `api.anthropic.com`. При 401/429/офлайне — тихая деградация: показываем последнее известное значение с пометкой «устарело», без спама в консоль.
- Поллинг: не чаще раза в 180 с; один поллер на приложение; таймер `unref`.
- В smoke-режиме сеть НЕ трогать и `npx` НЕ спавнить (иначе прогон станет медленным и флаки).
- Палитра — только токены v2; кольца и графики без новых цветов.
- `taskkill /F` запрещён; тестовые инстансы закрывать `taskkill /PID <pid>` без `/F`.
- Каждая задача: `npm test` + `npm run smoke` (exit 0) → commit. Комментарии по-русски.

---

### Task 1: usage-oauth.js — официальные лимиты (TDD)

**Files:**
- Create: `src/main/usage-oauth.js`, `test/usage-oauth.test.js`

**Interfaces:**
- `createUsagePoller({ readToken, httpGet, now, cache, intervalMs = 180000, log })`:
  - `readToken()` → `{ accessToken, expiresAt } | null` (в проде читает `.credentials.json`; НИКОГДА не логировать значение).
  - `httpGet(url, headers)` → `Promise<{status, body}>` (в проде — `net.request`/`https`).
  - `cache` → `{ read(): object|null, write(obj): void }` (в проде — JSON-файл в userData).
  - `start()` / `stop()` / `snapshot()` — snapshot возвращает нормализованный объект (см. ниже), СИНХРОННО, из памяти.
  - `refresh()` → Promise, один запрос; используется таймером и ручным обновлением.
- Нормализованная форма (единственное, что уходит в renderer):
```js
{
  ok: true|false,          // удалось ли получить свежие данные хоть раз
  stale: bool,             // данные из кэша, последний запрос не удался
  fetchedAt: number,       // ms
  fiveHour:  { percent: number, resetsAt: number|null },
  sevenDay:  { percent: number, resetsAt: number|null },
  scoped: [ { label: string, percent: number, resetsAt: number|null } ], // из limits[] kind=weekly_scoped, label из scope.model.display_name
  error: null | 'auth' | 'rate' | 'network'
}
```
- Правила: 401/403 → `error:'auth'`, поллинг НЕ прекращать, но интервал увеличить до 15 мин (токен могли обновить). 429 → `error:'rate'`, следующий запрос не раньше чем через 10 мин. Сетевые ошибки → `error:'network'`, обычный интервал. Любая ошибка при наличии кэша → `stale:true` + прежние цифры.
- Заголовки: `Authorization: Bearer <token>`, `anthropic-beta: oauth-2025-04-20`, `User-Agent: claude-code/<version>` (версию брать из конфига `usage.userAgentVersion`, дефолт `2.1.220`; заголовок обязателен, иначе 429).

- [ ] **Step 1: `test/usage-oauth.test.js`** — покрыть: успешный разбор реального образца ответа (взять форму из блока «ПРОВЕРЕНО» выше: five_hour 12.0/resets_at, seven_day 2.0, limits с weekly_scoped и `scope.model.display_name='Fable'`); отсутствие токена → `ok:false, error:'auth'`, запрос НЕ отправлен; 401 → error 'auth' и увеличенный интервал; 429 → error 'rate' и отложенный следующий запрос; сетевой сбой при наличии кэша → stale:true и прежние проценты; отсутствие кэша и сбой → ok:false; snapshot() синхронный и не бросает до первого refresh; stop() снимает таймер; токен НЕ появляется ни в одном аргументе `log`.
- [ ] **Step 2:** RED. **Step 3:** реализация. **Step 4:** GREEN. **Step 5:** commit `feat: official usage poller (5h/weekly limits) with graceful degradation`.

---

### Task 2: usage-ccusage.js — расходы по проектам (TDD)

**Files:**
- Create: `src/main/usage-ccusage.js`, `test/usage-ccusage.test.js`

**Interfaces:**
- `createCcusage({ run, cache, now, ttlMs = 600000 })`:
  - `run(args) → Promise<{code, stdout, stderr}>` (в проде — `execFile('npx', ['--yes','ccusage@latest', ...args])` с таймаутом 60 с).
  - `get({ force = false })` → Promise нормализованного объекта; при свежем кэше (моложе ttl) сеть/процесс не трогаем.
- Нормализованная форма:
```js
{
  ok: bool, stale: bool, fetchedAt: number, error: null|'unavailable'|'parse',
  totals: { costUsd: number, tokens: number, sessions: number },
  byProject: [ { name, costUsd, tokens, lastActive } ],   // отсортировано по costUsd убыв.
  byDay: [ { date: 'YYYY-MM-DD', costUsd, tokens } ],     // последние 30 дней
  byModel: [ { model, costUsd, tokens } ],
}
```
- Правила: если `run` бросил/код≠0/вывод не парсится → `ok:false, error:'unavailable'|'parse'`, при наличии кэша отдаём его со `stale:true`. Никогда не бросать наружу.
- Команды ccusage подобрать самостоятельно, проверив реальный вывод на этой машине (`npx ccusage@latest daily --json`, при необходимости `--instances`/`--breakdown`); ФАКТИЧЕСКИЕ команды и форму вывода зафиксировать в отчёте. Если поля называются иначе — адаптировать маппинг, схему выше сохранить.

- [ ] Шаги: сначала руками выполнить `npx ccusage@latest daily --json` и сохранить кусок реального вывода как фикстуру в тесте → тест → RED → реализация → GREEN → commit `feat: ccusage layer for per-project spend`.

---

### Task 3: Кольца лимитов в сайдбаре

**Files:**
- Create: `src/renderer/js/rings.js`
- Modify: `src/main/ipc.js` (IPC + запуск поллера), `src/preload/preload.js`, `src/renderer/index.html`, `src/renderer/css/app.css`, `src/renderer/js/app.js`

**Interfaces:**
- IPC: `usage:get` (handle → snapshot слоя A), событие `usage:update` (main шлёт после каждого refresh).
- `rings.js`: `renderRings(hostEl, snapshot)` — два кольца (conic-gradient, как в мокапе фазы 0): 5ч и неделя, под каждым — процент и обратный отсчёт («сброс через 2ч 13м»); цвет по порогам: `--ok` <60%, `--warn` 60–85%, `--err` >85%; при `stale` — приглушить и добавить title «данные устарели». Клик по кольцам открывает дашборд (Task 4).
- Разметка: блок `#limits` в подвале сайдбара, НАД кнопкой «+ Проект».
- Формат обратного отсчёта — чистая функция `formatCountdown(resetsAt, now)` в `src/renderer/js/countdown.js` + тест: >1ч → «2ч 13м», <1ч → «47м», <1м → «меньше минуты», прошедшее/невалидное → «—».
- app.js: подписка на `usage:update`, первичный `usage:get` при старте, перерисовка колец; таймер раз в 30 с только для обновления обратного отсчёта (без сети).

- [ ] Шаги: тест countdown → RED → реализация → кольца и проводка → smoke → живая проверка через CDP (кольца отрисованы, проценты совпадают с ответом API) → commit `feat: limit rings in the sidebar`.

---

### Task 4: Вкладка дашборда

**Files:**
- Create: `src/renderer/js/dashboard.js`
- Modify: `index.html`, `app.css`, `app.js` (открытие), палитра (действие «Дашборд»), панель действий (кнопка 📊)

**Interfaces:**
- Дашборд — ОВЕРЛЕЙ над терминальной областью (как restore-оверлей), а не отдельная вкладка: проще, не ломает модель вкладок. Открытие: кнопка на панели действий, действие палитры, Ctrl+D. Закрытие: Esc, повторный Ctrl+D, клик вне.
- Содержимое: (1) две крупные полосы лимитов с процентами и отсчётом + строки по моделям из `scoped`; (2) четыре карточки: расход за 30 дней, токены, сессии, средняя цена сессии; (3) таблица по проектам (имя, токены, $, последняя активность), сортировка по $; (4) столбчатый график по дням (простые div-бары, как у Opcode), пресеты 7д/30д. Данные слоя B помечать «оценка».
- Пустое состояние: если слой B недоступен (`ok:false`) — показать только лимиты и строку «расходы недоступны: ccusage не запустился» с кнопкой «Обновить».
- Кнопка «Обновить» дёргает `usage:refresh` (оба слоя, force).

- [ ] Шаги: разметка+CSS → рендер из снапшотов → проводка открытия/закрытия → smoke → живая проверка через CDP (оверлей открывается, цифры лимитов совпадают с API, таблица проектов непуста) → commit `feat: usage dashboard overlay`.

---

### Task 5: Хвосты carryover фазы 4

**Files:** `src/main/toasts.js`, `src/main/ipc.js`, `src/main/main.js`, `src/renderer/js/app.js`, тесты

- [ ] 1. Утечка карт в `toasts.js`: добавить `forget(tabId)`, звать из обработчика `tabs:close` (закрытая вкладка не эмитит `dead`, поэтому записи копятся). +тест.
- [ ] 2. `Ctrl+R` внутри DevTools перезагружает renderer поверх живых вкладок main → дубликаты и второй оверлей. Заблокировать reload: в `before-input-event` перехватывать `Ctrl+R`/`Ctrl+Shift+R`/`F5` и гасить (`preventDefault`), либо `webContents.on('will-navigate')` если он ловит reload — проверить фактически и описать в отчёте. ВАЖНО: Ctrl+Shift+R в терминале — это наш «перезапустить сессию», он должен продолжать работать (перехват на уровне окна не должен его съедать — проверь порядок).
- [ ] 3. `peekedTabId` не сбрасывается в `activateTab()` — сбросить для консистентности.
- [ ] 4. Бейдж считать из стора вкладок, а не из отдельного `waitingTabs` Set (инвариант структурный, а не случайный) — если это дорого, оставить и записать решение.
- [ ] commit `fix: phase 4 carryover — toast map cleanup, reload guard, peek bookkeeping`.

---

## Приёмка фазы (руками)

1. Запустить кокпит — в подвале сайдбара два кольца с реальными процентами (сверить с `/usage` в терминале) и отсчётом до сброса.
2. Ctrl+D — дашборд: лимиты, карточки, таблица проектов, график по дням.
3. Отключить сеть → кольца становятся приглушёнными с пометкой «устарело», приложение не падает.
4. Ctrl+R в DevTools больше не плодит вкладки.

## Self-Review (выполнен)

1. **Coverage:** §3.6 ✓ (T3), §3.9 ✓ (T4), §5.3 слои A и B ✓ (T1,T2; слой statusline-tee СОЗНАТЕЛЬНО исключён — у пользователя свой statusline, ломать нельзя, обоснование в шапке). Carryover фазы 4 ✓ (T5). Diff-панель, GitHub-панель, FTS-поиск, очередь промптов, split view — следующая фаза, не дыра.
2. **Placeholders:** нет. Единственная точка неопределённости (точные команды/поля ccusage) снабжена требованием проверить фактический вывод и зафиксировать в отчёте — форма нормализованного объекта задана жёстко.
3. **Consistency:** оба слоя отдают `{ok, stale, fetchedAt, error}` одинаковой формы; renderer получает только агрегаты (токен не покидает main); кэш — файлы в userData, никаких нативных зависимостей; smoke не ходит в сеть и не спавнит npx.
