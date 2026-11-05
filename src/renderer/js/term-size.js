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

// proposed — результат fit.proposeDimensions(); box — {width, height}
// контейнера (clientWidth/clientHeight). null = «терминал не подогнан, слать
// нечего». Проверка коробки нужна именно для свёрнутого окна: там FitAddon
// предлагает 2×1 — целые и конечные, по форме неотличимые от настоящих.
export function fittedSize(proposed, box) {
  if (!proposed || !box) return null;
  const { cols, rows } = proposed;
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) return null;
  if (!(box.width > 0) || !(box.height > 0)) return null;
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
