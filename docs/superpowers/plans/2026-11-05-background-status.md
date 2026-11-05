# Статус «фон» — вкладка с живой фоновой задачей

> **Для исполнителей:** superpowers:subagent-driven-development, TDD. Шаги `- [ ]`.
> **Состояние:** реализовано в ветке `feat/background-status` (ревью 05.11 —
> APPROVE WITH FIXES, фиксы внесены). План ниже описывает то, что сделано, а
> не первоначальный замысел: первоначальная схема (снимать задачи по
> `<task-notification>` в UserPromptSubmit) отвергнута — см. «Откуда данные».

**Цель:** вкладка, у которой Claude закончил ход, но оставил живую фоновую
команду, фонового агента или Workflow, стоит в «Работают» с подписью
«фон · …», а не в «Готово»/«Наготове» (живая жалоба 05.11: запись флешки шла в
фоне, вкладка — «Наготове»).

**Решения владельца (05.11):** (1) секция «Работают», подпись «фон · 1
команда», проверка на зависание к ней НЕ применяется; (2) долгоживущий фон
(dev-сервер на всю сессию) держит вкладку в «Работают», пока жив, — без
ограничения по времени.

**Архитектура:** новый статус ядра `'background'`. Отдельный статус, а не
`'working'`: ночная смена ловит остановку по лимиту на переходе из работы в
остановку; если бы Stop с фоном оставлял `'working'`, лимит-стоп вкладки с
dev-сервером не детектился бы никогда.

- **Источник истины — поле `background_tasks` хука Stop.** CLI (2.1.316+,
  проверено по бинарю 2.1.316 и 2.1.318) собирает его из реестра задач:
  всё, что `running`/`pending` и в фоне; пустой массив — ничего не летит.
- **Журнал запусков `tab.bg` (Map id → вид) — из PostToolUse основного
  потока.** Нужен только чтобы отличить свой фон от наблюдателей: Monitor в
  списке Stop выглядит как обычная `'shell'` (local_bash с kind monitor).
- **На каждом Stop** журнал сверяется со списком, остаётся только живое; не
  пусто → `'background'` с подписью, пусто → `'done'`. Поэтому отдельная
  очистка на SessionStart/рестарте не нужна: протухший id не переживает
  первого же Stop.
- **Нет поля `background_tasks`** (старый CLI) → `'done'`, как до фичи.

## Откуда данные (бинарь Claude Code 2.1.318 + журналы сессий 05.11)

Хук кокпита (`scripts/cockpit-hook.js`) пересылает payload целиком.

| Что | Событие | Признак |
|---|---|---|
| фоновая команда запущена | PostToolUse, `tool_name` `Bash`/`PowerShell` | `tool_response.backgroundTaskId` (в т.ч. Ctrl+B и уход в фон по таймауту — `run_in_background` во входе тогда нет); НЕ считается при `backgroundEndsWithFinalResponse: true` (CLI снимет сам, без уведомления) |
| фоновый агент запущен | PostToolUse, `tool_name` `Agent` | `tool_response.isAsync === true`, `tool_response.agentId` |
| агент возобновлён | PostToolUse, `tool_name` `SendMessage` | `tool_response.resumedAgentId` |
| Workflow запущен | PostToolUse, `tool_name` `Workflow` | `tool_response.taskType === 'local_workflow'`, `taskId` непуст, нет `error` (операция над идущим прогоном отвечает `taskId: ''`; облачный — `taskType: 'remote_agent'`) |
| что ещё живо | Stop | `background_tasks: [{id, type, status, description, command?, agent_type?, name?}]`; `id` = `backgroundTaskId`/`agentId`/`taskId` |
| хук сабагента | любой хук инструмента | поле `agent_id` (основной поток его не несёт); `agent_id` = id агента в реестре |
| ход начат уведомлением | UserPromptSubmit | `prompt` начинается с `<task-notification>` |

