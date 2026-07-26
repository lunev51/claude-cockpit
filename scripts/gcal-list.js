'use strict';
// Список ближайших событий из Google Calendar (для терминальной Юки).
//
// Использование:
//   node gcal-list.js [дней]      по умолчанию 7 дней вперёд от «сейчас»
//   node gcal-list.js today       только сегодня
//   node gcal-list.js tomorrow    только завтра
//
// Вывод: строки «DD.MM HH:MM — Название», либо «Событий нет».

const core = require('./gcal-core');

function dayBounds(offsetDays, tz) {
  // Начало и конец календарного дня (offset от сегодня) в поясе tz → ISO UTC.
  const now = new Date();
  const localMs = now.getTime() + core.tzOffsetMs(now.getTime(), tz);
  const d = new Date(localMs);
  const y = d.getUTCFullYear(), mo = d.getUTCMonth() + 1, day = d.getUTCDate() + offsetDays;
  const startMs = core.zonedToUtcMs(y, mo, day, 0, 0, tz);
  const endMs = core.zonedToUtcMs(y, mo, day, 23, 59, tz) + 60000;
  return { from: new Date(startMs).toISOString(), to: new Date(endMs).toISOString() };
}

async function main() {
  const arg = (process.argv[2] || '').toLowerCase();
  const rules = core.loadRules();
  const tz = rules.timezone;

  let from, to;
  if (arg === 'today') ({ from, to } = dayBounds(0, tz));
  else if (arg === 'tomorrow') ({ from, to } = dayBounds(1, tz));
  else {
    const days = /^\d+$/.test(arg) ? +arg : 7;
    from = new Date().toISOString();
    to = new Date(Date.now() + days * 86400000).toISOString();
  }

  const events = await core.listEvents(from, to, 50);
  if (!events.length) { console.log('Событий нет.'); return; }

  const fmt = new Intl.DateTimeFormat('ru-RU', {
    timeZone: tz, weekday: 'short', day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
  console.log(`Событий: ${events.length} (пояс ${tz})`);
  for (const e of events) {
    const allDay = e.start && e.start.length === 10; // YYYY-MM-DD
    const when = allDay
      ? e.start + ' (весь день)'
      : fmt.format(new Date(e.start));
    const loc = e.location ? ` @ ${e.location}` : '';
    console.log(`- ${when} — ${e.title}${loc}`);
  }
}

main().catch((e) => { console.error('✗ Ошибка:', e.message); process.exit(1); });
