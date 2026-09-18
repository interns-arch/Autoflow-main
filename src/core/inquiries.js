'use strict';
// Inquiry / sale-loss log — the founder's "purchase intelligence":
//
//   "jitni inquiry mere paas aa rahi hai, jitno ko main mana kar raha hoon,
//    vo store honi chahiye purchase wale ke paas ... mere paas AC gas ki
//    inquiry pichhle 15 din se regular aa rahi hai, lekin aaj bhi ye log AC
//    gas nahi laaye ... vo sale loss ho rahi hai meri, vo opportunity loss."
//
// EVERY inquiry is recorded, and every NA is flagged. The repeat count across
// customers is the signal that decides what purchase should start stocking.
// This is the data that does not exist anywhere else in the company today.
const store = require('../store');

function bucket() {
  const s = store.load();
  if (!s.inquiries) s.inquiries = [];
  return s.inquiries;
}

function keyFor(item, partNo) {
  return String(partNo || item || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '');
}

// Record one requested line and how we answered it.
//   outcome: 'available' | 'partial' | 'na' | 'unknown'
function record({ item, partNo, qty, customer, chatId, outcome, available }) {
  const row = {
    id: 'INQ-' + store.nextSeq('inquiry'),
    key: keyFor(item, partNo),
    item: String(item || '').trim(),
    partNo: partNo || null,
    qty: Number(qty) || 1,
    customer: store.normPhone(customer) || null,
    chatId: chatId || null,
    outcome: outcome || 'unknown',
    available: Number(available) || 0,
    at: new Date().toISOString(),
  };
  bucket().push(row);
  const all = bucket();
  // Two caps, because one is not enough. 5,000 rows keeps the file from ever
  // growing without bound; 90 days keeps it from holding a year of questions
  // nobody will ever look at. What must survive forever is not this — it is
  // core/knowledge.js, the answers a human gave, so the same question is never
  // escalated twice.
  const KEEP_DAYS = 90;
  const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  let dropped = 0;
  while (all.length && new Date(all[0].at || 0).getTime() < cutoff) {
    all.shift();
    dropped++;
  }
  if (all.length > 5000) all.splice(0, all.length - 5000);
  store.save();
  if (outcome === 'na') {
    store.log('inquiry', `SALE LOSS: "${row.item}" x${row.qty} for ${row.customer || 'customer'} — not available`);
  }
  return row;
}

function recordMany(lines, { customer, chatId }) {
  return (lines || []).map((l) =>
    record({
      item: l.requested || l.item,
      partNo: l.partNo,
      qty: l.qty,
      customer,
      chatId,
      outcome:
        l.source === 'unavailable' ? 'na' : l.source === 'unknown' ? 'unknown' : l.partial ? 'partial' : 'available',
      available: l.available,
    })
  );
}

// Everything we said no to, grouped by part, most-demanded first.
// `sinceDays` defaults to 30 — the window the founder reviews.
function lostSales(sinceDays = 30) {
  const cutoff = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
  const grouped = new Map();
  for (const row of bucket()) {
    if (row.outcome !== 'na' && row.outcome !== 'partial') continue;
    if (new Date(row.at).getTime() < cutoff) continue;
    const g = grouped.get(row.key) || {
      key: row.key,
      item: row.item,
      partNo: row.partNo,
      requests: 0,
      totalQty: 0,
      customers: new Set(),
      lastAt: row.at,
    };
    g.requests += 1;
    g.totalQty += row.qty;
    if (row.customer) g.customers.add(row.customer);
    if (row.at > g.lastAt) g.lastAt = row.at;
    grouped.set(row.key, g);
  }
  return [...grouped.values()]
    .map((g) => ({ ...g, customers: g.customers.size }))
    .sort((a, b) => b.customers - a.customers || b.requests - a.requests);
}

// WhatsApp-ready report for the daily admin push.
function lostSalesMessage(sinceDays = 1, limit = 15) {
  const rows = lostSales(sinceDays).slice(0, limit);
  if (!rows.length) return `📉 *Sale loss (last ${sinceDays}d):* none — everything asked for was available.`;
  const lines = rows.map(
    (r, i) =>
      `${i + 1}. ${r.item}${r.partNo && r.partNo !== r.item ? ` (${r.partNo})` : ''} — ` +
      `${r.requests} request(s), ${r.customers} customer(s), qty ${r.totalQty}`
  );
  return (
    `📉 *Sale loss — what we said NO to (last ${sinceDays}d)*\n` +
    lines.join('\n') +
    `\n\nRepeat demand here is what purchase should stock next.`
  );
}

function recent(limit = 100) {
  return [...bucket()].reverse().slice(0, limit);
}

module.exports = { record, recordMany, lostSales, lostSalesMessage, recent };
