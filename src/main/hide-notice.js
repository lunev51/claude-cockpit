'use strict';
// Объяснение, куда делось окно (ревью 09.08, C28). Чистый модуль: Electron
// (Notification) приходит снаружи, из main.js, — решение «показывать ли и
// какой текст» проверяется test/hide-notice.test.js без него.
//
// Окно прячется в трей двумя путями: крестиком (win.on('close') — выход
// только из меню трея, иначе удалённый клиент остался бы без вкладок) и уходом
// управления на другую машину (hideWindow). Объяснение было только у второго,
// а самый частый путь — крестик — молчал: окно пропадало из панели задач и
// Alt+Tab, и это выглядело как «приложение закрылось само», хотя сессии жили.
//
// Правило: объясняем ПЕРВОЕ скрытие за запуск — любым путём — и ровно один
// раз. Текст свой у каждого пути: у крестика человек сам закрыл окно, и ему
// важно, что сессии живы и как выйти совсем; при уходе управления окно
// спряталось само, и важно, почему.
const HIDE_NOTICES = Object.freeze({
  close: Object.freeze({
    title: 'Cockpit работает в трее',
    body: 'Сессии живы. Выйти совсем — «Выход» в меню значка в трее.',
  }),
  handoff: Object.freeze({
    title: 'Cockpit свёрнут в трей',
    body: 'Управление ушло на другую машину. Значок в трее вернёт окно.',
  }),
});

// canNotify — есть ли центр уведомлений (Notification.isSupported()),
// notify({title, body}) — показать. Возвращает функцию explainHide(reason):
// reason — 'close' | 'handoff'; отдаёт показанный текст или null.
//
// НЕ бросает никогда (I1 ревью ветки): explainHide зовётся из win.on('close')
// — точки входа без guarded(), — и бросок оттуда ушёл бы в uncaughtException
// → teardown() и app.exit(1): все pty умерли бы ради тоста. Окно к этому
// моменту уже спрятано (main.js зовёт нас после win.hide()). Сломанный тост
// не повторяем: «первый раз» тратится до notify().
function createHideExplainer({ canNotify, notify }) {
  let explained = false;
  const supported = () => {
    try {
      return !!canNotify();
    } catch (err) {
      console.warn('[hide-notice] центр уведомлений недоступен:', err && err.message);
      return false;
    }
  };
  return function explainHide(reason) {
    const notice = HIDE_NOTICES[reason];
    if (!notice || explained || !supported()) return null;
    explained = true;
    try {
      notify(notice);
    } catch (err) {
      console.warn('[hide-notice] уведомление не показалось:', err && err.message);
      return null;
    }
    return notice;
  };
}

module.exports = { createHideExplainer, HIDE_NOTICES };
