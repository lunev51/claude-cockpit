'use strict';
// Создать событие в Google Calendar (для терминальной Юки).
//
// Использование:
//   node gcal-create.js "<заголовок>" "<начало>" [<минут> | "<конец>"] [опции]
//   начало/конец: YYYY-MM-DD HH:MM   (в твоём поясе из правил)
//   если 3-й аргумент число — это длительность в минутах;
//   если не указан — берётся длительность_по_умолчанию из правил.
// Опции:
//   --desc "текст"        описание события
//   --attendee email      добавить гостя (пришлёт приглашение)
//   --force               создать вопреки правилам (окна/буфер/срок)
//
// Вывод: «✓ Создано: …» при успехе, «✗ Не создано: причина» при отказе.

const core = require('./gcal-core');

function parseArgs(argv) {
  const pos = [];
  const opt = { attendees: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') opt.force = true;
    else if (a === '--desc') opt.desc = argv[++i];
    else if (a === '--attendee') opt.attendees.push(argv[++i]);
    else if (a === '--input-tz') opt.inputTz = argv[++i]; // пояс, в котором заданы start/end
    else if (a === '--source') opt.source = argv[++i];     // 'telegram' → в журнал авто-встреч
    else if (a === '--notify') opt.notify = true;          // прислать 📅 в Избранное
    else if (a === '--skip-window') opt.skipWindow = true; // не проверять рабочие окна (юзер задал свой промежуток)
    else pos.push(a);
  }
  return { pos, opt };
}

function fieldsFromMs(localMs) {
  const d = new Date(localMs);
  return {
    y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(),
    h: d.getUTCHours(), mi: d.getUTCMinutes(),
  };
}
function addMinutesLocal(start, minutes, tz) {
  const ms = core.zonedToUtcMs(start.y, start.mo, start.d, start.h, start.mi, tz) + minutes * 60000;
  return fieldsFromMs(ms + core.tzOffsetMs(ms, tz));
}
// Перевести «настенное» время из пояса fromTz в пояс toTz (для согласования
// с собеседником в другом часовом поясе → события всегда в поясе пользователя).
function convertTz(fields, fromTz, toTz) {
  const utc = core.zonedToUtcMs(fields.y, fields.mo, fields.d, fields.h, fields.mi, fromTz);
  return fieldsFromMs(utc + core.tzOffsetMs(utc, toTz));
}

async function main() {
  const { pos, opt } = parseArgs(process.argv.slice(2));
  if (pos.length < 2) {
    console.error('Использование: gcal-create.js "<заголовок>" "<YYYY-MM-DD HH:MM>" [минут | "<конец>"] [--desc ..] [--attendee email] [--force]');
    process.exit(2);
  }
  const rules = core.loadRules();
  const tz = rules.timezone;
  const title = pos[0];
  let start = core.parseLocal(pos[1]);

  let end;
  if (pos[2] != null && /^\d+$/.test(pos[2])) {
    // длительность: переводим начало в твой пояс, дальше считаем от него
    if (opt.inputTz && opt.inputTz !== tz) start = convertTz(start, opt.inputTz, tz);
    end = addMinutesLocal(start, +pos[2], tz);
  } else if (pos[2] != null) {
    end = core.parseLocal(pos[2]);
    if (opt.inputTz && opt.inputTz !== tz) {
      start = convertTz(start, opt.inputTz, tz);
      end = convertTz(end, opt.inputTz, tz);
    }
  } else {
    if (opt.inputTz && opt.inputTz !== tz) start = convertTz(start, opt.inputTz, tz);
    end = addMinutesLocal(start, rules.defaultDuration, tz);
  }

  if (!opt.force) {
    const buf = core.eventBuffer(title, rules); // встреча → 30, созвон → 15
    const v = await core.validateEvent(start, end, rules, { skipWindow: !!opt.skipWindow, buffer: buf });
    if (!v.ok) { console.error('✗ Не создано:', v.reason); process.exit(1); }
  }

  const ev = await core.createEvent({
    title, start, end, timeZone: tz,
    description: opt.desc, attendees: opt.attendees,
  });

  const fmt = (p) => `${core.pad(p.d)}.${core.pad(p.mo)} ${core.pad(p.h)}:${core.pad(p.mi)}`;
  const when = `${fmt(start)}–${core.pad(end.h)}:${core.pad(end.mi)}`;

  // Авто-созданные из Telegram — в журнал «новых событий».
  if (opt.source) {
    core.appendJournal({
      id: ev && ev.id, title, start: core.localIso(start), end: core.localIso(end),
      tz, source: opt.source, attendee: opt.attendees[0] || '',
    });
  }
  // Мгновенное уведомление в Избранное (маркер 📅 — слушатель его игнорирует).
  if (opt.notify) {
    await core.notifySaved(`📅 Поставила в календарь: «${title}» — ${when} (${tz}).`);
  }

  console.log(`✓ Создано: «${title}» — ${when} (${tz})`);
  if (opt.attendees.length) console.log(`  гость: ${opt.attendees.join(', ')} (приглашение отправлено)`);
  if (ev && ev.htmlLink) console.log('  ' + ev.htmlLink);
  if (ev && ev.id) console.log('  id: ' + ev.id);
}

main().catch((e) => { console.error('✗ Ошибка:', e.message); process.exit(1); });
