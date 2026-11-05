# Снимок экрана вместо хвоста вывода (05.11.2026)

> superpowers:test-driven-development. Ветка `fix/screen-mirror`, рабочая копия
> `C:\Users\Lunev\AssistClaude\wt-mirror\cockpit` (node_modules — junction на
> живой каталог, `@xterm/headless@6.0.0` лежит уровнем выше, в
> `C:\Users\Lunev\AssistClaude\wt-mirror\node_modules`, и находится обычным
> поиском Node по родительским папкам). `package.json`/`package-lock.json` уже
> содержат `@xterm/headless ^6.0.0`.

## Живая жалоба и причина (доказано 05.11)

Кокпит в Chrome на ПК: у вкладки akto после открытия страницы низ терминала
сломан — нет рамок поля ввода и строки статуса, на месте статус-бара только
изменившиеся цифры («47», «5»). У соседней вкладки всё целое.

Причина (проверено на настоящих буферах живого кокпита):

- Поток pty на Windows — это рендер ConPTY: абсолютные позиции `\e[r;cH`, ни
  одного перевода строки, полная перерисовка экрана (`\e[2J`) — только при
  ресайзе. Дальше — только изменившиеся клетки (спиннер, счётчик токенов).
- Подключившийся клиент (новая страница браузера; И любой обрыв связи —
  `api-boot.js/reconnectLoop` перезагружает страницу) получает экран из
  `net:buffer` = последние 256 КБ сырого потока (`output-buffer.js`).
- Если последняя полная перерисовка старше этих 256 КБ (вкладка akto 3 мин 42 с
  крутила спиннер), всё, что не менялось с тех пор (рамки, «Opus 5.5 | akto |
  main», «bypass permissions»), в хвосте отсутствует. Ресайза при открытии нет
  (размер тот же) — значит, и перерисовки, которая бы спасла, нет.
- Воспроизведено: буфер вкладки claude-cockpit (296 тыс. символов, последняя
  полная перерисовка на 69 %) целиком → низ целый; тот же буфер с точки после
  последней рамки → внизу только `141k · 14%`.

## Решение

main держит у себя «зеркало» экрана каждой вкладки — `@xterm/headless` того же
размера, что pty, — и `net:buffer` отдаёт его снимок (`@xterm/addon-serialize`,
уже есть в зависимостях), а не сырой хвост. Снимок, записанный в свежий xterm
того же размера, восстанавливает экран один в один (спайк на живом буфере: 0
расходящихся строк, курсор на месте, разбор 296 тыс. символов — 22 мс, снимок —
4 КБ против 256 КБ хвоста).

Не делаем: дедупликацию живого вывода, пришедшего, пока едет снимок
(`pendingOutput` в app.js) — поведение то же, что было с сырым хвостом; ConPTY
пишет абсолютными позициями, повтор куска почти всегда идемпотентен.

## Задачи

### 1. `src/main/screen-mirror.js` (новый) + `test/screen-mirror.test.js`

```js
createScreenMirror({ Terminal, SerializeAddon, sizeOf, scrollback = 1000 })
  push(tabId, data)   // синхронно; размер берёт из sizeOf(tabId)
  get(tabId)          // Promise<string> — снимок после разбора всего принятого
  drop(tabId)         // dispose зеркала
createTabHistory({ sizeOf, load = require, warn = console.warn })
  // @xterm/headless + @xterm/addon-serialize → createScreenMirror;
  // не загрузились (забыли npm install после pull) → createOutputBuffer() из
  // output-buffer.js + одно предупреждение. Кокпит не имеет права упасть из-за
  // отсутствующего пакета: старое поведение лучше, чем никакого.
```

Правила:
- `sizeOf(tabId)` → `{cols, rows}` или `null`. `null` = вкладки нет (закрыта,
  хвостовой кусок после drop) → push НИЧЕГО не создаёт (иначе утечка зеркала на
  каждое закрытие). Своё правило «валидного размера» не изобретать — взять
  `isValidSize` из ownership.js или validDim из sessions.js, если экспортирован.
- push: нет зеркала → создать в размере sizeOf; размер отличается →
  `term.resize` ДО записи (поток после ресайза pty уже в новом размере, а ConPTY
  после ресайза перерисовывает экран целиком — недолетевший кусок старого
  размера этим лечится).
