'use strict';
// Зеркало экрана каждой вкладки — то, что клиент получает по net:buffer,
// подключившись (новая страница браузера, перезагрузка renderer, ЛЮБОЙ обрыв
// связи: reconnectLoop в api-boot.js перезагружает страницу).
//
// Живая жалоба 05.11: кокпит в Chrome на ПК, у вкладки akto после открытия
// страницы низ терминала сломан — нет рамок поля ввода и строки статуса, на
// месте статус-бара только изменившиеся цифры («47», «5»). Соседняя вкладка
// целая.
//
// Причина — в природе потока. На Windows pty отдаёт рендер ConPTY: абсолютные
// позиции (CSI r;c H), ни одного перевода строки, полная перерисовка экрана
// (CSI 2J) — только при ресайзе, дальше одни изменившиеся клетки (спиннер,
// счётчик токенов). Раньше клиент получал последние 256 КБ сырого потока
// (output-buffer.js). Вкладка akto 3 мин 42 с крутила спиннер — последняя
// полная перерисовка ушла за пределы хвоста, и всё, что с тех пор не менялось
// (рамки, «Opus 5.5 | akto | main», «bypass permissions»), в хвосте просто
// отсутствовало. Ресайза при открытии страницы нет (размер тот же) — значит,
// нет и перерисовки, которая бы это спасла. Хвостом любой длины это не
// лечится: перерисовка может быть сколь угодно давней.
//
// Поэтому main держит у себя настоящий терминал (@xterm/headless) на каждую
// вкладку, того же размера, что её pty, и отдаёт его снимок
// (@xterm/addon-serialize). Снимок, записанный в свежий xterm того же
// размера, восстанавливает экран один в один. Спайк на живом буфере вкладки
// claude-cockpit (296 тыс. символов): 0 расходящихся строк, курсор на месте,
// разбор — 22 мс, снимок — 4 КБ против 256 КБ хвоста.
//
// Память: один терминал на вкладку с прокруткой SCROLLBACK строк. ConPTY
// почти не прокручивает (пишет по абсолютным позициям), так что прокрутка
// заполняется редко, а снимок с ней — это и есть «что было выше экрана».
const { createOutputBuffer } = require('./output-buffer');
// Валидный размер — тот же, что эстафета и pty (2..500 по обеим осям), а не
// своё правило: зеркало обязано совпадать с pty, кривое значит «размера нет».
const { isValidSize } = require('./ownership');

const SCROLLBACK = 1000;

function createScreenMirror({ Terminal, SerializeAddon, sizeOf, scrollback = SCROLLBACK }) {
  // tabId → { term, serializer, pending:Set<resolve> }
  const mirrors = new Map();

  function currentSize(tabId) {
    const size = sizeOf(tabId);
    return isValidSize(size) ? size : null;
  }

  function fit(mirror, size) {
    if (mirror.term.cols !== size.cols || mirror.term.rows !== size.rows) {
      mirror.term.resize(size.cols, size.rows);
    }
  }

  return {
    push(tabId, data) {
      if (!tabId || typeof data !== 'string' || !data) return;
      // Размера нет — вкладки нет: закрыта, а это хвост убитого pty, долетевший
      // после tabs:close. Заводить ради него терминал нельзя — получили бы
      // утечку зеркала на каждое закрытие вкладки.
      const size = currentSize(tabId);
      if (!size) return;
      let mirror = mirrors.get(tabId);
      if (!mirror) {
        const term = new Terminal({
          cols: size.cols, rows: size.rows, scrollback, allowProposedApi: true, // serialize — proposed API
        });
        const serializer = new SerializeAddon();
        term.loadAddon(serializer);
        mirror = { term, serializer, pending: new Set() };
        mirrors.set(tabId, mirror);
      } else {
        // Ресайз ДО записи: поток после ресайза pty уже в новой сетке. Кусок
        // старого размера, не долетевший к моменту ресайза, ляжет криво, но
        // ConPTY после ресайза перерисовывает экран целиком — это его и лечит.
        fit(mirror, size);
      }
      mirror.term.write(data);
    },

    // Promise<string>. write в xterm асинхронный (очередь разбирается кусками
    // по таймеру): снимок сразу после push потерял бы всё, что ещё в очереди.
    // Пустая запись с колбэком встаёт в ту же очередь последней — колбэк
    // приходит, когда разобрано всё принятое до неё.
    get(tabId) {
      const mirror = mirrors.get(tabId);
      if (!mirror) return Promise.resolve('');
      // Ресайз без вывода (ConPTY ещё не перерисовал) — снимок всё равно в
      // текущей сетке pty: клиент запишет его в xterm именно такого размера.
      const size = currentSize(tabId);
      if (size) fit(mirror, size);
      return new Promise((resolve) => {
        mirror.pending.add(resolve);
        mirror.term.write('', () => {
          if (!mirror.pending.delete(resolve)) return; // уже ответили в drop
          resolve(mirror.serializer.serialize({ scrollback }));
        });
      });
    },

    drop(tabId) {
      const mirror = mirrors.get(tabId);
      if (!mirror) return;
      mirrors.delete(tabId);
      // Разобранный терминал колбэк записи не позовёт — ждущий снимка (клиент
      // подключался, пока вкладку закрывали) висел бы вечно. Вкладки больше
      // нет, её история — пустая строка.
      for (const resolve of mirror.pending) resolve('');
      mirror.pending.clear();
      mirror.term.dispose();
    },
  };
}

// Зеркало, а если пакетов нет — старый сырой хвост. @xterm/headless — новая
// зависимость: pull без npm install оставил бы её ненайденной, и main упал бы
// на старте целиком. Кокпит не имеет права упасть из-за отсутствующего пакета:
// старое поведение (экран целый, пока полная перерисовка в пределах хвоста)
// лучше, чем никакого. Предупреждение одно — при создании, а не на каждый
// вывод.
function createTabHistory({ sizeOf, load = require, warn = console.warn }) {
  try {
    const { Terminal } = load('@xterm/headless');
    const { SerializeAddon } = load('@xterm/addon-serialize');
    // Пакет есть, а экспорта нет (сменилась сборка) — это то же «нет пакета»,
    // только упало бы позже, на первом выводе вкладки.
    if (typeof Terminal !== 'function' || typeof SerializeAddon !== 'function') {
      throw new Error('нет Terminal/SerializeAddon в экспорте');
    }
    return createScreenMirror({ Terminal, SerializeAddon, sizeOf });
  } catch (err) {
    warn(`[screen-mirror] @xterm/headless или @xterm/addon-serialize недоступны (${err && err.message}) — `
      + 'история вкладок будет сырым хвостом вывода; поможет npm install');
    const raw = createOutputBuffer();
    // Тот же контракт, что у зеркала: get — промис.
    return { push: raw.push, get: async (tabId) => raw.get(tabId), drop: raw.drop };
  }
}

module.exports = { createScreenMirror, createTabHistory, SCROLLBACK };
