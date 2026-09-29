'use strict';
// A CHEQUE THAT BOUNCES (founder, 29 Sep).
//
// A cheque counts as paid the moment it is received (core/cheques). If the
// bank bounces it, or finance rejects it, it pays nothing: from then on it
// simply stops counting, so what the customer owes goes back up on its own.
// The accountants and admins are told, once per cheque, so someone calls the
// customer. Every EVERY_MS the portal's cheque list is read for a status that
// paid nothing.
//
// The first look only learns which cheques were already rejected before this
// existed (9 on 29 Sep), so nobody is sent a history lesson.
const config = require('../config');
const store = require('../store');
const chatState = require('./chatState');
const { isFailed } = require('./cheques');

const EVERY_MS = 15 * 60 * 1000;
// { seenAt }, not { at }: chatState drops an `at` after a day, and this is
// kept for good - a forgotten cheque would be announced again.
const seen = chatState.slot('chequeWatch.failed'); // txn id -> { seenAt }

const money = (v) => '₹' + Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

function staff() {
  const out = new Set([...Object.keys(config.payments.accountants || {}), ...(config.adminNumbers || [])]);
  return [...out].filter((p) => /^\d{10,15}$/.test(p));
}

// -> the cheques newly found bounced or rejected (and told).
async function checkOnce(bot) {
  const portal = require('../integrations/dealerPortal');
  const list = await portal.pdcChequeList({});
  const failed = (list || []).filter(isFailed);
  const first = !seen.get('__primed');
  const fresh = failed.filter((c) => !seen.get(String(c.txn_id)));
  for (const c of fresh) seen.set(String(c.txn_id), { seenAt: Date.now() });
  if (first) {
    seen.set('__primed', { seenAt: Date.now() });
    store.log('cheques', `watch started: ${failed.length} cheque(s) already bounced/rejected - noted, nobody told`);
    return [];
  }
  for (const c of fresh) await tell(bot, c).catch((e) => store.log('cheques', `could not tell about cheque ${c.txn_id}: ${String((e && e.message) || e).slice(0, 80)}`));
  return fresh;
}

async function tell(bot, c) {
  const escalation = require('./escalation');
  const status = String(c.status || '').toLowerCase();
  const text = [
    `⚠️ *Cheque ${status}* — ${c.dealer_name || 'account ' + c.acc_id}`,
    `Cheque${c.pdc_number ? ' no. ' + c.pdc_number : ''} · ${money(c.pdc_amount)}${c.cheque_date ? ' · dated ' + c.cheque_date : ''}${c.bank_name ? ' · ' + c.bank_name : ''}`,
    c.created_user_name ? `Collected by: ${c.created_user_name}` : null,
    '',
    `It no longer counts as paid: the bot now shows this customer ${money(c.pdc_amount)} more due, and holds their next order until it is paid.`,
  ]
    .filter((l) => l !== null)
    .join('\n');
  for (const to of staff()) {
    try {
      await escalation.ensureWindow(bot.transport, to, `Cheque ${status} — details follow`, String(c.txn_id)).catch(() => {});
      await bot.transport.sendText(to, text);
    } catch (e) {
      store.log('cheques', `bounce alert to ${to} failed: ${String((e && e.message) || e).slice(0, 80)}`);
    }
  }
  require('./cheques').forget(c.acc_id);
  store.log('cheques', `cheque ${c.txn_id} (${money(c.pdc_amount)}, account ${c.acc_id}) ${status} - staff told`);
}

let timer = null;
function start(bot) {
  if (timer) return;
  const run = () => checkOnce(bot).catch((e) => store.log('cheques', 'cheque check failed: ' + String((e && e.message) || e).slice(0, 100)));
  setTimeout(run, 90 * 1000).unref();
  timer = setInterval(run, EVERY_MS);
  if (timer.unref) timer.unref();
}

module.exports = { start, checkOnce };
