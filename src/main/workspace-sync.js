'use strict';
// Чистое (без Electron) ядро синхронизации манифеста воркспейса — вынесено
// из ipc.js специально ради теста на КРИТИЧЕСКИЙ баг ревью (FIX 1): при
// нормальном закрытии окна flushWorkspace() зовётся дважды (window-all-closed
// пишет хороший манифест, затем before-quit) — между этими двумя вызовами
// disposeSessions() закрывает все вкладки одну за другой, каждое закрытие
// шлёт tabs:changed, который пересобирает манифест уже из ПОРЕДЕВШЕГО списка
// вкладок. К моменту второго flush() в pending лежит {tabs: []}, и именно
// он попадает на диск — вчерашний состав вкладок стирается на каждом штатном
// выходе, restore никогда не срабатывает. Живые ручные проверки этого не
// ловили, потому что использовали taskkill /F — он не даёт процессу дойти
// до обработчиков выхода вообще.
//
// Фикс — двусторонний гейт поверх store:
//  - markQuitting() необратимо глушит sync() ПОСЛЕ первого flush() в
//    выходной последовательности — второй (и любой следующий) sync,
//    порождённый закрытием вкладок внутри disposeSessions(), уже не может
//    затереть pending.
//  - markReady() (FIX 2) держит sync() немым, пока renderer не закончит
//    восстановление воркспейса при старте — иначе каждый promitional open()
//    восстанавливаемой вкладки писал бы манифест текущим (неполным) составом,
//    и закрытие/краш посреди стаггера-восстановления теряло бы вкладки
//    безвозвратно.

function createWorkspaceSync({ store, listTabs, smoke = false }) {
  let ready = false;
  let quitting = false;

  function sync(activeTabId) {
    if (smoke) return;      // headless-прогон никогда не пишет userData
    if (!ready) return;      // FIX 2: восстановление воркспейса ещё не завершено
    if (quitting) return;    // FIX 1: приложение уже начало выходить — состав больше не трогаем
    const list = listTabs();
    const idx = list.findIndex((t) => t.tabId === activeTabId);
    store.set({
      version: 1,
      activeIndex: idx === -1 ? 0 : idx,
      tabs: list.map(({ cwd, name, sessionId, ghostId }) => ({ cwd, name, sessionId, ghostId })),
    });
  }

  function markReady() {
    ready = true;
  }

  function markQuitting() {
    quitting = true;
  }

  function flush() {
    store.flush();
  }

  // ARCHITECTURE Fix 13 (ревью): раньше самая ценная строка хотфикса —
  // markReady() + немедленный условный sync() при непустом списке вкладок —
  // жила прямо в ipc.js (обработчик 'workspace:ready'), а ipc.js без
  // Electron-контекста не тестируется вообще (в репо нет ipc-тестов).
  // Переносим логику сюда, в чистый (без Electron) модуль — она покрывается
  // тем же test/workspace-sync.test.js, что и остальной гейт ready/quitting.
  //
  // markReady() зовём ВСЕГДА, а немедленный sync() — ТОЛЬКО если в manager
  // уже есть хоть одна вкладка (см. подробное обоснование FIX 1 (carryover 3)
  // выше в шапке файла и в ipc.js, обработчик 'workspace:ready'): на ветках
  // отказа («начать пусто» / Esc / пустой выбор чекбоксов) manager.list()
  // пуст, и eager-sync записал бы валидно-пустой манифест, теряя вчерашний
  // состав вкладок и ghost-файлы до первого РЕАЛЬНОГО изменения состава.
  function readyAndSync(activeTabId) {
    markReady();
    if (listTabs().length > 0) sync(activeTabId);
  }

  return {
    sync, markReady, markQuitting, flush, readyAndSync,
  };
}

module.exports = { createWorkspaceSync };
