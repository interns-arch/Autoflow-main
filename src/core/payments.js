'use strict';
// PAYMENT BEFORE A NEW ORDER (founder, 25 Sep).
//
// A customer who still owes money is not given a new order until it is
// settled:
//   1. At the order's "yes", the due balance is read from the portal (it is
//      Odoo's receivable, live). Rs 1 or more: the order is HELD, and the
//      customer is told the exact amount and sent a payment QR.
//   2. They say they have paid: the accountant (Anurag) is asked to check —
//      "OK PAY-… <amount received>" or "NO PAY-…". He records the receipt on
//      the portal/Odoo himself.
//   3. On his OK the balance is read again. Under Rs 1: the customer is told
//      it is settled and the held order goes on — to the Sales Heads for
//      approval. Still due: the customer is told what is left, with a QR for
//      that, and the accountant is told the portal still shows it.
//
// A request, by id:
//   { id, chatId, phone, customer, buyerId, due, orderId, status:
//     'waiting' | 'checking' | 'settled', received: [{ amount, by, at }], at }
const config = require('../config');
const store = require('../store');
const chatState = require('./chatState');

const requests = chatState.slot('payments.requests');

const isAccountant = (phone) => Boolean((config.payments.accountants || {})[store.normPhone(phone)]);
const accountantName = (phone) => (config.payments.accountants || {})[store.normPhone(phone)] || store.normPhone(phone);
const money = (v) => 'Rs.' + Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const round2 = (v) => Math.round(Number(v || 0) * 100) / 100;

// What this customer owes, from the portal's account row (its balance is
// Odoo's receivable, read live). -> { due, live } or null when it cannot be
// read — and an unreadable balance never blocks an order.
async function dueOf(customer) {
  if (!customer || !customer.buyerId) return null;
  const portal = require('../integrations/dealerPortal');
  let rows = [];
  try {
    rows = customer.name ? await portal.searchAccounts(customer.name) : [];
  } catch (e) {
    store.log('payments', 'balance of ' + customer.name + ' could not be read: ' + String((e && e.message) || e).slice(0, 80));
    return null;
  }
  const row = rows.find((r) => Number(r.id) === Number(customer.buyerId));
  if (!row || row.balance === undefined || row.balance === null) return null;
  // A CHEQUE THEY GAVE COUNTS AS PAID ONCE RECEIVED (founder, 29 Sep): the
  // balance is Odoo's and has not taken it off yet (core/cheques). Read fresh
  // - an accountant's OK re-reads this to see whether it is settled.
  const pos = await require('./cheques')
    .positionOf(customer.buyerId, { fresh: true })
    .catch(() => null);
  const cheque = pos ? pos.chequeAmount : 0;
  return {
    due: round2(Math.max(0, Number(row.balance) - cheque)),
    owed: round2(row.balance),
    chequeAmount: cheque,
    cheques: pos ? pos.cheques : [],
    live: row.balance_is_live !== false,
  };
}

const settled = (due) => !(Number(due) >= (config.payments.settledBelow || 1));

function newId() {
  let id;
  do id = 'PAY-' + Math.random().toString(36).slice(2, 6).toUpperCase();
  while (requests.get(id));
  return id;
}

// The open request for this chat, if there is one.
function forChat(chatId) {
  for (const r of requests.values()) if (r.chatId === chatId && r.status !== 'settled') return r;
  return null;
}
const find = (id) => requests.get(String(id || '').toUpperCase()) || null;
function save(req) {
  req.at = req.at || Date.now();
  requests.set(req.id, req);
  return req;
}
function open({ chatId, phone, customer, buyerId, due, orderId }) {
  const was = forChat(chatId);
  if (was) {
    Object.assign(was, { due, orderId: orderId || was.orderId, customer: customer || was.customer, buyerId: buyerId || was.buyerId });
    return save(was);
  }
  return save({ id: newId(), chatId, phone, customer, buyerId, due, orderId: orderId || null, status: 'waiting', received: [], at: Date.now() });
}

// The payment QR: UPI for the exact amount when a UPI id is set, else the
// fixed image. -> { buffer, mime } or null when neither is configured.
async function qr(amount, note) {
  const p = config.payments;
  if (p.upiId) {
    const url =
      'upi://pay?pa=' + encodeURIComponent(p.upiId) +
      '&pn=' + encodeURIComponent(p.upiName || 'Cartrends') +
      '&am=' + encodeURIComponent(round2(amount).toFixed(2)) +
      '&cu=INR' +
      (note ? '&tn=' + encodeURIComponent(String(note).slice(0, 60)) : '');
    const buffer = await require('qrcode').toBuffer(url, { type: 'png', width: 512, margin: 2 });
    return { buffer, mime: 'image/png', upi: url };
  }
  if (p.qrImage) {
    try {
      const fs = require('fs');
      const path = require('path');
      const file = path.isAbsolute(p.qrImage) ? p.qrImage : path.join(config.sharedDir, p.qrImage);
      const buffer = fs.readFileSync(file);
      return { buffer, mime: /\.png$/i.test(file) ? 'image/png' : 'image/jpeg' };
    } catch (e) {
      store.log('payments', 'payment QR image not readable: ' + String((e && e.message) || e).slice(0, 80));
    }
  }
  return null;
}

// What the accountant reads.
function accountantText(req, claim) {
  return [
    `*Payment check* — ${req.id}`,
    `Customer: ${req.customer}${req.phone ? ` (+${String(req.phone).replace(/^\+/, '')})` : ''}`,
    `Due on the portal: *${money(req.due)}*`,
    req.orderId ? `Held order: ${req.orderId} (goes for approval once this is settled)` : null,
    claim ? `Customer says: "${String(claim).slice(0, 200)}"` : 'Customer says they have paid.',
    '',
    'Check the account, record what came in on the portal, then reply:',
    `*OK ${req.id} <amount received>* — e.g. OK ${req.id} ${Math.round(req.due)}`,
    `*NO ${req.id}* — nothing has come in`,
  ]
    .filter((l) => l !== null)
    .join('\n');
}

// "OK PAY-7F3K 22002", "ok pay-7f3k ₹22,002.05", "NO PAY-7F3K"
// -> { yes, requestId, amount|null } or null.
function readDecision(text) {
  const t = require('./waText').unformat(String(text || '')).trim();
  const m = t.match(/^(ok|yes|haan|received|mila|aa gaya|no|nahi|nhi|not received)\s+(PAY-[A-Z0-9]+)(?:\s+(?:rs\.?|₹|inr)?\s*([\d,]+(?:\.\d+)?))?\s*(?:rs|rupees?|\/-)?\s*$/i);
  if (!m) return null;
  return {
    yes: !/^(no|nahi|nhi|not received)$/i.test(m[1]),
    requestId: m[2].toUpperCase(),
    amount: m[3] ? Number(m[3].replace(/,/g, '')) : null,
  };
}

module.exports = { dueOf, settled, open, forChat, find, save, qr, accountantText, readDecision, isAccountant, accountantName, money, requests };
