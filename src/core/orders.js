'use strict';
// Sales Order lifecycle.
//   draft (held locally) -> customer modifies freely -> final "yes"
//   -> punched into the Dealer Portal via its confirm API -> done.
//
// There is no order split any more. The Dealer Portal owns everything after
// the punch: PO to the vendor, warehouse, transit, invoicing. This process
// only captures the order and reports status back to the customer.
const store = require('../store');
const availability = require('./availability');
const lang = require('./lang');
const appConfig = require('../config');
const portal = require('../integrations/dealerPortal');
const inquiries = require('./inquiries');

// A draft the customer walked away from days ago is not their current order.
// Reusing it silently mixes yesterday's items into today's photo — which is
// exactly how "Brake Pad x 5" appeared at the top of a 27-line order that
// never mentioned brake pads.
// chatId -> what we just closed, so it can be mentioned once and then forgotten
const chatState = require('./chatState');
const lastExpired = chatState.slot('orders.expiredNotice');

// Read AND clear. The customer hears about a retired cart exactly once; the
// next message is about their new order, not about old business.
function takeExpiredNotice(chatId) {
  const n = lastExpired.get(chatId);
  lastExpired.delete(chatId);
  // Survives a restart now, so a notice from yesterday is not news any more.
  if (!n || !n.items || (n.at && Date.now() - n.at > 24 * 60 * 60 * 1000)) return '';
  const t = lang.for(chatId);
  return t(
    `(Your previous order ${n.id} — ${n.items} item, ${n.hours}h old — has been closed. This is a new order. Tell me if you still want the old one.)`,
    `(Aapka pichhla order ${n.id} — ${n.items} item, ${n.hours}h purana — band kar diya hai. Ye naya order hai. Purana chahiye to bata dijiye.)`
  );
}

function findDraft(chatId) {
  const config = require('../config');
  const maxAgeMs = config.dealerPortal.quoteMaxAgeHours * 60 * 60 * 1000;
  const d = store.orders().find((o) => o.chatId === chatId && o.status === 'draft') || null;
  if (!d) return null;
  // TWO clocks, either one retires the draft:
  //   idle  — the customer stopped replying and came back much later
  //   total — the draft has simply been alive too long
  // The idle clock alone is not enough: quotedAt is bumped on every single
  // touch, so a cart poked once a day never ages out. That is exactly how a
  // 27-line order created four days earlier was still collecting today's
  // items, with a "Brake Pad x 5" nobody had mentioned since.
  const now = Date.now();
  const idleMs = now - new Date(d.quotedAt || d.createdAt).getTime();
  const totalMs = now - new Date(d.createdAt).getTime();
  const reason =
    idleMs > maxAgeMs
      ? `idle ${Math.round(idleMs / 3600000)}h`
      : totalMs > maxAgeMs
        ? `open ${Math.round(totalMs / 3600000)}h`
        : null;
  if (reason) {
    d.status = 'expired';
    store.save();
    store.log('orders', `${d.id} draft expired (${reason}) — starting fresh`);
    // Remember what was dropped so the customer can be TOLD. Closing their
    // cart silently means they look for it later, find it empty, and think we
    // lost their order — the same worry the bot exists to remove.
    lastExpired.set(chatId, { id: d.id, items: d.lines.length, hours: Math.round(totalMs / 3600000), at: Date.now() });
    return null;
  }
  lastExpired.delete(chatId);
  return d;
}

function getOrCreateDraft(chatId, customer) {
  let o = findDraft(chatId);
  if (!o) {
    o = {
      id: 'ORD-' + store.nextSeq('order'),
      chatId,
      customer: customer || chatId,
      lines: [], // resolved lines from availability.resolve()
      status: 'draft',
      soNumber: null,
      createdAt: new Date().toISOString(),
    };
    store.orders().push(o);
    store.save();
  }
  return o;
}

