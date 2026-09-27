'use strict';
// ONE PART, AS THE CUSTOMER NEEDS TO HEAR ABOUT IT.
//
// check_stock_and_price and resolve_order_list both answer "do you have it,
// how many, what does it cost me". They used to say only a status and a
// price: a short line was "part_in_stock_rest_on_order" with no number, so
// the customer could not be told how many they would get now, and the
// discount was folded into a price string the agent could not explain —
// "Isme discount ke baad kitna hoga" went to a person (25 Sep, live).
//
// Stock stays internal (prompt: never tell a customer how many we have).
// The one number given is when we are SHORT of what they asked for: how many
// of THEIR pieces we can send now. That is their order, not our shelf.
const appConfig = require('../../config');
const availability = require('../../core/availability');

function stockOf(line, qty) {
  const src = line.source || 'unknown';
  if (src === 'unidentified') return { status: 'not_recognised_by_portal' };
  if (src === 'unknown') return { status: 'not_confirmed_yet' };
  const have = Math.max(0, Number(line.available) || 0);
  const eta = appConfig.onOrderEtaDays;
  if (src === 'unavailable' || have === 0) return { status: 'out_of_stock', canSupplyNow: 0, etaDays: eta };
  if (have < qty || src === 'partial') {
    const now = Math.min(have, qty);
    if (now >= qty) return { status: 'in_stock' };
    return { status: 'short', canSupplyNow: now, restOnOrder: qty - now, etaDays: eta };
  }
  return { status: 'in_stock' };
}

// Money for THIS customer only (availability.priceOf decides what may be
// shown). The discount fields appear only when the price is theirs.
function moneyOf(line) {
  const price = availability.priceOf(line).replace(/^\s*—\s*/, '') || null;
  const out = { price };
  const pct = Number(line.discountPercent);
  if (line.pricedForCustomer && pct > 0) {
    out.discount = {
      percent: pct,
      rule: line.discountRule || null,
      mrp: Number(line.mrp) > 0 ? 'Rs.' + Math.round(Number(line.mrp)) : null,
      priceAfterDiscount: Number(line.rate) > 0 ? 'Rs.' + Math.round(Number(line.rate)) : null,
      gstIncluded: Number(line.taxPercent) > 0 ? Number(line.taxPercent) + '%' : null,
    };
  }
  return out;
}

function partFacts(line, { asked, qty, qtyGiven } = {}) {
  const q = Math.max(1, Number(qty) || Number(line.qty) || 1);
  return {
    asked: asked || line.item || line.partNo,
    partNo: line.partNo || line.item,
    name: availability.displayName(line),
    qtyAsked: qtyGiven === false ? null : q,
    ...stockOf(line, q),
    ...moneyOf(line),
  };
}

module.exports = { partFacts, stockOf, moneyOf };
