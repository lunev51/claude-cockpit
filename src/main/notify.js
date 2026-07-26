'use strict';
// Канал уведомлений main→renderer. Любой модуль main-процесса может вызвать
// notify(text, level) — сообщение уедет в renderer ('app:notice') и покажется
// тостом. Окно регистрируется один раз через setWindow(win).

let _win = null;

// Регистрация окна-получателя (вызывается из main.js после createWindow).
function setWindow(win) {
  _win = win;
}

// notify(text, level): level ∈ {'warn','error'}. Безопасно при отсутствии/
// уничтоженном окне — просто дублируем в консоль.
function notify(text, level = 'warn') {
  const line = `[notice:${level}] ${text}`;
  if (level === 'error') console.error(line); else console.warn(line);
  if (!_win || _win.isDestroyed()) return;
  try {
    _win.webContents.send('app:notice', { text: String(text), level });
  } catch { /* окно могло уйти между проверкой и отправкой */ }
}

module.exports = { setWindow, notify };