// Merge already-resolved lines into the draft. Re-asks the portal when a
// quantity changes, so availability always reflects the CURRENT quantity.
// `replace` is for PHOTO orders: re-sending the same picture means "read it
// again", not "double everything". Typed items still add up, because a
// customer listing more parts genuinely wants them added.
function addLines(order, resolvedLines, { replace = false } = {}) {
  // Anything the customer was asked about is now out of date: the ask was
  // about the old list, and a later "ok" must not punch a changed one.
  order.confirmAskedAt = null;
  for (const line of resolvedLines) {
    // A row that came from the customer's own file identifies ITSELF (`key`),
    // so two identical rows stay two rows and ORDER 272's quantity can never
    // overwrite ORDER 179's. Only typed items merge by name, which is what a
    // customer listing more parts in chat actually means.
    // Match on the PART NUMBER the portal resolved, not only on the customer's
    // wording. The same label photographed twice can be read back as
    // "17521m52TOO" and "17521M52T00" — one character apart, the same part —
    // and the cart ended up holding both. Once the portal has named them, they
    // are the same line.
    const samePart = (a, b) =>
      a.partNo && b.partNo
        ? availability.normPart(a.partNo) === availability.normPart(b.partNo)
        : availability.sameItem(a.item, b.item);

    const existing = line.key
      ? order.lines.find((l) => l.key === line.key)
      : order.lines.find((l) => !l.key && samePart(l, line) && (l.ref || null) === (line.ref || null));
    if (existing) {
      existing.qty = replace ? line.qty : existing.qty + line.qty;
      Object.assign(existing, line, { qty: existing.qty, requested: existing.requested || line.item });
      existing.partial = existing.available > 0 && existing.available < existing.qty;
    } else {
      order.lines.push(line);
    }
  }
  order.quotedAt = new Date().toISOString();
  store.save();
  return order;
}

// A line answers to three names: the portal's ("DISC PAD"), the part number,
// and what the customer actually typed. removeItem learned this the hard way;
// setQty had the same blind spot, so "PART-4 ki qty 3 kr do" — and every
// line-number quantity edit — silently found nothing.
function lineNamed(l, item) {
  return (
    availability.sameItem(l.item, item) ||
    availability.sameItem(l.requested, item) ||
    (l.partNo && availability.normPart(l.partNo) === availability.normPart(item))
  );
}

async function setQty(order, item, qty) {
  const line = order.lines.find((l) => lineNamed(l, item));
  if (!line) return false;
  if (qty <= 0) {
    order.lines = order.lines.filter((l) => l !== line);
    store.save();
    return true;
  }
  const fresh = await availability.resolveOne(line.partNo || line.item, qty);
  Object.assign(line, fresh, { requested: line.requested || line.item });
  store.save();
  return true;
}

function removeItem(order, item) {
  const before = order.lines.length;
  // A line has three names: the portal's ("DISC PAD"), the part number, and
  // what the customer actually typed. Only the first was checked, so
  // "55810M75J30 hata do" never found its own line and the customer was told
  // the part was not in an order it was sitting in.
  order.lines = order.lines.filter((l) => !lineNamed(l, item));
  store.save();
  return order.lines.length < before;
}

function cancel(order) {
  order.status = 'cancelled';
  store.save();
}

// One line per item, the way a counter salesman answers: part, qty, what the
// customer actually gets. No decoration.
function lineText(l, t) {
  t = t || ((en) => en);
  const name = availability.displayName(l);
  // The money, on the same line as the stock. One rule, in
  // availability.priceOf: a customer the portal knows sees the rate it priced
  // for THEIR account; anyone else sees MRP and never the logged-in account's
  // negotiated discount.
  const price = availability.priceOf(l);
  if (l.source === 'unavailable')
    return `${name} x${l.qty}${price} - on order, ETA = ${appConfig.onOrderEtaDays} days`;
  if (l.source === 'unknown' || l.source === 'unidentified')
    return `${name} x${l.qty} - ` + t('checking', 'check kar raha hoon');
  if (l.partial)
    // Founder, 14 Sep: never "rest on order" - say what is there.
    return `${name} x${l.qty}${price} - ` + t(`only ${l.available} available`, `sirf ${l.available} available`);
  // How MUCH is on the shelf is our business, not the customer's. Founder's
  // call: they asked for a quantity, they are told they can have it. A stock
  // figure only invites "hold all ninety for me".
  return `${name} x${l.qty}${price} - ` + t('available', 'hai');
}

// Acknowledge ONLY what this message changed. Re-printing a 28-line cart after
// every single part is not how anyone on either side of this trade writes:
// the customer sends a part, the counter says what they can do with it. The
// full cart is available on demand and is always shown before a confirm.
// `pending` are items still being confirmed by a human. They belong with the
// other answers about this message, ABOVE the call to action — putting them
// after "YES = confirm" reads as if they were part of a different reply.
function ack(lines, order, pending) {
  const t = lang.for(order && order.chatId);
  const rows = lines.map((l) => lineText(l, t));
  for (const p of pending || [])
    rows.push(
      `${availability.displayName(p)} - ` + t('checking, will confirm shortly', 'check karke confirm karta hoon')
    );
  // NO "confirm?" here. A customer sending eight parts one after another was
  // asked to confirm eight times, which is not how anyone talks — the counter
  // man answers each part and asks once, at the end, when you stop. That ask
  // now comes from the bot after a pause (see customerBot's confirm nudge), so
  // this is only the answer to what they just sent.
  // ...and NO running total either. The customer knows what is in their own
  // order; printing "4 items in the order" after every part is the bot talking
  // about itself in the middle of a conversation. The count belongs in exactly
  // one place — the ask at the end, once they have stopped sending parts (see
  // customerBot's confirm nudge) — and in *LIST*, when they ask for it.
  return rows.join('\n');
}

