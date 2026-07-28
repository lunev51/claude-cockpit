# Cockpit Phase 6 — Diff-панель и GitHub-панель

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Видеть состояние работы, не заходя в терминал: боковая diff-панель «что Claude наменял» у каждой вкладки и GitHub-слой (бейдж PR на вкладке + раздел в дашборде с открытыми PR, issues и уведомлениями).

**Architecture:** Два новых чистых модуля в main (`git-info.js`, `gh-info.js`) с инжектируемым раннером процессов; данные тянутся лениво и кэшируются с TTL; renderer получает готовые агрегаты. Diff — БОКОВАЯ ПАНЕЛЬ внутри `#main` справа от терминала (НЕ оверлей: оверлеев уже четыре и они дерутся за Escape — см. carryover), GitHub-раздел живёт внутри существующего дашборда.

**Спека:** §3.17 (diff-панель), §3.22 (GitHub-панель).
**Carryover фазы 5:** `docs/superpowers/plans/2026-07-28-phase6-carryover-notes.md` — пункты 4 (осиротевшие npx), 5 (пин ccusage), 7 (single-flight у get) закрываются в Task 5; остальные переносятся дальше.

## Global Constraints

- Никаких новых npm-зависимостей: `git` и `gh` вызываются как процессы, парсинг свой.
- Все внешние вызовы — через инжектируемый `run(cmd, args, opts)`; модули чистые и тестируются `node --test`.
- Никогда не бросать наружу: любая ошибка → `{ok:false, error}`; отсутствие git-репозитория/`gh`/сети — нормальная ситуация, а не сбой.
- Ограничение объёма: diff режется до 200 файлов и 2000 строк с явной пометкой «показано N из M» — терминал не должен захлебнуться.
- В smoke-режиме НЕ спавнить ни `git`, ни `gh`.
- Палитра — только токены v2; статусы PR — существующие `--ok/--warn/--err/--working`.
- `taskkill /F` запрещён; тестовые инстансы закрывать `taskkill /PID <pid>` без `/F`.
- Каждая задача: `npm test` + `npm run smoke` (exit 0) → commit. Комментарии по-русски.
- Все живые проверки — СИНХРОННО, с таймаутами; фоновых прогонов не запускать (на этом уже зависал агент).

---

### Task 1: git-info.js — состояние репозитория и дифф (TDD)

**Files:** Create `src/main/git-info.js`, `test/git-info.test.js`

**Interfaces:**
- `createGitInfo({ run, now, cache, ttlMs = 3000 })`; `run(args, cwd)` → `{code, stdout, stderr}`.
- `get(cwd, { force = false })` → Promise:
```js
{
  ok: bool, isRepo: bool, error: null|'not-a-repo'|'git-missing'|'failed',
  branch: string|null, ahead: number, behind: number,
  files: [ { path, status: 'M'|'A'|'D'|'R'|'?'|'C'|'U', staged: bool, added: number, removed: number } ],
  diff: string,            // текст unified-диффа (уже урезанный)
  truncated: { files: number, lines: number } | null,  // сколько скрыто
  fetchedAt: number,
}
```
- Команды (все с `-c core.quotepath=false`, чтобы кириллица в путях не превращалась в escape-последовательности):
  - `status --porcelain=v1 -b` → ветка, ahead/behind, список файлов и их статусы;
  - `diff --numstat HEAD` (и `--staged` если нужно) → числа добавленных/удалённых по файлам;
  - `diff HEAD` → текст диффа; при превышении лимитов — обрезать и заполнить `truncated`.
- TTL-кэш по cwd (Map); `force` его игнорирует. Не в репозитории (`code != 0` + текст «not a git repository») → `{ok:true, isRepo:false}` — это НЕ ошибка.
- `git` отсутствует (ENOENT) → `{ok:false, error:'git-missing'}`, кэшировать этот факт (не дёргать каждые 3 с).

- [ ] Тесты: разбор `-b` строки с ahead/behind и без; переименования (`R  old -> new`); неотслеживаемые (`??`); кириллические пути; не-репозиторий; отсутствие git; обрезка по лимиту файлов и строк с корректным `truncated`; TTL (второй вызов внутри TTL не зовёт `run`), `force` зовёт.
- [ ] RED → реализация → GREEN → commit `feat: git-info module for diff panel`.

