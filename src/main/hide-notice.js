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
function createHideExplainer({ canNotify, notify }) {
  let explained = false;
  return function explainHide(reason) {
    const notice = HIDE_NOTICES[reason];
    if (!notice || explained || !canNotify()) return null;
    explained = true;
    notify(notice);
    return notice;
  };
}

module.exports = { createHideExplainer, HIDE_NOTICES };
