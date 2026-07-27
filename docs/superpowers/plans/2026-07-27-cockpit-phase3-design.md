# Cockpit Phase 3 — Дизайн v2 (нейтральный чёрный) + панель действий

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Перекрасить кокпит в нейтральный чёрный в духе Warp (решение пользователя, вариант E), ужать геометрию до варповской плотности, заменить отладочную строку внизу на панель действий с кнопками слэш-команд.

**Architecture:** Вся правка — в renderer: `tokens.css` (значения), `app.css` (радиусы/плотность/новая панель), `terminal.js` (xterm-тема), `index.html` (разметка панели), `app.js` (обработчики кнопок), `config.js` (список кнопок). Логика вкладок/сессий/хуков не трогается.

**Tech Stack:** как раньше; локальные шрифты Inter + DM Mono (woff2) в `assets/fonts/`.

**Спека:** §7 (дизайн-система v2), фичи 23 и 26 (панель действий + кнопки слэш-команд).

## Global Constraints

- Палитра строго нейтральная (R=G=B), кроме терракоты и статусных ANSI-цветов Warp.
  Ни одного тёплого/коричневого серого не остаётся: `#141413`, `#1F1E1B`, `#262624`,
  `#30302E`, `#3A3733`, `#403D38`, `#FAF9F5`, `#A09D96`, `#8F8D83`, `#2e2320`, `#4a3227`,
  `#CC785C`, `#5DB872`, `#5DB8A6`, `#E8A55A`, `#C64545` — должны исчезнуть из репозитория
  (проверка grep'ом в Task 3).
- Шрифты только локальные (CSP `default-src 'self'`; сеть недоступна) — никаких Google Fonts.
- Терракота `#D97757` — исключительно «ждёт тебя» и главные CTA.
- Логика не меняется: никаких правок в sessions.js/hook-bridge/connector/workspace.
- Каждая задача: `npm test` (все зелёные, без регрессий) + `npm run smoke` (exit 0) → commit.
- Комментарии по-русски.

---

### Task 1: Шрифты Inter + DM Mono локально

**Files:**
- Create: `assets/fonts/` (woff2-файлы), `src/renderer/css/fonts.css`
- Modify: `src/renderer/index.html` (подключение), `package.json` (build.files уже включает assets/**)

**Interfaces:**
- Produces: семейства `Inter` (400, 500) и `DM Mono` (400) доступны в renderer;
  `--font-ui: Inter, 'Segoe UI', sans-serif`, `--font-mono: 'DM Mono', 'JetBrainsMono NF', Consolas, monospace`
  (значения выставляются в Task 2, здесь только @font-face).

- [ ] **Step 1: Скачать шрифты** (лицензии: Inter — OFL, DM Mono — OFL; оба свободны):

```powershell
$dir = "C:\Users\Lunev\AssistClaude\claude-cockpit\assets\fonts"
New-Item -ItemType Directory -Force $dir | Out-Null
$files = @{
  'Inter-Regular.woff2' = 'https://github.com/rsms/inter/raw/master/docs/font-files/InterVariable.woff2'
  'DMMono-Regular.woff2' = 'https://github.com/googlefonts/dm-mono/raw/main/fonts/webfonts/DMMono-Regular.woff2'
}
foreach ($k in $files.Keys) { Invoke-WebRequest -Uri $files[$k] -OutFile (Join-Path $dir $k) -UseBasicParsing }
Get-ChildItem $dir | Select-Object Name, Length
```

Если ссылка отдаёт 404 (репозитории меняют структуру) — найти актуальный woff2 (Inter:
github.com/rsms/inter релизы; DM Mono: github.com/googlefonts/dm-mono) и скачать его;
зафиксировать фактические URL в отчёте. Оба файла должны быть > 30 КБ (иначе скачалась
HTML-заглушка — проверить).

- [ ] **Step 2: `src/renderer/css/fonts.css`:**

```css
/* Локальные шрифты: CSP запрещает внешние источники, сети у приложения нет. */
@font-face {
  font-family: 'Inter';
  src: url('../../../assets/fonts/Inter-Regular.woff2') format('woff2');
  font-weight: 100 900;   /* вариативный: покрывает 400 и 500 */
  font-display: block;
}
@font-face {
  font-family: 'DM Mono';
  src: url('../../../assets/fonts/DMMono-Regular.woff2') format('woff2');
  font-weight: 400;
  font-display: block;
}
```

(Если скачан не вариативный Inter, а статические начертания — сделать два @font-face с
weight 400 и 500 и соответствующими файлами.)

- [ ] **Step 3:** в `index.html` подключить `fonts.css` ПЕРЕД `app.css`.
- [ ] **Step 4:** `npm run smoke` → exit 0; визуально шрифт в терминале сменился (в отчёте
  отметить, что проверка визуальная остаётся человеку). Commit `feat: bundle Inter and DM Mono locally`.

---

### Task 2: tokens.css v2 + xterm-тема

**Files:**
- Modify: `src/renderer/css/tokens.css` (полная замена), `src/renderer/js/terminal.js` (константа THEME)

**Interfaces:**
- Produces: все переменные сохраняют ИМЕНА (`--bg-window`, `--bg-panel`, `--bg-card`,
  `--bg-hover`, `--bg-wait`, `--border`, `--border-soft`, `--border-wait`, `--text`,
  `--text-muted`, `--text-dim`, `--accent`, `--accent-hover`, `--ok`, `--working`,
  `--warn`, `--err`, `--radius-s/m/l`, `--font-ui`, `--font-serif`, `--font-mono`) —
  меняются только значения, поэтому app.css не ломается. `--font-serif` остаётся как
  алиас на `--font-ui` (серифов в v2 нет, но переменная используется в app.css).

- [ ] **Step 1: `src/renderer/css/tokens.css`** — полная замена:

```css
/* Дизайн-токены Cockpit v2 (27.07): нейтральный чёрный в духе Warp.
   Вся шкала R=G=B — прежняя тёплая гамма читалась «коричнево-серой».
   Хроматика только у акцента и статусов (ANSI-палитра Warp default_dark, MIT). */
:root {
  --bg-window: #0F0F0F;
  --bg-panel:  #141414;
  --bg-card:   #1E1E1E;
  --bg-hover:  #2A2A2A;
  --bg-wait:   #231A16; /* подложка «ждёт тебя» — единственная тёплая поверхность */

  --border:      #2A2A2A;
  --border-soft: #333333;
  --border-wait: #D97757;

  --text:       #E8E8E8;
  --text-muted: #9E9E9E;
  --text-dim:   #8A8A8A;

  --accent:       #D97757; /* ТОЛЬКО «ждёт тебя» и главные CTA */
  --accent-hover: #A9583E;
  --accent-soft:  #D97757;

  /* Статусы — ANSI Warp default_dark */
  --ok:      #a1b56c;
  --working: #86c1b9;
  --warn:    #f7ca88;
  --err:     #ab4642;

  /* Геометрия Warp: жёстко, без щедрых пилюль */
  --radius-s: 3px;
  --radius-m: 4px;
  --radius-l: 6px;

  --font-ui:    'Inter', 'Segoe UI', sans-serif;
  --font-serif: 'Inter', 'Segoe UI', sans-serif; /* серифов в v2 нет; алиас для совместимости */
  /* DM Mono отменён 27.07: нет кириллицы. Берём тот же шрифт, что и терминал. */
  --font-mono:  'JetBrainsMono NF', 'JetBrains Mono', 'Cascadia Mono', Consolas, monospace;
}
```

- [ ] **Step 2: `terminal.js`** — заменить константу THEME целиком (ANSI скопирована из
  `warpdotdev/themes` standard/default_dark.yaml, MIT):

```js
// Тема терминала v2: нейтральный чёрный + ANSI-палитра Warp default_dark (MIT).
const THEME = {
  background: '#0F0F0F',
  foreground: '#d8d8d8',
  cursor: '#D97757',
  cursorAccent: '#0F0F0F',
  selectionBackground: '#2A2A2A',
  black: '#181818',
  red: '#ab4642',
  green: '#a1b56c',
  yellow: '#f7ca88',
  blue: '#7cafc2',
  magenta: '#ba8baf',
  cyan: '#86c1b9',
  white: '#d8d8d8',
  brightBlack: '#585858',
  brightRed: '#ab4642',
  brightGreen: '#a1b56c',
  brightYellow: '#f7ca88',
  brightBlue: '#7cafc2',
  brightMagenta: '#ba8baf',
  brightCyan: '#86c1b9',
  brightWhite: '#f8f8f8',
};
```

- [ ] **Step 3:** в `main.js` обновить `backgroundColor: '#0F0F0F'` и
  `titleBarOverlay: { color: '#141414', symbolColor: '#9E9E9E', height: 36 }`.
- [ ] **Step 4:** `npm test` + `npm run smoke` → зелёные. Commit `feat: design tokens v2 — neutral black, Warp ANSI palette`.

---

### Task 3: Плотность и геометрия в app.css + чистка старых цветов

**Files:**
- Modify: `src/renderer/css/app.css`, `src/renderer/js/terminal.js` (инлайн-стили панели поиска)

**Interfaces:** внешних контрактов нет; только визуальные правила.

- [ ] **Step 1:** в `app.css` привести к плотности Warp:
  - `#titlebar`: высота 36px (без изменений), шрифт `var(--font-ui)` 12px weight 500,
    letter-spacing −0.1px (убрать серифный стиль `#titlebar-text`).
  - `.tab-row`: padding `6px 8px` (было 7px 8px), gap 7px; `.tab-name` 12px/500;
    `.tab-sub` 10px; активная строка — фон `var(--bg-card)`; «ждёт» — фон `var(--bg-wait)`
    + `border-left: 2px solid var(--accent)` (вместо рамки по периметру).
  - `.sidebar-section`: 9px, letter-spacing .5px, weight 500.
  - `.sidebar-btn`: padding 5px, radius `var(--radius-s)`, border `1px solid var(--border)`.
  - Сайдбар: ширина 200px (было 240) — плотнее.
  - Оверлей restore: карточка radius `var(--radius-l)`, заголовок `var(--font-ui)` 15px/500.
- [ ] **Step 2:** в `terminal.js` инлайн-стили панели поиска перевести на нейтральные
  значения: фон `#141414`, граница `1px solid #2A2A2A`, текст `#E8E8E8`, кнопки `#8A8A8A`.
- [ ] **Step 3: Проверка чистоты** — grep по `src/`:

```powershell
$old = '#141413','#1F1E1B','#262624','#30302E','#3A3733','#403D38','#FAF9F5','#A09D96','#8F8D83','#2e2320','#4a3227','#CC785C','#5DB872','#5DB8A6','#E8A55A','#C64545','Lora','JetBrainsMono NF'
foreach ($c in $old) { $hits = Select-String -Path "C:\Users\Lunev\AssistClaude\claude-cockpit\src\*\*.*","C:\Users\Lunev\AssistClaude\claude-cockpit\src\*\*\*.*" -Pattern ([regex]::Escape($c)) -ErrorAction SilentlyContinue; if ($hits) { "ОСТАЛОСЬ ${c}:"; $hits | ForEach-Object { "  $($_.Path):$($_.LineNumber)" } } }
```

Единственное допустимое исключение — `JetBrainsMono NF` внутри `--font-mono` (fallback) и
`#181818` (ANSI black). Все прочие вхождения устранить. Вывод grep'а — в отчёт.

- [ ] **Step 4:** `npm test` + `npm run smoke`. Commit `feat: Warp-density geometry, purge warm palette remnants`.

---

### Task 4: Панель действий вместо отладочной строки

**Files:**
- Modify: `src/renderer/index.html`, `src/renderer/css/app.css`, `src/renderer/js/app.js`, `src/main/config.js`, `src/preload/preload.js` (если нужен новый канал — не нужен, пишем через существующий `term.write`)

**Interfaces:**
- Consumes: `api.term.write(tabId, data)` (существует), `tabStore.activeId`.
- Produces: конфиг `actionBar: { commands: [{label, command}] }` с дефолтом
  `[{label:'/remote-control', command:'/remote-control'}, {label:'/compact', command:'/compact'}, {label:'/usage', command:'/usage'}]`;
  клик по кнопке → `api.term.write(activeId, command + '\r')`.

- [ ] **Step 1: `config.js`** — в DEFAULTS добавить:

```js
  actionBar: {
    commands: [
      { label: '/remote-control', command: '/remote-control' },
      { label: '/compact', command: '/compact' },
      { label: '/usage', command: '/usage' },
    ],
  },
```

- [ ] **Step 2: `index.html`** — заменить `#status-bar` на:

```html
  <div id="action-bar">
    <div id="action-commands"></div>
    <div id="action-right">
      <span id="limit-5h" title="5-часовое окно"></span>
    </div>
  </div>
```

(Отладочные `#status-pty` и `#status-font` удалить — просьба пользователя. Виджет лимита
пока пустой: наполнится в фазе дашборда; сейчас скрыт, если текста нет.)

- [ ] **Step 3: `app.css`** — стили панели:

```css
#action-bar {
  height: 32px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  background: var(--bg-panel);
  border-top: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-muted);
  user-select: none;
}
#action-commands { display: flex; gap: 5px; }
.action-btn {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 10px;
  padding: 3px 8px;
  cursor: pointer;
}
.action-btn:hover { background: var(--bg-hover); color: var(--text); }
.action-btn:active { background: var(--accent); color: var(--bg-window); border-color: var(--accent); }
#action-right { margin-left: auto; display: flex; align-items: center; gap: 8px; }
```

Также в `app.css` поправить высоту сетки: `#app { height: calc(100% - 36px - 32px); }`.

- [ ] **Step 4: `app.js`** — рендер кнопок в boot() и удаление обращений к `#status-pty`/`#status-font`:

```js
// Панель действий: кнопки шлют слэш-команду в pty активной вкладки (фича 23/26).
function renderActionBar() {
  const host = $('action-commands');
  host.textContent = '';
  for (const { label, command } of (config.actionBar?.commands || [])) {
    const btn = document.createElement('button');
    btn.className = 'action-btn';
    btn.textContent = label;
    btn.title = `Отправить ${command} в активную вкладку`;
    btn.addEventListener('click', () => {
      const id = tabStore.activeId;
      if (id) window.api.term.write(id, `${command}\r`);
    });
    host.appendChild(btn);
  }
}
```

Вызвать `renderActionBar()` в boot() после создания tabStore. Удалить функции/строки,
писавшие в `status-pty` и `status-font` (включая `entry.lastPtyStatus`/`entry.fontSize`
восстановление в activateTab — сами поля можно оставить, но DOM-запись убрать; при
удалении убедиться, что onPtyStatus/onFontSize колбэки остаются валидными функциями).

- [ ] **Step 5:** `npm test` + `npm run smoke` → зелёные; `npm start` ~15 с в фоне, ноль
  `[renderer-error]`, аккуратный taskkill /T. Commit `feat: action bar with slash-command buttons, drop debug status line`.

---

## Приёмка фазы (руками)

1. `npm start` — окно нейтрально-чёрное, терминал `#0F0F0F`, ни следа коричневого.
2. Шрифты: интерфейс Inter, терминал DM Mono.
3. Строки сайдбара плотнее, углы жёсткие (4px), «ждёт тебя» — терракотовая левая кромка + пульс.
4. Внизу — панель с кнопками `/remote-control`, `/compact`, `/usage`; клик по кнопке
   отправляет команду в активную вкладку. Отладочной строки нет.

## Self-Review (выполнен)

1. **Coverage:** токены ✓ (T2), геометрия/плотность ✓ (T3), шрифты ✓ (T1), панель+кнопки ✓ (T4),
   удаление отладочной строки ✓ (T4). Фичи 24/25/27-30 (проводник, голос, библиотека промптов,
   именованные воркспейсы, навигатор ходов, WebGL) — отдельные фазы, не дыра.
2. **Placeholders:** нет; единственная точка неопределённости (актуальные URL шрифтов)
   снабжена критерием проверки и требованием зафиксировать фактические ссылки.
3. **Consistency:** имена CSS-переменных не меняются → app.css не ломается; `--font-serif`
   сохранён алиасом; высота сетки пересчитана под 32px панель; `api.term.write` — существующий канал.
