# Cockpit Phase 8 — «Ночная смена» Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Авто-продолжение вкладок после сброса 5-часового лимита: детект остановки по лимиту, таймер на `resets_at`, «продолжай» в ту же сессию, powerSaveBlocker, журнал и утренний отчёт.

**Architecture:** Чистая фабрика `night-watch.js` в main (вся логика), файловый журнал `night-journal.js`, обвязка в ipc.js (реальные зависимости + IPC), renderer — кнопка 🌙, действие палитры, секция дашборда. Спека: `docs/superpowers/specs/2026-07-29-night-watch-design.md` — читать при любой неясности, она источник правды.

**Tech Stack:** Electron 29 (пиннут), node --test, никаких новых зависимостей.

## Global Constraints

- Никаких новых npm-зависимостей и НИКАКИХ нативных модулей.
- Логика в чистых модулях с инжектируемыми зависимостями (`now`, таймеры, fs, поллер); тесты `node --test` без Electron.
- Никогда не бросать наружу; любой сбой — запись в журнал + деградация к бездействию.
- В smoke: не спавнить процессы, не трогать userData, НЕ стартовать powerSaveBlocker (обвязка обязана гейтить все три).
- Только токены дизайна v2; комментарии по-русски.
- Голый CR в pty запрещён; вброс «продолжай» — через гард непустого текста; проверка статуса вкладки — непосредственно ПЕРЕД записью.
- Решения пользователя (спека, менять нельзя): глобальный тумблер; всегда текст «продолжай»; выключение только вручную; armed НЕ переживает перезапуск приложения.
- Каждая задача: `npm test` + `npm run smoke` (оба exit 0) → commit. Работать СИНХРОННО, без фоновых прогонов.

---

### Task 1: night-watch.js — чистое ядро (TDD)

**Files:** Create `src/main/night-watch.js`, `test/night-watch.test.js`

**Interfaces:**
- `createNightWatch({ now, setTimer, clearTimer, refreshUsage, getTabStatus, writeToTab, emit, powerBlocker, journal, config })` →
  `{ arm(), disarm(), isArmed(), onTabStop(tabId, prevStatus), onUserInput(tabId), snapshot(), dispose() }`
- `config` дефолты (мержатся поверх переданного): `{ fiveHourThreshold: 95, wakeMarginMs: 60000, staggerMs: 10000, maxResets: 4, retryMs: 300000, maxRetries: 3 }`
- `refreshUsage()` → Promise снапшота usage-oauth (`{ok, fiveHour:{percent,resetsAt}, sevenDay:{percent}}`); может реджектить — ловить.
- `journal` = `{ append(entry), readAll(), reset() }`; entry = `{ ts, type, tabId?, detail? }` — ts проставляет само ядро через `now()`.
- `powerBlocker` = `{ start(), stop() }` — идемпотентные.
- `emit(event, payload)` — ядро шлёт `emit('night:changed', snapshot())` после КАЖДОГО изменения состояния.
- `snapshot()` → `{ armed, pendingCount, wakeAt: ms|null, resetsHandled, journal: [...journal.readAll()] }`.

