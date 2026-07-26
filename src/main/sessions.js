'use strict';
// Менеджер сессий: tabId → pty + машина статусов (спека §5.2).
// Чистый Node-модуль без Electron: фабрика pty, конфиг, клок и env инжектятся.
// Статусы приходят ТОЛЬКО из хуков Claude Code и жизненного цикла pty —
// вывод терминала не парсится никогда (хрупко, ломается о каждый релиз CLI).

const path = require('path');
const crypto = require('crypto');

const STATUSES = ['working', 'waiting', 'done', 'stuck', 'dead'];

// ptyFactory(opts) → {write, resize, kill, pid} — в проде createPty из pty.js.
// getTermConfig() → config.terminal; onEvent(channel, payload) → webContents.send.
// now() — клок (тестам нужен управляемый); stuckAfterMs — порог зависания;
// getExtraEnv() — доп. env для pty (порт hook-bridge, Task 2).
function createSessionManager({
  ptyFactory,
  getTermConfig,
  onEvent,
  now = Date.now,
  stuckAfterMs = 5 * 60 * 1000,
  getExtraEnv = () => ({}),
}) {
  const tabs = new Map();

  function open({ cwd, command = null, args = null, smoke = false }) {
    const tabId = crypto.randomUUID();
    const name = path.basename(cwd) || cwd;
    tabs.set(tabId, {
      tabId, cwd, name, smoke,
      command, args,           // per-tab переопределение (claude --resume <id> в фазе 2b)
      proc: null, cols: 80, rows: 24, alive: false,
      gen: 0,                  // поколение спавна: гардит все колбэки от гонок
      sessionId: null,         // session_id Claude Code из SessionStart-хука
      status: null, subtitle: '', waitingText: '',
      lastOutputAt: now(),
      pendingExtraArgs: null,  // одноразовый оверрайд args на следующий spawn() (хотфикс restart, спека §3.14)
      resumePending: false,    // true = последний спавн ушёл с --resume/--continue и ещё не подтверждён SessionStart-хуком
    });
    return { tabId, cwd, name };
  }

  function setStatus(tab, status, subtitle) {
    tab.status = status;
    if (typeof subtitle === 'string') tab.subtitle = subtitle;
    if (status !== 'waiting') tab.waitingText = '';
    onEvent('tab:status', {
      tabId: tab.tabId, status, subtitle: tab.subtitle, waitingText: tab.waitingText,
    });
  }

  function spawn(tab) {
    const t = getTermConfig();
    // pendingExtraArgs — одноразовый оверрайд от restart() (--resume/--continue),
    // потребляется здесь и сбрасывается, чтобы следующий обычный спавн был «голым».
    const extraArgs = tab.pendingExtraArgs;
    tab.pendingExtraArgs = null;
    const baseArgs = tab.args || t.args;
    const spec = tab.smoke
      ? { command: 'cmd.exe', args: ['/c', 'echo PTY_OK'] }
      : { command: tab.command || t.command, args: extraArgs ? [...baseArgs, ...extraArgs] : baseArgs };
    // Поколение растёт ДО вызова фабрики: синхронные колбэки нового процесса
    // проходят гард, а все колбэки предыдущего поколения — отсекаются.
    tab.gen += 1;
    const myGen = tab.gen;
    try {
      const proc = ptyFactory({
        ...spec,
        cwd: tab.cwd,
        cols: tab.cols,
        rows: tab.rows,
        useConpty: t.useConpty !== false,
        useConptyDll: t.useConptyDll !== false,
        env: {
          ...process.env,
          COCKPIT: '1',
          COCKPIT_TAB_ID: tab.tabId,
          ...getExtraEnv(),
        },
        onData: (data) => {
          if (myGen !== tab.gen) return; // хвост убитого процесса
          tab.lastOutputAt = now();
          if (tab.status === 'stuck') setStatus(tab, 'working', tab.subtitle);
          onEvent('term:data', { tabId: tab.tabId, data });
        },
        onExit: (exitCode) => {
          if (myGen !== tab.gen) return; // stale exit после рестарта
          tab.proc = null;
          tab.alive = false;
          setStatus(tab, 'dead', `процесс завершён (код ${exitCode})`);
          onEvent('term:exit', { tabId: tab.tabId, exitCode });
        },
      });
      // Синхронный exit из фабрики мог уже пометить смерть — не воскрешаем.
      if (myGen === tab.gen && tab.status !== 'dead') {
        tab.proc = proc;
        tab.alive = true;
        setStatus(tab, 'working', 'сессия запущена');
        onEvent('term:started', { tabId: tab.tabId, pid: proc.pid });
      }
    } catch (err) {
      tab.proc = null;
      tab.alive = false;
      setStatus(tab, 'dead', 'не запустился');
      onEvent('term:data', {
        tabId: tab.tabId,
        data: `\x1b[31m[не удалось запустить ${spec.command}: ${err.message}]\x1b[0m\r\n`,
      });
      onEvent('term:exit', { tabId: tab.tabId, exitCode: -1 });
    }
  }

  function start(tabId, cols, rows) {
    const tab = tabs.get(tabId);
    if (!tab || tab.proc) return;
    tab.cols = cols;
    tab.rows = rows;
    spawn(tab);
  }

  function write(tabId, data) {
    const tab = tabs.get(tabId);
    if (tab && tab.proc) tab.proc.write(data);
  }

  function resize(tabId, cols, rows) {
    const tab = tabs.get(tabId);
    if (!tab) return;
    tab.cols = cols;
    tab.rows = rows;
    if (tab.proc) tab.proc.resize(cols, rows);
  }

  // Рестарт «на месте» (Ctrl+Shift+R) не должен терять сессию — три уровня
  // деградации из спеки §3.14:
  function restart(tabId) {
    const tab = tabs.get(tabId);
    if (!tab) return;
    if (tab.proc) {
      try { tab.proc.kill(); } catch { /* мог уже завершиться */ }
      tab.proc = null;
      tab.alive = false;
    }
    const boundSessionId = tab.sessionId;
    tab.sessionId = null; // новая жизнь — новый SessionStart перебиндит

    if (boundSessionId) {
      // 1. session_id уже известен (из прошлого SessionStart) — резюмируем именно его.
      tab.pendingExtraArgs = ['--resume', boundSessionId];
      tab.resumePending = true;
    } else if (!tab.resumePending) {
      // 2. session_id ещё нет, и предыдущая попытка резюма/continue не провалилась —
      //    пробуем --continue (последняя сессия этой папки). Это же включает хуки,
      //    если вкладка была запущена до подключения хуков к проекту.
      tab.pendingExtraArgs = ['--continue'];
      tab.resumePending = true;
    } else {
      // 3. Предыдущий спавн уже уходил с --resume/--continue, но SessionStart так
      //    и не пришёл (процесс умер, сессия не нашлась) — не зацикливаемся на
      //    вечных попытках, спавним голые args как обычный старт.
      tab.pendingExtraArgs = null;
      tab.resumePending = false;
    }

    spawn(tab);
  }

  function close(tabId) {
    const tab = tabs.get(tabId);
    if (!tab) return;
    tab.gen += 1; // отсекаем любые будущие колбэки процесса
    if (tab.proc) {
      try { tab.proc.kill(); } catch { /* мог уже завершиться */ }
    }
    tabs.delete(tabId);
  }

  // --- привязка session_id и события хуков ---

  function bindSession(tabId, sessionId) {
    const tab = tabs.get(tabId);
    if (tab) tab.sessionId = sessionId;
  }

  function findBySessionId(sessionId) {
    for (const tab of tabs.values()) {
      if (tab.sessionId === sessionId) return tab.tabId;
    }
    return null;
  }

  function findUnboundByCwd(cwd) {
    for (const tab of tabs.values()) {
      if (!tab.sessionId && tab.cwd === cwd) return tab.tabId;
    }
    return null;
  }

  // Переходы машины статусов по событиям хуков (спека §5.2).
  function applyHookEvent(tabId, event, data = {}) {
    const tab = tabs.get(tabId);
    if (!tab) return;
    switch (event) {
      case 'SessionStart':
        if (data.session_id) {
          bindSession(tabId, data.session_id);
          tab.resumePending = false; // resume/continue подтверждён хуком — попытка удалась
        }
        setStatus(tab, 'working', 'сессия запущена');
        break;
      case 'UserPromptSubmit':
        setStatus(tab, 'working', 'думает…');
        break;
      case 'PreToolUse':
        setStatus(tab, 'working', data.tool_name ? `${data.tool_name}…` : 'работает…');
        break;
      case 'Notification':
        tab.waitingText = String(data.message || '');
        tab.status = 'waiting';
        tab.subtitle = tab.waitingText.slice(0, 120);
        onEvent('tab:status', {
          tabId: tab.tabId, status: 'waiting', subtitle: tab.subtitle, waitingText: tab.waitingText,
        });
        break;
      case 'Stop':
        setStatus(tab, 'done', '');
        break;
      default:
        break; // незнакомые события молча игнорируем — контракт CLI может расти
    }
  }

  // Детект зависания: working без вывода дольше порога. Зовётся таймером main.
  function checkStuck() {
    const ts = now();
    for (const tab of tabs.values()) {
      if (tab.status === 'working' && tab.proc && ts - tab.lastOutputAt > stuckAfterMs) {
        const min = Math.max(1, Math.round((ts - tab.lastOutputAt) / 60000));
        setStatus(tab, 'stuck', `нет вывода ${min}м`);
      }
    }
  }

  function list() {
    return [...tabs.values()].map(({ tabId, cwd, name, alive, status, subtitle, sessionId }) => (
      { tabId, cwd, name, alive, status, subtitle, sessionId }
    ));
  }

  function disposeAll() {
    for (const tabId of [...tabs.keys()]) close(tabId);
  }

  return {
    open, start, write, resize, restart, close, list, disposeAll,
    bindSession, findBySessionId, findUnboundByCwd, applyHookEvent, checkStuck,
  };
}

module.exports = { createSessionManager, STATUSES };
