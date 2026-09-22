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
const config = require('../config');

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

// NO ODOO PRICE HERE, AND THAT IS THE POINT.
//
// Odoo's list_price used to be the fallback when the portal could not price
// something, and the two do not agree: 23820M79J20 is 3,599 on the portal
// and 3,489 in Odoo (21 Sep). The order is punched against the PORTAL, so an
// Odoo figure quoted to a customer is a price they will not be charged —
// a misquote, and the kind that is only discovered on the bill.
//
// So the portal is the only source of a price a customer sees. When it
// cannot price a part, nobody guesses: quote() returns null and the question
// goes to a person, which is what this bot already does with anything it is
// not sure of. Odoo is still read for the LEDGER and credit notes
// (core/customerLookup) — that is their account, not a quote.

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

  // 2. the portal — MRP, and this customer's own discount when it knows them
  //
  // The portal is the price of record: it carries the MRP the catalogue
  // actually holds and the discount set against THAT customer's account.
  // Odoo below is the fallback, and its MRP can differ (21 Sep: 23820M79J20
  // is 3,599 on the portal and 3,489 in Odoo), so the portal is asked first
  // whenever it can answer.
  //
  // Two ways it can answer. With a customer the portal knows, we price
  // against their account and they get their own discount and net rate. With
  // a number that is not registered yet there is no customer discount to
  // give, so we price against the house account and keep ONLY the MRP — the
  // discount on that account is ours, not theirs, and quoting it as their
  // rate would be a promise nobody made.
  const ctx = opts.ctx || null;
  const theirAccount = (ctx && (ctx.accountId || ctx.buyerId)) || null;
  const priceAccount = theirAccount || config.dealerPortal.listPriceAccountId || null;
  if (priceAccount) {
    const mrpOnly = !theirAccount;
    try {
      const portal = require('../integrations/dealerPortal');
      const rows = await portal.commercialAnalyze(
        list.map((p) => ({ item: p, partNo: p, qty: 1 })),
        { ...(ctx || {}), accountId: priceAccount },
      );
      const priced = (rows || [])
        .filter((r) => r && (mrpOnly ? r.mrp : r.rate))
        .map((r) => {
          const match = (opts.lines || []).find((l) => norm(l.partNo || l.item) === norm(r.partNo || r.item));
          return {
            part: r.partNo || r.item,
            rate: mrpOnly ? null : r.rate,
            mrp: r.mrp,
            discountPercent: mrpOnly ? null : r.discountPercent,
            taxPercent: r.taxPercent,
            qty: match ? match.qty : 1,
          };
        });
      if (priced.length) {
        store.log(
          'rate',
          'quoted ' + priced.length + ' part(s) from the portal ' +
            (mrpOnly ? 'at MRP (account ' + priceAccount + ', customer not registered)' : 'for account ' + priceAccount),
        );
        return render(priced, t) + gstNote(priced, t);
      }
    } catch (e) {
      store.log('rate', 'commercial-analyze for a rate failed: ' + String((e && e.message) || e).slice(0, 110));
    }
  }

  // The portal could not price it, so nobody does. Null sends the question
  // to a person — the same thing this bot does with any part it cannot
  // identify. A guessed price is worse than a short wait.
  store.log('rate', 'the portal could not price ' + list.length + ' part(s) — asking a person');
  return null;
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

// The price of each part, for a short list the customer picks from: part
// number -> { mrp, rate, discountPercent } in one portal call. Same rule as
// quote(): their own rate when the portal knows them, MRP only when it does
// not. Parts it cannot price are simply missing - never guessed.
async function prices(partNos, who) {
  const list = [...new Set((partNos || []).map((p) => String(p || '').trim().toUpperCase()).filter(Boolean))].slice(0, 8);
  const out = new Map();
  if (!list.length) return out;
  const ctx = (who && who.ctx) || null;
  const theirAccount = (ctx && (ctx.accountId || ctx.buyerId)) || null;
  const priceAccount = theirAccount || config.dealerPortal.listPriceAccountId || null;
  if (!priceAccount) return out;
  try {
    const portal = require('../integrations/dealerPortal');
    const rows = await portal.commercialAnalyze(
      list.map((p) => ({ item: p, partNo: p, qty: 1 })),
      { ...(ctx || {}), accountId: priceAccount },
    );
    for (const r of rows || []) {
      if (!r || !r.mrp) continue;
      out.set(norm(r.partNo || r.item), {
        mrp: r.mrp,
        rate: theirAccount ? r.rate : null,
        discountPercent: theirAccount ? r.discountPercent : null,
      });
    }
  } catch (e) {
    store.log('rate', 'prices for a list failed: ' + String((e && e.message) || e).slice(0, 110));
  }
  return out;
}

// One line of that list: "MRP ₹2,982" or "MRP ₹2,982, aapka rate ₹2,624".
function priceText(p, t) {
  if (!p) return '';
  if (p.rate && Number(p.rate) !== Number(p.mrp)) return 'MRP ₹' + money(p.mrp) + t(', your rate ₹', ', aapka rate ₹') + money(p.rate);
  return 'MRP ₹' + money(p.mrp);
}

// The whole order, priced: every line with its pieces, what one costs, what
// the line comes to, and the total. quote() stops at five parts and prints no
// quantities; an order of eighteen lines needs all eighteen.
// lines: [{ partNo, qty, available?, source? }]
async function priceList(lines, who, t) {
  const rows = (lines || []).filter((l) => l && l.partNo);
  if (!rows.length) return '';
  const nos = [...new Set(rows.map((l) => String(l.partNo).toUpperCase()))];
  const got = new Map();
  for (let i = 0; i < nos.length; i += 8) {
    const part = await prices(nos.slice(i, i + 8), who);
    for (const [k, v] of part) got.set(k, v);
  }
  let total = 0;
  let complete = true;
  const kinds = new Set();
  const out = rows.map((l, i) => {
    const qty = Math.max(1, Number(l.qty) || 1);
    const p = got.get(norm(l.partNo));
    const note =
      l.source === 'unavailable' ? t(' (on order)', ' (on order)')
        : Number(l.available) > 0 && Number(l.available) < qty ? t(` (only ${l.available} available)`, ` (sirf ${l.available} available)`)
          : '';
    if (!p) {
      complete = false;
      return `${i + 1}. ${l.partNo} x${qty} - ${t('price to follow', 'price confirm karke')}${note}`;
    }
    const unit = Number(p.rate || p.mrp);
    kinds.add(p.rate ? 'net' : 'mrp');
    total += unit * qty;
    return `${i + 1}. ${l.partNo} x${qty} - ${priceText(p, t)} = ₹${money(unit * qty)}${note}`;
  });
  // A total only when every line is priced the same way - see render().
  const pcs = rows.reduce((n, l) => n + Math.max(1, Number(l.qty) || 1), 0);
  let foot = '';
  if (complete && kinds.size === 1 && total > 0) {
    foot = '\n\n' + (kinds.has('net') ? t(`Total (${pcs} pcs): ₹`, `${pcs} pcs ka total: ₹`) : t(`Total at MRP (${pcs} pcs): ₹`, `${pcs} pcs ka total (MRP): ₹`)) + money(total);
  }
  return out.join('\n') + foot;
}

module.exports = { quote, prices, priceText, priceList, norm, _internals: { render } };
