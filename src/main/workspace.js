'use strict';
// Манифест воркспейса: какие вкладки открыты, их session-id и ghost-файлы.
// Пишется атомарно (temp+rename) с дебаунсом на каждое изменение — урок из
// жалоб на официальный клиент, где раскладка «не доживает» до перезапуска.
// Предыдущее валидное состояние хранится в .bak (упрощение спеки §6:
// двух поколений достаточно вместо пяти).

const fs = require('fs');

function isValid(state) {
  return !!state
    && typeof state === 'object'
    && state.version === 1
    && Number.isInteger(state.activeIndex)
    && Array.isArray(state.tabs)
    && state.tabs.every((t) => t && typeof t.cwd === 'string');
}

function readValid(file) {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isValid(state) ? state : null;
  } catch {
    return null;
  }
}

function createWorkspaceStore({ file, debounceMs = 500 }) {
  let pending = null;   // несохранённое состояние
  let timer = null;

  function load() {
    return readValid(file) || readValid(`${file}.bak`);
  }

  function writeNow() {
    if (pending === null) return;
    const state = pending;
    pending = null;
    try {
      // Текущий валидный файл становится страховкой перед перезаписью. FIX 8
      // (ревью): копируем в .bak, только если file САМ проходит валидацию —
      // иначе одна внешняя порча file (например, обрыв записи сторонним
      // процессом) затирает последнее ХОРОШЕЕ поколение битым содержимым,
      // и .bak перестаёт быть страховкой ровно в тот момент, когда она нужна.
      if (readValid(file)) {
        try { fs.copyFileSync(file, `${file}.bak`); } catch { /* не критично */ }
      }
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(tmp, file);
    } catch (err) {
      console.warn(`[workspace] запись манифеста не удалась: ${err.message}`);
    }
  }

  function set(state) {
    pending = state;
    if (timer) clearTimeout(timer);
    timer = setTimeout(writeNow, debounceMs);
    if (timer.unref) timer.unref();
  }

  function flush() {
    if (timer) clearTimeout(timer);
    timer = null;
    writeNow();
  }

  return { load, set, flush };
}

module.exports = { createWorkspaceStore };