Почему не уведомления: по 60 последним журналам 05.11 `<task-notification>`
92 раза пришёл вложением прямо в идущий ход (`queued_command`), и у 69 задач
из них UserPromptSubmit не увидел уведомления ни разу — журнал, который
снимает задачи по уведомлениям, держал бы вкладку в «фоне» вечно.
Отдельным ходом уведомление пришло 388 раз, UserPromptSubmit сработал на 387.

Monitor и прочие инструменты не считаются (наблюдатели, не работа). Фон,
запущенный сабагентом (`agent_id` в PostToolUse), — не фон вкладки: его
уведомление уходит самому сабагенту.

## Таблица переходов

Состояния: `working`, `waiting`, `done`, `stuck`, `dead`, `ready`, **`background`**.
`bg` — журнал запусков; `inTurn` — идёт ход основного потока (от
UserPromptSubmit или первого его PreToolUse до Stop; сбрасывается и на
spawn). `awaitingReply` для этого не годится: Notification снимает его
посреди хода.

| Событие | Условие | bg / inTurn | Новый статус | Что видит человек |
|---|---|---|---|---|
| PostToolUse основного потока, запуск фона | — | +id | без изменений | — |
| PostToolUse/PreToolUse сабагента | `inTurn` | — | PreToolUse: `working` «Bash…» (как раньше) | «Работают» |
| PreToolUse сабагента | вне хода, процесс жив | +`agent_id` (вид agent) | **`background`** (и из `waiting`, `done`, `ready`); без события, если статус и подпись не изменились; ожидание ответа НЕ взводится | «Работают», «фон · 1 агент» |
| PostToolUse сабагента | вне хода, процесс жив, статус `waiting` с `waitingKind` `permission` | +`agent_id` | без изменений: это может быть параллельный инструмент той же пачки, вопрос ещё висит (B3 ре-ревью) | «Ждут тебя» |
| PostToolUse сабагента | вне хода, процесс жив, иначе (в т.ч. idle-`waiting`) | +`agent_id` | **`background`**, как у PreToolUse | «Работают», «фон · 1 агент» |
| UserPromptSubmit | — | inTurn=true | `working` «думает…»; payload `taskNotification: true`, если ход начат уведомлением | «Работают» |
| PreToolUse основного потока | — | inTurn=true | `working` (как раньше) | «Работают» |
| Stop | живое ∩ bg не пусто | bg=живое, inTurn=false | **`background`**, подпись `backgroundSubtitle`, `genProven` | «Работают», «фон · 1 команда» |
| Stop | пусто или нет поля | bg=живое/пусто, inTurn=false | `done` (как раньше) | «Готово» |
| Notification idle_prompt | статус `background` | — | без изменений, без события | «Работают» |
| Notification | иначе | — | `waiting` (как раньше) | «Ждут тебя» |
| markSeen | `background` | — | без изменений (только `done`) | — |
| детект зависания | `background` | — | не трогает (только `working` + `awaitingReply`) | — |

Почему гарда idle-пинга: CLI глушит `idle_prompt` только при живых фоновых
АГЕНТАХ, а при фоновой команде шлёт его через минуту без фокуса — вкладка с
записью флешки уезжала бы в «Ждут тебя». Почему гарда хуков сабагента:
инструмент фонового агента делал вкладку `working` с ожиданием ответа, Stop
основного потока за этим не следует — через 5 минут тишины «Проблемы»
(сценарий S1 ревью: фоновый агент спросил разрешение, человек ответил).
Из вопроса разрешения в «фон» ведёт только PreToolUse агента: он приходит,
лишь когда пачка с разрешённым инструментом закончилась, а PostToolUse может
быть от параллельного инструмента, завершившегося до ответа (B3 ре-ревью).
Цена — пока разрешённый инструмент выполняется, вкладка остаётся в «Ждут
тебя». idle-ожидание вопроса не держит, поэтому ему хватает и PostToolUse.