**Семантика (из спеки, дословно к реализации):**
- `arm()`: armed=true, resetsHandled=0, pending=[], `journal.reset()` + append `{type:'armed'}`. Повторный вызов — no-op. `disarm()`: снять таймер, pending=[], блокер stop, append `{type:'disarmed'}`. Только эти два меняют armed.
- `onUserInput(tabId)`: `lastInputAt.set(tabId, now())` — всегда, даже не armed (дёшево, а история ввода нужна на момент детекта).
- `onTabStop(tabId, prevStatus)`: гарды по порядку — `armed`; `prevStatus === 'working'`; `resetsHandled < maxResets` (иначе append `{type:'cap-reached', tabId}`); tabId ещё не в pending. Затем `await refreshUsage()` (reject → append `{type:'usage-error'}`, выход) и ПОСЛЕ await перепроверить armed (могли disarm-нуть, пока ждали). Снапшот `ok:false` → append `{type:'no-usage-data', tabId}`, выход. `sevenDay.percent >= 99` → append `{type:'weekly-limit', tabId}`, выход. `fiveHour.percent >= fiveHourThreshold`: `resetsAt` null → append `{type:'no-resets-at', tabId}`, выход; иначе pending.push({tabId, detectedAt: now(), resetsAt}), append `{type:'limit-stop', tabId, detail: String(resetsAt)}`, перепланировать таймер на `max(всех pending resetsAt) + wakeMarginMs`, блокер-инвариант, emit. Ниже порога → обычное завершение, тишина.
- **Блокер-инвариант** (одна функция, зовётся из всех переходов): `want = armed && (pending.length > 0 || wakePassInFlight)`; want && !on → start; !want && on → stop.
- **Пробуждение** (таймер): `await refreshUsage()`; перепроверить armed. Окно сбросилось (`ok && fiveHour.percent < fiveHourThreshold`): resetsHandled++, retries=0, `wakePassInFlight=true`, забрать pending в локальный список и очистить. Вкладки по очереди со стаггером `staggerMs` (первая сразу, следующие цепочкой `setTimer`); на КАЖДОМ выстреле: если !armed → прервать цепочку (append `{type:'aborted'}`); статус вкладки (`getTabStatus`) `waiting`/`dead`/null → append `{type:'skipped', tabId, detail:'status:<st>'}`; `lastInputAt.get(tabId) > detectedAt` → append `{type:'skipped', tabId, detail:'user-took-over'}`; иначе `writeToTab(tabId, 'продолжай')` + append `{type:'resumed', tabId}`. После последней: `wakePassInFlight=false`, append `{type:'wake-complete', detail:'N of M'}`, блокер-инвариант, emit. НЕ сбросилось (или ok:false): retries++; retries <= maxRetries → таймер через `retryMs`, append `{type:'retry', detail:String(retries)}`; иначе append `{type:'gave-up'}`, pending=[], блокер-инвариант, emit.
- `dispose()`: снять все таймеры, блокер stop (для тестов и quit).
- Ядро НИКОГДА не бросает наружу: каждый публичный метод — try/catch с append `{type:'internal-error', detail: err.message}`.

- [ ] Тесты (fake now/таймеры дёргаются руками; fake refreshUsage — управляемый promise; журнал — массив в памяти): детект working+Stop+95%→pending+таймер+limit-stop; prevStatus 'done'→тишина; percent 50→тишина; ok:false→no-usage-data; reject→usage-error; weekly 99→weekly-limit без планирования; resetsAt null→no-resets-at; дубль tabId в pending не плодится; disarm во время await refreshUsage→после резолва ничего не происходит; пробуждение: сброс→«продолжай» в живую вкладку (проверить точный текст 'продолжай' у writeToTab); waiting/dead/null→skipped со статусом; ввод после detectedAt→skipped user-took-over; ввод ДО detectedAt→resumed (не путать направление сравнения); стаггер: вторая вкладка стреляет только после ручного тика staggerMs; disarm посреди цепочки→aborted, хвост не стреляет; не сбросилось→retry×maxRetries→gave-up; потолок: после maxResets пробуждений новый детект→cap-reached; блокер: start при первом pending, stop после wake-complete/disarm/gave-up, идемпотентность не нарушена; arm→journal.reset(); каждый переход эмитит night:changed.
- [ ] RED → реализация → GREEN → `npm test` + `npm run smoke` → commit `feat: night-watch core (limit-stop detect, timed resume, guards)`.

---

### Task 2: night-journal.js + обвязка в main

**Files:** Create `src/main/night-journal.js`, `test/night-journal.test.js`; Modify `src/main/ipc.js`, `src/main/config.js`, `src/preload/preload.js`; Test: дополнить `test/ipc-smoke-gate.test.js`

