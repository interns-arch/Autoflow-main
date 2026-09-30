'use strict';
// LOSS BILLING (founder, 30 Sep): "if customer has loss billing then send for
// approval to prateek sir ... when prateek sir approve the loss billing order
// only then punch the order to dealer portal".
//
// A line is a loss when what the customer pays for it, after their discount,
// is below what the part cost us. The portal's commercial-analyze keeps our
// cost on each allocation as `base_price` (never shown to a customer); the
// customer's `price` includes GST, so it is compared ex-GST unless
// LOSS_COST_INCLUDES_GST says the cost includes it too.
const config = require('../config');
const store = require('../store');

const round2 = (v) => Math.round(Number(v || 0) * 100) / 100;
const money = (v) => '₹' + Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const cfg = () => config.lossBilling || {};

function allocationsOf(l) {
  const raw = l && l._raw && typeof l._raw === 'object' ? l._raw : {};
  return Array.isArray(raw.dealers) ? raw.dealers : Array.isArray(raw.allocations) ? raw.allocations : [];
}

// Our cost for one piece: the allocations' base_price, weighted by the qty
// each gives (the highest when none says a qty). null when nobody says.
function costOf(l) {
  const raw = (l && l._raw) || {};
  const priced = allocationsOf(l).filter((a) => Number(a.base_price) > 0);
  if (priced.length) {
    const qty = priced.reduce((s, a) => s + (Number(a.qty) || 0), 0);
    if (qty > 0) return round2(priced.reduce((s, a) => s + Number(a.base_price) * (Number(a.qty) || 0), 0) / qty);
    return Math.max(...priced.map((a) => Number(a.base_price)));
  }
  if (Number(raw.base_price) > 0) return Number(raw.base_price);
  return null;
}

// What the customer pays for one piece, incl. GST, after their discount.
function sellOf(l) {
  const raw = (l && l._raw) || {};
  return Number(raw.discounted_unit_price) || Number(raw.price) || Number(l.rate) || null;
}

function taxOf(l) {
  const raw = (l && l._raw) || {};
  return Number(l.taxPercent) || Number(raw.tax_percent) || Number(raw.gst_percent) || Number(raw.gst_rate) || cfg().defaultTaxPercent || 18;
}

// -> { lines: [{ partNo, qty, sell, sellEx, cost, lossUnit, loss }], total } or null.
function check(lines) {
  const out = [];
  for (const l of lines || []) {
    const cost = costOf(l);
    const sell = sellOf(l);
    if (!cost || !sell) continue;
    const sellEx = cfg().costIncludesGst ? sell : round2(sell / (1 + taxOf(l) / 100));
    if (sellEx >= cost - 0.005) continue;
    const qty = Number(l.qty) || 1;
    out.push({ partNo: l.partNo || l.item, qty, sell: round2(sell), sellEx, cost: round2(cost), tax: taxOf(l), discount: Number(l.discountPercent) || Number((l._raw || {}).discount_percent) || 0, lossUnit: round2(cost - sellEx), loss: round2((cost - sellEx) * qty) });
  }
  return out.length ? { lines: out, total: round2(out.reduce((s, x) => s + x.loss, 0)) } : null;
}

// The lines about to be punched, priced the way the punch will price them
// (the customer's discount rules as the admin panel has them now).
async function checkOrder(order, lines) {
  if (cfg().enabled === false) return null;
  let priced = lines;
  try {
    const p = await require('../integrations/dealerPortal')._discountForPunch({ ...order, lines });
    if (p && Array.isArray(p.lines)) priced = p.lines;
  } catch (e) {
    store.log('orders', `${order.id}: loss check read the lines as quoted: ` + String((e && e.message) || e).slice(0, 80));
  }
  const loss = check(priced);
  if (loss) store.log('orders', `${order.id}: LOSS BILLING on ${loss.lines.length} line(s), ${money(loss.total)} below cost — ` + loss.lines.map((x) => `${x.partNo} sells ${money(x.sellEx)} ex-GST vs cost ${money(x.cost)}`).join('; '));
  return loss;
}

const approvers = () => cfg().approvers || {};
const isApprover = (phone) => Boolean(approvers()[store.normPhone(phone)]);
const approverName = (phone) => approvers()[store.normPhone(phone)] || store.normPhone(phone);
const approverNames = () => Object.values(approvers()).join(' / ') || 'the Sales Head';

// The lines, for the approver.
function lossRows(loss) {
  return loss.lines.map(
    (x, i) =>
      `${i + 1}. ${x.partNo} × ${x.qty} — sells ${money(x.sell)} incl. GST (${money(x.sellEx)} ex-GST${x.discount ? `, ${x.discount}% off` : ''}) vs cost ${money(x.cost)} → *loss ${money(x.loss)}*`,
  );
}

module.exports = { check, checkOrder, costOf, sellOf, lossRows, money, isApprover, approverName, approverNames, approvers };
