# Cockpit Phase 4 — Узнать и ответить, не переключаясь

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Кокпит зовёт сам, когда Claude ждёт ответа (тост Windows + бейдж на иконке + счётчик в заголовке), позволяет ответить прямо из другой вкладки (peek), даёт палитру команд по Ctrl+P и вставку скриншотов Ctrl+Shift+V.

**Architecture:** Всё опирается на уже готовую машину статусов (Фаза 2a): `tab:status` с `waiting` + `waitingText` — единственный триггер. Main получает от renderer агрегат «сколько ждут» и рисует overlay-иконку; renderer владеет UI (peek-поповер, палитра). Ответ из peek идёт существующим каналом `term:write` в pty нужной вкладки.

**Tech Stack:** как прежде; новых npm-зависимостей НЕТ (Notification и nativeImage — из Electron, badge рисуется на canvas в renderer).

**Спека:** §3.7 (уведомления), §3.11 (peek), §3.13 (палитра), §3.15 (скриншоты), §5.4.
**Carryover фазы 3:** `docs/superpowers/plans/2026-07-27-phase4-carryover-notes.md` — пункт 1 (DevTools) закрывается в Task 1, остальные (xterm-тема как второй источник правды, контраст ANSI-красного, гомоглиф в комментарии) переносятся дальше.

## Global Constraints

- Electron 29.4.6; pty.js не трогать; npm install не запускать.
- Палитра — только токены v2 (`--bg-*`, `--text-*`, `--accent`, статусные); никаких новых хардкодов.
- Правило уведомлений: НЕ уведомлять о том, на что пользователь сейчас смотрит — тост шлётся, только если окно не в фокусе ИЛИ активна другая вкладка.
- `taskkill /F` запрещён в любой форме; тестовые инстансы закрывать `taskkill /PID <pid>` без `/F`.
- Каждая задача: `npm test` (все зелёные) + `npm run smoke` (exit 0) → commit. Комментарии по-русски.
- Renderer-код тестов не имеет (нет DOM-харнесса) — чистую логику выносить в модули и покрывать `node --test`.

---

### Task 1: Агрегат ожидающих + бейдж на иконке + заголовок окна + DevTools

**Files:**
- Create: `src/main/attention.js`, `test/attention.test.js`
- Modify: `src/main/ipc.js` (IPC-канал), `src/main/main.js` (DevTools, передача окна), `src/preload/preload.js`, `src/renderer/js/app.js` (сообщать агрегат), `src/renderer/js/badge.js` (новый, рисует иконку)

**Interfaces:**
- Produces: `createAttention({ getWindow, setOverlay })`:
  - `update({ count, dataUrl })` — принимает число ждущих и PNG-иконку (data URL) от renderer; ставит overlay-иконку через `setOverlay(image, description)` и заголовок окна `Cockpit` / `Cockpit — N ждут`; при `count === 0` снимает overlay (`setOverlay(null, '')`).
  - Чистая логика (форматирование заголовка, решение «ставить/снимать») тестируется без Electron: `formatTitle(count) → string`, экспортировать отдельно.
- `badge.js` (renderer): `renderBadge(count) → dataURL|null` — рисует на `<canvas>` 32×32 круг `--accent` с белой цифрой (999+ → «99+»), возвращает `canvas.toDataURL('image/png')`; при `count === 0` → null.
- IPC: `attention:update` (send, `{count, dataUrl}`); preload `attention.update(count, dataUrl)`.
- app.js: после каждого изменения `waitingTabs` звать `pushAttention()` = `window.api.attention.update(waitingTabs.size, renderBadge(waitingTabs.size))`.
- main.js: вернуть DevTools (carryover 1) — локальный хоткей на F12 через `win.webContents.on('before-input-event')`: если `input.key === 'F12'` → `win.webContents.toggleDevTools()`. Комментарий: меню отключено ради Ctrl+R, F12 возвращаем точечно.

- [ ] **Step 1: `test/attention.test.js`** — тесты чистой логики:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createAttention, formatTitle } = require('../src/main/attention');