function summary(order) {
  const t = lang.for(order && order.chatId);
  if (!order.lines.length) return t('Cart is empty.', 'Order khaali hai.');
  // When the file carried the customer's own order numbers, show the cart the
  // way THEY filed it. A flat list of 71 parts cannot be checked against the
  // four orders they actually sent.
  const refs = [...new Set(order.lines.map((l) => l.ref).filter(Boolean))];
  if (refs.length > 1) {
    return refs
      .map((ref) => {
        const g = order.lines.filter((l) => l.ref === ref);
        return `*ORDER ${ref}* (${g.length} item)\n` + g.map((l, i) => `${i + 1}. ${lineText(l, t)}`).join('\n');
      })
      .join('\n\n');
  }
  return order.lines
    .map((l, i) => {
      const name = availability.displayName(l);
      const price = availability.priceOf(l);
      const state =
        l.source === 'unavailable'
          ? `on order, ETA = ${appConfig.onOrderEtaDays} days`
          : l.source === 'unknown' || l.source === 'unidentified'
            ? t('checking', 'check kar raha hoon')
            : l.partial
              ? t(`only ${l.available} available`, `sirf ${l.available} available`)
              : t('available', 'hai');
      return `${i + 1}. ${name} x ${l.qty}${price} — ${state}`;
    })
    .join('\n');
}

// Quoted quantities go stale — another customer's order may take the same
// stock in between. So a confirm ALWAYS re-checks with the portal first.
//
// Returns one of:
//   { stale: true, ... }    quantities moved (or the draft aged out) — NOTHING
//                           was ordered; the caller must show the new figures
//                           and wait for a fresh yes. The order is never placed
//                           on the same message that refreshed the numbers, so
//                           the customer agrees to the figure they were shown.
//   { soNumber, backordered }  placed.
// ONE punch per order, even when two "yes" arrive at the same moment.
//
// Measured 12 Sep on the mock portal: two yes messages one after the other
// punch once (the draft is already confirmed by then), but two arriving
// together punch TWICE - a duplicate webhook, or a double tap, and the
// customer has two sales orders. The draft's own status cannot stop that,
// because both calls read it before either writes.
const inFlight = new Set();

// `opts.approvedBy`: a Sales Head said "OK ORD-…" to this order. That is the
// one thing that places it while ORDER_CONFIRM_ENABLED is off — the switch
// stays off for everything else — and it is placed as it stands now: stock is
// re-read and whatever is there is punched, without asking the customer again.
async function confirm(order, opts = {}) {
  if (!order.lines.length) throw new Error('nothing to confirm');

  // Already being punched by another message this second.
  if (inFlight.has(order.id)) {
    store.log('orders', order.id + ' confirm ignored - already being punched');
    return { busy: true };
  }
  inFlight.add(order.id);
  try {
    return await punch(order, opts);
  } finally {
    inFlight.delete(order.id);
  }
}

