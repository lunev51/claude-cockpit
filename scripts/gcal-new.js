'use strict';
// «Какие у меня новые события?» — показывает АВТО-созданные из Telegram
// встречи из журнала и сразу ОЧИЩАЕТ журнал (как сводка входящих SMS):
// спросил → озвучили и стёрли. Для терминальной Юки.
//   node gcal-new.js

const core = require('./gcal-core');

const RU_WD = ['воскресенье', 'понедельник', 'вторник', 'среда',
  'четверг', 'пятница', 'суббота'];

// День недели даём ГОТОВЫМ — иначе haiku вычисляет его сама и ошибается
// (напр. 15.06.2026 — понедельник, а она говорила «воскресенье»).
function whenStr(localIso) {
  const m = String(localIso).match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return String(localIso);
  const wd = RU_WD[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()];
  return `${wd}, ${m[3]}.${m[2]}, ${m[4]}:${m[5]}`;
}

function main() {
  const fresh = core.takeNewJournal();
  if (!fresh.length) { console.log('Новых событий нет.'); return; }
  console.log(`Новых событий: ${fresh.length}`);
  for (const e of fresh) {
    const who = e.attendee ? ` (с ${e.attendee})` : '';
    const src = e.source === 'telegram' ? ' [согласовано через Telegram]' : '';
    console.log(`- ${whenStr(e.start)} — ${e.title}${who}${src}`);
  }
}

try { main(); } catch (e) { console.error('✗ Ошибка:', e.message); process.exit(1); }
