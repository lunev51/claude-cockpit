# Размер терминала + мелочи ревью C — план

> **Для исполнителей:** superpowers:subagent-driven-development, TDD внутри задачи.
> Шаги с чекбоксами `- [ ]`.

**Цель:** «квадрат» 80×24 и «уехавший» статус-бар больше не появляются ни в окне
ПК, ни в браузере; закрыта регрессия #45 и пять видимых пунктов раздела C ревью.

**Архитектура:** размер в pty отправляет только терминал, который реально
подогнан под видимый контейнер; сервер применяет размер владельца ко ВСЕМ живым
вкладкам. Шрифт терминала дожидаемся до первого замера и перемеряем, если он
догрузился позже. Мелочи — точечные правки по месту.

**Стек:** Electron, xterm.js 6.0.0 + addon-fit 0.11.0, node --test.

**Спека:** диагноз из сессии 05.11.2026 (запись кадров на стенде, ниже — выжимка).

## Диагноз (выжимка)

Запись кадров браузера при открытии страницы (стенд, 3 вкладки claude):

```
SEND owner:claim  {cols:80, rows:24}   ← вкладок ещё нет, запасной размер (app.js termSize)
SEND term:start   {80×24}              ← вкладка создана в скрытом контейнере (terminal.js:432)
SEND term:resize  {279×69}             ← активная вкладка подогнана
SEND term:start   {80×24}              ← фоновая вкладка
SEND term:resize  {80×24}              ← ResizeObserver скрытой вкладки: fit не сработал, размер ушёл всё равно (terminal.js:454)
SEND owner:claim  {279×69}             ← тот же владелец → ownership не применяет
```

Плюс `ipc.js:2278` — `ownership.noteSize` запоминает 80×24 скрытой вкладки как
размер владельца, и следующая пересадка без размера (показ окна ПК из трея)
раздаёт 80×24 всем сессиям.

Шрифт: `JetBrainsMono NF` (1 МБ) отдаётся без кэширования (`net-server.js:239`),
xterm мерит ячейку по запасному шрифту (Menlo на маке: высота строки ~1.16 em
против 1.32 em у JetBrains Mono — замер TTF: JBM 1.320, Consolas 1.171) и не
перемеряет при догрузке шрифта (в xterm 6 перемер только в `_afterResize`, при
смене опций шрифта и DPR). Первый же ресайз с изменением строк перемеряет
ячейку, но число строк уже посчитано по старой высоте → нижние строки за краем.

Отступ: `* { box-sizing: border-box }` + `.term-view { padding: 4px 0 0 8px }` —
FitAddon берёт высоту контейнера вместе с отступом.

## Глобальные ограничения

- Живой каталог `C:\Users\Lunev\AssistClaude\claude-cockpit` НЕ трогать — там
  работает кокпит владельца. Только своя копия (worktree).
- `npm test` в своей копии — зелёный в конце задачи (старт: 1086 тестов).
- Новый тест сначала КРАСНЫЙ на исходном коде; если бага нет — мутация. Для
  стражей по исходнику — мутация обязательна (якорь мог зацепиться не за то).
- Коммиты: `git add` поимённо, сообщение файлом `git commit -F`, по-русски в
  стиле репо (`fix: ...`). Окончание сообщения:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Комментарии в коде — по-русски, объясняют «почему», как во всём репо.
- Electron (`npm start`/`smoke`) не запускать — живую проверку делает
  координатор на стенде.

## На что смотреть ревью (не покрыто тестами задач напрямую)

1. Вкладка открыта, пока окно скрыто/свёрнуто и нет ни одного подогнанного
   терминала → процесс стартует в известном размере владельца (или 80×24, если
   неизвестен никакой), и первый видимый fit его поправляет.
2. Свёрнутое окно даёт контейнер 0×0 → никаких `term:resize` 2×1.
3. Разный размер шрифта во вкладках (Ctrl+колесо в одной) → фоновые вкладки
   временно в сетке видимой; при показе вкладка сообщает свою. Принято.
