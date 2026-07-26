'use strict';
// Удалить событие из Google Calendar по id (для терминальной Юки).
//   node gcal-delete.js <eventId>
// id берётся из вывода gcal-create.js или gcal-list.js.

const core = require('./gcal-core');

async function main() {
  const id = process.argv[2];
  if (!id) { console.error('Использование: gcal-delete.js <eventId>'); process.exit(2); }
  await core.api('DELETE', `/calendars/primary/events/${encodeURIComponent(id)}`);
  console.log(`✓ Удалено событие ${id}`);
}

main().catch((e) => { console.error('✗ Ошибка:', e.message); process.exit(1); });
