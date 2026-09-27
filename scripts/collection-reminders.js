#!/usr/bin/env node
'use strict';
// Who gets a payment reminder today (collection date in two days), and the
// message they would read. Sends nothing.
//
//   node scripts/collection-reminders.js            # today
//   node scripts/collection-reminders.js 2026-10-07 # as if run on that day
const { dueSoon, message } = require('../src/core/collectionReminders');

(async () => {
  const when = process.argv[2] ? new Date(process.argv[2] + 'T06:00:00+05:30') : new Date();
  const list = await dueSoon(when);
  const rs = (v) => '₹' + Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  console.log(`${list.length} customer(s) to remind (collection date ${list[0] ? list[0].collectDate : '—'})\n`);
  for (const r of list) {
    console.log(`• ${r.name} — ${r.phone || 'NO PHONE'} — ${rs(r.dueAmount)} (${r.invoices.map((i) => i.name + ' ' + i.date).join(', ')}; collection ${r.collectionDays} days)`);
  }
  if (list[0]) console.log('\n--- the message ---\n' + message(list[0], (en, hi) => hi));
  process.exit(0);
})().catch((e) => {
  console.log('ERR', e.message);
  process.exit(1);
});