4. Шрифт не грузится вовсе (заблокирован, нет сети) → ожидание обрывается по
   таймауту 3 с, терминал всё равно открывается.
5. Повторный захват тем же владельцем после загрузки — не раздаёт старый размер.

---

## Задача A — размер терминала (ветка `fix/term-size`, копия `cockpit-wt-size`)

### A1. Чистая функция «подогнан ли терминал»

**Файлы:** создать `src/renderer/js/term-size.js`, тест `test/term-size.test.js`.

**Интерфейс:**
- `export function fittedSize(proposed, box)` → `{cols, rows} | null`.
  `proposed` — результат `fit.proposeDimensions()` (может быть `undefined` или
  `{cols: NaN, rows: NaN}`), `box` — `{width, height}` контейнера
  (`clientWidth/clientHeight`). `null`, если `proposed` нет, cols/rows не
  конечные целые ≥ 1, или `box.width <= 0 || box.height <= 0`.
- `export async function waitForFont(fonts, spec, timeoutMs)` → `'loaded' | 'timeout' | 'failed'`.
  `fonts` — объект с `load(spec)` (в проде `document.fonts`), `spec` —
  CSS-шорткат вида `14px "JetBrainsMono NF"`. Никогда не бросает.

- [ ] Тесты: `undefined` → null; `{cols: NaN, rows: NaN}` → null;
  `{cols: 2, rows: 1}` при `box 0×0` → null; `{cols: 279, rows: 69}` при
  `box 2360×1332` → `{cols: 279, rows: 69}`. `waitForFont`: резолв → `'loaded'`,
  реджект → `'failed'`, вечный промис при `timeoutMs: 30` → `'timeout'`.
- [ ] Увидеть красными (модуля нет), реализовать, зелёные, коммит.

### A2. Терминал сообщает только подогнанный размер

**Файлы:** `src/renderer/js/terminal.js` (ResizeObserver ~449–457, `setFontSize`
~280–291, старт ~430–432, `refit` ~487–491), тест — страж по исходнику
`test/terminal-size-guard.test.js` (renderer не покрыт node --test, см.
`test/handoff-claim-guard.test.js` — образец).

**Интерфейс:**
- внутри `initTerminal`: `measure()` = `fit.fit()` + `fittedSize(fit.proposeDimensions(), {width: container.clientWidth, height: container.clientHeight})`;
- `term:resize` уходит ТОЛЬКО при `measure() !== null` — во всех трёх местах;
- старт: `window.api.term.start(tabId, s ? s.cols : null, s ? s.rows : null)`;
- `refit()` возвращает `{cols, rows} | null` (null — не подогнан, ничего не отправлено).
- Перемер после догрузки шрифта: подписка `document.fonts` на `loadingdone`
  (снимается в `dispose`) → перемерить ячейку и, если подогнан, отправить
  размер. Публичного API на перемер в xterm 6 нет; допустимо
  `term._core._charSizeService.measure()` под optional chaining (FitAddon сам
  ходит в `_core`), либо иной способ — проверить по `node_modules/@xterm/xterm/lib/xterm.js`,
  что он реально вызывает `measure()`.

- [ ] Страж: в теле колбэка ResizeObserver, в `setFontSize` и в `refit` вызов
  `window.api.term.resize` стоит под проверкой результата `fittedSize`/`measure`;
  `term.start` не берёт `term.cols/term.rows` напрямую. Мутации: вернуть
  безусловный resize в каждом из мест по очереди → страж краснеет.
- [ ] Реализация, тесты, коммит.

### A3. Сервер: размер владельца — всем вкладкам; старт без размера

**Файлы:** `src/main/ipc.js` (`term:start` ~2233, `term:resize` ~2266,
`owner:claim` ~1891), `src/main/ownership.js:25-26`, `src/main/net-server.js:292`
(только если нужно для валидации), тесты: `test/ipc-handoff-wiring.test.js`,
`test/ownership.test.js`.

