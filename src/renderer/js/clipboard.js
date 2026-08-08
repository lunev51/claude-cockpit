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
  }
}
