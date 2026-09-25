'use strict';
// Odoo, read-only: the documents behind a customer's balance.
//
// The Dealer Portal answers almost everything the sales desk asks, but not
// this: it gives the BALANCE, while the invoices, credit notes and payments
// that make up that balance live in Odoo (erp.cartrends.co.in).
//
// Two facts that cost an hour on 11 Sep:
//   * ODOO_URL in .env ends with /odoo — that is the web client's path. The
//     JSON-RPC endpoint is at the ORIGIN; /odoo/jsonrpc redirects to the
//     database selector, which answers HTML to a JSON call.
//   * the portal's account row carries odoo_partner_id (Kalra Motors 265 ->
//     partner 1734), so a customer picked by name on the portal maps straight
//     to res.partner. Nothing here looks a partner up by NAME: two customers
//     can share one, and the wrong ledger is worse than no ledger.
//
// One thing in this file writes to the ERP: ensurePartner, the customer a new
// account needs on Odoo. Everything else reads.
const config = require('../config');
const store = require('../store');

function enabled() {
  const o = config.odoo || {};
  return Boolean(o.url && o.db && o.username && o.apiKey);
}

function origin() {
  try {
    return new URL(config.odoo.url).origin;
  } catch (_) {
    return String((config.odoo && config.odoo.url) || '').replace(/\/+$/, '');
  }
}

async function rpc(service, method, args) {
  const res = await fetch(origin() + '/jsonrpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { service, method, args }, id: Date.now() }),
    signal: AbortSignal.timeout(config.odoo.timeoutMs),
  });
  if (!res.ok) throw new Error('Odoo HTTP ' + res.status);
  const data = await res.json();
  if (data.error) {
    const e = new Error(String((data.error.data && data.error.data.message) || data.error.message || 'Odoo error').slice(0, 200));
    e.odoo = (data.error.data && data.error.data.name) || null;
    throw e;
  }
  return data.result;
}

// The uid is cached; Odoo hands out a new one cheaply, so a stale session is
// simply logged in again rather than reported to whoever asked.
let uid = null;
async function login() {
  const o = config.odoo;
  uid = await rpc('common', 'authenticate', [o.db, o.username, o.apiKey, {}]);
  if (!uid) throw new Error('Odoo refused the login (database, user or key)');
  store.log('odoo', 'login OK as ' + o.username + ' (uid ' + uid + ')');
  return uid;
}

async function call(model, method, args, kw, retry = true) {
  if (!enabled()) throw new Error('Odoo is not configured');
  if (!uid) await login();
  try {
    return await rpc('object', 'execute_kw', [config.odoo.db, uid, config.odoo.apiKey, model, method, args, kw || {}]);
  } catch (e) {
    if (retry && /session|expired|access denied|invalid|uid/i.test(String(e.message))) {
      uid = null;
      return call(model, method, args, kw, false);
    }
    throw e;
  }
}

const num = (v) => Math.round((Number(v) || 0) * 100) / 100;

// What the customer owes, and the documents behind it. `due` comes from the
// partner record, the same number the portal shows as the balance.
async function ledger(partnerId, { limit = 6 } = {}) {
  const id = Number(partnerId);
  if (!id) return null;
  const [partner] = await call('res.partner', 'read', [[id]], { fields: ['name', 'total_due', 'total_overdue'] });
  const moves = await call(
    'account.move',
    'search_read',
    [[['partner_id', '=', id], ['state', '=', 'posted'], ['move_type', 'in', ['out_invoice', 'out_refund']]]],
    {
      fields: ['name', 'move_type', 'invoice_date', 'invoice_date_due', 'amount_total', 'amount_residual', 'payment_state'],
      limit,
      order: 'invoice_date desc, id desc',
    },
  );
  return {
    name: partner && partner.name,
    due: num(partner && partner.total_due),
    overdue: num(partner && partner.total_overdue),
    documents: moves.map((m) => ({
      kind: m.move_type === 'out_refund' ? 'credit note' : 'invoice',
      name: m.name,
      date: m.invoice_date || null,
      dueDate: m.invoice_date_due || null,
      total: num(m.amount_total),
      pending: num(m.amount_residual),
      paid: m.payment_state === 'paid',
    })),
  };
}

// Posted credit notes only: a draft one is not money the customer has.
async function creditNotes(partnerId, { limit = 6 } = {}) {
  const id = Number(partnerId);
  if (!id) return null;
  const rows = await call(
    'account.move',
    'search_read',
    [[['partner_id', '=', id], ['state', '=', 'posted'], ['move_type', '=', 'out_refund']]],
    { fields: ['name', 'invoice_date', 'amount_total', 'amount_residual', 'payment_state'], limit, order: 'invoice_date desc, id desc' },
  );
  return rows.map((m) => ({
    name: m.name,
    date: m.invoice_date || null,
    total: num(m.amount_total),
    pending: num(m.amount_residual),
    used: m.payment_state === 'paid',
  }));
}

// THE CUSTOMER ON ODOO, for an account the bot has just opened.
//
// The portal creates the Odoo partner itself when it opens an account (MIYA JI
// MOTORS got 51815 six seconds before the account; SHREE SHYAM ENTERPRISES
// got 51818), and links it by itself — it has no API field to set the link.
// This is for when that does not happen: an account with no Odoo customer
// takes orders that never become an Odoo SO.
//
// Never a second partner for the same business. The GSTIN is looked for
// first, then the phone (as the portal writes it, 91XXXXXXXXXX, and as ten
// digits); only when neither is on Odoo is one created.
// -> { id, created: boolean, matchedBy }
async function ensurePartner({ name, phone, gstNo, email, address, city, state, pin }) {
  const vat = String(gstNo || '').trim().toUpperCase();
  const digits = String(phone || '').replace(/\D/g, '');
  const ten = digits.slice(-10);
  if (vat) {
    const hit = await call('res.partner', 'search', [[['vat', '=', vat]]], { limit: 1 });
    if (hit.length) return { id: hit[0], created: false, matchedBy: 'gstin' };
  }
  if (ten.length === 10) {
    const hit = await call('res.partner', 'search', [['|', ['phone', '=', '91' + ten], ['phone', '=', ten]]], { limit: 1 });
    if (hit.length) return { id: hit[0], created: false, matchedBy: 'phone' };
  }
  const india = await call('res.country', 'search', [[['code', '=', 'IN']]], { limit: 1 });
  let stateId = false;
  if (state && india.length) {
    const st = await call('res.country.state', 'search', [[['country_id', '=', india[0]], ['name', 'ilike', String(state).replace(/\s*\(IN\)\s*$/, '')]]], { limit: 1 });
    stateId = st.length ? st[0] : false;
  }
  const values = {
    name: String(name || '').trim(),
    is_company: true,
    customer_rank: 1,
    phone: ten.length === 10 ? '91' + ten : digits || false,
    email: email || false,
    vat: vat || false,
    street: address || false,
    city: city || false,
    zip: pin ? String(pin) : false,
    state_id: stateId,
    country_id: india.length ? india[0] : false,
  };
  if (!values.name) throw new Error('no name to create the Odoo customer with');
  const id = await call('res.partner', 'create', [values]);
  store.log('odoo', `customer created on Odoo: "${values.name}" -> partner ${id}`);
  return { id, created: true, matchedBy: null };
}

module.exports = { enabled, ledger, creditNotes, ensurePartner, _call: call, _login: login };