---

### Task 2: Diff-панель в интерфейсе

**Files:** Create `src/renderer/js/diffpanel.js`; Modify `index.html`, `app.css`, `app.js`, `ipc.js`, `preload.js`, `connector.js`, `sessions.js`

**Interfaces:**
- IPC `git:get (tabId, {force})` → main берёт cwd вкладки из `manager.list()` и зовёт `gitInfo.get`. preload `git.get(tabId, opts)`.
- Панель: справа внутри `#main`, ширина 380px, сворачивается/разворачивается по **Ctrl+G** и по кнопке в панели действий; состояние (открыта/закрыта) хранить в конфиге через `config:set` (`ui.diffPanelOpen`).
- Содержимое: шапка «ветка · +N −M · X файлов» (при ahead/behind — «↑2 ↓1»); список файлов со значком статуса и числами; ниже — текст диффа моноширинным, с раскраской строк (`+` → `--ok`, `-` → `--err`, `@@` → `--text-dim`); при `truncated` — строка «показано N из M файлов». Клик по файлу — прокрутка к его секции в диффе.
- Пустые состояния: не репозиторий → «проект не под git»; нет изменений → «изменений нет»; `git-missing` → «git не найден в PATH».
- Обновление: (1) при открытии панели и при переключении вкладки; (2) по хуку **PostToolUse** с дебаунсом 1500 мс; (3) кнопка «Обновить» в шапке панели.
- **PostToolUse надо добавить в хуки** (`connector.js` сейчас ставит 5 событий): добавить шестое, `matcher: '*'`. ВАЖНО: `isConnected()` сейчас проверяет лишь наличие маркера `cockpit-hook.js` — после добавления события старые проекты будут считаться подключёнными, но PostToolUse слать не будут. Fix: `isConnected` должна проверять, что присутствуют ВСЕ события из `EVENTS`; тогда кнопка ⚡ снова загорится и один клик дополнит настройки. Тест на это обязателен.
- `sessions.applyHookEvent`: обработать `PostToolUse` — статус не менять (это не сигнал ожидания), но эмитить `onEvent('git:changed', {tabId})`, чтобы renderer знал, что пора обновить панель.

- [ ] Шаги: connector (+событие, +строгий isConnected, тесты) → sessions (PostToolUse → git:changed, тест) → IPC/preload → UI-модуль и стили → проводка Ctrl+G и кнопки → `npm test` + smoke → живая проверка через CDP (панель открывается, показывает реальные изменения в репозитории кокпита) → commit `feat: diff panel with PostToolUse-driven refresh`.

---

### Task 3: gh-info.js — данные GitHub (TDD)

**Files:** Create `src/main/gh-info.js`, `test/gh-info.test.js`

**Interfaces:**
- `createGhInfo({ run, now, cache, ttlMs = 180000 })`; `run(args, cwd)` → `{code, stdout, stderr}` (в проде — `gh` через execFile с `shell:true` на Windows, как для npx).
- `getRepo(cwd, {force})` → `{ok, error:null|'no-gh'|'no-remote'|'auth'|'failed', repo: 'owner/name'|null, pr: null | {number, title, state, isDraft, checks: 'passing'|'failing'|'pending'|'none', reviewDecision: string|null, url}}`
  - Команда: `gh pr status --json number,title,state,isDraft,statusCheckRollup,reviewDecision,url` в cwd проекта; берём `currentBranch`.
  - Нет remote/не репозиторий → `{ok:true, error:'no-remote'}` (не ошибка); `gh` не установлен → `'no-gh'`; не авторизован → `'auth'`.
- `getGlobal({force})` → `{ok, error, prs: [{repo, number, title, checks, url}], issues: [{repo, number, title, url}], notifications: number}`
  - `gh search prs --author=@me --state=open --json ...` (или `gh pr list` по каждому проекту — выбрать по фактической доступности команд, проверить руками и зафиксировать в отчёте), `gh search issues --assignee=@me --state=open`, `gh api notifications --jq length`.
- Кэш с TTL 3 мин, отдельный per-cwd для `getRepo` и общий для `getGlobal`.

