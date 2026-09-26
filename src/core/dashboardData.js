'use strict';
// THE DASHBOARD'S DATA (founder, 26 Sep): customers created, orders placed,
// discounts and payments — who asked, who approved, where each one stands.
//
// Two sources: the approval log (every request to a Sales Head / the
// accountant and every decision, core/approvalLog, backfilled from the chat
// log by scripts/backfill-approvals.js) and the orders the bot keeps.
const store = require('../store');
const approvalLog = require('./approvalLog');

const phoneOf = (chatId) => String(chatId || '').split('@')[0];

// Who someone is, by number: a Sales Head, a sales-team agent, or a customer.
function whoIs(phone) {
  const config = require('../config');
  const p = store.normPhone(phone);
  if (!p) return null;
  const approver = (config.creation.approvers || {})[p];
  if (approver) return approver;
  const agent = (config.creation.team || {})[p];
  if (agent) return agent;
  if ((config.salesTeamNumbers || []).includes(p)) return 'Sales team ' + p;
  return null;
}

// Events grouped by request, in time order.
function grouped(events) {
  const by = new Map();
  for (const e of events) {
    const k = e.kind + ':' + e.id;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(e);
  }
  return by;
}

function customers(events) {
  const out = [];
  for (const [, list] of grouped(events.filter((e) => e.kind === 'account'))) {
    const req = list.find((e) => e.event === 'requested') || {};
    const last = list[list.length - 1];
    const done = list.find((e) => e.event === 'approved');
    const rej = list.find((e) => e.event === 'rejected');
    const facts = { ...req, ...(done || {}) };
    out.push({
      id: last.id,
      requestedAt: req.at || (done && done.at) || last.at,
      decidedAt: (done || rej || {}).at || null,
      status: done ? 'created' : rej ? 'rejected' : 'waiting for approval',
      customer: facts.customer || null,
      phone: facts.phone || null,
      gst: facts.gst || null,
      businessType: facts.businessType || null,
      contactPerson: facts.contactPerson || null,
      contactPhone: facts.contactPhone || null,
      email: facts.email || null,
      address: facts.address || null,
      dob: facts.dob || null,
      bank: facts.bank || null,
      location: facts.location || null,
      homeBranch:
        facts.homeBranch ||
        (facts.address ? require('./dataEntryRequests').branchName(require('./dataEntryRequests').branchFor({ address: facts.address })) : null),
      openedBy: facts.openedBy || req.by || null,
      approvedBy: done ? done.by : null,
      rejectedBy: rej ? rej.by : null,
      portalLogin: facts.username || null,
      odooPartner: facts.odooPartner || null,
      note: rej && rej.note ? rej.note : null,
    });
  }
  return out.sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt)));
}

function discounts(events) {
  const out = [];
  for (const [, list] of grouped(events.filter((e) => e.kind === 'discount'))) {
    const req = list.find((e) => e.event === 'requested') || {};
    const done = list.find((e) => e.event === 'approved');
    const rej = list.find((e) => e.event === 'rejected');
    out.push({
      id: list[0].id,
      requestedAt: req.at || list[0].at,
      decidedAt: (done || rej || {}).at || null,
      status: done ? 'approved' : rej ? 'rejected' : 'waiting for approval',
      customer: req.customer || (done && done.customer) || (rej && rej.customer) || null,
      asked: req.detail || null,
      result: (done && done.detail) || (rej && rej.detail) || null,
      createdBy: req.by || null,
      approvedBy: done ? done.by : null,
      rejectedBy: rej ? rej.by : null,
    });
  }
  return out.sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt)));
}

