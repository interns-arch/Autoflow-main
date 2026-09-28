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
  if ((config.adminNumbers || []).includes(p)) return 'Admin ' + p;
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
    const facts = { ...req, ...(rej || {}), ...(done || {}) };
    out.push({
      id: last.id,
      requestedAt: req.at || (done && done.at) || last.at,
      decidedAt: (done || rej || {}).at || null,
      status: done ? 'created' : rej ? 'rejected' : 'waiting for approval',
      customer: facts.customer || (facts.phone ? facts.phone + (rej && rej.note === 'GST review' ? ' (GST not verified)' : '') : null),
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
    // Since 28 Sep a request goes straight to the portal ("sent to portal",
    // with the rule number); the portal's Super Admin decides it there.
    const sent = [...list].reverse().find((e) => e.event === 'sent to portal');
    out.push({
      id: list[0].id,
      requestedAt: req.at || list[0].at,
      decidedAt: (done || rej || {}).at || null,
      status: done ? 'approved' : rej ? 'rejected' : sent ? 'waiting for Super Admin' : 'waiting for approval',
      portalDetail: sent ? sent.detail : null,
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
    // A punch the portal refused is shown whatever state the order was left
    // in - a cart confirmed straight from the chat stays a draft when the
    // portal says no, and used to vanish from here.
    const refusedHere = o.punchRefused && o.status !== 'confirmed';
    const st = status(o) || (refusedHere ? 'refused by portal' : null);
    if (!st) continue; // drafts and carts nobody confirmed
    const log = logByOrder.get('order:' + o.id) || [];
    const req = log.find((e) => e.event === 'requested');
    const failed = [...log].reverse().find((e) => e.event === 'failed') || (refusedHere ? { detail: o.punchRefused.why, at: o.punchRefused.at } : null);
    const pc = o.portalCustomer || (typeof o.customer === 'object' ? o.customer : null) || {};
    const chatPhone = phoneOf(o.chatId);
    // Who placed it, as recorded when it was asked for; the number's role
    // today only when nothing was recorded (7355374975 was a customer's
    // number on 25 Sep and is an agent's now).
    const agent = req
      ? /sales team/i.test(req.by || '')
        ? String(req.by).replace(/\s*\(sales team\)\s*$/, '')
        : null
      : whoIs(chatPhone);
    const punched = (o.lines || []).filter((l) => l.source !== 'unidentified' && l.source !== 'unknown' && l.source !== 'unavailable' && (Number(l.available) || 0) > 0);
    const amount = punched.reduce((s, l) => s + (Number(l.rate) || Number(l.mrp) || 0) * Math.min(Number(l.qty) || 0, Number(l.available) || 0), 0);
    out.push({
      id: o.id,
      at: o.confirmedAt || o.approvalAskedAt || (refusedHere && o.punchRefused.at) || o.createdAt || null,
      // Punched, then cancelled on the portal (core/cancelWatch): not placed.
      status: o.portalCancelled ? 'cancelled on portal' : failed && st !== 'placed' ? 'refused by portal' : st,
      cancelledAt: o.portalCancelled ? o.portalCancelled.at : null,
      customer: pc.name || (typeof o.customer === 'string' && !/@/.test(o.customer) ? o.customer : null),
      customerId: pc.buyerId || null,
      placedBy: agent ? (/^Admin /.test(agent) ? agent : agent + ' (agent)') : 'customer',
      // Orders placed before the approval step existed (placing was on).
      approvedBy: o.approvedBy || (st === 'placed' ? 'placed directly (no approval step)' : null),
      rejectedBy: o.rejectedBy || null,
      portalOrder: (o.placed || []).map((p) => p.soNumber).filter(Boolean).join(' / ') || o.soNumber || null,
      lines: (o.lines || []).map((l) => `${l.partNo || l.item} x${l.qty}`).join(', '),
      amount: Math.round(amount * 100) / 100,
      paymentHold: o.paymentId || null,
      note: o.portalCancelled ? 'cancelled on the portal after the punch (portal order ' + o.portalCancelled.so + ')' + (o.portalCancelled.told ? ' — customer told' : '') : failed ? failed.detail : null,
    });
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

// Accounts opened before the approval log kept their details (24 Sep) are
// filled in from the portal: phone, GSTIN, address, home branch.
let portalCache = { at: 0, rows: new Map() };
async function enrich(list) {
  const portal = require('../integrations/dealerPortal');
  const de = require('./dataEntryRequests');
  if (Date.now() - portalCache.at > 10 * 60 * 1000) portalCache = { at: Date.now(), rows: new Map() };
  for (const c of list) {
    if (c.status !== 'created' || !c.customer || (c.gst && c.phone && c.address && c.homeBranch)) continue;
    let row = portalCache.rows.get(c.customer);
    if (row === undefined) {
      const rows = await portal.searchAccounts(c.customer).catch(() => []);
      row = rows.find((r) => String(r.name || '').trim() === c.customer) || null;
      portalCache.rows.set(c.customer, row);
    }
    if (!row) continue;
    c.phone = c.phone || row.phone || row.mobile || null;
    c.gst = c.gst || row.gst_no || null;
    c.address = c.address || [row.address, row.state_name].filter(Boolean).join(', ') || null;
    c.contactPerson = c.contactPerson || row.person || null;
    c.homeBranch = c.homeBranch || (row.address || row.state_name ? de.branchName(de.branchFor({ state: row.state_name, address: row.address })) : null);
  }
  return list;
}

// ---------------------------------------------------------------- the portal
//
// THE BOT'S RECORD AND THE PORTAL'S, SIDE BY SIDE (founder, 28 Sep: "status
// of order, customer creation, discount and all data take from dealer portal
// and bot data"). The approval log says what was asked and decided here; the
// portal says where each thing stands there - allocated, invoiced,
// dispatched; the account open or not; the rule approved by the Super Admin,
// still pending, or gone. Every read is cached for five minutes and capped in
// number, so opening the dashboard can never flood the portal; if the portal
// does not answer, the bot's own record still shows and `sources` says so.
const TTL_MS = 5 * 60 * 1000;
const cacheOf = new Map(); // key -> { at, value }
async function cached(key, fn) {
  const hit = cacheOf.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = await fn();
  cacheOf.set(key, { at: Date.now(), value });
  if (cacheOf.size > 2000) cacheOf.delete(cacheOf.keys().next().value);
  return value;
}
// A few at a time, in order.
async function eachLimited(items, n, fn) {
  let i = 0;
  const run = async () => {
    while (i < items.length) {
      const it = items[i++];
      await fn(it).catch(() => {});
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
}

// ORDERS: the portal order behind each one - its allocation, invoice and
// dispatch - for the 60 most recent that reached the portal.
async function portalOrders(list) {
  const portal = require('../integrations/dealerPortal');
  const withSo = list.filter((o) => o.portalOrder).slice(0, 60);
  await eachLimited(withSo, 4, async (o) => {
    const id = String(o.portalOrder).split(/\s*\/\s*/)[0].trim();
    if (!/^\d+$/.test(id)) return;
    const raw = await cached('order:' + id, () => portal.order(Number(id)));
    const p = (raw && raw.data) || raw || {};
    const lines = p.lines || p.order_lines || [];
    const disc = lines.map((l) => Number(l.item_discount_per) || 0);
    o.portal = {
      order: id,
      status: p.status || null,
      doStatus: p.do_status || null,
      invoice: p.invoice_status || null,
      invoiceNo: p.invoice_no || null,
      dispatch: p.tracker_status || null,
      dispatchedAt: p.dispatched_at || null,
      odooSo: p.odoo_so_name || null,
      closed: Boolean(p.is_closed),
      total: p.total_amount != null ? Number(p.total_amount) : null,
      discount: disc.length ? (disc.some((x) => x > 0) ? Math.max(...disc) + '%' : '0%') : null,
    };
    // Cancelled there before the watcher's next look: shown as such at once.
    if (/cancel/i.test(String(p.status || '') + ' ' + String(p.do_status || '')) && o.status === 'placed') {
      o.status = 'cancelled on portal';
      o.note = o.note || 'cancelled on the portal after the punch (portal order ' + id + ')';
    }
    // Where it stands, in one word the team uses.
    o.portalStage = p.dispatched_at || /dispatch|deliver/i.test(p.tracker_status || '')
      ? 'dispatched'
      : p.invoice_no || /invoiced|done|complete/i.test(p.invoice_status || '')
        ? 'invoiced'
        : p.is_closed
          ? 'closed'
          : p.status
            ? String(p.status).toLowerCase()
            : null;
  });
}

// DISCOUNTS: every request's rule as the portal has it now, and the rules
// kept on the portal for a customer that the bot never asked for.
function ruleIdOf(d) {
  const m = String([d.result, d.asked, d.portalDetail].filter(Boolean).join(' ')).match(/rule\s*#?\s*(\d{3,})/i);
  return m ? Number(m[1]) : null;
}
async function portalDiscounts(list) {
  const portal = require('../integrations/dealerPortal');
  const rules = await cached('discount-rules', () => portal.listDiscountRules());
  const byId = new Map(rules.map((r) => [Number(r.rule_id || r.id), r]));
  const seen = new Set();
  const status = (r) => {
    const s = String((r && r.approval_status) || '').toUpperCase();
    if (!r) return 'not on portal';
    if (r.is_active === false) return 'inactive on portal';
    // Past its end date it prices nothing, approved or not.
    if (r.valid_to && new Date(r.valid_to).getTime() < Date.now()) return 'expired';
    return s === 'APPROVED' ? 'approved' : s === 'REJECTED' ? 'rejected' : 'waiting for Super Admin';
  };
  const facts = (r) => ({
    rule: Number(r.rule_id || r.id),
    name: r.rule_name || null,
    on: r.rule_type === 'ITEM' ? 'part ' + r.part_no : r.brand ? 'brand ' + r.brand : 'all parts',
    value: r.discount_value != null ? r.discount_value + (String(r.discount_mode || '').toUpperCase() === 'PERCENT' ? '%' : '') : null,
    approval: r.approval_status || null,
    validFrom: r.valid_from || null,
    validTo: r.valid_to || null,
    dealer: r.dealer_id || null,
  });
  for (const d of list) {
    const id = d.ruleId || ruleIdOf(d);
    if (!id) continue;
    d.ruleId = id;
    seen.add(id);
    const r = byId.get(id);
    d.portal = r ? facts(r) : { rule: id, approval: null };
    // The portal decides now: a Sales Head's "OK" on WhatsApp was never
    // approval there.
    d.status = status(r);
    // Decided on the portal: its last update is when the Super Admin said
    // yes or no - the date a "discounts approved on 28 Sep" count reads.
    if (r && !d.decidedAt && /approved|rejected|expired/.test(d.status)) d.decidedAt = r.updated_at || null;
  }
  // Customer rules on the portal the bot did not ask for (typed on the
  // portal, or before the bot kept a log): one row each.
  for (const r of rules) {
    const id = Number(r.rule_id || r.id);
    if (seen.has(id) || !r.dealer_id) continue;
    list.push({
      id: 'RULE-' + id,
      ruleId: id,
      requestedAt: r.created_at || null,
      decidedAt: /^(APPROVED|REJECTED)$/i.test(String(r.approval_status || '')) ? r.updated_at || null : null,
      status: status(r),
      customer: String(r.rule_name || '').replace(/\s+\S+\s+-?[\d.]+%?$/, '').trim() || null,
      asked: facts(r).on + ' ' + (facts(r).value || ''),
      result: null,
      createdBy: r.requested_by_name || r.requested_by || (r.rule_metadata && r.rule_metadata.setBy) || 'portal',
      source: r.rule_metadata && r.rule_metadata.source === 'whatsapp-bot' ? 'bot' : 'portal',
      portal: facts(r),
    });
  }
  list.sort((a, b) => String(b.requestedAt || '').localeCompare(String(a.requestedAt || '')));
}

// CUSTOMERS: is the account on the portal - found by its mobile number - and
// under which account id and dealer. For the 80 most recent requests.
async function portalCustomers(list) {
  const so = require('./salesOrder');
  const recent = list.filter((c) => c.phone).slice(0, 80);
  await eachLimited(recent, 4, async (c) => {
    const ten = String(c.phone).replace(/\D/g, '').slice(-10);
    if (ten.length !== 10) return;
    const rows = await cached('acct:' + ten, () => so.findByKey({ phone: '91' + ten }));
    const r = (rows || [])[0] || null;
    c.portal = r ? { account: r.id, name: r.name || null, gst: r.gst_no || null, dealer: r.home_branch_dealer_id || null, accounts: rows.length } : { account: null };
    c.portalStatus = r ? 'on portal' : c.status === 'created' ? 'NOT found on portal' : 'not on portal yet';
    if (r && !c.gst && r.gst_no) c.gst = r.gst_no;
  });
}

async function buildLive() {
  const out = build();
  out.sources = { bot: 'ok' };
  const step = async (name, fn) => {
    try {
      await fn();
      out.sources[name] = 'ok';
    } catch (e) {
      out.sources[name] = 'portal did not answer: ' + String((e && e.message) || e).slice(0, 80);
    }
  };
  await Promise.all([
    step('customers', async () => {
      await enrich(out.customers);
      await portalCustomers(out.customers);
    }),
    step('orders', () => portalOrders(out.orders)),
    step('discounts', () => portalDiscounts(out.discounts)),
  ]);
  return out;
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
        refused: count(o, 'refused by portal'),
        cancelled: count(o, 'cancelled on portal'),
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

module.exports = { build, buildLive };