- get: нет зеркала → `''`. Есть → привести к текущему sizeOf (если вкладка ещё
  есть), затем `term.write('', cb)` и в cb — `serialize({ scrollback })`:
  write в xterm асинхронный, снимок без ожидания разбора потерял бы хвост.
- `allowProposedApi: true` (нужен serialize-аддону).
- Шапка модуля по-русски, в стиле репо: почему (живая жалоба 05.11, механизм
  ConPTY, цифры спайка), и почему fallback.

Тесты (настоящий `@xterm/headless`, без фейков терминала):
- **Регрессия (сначала КРАСНАЯ на старом пути — `createOutputBuffer`)**: поток
  «как у ConPTY»: `\e[2J`, рамка `─`×N в строке R1, `> ` в R1+1, рамка в R1+2,
  статус «Opus 5.5 | proj | main | 100k · 10%» в R1+3, «bypass permissions on»
  в R1+4 — один раз; затем >300 КБ правок только счётчика (`\e[R1+3;Ch` +
  `NNNk · NN%`). Снимок (`await history.get`) пишется в свежий headless того же
  размера → в нужных строках есть рамка, `> `, «Opus 5.5», «bypass
  permissions». Красноту показать: тот же тест на `createOutputBuffer` падает.
- Ресайз: push при 100×30, sizeOf → 120×40, push → зеркало 120×40; ресайз без
  данных → get отдаёт снимок уже в новом размере.
- sizeOf null → push не создаёт зеркало, get → ''.
- drop → get → ''; push после drop при sizeOf null ничего не воскрешает.
- createTabHistory: load бросает → объект с push/get/drop (сырой буфер),
  warn позван один раз; load успешен → зеркало.
- Мутациями проверить: убрать resize в push; убрать ожидание write('') в get;
  убрать проверку sizeOf null; убрать fallback — каждый раз хоть один тест
  краснеет.

### 2. `sessions.js`: `manager.size(tabId)`

`{cols, rows}` текущего pty вкладки (поля tab.cols/tab.rows, их ставят start()
и resize()) или `null`, если вкладки нет / размера ещё нет. Добавить в
возвращаемый объект менеджера. Тест в test/sessions.test.js (реальная форма:
start → size, resize → size, нет вкладки → null).

### 3. Проводка в `ipc.js` и `net-server.js`

- ipc.js: `const outputBuffer = createOutputBuffer({})` →
  `createTabHistory({ sizeOf: (tabId) => (manager ? manager.size(tabId) : null) })`
  (`manager` — модульный `let`, объявлен выше; переименование переменной — на
  усмотрение, но комментарии рядом поправить по смыслу). bufferTermData /
  dropTabOutputBuffer / registry `net:buffer` — оставить сигнатуры, проверить,
  что registry-обработчик отдаёт промис (ipcMain.handle его дождётся).
- net-server.js: `serveOwn` для `net:buffer` возвращает теперь промис, а
  вызов стоит БЕЗ await (`const result = SERVER_CHANNELS.has(...) ?
  serveOwn(...) : await registry.call(...)`) — промис ушёл бы клиенту как `{}`.
  Добавить await. Тест в test/net-server.test.js: outputBuffer.get отдаёт
  Promise строки → клиент получает строку (красный без await).
- Комментарии в net-server.js/ipc.js, где сказано «хвост вывода / 256 КБ»,
  привести к новому смыслу. Комментарий-шапку output-buffer.js дополнить: теперь
  это запасной путь (createTabHistory), почему он не годится как основной.

### 4. Проверка

- `npm test` зелёный целиком (старт на origin/main: 1355).
- Коммиты по задачам, `git add` поимённо, `git commit -F <файл>`, по-русски,
  последняя строка — `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  и `Claude-Session: https://claude.ai/code/session_01VLhaqS2Jmx2JkoPWS23aFe`.
- Electron не запускать, живой каталог `C:\Users\Lunev\AssistClaude\claude-cockpit`
  не трогать (там работает кокпит владельца; его node_modules — junction, НЕ
  запускать npm install внутри рабочей копии).