Вброс очереди на Stop — **как раньше, независимо от bg**: Claude после хода
принимает ввод, а при вечном dev-сервере очередь иначе не сошла бы никогда.

## Потребители статуса

| Где | Как относится к `background` |
|---|---|
| `tab-group.js` | секция «Работают» (шов `KNOWN_STATUSES` ↔ `STATUSES` стережёт `test/tab-group-markup.test.js`) |
| `app.css` | `.tab-dot.background` — цвет working, приглушённо |
| `app.js` | ghost-буфер на конце хода — да; markSeen — нет; закрытие peek — да; блок ввода диалогом — нет |
| `toasts.js` | тишина; из `background` в `working` по уведомлению (`taskNotification`) время до «готово» не сбрасывается, по новому промпту человека — сбрасывается (сценарий S2 ревью) |
| `ipc.js` | `shouldDetectLimitStop`: `working/stuck → background` — остановка; тостеру прокидывается `taskNotification` |
| `night-watch.js` | не в `NO_RESUME_STATUSES` — пробуждение продолжает |
| `attention.js`, `badge.js`, `tabs.js` (счётчик ждущих), smoke в `main.js` | без изменений: считают только `waiting` или по секции |

## Известные ограничения

- **Задача снята в `/tasks` без хука и без уведомления** — вкладка в «фоне»
  до следующего Stop (любого следующего хода), не навсегда.
- **После `/clear` при живом dev-сервере** — «Наготове» до следующего Stop
  (SessionStart ставит `ready`; сверка со списком — только на Stop).
- **Старый CLI без `background_tasks`** — `done`, как до фичи.
- **Два фоновых агента:** инструмент второго уводит из «Ждут тебя» вопрос
  первого (так же было и в ходе с обычными агентами); тост о вопросе к этому
  моменту уже показан.
- **Ход, начатый уведомлением, узнаётся по началу prompt.** Если CLI склеит
  уведомление с промптом человека, тостер посчитает это новым ходом —
  «готово» может не прийти для короткого хода.
- **Мост режет тело больше 256 КБ** (`hook-bridge.js`): Stop с огромным
  `last_assistant_message` не дойдёт — статус не сменится (как и раньше).

**Вопрос владельцу (открыт, код не трогали):** вкладка с dev-сервером на всю
сессию: каждый ответ кончается в `background` — нет тоста «готово» и секции
«Готово» никогда.

---

## Задача — ветка `feat/background-status` (сделано)

**Файлы:**
- `src/main/background-tasks.js` (новый, CJS, чистые функции):
  `launchedTaskId(toolName, toolResponse)` → `{id, kind: 'shell'|'agent'|'workflow'} | null`;
  `liveBackground(known, backgroundTasks)` → `Map | null`;
  `backgroundSubtitle(bg)` → `'фон · 1 команда'`, `'фон · 2 команды, 1 агент'`,
  `'фон · 1 команда, 1 агент, 2 workflow'` (русская множественность; «workflow»
  не склоняется); `isTaskNotification(prompt)`.
- `src/main/sessions.js` — `STATUSES` + `'background'`; `tab.bg`, `tab.inTurn`;
  разбор хуков в `applyHookEvent`; `noteBackgroundAgent`.
- `src/main/ipc.js`, `src/main/toasts.js`, `src/main/night-watch.js` (комментарий),
  `src/renderer/js/tab-group.js`, `src/renderer/js/app.js`, `src/renderer/css/app.css`.

**Тесты:** `test/background-tasks.test.js`; раздел «фон» в
`test/sessions.test.js` (включая S1 ревью и хуки сабагента в ходе/вне хода);
`test/ipc-smoke-gate.test.js`, `test/tab-group.test.js`, `test/toasts.test.js`
(включая S2), `test/night-watch.test.js`; стражи по исходнику
`test/ghost-on-turn-end-guard.test.js`, `test/ipc-toaster-wiring-guard.test.js`.
Каждый новый тест — красный до правки или проверен мутацией.
