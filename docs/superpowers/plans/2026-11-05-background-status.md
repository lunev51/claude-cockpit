# Статус «фон» — вкладка с живой фоновой задачей

> **Для исполнителей:** superpowers:subagent-driven-development, TDD. Шаги `- [ ]`.

**Цель:** вкладка, у которой Claude закончил ход, но оставил живую фоновую
команду или фонового агента, стоит в «Работают» с подписью «фон · …», а не в
«Готово»/«Наготове» (живая жалоба 05.11: запись флешки шла в фоне, вкладка —
«Наготове»).

**Решения владельца (05.11):** (1) секция «Работают», подпись «фон · 1
команда», проверка на зависание к ней НЕ применяется; (2) долгоживущий фон
(dev-сервер на всю сессию) держит вкладку в «Работают», пока жив, — без
ограничения по времени.

**Архитектура:** новый статус ядра `'background'`. Ядро (sessions.js) ведёт по
вкладке множество живых фоновых задач из хуков, которые уже приходят
(PostToolUse, UserPromptSubmit). Отдельный статус, а не `'working'`: ночная
смена ловит остановку по лимиту на переходе из `'working'` в остановку; если бы
Stop с фоном оставлял `'working'`, лимит-стоп вкладки с dev-сервером не
детектился бы никогда.

## Откуда данные (проверено по журналу сессии Claude Code 2.1.318, 05.11)

Хук кокпита (`scripts/cockpit-hook.js`) пересылает payload целиком.

| Что | Событие | Признак |
|---|---|---|
| фоновая команда запущена | PostToolUse, `tool_name` `Bash`/`PowerShell` | `tool_input.run_in_background === true`, `tool_response.backgroundTaskId` (напр. `"btlnghtdk"`) |
| фоновый агент запущен | PostToolUse, `tool_name` `Agent` | `tool_response.isAsync === true`, `tool_response.agentId` (`status: "async_launched"`) |
| агент возобновлён | PostToolUse, `tool_name` `SendMessage` | `tool_response.resumedAgentId` |
| задача снята вручную | PostToolUse, `tool_name` `TaskStop` | `tool_input.task_id` (устар. `shell_id`) |
| задача закончилась | UserPromptSubmit | `prompt` содержит `<task-notification>…<task-id>ID</task-id>…<status>completed|failed|…</status>` (один prompt может нести несколько блоков) |

Monitor и прочие инструменты НЕ считаются (это наблюдатели, не работа).
Форма `tool_response` в хуке = `toolUseResult` в журнале — подтвердить живьём
(координатор, стенд).

## Таблица переходов

Состояния: `working`, `waiting`, `done`, `stuck`, `dead`, `ready`, **`background`** (новое).
`bg` — множество id живых фоновых задач вкладки.

| Событие | Условие | bg | Новый статус | Что видит человек |
|---|---|---|---|---|
| PostToolUse запуск фона (см. таблицу выше) | — | +id | без изменений (ход идёт, `working`) | «Работают», как сейчас |
| PostToolUse TaskStop | — | −id | без изменений | — |
| UserPromptSubmit | prompt с `<task-notification>` | −каждый id из блоков | `working` «думает…» (как сейчас) | «Работают» |
| UserPromptSubmit | обычный промпт | без изменений | `working` (как сейчас) | «Работают» |
| PreToolUse | — | — | `working` (как сейчас) | «Работают» |
| Stop | `bg` не пуст | — | **`background`**, подпись `backgroundSubtitle(bg)`, `awaitingReply=false` | «Работают», «фон · 1 команда» |
| Stop | `bg` пуст | — | `done` (как сейчас) | «Готово» |
| Notification | — | без изменений | `waiting` (как сейчас) | «Ждут тебя» |
| SessionStart | source ≠ `compact` | **очистить** | `ready` (как сейчас) | «Наготове» |
| SessionStart | source = `compact` | без изменений | `working` (как сейчас) | «Работают» |
| процесс вышел / рестарт | — | **очистить** | как сейчас (`dead`/…) | как сейчас |
| markSeen | статус `background` | — | без изменений (трогает только `done`) | — |
| детектор зависания | статус `background` | — | не трогает (только `working` + `awaitingReply`) | — |

Побочные эффекты Stop (вброс очереди при `genProven`, `holdQueueFor`) — **как
сейчас, независимо от bg**: Claude после хода принимает ввод, а при вечном
dev-сервере очередь иначе не сошла бы никогда.

## Глобальные ограничения

