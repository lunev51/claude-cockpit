'use strict';
// Если preload уже дал window.api — мы в Electron, ничего не делаем.
// Иначе поднимаем сокет к тому же хосту, откуда пришла страница.
//
// Этот файл — ПЕРВЫЙ импорт app.js (см. комментарий там), не отдельный
// <script>: top-level await ниже реально блокирует выполнение app.js до
// готовности window.api (ревью задачи 6, Critical 1).
import { createNetApi } from './net-api.js';
import { API_SHAPE } from './api-shape.js';

// Недоступный сервер не должен вешать страницу навсегда (ревью задачи 6,
// Important 2) — таймаут ловит тихо непослушный порт (пакеты роняются без
// ответа), 'error' ловит быстрый и явный отказ (порт закрыт, TLS и т.п.).
const CONNECT_TIMEOUT_MS = 10000;

// I3 ревью: обрыва связи не было видно ВООБЩЕ, а переподключения не было ни
// здесь, ни в net-api.js — страница оставалась мёртвой до F5. Нарастающий
// интервал (спека: «клиент переподключается с нарастающим интервалом») —
// явный список, а не формула: последнее значение повторяется бесконечно, так
// что закрытая на ночь крышка макбука не превращается в раз-в-час.
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];

// Состояние связи для интерфейса. В Electron сокета нет вовсе — значение так и
// остаётся «на связи» (окно и main живут одним процессом: умер main — умерло
// окно, показывать некому).
export const linkState = { online: true, attempt: 0 };
const linkWatchers = [];

export function onLinkChange(fn) {
  linkWatchers.push(fn);
}

// C2 ре-ревью: перезагрузка после обрыва (reconnectLoop ниже) — НЕ «человек
// открыл страницу», и захват управления при такой загрузке отбирал руль у
// живого ПК (handoff-view.js/shouldClaimOnLoad, там же вся цепочка). Метка
// живёт в sessionStorage: она обязана пережить ИМЕННО перезагрузку и умереть
// вместе со вкладкой. Читается ровно один раз (app.js/takeAutoReloadMark) —
// иначе следующая, уже ручная, F5 сошла бы за автоматическую.
export const RELOAD_MARK_KEY = 'cockpit.autoReload';

// sessionStorage может бросить (file://, приватный режим с выключенным
// хранилищем) — потеря метки не повод не переподключаться вовсе.
function markAutoReload() {
  try { window.sessionStorage.setItem(RELOAD_MARK_KEY, '1'); } catch { /* переживём */ }
}

function setLink(patch) {
  Object.assign(linkState, patch);
  for (const fn of linkWatchers) {
    // Падение одного наблюдателя не должно рвать переподключение.
    try { fn({ ...linkState }); } catch { /* его беда */ }
  }
}

// Переподключение НЕ пытается чинить состояние страницы на живую: сокет
// поднимается заново только чтобы узнать, что кокпит снова отвечает, — а
// дальше страница перезагружается целиком. Это тот же путь, которым сюда
// приходит любой новый клиент (boot() → tabs:list → подключение к живым
// вкладкам с историей из net:buffer), то есть уже отревьюженный и рабочий, а
// не второй, «умный», написанный ради одного сценария.
function reconnectLoop(url) {
  const delay = RECONNECT_DELAYS_MS[
    Math.min(linkState.attempt, RECONNECT_DELAYS_MS.length - 1)
  ];
  setTimeout(() => {
    setLink({ attempt: linkState.attempt + 1 });
    let probe = null;
    let settled = false;
    // 'error' и 'close' приходят парой — вторая попытка планировалась бы
    // дважды и интервал схлопывался бы вдвое.
    const fail = () => {
      if (settled) return;
      settled = true;
      try { probe && probe.close(); } catch { /* уже мёртв */ }
      reconnectLoop(url);
    };
    try {
      probe = new WebSocket(url);
    } catch {
      fail();
      return;
    }
    probe.addEventListener('open', () => {
      if (settled) return;
      settled = true;
      setLink({ online: true });
      try { probe.close(); } catch { /* всё равно перезагружаемся */ }
      // Метку ставим ДО reload: после него этот код уже не выполнится.
      markAutoReload();
      window.location.reload();
    }, { once: true });
    probe.addEventListener('error', fail, { once: true });
    probe.addEventListener('close', fail, { once: true });
  }, delay);
}

