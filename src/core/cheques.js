'use strict';
// CHEQUES GIVEN, NOT YET IN ODOO (founder, 29 Sep).
//
// A customer hands over a cheque. The portal has it the same day - collected,
// then verified by finance, then deposited - but Odoo only when it clears and
// is posted there. Until then the portal's account `balance` is Odoo's
// outstanding and does NOT take the cheque off: live, 29 Sep, an account with
// a verified ₹4,446 cheque read "balance 4446" and the bot told them they owed
// ₹4,446. The portal's own credit control already counts the cheque
// (approved_pdc_coverage); the bot's messages did not.
//
// The founder's rule: a cheque COUNTS AS PAID ONCE RECEIVED. So what the
// customer still owes is Odoo's outstanding less every cheque that is
// collected, verified or deposited. A cleared cheque is already in Odoo (it
// carries its Odoo payment), and a rejected or bounced one pays nothing - it
// is added back simply by no longer counting, and the staff are told
// (core/chequeWatch).
const store = require('../store');

// Received and still on its way to Odoo.
const PENDING = /^(collected|verified|deposited|submitted|pending|received)$/i;
// Paid nothing.
const FAILED = /^(rejected|bounced|cancelled|canceled|returned)$/i;
const isPending = (c) => PENDING.test(String((c && c.status) || '').trim());
const isFailed = (c) => FAILED.test(String((c && c.status) || '').trim());

const num = (v) => {
  const n = Number(String(v == null ? '' : v).replace(/[₹,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const round2 = (v) => Math.round(Number(v || 0) * 100) / 100;

const TTL_MS = 60 * 1000;
const cache = new Map(); // accountId -> { at, value }

// -> { owed, chequeAmount, afterCheques, cheques: [...pending], failed: [...], live } | null
//   owed          what Odoo says they owe (the portal's live outstanding)
//   chequeAmount  cheques received and not yet in Odoo
//   afterCheques  what is left once those are counted - what they still owe
// null when the portal cannot say: the caller falls back to what it had.
async function positionOf(accountId, { fresh = false } = {}) {
  const id = String(accountId == null ? '' : accountId).replace(/[^0-9]/g, '');
  if (!id) return null;
  const hit = cache.get(id);
  if (!fresh && hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const portal = require('../integrations/dealerPortal');
  let bal = null;
  let list = [];
  try {
    [bal, list] = await Promise.all([portal.pdcBalance(id), portal.pdcCheques(id)]);
  } catch (e) {
    store.log('cheques', `account ${id}: cheques could not be read: ${String((e && e.message) || e).slice(0, 100)}`);
    return null;
  }
  const owed = num(bal && (bal.customer_outstanding != null ? bal.customer_outstanding : bal.balance));
  const cheques = (list || [])
    .filter(isPending)
    .map((c) => ({
      id: c.txn_id,
      number: c.pdc_number || null,
      amount: num(c.pdc_amount) || 0,
      date: c.cheque_date || null,
      bank: c.bank_name || null,
      status: String(c.status || '').toLowerCase(),
    }));
  // The list is the truth about which cheques; the portal's pdc_amount only
  // when the list could not be had (it counts verified ones alone).
  const listed = round2(cheques.reduce((s, c) => s + c.amount, 0));
  const chequeAmount = cheques.length ? listed : num(bal && bal.pdc_amount) || 0;
  const failed = (list || []).filter(isFailed).map((c) => ({ id: c.txn_id, number: c.pdc_number || null, amount: num(c.pdc_amount) || 0, status: String(c.status || '').toLowerCase(), at: c.updated_at || null }));
  const value =
    owed === null
      ? null
      : {
          owed: round2(owed),
          chequeAmount,
          afterCheques: round2(Math.max(0, owed - chequeAmount)),
          cheques,
          failed,
          live: !bal || bal.balance_is_live !== false,
        };
  cache.set(id, { at: Date.now(), value });
  return value;
}

function forget(accountId) {
  cache.delete(String(accountId == null ? '' : accountId).replace(/[^0-9]/g, ''));
}

const money = (v) => Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const day = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : null);
const STATUS_HI = { collected: 'mil gaya hai', verified: 'verify ho gaya hai', deposited: 'bank mein jama ho gaya hai' };
const STATUS_EN = { collected: 'received', verified: 'verified', deposited: 'deposited in the bank' };

// One line per cheque, for a customer or the staff: "cheque 004512 · ₹40,000 · 2 Oct · deposited".
function chequeLines(pos, t) {
  return (pos.cheques || []).map(
    (c) =>
      '• ' +
      [
        t('cheque', 'cheque') + (c.number ? ' ' + c.number : ''),
        '₹' + money(c.amount),
        day(c.date),
        t(STATUS_EN[c.status] || c.status, STATUS_HI[c.status] || c.status),
      ]
        .filter(Boolean)
        .join(' · '),
  );
}

module.exports = { positionOf, forget, chequeLines, isPending, isFailed, _cache: cache };
