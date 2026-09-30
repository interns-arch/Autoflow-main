'use strict';
// ADVANCE ORDERS FOR PARTS ON ORDER (founder, 26 Sep): "on order which is ETA
// firstly send to customer to approve for ETA and explain about ETA to
// customer and when customer allow the ETA then update advance order for the
// customer on dealer portal".
//
// When an order is placed, whatever could not be punched - no stock, or the
// rest of a short line - is offered to the CUSTOMER with its ETA, explained in
// plain words. Nothing is booked until they say yes. On a yes, those parts go
// to the Dealer Portal as an advance (unallocated) order for that customer; on
// a no, nothing is booked. The offer is made on the customer's own number;
// only when there is none it is made to the salesman who punched the order.
const config = require('../config');
const store = require('../store');
const chatState = require('./chatState');

// chatId -> { id, orderId, soNumber, ctx, lines, etaDate, askedAt, agentChat, agentName, customerName }
// (askedAt, not `at`: the chatState janitor would drop it after a day; an
// offer stands for OFFER_DAYS.)
const offers = chatState.slot('advance.offers');
const OFFER_DAYS = 3;

const YES = /^\s*(haan+|han|ha|haa|yes|y|ok|okay|ji|ji haan|sahi|sahi hai|theek|thik|theek hai|thik hai|done|confirm|book|book karo|book kar do|kar do|karo|chalega|chalegi|manzoor|approved?|accept(ed)?|ADV_YES)\b/i;
const NO = /^\s*(nahi+|nhi|no|n|na|mat|mat karo|rehne do|rhne do|nahi chahiye|cancel|reject|ADV_NO)\b/i;

// YYYY-MM-DD in India, and n days on.
const ymd = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: config.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const addDays = (dateStr, n) => {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const pretty = (dateStr) => new Date(dateStr + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'long', timeZone: 'UTC' });

// The ETA of each part: the portal's own date when its ETA record has one
// still ahead of us, otherwise the standard ON_ORDER_ETA_DAYS from today.
// -> lines with .etaDate, and the latest of them.
async function withEta(lines, now = new Date()) {
  const portal = require('../integrations/dealerPortal');
  const today = ymd(now);
  const standard = addDays(today, config.onOrderEtaDays);
  const out = [];
  for (const l of lines) {
    let date = null;
    try {
      const rows = await portal.etaMapping(l.partNo || l.item);
      const dates = rows
        .map((r) => String(r.mappedEta || r.eta || '').slice(0, 10))
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= today)
        .sort();
      date = dates[0] || null;
    } catch (_) {
      date = null;
    }
    out.push({ ...l, etaDate: date || standard, etaFromPortal: Boolean(date) });
  }
  const etaDate = out.map((l) => l.etaDate).sort().pop() || standard;
  return { lines: out, etaDate };
}

// What was asked for and not punched, from the confirm result and the lines
// an agent took out of the cart ("only available items") before approval.
function notPunched(order, res) {
  const byPart = new Map();
  const add = (l, qty) => {
    const partNo = String(l.partNo || l.item || '').trim();
    if (!partNo || !(qty > 0)) return;
    const line = (order.lines || []).find((x) => String(x.partNo || x.item) === partNo) || {};
    const cur = byPart.get(partNo);
    if (cur) cur.qty += qty;
    else byPart.set(partNo, { partNo, item: l.item || line.item || partNo, qty, price: l.price != null ? l.price : line.rate != null ? line.rate : line.price != null ? line.price : null, mrp: l.mrp || line.mrp || null });
  };
  for (const l of (res && res.skipped) || []) {
    if (l.source === 'unidentified' || l.source === 'unknown') continue; // not a known part: nothing to book
    add(l, Number(l.qty) || 0);
  }
  for (const l of (res && res.short) || []) add({ partNo: l.partNo, item: l.item }, (Number(l.asked) || 0) - (Number(l.punched) || 0));
  for (const l of order.leftOutLines || []) add(l, Number(l.qty) || 0);
  return [...byPart.values()];
}

function offerText(o, t) {
  const rows = o.lines.map((l) => `• ${l.partNo}${l.item && l.item !== l.partNo ? ` (${String(l.item).split('|')[0].trim()})` : ''} × ${l.qty} — ETA ${pretty(l.etaDate)}`);
  const who = o.customerName ? `${o.customerName} ji` : 'Sir';
  return t(
    [
      `Namaste ${who} 🙏`,
      '',
      `${o.soNumber ? `Your order ${o.soNumber} is placed. ` : ''}These parts are not in stock with us right now:`,
      ...rows,
      '',
      `*What ETA means:* ETA is the "estimated time of arrival" — the date we expect these parts to reach our warehouse from the supplier. We expect them by *${pretty(o.etaDate)}*. It is an estimate, so it can move by a day or two; we will keep you posted.`,
      '',
      `If this ETA works for you, we will book them for you *in advance*: they are reserved in your name and sent to you as soon as they arrive — you do not need to order again. Nothing is billed until they are dispatched.`,
      '',
      `Reply *YES* to book them in advance, or *NO* if you do not need them.`,
    ].join('\n'),
    [
      `Namaste ${who} 🙏`,
      '',
      `${o.soNumber ? `Aapka order ${o.soNumber} place ho gaya hai. ` : ''}Ye parts abhi hamare stock mein nahi hain:`,
      ...rows,
      '',
      `*ETA ka matlab:* ETA yaani "estimated time of arrival" — wo tareekh jab tak ye parts supplier se hamare warehouse pahunchne ki ummeed hai. Ye *${pretty(o.etaDate)}* tak aane chahiye. Ye andaaza hai, ek-do din aage-peeche ho sakta hai; hum aapko batate rahenge.`,
      '',
      `Agar ye ETA aapko theek hai, to hum inhe aapke liye *advance mein book* kar dete hain: parts aapke naam pe rok liye jayenge aur aate hi aapko bhej diye jayenge — dobara order nahi karna padega. Bill dispatch ke time hi banega.`,
      '',
      `Advance booking ke liye *HAAN* likhiye, ya zaroorat nahi hai to *NAHI*.`,
    ].join('\n'),
  );
}