- Живой каталог `C:\Users\Lunev\AssistClaude\claude-cockpit` НЕ трогать (там
  работает кокпит владельца). Копия: `C:\Users\Lunev\AssistClaude\cockpit-wt-bg`,
  ветка `feat/background-status` от `origin/main`.
- `npm test` зелёный (старт: 1214). Новый тест сначала красный; стражи — мутацией.
- Фикстуры хуков — реальной формы (см. таблицу «Откуда данные»; `manager.list()`
  отдаёт `tabId`, не `id`).
- Коммиты поимённо, `git commit -F`, по-русски, последняя строка
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Electron не запускать.

## На что смотреть ревью

1. Задача снята в UI Claude Code (`/tasks`) без хука и без уведомления →
   вкладка навсегда в `background`. Проверить, что SessionStart/выход процесса
   чистят; задокументировать как известное ограничение, если других путей нет.
2. Уведомление пришло ДО PostToolUse запуска (гонка порядка хуков) → id не
   должен «залипнуть» навсегда.
3. Один prompt с несколькими `<task-notification>` → все id сняты.
4. Ночная смена: Stop с фоном по лимиту → `onTabStop` срабатывает
   (`shouldDetectLimitStop` принимает переход в `background`); пробуждение
   продолжает `background`-вкладку (не в `NO_RESUME_STATUSES`).
5. Все потребители статусов в renderer и main знают `background` (страж
   `KNOWN_STATUSES` ↔ `STATUSES` уже есть — test/tab-group-markup.test.js).

---

## Задача — одна, ветка `feat/background-status`

**Файлы (по меньшей мере):**
- `src/main/sessions.js` — `STATUSES` + `'background'`; `tab.bg` (Set) в
  создании вкладки; разбор хуков в `applyHookEvent`; очистка на SessionStart
  (не compact) и выходе/рестарте процесса.
- `src/main/background-tasks.js` (новый, CJS, чистые функции):
  - `launchedTaskId(toolName, toolInput, toolResponse)` → `{id, kind: 'shell'|'agent'} | null`;
  - `stoppedTaskId(toolName, toolInput)` → `string | null` (TaskStop);
  - `notifiedTaskIds(prompt)` → `string[]` (все `<task-id>` из `<task-notification>`);
  - `backgroundSubtitle(bg)` → `'фон · 1 команда'`, `'фон · 2 команды'`,
    `'фон · 5 команд'`, `'фон · 1 агент'`, `'фон · 2 агента'`,
    `'фон · 1 команда, 1 агент'` (русская множественность: 1/21 — «команда/агент»,
    2–4/22–24 — «команды/агента», 5–20/11–14 — «команд/агентов»).
  - `bg` хранит `Map<id, kind>`, чтобы подпись знала виды.
- `src/main/ipc.js` — `shouldDetectLimitStop`: остановкой считается и переход в
  `background` (не только `done`); комментарий почему.
- `src/renderer/js/tab-group.js` — `background: 'working'`.
- `src/renderer/css/app.css` — `.tab-dot.background` (как `working`, можно
  приглушённее — на усмотрение, одной строкой).
- Пройти grep'ом всех потребителей статусов (`'working'`, `'done'`, `groupOf`,
  счётчики трея `main.js:606`, `toasts.js`, `app.js` saveGhost на конце хода,
  `attention.js`, `badge.js`, `night-watch.js`) и решить для каждого, как он
  относится к `background`; в отчёте — список с решением. Конец хода
  (`saveGhost` на `done`/`waiting`) — относится и к `background`.

**Тесты (сначала красные):**
- `test/background-tasks.test.js` — все четыре функции на реальной форме
  payload (из таблицы «Откуда данные»), включая prompt с двумя блоками и
  мусорный prompt; множественность 1, 2, 5, 11, 21, 22.
- `test/sessions.test.js` — по таблице переходов: запуск фона + Stop →
  `background` с подписью; уведомление → `working`, затем Stop → `done`;
  TaskStop снимает; SessionStart чистит; compact не чистит; процесс вышел —
  чистит; `background` не становится `stuck` по таймеру; markSeen не трогает;
  вброс очереди на Stop с фоном происходит как раньше.
- `test/ipc-*.test.js` — `shouldDetectLimitStop(working → background)` = true.
- `test/tab-group*.test.js` — `background` в «Работают» (шов STATUSES уже стережёт).

**Отчёт:** коммиты; красные до правки; мутации; потребители статусов с решением;
`npm test` итог.
