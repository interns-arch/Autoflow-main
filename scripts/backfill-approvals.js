#!/usr/bin/env node
'use strict';
// REBUILD THE APPROVAL LOG FROM THE CHAT LOG — every account, discount, order
// and payment request the bot sent to a Sales Head / the accountant, and every
// decision on it, with the original times. core/approvalLog only began on
// 25 Sep; the dashboard and the 6 pm report read it, so what came before is
// recovered here from the messages themselves. Lines already in the log are
// not written twice.
//
//   node scripts/backfill-approvals.js          # report what would be added
//   node scripts/backfill-approvals.js --write  # and add it
const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const log = require('../src/core/approvalLog');
const unformat = require('../src/core/waText').unformat;

const write = process.argv.includes('--write');
const approvers = { ...(config.creation.approvers || {}), ...((config.payments && config.payments.accountants) || {}) };

const rows = fs
  .readFileSync(path.join(config.sharedDir, 'chats.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch (_) {
      return null;
    }
  })
  .filter(Boolean);

const have = new Set(log.between('2000-01-01', '2100-01-01').map((e) => e.kind + ':' + e.id + ':' + e.event));
const kindOf = (id) => (id.startsWith('WA-') ? 'account' : id.startsWith('DSC-') ? 'discount' : id.startsWith('PAY-') ? 'payment' : 'order');
const field = (t, k) => {
  const m = t.match(new RegExp('^' + k + ':\\s*(.+)$', 'mi'));
  return m ? m[1].trim() : null;
};
const out = [];
const seenReq = new Set();

for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  const t = String(r.text || '');
  // A request, as sent to an approver.
  if (r.dir === 'out' && approvers[r.phone]) {
    const m = t.match(/^\*(Discount rule|Discount change|Order approval|New customer|Payment check)\* — ((?:WA|DSC|ORD|PAY)-[A-Z0-9]+)/);
    if (m && !seenReq.has(m[2])) {
      seenReq.add(m[2]);
      const id = m[2];
      const k = kindOf(id);
      const e = { at: r.at, kind: k, id, event: 'requested' };
      if (k === 'account') {
        Object.assign(e, {
          by: field(t, 'Bheja') || field(t, 'Opened by'),
          customer: field(t, 'Firm'),
          phone: field(t, 'Mobile'),
          gst: field(t, 'GSTIN'),
          businessType: field(t, 'Business type'),
          contactPerson: field(t, 'Contact'),
          email: field(t, 'Email'),
          address: [field(t, 'Address'), field(t, 'City'), field(t, 'State'), field(t, 'PIN')].filter(Boolean).join(', '),
          dob: field(t, 'Owner DOB'),
          bank: field(t, 'Bank'),
        });
      } else if (k === 'discount') {
        e.customer = (field(t, 'Customer') || '').replace(/\s*\(\+\d+\)$/, '');
        e.by = field(t, 'Asked by');
        e.detail =
          m[1] === 'Discount change'
            ? `change ${field(t, 'Current discount')} → ${field(t, 'Customer wants')}`.replace(/\*/g, '')
            : (t.split('\n')[2] || '').trim();
      } else if (k === 'order') {
        e.customer = (field(t, 'Customer') || '').replace(/\s*\(\+\d+\)$/, '').replace('[object Object]', '') || null;
        e.by = field(t, 'Requested by') || 'customer (' + ((t.match(/\(\+(\d+)\)/) || [])[1] || '') + ')';
        e.detail = (t.match(/^\d+\./gm) || []).length + ' line(s)';
      } else {
        e.customer = (field(t, 'Customer') || '').replace(/\s*\(\+\d+\)$/, '');
        e.detail = 'due ' + (field(t, 'Due on the portal') || '').replace(/\*/g, '');
      }
      out.push(e);
    }
  }
  // A decision, from an approver, and what the bot answered.
  if (r.dir === 'in' && approvers[r.phone]) {
    const m = unformat(t).match(/^(ok|yes|haan|approve|received|mila|no|nahi|reject)\s+((?:WA|DSC|ORD|PAY)-[A-Z0-9]+)/i);
    if (!m) continue;
    const id = m[2].toUpperCase();
    const k = kindOf(id);
    const who = approvers[r.phone];
    const reply = rows.slice(i + 1, i + 10).find((x) => x.dir === 'out' && x.phone === r.phone);
    const rt = String((reply && reply.text) || '');
    let ev = null;
    let detail = null;
    const extra = {};
    if (/^Rejected|reject kar diya/i.test(rt)) ev = 'rejected';
    else if (k === 'order' && /^Placed — /.test(rt)) {
      ev = 'approved';
      detail = 'portal order ' + ((rt.match(/portal order (\S+?)\./) || [])[1] || '');
    } else if (k === 'order' && /portal (blocked|did not|ne )/i.test(rt)) {
      ev = 'failed';
      detail = rt.slice(0, 120);
    } else if (k === 'discount' && /^Done — |^Approved\./.test(rt)) {
      ev = 'approved';
      detail = rt.replace(/^Done — /, '').replace(/\.$/, '');
    } else if (k === 'account' && /^Done — /.test(rt)) {
      ev = 'approved';
      const um = rt.match(/\(([a-z0-9_]+)\)/);
      const om = rt.match(/partner (\d+)/);
      const nm = rt.match(/^Done — (.+?) is open \(/);
      Object.assign(extra, { username: um && um[1], odooPartner: om ? Number(om[1]) : null, customer: nm ? nm[1].trim() : undefined });
    } else if (k === 'payment' && /^Settled/i.test(rt)) ev = 'settled';
    if (!ev) continue;
    const req = out.find((e) => e.id === id && e.event === 'requested') || {};
    const carry = k === 'account' ? ['customer', 'phone', 'gst', 'businessType', 'contactPerson', 'email', 'address', 'dob', 'bank'] : ['customer'];
    for (const f of carry) if (req[f] && !extra[f]) extra[f] = req[f];
    if (extra.customer === undefined) delete extra.customer;
    out.push({ at: r.at, kind: k, id, event: ev, by: who, detail, ...extra });
  }
}

// Accounts opened before the "New customer — WA-…" summary existed: the
// approver's "Done — X is open (login)" is all there is.
for (const r of rows) {
  if (r.dir !== 'out' || !approvers[r.phone]) continue;
  const m = String(r.text || '').match(/^Done — (.+?) is open \(([a-z0-9_]+)\)/);
  if (!m) continue;
  const already = out.some((e) => e.kind === 'account' && e.event === 'approved' && e.customer === m[1]);
  if (already) continue;
  const id = 'WA-OLD-' + m[2].toUpperCase().slice(0, 20);
  out.push({ at: r.at, kind: 'account', id, event: 'approved', by: approvers[r.phone], customer: m[1], username: m[2] });
}

let n = 0;
for (const e of out) {
  if (have.has(e.kind + ':' + e.id + ':' + e.event)) continue;
  n++;
  console.log(e.at.slice(0, 16), e.kind.padEnd(8), e.id.padEnd(14), e.event.padEnd(9), (e.customer || '').slice(0, 28).padEnd(28), e.by || '');
  if (write) fs.appendFileSync(log.file(), JSON.stringify(e) + '\n');
}
console.log(`\n${n} event(s) ${write ? 'added' : 'to add (run with --write)'}`);
