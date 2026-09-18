'use strict';
// The portal refusing to punch an order.
//
// 12 Sep, live: a customer said Yes to five lines and got "our system did not
// accept it - our team has been alerted". Two things were wrong. The portal
// had said exactly why:
//
//   HTTP 409 {"detail":{"message":"Customer credit control blocked order
//   confirmation.","credit_control":{"allowed":false,"block_reasons":
//   ["ONE_DAY_OPEN_EXPOSURE"],"account_id":8191, ...}}}
//
// and no team had been told at all - that line was simply untrue.
//
// What the customer hears depends on WHOSE problem it is, and the portal is
// asked rather than guessed (GET /accounts/{id}/credit-control):
//
//   * money - a bill is pending or overdue, or the credit limit is used up.
//     That is the customer's to clear, and it is said plainly, the way the
//     team says it on the phone: "purana clear karwa dijiye, phir laga denge".
//   * anything else - a house rule, or a breakdown. Account 8191 on 12 Sep was
//     this: balance 0, no pending or overdue bill, 98,311 of the limit free,
//     and only single_order_blocked true, because one order (633 / SO 235954)
//     was still open on a 1-day credit term. Telling that customer to "clear
//     your pending" would have been false. They get one short line (founder:
//     "bs ye bol do ki problem ho rhi hai backend mai") and the figures go to
//     the admins, who can clear it.
const config = require('../config');
const store = require('../store');

// The portal's own words for a block, in the team's words.
const REASONS = {
  ONE_DAY_OPEN_EXPOSURE: 'an order is already open (1-day credit term)',
  CREDIT_LIMIT_EXCEEDED: 'credit limit used up',
  OVERDUE_INVOICES: 'overdue bills',
  OVERDUE: 'overdue bills',
  BLOCKED_ACCOUNT: 'account on hold',
};

