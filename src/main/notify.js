'use strict';
// Канал уведомлений main→renderer. Любой модуль main-процесса может вызвать
// notify(text, level) — сообщение уедет в renderer ('app:notice') и покажется
// тостом. Рассылка регистрируется один раз через setBroadcast(broadcast).
//
// Ре-ревью задачи 3 (Important 1): раньше здесь был setWindow(win) и прямой
// win.webContents.send — локальное окно получало тост, а браузерный клиент
// на другой машине НЕ получал его никогда, потому что этот канал не проходил
// через единую точку рассылки (broadcast.js). Это тот самый класс молчаливой
// дыры, ради которого задача 3 делалась: локально работает без единой
// ошибки, по сети — нет.

let _broadcast = null;

// Регистрация рассылки (вызывается из main.js после registerIpc(), когда
// broadcast уже создан — см. main.js).
function setBroadcast(broadcast) {
  _broadcast = broadcast;
}

// notify(text, level): level ∈ {'warn','error','info'}. Безопасно при
// отсутствии рассылки (например, до её подключения) — просто дублируем в
// консоль. 'info' — находка 4б (ревью фазы 6): успешное действие
// пользователя (например, «хуки подключены») — не предупреждение и не
// ошибка, console.warn() для него был бы неверной маркировкой в DevTools.
function notify(text, level = 'warn') {
  const line = `[notice:${level}] ${text}`;
  if (level === 'error') console.error(line);
  else if (level === 'info') console.log(line);
  else console.warn(line);
  if (!_broadcast) return; // рассылка ещё не подключена — окно/сеть подождут
  _broadcast.emit('app:notice', { text: String(text), level });
}

module.exports = { setBroadcast, notify };