test('formatTitle: 0 → просто Cockpit, N → со счётчиком', () => {
  assert.strictEqual(formatTitle(0), 'Cockpit');
  assert.strictEqual(formatTitle(1), 'Cockpit — 1 ждёт');
  assert.strictEqual(formatTitle(2), 'Cockpit — 2 ждут');
  assert.strictEqual(formatTitle(5), 'Cockpit — 5 ждут');
});

function makeAttention() {
  const calls = { overlay: [], title: [] };
  const win = {
    isDestroyed: () => false,
    setTitle: (t) => calls.title.push(t),
  };
  const att = createAttention({
    getWindow: () => win,
    setOverlay: (img, desc) => calls.overlay.push({ img, desc }),
  });
  return { att, calls };
}

test('update с count>0 ставит overlay и заголовок', () => {
  const { att, calls } = makeAttention();
  att.update({ count: 2, dataUrl: 'data:image/png;base64,AAA' });
  assert.strictEqual(calls.overlay.length, 1);
  assert.strictEqual(calls.overlay[0].img, 'data:image/png;base64,AAA');
  assert.ok(calls.overlay[0].desc.includes('2'));
  assert.strictEqual(calls.title[0], 'Cockpit — 2 ждут');
});

test('update с count=0 снимает overlay', () => {
  const { att, calls } = makeAttention();
  att.update({ count: 1, dataUrl: 'data:image/png;base64,AAA' });
  att.update({ count: 0, dataUrl: null });
  assert.strictEqual(calls.overlay[1].img, null);
  assert.strictEqual(calls.title[1], 'Cockpit');
});

test('повторный update с тем же count не дёргает окно лишний раз', () => {
  const { att, calls } = makeAttention();
  att.update({ count: 1, dataUrl: 'data:image/png;base64,AAA' });
  att.update({ count: 1, dataUrl: 'data:image/png;base64,AAA' });
  assert.strictEqual(calls.overlay.length, 1);
  assert.strictEqual(calls.title.length, 1);
});