// The punch itself. Only ever called through confirm() above, which holds
// the lock for the whole of it.
async function punch(order, opts = {}) {

  const config = require('../config');

  // Refused BEFORE the portal is touched, so no stray "yes" during testing can
  // create an order a person then has to cancel by hand. Checked here rather
  // than at the call site because this is the only door to the confirm API.
  // AN ORDER IS FOR SOMEBODY. The customer the portal bills is
  // order.portalCustomer; a cart that only carries order.customer (the
  // agent's, before 25 Sep) takes it from there. Without one, the portal
  // makes an order with no buyer — no customer on it, no Odoo SO (portal order
  // 1214) — so nothing is sent at all.
  if (!(order.portalCustomer && order.portalCustomer.buyerId) && order.customer && typeof order.customer === 'object' && order.customer.buyerId) {
    order.portalCustomer = order.customer;
    store.save();
  }
  if (!(order.portalCustomer && order.portalCustomer.buyerId)) {
    store.log('orders', `${order.id} confirm REFUSED — no portal customer on the order`);
    return { noCustomer: true };
  }

  if (!config.dealerPortal.confirmEnabled && !opts.approvedBy) {
    store.log('orders', `${order.id} confirm BLOCKED — ORDER_CONFIRM_ENABLED is not true (testing mode)`);
    return { blocked: true, lines: order.lines.length };
  }
  const quotedAt = new Date(order.quotedAt || order.createdAt).getTime();
  const ageMin = (Date.now() - quotedAt) / 60000;

  // Too old to be worth refreshing — the intent is gone, not just the numbers.
  if (!opts.approvedBy && ageMin > config.dealerPortal.quoteMaxAgeHours * 60) {
    order.status = 'expired';
    store.save();
    return { stale: true, expired: true };
  }

  // Re-ask the portal for exactly what is in the draft.
  const fresh = await availability.resolve(
    order.lines.map((l) => ({ item: l.partNo || l.item, qty: l.qty })),
    order.portalCustomer || null
  );
  const before = order.lines.map((l) => l.available || 0);
  order.lines = fresh.map((f, i) => ({
    ...f,
    requested: order.lines[i].requested || order.lines[i].item,
    ref: order.lines[i].ref || null, // the customer's own order number
  }));
  order.quotedAt = new Date().toISOString();
  store.save();

  const moved = fresh
    .map((f, i) => ({ line: f, was: before[i], now: f.available || 0 }))
    .filter((c) => c.now !== c.was);

  // Only interrupt when the change actually matters to the customer, or when
  // the quote had gone stale on time anyway.
  if (!opts.approvedBy && moved.length && ageMin > config.dealerPortal.quoteTtlMinutes) {
    store.log('orders', `${order.id} confirm: stock moved since the quote — asking again`);
    return { stale: true, moved, ageMin: Math.round(ageMin) };
  }

  // ONE SALES ORDER PER CUSTOMER ORDER NUMBER.
  //
  // A pending list carries several of the customer's own orders ("ORDER NO
  // 179", "260", ...). They track goods and expect their bills by those
  // numbers, so punching the lot as a single sales order would hand them one
  // invoice for four orders and no way to reconcile it. Each group goes in
  // separately, carrying its number as external_order_reference.
  // IN STOCK ONLY (founder, 14 Sep: "jo hai unka hi so punch hoga... punch avl
  // item ka hi hoga abhi"). A part with nothing in stock stays out of the SO; a
  // part with some stock is punched for what is there. 14 Sep, live: SO 687 was
  // sent ten lines, kept 4 pieces of one, and nine parts silently went nowhere.
  const inStock = (l) =>
    l.source !== 'unidentified' && l.source !== 'unknown' && l.source !== 'unavailable' && (Number(l.available) || 0) > 0;
  const toPunch = order.lines.filter(inStock).map((l) => ({ ...l, qty: Math.min(l.qty, Number(l.available) || 0) }));
  const skipped = order.lines.filter((l) => !inStock(l));
  const short = order.lines
    .filter((l) => inStock(l) && (Number(l.available) || 0) < l.qty)
    .map((l) => ({ item: l.requested || l.item, partNo: l.partNo || l.item, asked: l.qty, punched: Number(l.available) || 0 }));
  if (!toPunch.length) {
    store.log('orders', `${order.id} confirm: nothing in stock - no SO punched`);
    return { nothingInStock: true, skipped };
  }

  const groups = new Map();
  for (const l of toPunch) {
    const k = l.ref || '';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(l);
  }

  const placed = [];
  for (const [ref, lines] of groups) {
    const res = await portal.confirm({ ...order, lines, customerRef: ref || null });
    const soNumber = res.soNumber;
    // A punch can make TWO portal orders - what is in stock, and what is on
    // order - and the draft SO review has to show both.
    placed.push({
      soNumber,
      unallocatedOrderId: res.unallocatedOrderId || null,
      portalLines: res.portalLines || null,
      odooSoName: res.odooSoName || null,
      ref: ref || null,
      lines: lines.length,
    });
    store.log(
      'orders',
      `${order.id}${ref ? ' [' + ref + ']' : ''} confirmed -> ${soNumber} (${lines.length} line(s))`
    );
  }

  order.soNumber = placed[0].soNumber;
  order.placed = placed;
  order.status = 'confirmed';
  order.confirmedAt = new Date().toISOString();
  store.save();

  const backordered = order.lines.filter((l) => l.source === 'unavailable' || l.partial);
  return {
    soNumber: placed[0].soNumber,
    unallocatedOrderId: placed[0].unallocatedOrderId || null,
    odooSoName: placed[0].odooSoName || null,
    placed,
    backordered,
    skipped,
    short,
    punchedLines: toPunch.map((l) => ({ partNo: l.partNo || l.item, qty: l.qty })),
  };
}

module.exports = { findDraft, takeExpiredNotice, getOrCreateDraft, addLines, setQty, removeItem, cancel, summary, ack, lineText, confirm };
