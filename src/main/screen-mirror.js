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
// (@xterm/addon-serialize), записанный клиентом в свежий xterm того же размера.
//
// Насколько снимок точен (замеры ревью ветки, 05.11):
//  - зеркало = окно ПК: фазз сырого потока по клеткам — совпадение во всех
//    случаях, это один и тот же xterm на одном и том же потоке;
//  - снимок = зеркало на живом буфере вкладки claude-cockpit (296 тыс.
//    символов): 0 расходящихся строк, курсор на месте; разбор — 22 мс,
//    снимок — 4 КБ против 256 КБ хвоста;
//  - известный изъян самого аддона (0.14.0): автоперенесённая строка, у
//    продолжения которой стёрто начало (EL/ECH), сериализуется со сдвигом —
//    cols=10, «aaaaaaaaaabbb» + стереть первую клетку второй строки: зеркало
//    ["aaaaaaaaaa", " bb"], снимок ["aaaaaaaaab", "b"] (SerializeAddon.ts,
//    приоритет `a && b ? c : d` в проверке переноса). Живёт ровно до
//    перерисовки этих строк, на потоке ConPTY (без автопереноса в рамках
//    Claude Code) не встречен. Аддон не латаем: обход потребовал бы своей
//    сериализации буфера, а дешёвого публичного — нет;
//  - режимы, которые аддон не переносит вовсе, дописываются сюда сами (см.
//    trackLostModes ниже), иначе мышь у клиента мертва.
//
// Принятое ограничение: зритель с сеткой ВЫШЕ pty (невладелец под заглушкой,
// управление у другого) при непустой прокрутке зеркала видит строки истории
// под экраном pty — снимок пишется строками от верха, и лишняя высота клиента
// показывает «раскол». Захват управления даёт ресайз pty и полную перерисовку
// ConPTY — у владельца сетка всегда равна pty.
//
// Память: один терминал на вкладку с прокруткой SCROLLBACK строк. На живых
// буферах ConPTY переводов строки нет вовсе — прокрутка пустая, и терминал
// весит экран. В общем случае (поток с переводами строк, полная прокрутка)
// это до ~3,7 МБ на вкладку при 200×50 (замер ревью) и ~1,2 МБ при 120×40.
const { createOutputBuffer } = require('./output-buffer');
// Валидный размер — тот же, что эстафета и pty (2..500 по обеим осям), а не
// своё правило: зеркало обязано совпадать с pty, кривое значит «размера нет».
const { isValidSize } = require('./ownership');

const SCROLLBACK = 1000;

// Режимы, которые addon-serialize 0.14.0 не переносит (_serializeModes знает
// слежение мыши, bracketed paste, клавиатурные режимы — но не кодировку мыши
// и не видимость курсора). Ревью ветки (I1), подтверждено на живых буферах:
// ConPTY ставит ?1000h ?1002h ?1003h ?1006h по разу. Клиент после снимка
// получал слежение DRAG/ANY в кодировке по умолчанию — события мыши уходят
// в onBinary как \e[M…, а terminal.js слушает только onData: колесо мёртвое.
//
// Следим публичным API парсера (обработчик с return false — xterm дальше
// обрабатывает последовательность как обычно). Правила — ровно поведение
// xterm 6 (его InputHandler): ?1006h → SGR, ?1016h → SGR_PIXELS, ?1006l и
// ?1016l → по умолчанию; ?25h/?25l — курсор; RIS (\ec) сбрасывает кодировку,
// но видимость курсора НЕ трогает; DECSTR (\e[!p) показывает курсор, мышь не
// трогает. ?1005/?1015 xterm не поддерживает — клиенту их нести незачем.
// Равенство с окном ПК держит таблица в test/screen-mirror.test.js: другое
// поведение нового xterm покраснит там.
//
// Возвращает функцию: строка, которую дописать в конец снимка. Только
// отличия от умолчания — как и сам аддон: снимок пишется в свежий xterm
// (attachTab → replayHistory), его умолчания и есть исходное состояние.
//
// Подпараметры (1006:1) приходят в params отдельным элементом-массивом после
// основного числа; массив не равен ни одному числу ниже — отдельный фильтр
// не нужен.
function trackLostModes(term) {
  let mouseEncoding = 'DEFAULT';
  let cursorHidden = false;
  term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
    for (const p of params) {
      if (p === 1006) mouseEncoding = 'SGR';
      else if (p === 1016) mouseEncoding = 'SGR_PIXELS';
      else if (p === 25) cursorHidden = false;
    }
    return false;
  });
  term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
    for (const p of params) {
      if (p === 1006 || p === 1016) mouseEncoding = 'DEFAULT';
      else if (p === 25) cursorHidden = true;
    }
    return false;
  });
  term.parser.registerEscHandler({ final: 'c' }, () => {
    mouseEncoding = 'DEFAULT';
    return false;
  });
  term.parser.registerCsiHandler({ intermediates: '!', final: 'p' }, () => {
    cursorHidden = false;
    return false;
  });
  const ENCODING = { DEFAULT: '', SGR: '\x1b[?1006h', SGR_PIXELS: '\x1b[?1016h' };
  return () => ENCODING[mouseEncoding] + (cursorHidden ? '\x1b[?25l' : '');
}