function payments(events) {
  const out = [];
  for (const [, list] of grouped(events.filter((e) => e.kind === 'payment'))) {
    const req = list.find((e) => e.event === 'requested') || {};
    const claim = list.find((e) => e.event === 'claimed');
    const settled = list.find((e) => e.event === 'settled');
    const last = list[list.length - 1];
    out.push({
      id: list[0].id,
      at: req.at || list[0].at,
      customer: req.customer || last.customer || null,
      due: req.amount || null,
      detail: req.detail || null,
      status: settled ? 'settled' : last.event === 'rejected' ? 'not received' : claim ? 'checking' : 'waiting for payment',
      checkedBy: list.filter((e) => e.event === 'approved' || e.event === 'rejected').map((e) => e.by).filter(Boolean).join(', ') || null,
      received: list.filter((e) => e.event === 'approved').map((e) => e.detail).filter(Boolean).join('; ') || null,
    });
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

function orders(events) {
  const logByOrder = grouped(events.filter((e) => e.kind === 'order'));
  const status = (o) =>
    ({ confirmed: 'placed', approval: 'waiting for approval', awaitingPayment: 'waiting for payment', rejected: 'rejected' })[o.status] || null;
  const out = [];
  for (const o of store.orders()) {
    const st = status(o);
    if (!st) continue; // drafts and carts nobody confirmed
    const log = logByOrder.get('order:' + o.id) || [];
    const req = log.find((e) => e.event === 'requested');
    const failed = log.find((e) => e.event === 'failed');
    const pc = o.portalCustomer || (typeof o.customer === 'object' ? o.customer : null) || {};
    const chatPhone = phoneOf(o.chatId);
    const agent = req && /sales team/i.test(req.by || '') ? String(req.by).replace(/\s*\(sales team\)\s*$/, '') : whoIs(chatPhone);
    const punched = (o.lines || []).filter((l) => l.source !== 'unidentified' && l.source !== 'unknown' && l.source !== 'unavailable' && (Number(l.available) || 0) > 0);
    const amount = punched.reduce((s, l) => s + (Number(l.rate) || Number(l.mrp) || 0) * Math.min(Number(l.qty) || 0, Number(l.available) || 0), 0);
    out.push({
      id: o.id,
      at: o.confirmedAt || o.approvalAskedAt || o.createdAt || null,
      status: failed && st !== 'placed' ? 'refused by portal' : st,
      customer: pc.name || (typeof o.customer === 'string' && !/@/.test(o.customer) ? o.customer : null),
      customerId: pc.buyerId || null,
      placedBy: agent ? agent + ' (agent)' : 'customer',
      approvedBy: o.approvedBy || null,
      rejectedBy: o.rejectedBy || null,
      portalOrder: (o.placed || []).map((p) => p.soNumber).filter(Boolean).join(' / ') || o.soNumber || null,
      lines: (o.lines || []).map((l) => `${l.partNo || l.item} x${l.qty}`).join(', '),
      amount: Math.round(amount * 100) / 100,
      paymentHold: o.paymentId || null,
      note: failed ? failed.detail : null,
    });
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

function build() {
  const events = approvalLog.between('2000-01-01', '2100-01-01');
  const c = customers(events);
  const o = orders(events);
  const d = discounts(events);
  const p = payments(events);
  const count = (list, s) => list.filter((x) => x.status === s).length;
  return {
    at: new Date().toISOString(),
    summary: {
      customers: { total: c.length, created: count(c, 'created'), waiting: count(c, 'waiting for approval'), rejected: count(c, 'rejected') },
      orders: {
        total: o.length,
        placed: count(o, 'placed'),
        waiting: count(o, 'waiting for approval') + count(o, 'waiting for payment'),
        rejected: count(o, 'rejected'),
        value: Math.round(o.filter((x) => x.status === 'placed').reduce((s, x) => s + x.amount, 0)),
      },
      discounts: { total: d.length, approved: count(d, 'approved'), waiting: count(d, 'waiting for approval'), rejected: count(d, 'rejected') },
      payments: { total: p.length, settled: count(p, 'settled'), open: p.length - count(p, 'settled') },
    },
    customers: c,
    orders: o,
    discounts: d,
    payments: p,
  };
}

module.exports = { build };
