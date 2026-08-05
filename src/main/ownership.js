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
  let size = null;

  function claim(who, nextSize) {
    if (nextSize) size = { cols: nextSize.cols, rows: nextSize.rows };
    if (who === owner) {
      // Тот же хозяин вернулся после обрыва — событие не нужно, но офлайн
      // снимаем: интерфейс показывает «владелец не на связи».
      online = true;
      return false;
    }
    const previous = owner;
    owner = who;
    online = true;
    if (typeof onChange === 'function') onChange({ owner, previous, size });
    return true;
  }

  function drop(who) {
    if (who !== owner) return false;
    online = false;
    return true;
  }

  return {
    owner: () => owner,
    size: () => size,
    ownerOnline: () => online,
    canWrite: (who) => who === owner,
    claim,
    drop,
  };
}

module.exports = { createOwnership };