**Интерфейс:**
- `function resolveStartSize(cols, rows, ownerSize)` в `ipc.js`, в
  `module.exports` → `{cols, rows}`: валидные cols/rows (validDim) → они; иначе
  `ownerSize` если валиден; иначе `{cols: 80, rows: 24}`.
- `term:start`: невалидный размер больше НЕ причина молча выйти — берём
  `resolveStartSize(cols, rows, ownership.size())`. tabId по-прежнему обязателен.
- `term:resize` от владельца: размер применяется ко ВСЕМ живым вкладкам
  (существующая `applyHandoffSize`), затем `ownership.noteSize`. Комментарий —
  почему всем (одна область окна на все вкладки; скрытые вкладки размер больше
  не сообщают) и что разный шрифт во вкладках — принятая цена.
- `ownership.claim(who, nextSize)`: размер запоминается только валидный
  (целые 2..500, как validDim); `{cols: null, rows: null}`/`{cols: undefined}` —
  как «без размера» (пункт C1 ревью).

- [ ] Тесты (сначала красные): `resolveStartSize(null, null, {cols:279, rows:69})`
  → 279×69; `(null, null, null)` → 80×24; `(120, 40, {…})` → 120×40.
  Проводка: term:resize одной вкладки меняет размер у всех вкладок фейкового
  manager (форма `manager.list()` — поле `tabId`, НЕ `id`; см. урок в
  комментарии у `applyHandoffSize`). ownership: claim с `{cols: null, rows: null}`
  не затирает ранее запомненный размер владельца.
- [ ] Реализация, коммит.

### A4. Захват при загрузке — без запасного 80×24; шрифт до первого терминала

**Файлы:** `src/renderer/js/app.js` (`termSize` ~2434, `claimControl` ~2611,
`ensureActiveTabForHandoff` ~2597, `boot` ~2759–2810), тест — дополнить
`test/handoff-claim-guard.test.js` (сохранить его существующие инварианты).

**Интерфейс:**
- `termSize()` → `{cols, rows} | null`: размер активного терминала через его
  `refit()` (A2); нет активной вкладки или не подогнан → `null`.
- `claimControl`: `window.api.owner.claim(size ? size.cols : null, size ? size.rows : null)`.
- `boot`: перед первым созданием терминала (до `bootWorkspace`/`attach`, после
  `config.get`) — `await waitForFont(document.fonts, \`${config.terminal.fontSize}px "JetBrainsMono NF"\`, 3000)`;
  исход `'timeout'`/`'failed'` — `console.warn`, работа продолжается.
  Семейство — первое из `config.terminal.fontFamily`, не хардкод, если это
  просто разобрать; иначе хардкод с комментарием.

- [ ] Страж: в `claimControl` нет литерала `80` и нет `{ cols: 80`; `termSize`
  не возвращает запасной размер; в `boot` `waitForFont` вызван раньше
  `bootWorkspace`. Мутации на каждый пункт.
- [ ] Реализация, коммит.

### A5. Кэширование статики и отступ контейнера

**Файлы:** `src/main/net-server.js` (~210–240), `test/net-server.test.js`;
`src/renderer/css/app.css:419`.

**Интерфейс:**
- Статика: `ETag` (размер+mtime) и `Last-Modified` всем файлам;
  `Cache-Control: no-cache` для `.html/.js/.css/.json/.map` (всегда
  перепроверка — старый скрипт не залипает), `Cache-Control: max-age=604800`
  для `.woff2/.ico/.png/.svg`. `If-None-Match` совпал → `304` без тела.
- `.term-view`: FitAddon должен видеть высоту без отступа — например
  `box-sizing: content-box` у `.term-view` (при `position:absolute; inset:0`
  контентный блок = область минус отступ). Альтернатива — перенести отступ на
  `.term-view .xterm` (FitAddon вычитает отступ элемента терминала).

- [ ] Тесты net-server: заголовки на `.woff2` и `.js`; повтор с `If-None-Match`
  → 304. Сначала красные.