- [ ] **Первый шаг — руками:** выполнить `gh pr status --json ...`, `gh search prs ...`, `gh api notifications` в репозитории кокпита, посмотреть фактические поля и коды возврата; зафиксировать в отчёте и использовать как фикстуры.
- [ ] Тесты: разбор реального образца; ветка без PR; не-репозиторий; `gh` отсутствует; ошибка авторизации; TTL/force; вычисление `checks` из `statusCheckRollup` (passing/failing/pending/none).
- [ ] RED → реализация → GREEN → commit `feat: gh-info module (PR status, issues, notifications)`.

---

### Task 4: GitHub в интерфейсе

**Files:** Modify `tabs.js`, `app.js`, `dashboard.js`, `app.css`, `ipc.js`, `preload.js`

**Interfaces:**
- IPC `gh:repo (tabId, {force})`, `gh:global ({force})`; preload соответственно.
- **Бейдж PR на строке сайдбара:** маленький значок `#123` справа от имени проекта; цвет: `--working` (pending), `--ok` (passing), `--err` (failing), `--text-dim` (нет проверок/черновик). Тултип — заголовок PR. Клик по бейджу открывает PR в браузере (`shell.openExternal`, уже есть в preload). Обновление: при открытии вкладки и раз в 3 мин (общий таймер, `unref`).
- **Раздел «GitHub» в дашборде** (после блока расходов): «Мои открытые PR» (репозиторий, номер, заголовок, статус проверок), «Назначенные issues», «Непрочитанных уведомлений: N» со ссылкой. Пустые состояния: «gh не установлен» / «нет открытых PR». Клик по строке — открыть в браузере.
- Данные тянуть лениво: `gh:global` — только при открытии дашборда (не на старте приложения).

- [ ] Шаги: IPC/preload → бейджи в tabs.js → раздел в dashboard.js → стили → smoke → живая проверка через CDP (в репозитории кокпита есть смёрженные PR; проверить на ветке с открытым PR либо создать временный черновой PR и удалить) → commit `feat: GitHub badges and dashboard section`.

---

### Task 5: Хвосты carryover фазы 5

- [ ] 1. **Осиротевшие npx-процессы** (`ipc.js`): `execFile(..., {shell:true, timeout})` при таймауте убивает `cmd.exe`, но не внука-node. Хранить ссылки на живые дочерние процессы и убивать дерево (`taskkill /PID <pid> /T` БЕЗ `/F`) в `disposeSessions()`; при таймауте — то же самое.
- [ ] 2. **Пин версии ccusage**: `ccusage@latest` → `ccusage@20.0.19` (скорость + предсказуемость + меньше supply-chain-поверхности). Вынести версию в константу с комментарием, как обновлять.
- [ ] 3. **Single-flight у `ccusage.get()`** (`usage-ccusage.js`): сейчас IPC защищает refresh от refresh, но не get от refresh — до четырёх параллельных npx. Флаг «в полёте» внутри модуля + тест.
- [ ] commit `fix: phase 5 carryover — process cleanup, pinned ccusage, single-flight`.

---

## Приёмка фазы (руками)

1. Ctrl+G открывает панель справа; в проекте с изменениями видно ветку, файлы и цветной дифф; после действия Claude панель обновляется сама.
2. Кнопка ⚡ снова горит на подключённых ранее проектах (добавилось событие) — клик, перезапуск сессии, панель начинает обновляться автоматически.
3. На вкладке проекта с открытым PR виден бейдж с номером и цветом проверок; клик открывает PR в браузере.
4. Ctrl+D → в дашборде раздел GitHub с моими PR, issues и числом уведомлений.

## Self-Review (выполнен)

1. **Coverage:** §3.17 ✓ (T1,T2), §3.22 ✓ (T3,T4), carryover 4/5/7 ✓ (T5). FTS-поиск, очередь промптов, библиотека промптов, именованные воркспейсы, голос — следующие фазы, не дыра.
2. **Placeholders:** нет; единственная неопределённость (фактические команды/поля `gh`) снабжена требованием проверить руками и зафиксировать образец, форма нормализованных объектов задана жёстко.
3. **Consistency:** оба модуля отдают `{ok, error, fetchedAt}` в одном стиле с фазой 5; diff — панель, а не оверлей (осознанно, чтобы не усугублять драку за Escape); PostToolUse требует ужесточить `isConnected`, иначе старые проекты молча не получат новое событие — это зафиксировано как обязательный тест.