function watchLink(socket, url) {
  const down = () => {
    if (!linkState.online) return; // close после error — один обрыв, не два
    setLink({ online: false, attempt: 0 });
    reconnectLoop(url);
  };
  socket.addEventListener('close', down);
  socket.addEventListener('error', down);
}

if (!window.api) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  // Адрес собирается ЗДЕСЬ и дословно (`${proto}://${location.host}/ws`) —
  // test/renderer-boot-guard.js сверяет этот шаблон с path сокет-сервера в
  // net-server.js: разъехавшийся путь дал бы загружающуюся страницу, у
  // которой window.api не соберётся никогда. Переподключение берёт готовый
  // socket.url, чтобы второй копии этого шаблона в файле не было вовсе.
  const socket = new WebSocket(`${proto}://${location.host}/ws`);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('сервер кокпита не ответил за 10 секунд')),
      CONNECT_TIMEOUT_MS,
    );
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('не удалось подключиться к серверу кокпита'));
    }, { once: true });
  });
  const api = createNetApi({ socket, shape: API_SHAPE });
  // I1 ре-ревью: shell:openExternal — канал ПИШУЩИЙ (он открывает браузер на
  // машине владельца, окно которой в этот момент спрятано в трей), и после
  // сужения прав невладельца клик по строке дашборда, по бейджу PR и по ссылке
  // в терминале давал у зрителя unhandled rejection и ничего больше. Но
  // человек в браузере хочет открыть ссылку У СЕБЯ — а для этого сетевому
  // клиенту чужое разрешение не нужно вовсе: он и так браузер. Подменяем метод
  // ЗДЕСЬ, на единственной границе «мы не в Electron»: в окне ПК всё остаётся
  // как было (там window.api собирает preload и эта ветка не выполняется).
  //
  // Проверка схемы — та же, что в main (ipc.js/shell:openExternal): в
  // window.open нельзя пускать javascript:/data: — ссылка приезжает из чужого
  // вывода терминала. noopener обязателен: без него открытая страница получает
  // window.opener на кокпит.
  //
  // Заблокированный попап (M2 ре-ревью) иначе не оставляет НИ ОДНОГО следа:
  // с noopener window.open по спеке всегда возвращает null, так что отличить
  // «открылось» от «браузер запретил» по возвращённому значению нельзя.
  // Сегодня все вызовы идут прямо из клика и блокировщик их пропускает, но
  // любой будущий вызов из таймера или промиса отвалился бы молча. Поэтому
  // спрашиваем у браузера, считает ли он момент пользовательским, и если нет —
  // говорим человеку, а не делаем вид, что открыли.
  api.shell.openExternal = async (url) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return;
    const activation = navigator.userActivation;
    if (activation && activation.isActive === false) {
      window.dispatchEvent(new CustomEvent('cockpit:toast', {
        detail: { text: 'браузер не дал открыть ссылку — она в буфере обмена', level: 'warn' },
      }));
      try {
        await navigator.clipboard.writeText(url);
      } catch { /* буфер тоже могут не дать — тогда остаётся только текст тоста */ }
      return;
    }
    window.open(url, '_blank', 'noopener');
  };
  window.api = api;
  // План 3: признак «мы сетевой клиент, а не окно Electron». По нему файловый
  // обзор прячет кнопку «Системное окно»: нативный диалог открылся бы на
  // машине владельца, окно которой в этот момент спрятано в трей, — то есть
  // модалка повисла бы там, где никого нет.
  window.__cockpitNetClient = true;
  watchLink(socket, socket.url);
}
