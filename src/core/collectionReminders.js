'use strict';
// PAYMENT REMINDERS, two days before the collection date (founder, 26 Sep):
// "in a very respectful and warm tone".
//
// The collection date of an invoice is its date + the customer's collection
// days (the portal's credit terms; 15 when not set). Odoo's own due date is
// the invoice date itself — no payment terms are set there — so it is not
// used. Every open invoice (Odoo, amount still pending) whose collection date
// is exactly two days away gets one reminder, to the phone on the customer's
// account, with the payment QR. An invoice is reminded once; the admins get a
// summary of who was reminded.
const config = require('../config');
const store = require('../store');
const chatState = require('./chatState');

const sent = chatState.slot('reminders.sent'); // "<invoice>|<collection date>" -> at
const DEFAULT_COLLECTION_DAYS = 15;
const MAX_PER_RUN = Number(process.env.REMINDERS_MAX_PER_RUN || 300);

// YYYY-MM-DD in India.
const ymd = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: config.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const addDays = (dateStr, n) => {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const pretty = (dateStr) => new Date(dateStr + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'long', timeZone: 'UTC' });
const rs = (v) => '₹' + Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

// Who is due in two days. -> [{ name, phone, accountId, collectionDays,
// collectDate, invoices: [{ name, date, pending }], dueAmount, totalDue }]
async function dueSoon(now = new Date()) {
  const odoo = require('../integrations/odoo');
  const portal = require('../integrations/dealerPortal');
  const target = addDays(ymd(now), 2);
  // Any invoice whose collection date could be the target: collection days
  // run 1..30, so invoices dated 1..30 days before it.
  const rows = await odoo._call(
    'account.move',
    'search_read',
    [[
      ['move_type', '=', 'out_invoice'],
      ['state', '=', 'posted'],
      ['amount_residual', '>', 0],
      ['invoice_date', '>=', addDays(target, -30)],
      ['invoice_date', '<=', addDays(target, -1)],
    ]],
    { fields: ['name', 'partner_id', 'invoice_date', 'amount_residual'], order: 'invoice_date asc', limit: 2000 },
  );
  const byPartner = new Map();
  for (const r of rows) {
    const pid = r.partner_id && r.partner_id[0];
    if (!pid) continue;
    if (!byPartner.has(pid)) byPartner.set(pid, { pid, name: r.partner_id[1], invoices: [] });
    byPartner.get(pid).invoices.push({ name: r.name, date: r.invoice_date, pending: Math.round(Number(r.amount_residual) * 100) / 100 });
  }

  const out = [];
  // Six customers looked up at a time: one by one, a month of invoices took
  // longer than a morning job should.
  const partners = [...byPartner.values()];
  const one = async (p) => {
    // The portal account: the phone to write to, the collection days, the balance.
    let acct = null;
    try {
      acct = (await portal.searchAccounts(p.name)).find((a) => Number(a.odoo_partner_id) === Number(p.pid)) || null;
    } catch (_) {
      acct = null;
    }
    let collectionDays = DEFAULT_COLLECTION_DAYS;
    if (acct) {
      const cc = await portal.creditControl(acct.id).catch(() => null);
      if (cc && Number(cc.collection_days) > 0) collectionDays = Number(cc.collection_days);
    }
    const due = p.invoices.filter((i) => addDays(i.date, collectionDays) === target);
    if (!due.length) return;
    let phone = String((acct && (acct.phone || acct.mobile)) || '').replace(/\D/g, '').slice(-10);
    if (phone.length !== 10) {
      const [partner] = await odoo._call('res.partner', 'read', [[p.pid]], { fields: ['phone'] }).catch(() => [null]);
      phone = String((partner && partner.phone) || '').replace(/\D/g, '').slice(-10);
    }
    out.push({
      name: (acct && acct.name) || p.name,
      phone: phone.length === 10 ? '91' + phone : null,
      accountId: acct ? acct.id : null,
      collectionDays,
      collectDate: target,
      invoices: due,
      dueAmount: Math.round(due.reduce((s, i) => s + i.pending, 0) * 100) / 100,
      totalDue: acct && acct.balance != null ? Number(acct.balance) : null,
    });
  };
  for (let i = 0; i < partners.length; i += 6) await Promise.all(partners.slice(i, i + 6).map((p) => one(p).catch(() => {})));
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// The message — warm, respectful, short. Hinglish by default, English for a
// chat that writes in English.
function message(r, t) {
  const inv = r.invoices.length === 1 ? `invoice ${r.invoices[0].name} (${pretty(r.invoices[0].date)})` : `${r.invoices.length} invoices (${r.invoices.map((i) => i.name).join(', ')})`;
  const extra = r.totalDue && r.totalDue > r.dueAmount + 1 ? { en: `\nYour total open balance with us is ${rs(r.totalDue)}.`, hi: `\nAapka kul open balance ${rs(r.totalDue)} hai.` } : { en: '', hi: '' };
  return t(
    `Namaste ${r.name} ji 😊\n\nThank you for your continued trust in Cartrends — it means a lot to us.\n\nA gentle reminder: ${rs(r.dueAmount)} for ${inv} is due on *${pretty(r.collectDate)}*, in two days.${extra.en}\n\nYou can pay with the QR below, and just reply "payment done" once it is sent. If it is already on its way, please ignore this — and thank you!\n\nWarm regards,\nTeam Cartrends`,
    `Namaste ${r.name} ji 😊\n\nCartrends par aapke bharose ke liye dil se shukriya — aapke saath kaam karke hamein hamesha khushi hoti hai.\n\nBas ek chhota sa yaad dilana tha: ${inv} ka ${rs(r.dueAmount)} *${pretty(r.collectDate)}* tak dena hai, yaani 2 din mein.${extra.hi}\n\nNeeche diye QR se pay kar sakte hain, aur pay karke bas "payment kar diya" likh dijiye. Agar payment pehle hi bhej diya hai to is message ko ignore kar dijiye — shukriya!\n\nSaadar,\nTeam Cartrends`,
  );
}

// Send today's reminders. `dryRun`: list them, send nothing.
async function run(bot, { dryRun = false, now = new Date(), list: given = null } = {}) {
  const odoo = require('../integrations/odoo');
  if (!odoo.enabled()) return { skipped: 'Odoo is not configured' };
  const list = given || (await dueSoon(now));
  const escalation = require('./escalation');
  const payments = require('./payments');
  const lang = require('./lang');
  const done = [];
  const skipped = [];
  for (const r of list) {
    const key = r.invoices.map((i) => i.name).join('+') + '|' + r.collectDate;
    if (sent.get(key)) {
      skipped.push({ ...r, why: 'already reminded' });
      continue;
    }
    if (!r.phone) {
      skipped.push({ ...r, why: 'no phone on the account' });
      continue;
    }
    // Company SIMs are saved as customer phones (Arihant Accessories carries
    // NK Jain's 9810238966): a reminder never goes to one of our own people.
    const p = store.normPhone(r.phone);
    const staff =
      (config.creation.team || {})[p] ||
      (config.creation.approvers || {})[p] ||
      (config.salesTeamNumbers || []).includes(p) ||
      (config.adminNumbers || []).includes(p) ||
      ((config.payments && config.payments.accountants) || {})[p];
    if (staff) {
      skipped.push({ ...r, why: 'phone on the account is a staff number (' + (typeof staff === 'string' ? staff : p) + ')' });
      continue;
    }
    if (done.length >= MAX_PER_RUN) {
      skipped.push({ ...r, why: 'daily cap reached' });
      continue;
    }
    if (dryRun) {
      done.push(r);
      continue;
    }
    const chatId = r.phone + '@cloud';
    const t = lang.for(chatId);
    try {
      // Outside the 24h window only a template is delivered: its one line
      // carries the reminder on its own.
      await escalation.ensureWindow(
        bot.transport,
        r.phone,
        `${rs(r.dueAmount)} due on ${pretty(r.collectDate)} — a gentle payment reminder from Cartrends. Thank you!`,
        r.invoices[0].name,
      );
      const text = message(r, t);
      const id = await bot.transport.sendToChat(chatId, text);
      if (bot.recordOutgoing) bot.recordOutgoing(chatId, id, text);
      const q = await payments.qr(r.dueAmount, r.name + ' ' + r.invoices[0].name).catch(() => null);
      if (q && bot.transport.sendImage) await bot.transport.sendImage(chatId, q.buffer, q.mime, t(`Pay ${rs(r.dueAmount)} — scan to pay`, `${rs(r.dueAmount)} — scan karke pay kijiye`));
      sent.set(key, Date.now());
      done.push(r);
      store.log('remind', `payment reminder to ${r.name} (${r.phone}): ${rs(r.dueAmount)} due ${r.collectDate}`);
    } catch (e) {
      skipped.push({ ...r, why: 'send failed: ' + String((e && e.message) || e).slice(0, 80) });
    }
  }
  // The admins: who was reminded.
  if (!dryRun && (done.length || skipped.some((s) => s.why !== 'already reminded'))) {
    const total = done.reduce((s, r) => s + r.dueAmount, 0);
    const text = [
      `🔔 *Payment reminders* — due ${pretty(addDays(ymd(now), 2))}`,
      `Sent: ${done.length} customer(s), ${rs(total)}`,
      ...done.slice(0, 25).map((r) => `• ${r.name} — ${rs(r.dueAmount)}`),
      done.length > 25 ? `…and ${done.length - 25} more` : null,
      skipped.filter((s) => s.why !== 'already reminded').length ? `Not sent: ${skipped.filter((s) => s.why !== 'already reminded').map((s) => s.name + ' (' + s.why + ')').slice(0, 10).join('; ')}` : null,
    ]
      .filter(Boolean)
      .join('\n');
    for (const n of config.adminNumbers || []) {
      try {
        await escalation.ensureWindow(bot.transport, n, 'Payment reminders — summary follows');
        await bot.transport.sendText(n, text);
      } catch (_) {
        /* the reminders went either way */
      }
    }
  }
  store.log('remind', `${dryRun ? 'DRY RUN: would remind' : 'reminded'} ${done.length} customer(s); ${skipped.length} skipped`);
  return { target: addDays(ymd(now), 2), sent: done, skipped };
}

module.exports = { run, dueSoon, message };
