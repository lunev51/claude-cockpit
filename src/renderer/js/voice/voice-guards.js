'use strict';
// Task 3 фазы 9 (голосовой ввод, push-to-talk по правому Shift) — чистые
// гарды/решения, вынесенные ОТДЕЛЬНЫМ модулем от app.js (урок финального
// ревью фазы 7: не хоронить принимающую решение логику в замыканиях
// оркестратора — без вынесения её нельзя покрыть node --test). Ничего про
// DOM/Electron внутри — используется app.js (renderer, import) и напрямую
// тестом через динамический import() (тот же мост, что night-format.js/
// format.js, см. test/night-format.test.js).

// «Можно ли начать запись прямо сейчас» — ТРИ независимых условия (бриф,
// task-3-brief.md): ни один оверлей приложения не открыт (палитра/дашборд/
// peek/поиск истории/форма рецепта/шпаргалка клавиш/поле очереди/restore —
// см. app.js/overlayFlags()), есть активная вкладка (некуда писать текст),
// голосовой стек найден на диске (status().available — НЕ то же самое, что
// «сервер сейчас поднят», см. src/main/stt.js/status()). Мусорные overlays
// (null/undefined) трактуются как «ничего не открыто» — защитный рубеж, а не
// повод бросить исключение из обработчика keydown.
function canStartRecording({ overlays, hasActiveTab, sttAvailable }) {
  if (!hasActiveTab) return false;
  if (!sttAvailable) return false;
  if (overlays && Object.values(overlays).some(Boolean)) return false;
  return true;
}

// «Что делать с ответом stt:transcribe(wav)» — {text}|{error} от main (см.
// preload.js/stt.transcribe, IPC-контракт Task 2) → ОДНО из трёх действий:
//   - error (непустая строка) → тост с текстом ошибки как есть (main уже
//     перевёл её в человеческий вид — стек/бекенды/таймаут, см. stt.js);
//   - text пустой/из одних пробелов (тишина/шум) → тост «Не расслышал»;
//   - иначе → доставка (app.js прогонит normalizeForPty + гард статуса
//     вкладки writeCommandToTab — тот же путь, каким уходят рецепты).
// error проверяется ПЕРВЫМ: по контракту Task 2 поля error/text взаимно
// исключающие, но если оба почему-то присутствуют — ошибка приоритетнее
// (нечего доставлять текст, который main пометил как сбойный).
function resolveTranscribeResult(result) {
  if (result && typeof result.error === 'string' && result.error) {
    return { action: 'toast', level: 'error', message: result.error };
  }
  const text = result && typeof result.text === 'string' ? result.text : '';
  if (!text.trim()) {
    return { action: 'toast', level: 'warn', message: 'Не расслышал' };
  }
  return { action: 'deliver', text };
}

export { canStartRecording, resolveTranscribeResult };