**Interfaces:**
- Consumes: `createNightWatch` из Task 1 (сигнатура выше — дословно).
- `createNightJournal({ file, fs })` → `{ append(entry), readAll(), reset() }`. Формат файла: JSON-массив entries. Запись атомарная (temp+rename — образец `workspace.js`/`recipes.js`); битый файл → readAll()=[] + `.bak` перед ПЕРВОЙ перезаписью поверх битого (образец recipes.js, включая «одноразовость» .bak). Никогда не бросает.
- `config.js`: секция `nightWatch` с дефолтами `{ fiveHourThreshold: 95, wakeMarginMs: 60000, staggerMs: 10000, maxResets: 4, retryMs: 300000, maxRetries: 3 }` (deepMerge как у остальных секций).
- `preload.js`: `night: { toggle: () => invoke('night:toggle'), get: () => invoke('night:get'), onChanged: (cb) => on('night:changed', cb) }` — в стиле существующих секций.
- Produces для Task 3: IPC `night:toggle` (→ снапшот после переключения), `night:get` (→ снапшот), push-событие `night:changed` (снапшот).

**Обвязка в ipc.js (все реальные зависимости в одном месте):**
- Инстанс после создания manager/usagePoller: `nightWatch = createNightWatch({...})` где:
  - `refreshUsage: () => usagePoller.refresh()`;
  - `getTabStatus: (tabId)` — из manager.list() (или карты статусов ниже);
  - `writeToTab: (tabId, text) => { const t = String(text || '').trim(); if (t) manager.write(tabId, t + '\r'); }`;
  - `powerBlocker`: обёртка над `require('electron').powerSaveBlocker` с `start('prevent-app-suspension')`/`stop(id)`, идемпотентная (id-гард); **в smoke — no-op объект**;
  - `journal`: реальный `createNightJournal` на `path.join(userData, 'night-journal.json')`; **в smoke — in-memory фейк** (append/readAll/reset на массиве);
  - `emit: (event, payload) => win.webContents.send(event, payload)` (тот же паттерн, что queue:changed);
  - `config: getConfig().nightWatch`.
- **Детект Stop без изменения sessions.js**: обвязка держит `const lastStatusByTab = new Map()`; в существующем месте, где onEvent-события manager уходят в renderer, на `'tab:status'`: `const prev = lastStatusByTab.get(p.tabId); lastStatusByTab.set(p.tabId, p.status); if (p.status === 'done' && prev === 'working') nightWatch.onTabStop(p.tabId, prev);` — переход working→done производится ТОЛЬКО веткой Stop в applyHookEvent (проверить это чтением sessions.js и зафиксировать комментарием). На `tabs:close`/удаление вкладки — чистить запись карты.
- В хендлере `'term:write'` рядом с `manager.write`: `nightWatch.onUserInput(tabId)`.
- IPC-хендлеры `night:toggle`/`night:get` — вынести в экспортируемые функции (паттерн `gitGetHandler` фазы 7, помечены «только для теста») и покрыть смоук-гейт тестами в `test/ipc-smoke-gate.test.js`: при `smoke:true` журнал не пишет на диск и блокер не зовётся (заглушки, которые бросают при вызове).
- Тосты ключевых моментов: обвязка оборачивает journal.append — типы `limit-stop`/`wake-complete`/`weekly-limit`/`gave-up` дополнительно шлют существующий канал notify (`app:notice`) с человеческим текстом («Лимит: продолжу в HH:MM», «Ночная смена: продолжил N вкладок», «Недельный лимит — продолжение невозможно», «Окно не сбросилось — сдаюсь»). HH:MM форматировать из resetsAt.
- На `before-quit`/teardown: `nightWatch.dispose()`.

- [ ] Тесты журнала: append→readAll круговой; reset→пусто; битый файл→[] + .bak одноразовый; атомарность (нет полу-записанного файла при падении rename — проверить через fake fs с бросающим rename: исходный файл цел).
- [ ] RED → реализация → GREEN → смоук-гейт тесты → `npm test` + `npm run smoke` → commit `feat: night-watch wiring — journal, IPC, power blocker, stop detection`.

---

### Task 3: Renderer — кнопка 🌙, палитра, секция дашборда

