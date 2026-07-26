'use strict';
// Все IPC-каналы регистрируются здесь, в одном месте.
// PTY-инстанс живёт внутри модуля; main управляет им через disposePty().

const { ipcMain, shell } = require('electron');
const { getConfig, setConfig } = require('./config');
const { createPty } = require('./pty');
const { transcribeWav } = require('./stt');
const { chooseWorkdir } = require('./workdir');
const { getActualPort } = require('./speak-server');

let ptyProc = null;
// Последние известные размеры терминала (из term:start / term:resize) —
// нужны для term:restart, чтобы заспавнить pty с теми же параметрами.
let lastCols = 80;
let lastRows = 24;

// Проверка размеров терминала: целое в диапазоне 2..500.
function validDim(n) {
  return Number.isInteger(n) && n >= 2 && n <= 500;
}

// win — BrowserWindow, куда шлём вывод PTY.
// opts.smoke — вместо claude спавним cmd.exe /c echo PTY_OK (smoke-тест).
// opts.onPtyData — необязательный колбэк для main (сбор вывода в smoke-режиме).
function registerIpc(win, opts = {}) {
  const { smoke = false, onPtyData = null } = opts;

  // Описание процесса для текущего режима.
  function buildSpec() {
    const t = getConfig().terminal;
    return smoke
      ? { command: 'cmd.exe', args: ['/c', 'echo PTY_OK'], cwd: t.cwd }
      : { command: t.command, args: t.args, cwd: t.cwd };
  }

  // Спавн pty с обработкой ошибок: main не должен падать.
  function spawnPty(cols, rows) {
    const spec = buildSpec();
    try {
      // onExit передаётся в createPty ДО присвоения ptyProc — сравниваем по
      // ссылке на свой инстанс, чтобы старый onExit не затёр новый процесс.
      let myProc;
      myProc = createPty({
        ...spec,
        cols,
        rows,
        useConpty: getConfig().terminal.useConpty !== false,
        useConptyDll: getConfig().terminal.useConptyDll !== false,
        // Маркер для Stop-хука: озвучка работает только внутри companion'а.
        env: {
          ...process.env,
          CC_COMPANION: '1',
          // Фактический порт озвучки: speak-server стартует в whenReady ДО
          // term:start, так что реальный порт уже известен. Если сервер не
          // слушает (0) — падаем на конфиг-значение.
          CC_SPEAK_PORT: String(getActualPort() || getConfig().tts?.port || 48751),
        },
        onData: (data) => {
          if (onPtyData) onPtyData(data);
          if (!win.isDestroyed()) win.webContents.send('term:data', data);
        },
        onExit: (exitCode) => {
          // Обнуляем только если это всё ещё наш процесс (иначе рестарт уже
          // подменил ptyProc и затирать его нельзя).
          if (ptyProc === myProc) ptyProc = null;
          if (!win.isDestroyed()) win.webContents.send('term:exit', { exitCode });
        },
      });
      ptyProc = myProc;
      if (!win.isDestroyed()) win.webContents.send('term:started', { pid: ptyProc.pid });
    } catch (err) {
      ptyProc = null;
      if (!win.isDestroyed()) {
        win.webContents.send(
          'term:data',
          `\x1b[31m[не удалось запустить ${spec.command}: ${err.message}]\x1b[0m\r\n`,
        );
        win.webContents.send('term:exit', { exitCode: -1 });
      }
    }
  }

  ipcMain.handle('config:get', () => getConfig());

  ipcMain.handle('config:set', (_e, partial) => {
    if (!partial || typeof partial !== 'object' || Array.isArray(partial)) {
      throw new TypeError('config:set ожидает plain-object');
    }
    return setConfig(partial);
  });

  // Смена рабочей папки: диалог → перезапуск pty → обновление заголовка окна.
  ipcMain.handle('workdir:choose', async () => {
    const chosen = await chooseWorkdir(win, getConfig, setConfig);
    if (!chosen) return null;
    // Перезапуск pty с новым cwd (buildSpec уже читает getConfig().terminal.cwd)
    if (ptyProc) {
      try { ptyProc.kill(); } catch { /* мог уже завершиться */ }
      ptyProc = null;
    }
    spawnPty(lastCols, lastRows);
    // Обновляем заголовок окна
    if (!win.isDestroyed()) win.setTitle(`Claude Companion — ${chosen}`);
    return chosen;
  });

  ipcMain.handle('shell:openExternal', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  ipcMain.on('term:start', (_e, { cols, rows } = {}) => {
    if (ptyProc) return; // повторный start игнорируем
    if (!validDim(cols) || !validDim(rows)) return;
    lastCols = cols;
    lastRows = rows;
    spawnPty(cols, rows);
  });

  ipcMain.on('term:restart', () => {
    if (ptyProc) {
      try { ptyProc.kill(); } catch { /* мог уже завершиться */ }
      ptyProc = null;
    }
    spawnPty(lastCols, lastRows);
  });

  ipcMain.on('term:write', (_e, data) => {
    if (typeof data !== 'string') return;
    if (ptyProc) ptyProc.write(data);
  });

  // Распознавание речи: buf — ArrayBuffer/Uint8Array с WAV из renderer.
  ipcMain.handle('stt:transcribe', async (_e, buf) => {
    if (!(buf instanceof ArrayBuffer) && !(buf instanceof Uint8Array)) {
      throw new TypeError('stt:transcribe ожидает ArrayBuffer или Uint8Array');
    }
    return transcribeWav(Buffer.from(buf), getConfig().stt);
  });

  ipcMain.on('term:resize', (_e, { cols, rows } = {}) => {
    if (!validDim(cols) || !validDim(rows)) return;
    lastCols = cols;
    lastRows = rows;
    if (ptyProc) ptyProc.resize(cols, rows);
  });
}

// Убиваем PTY при выходе приложения.
function disposePty() {
  if (!ptyProc) return;
  try { ptyProc.kill(); } catch { /* процесс мог уже завершиться */ }
  ptyProc = null;
}

module.exports = { registerIpc, disposePty };