function reasonWords(codes) {
  return (codes || [])
    .map((c) => REASONS[String(c).toUpperCase()] || String(c).toLowerCase().split('_').join(' '))
    .join(', ');
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function money(v) {
  return num(v).toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

// What the portal actually refused with. Anything it does not recognise comes
// back as a plain failure, never as a guess.
function read(e) {
  const detail = (e && e.body && e.body.detail) || null;
  const cc = (detail && (detail.credit_control || detail.creditControl)) || null;
  if (e && e.status === 409 && cc) {
    return {
      kind: 'credit',
      reasons: reasonWords(cc.block_reasons || cc.blockReasons),
      accountId: cc.account_id || cc.accountId || null,
      accountName: cc.account_name || cc.accountName || null,
      message: (detail && detail.message) || 'Credit control blocked the order.',
    };
  }
  return {
    kind: 'other',
    message: String((e && e.message) || e || 'unknown error').slice(0, 300),
  };
}

// Is this the customer's money, or our own house rule? Only the first is
// something to ask them to fix.
function readMoney(cc) {
  if (!cc) return null;
  const due = num(cc.net_receivable_amount) || num(cc.open_invoice_residual);
  const overdue = num(cc.uncovered_overdue_amount);
  const owes =
    overdue > 0 ||
    (cc.overdue_invoices || []).length > 0 ||
    cc.credit_limit_blocked === true ||
    cc.credit_days_blocked === true ||
    due > 0;
  return {
    owes,
    due,
    overdue,
    overdueCount: (cc.overdue_invoices || []).length,
    pending: (cc.pending_invoices || []).length,
    available: num(cc.available_credit_after_pdc),
    limit: num(cc.credit_limit),
    days: cc.credit_days,
    openOrders: cc.pipeline_orders || [],
    openAmount: num(cc.pipeline_order_amount),
    flags: ['configuration_blocked', 'credit_days_blocked', 'single_order_blocked', 'credit_limit_blocked'].filter(
      (f) => cc[f] === true,
    ),
  };
}

// The people who can do something about it. A credit block is an accounts
// matter, so it goes to the admins - the same people who already see ledgers
// and balances - and not into the parts helper's question queue.
function recipients() {
  const out = [];
  for (const n of config.adminNumbers || []) if (n && !out.includes(n)) out.push(n);
  return out;
}

async function alert(bot, info, facts, { phone, order, customerName }) {
  const tr = bot && bot.transport;
  if (!tr || typeof tr.sendText !== 'function') return 0;
  const name = customerName || info.accountName || null;
  const who = name ? name + ' (' + phone + ')' : phone;
  const items = ((order && order.lines) || []).map((l) => (l.partNo || l.item) + ' x' + l.qty).join('\n');
  const out = [];
  if (info.kind === 'credit') {
    out.push((facts && facts.owes ? '🔴 *Order blocked - payment pending* - ' : '🟠 *Order blocked on credit* - ') + who);
    out.push('');
    if (info.reasons) out.push('Portal: ' + info.reasons);
    if (info.accountId) out.push('Account: ' + [info.accountName, '#' + info.accountId].filter(Boolean).join(' '));
    if (facts) {
      if (facts.owes) {
        out.push(
          'Owed: ₹' +
            money(facts.due) +
            (facts.overdue ? ' (overdue ₹' + money(facts.overdue) + ')' : '') +
            (facts.overdueCount ? ' · ' + facts.overdueCount + ' overdue bill(s)' : ''),
        );
      } else {
        out.push(
          'Owed: nothing - limit ₹' + money(facts.limit) + ', free ₹' + money(facts.available) + ', ' + facts.days + ' day term',
        );
      }
      if (facts.openOrders.length) {
        out.push(
          'Already open: ' +
            facts.openOrders
              .map((o) => (o.portal_order_id || '?') + (o.odoo_so_name ? ' / SO ' + o.odoo_so_name : '') + ' ₹' + money(o.amount))
              .join(', '),
        );
      }
      if (facts.flags.length) out.push('Flag: ' + facts.flags.join(', '));
    }
  } else {
    out.push('⚠️ *Order could not be punched* - ' + who);
    out.push('');
    out.push(info.message);
  }
  if (items) out.push('', items);
  out.push('', 'The customer is waiting.');
  const body = out.join('\n');
  let sent = 0;
  for (const n of recipients()) {
    try {
      await tr.sendText(n, body);
      sent++;
    } catch (e) {
      store.log('punch', 'could not alert ' + n + ': ' + String((e && e.message) || e).slice(0, 100));
    }
  }
  store.log('punch', info.kind + ' refusal for ' + who + ' - told ' + sent + ' admin(s)');
  return sent;
}

// What the customer hears. Money is theirs to clear, so it is said plainly;
// everything else is ours, and gets one line with no reason in it.
function customerLine(facts, told, t) {
  if (facts && facts.owes) {
    return t(
      'Your earlier payment is still pending, so the order did not go in. Clear it and I will place it right away.',
      'Aapka pichhla payment abhi pending hai, isliye order nahi lag paya. Clear hote hi laga dunga.',
    );
  }
  return t(
    'System is not taking the order right now.' + (told ? ' Our team is on it.' : ''),
    'Abhi system order accept nahi kar raha.' + (told ? ' Team dekh rahi hai.' : ''),
  );
}

// The whole job: read the refusal, ask the portal what it really is, tell the
// people who can fix it, and hand back the line for the customer.
async function handle(bot, e, { phone, chatId, order, customerName, t }) {
  const info = read(e);
  let facts = null;
  if (info.kind === 'credit') {
    const accountId = info.accountId || (order && order.portalCustomer && order.portalCustomer.buyerId) || null;
    try {
      const cc = await require('../integrations/dealerPortal').creditControl(accountId);
      facts = readMoney(cc);
      const fresh = cc && (cc.block_reasons || cc.blockReasons);
      if (fresh && fresh.length) info.reasons = reasonWords(fresh);
    } catch (err) {
      store.log('punch', 'credit-control read failed for ' + accountId + ': ' + String((err && err.message) || err).slice(0, 120));
    }
  }
  store.log(
    'punch',
    'punch refused for ' +
      phone +
      ': ' +
      (info.kind === 'credit'
        ? 'credit control - ' +
          (info.reasons || 'blocked') +
          (facts ? (facts.owes ? ' - owes ₹' + money(facts.due) : ' - nothing owed, house rule') : '')
        : info.message),
  );
  const told = await alert(bot, info, facts, { phone, order, customerName });
  return customerLine(facts, told > 0, t);
}

module.exports = { handle, read, customerLine, _internals: { reasonWords, recipients, readMoney } };
