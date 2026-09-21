'use strict';
// What a part costs the customer.
//
// Until 12 Sep every "Price?" went to a person. Founder: "KYON PRICE PORTAL PE
// NHI HAI KYA". It is there — but not where the bot was looking, and one of
// the numbers must never be read out. Measured on the live portal and Odoo:
//
//   * the availability call (`PUSH_ORDER/analyze`) returns NO price at all,
//     only allocations. That is why the bot had nothing to say.
//   * `/search` returns `price`, and that is our PURCHASE price (11189M72R00:
//     139.51, exactly Odoo's standard_price). Quoting it would hand the
//     customer our cost. It is never used here.
//   * Odoo's `list_price` IS the MRP. Checked against real order lines:
//     71731M69R00 → 64/64, 4110002810 → 1791/1791, 4130002810 → 1637/1637.
//   * What the customer actually pays is MRP minus THEIR discount. Kalra's
//     order 486: mrp 64, item_discount_per 12, discounted_unit_price 56.32 —
//     and 8% on the Hyundai lines. The rule lives in the portal
//     (`discount_rule_id`), which the API does not expose before an order.
//
// So: MRP always, and the net rate only when this customer's OWN past order
// shows the discount for that same part. A rate we cannot stand behind is not
// quoted — it goes to a person, as before.
const store = require('../store');

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function money(v) {
  const n = num(v);
  if (n === null) return null;
  return n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

const norm = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// MRP, straight from Odoo's price list.
async function mrpFor(partNos) {
  const odoo = require('../integrations/odoo');
  const out = new Map();
  if (!odoo.enabled() || !partNos.length) return out;
  try {
    const rows = await odoo._call(
      'product.product',
      'search_read',
      [[['default_code', 'in', partNos]]],
      { fields: ['default_code', 'list_price'], limit: 20 },
    );
    for (const r of rows) if (num(r.list_price)) out.set(norm(r.default_code), num(r.list_price));
  } catch (e) {
    store.log('rate', 'Odoo MRP lookup failed: ' + String((e && e.message) || e).slice(0, 120));
  }
  return out;
}

// The discount this customer got on this very part, last time they bought it.
// Anything less certain than that is not used to quote a rate.
async function discountsFor(accountName, partNos) {
  const portal = require('../integrations/dealerPortal');
  const out = new Map();
  if (!accountName || !partNos.length) return out;
  let orders = [];
  try {
    orders = await portal.recentOrders(accountName, { limit: 8 });
  } catch (e) {
    store.log('rate', 'past orders lookup failed for ' + accountName + ': ' + String((e && e.message) || e).slice(0, 110));
    return out;
  }
  const want = new Set(partNos.map(norm));
  for (const o of orders) {
    for (const l of o.lines || []) {
      const p = norm(l.part_no);
      if (!want.has(p) || out.has(p)) continue;
      const disc = num(l.item_discount_per);
      if (disc !== null && disc > 0 && disc < 90) out.set(p, disc);
    }
  }
  return out;
}

// GST is on top of the rate and the desk always says so - but not twice.
// When the portal gave the tax percent it is already on every line.
function gstNote(rows, t) {
  if (rows.length && rows.every((r) => r.taxPercent)) return '';
  // Nothing to add: MRP and the customer's rate both already INCLUDE GST
  // (Odoo bill CT-DL-26-27/3227: 10 x 92.4 = ₹924 total, tax "price_include").
  // "GST extra" told customers to add 18% to a price that had it in already.
  return '';
}

// One line per part, in the order they were asked about.
function render(rows, t) {
  let list = rows
    .map((r) => {
      if (r.rate && r.mrp && r.discountPercent) {
        return (
          r.part + ' - MRP ₹' + money(r.mrp) + t(', your rate ₹', ', aapka rate ₹') + money(r.rate) +
          ' (' + r.discountPercent + '% off)' + (r.taxPercent ? ' incl. ' + r.taxPercent + '% GST' : ' incl. GST')
        );
      }
      // MRP always said when known - "Mrp of these parts" with no discount
      // came back as "your rate ₹64" and no MRP at all (13 Sep, live).
      if (r.rate && r.mrp) {
        return (
          r.part + ' - MRP ₹' + money(r.mrp) + t(', your rate ₹', ', aapka rate ₹') + money(r.rate) +
          (Number(r.rate) === Number(r.mrp) ? t(' (no discount)', ' (koi discount nahi)') : '') +
          (r.taxPercent ? ' incl. ' + r.taxPercent + '% GST' : ' incl. GST')
        );
      }
      if (r.rate) return r.part + t(' - your rate ₹', ' - aapka rate ₹') + money(r.rate) + (r.taxPercent ? ' incl. ' + r.taxPercent + '% GST' : ' incl. GST');
      return r.part + ' - MRP ₹' + money(r.mrp) + ' (incl. GST)';
    })
    .join('\n');

  // THE TOTAL.
  //
  // This used to be added only when every row carried a net `rate`, so the
  // commonest case in practice — Odoo MRP with no discount on the account —
  // printed three prices and no sum. 21 Sep, live: a customer asked "Total
  // kitna hoga" against a cart of three parts at ×2 each and never got a
  // figure. MRP is a real price and worth adding up; it is just labelled as
  // MRP so nobody reads it as their net.
  //
  // Never MIX the two. A sum of some net rates and some MRPs is a number
  // that is true of nothing, and in this trade it would be read as the bill.
  // Mixed, or any part we could not price, means no total at all — an
  // incomplete sum is worse than none.
  const qtyOf = (r) => Math.max(1, Number(r.qty) || 1);
  const pcs = rows.reduce((n, r) => n + qtyOf(r), 0);
  const sum = (pick) => rows.reduce((n, r) => n + Number(pick(r)) * qtyOf(r), 0);
  const label = (amount, isNet) => {
    const many = pcs > rows.length; // a quantity is in play, so say what the sum covers
    const head = isNet
      ? many ? t(`Total for ${pcs} pcs`, `${pcs} pcs ka total`) : t('Total', 'Total')
      : many ? t(`Total for ${pcs} pcs at MRP`, `${pcs} pcs ka total (MRP)`) : t('Total at MRP', 'Total (MRP)');
    return '\n\n' + head + ': ₹' + money(amount);
  };

  if (rows.length > 1 || pcs > 1) {
    if (rows.every((r) => r.rate)) {
      const total = sum((r) => r.rate);
      if (total > 0) list += label(total, true);
    } else if (rows.every((r) => r.mrp)) {
      const total = sum((r) => r.mrp);
      if (total > 0) list += label(total, false);
    }
  }
  return list;
}

// What a part costs this customer.
//
// Three places to look, cheapest first:
//   1. the lines already in front of us - the portal answered when the list
//      was priced, and dropping that answer is what sent every rate question
//      to a person while the figure sat one message above (Anik, 12 Sep:
//      "do not drop other information");
//   2. the portal itself, for a customer it knows - `commercial-analyze`
//      returns MRP, the customer's discount, tax and the net rate;
//   3. Odoo's MRP plus whatever discount this customer's own past order shows.
//
// `who` is the account name (old callers pass a string) or
// { name, ctx, lines } - ctx being the resolved portal customer.
async function quoteInner(partNos, who, t) {
  // Upper-cased: Odoo's default_code and the portal catalogue are both
  // case-sensitive. 13 Sep, live: "16510m65l10" found no MRP and the rate
  // went to a person; "16510M65L10" has MRP 105.
  const list = [...new Set((partNos || []).map((p) => String(p || '').trim().toUpperCase()).filter(Boolean))].slice(0, 5);
  if (!list.length) return null;
  const opts = typeof who === 'string' || !who ? { name: who || null } : who;
  const wanted = new Set(list.map(norm));

  // 1. already known, from the list this customer is looking at
  const known = new Map();
  for (const l of opts.lines || []) {
    const p = norm(l.partNo || l.item);
    if (!wanted.has(p) || !l.rate) continue;
    known.set(p, { part: l.partNo || l.item, rate: l.rate, mrp: l.mrp, discountPercent: l.discountPercent, taxPercent: l.taxPercent, qty: l.qty });
  }
  if (known.size === list.length) {
    store.log('rate', 'quoted ' + known.size + ' part(s) from the list already on screen');
    const k = [...known.values()];
    return render(k, t) + gstNote(k, t);
  }

  // 2. the portal, for a customer it knows
  const ctx = opts.ctx || null;
  if (ctx && (ctx.accountId || ctx.buyerId)) {
    try {
      const portal = require('../integrations/dealerPortal');
      const rows = await portal.commercialAnalyze(list.map((p) => ({ item: p, partNo: p, qty: 1 })), ctx);
      const priced = (rows || [])
        .filter((r) => r && r.rate)
        .map((r) => {
          const match = (opts.lines || []).find((l) => norm(l.partNo || l.item) === norm(r.partNo || r.item));
          return { part: r.partNo || r.item, rate: r.rate, mrp: r.mrp, discountPercent: r.discountPercent, taxPercent: r.taxPercent, qty: match ? match.qty : 1 };
        });
      if (priced.length) {
        store.log('rate', 'quoted ' + priced.length + ' part(s) from the portal for account ' + (ctx.accountId || ctx.buyerId));
        return render(priced, t) + gstNote(priced, t);
      }
    } catch (e) {
      store.log('rate', 'commercial-analyze for a rate failed: ' + String((e && e.message) || e).slice(0, 110));
    }
  }

  // 3. Odoo's MRP, and this customer's own discount if a past order shows it
  const [mrp, disc] = await Promise.all([mrpFor(list), discountsFor(opts.name, list)]);
  const rows = [];
  for (const p of list) {
    const m = mrp.get(norm(p));
    if (m === undefined) continue;
    const d = disc.get(norm(p));
    const match = (opts.lines || []).find((l) => norm(l.partNo || l.item) === norm(p));
    rows.push({ part: p, mrp: m, discountPercent: d || null, rate: d ? Math.round(m * (1 - d / 100) * 100) / 100 : null, taxPercent: null, qty: match ? match.qty : 1 });
  }
  if (!rows.length) return null;
  store.log('rate', 'quoted ' + rows.length + ' part(s) from Odoo' + (disc.size ? ' with their own past discount' : ' at MRP'));
  return render(rows, t) + gstNote(rows, t);
}


// `who.label` - the customer this rate is for, when someone asks on their
// behalf - goes on top of the answer.
async function quote(partNos, who, t) {
  const out = await quoteInner(partNos, who, t);
  const label = who && typeof who === 'object' ? who.label : null;
  // "For Kalra Motors:", not a bare name on top - on its own it did not say
  // that the rates below are THAT customer's.
  return out && label ? t('For ' + label + ':', label + ' ke liye:') + String.fromCharCode(10) + out : out;
}

module.exports = { quote, _internals: { mrpFor, discountsFor, render } };
