'use strict';
// Task 3 фазы 9 (голосовой ввод, push-to-talk по правому Shift) — чистые
// гарды/решения, вынесенные ОТДЕЛЬНЫМ модулем от app.js (урок финального
// ревью фазы 7: не хоронить принимающую решение логику в замыканиях
// оркестратора — без вынесения её нельзя покрыть node --test). Ничего про
// DOM/Electron внутри — используется app.js (renderer, import) и напрямую
// тестом через динамический import() (тот же мост, что night-format.js/
// format.js, см. test/night-format.test.js).

// «Можно ли начать запись прямо сейчас, и если нет — нужен ли тост» (ревью
// раунда 2, Minor 2 — заменяет прежнюю canStartRecording: ТА же проверка трёх
// условий из брифа, task-3-brief.md, плюс причина отказа и готовый тост,
// вынесенные из bindVoiceHotkey/app.js, где раньше жили инлайново). Условия
// (в порядке проверки, порядок ЗНАЧИМ — см. ниже): есть активная вкладка
// (некуда писать текст) → ни один оверлей приложения не открыт (палитра/
// дашборд/peek/поиск истории/форма рецепта/шпаргалка клавиш/поле очереди/
// restore — см. app.js/overlayFlags(), сведены вызывающим кодом в один
// булев overlaysOpen) → голосовой стек найден на диске (sttAvailable —
// status().available, НЕ то же самое, что «сервер сейчас поднят», см.
// src/main/stt.js/status()).
//
// Порядок проверки — не только «первая сработавшая причина», но и явное
// решение «когда НЕ показывать тост про стек»: тост «стек не найден»
// (одноразовый за сессию, состояние которого хранит вызывающий код) должен
// гореть ТОЛЬКО когда стек — единственная и реальная блокирующая причина, а
// не когда отказ вызван ещё и/только отсутствием вкладки или открытым
// оверлеем (Minor 3 ревью раунда 1: раньше тост про стек мог сгореть
// впустую, если параллельно не было активной вкладки — теперь reason
// однозначно называет ПЕРВУЮ применимую причину, и toast присутствует ТОЛЬКО
// у reason:'stt-unavailable').
function resolveStartBlock({ overlaysOpen, hasActiveTab, sttAvailable }) {
  if (!hasActiveTab) return { allowed: false, reason: 'no-tab' };
  if (overlaysOpen) return { allowed: false, reason: 'overlay' };
  if (!sttAvailable) {
    return {
      allowed: false,
      reason: 'stt-unavailable',
      toast: { message: 'Голосовой стек не найден (см. stt.stackRoots в конфиге)', level: 'warn' },
    };
  }
  return { allowed: true, reason: null };
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

export { resolveStartBlock, resolveTranscribeResult };
