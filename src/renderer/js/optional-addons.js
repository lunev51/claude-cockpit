'use strict';
// Аддоны xterm, нужные только по флагу конфига (ревью 09.08, C15).
//
// addon-webgl (~248 КБ) и addon-unicode11 (~52 КБ) раньше грузились тегами
// index.html всегда, хотя обе фичи выключены по умолчанию (terminal.webgl:
// false, unicode11 не задан). Браузер на макбуке качал эти ~300 КБ на каждой
// загрузке страницы ради кода, который не исполнялся. Теперь boot() (app.js)
// грузит их отсюда — только включённые и до первого терминала: terminal.js
// читает window.WebglAddon / window.Unicode11Addon синхронно при создании
// вкладки, позже будет поздно.
//
// Деградация та же, что была у самого terminal.js: аддон не доехал — его
// фича выключена, terminal.js сам предупредит в консоли и возьмёт обычный
// рендер. Ни отказ, ни зависшая загрузка не держат boot.

// flag — ключ config.terminal, global — что UMD-сборка кладёт в window и
// что читает terminal.js. src — тот же путь, что был у тега: относительный
// <script src> браузер разрешает от адреса СТРАНИЦЫ (index.html), а не этого
// модуля, и по сети он схлопывается в /node_modules/... (корень статики, см.
// rendererStaticRoots в ipc.js).
export const OPTIONAL_ADDONS = [
  { flag: 'webgl', global: 'WebglAddon', src: '../../node_modules/@xterm/addon-webgl/lib/addon-webgl.js' },
  { flag: 'unicode11', global: 'Unicode11Addon', src: '../../node_modules/@xterm/addon-unicode11/lib/addon-unicode11.js' },
];

// Потолок ожидания одного аддона. Локально (Electron, file://) это
// миллисекунды; по медленной сети до макбука 250 КБ успевают с запасом.
// Дольше держать boot нельзя: интерфейс пустой, пока ждём.
export const ADDON_WAIT_MS = 5000;

// Ровно то условие, по которому terminal.js аддон включает (=== true):
// грузить аддон, который terminal.js не возьмёт, незачем.
export function neededAddons(termCfg) {
  return OPTIONAL_ADDONS.filter((a) => !!termCfg && termCfg[a.flag] === true);
}

function injectScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(`не загрузился ${src}`));
    document.head.appendChild(el);
  });
}

// → { [flag]: 'loaded' | 'failed' | 'timeout' } по каждому включённому
// аддону. Никогда не бросает. loadScript/isLoaded/warn — для теста.
export async function loadOptionalAddons(termCfg, {
  loadScript = injectScript,
  isLoaded = (name) => typeof window !== 'undefined' && window[name] != null,
  warn = (...args) => console.warn(...args),
  timeoutMs = ADDON_WAIT_MS,
} = {}) {
  const outcome = {};
  await Promise.all(neededAddons(termCfg).map(async (addon) => {
    if (isLoaded(addon.global)) {
      outcome[addon.flag] = 'loaded';
      return;
    }
    let failure = null;
    const failed = (err) => { failure = err; return 'failed'; };
    // Отказ ловится здесь же: загрузка, проигравшая таймауту и упавшая
    // позже, иначе стала бы необработанным отказом промиса.
    let loading;
    try {
      loading = Promise.resolve(loadScript(addon.src)).then(() => 'loaded', failed);
    } catch (err) {
      loading = Promise.resolve(failed(err));
    }
    let timer = null;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs); });
    let result = await Promise.race([loading, timeout]);
    clearTimeout(timer);
    // Скрипт исполнился, а глобали нет — сборка сменила имя; terminal.js её
    // всё равно не найдёт.
    if (result === 'loaded' && !isLoaded(addon.global)) result = 'failed';
    if (result !== 'loaded') {
      const why = result === 'timeout' ? `не загрузился за ${timeoutMs} мс`
        : (failure ? failure.message : `загрузился, но window.${addon.global} не появился`);
      warn(`[boot] аддон ${addon.global} (terminal.${addon.flag}) ${why} — открываю терминалы без него`);
    }
    outcome[addon.flag] = result;
  }));
  return outcome;
}