test('уничтоженное окно не роняет update', () => {
  const att = createAttention({
    getWindow: () => ({ isDestroyed: () => true, setTitle() { throw new Error('нельзя'); } }),
    setOverlay: () => { throw new Error('нельзя'); },
  });
  att.update({ count: 3, dataUrl: 'x' }); // не должно бросить
});
```

- [ ] **Step 2:** RED (`Cannot find module`). **Step 3: `src/main/attention.js`** — реализация по контракту выше (dedupe по count, guard на destroyed-окно, try/catch вокруг setOverlay/setTitle). Экспорт `{ createAttention, formatTitle }`.
- [ ] **Step 4: renderer `badge.js`** — canvas 32×32, `fillStyle` берётся из `getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`, цифра белая жирная по центру; вернуть dataURL.
- [ ] **Step 5:** IPC + preload + вызовы из app.js (там, где сейчас `updateTitlebarAlert()` — рядом добавить `pushAttention()`); в main.js — `attention` создаётся с `setOverlay: (img, desc) => win.setOverlayIcon(img ? nativeImage.createFromDataURL(img) : null, desc)`, и F12-хоткей.
- [ ] **Step 6:** `npm test` + `npm run smoke` → commit `feat: taskbar badge, window title counter, F12 devtools`.

---

### Task 2: Тосты Windows по правилу «не про то, на что смотришь»

**Files:**
- Create: `src/main/toasts.js`, `test/toasts.test.js`
- Modify: `src/main/ipc.js`, `src/preload/preload.js`, `src/renderer/js/app.js`

**Interfaces:**
- Produces: `createToaster({ isWindowFocused, getActiveTabId, showNotification, focusTab })`:
  - `onStatus({ tabId, tabName, status, waitingText })` — решает, показывать ли тост:
    - `waiting` → тост «<имя проекта> ждёт ответа» + первая строка `waitingText` (обрезать до 120 символов);
    - `done` → тост «<имя проекта>: готово» ТОЛЬКО если статус пришёл после >30 с работы (иначе шум на каждую мелочь) — время старта работы держать внутри модуля по `tabId`;
    - `dead` → тост «<имя проекта>: сессия завершилась»;
    - прочие статусы — молчать.
  - ПОДАВЛЕНИЕ: если `isWindowFocused()` И `getActiveTabId() === tabId` — не показывать ничего (пользователь смотрит именно на эту вкладку).
  - Клик по тосту → `focusTab(tabId)`.
- В main: `showNotification` = `new Notification({title, body}).on('click', …).show()`; `focusTab` = поднять окно (`win.show(); win.focus()`) и послать в renderer `tab:activate {tabId}`.
- preload: `tab.onActivate(cb)`; app.js подписывается и зовёт `activateTab(tabId)`.
- Renderer сообщает main активную вкладку и фокус: существующий `workspace:setActive` уже даёт активную; фокус окна main знает сам (`win.isFocused()`).

- [ ] **Step 1: `test/toasts.test.js`** — покрыть матрицу: waiting при неактивной вкладке → тост; waiting при активной+фокусе → тишина; waiting при активной, но окно без фокуса → тост; done через 5 с → тишина; done через 60 с → тост; dead → тост; клик вызывает focusTab с верным tabId; текст обрезается до 120.
- [ ] **Step 2:** RED. **Step 3:** реализация `toasts.js` (чистая, все зависимости инжектятся).
- [ ] **Step 4:** проводка в ipc.js: подписаться на тот же поток, что шлёт `tab:status` в renderer (в `onEvent`-обёртке менеджера), и звать `toaster.onStatus(...)`; имя вкладки брать из `manager.list()`.
- [ ] **Step 5:** `npm test` + smoke + живая проверка: `npm start`, свернуть окно, дождаться `waiting` в любой вкладке (или сымитировать POST'ом на hook-bridge событием Notification) → тост появился, клик по тосту поднял окно и переключил вкладку. Закрывать штатно. → commit `feat: Windows toasts for waiting/done/dead with focus-aware suppression`.

---

### Task 3: Peek — ответить, не переключаясь

**Files:**
- Create: `src/renderer/js/peek.js`
- Modify: `src/renderer/index.html` (контейнер поповера), `src/renderer/css/app.css`, `src/renderer/js/app.js`, `src/renderer/js/tabs.js` (хранить waitingText и отдавать по tabId)

**Interfaces:**
- Consumes: `tab:status` payload уже содержит `waitingText`; `api.term.write(tabId, data)`.
- Produces: `createPeek({ root, onSend, onOpenTab })`:
  - `show({ tabId, name, text, anchorEl })` — рисует поповер у строки сайдбара: имя проекта, полный текст вопроса, поле ввода, подсказки «Enter — отправить, Esc — закрыть, Ctrl+Enter — перейти во вкладку».
  - Кнопки-цифры: если в тексте вопроса есть строки вида `1. …` / `2. …` (варианты Claude), показать их кнопками — клик отправляет соответствующую цифру.
  - `hide()`; открытый peek закрывается по Esc, клику вне, смене активной вкладки.
  - `onSend(tabId, text)` → `api.term.write(tabId, text + '\r')`.
- Открытие: клик по строке сайдбара со статусом `waiting` открывает peek ВМЕСТО переключения (обычные строки переключают как раньше); плюс горячая клавиша: Space, когда фокус на строке сайдбара (строки получают `tabindex="0"`).
- Чистая часть выносится в `parseOptions(text) → [{digit, label}]` и покрывается тестом (`test/peek-parse.test.js`).

- [ ] Шаги: тест `parseOptions` → RED → реализация → проводка UI и CSS (поповер: `--bg-card`, `--border`, radius `--radius-m`, тень отсутствует, максимум 420px ширины) → smoke → живая проверка через CDP: сымитировать `waiting` (POST на hook-bridge), кликнуть строку, убедиться, что поповер открылся и в pty ушёл ответ → commit `feat: peek popover — answer Claude without switching tabs`.

---

### Task 4: Палитра команд (Ctrl+P) + вставка скриншотов (Ctrl+Shift+V)

**Files:**
- Create: `src/renderer/js/palette.js`, `src/main/screenshot.js`, `test/palette-filter.test.js`, `test/screenshot.test.js`
- Modify: `index.html`, `app.css`, `app.js`, `ipc.js`, `preload.js`, `terminal.js` (перехват Ctrl+Shift+V)

**Interfaces:**
- `palette.js`: `createPalette({ root, getActions })`; `getActions()` возвращает массив `{id, title, hint, run}`. Набор действий: перейти к вкладке (по одной записи на вкладку), «+ Проект», «Перезапустить сессию», «Подключить хуки», «Отправить /compact», «Отправить /remote-control», «Открыть DevTools». Фильтрация — чистая функция `filterActions(actions, query) → actions` (подстрочный regex-free fuzzy: все символы запроса встречаются по порядку; сортировка по позиции первого совпадения), покрыта тестом.
- `screenshot.js` (main): `saveClipboardImage({ readImage, dir, now })` → `{path}` или `null`, если в буфере не картинка. Пишет PNG в `<dir>/.cockpit-shots/<timestamp>.png`, `mkdir -p`. Чистая логика (имя файла, проверка пустоты) тестируется с фейковым `readImage`.
- IPC `screenshot:paste (tabId)` → main берёт cwd вкладки, сохраняет, возвращает путь; renderer печатает путь в pty (`api.term.write(tabId, path)` без `\r` — пользователь допишет промпт).
- В `terminal.js` перехват Ctrl+Shift+V сейчас вставляет текст; расширить: если в буфере обмена картинка (renderer это узнать не может напрямую) — сначала пробуем `screenshot:paste`, и только если вернулся `null`, делаем обычную текстовую вставку.
- `.cockpit-shots/` добавить в `.gitignore` шаблон? Нет — это папка пользовательского проекта; вместо этого при первом сохранении писать рядом `.gitignore` с `*` внутри (чтобы не мусорить в чужом репозитории). Задокументировать в комментарии.

- [ ] Шаги: тесты `filterActions` и `saveClipboardImage` → RED → реализации → UI палитры (оверлей по центру, `--bg-panel`, список, стрелки/Enter/Esc) → проводка Ctrl+P (window keydown capture, как Ctrl+Tab) → smoke → commit `feat: command palette and screenshot paste`.

---

## Приёмка фазы (руками)

1. Свернуть кокпит, дождаться вопроса Claude в любой вкладке → тост, на иконке в панели задач бейдж с цифрой, в заголовке «Cockpit — 1 ждёт».
2. Клик по тосту — окно поднялось и переключилось на нужную вкладку.
3. Работая в одной вкладке, кликнуть по ждущей строке сайдбара → peek с текстом вопроса; ответить цифрой или текстом; фокус остался в исходной вкладке.
4. Ctrl+P → палитра, ввод пары букв проекта → Enter переключает.
5. Скопировать скриншот, Ctrl+Shift+V в терминале → в промпт вставился путь к PNG.

## Self-Review (выполнен)

1. **Coverage:** §3.7 ✓ (T1+T2), §3.11 ✓ (T3), §3.13 ✓ (T4), §3.15 ✓ (T4), carryover DevTools ✓ (T1). Очередь промптов (§3.12) сознательно НЕ входит — она требует поля ввода в терминальной панели и логичнее идёт вместе с дашбордом следующей фазы.
2. **Placeholders:** нет; renderer-части заданы поведенчески (в проекте нет DOM-тестов), вся тестируемая логика вынесена в чистые функции с явными тестами.
3. **Consistency:** триггер один — `tab:status` с `waiting`/`waitingText` из Фазы 2a; ответ уходит существующим `term:write`; бейдж рисуется в renderer (там есть canvas и токены), ставится в main (там окно) — граница проходит по одному IPC-каналу `attention:update`.