**Files:** Modify `src/renderer/js/app.js`, `src/renderer/js/dashboard.js`, `src/renderer/css/app.css`

**Interfaces:**
- Consumes: `window.api.night.{toggle, get, onChanged}` из Task 2; снапшот `{ armed, pendingCount, wakeAt, resetsHandled, journal }`.

**Поведение:**
- Кнопка 🌙 в `renderActionBar()` ПОСЛЕ ⌨ (id `btn-night`, класс `action-btn`, тот же mousedown-preventDefault): клик → `api.night.toggle()`; результат/`night:changed` → `classList.toggle('armed', s.armed)` + `title` = «Ночная смена: выкл» / «вооружена — продолжу вкладки после сброса лимита». CSS `.action-btn.armed { color: var(--accent); }` — вооружённость видна издалека (решение спеки: выключение только вручную, компенсатор — заметность).
- Модульный кэш `nightState` в app.js: `boot()` делает `api.night.get()`, подписка `api.night.onChanged` обновляет кэш и кнопку.
- Действие палитры: `{ id: 'night', title: nightState?.armed ? 'Ночная смена: выключить' : 'Ночная смена: включить', hint: '🌙', run: () => api.night.toggle() }` — рядом с «Горячие клавиши».
- Дашборд: секция «Ночная смена» (после секции GitHub): строка состояния — «выключена» / «вооружена, сбросов обработано N» / «ждёт сброса: M вкладок, продолжу в HH:MM» (из wakeAt через существующий formatShortDate/новый formatTime HH:MM в format.js, если его нет — добавить с тестом); ниже — журнал (последние 20 записей, новые сверху): «HH:MM — <человеческий текст типа>» (limit-stop → «встала по лимиту», resumed → «продолжена», skipped+detail → «пропущена: <причина>», weekly-limit → «недельный лимит», wake-complete → «пробуждение: N of M», gave-up → «окно не сбросилось», armed/disarmed → «включена»/«выключена»). Данные — из `api.night.get()` в общем сборе данных дашборда (там же, где usage/git/gh). Пустой журнал → «журнал пуст». Стили — существующие классы dashboard-section/строк + токены, без хардкода.
- Шпаргалка клавиш (`hotkeys.js`): не трогать — у 🌙 нет хоткея, кнопка и палитра достаточны (YAGNI).

- [ ] Реализация → `npm test` + `npm run smoke` (renderer-errors=0) → commit `feat: night-watch UI — arm button, palette action, dashboard section`.
- [ ] Живая GUI-приёмка — НЕ имплементером (координатор с пользователем): взвод, детект на реальном лимите — по обстоятельствам ночи.

---

## Приёмка фазы (руками, вечером)

1. 🌙 → кнопка загорелась акцентом; Ctrl+P показывает «Ночная смена: выключить»; Ctrl+D — секция «вооружена».
2. (Реальная ночь) Вкладка упирается в лимит → тост «продолжу в HH:MM», секция дашборда показывает ожидание, ноутбук не засыпает.
3. После сброса — «продолжай» ушло, работа продолжилась, очередь Ctrl+Q поехала штатно.
4. Утром — журнал в дашборде читается как история ночи.
5. Вкладка с диалогом разрешения НЕ получила «продолжай» (запись «пропущена»).

## Self-Review (выполнен)

1. **Coverage:** детект/таймер/пробуждение/предохранители/блокер (T1) ✓, журнал+IPC+тосты+smoke-гейты (T2) ✓, UI+отчёт (T3) ✓; armed не переживает рестарт — нигде не персистится, покрыто конструкцией (нет чтения при старте). Спека закрыта.
2. **Placeholders:** нет; все типы записей журнала и их человеческие тексты перечислены явно.
3. **Type consistency:** снапшот `{armed, pendingCount, wakeAt, resetsHandled, journal}` одинаков в T1 (produces), T2 (IPC) и T3 (consumes); сигнатура createNightWatch в T1 и T2 дословно совпадает; типы журнала T1 = рендер-маппинг T3.