- [ ] CSS — без node-теста (проверяется живьём координатором: высота
  `.xterm-screen` ≤ контентной высоты контейнера).
- [ ] Коммит.

---

## Задача B — регрессия #45 и пункты C (ветка `fix/hygiene-c`, копия `cockpit-wt-hygiene`)

Параллельно с A. Файлы пересекаются с A (`app.js`, `terminal.js`, `ipc.js`), но
в других функциях — трогать ТОЛЬКО перечисленные места.

### B1. «Прочитано» при возврате фокуса — и в браузере

**Файлы:** `src/renderer/js/app.js` (`bindVoiceHotkey` ~1340–1445, `boot`),
тест-страж (новый файл).
- Слушатель `window 'focus'` → `markSeenIfWatching` вынести из
  `bindVoiceHotkey` в `bindSeenOnFocus()`, вызывать в `boot` безусловно —
  строкой рядом с вызовом `bindVoiceHotkey()` (~3141), не в начале `boot`
  (там правит задача A).
  Причина: ранний `return` для сетевого клиента (#45, `app.js:1364–1372`)
  отрезал его в браузере.
- [ ] Страж: `bindSeenOnFocus` вызывается в `boot`; внутри `bindVoiceHotkey`
  нет `markSeenIfWatching`. Мутации: убрать вызов → красный; вернуть слушатель
  под ранний return → красный.

### B2. Каскады dispose без пошаговых try/catch (C25)

**Файлы:** `src/main/ipc.js` (~2362–2402), `src/main/main.js` (~656–688);
новый `src/main/run-steps.js` + `test/run-steps.test.js`.
- `function runSteps(steps, log)` (CJS): `steps` — массив `[label, fn]`;
  каждый шаг в своём try/catch, сбой → `log(label, err)`, следующие шаги
  выполняются. Использовать в обоих каскадах.
- [ ] Тест: второй шаг бросает → третий выполнен, log получил метку второго.

### B3. Поиск в терминале: кнопки не отбирают фокус (C10)

**Файлы:** `src/renderer/js/terminal.js` — ТОЛЬКО `mkBtn`/обработчики кнопок
поиска (~183–233).
- `mousedown` → `preventDefault()` на ▲▼✕, фокус остаётся в поле — Esc/Enter
  работают после клика мышью.
- [ ] Страж по исходнику + мутация.

### B4. Esc в палитре и поиске истории (C11)

**Файлы:** `src/renderer/js/palette.js` (~93), `src/renderer/js/search.js` (~245).
- Esc закрывает оверлей, где бы внутри него ни был фокус (обработчик на корне
  оверлея или на `document`, пока открыт — как у дашборда/peek; выбрать то,
  что уже принято в соседях, и сослаться на них в комментарии).
- [ ] Страж/тест + мутация.

### B5. 🌙 без двойного переключения (C16)

**Файлы:** `src/renderer/js/app.js` (`toggleNight` ~666); новый
`src/renderer/js/single-flight.js` + `test/single-flight.test.js`.
- `export function singleFlight(fn)` → функция: пока идёт предыдущий вызов,
  повторный возвращает тот же промис, `fn` не зовётся второй раз.
- [ ] Тест: два вызова подряд → `fn` вызвана один раз, оба получили один
  результат; после завершения — новый вызов снова зовёт `fn`.
- [ ] Применить к `toggleNight`, коммит.

---

## После задач (координатор)

1. Волна ревью (Opus, с запуском команд и мутациями), фикс-раунд до нуля Critical.
2. Живой прогон на стенде (`cockpit-net-data`, порт 48301, claude во вкладках):
   запись кадров `trace.js` — ни одного `80×24` ни в `owner:claim`, ни в
   `term:start`, ни в `term:resize`; фоновые вкладки в размере окна до
   переключения; шрифт с запасным Consolas (стенд-конфиг `fontFamily`) —
   статус-бар на месте после ресайза; скриншоты в корень проекта.
3. Два PR: A, затем B (ребейз на main после мержа A).
4. `PROGRESS.md`.
