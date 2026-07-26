'use strict';
// Авто-очистка накопившихся транскриптов claude-сессий (запускается при старте
// companion). На каждом перезапуске создаётся новая сессия → они плодятся и
// раздувают /resume. Чистим по возрасту, РАЗДЕЛЬНО:
//   - основные сессии Юки (проект companion-home) — старше mainRetentionDays (7);
//   - память суб-агентов авто-ответов (проект tg-reply) — держим
//     replyRetentionDays (3) на человека, старше удаляем; чистим протухшие
//     записи в .tg-sessions.json (на кого транскрипта уже нет).
// Сами данные (события календаря, .tg.json, журналы) НЕ трогаем — только *.jsonl
// в папках проектов Claude Code (~/.claude/projects/<кодированный-cwd>/).

const fs = require('fs');
const os = require('os');
const path = require('path');

// cwd → имя папки проекта Claude Code (он заменяет : \ / на «-»).
function projectDirFor(cwd) {
  const enc = String(cwd).replace(/[:\\/]/g, '-');
  return path.join(os.homedir(), '.claude', 'projects', enc);
}

// Удалить *.jsonl старше maxAgeDays в каталоге. Возвращает число удалённых.
function sweepProject(dir, maxAgeDays) {
  let removed = 0;
  let files;
  try { files = fs.readdirSync(dir); } catch { return 0; }
  const cutoff = Date.now() - maxAgeDays * 86400000;
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    const fp = path.join(dir, f);
    try {
      if (fs.statSync(fp).mtimeMs < cutoff) { fs.unlinkSync(fp); removed++; }
    } catch { /* пропускаем недоступный файл */ }
  }
  return removed;
}

// Убрать из .tg-sessions.json записи, чьих транскриптов больше нет.
function pruneTgSessions(sessionsFile, tgReplyDir) {
  let map;
  try { map = JSON.parse(fs.readFileSync(sessionsFile, 'utf8')); } catch { return 0; }
  if (!map || typeof map !== 'object') return 0;
  let pruned = 0;
  for (const [chatId, sid] of Object.entries(map)) {
    if (!fs.existsSync(path.join(tgReplyDir, `${sid}.jsonl`))) {
      delete map[chatId]; pruned++;
    }
  }
  if (pruned) {
    try { fs.writeFileSync(sessionsFile, JSON.stringify(map, null, 2), 'utf8'); } catch { /* */ }
  }
  return pruned;
}

// cleanupSessions(getConfig): безопасно вызывать при старте (всё в try).
function cleanupSessions(getConfig) {
  try {
    const cfg = (getConfig && getConfig()) || {};
    const home = cfg.terminal && cfg.terminal.cwd;
    if (!home) return;
    const s = cfg.sessions || {};
    const mainDays = Number(s.mainRetentionDays) > 0 ? Number(s.mainRetentionDays) : 7;
    const replyDays = Number(s.replyRetentionDays) > 0 ? Number(s.replyRetentionDays) : 3;

    const tgReplyDir = projectDirFor(path.join(home, '..', 'tg-reply'));
    const m = sweepProject(projectDirFor(home), mainDays);
    const r = sweepProject(tgReplyDir, replyDays);
    const p = pruneTgSessions(path.join(home, '.tg-sessions.json'), tgReplyDir);

    console.log(`[session-cleanup] основных удалено: ${m} (>${mainDays}д), `
      + `суб-агентских: ${r} (>${replyDays}д), записей сессий очищено: ${p}`);
  } catch (err) {
    console.warn(`[session-cleanup] ошибка: ${err.message}`);
  }
}

module.exports = { cleanupSessions, sweepProject, pruneTgSessions, projectDirFor };
