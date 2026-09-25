'use strict';
// THE 6 PM REPORT, as a CSV, to the Sales Heads (founder, 25 Sep).
//
// One file, three sections:
//   1. Customers created today — who they are, who opened the account, who
//      approved it, and its Odoo partner.
//   2. Sales today — every order the bot placed on the portal: customer,
//      portal order number, lines, amount, and who approved it.
//   3. Approvals today — every request (account, discount, order) and what
//      happened to it, including the ones still waiting.
// The caption carries the counts, so the day can be read without opening it.
const config = require('../config');
const store = require('../store');
const approvalLog = require('./approvalLog');

// Today in the bot's timezone (Asia/Kolkata): [start, end) as Dates, and the
// date as YYYY-MM-DD.
function today(now = new Date()) {
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: config.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const offset = config.tz === 'Asia/Kolkata' ? '+05:30' : 'Z';
  const start = new Date(`${ymd}T00:00:00${offset}`);
  return { ymd, start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

const time = (iso) =>
  iso ? new Intl.DateTimeFormat('en-IN', { timeZone: config.tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)) : '';

function cell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
const row = (cols) => cols.map(cell).join(',');

// The orders the bot placed on the portal today.
function salesToday(start, end) {
  const a = start.getTime();
  const b = end.getTime();
  return store
    .orders()
    .filter((o) => o.status === 'confirmed' && o.confirmedAt && new Date(o.confirmedAt).getTime() >= a && new Date(o.confirmedAt).getTime() < b)
    .map((o) => {
      const punched = (o.lines || [])
        .filter((l) => l.source !== 'unidentified' && l.source !== 'unknown' && l.source !== 'unavailable' && (Number(l.available) || 0) > 0)
        .map((l) => ({ partNo: l.partNo || l.item, qty: Math.min(Number(l.qty) || 0, Number(l.available) || 0), rate: Number(l.rate) || Number(l.mrp) || 0, discount: Number(l.discountPercent) || 0 }));
      const pc = o.portalCustomer || (typeof o.customer === 'object' ? o.customer : null) || {};
      return {
        at: o.confirmedAt,
        id: o.id,
        portalOrders: (o.placed || []).map((p) => p.soNumber).filter(Boolean).join(' / ') || o.soNumber || '',
        customer: pc.name || (typeof o.customer === 'string' ? o.customer : '') || '',
        phone: String(o.chatId || '').split('@')[0],
        lines: punched,
        qty: punched.reduce((s, l) => s + l.qty, 0),
        amount: Math.round(punched.reduce((s, l) => s + l.qty * l.rate, 0) * 100) / 100,
        approvedBy: o.approvedBy || '',
      };
    });
}

function build(now = new Date()) {
  const { ymd, start, end } = today(now);
  const events = approvalLog.between(start, end);
  // Who asked for each account: its 'requested' line (the form's opener, or
  // the customer themselves). Looked back a week, for a form filed yesterday.
  const asked = new Map();
  for (const e of approvalLog.between(new Date(start.getTime() - 7 * 24 * 60 * 60 * 1000), end)) {
    if (e.kind === 'account' && e.event === 'requested') asked.set(e.id, e.by);
  }
  const created = events.filter((e) => e.kind === 'account' && e.event === 'approved');
  const sales = salesToday(start, end);

  // Where each request stands at the end of the day: its last event.
  const last = new Map();
  for (const e of events) last.set(e.kind + ':' + e.id, e);
  const pending = [...last.values()].filter((e) => e.event === 'requested');
  const count = (kind, event) => events.filter((e) => e.kind === kind && e.event === event).length;

  const lines = [];
  lines.push(row([`Cartrends daily report — ${ymd}`]));
  lines.push('');
  lines.push(row(['1. CUSTOMERS CREATED TODAY', created.length]));
  lines.push(
    row(['Time', 'Request', 'Customer', 'WhatsApp', 'GSTIN', 'Business type', 'Contact person', 'Contact phone', 'Email', 'Address', 'Owner DOB', 'Bank', 'Location', 'Portal login', 'Odoo partner', 'Opened by', 'Approved by']),
  );
  for (const e of created) {
    lines.push(
      row([time(e.at), e.id, e.customer, e.phone, e.gst, e.businessType, e.contactPerson, e.contactPhone, e.email, e.address, e.dob, e.bank, e.location, e.username, e.odooPartner, e.openedBy || asked.get(e.id) || e.openedFor, e.by]),
    );
  }
  lines.push('');
  const total = Math.round(sales.reduce((s, o) => s + o.amount, 0) * 100) / 100;
  lines.push(row(['2. SALES TODAY', `${sales.length} order(s)`, `Rs ${total}`]));
  lines.push(row(['Time', 'Order', 'Portal order', 'Customer', 'WhatsApp', 'Parts (part x qty @ rate)', 'Total qty', 'Amount (Rs, incl. GST)', 'Approved by']));
  for (const o of sales) {
    lines.push(
      row([
        time(o.at),
        o.id,
        o.portalOrders,
        o.customer,
        o.phone,
        o.lines.map((l) => `${l.partNo} x${l.qty} @ ${l.rate}${l.discount ? ` (${l.discount}% off)` : ''}`).join('; '),
        o.qty,
        o.amount,
        o.approvedBy,
      ]),
    );
  }
  lines.push('');
  lines.push(row(['3. APPROVALS TODAY', events.length ? `${events.length} event(s)` : 'none']));
  lines.push(row(['Time', 'Type', 'Request', 'Event', 'Customer', 'Details', 'By']));
  for (const e of events) {
    const detail = e.kind === 'account' ? [e.gst, e.businessType].filter(Boolean).join(' · ') : e.detail || (e.amount ? 'Rs ' + e.amount : '');
    lines.push(row([time(e.at), e.kind, e.id, e.event, e.customer, detail, e.by]));
  }
  if (pending.length) {
    lines.push('');
    lines.push(row(['STILL WAITING FOR A DECISION', pending.length]));
    for (const e of pending) lines.push(row([time(e.at), e.kind, e.id, 'waiting', e.customer, e.detail || '', e.by]));
  }

  const summary = [
    `📊 *Daily report — ${ymd}*`,
    `Customers created: ${created.length}` + (count('account', 'rejected') ? ` (rejected ${count('account', 'rejected')})` : ''),
    `Orders placed: ${sales.length} — Rs ${total.toLocaleString('en-IN')}`,
    `Discounts approved: ${count('discount', 'approved')}` + (count('discount', 'rejected') ? `, rejected ${count('discount', 'rejected')}` : ''),
    `Orders approved: ${count('order', 'approved')}` + (count('order', 'rejected') ? `, rejected ${count('order', 'rejected')}` : '') + (count('order', 'failed') ? `, refused by the portal ${count('order', 'failed')}` : ''),
    pending.length ? `Still waiting: ${pending.length}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  // With a byte-order mark, so Excel opens the ₹ and the names correctly.
  return { ymd, csv: '﻿' + lines.join('\r\n') + '\r\n', summary, created, sales, events, pending };
}

// To every Sales Head. The report goes as a document; if a phone cannot be
// sent a document, it gets the summary as text.
async function send(bot, now = new Date()) {
  const escalation = require('./escalation');
  const r = build(now);
  const filename = `Cartrends-daily-report-${r.ymd}.csv`;
  let sent = 0;
  for (const phone of Object.keys(config.creation.approvers || {})) {
    try {
      // Outside the 24h window a message is silently dropped.
      await escalation.ensureWindow(bot.transport, phone, 'Daily report — file follows');
      if (bot.transport.sendDocument) {
        // WhatsApp takes a CSV as text/plain; the .csv name opens it in Excel.
        await bot.transport.sendDocument(phone, Buffer.from(r.csv, 'utf8'), filename, 'text/plain', r.summary);
      } else {
        await bot.transport.sendText(phone, r.summary);
      }
      sent++;
    } catch (e) {
      store.log('report', `daily report to ${phone} failed: ${String((e && e.message) || e).slice(0, 120)} — sending the summary as text`);
      try {
        await bot.transport.sendText(phone, r.summary);
        sent++;
      } catch (_) {
        /* logged above */
      }
    }
  }
  store.log('report', `daily report ${r.ymd} sent to ${sent} Sales Head(s): ${r.created.length} customer(s), ${r.sales.length} order(s), ${r.events.length} approval event(s)`);
  return { ...r, sent };
}

module.exports = { build, send, today };
