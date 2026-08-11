'use strict';
// Копирование в буфер обмена из терминала — с запасным путём для страницы,
// отданной по http.
//
// Живая жалоба 09.08: «command+V даёт вставку, но я не могу копировать текст в
// окне кокпита с мака». Причина зеркальна той, что была у вставки: Clipboard
// API живёт только в защищённом контексте, а браузер на макбуке получает
// страницу по http — там navigator.clipboard ПРОСТО НЕ СУЩЕСТВУЕТ.
//
// Прежний код звал `navigator.clipboard.writeText(sel).catch(() => {})`, то
// есть обращался к свойству undefined. Исключение при этом синхронное, и
// .catch его не ловит — копирование падало совершенно молча: и по выделению
// (copyOnSelect), и правым кликом, и по Ctrl+Shift+C.
//
// Запасной путь — execCommand('copy') через временное поле. Он объявлен
// устаревшим, но работает в незащищённом контексте, и другого способа для
// http-страницы нет. Правильное лекарство — HTTPS через Tailscale Serve
// (план 4 фазы), но пока его нет, копирование должно работать.
// Копирование, которое не молчит при отказе.
//
// copyText честно возвращает false, когда положить текст не вышло, — но в
// terminal.js результат не смотрел никто: человек выделял текст, ничего не
// происходило, и в интерфейсе не было ни строчки об этом. Ровно тот класс, что
// чинили в api-boot.js (B3, тост про буфер): действие молча не срабатывает.
//
// throttle — для «копировать выделением»: xterm зовёт onSelectionChange на
// КАЖДОЕ изменение выделения, то есть за одну протяжку мышью десятки раз. Без
// глушилки сломанный буфер обмена засыпал бы экран тостами. Явные действия
// (Cmd+C, правый клик) сообщают всегда: человек нажал и ждёт результата.
//
// Зависимости снаружи (copy/notify/now) — чтобы поведение проверялось тестом, а
// не стражем по исходнику: стражи здесь уже трижды оказывались холостыми.
export function createCopyReporter({
  copy = copyText,
  notify,
  now = () => Date.now(),
  quietMs = 10000,
  message = 'скопировать не вышло: браузер не дал доступ к буферу обмена',
} = {}) {
  let lastComplaintAt = null;
  return async function copyOrComplain(text, { throttle = false } = {}) {
    // await обязателен: без него ok — это Promise, всегда истинный, и жалоба
    // не прозвучит никогда (та же мина, что ловил страж B3).
    const ok = await copy(text);
    if (ok) return true;
    const stamp = now();
    const recently = throttle && lastComplaintAt !== null && (stamp - lastComplaintAt) < quietMs;
    if (!recently) {
      lastComplaintAt = stamp;
      if (typeof notify === 'function') notify(message);
    }
    return false;
  };
}

export async function copyText(text, {
  clipboard = (typeof navigator !== 'undefined' ? navigator.clipboard : undefined),
  doc = (typeof document !== 'undefined' ? document : undefined),
} = {}) {
  if (typeof text !== 'string' || !text) return false;

  // Основной путь. Отказать он может не только отсутствием: без фокуса
  // документа Chromium отвечает NotAllowedError — тогда тоже идём в запасной.
  if (clipboard && typeof clipboard.writeText === 'function') {
    try {
      await clipboard.writeText(text);
      return true;
    } catch { /* пробуем запасной путь ниже */ }
  }

  if (!doc || typeof doc.execCommand !== 'function') return false;

  // Временное поле: execCommand('copy') копирует ВЫДЕЛЕНИЕ документа, поэтому
  // текст надо сначала куда-то положить и выделить.
  const area = doc.createElement('textarea');
  area.value = text;
  // Вне экрана, но не display:none и не hidden: невидимое поле нельзя выделить,
  // и копировать станет нечего.
  area.style.position = 'fixed';
  area.style.top = '-1000px';
  area.style.opacity = '0';
  area.setAttribute('readonly', '');
  // Кого фокус покидает — тому и вернём. Без этого после КАЖДОГО копирования
  // фокус оставался на удалённом поле и падал на body: клавиатура переставала
  // попадать в терминал, пока человек не кликнет мышью (ревью 09.08, B2).
  // Бьёт это по основному сетевому сценарию: в браузере по http Clipboard API
  // недоступен, работает именно этот путь, а «копировать выделением» включено
  // по умолчанию — то есть ввод терялся на каждом выделении текста мышью.
  const previous = doc.activeElement;
  doc.body.appendChild(area);
  try {
    area.focus();
    area.select();
    if (typeof area.setSelectionRange === 'function') area.setSelectionRange(0, text.length);
    return doc.execCommand('copy') === true;
  } catch {
    return false;
  } finally {
    // Поле обязано уйти при любом исходе, иначе останется висеть в DOM.
    area.remove();
    // Возвращаем фокус только живому элементу, который его умеет принимать:
    // прежний владелец мог исчезнуть из DOM, пока шло копирование.
    if (previous && typeof previous.focus === 'function' && doc.contains(previous)) {
      try { previous.focus(); } catch { /* элемент мог стать нефокусируемым */ }
    }
  }
}