// Offer the ETA. `to` is the chat the offer goes to (the customer's own, or
// the salesman's when there is no customer number).
async function offer(bot, { order, res, soNumber, to, customerName, agentChat = null, agentName = null, now = new Date() }) {
  const lines = notPunched(order, res);
  if (!lines.length) return null;
  const { lines: eta, etaDate } = await withEta(lines, now);
  const o = {
    id: order.id,
    orderId: order.id,
    soNumber: soNumber || null,
    ctx: order.portalCustomer || null,
    actorUserId: order.actorUserId || null,
    // The mobile it came from, so the booking is punched on that agent's own
    // portal login too (dealerPortal.punchIdentity).
    punchedBy: order.punchedBy || null,
    customerName: customerName || (order.portalCustomer && order.portalCustomer.name) || null,
    lines: eta,
    etaDate,
    askedAt: Date.now(),
    agentChat,
    agentName,
    to,
  };
  const lang = require('./lang');
  const t = lang.for(to);
  const escalation = require('./escalation');
  const phone = String(to).split('@')[0];
  if (/^\d{10,15}$/.test(phone)) await escalation.ensureWindow(bot.transport, phone, `Parts on order for ${o.customerName || 'you'} — ETA ${pretty(etaDate)}`, soNumber || order.id).catch(() => {});
  const text = offerText(o, t);
  const id = await bot.transport.sendToChat(to, text);
  if (bot.recordOutgoing) bot.recordOutgoing(to, id, text);
  offers.set(to, o);
  store.log('advance', `${order.id}: ETA ${etaDate} offered to ${to} for ${lines.length} part(s) not in stock`);
  return o;
}

function pending(chatId) {
  const o = offers.get(chatId);
  if (!o) return null;
  if (Date.now() - (o.askedAt || 0) > OFFER_DAYS * 86400000) {
    offers.delete(chatId);
    return null;
  }
  return o;
}

// A reply to a standing offer: 'yes', 'no', or null when it is about
// something else (then the offer keeps standing, and the message goes on to
// whoever handles it).
function readReply(text, buttonId) {
  const said = String(buttonId || text || '').trim();
  if (!said || said.length > 60) return null;
  if (NO.test(said)) return 'no';
  if (YES.test(said)) return 'yes';
  return null;
}

// The customer said yes: book the parts on the portal as an advance order.
async function accept(bot, chatId) {
  const o = pending(chatId);
  if (!o) return null;
  const portal = require('../integrations/dealerPortal');
  const res = await portal.advanceOrder({ id: o.orderId, ctx: o.ctx, lines: o.lines, etaDate: o.etaDate, actorUserId: o.actorUserId, punchedBy: o.punchedBy || null });
  offers.delete(chatId);
  const approvalLog = require('./approvalLog');
  approvalLog.record({ kind: 'advance', id: o.orderId, event: 'booked', by: o.customerName || chatId, customer: o.customerName || null, detail: `advance order ${res.soNumber}, ETA ${o.etaDate}, ${o.lines.length} part(s)` });
  store.log('advance', `${o.orderId}: customer accepted ETA ${o.etaDate} - advance order ${res.soNumber} on the portal`);
  return { offer: o, soNumber: res.unallocatedOrderId || res.soNumber, res };
}

function decline(chatId) {
  const o = pending(chatId);
  if (!o) return null;
  offers.delete(chatId);
  try {
    require('./approvalLog').record({ kind: 'advance', id: o.orderId, event: 'declined', by: o.customerName || chatId, customer: o.customerName || null, detail: `ETA ${o.etaDate}, ${o.lines.length} part(s)` });
  } catch (_) {
    /* the log is a record, not a gate */
  }
  store.log('advance', `${o.orderId}: customer declined the ETA - nothing booked`);
  return o;
}

const bookedText = (o, so, t) =>
  t(
    `✅ Booked in advance — order no. ${so}.\n${o.lines.map((l) => `• ${l.partNo} × ${l.qty}`).join('\n')}\n\nExpected by *${pretty(o.etaDate)}*. We will send them as soon as they arrive. Thank you!`,
    `✅ Advance mein book ho gaya — order no. ${so}.\n${o.lines.map((l) => `• ${l.partNo} × ${l.qty}`).join('\n')}\n\n*${pretty(o.etaDate)}* tak aane ki ummeed hai. Aate hi aapko bhej denge. Shukriya!`,
  );

module.exports = { offer, pending, readReply, accept, decline, notPunched, withEta, offerText, bookedText, pretty, YES, NO, _offers: offers };
