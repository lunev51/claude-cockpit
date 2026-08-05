'use strict';
// Кто сейчас за рулём. У pty один размер на всех клиентов, поэтому
// одновременных хозяев быть не может — эксклюзивность убирает целый слой
// согласования колонок и строк.
//
// Уход владельца НЕ передаёт управление: закрытая крышка макбука не должна
// разворачивать окно на ПК посреди ночи. Управление меняется только явным
// захватом — открытием страницы в браузере или показом окна на ПК.
function createOwnership({ onChange } = {}) {
  let owner = 'local';
  let online = true;
  // Размер помним ПО ВЛАДЕЛЬЦУ: окно ПК на весь экран и браузер на макбуке —
  // это два разных терминала. Возврат управления часто происходит без нового
  // размера (main.js забирает его при показе окна, когда renderer ещё не
  // успел сказать своё слово), и подставить туда чужой размер значило бы
  // перерисовать Claude Code в ширине другой машины на каждом возврате.
  const sizes = new Map();

  function claim(who, nextSize) {
    if (nextSize) sizes.set(who, { cols: nextSize.cols, rows: nextSize.rows });
    if (who === owner) {
      // Тот же хозяин вернулся после обрыва — событие не нужно, но офлайн
      // снимаем: интерфейс показывает «владелец не на связи».
      online = true;
      return false;
    }
    const previous = owner;
    owner = who;
    online = true;
    // Размер НОВОГО владельца, не прежнего: именно под него переразмеривается
    // pty. Незнакомый клиент без размера отдаёт null — лучше не трогать pty
    // вовсе, чем натянуть на него чужую раскладку (см. applyHandoffSize).
    if (typeof onChange === 'function') onChange({ owner, previous, size: sizes.get(who) || null });
    return true;
  }

  function drop(who) {
    if (who !== owner) return false;
    online = false;
    return true;
  }

  return {
    owner: () => owner,
    size: () => sizes.get(owner) || null,
    ownerOnline: () => online,
    canWrite: (who) => who === owner,
    claim,
    drop,
  };
}

module.exports = { createOwnership };
