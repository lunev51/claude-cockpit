'use strict';
// Свободные ИНТЕРВАЛЫ для встреч с учётом правил (рабочие окна, буфер между
// встречами, чёрные даты, мин. срок, горизонт). Использует freeBusy (только
// занято/свободно — без названий событий).
//
//   node gcal-slots.js [--days 7] [--duration 30] [--from YYYY-MM-DD] [--json]
// Без --json: человеческий список по дням. С --json для tg_listen:
//   { timezone, today, autoEnabled, autoOnly, durationMin, ranges:[{date,start,end}] }
// Интервал [start,end] — непрерывно свободное время; встреча длительностью
// durationMin должна целиком в него помещаться (последний старт = end − dur).

const core = require('./gcal-core');

function parseArgs(argv) {
  const o = { days: 7, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--days') o.days = +argv[++i] || 7;
    else if (a === '--duration') o.duration = +argv[++i];
    else if (a === '--from') o.from = argv[++i];
    else if (a === '--type') o.type = argv[++i]; // call | meeting (буфер)
  }
  return o;
}

function dateFields(ms, tz) {
  const d = new Date(ms + core.tzOffsetMs(ms, tz));
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate() };
}
function localHM(ms, tz) {
  const d = new Date(ms + core.tzOffsetMs(ms, tz));
  return `${core.pad(d.getUTCHours())}:${core.pad(d.getUTCMinutes())}`;
}
// Вычесть busy-блоки [bs,be] из [lo,hi] → массив свободных [s,e].
function subtract(lo, hi, blocks) {
  let free = [[lo, hi]];
  for (const [bs, be] of blocks) {
    const next = [];
    for (const [s, e] of free) {
      if (be <= s || bs >= e) { next.push([s, e]); continue; }
      if (bs > s) next.push([s, Math.min(bs, e)]);
      if (be < e) next.push([Math.max(be, s), e]);
    }
    free = next;
  }
  return free;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const rules = core.loadRules();
  const tz = rules.timezone;
  const dur = o.duration || rules.defaultDuration;
  const now = Date.now();

  let base;
  if (o.from && /^\d{4}-\d{2}-\d{2}$/.test(o.from)) {
    const m = o.from.split('-'); base = { y: +m[0], mo: +m[1], d: +m[2] };
  } else base = dateFields(now, tz);

  const rangeStartMs = core.zonedToUtcMs(base.y, base.mo, base.d, 0, 0, tz);
  const rangeEndMs = rangeStartMs + (o.days + 1) * 86400000;
  const busy = await core.freeBusy(
    new Date(rangeStartMs).toISOString(), new Date(rangeEndMs).toISOString());

  const durMs = dur * 60000;
  // Буфер по типу: встреча → bufferMeeting (30), созвон → bufferCall (15, по умолч.).
  const buf = o.type === 'meeting' ? rules.bufferMeeting : rules.bufferCall;
  const bufMs = buf * 60000;
  const blocks = busy.map((b) => [b.startMs - bufMs, b.endMs + bufMs]);

  const ranges = [];
  for (let i = 0; i < o.days; i++) {
    const dd = new Date(Date.UTC(base.y, base.mo - 1, base.d + i));
    const y = dd.getUTCFullYear(), mo = dd.getUTCMonth() + 1, da = dd.getUTCDate();
    const wd = dd.getUTCDay();
    const dateStr = `${y}-${core.pad(mo)}-${core.pad(da)}`;
    if (rules.blackout.has(dateStr)) continue;
    for (const [ws, we] of (rules.windows[wd] || [])) {
      const wStart = core.zonedToUtcMs(y, mo, da, Math.floor(ws / 60), ws % 60, tz);
      const wEnd = core.zonedToUtcMs(y, mo, da, Math.floor(we / 60), we % 60, tz);
      const lo = Math.max(wStart, now + rules.minNotice * 60000);
      const hi = Math.min(wEnd, now + rules.horizonDays * 86400000);
      if (hi - lo < durMs) continue;
      for (const [fs, fe] of subtract(lo, hi, blocks)) {
        if (fe - fs >= durMs) {
          ranges.push({ date: dateStr, start: localHM(fs, tz), end: localHM(fe, tz) });
        }
      }
    }
  }

  if (o.json) {
    const tf = dateFields(now, tz);
    process.stdout.write(JSON.stringify({
      timezone: tz, today: `${tf.y}-${core.pad(tf.mo)}-${core.pad(tf.d)}`,
      autoEnabled: rules.autoEnabled, autoOnly: rules.autoOnly,
      durationMin: dur, ranges,
    }));
    return;
  }
  if (!ranges.length) { console.log('Свободных интервалов нет (в рамках правил и окон).'); return; }
  const wf = new Intl.DateTimeFormat('ru-RU', { timeZone: tz, weekday: 'short', day: '2-digit', month: '2-digit' });
  const byDay = {}, order = [];
  for (const r of ranges) {
    if (!byDay[r.date]) { byDay[r.date] = []; order.push(r.date); }
    byDay[r.date].push(`${r.start}–${r.end}`);
  }
  console.log(`Свободно (встреча ${dur} мин, пояс ${tz}):`);
  for (const d of order) {
    const [yy, mm, dd] = d.split('-').map(Number);
    const lbl = wf.format(new Date(core.zonedToUtcMs(yy, mm, dd, 12, 0, tz)));
    console.log(`- ${lbl}: ${byDay[d].join(', ')}`);
  }
}

main().catch((e) => { console.error('✗ Ошибка:', e.message); process.exit(1); });
