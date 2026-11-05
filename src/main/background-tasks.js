'use strict';
// Фоновые задачи вкладки (статус «фон», план 2026-11-05) — чистые функции
// без состояния; состояние (tab.bg) держит sessions.js.
//
// «Фон» — то, что Claude оставил жить после своего хода: команда в фоне
// (Bash/PowerShell с backgroundTaskId), фоновый агент (Agent с isAsync,
// либо возобновлённый через SendMessage) или Workflow. Monitor и прочие
// наблюдатели — не работа, их не считаем.
//
// Откуда берётся «жива ли ещё» — с хука Stop, а не из уведомлений. Stop у
// CLI (схема хука, проверено по бинарю 2.1.316 и 2.1.318) несёт поле
// background_tasks: всё, что ещё летит, пустой массив — ничего. Уведомление
// о конце задачи (<task-notification>) ненадёжно как источник: CLI часто
// вкладывает его прямо в идущий ход, и хук UserPromptSubmit его не видит —
// по живым журналам 05.11 так было у 69 из 92 таких доставок. Ядро, которое
// верило бы своему журналу запусков, держало бы вкладку в «фоне» вечно.
//
// Сам журнал запусков всё равно нужен: в списке Stop Monitor выглядит как
// обычная 'shell' (local_bash с kind monitor), и отличить его можно только
// тем, что его запуска мы как фона не видели.

// Команды, чей фон считаем. Monitor сюда не входит намеренно (см. шапку).
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

const isId = (v) => typeof v === 'string' && v !== '';

// PostToolUse → {id, kind} | null. toolResponse — tool_response хука как есть.
//
// Для команд признак — сам backgroundTaskId, а не run_in_background во
// входе: CLI ставит его всякий раз, когда команда продолжает жить в фоне, в
// том числе уведённая туда по Ctrl+B или по таймауту (backgroundedByUser,
// timedOutAfterMs). backgroundEndsWithFinalResponse — команда, которую CLI
// снимет сам вместе с финальным ответом и уведомления о которой не будет:
// держать ради неё вкладку в «Работают» нельзя.
function launchedTaskId(toolName, toolResponse) {
  if (!toolResponse || typeof toolResponse !== 'object') return null;
  if (SHELL_TOOLS.has(toolName)) {
    if (toolResponse.backgroundEndsWithFinalResponse === true) return null;
    return isId(toolResponse.backgroundTaskId) ? { id: toolResponse.backgroundTaskId, kind: 'shell' } : null;
  }
  if (toolName === 'Agent') {
    // Синхронный агент ход ждёт сам — фоном он не становится.
    if (toolResponse.isAsync !== true) return null;
    return isId(toolResponse.agentId) ? { id: toolResponse.agentId, kind: 'agent' } : null;
  }
  if (toolName === 'SendMessage') {
    // Возобновлённый агент снова работает в фоне под тем же id.
    return isId(toolResponse.resumedAgentId) ? { id: toolResponse.resumedAgentId, kind: 'agent' } : null;
  }
  if (toolName === 'Workflow') {
    // Workflow всегда фоновый. taskId — ключ задачи в реестре CLI (бинарь
    // 2.1.318: тот же id уходит в запуск задачи, и по нему же CLI сам ведёт
    // живой воркфлоу при восстановлении). Ответ с error — сценарий не
    // скомпилировался, задачи нет; taskType 'remote_agent' — запуск в
    // облаке, не здесь. Операция над уже идущим прогоном отвечает с пустым
    // taskId — её отсекает проверка id ниже.
    if (toolResponse.taskType !== 'local_workflow') return null;
    if (typeof toolResponse.error === 'string') return null;
    return isId(toolResponse.taskId) ? { id: toolResponse.taskId, kind: 'workflow' } : null;
  }
  return null;
}

// Ход, который CLI начал сам — с уведомлением о конце фоновой задачи, — а не
// новый промпт человека. Такой prompt начинается с тега (журналы 05.11:
// 388 из 388); тег посреди текста — это человек, который о нём спрашивает.
function isTaskNotification(prompt) {
  return typeof prompt === 'string' && /^\s*<task-notification>/.test(prompt);
}

// Сверка журнала запусков со списком Stop: Map<id, kind> только живых.
// null — CLI поля не прислал (старая версия): знать нечем, и вызывающий
// ведёт себя как до фичи. Угадывать по журналу здесь хуже, чем молчать, —
// см. шапку про уведомления посреди хода.
function liveBackground(known, backgroundTasks) {
  if (!Array.isArray(backgroundTasks)) return null;
  const liveIds = new Set();
  for (const t of backgroundTasks) {
    if (t && isId(t.id)) liveIds.add(t.id);
  }
  const live = new Map();
  for (const [id, kind] of known) {
    if (liveIds.has(id)) live.set(id, kind);
  }
  return live;
}

// Русская множественность: 1, 21, 101 — «одна»; 2–4, 22–24 — «несколько»;
// 0, 5–20, 11–14 в любом разряде — «много».
function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

// Подпись строки сайдбара: 'фон · 1 команда', 'фон · 2 команды, 1 агент'.
// «workflow» не склоняем: владелец зовёт инструмент по имени.
function backgroundSubtitle(bg) {
  let shells = 0;
  let agents = 0;
  let workflows = 0;
  for (const kind of bg.values()) {
    if (kind === 'agent') agents += 1;
    else if (kind === 'workflow') workflows += 1;
    else shells += 1;
  }
  const parts = [];
  if (shells) parts.push(`${shells} ${plural(shells, 'команда', 'команды', 'команд')}`);
  if (agents) parts.push(`${agents} ${plural(agents, 'агент', 'агента', 'агентов')}`);
  if (workflows) parts.push(`${workflows} workflow`);
  return parts.length ? `фон · ${parts.join(', ')}` : '';
}

module.exports = {
  launchedTaskId, liveBackground, backgroundSubtitle, isTaskNotification,
};