function createScreenMirror({
  Terminal, SerializeAddon, sizeOf, scrollback = SCROLLBACK, warn = console.warn,
}) {
  // tabId → { term, serializer, lostModes, pending:Set<resolve> }
  const mirrors = new Map();

  // Одно предупреждение на вид поломки: push зовётся на каждый кусок вывода,
  // и сломанная запись засыпала бы журнал main.
  const warned = new Set();
  function warnOnce(kind, err) {
    if (warned.has(kind)) return;
    warned.add(kind);
    warn(`[screen-mirror] ${kind}: ${err && err.message} — история вкладки может быть неполной`);
  }

  function currentSize(tabId) {
    const size = sizeOf(tabId);
    return isValidSize(size) ? size : null;
  }

  // resize в xterm синхронный, а write — очередь, которую xterm разбирает
  // таймером. Поэтому подгонка применяется ко ВСЕМУ, что ещё не разобрано, —
  // в том числе к кускам, пришедшим до ресайза pty в старой сетке: порядок
  // «подогнать, потом записать» в push ничего не упорядочивает. Это терпимо
  // потому, что ConPTY после ресайза перерисовывает экран целиком, и
  // перерисовка стоит в очереди после старых кусков — она их и перекрывает.
  function fit(mirror, size) {
    if (mirror.term.cols !== size.cols || mirror.term.rows !== size.rows) {
      mirror.term.resize(size.cols, size.rows);
    }
  }

  function create(size) {
    const term = new Terminal({
      cols: size.cols, rows: size.rows, scrollback, allowProposedApi: true, // serialize — proposed API
    });
    const serializer = new SerializeAddon();
    term.loadAddon(serializer);
    return { term, serializer, lostModes: trackLostModes(term), pending: new Set() };
  }

  return {
    // Никогда не бросает (ревью ветки, m2): зовётся из onEvent менеджера
    // сессий, то есть из onData node-pty. Исключение здесь — uncaughtException
    // и выход main, а term:data этого куска не дошёл бы до клиентов
    // (bufferTermData стоит в onEvent до broadcast.emit). Реальный повод —
    // очередь xterm сверх 50 МБ: write бросает «write data discarded».
    push(tabId, data) {
      if (!tabId || typeof data !== 'string' || !data) return;
      try {
        // Размера нет — вкладки нет: закрыта, а это хвост убитого pty,
        // долетевший после tabs:close. Заводить ради него терминал нельзя —
        // получили бы утечку зеркала на каждое закрытие вкладки.
        const size = currentSize(tabId);
        if (!size) return;
        let mirror = mirrors.get(tabId);
        if (!mirror) {
          mirror = create(size);
          mirrors.set(tabId, mirror);
        } else {
          fit(mirror, size);
        }
        mirror.term.write(data);
      } catch (err) {
        warnOnce('запись в зеркало экрана не удалась', err);
      }
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
          // Колбэк xterm зовёт и после dispose (ревью ветки, exp-dispose-cb):
          // вкладку закрыли, пока ждали, — drop уже ответил пустой строкой. А
          // serialize на разобранном терминале не бросает, но печатает в
          // журнал трассу «Trying to add a disposable to a DisposableStore
          // that has already been disposed».
          if (!mirror.pending.delete(resolve)) return;
          // Колбэк исполняется в таймере xterm, мимо любого try вызывающего:
          // исключение отсюда — uncaughtException и выход main.
          try {
            resolve(mirror.serializer.serialize({ scrollback }) + mirror.lostModes());
          } catch (err) {
            warnOnce('снимок зеркала экрана не снялся', err);
            resolve('');
          }
        });
      });
    },

    drop(tabId) {
      const mirror = mirrors.get(tabId);
      if (!mirror) return;
      mirrors.delete(tabId);
      // Ждущим снимка (клиент подключался, пока вкладку закрывали) отвечаем
      // сразу: вкладки больше нет, её история — пустая строка. Их колбэки
      // записи придут позже и увидят, что ответ уже дан.
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
    return createScreenMirror({
      Terminal, SerializeAddon, sizeOf, warn,
    });
  } catch (err) {
    warn(`[screen-mirror] @xterm/headless или @xterm/addon-serialize недоступны (${err && err.message}) — `
      + 'история вкладок будет сырым хвостом вывода; поможет npm install');
    const raw = createOutputBuffer();
    // Тот же контракт, что у зеркала: get — промис.
    return { push: raw.push, get: async (tabId) => raw.get(tabId), drop: raw.drop };
  }
}

module.exports = { createScreenMirror, createTabHistory, SCROLLBACK };
