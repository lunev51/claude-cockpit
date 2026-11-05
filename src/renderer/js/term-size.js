// Размер терминала: когда его вообще можно сообщать pty, и как дождаться
// шрифта, по которому он считается. Чистые функции без DOM — покрыты
// test/term-size.test.js.
//
// Запись кадров на стенде 05.11 (браузер, три вкладки claude): pty получал
// 80×24 трижды за одну загрузку страницы — захват до появления вкладок,
// term:start из скрытого контейнера и ResizeObserver скрытой вкладки. Во всех
// трёх случаях терминал НЕ был подогнан, а в pty уходил term.cols/term.rows,
// то есть умолчание xterm. FitAddon о неудаче не сообщает: proposeDimensions
// отдаёт undefined (терминал не открыт, ячейка не измерена), {NaN, NaN}
// (контейнер display:none — getComputedStyle даёт 'auto') или зажатый минимум
// 2×1 (контейнер 0×0 у свёрнутого окна), а fit() в первых двух случаях молча
// выходит. Отсюда отдельная проверка, а не доверие к term.cols.

// proposed — результат fit.proposeDimensions(). area — {width, height}
// ОБЛАСТИ ПОД КЛЕТКИ в CSS-пикселях: контентный блок контейнера (без его
// отступа) минус полоса прокрутки — ровно то, из чего FitAddon считает
// сетку. cell — CSS-размер ячейки, по которому он считал.
// null = «терминал не подогнан, слать нечего».
//
// Почему «сетка влезает в область», а не «область не нулевая». FitAddon
// зажимает минимум: cols ≥ 2, rows ≥ 1 — и на нулевой или почти нулевой
// области предлагает 2×1, 2×29 и т.п.: целые и конечные, по форме неотличимые
// от настоящих. Первая редакция сверяла их с clientWidth/clientHeight, а те
// включают отступ .term-view: хост 0×0 давал 8×4 — не ноль — и 2×1 уходили
// в pty (ревью ветки в Chrome; хост 0×500 давал 2×29, которые не отсекает и
// main). Зажатое значение по построению НЕ влезает в свою область, настоящее —
// влезает всегда (floor), так что проверка точная, без выдуманных порогов.
// Порога «слишком мало» сверх этого нет намеренно: узкое, но настоящее окно
// тоже размер, иначе pty остался бы шире видимого и строки резались бы справа.
//
// rows ≥ 2, cols ≥ 2 — те же границы, что validDim в main: меньшего он всё
// равно не примет. Допуск полпикселя — на ошибку округления дробной ячейки
// (floor(l / w) * w может обогнать l на 1e-13).
export function fittedSize(proposed, area, cell) {
  if (!proposed || !area || !cell) return null;
  const { cols, rows } = proposed;
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2) return null;
  if (!(area.width > 0) || !(area.height > 0)) return null;
  if (!(cell.width > 0) || !(cell.height > 0)) return null;
  const SLACK = 0.5;
  if (cols * cell.width > area.width + SLACK || rows * cell.height > area.height + SLACK) return null;
  return { cols, rows };
}

// Дождаться шрифта терминала. xterm мерит ячейку один раз при открытии и
// перемеряет только на смене опций шрифта, DPR и ресайзе (xterm 6:
// CharSizeService.measure) — если к этому моменту вшитый шрифт не догрузился,
// ячейка посчитана по запасному (Menlo на маке: высота строки ~1.16 em против
// 1.32 em у JetBrains Mono), и число строк выходит больше, чем влезает:
// нижние строки, то есть статус-бар Claude Code, уезжают за край.
//
// fonts — FontFaceSet (document.fonts), spec — CSS-шорткат вида
// `14px "JetBrainsMono NF"`. Никогда не бросает: шрифт — улучшение, а не
// условие запуска. Не загрузился (заблокирован, нет сети) — терминал всё
// равно открывается, а догрузку позже ловит подписка в terminal.js.
// Сколько ждать шрифт до первого терминала (app.js/boot). Дольше — пустое
// окно вместо терминала при заблокированном шрифте или без сети; догрузку
// позже всё равно поймает terminal.js (onFontsLoaded). Границы стережёт
// test/term-size.test.js: литерал по месту не стерёг никто (ревью ветки).
export const FONT_WAIT_MS = 3000;

export async function waitForFont(fonts, spec, timeoutMs) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const load = (async () => {
    try {
      await fonts.load(spec);
      return 'loaded';
    } catch {
      return 'failed';
    }
  })();
  try {
    return await Promise.race([load, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
