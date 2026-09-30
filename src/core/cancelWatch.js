'use strict';
// AN ORDER CANCELLED ON THE PORTAL AFTER IT WAS PUNCHED (founder, 28 Sep:
// "when customer/agent placed order and it punch but the order is cancel by
// super admin then bot also send that order are not able to punch, and also
// show this on dashboard").
//
// The punch went through - the customer was told "order placed, no. 1476" -
// and then someone cancelled it on the portal. Nothing told the customer, who
// went on waiting for goods that were never coming. This looks at the orders
// the bot punched recently, every ten minutes, and the first time the portal
// shows one cancelled: the order is marked (the dashboard reads it), and the
// customer - and the salesman, when it was his order - is told, once.
//
// Only orders punched in the last 48 hours are messaged about: a cancellation
// found on the first run for an order from last week goes on the dashboard,
// not into someone's WhatsApp out of nowhere.
const store = require('../store');

const EVERY_MS = 10 * 60 * 1000;
const LOOK_BACK_MS = 14 * 24 * 60 * 60 * 1000;
const TELL_WITHIN_MS = 48 * 60 * 60 * 1000;

const isCancelled = (p) => /cancel/i.test(String((p && (p.status || '')) + ' ' + (p && (p.do_status || ''))));

function candidates(now = Date.now()) {
  return store.orders().filter((o) => {
    if (o.status !== 'confirmed' || o.portalCancelled) return false;
    const at = Date.parse(o.confirmedAt || '') || 0;
    return at && now - at < LOOK_BACK_MS && (o.soNumber || (o.placed && o.placed.length));
  });
}

function portalIdsOf(o) {
  const ids = (o.placed || []).map((p) => p.soNumber).concat(o.soNumber ? [o.soNumber] : []);
  return [...new Set(ids.map((x) => String(x || '').trim()).filter((x) => /^\d+$/.test(x)))];
}

// One pass. -> [{ id, so, told }] for the orders found cancelled.
async function checkOnce(bot, now = Date.now()) {
  const portal = require('../integrations/dealerPortal');
  const found = [];
  for (const o of candidates(now).slice(0, 80)) {
    const ids = portalIdsOf(o);
    if (!ids.length) continue;
    let cancelled = [];
    for (const id of ids) {
      let p;
      try {
        const raw = await portal.order(Number(id));
        p = (raw && raw.data) || raw || null;
      } catch (e) {
        continue; // the portal not answering is not a cancellation
      }
      if (p && isCancelled(p)) cancelled.push(id);
    }
    // Every portal order behind it cancelled: the order is off. (Part of a
    // split order cancelled is left for a person - it still partly ships.)
    if (!cancelled.length || cancelled.length < ids.length) continue;
    o.portalCancelled = { at: new Date(now).toISOString(), so: cancelled.join(' / ') };
    store.save();
    const recent = now - (Date.parse(o.confirmedAt || '') || 0) < TELL_WITHIN_MS;
    store.log('orders', `${o.id} (portal ${o.portalCancelled.so}) was CANCELLED on the portal after it was punched${recent ? ' — telling them' : ' — older than 48 h, dashboard only'}`);
    try {
      require('./approvalLog').record({ kind: 'order', id: o.id, event: 'cancelled on portal', by: 'portal', customer: (o.portalCustomer && o.portalCustomer.name) || null, detail: 'portal order ' + o.portalCancelled.so + ' cancelled' });
    } catch (_) {
      /* the mark on the order is enough for the dashboard */
    }
    let told = 0;
    if (recent && bot) told = await tell(bot, o).catch(() => 0);
    o.portalCancelled.told = told;
    store.save();
    found.push({ id: o.id, so: o.portalCancelled.so, told });
  }
  return found;
}

async function tell(bot, o) {
  const lang = require('./lang');
  const escalation = require('./escalation');
  const so = o.portalCancelled.so;
  const name = (o.portalCustomer && o.portalCustomer.name) || null;
  const parts = (o.lines || [])
    .filter((l) => l.source !== 'unidentified' && l.source !== 'unknown')
    .map((l) => `• ${l.partNo || l.item} × ${l.qty}`)
    .join('\n');
  const forCustomer = (t) =>
    t(
      `We're sorry${name ? ', ' + name : ''} — your order ${so} (${o.id}) has been cancelled on our system, so it will not be supplied.${parts ? '\n\n' + parts : ''}\n\nIf you still need these parts, just reply here and we will place it again for you.`,
      `Maaf kijiye${name ? ' ' + name + ' ji' : ''} — aapka order ${so} (${o.id}) hamare system mein cancel ho gaya hai, isliye ye supply nahi ho payega.${parts ? '\n\n' + parts : ''}\n\nAgar ye parts abhi bhi chahiye, to bas yahan reply kar dijiye — hum dobara laga denge.`,
    );
  const forAgent = (t) =>
    t(
      `⚠️ ${name ? name + "'s o" : 'O'}rder ${so} (${o.id}) was cancelled on the Dealer Portal after it was punched — it will not be supplied.${parts ? '\n\n' + parts : ''}\n\nThe customer has been told.`,
      `⚠️ ${name ? name + ' ka o' : 'O'}rder ${so} (${o.id}) punch hone ke baad Dealer Portal pe cancel ho gaya — ye supply nahi hoga.${parts ? '\n\n' + parts : ''}\n\nCustomer ko bata diya hai.`,
    );
  const send = async (chatId, text) => {
    const phone = String(chatId).split('@')[0];
    if (/^\d{10,15}$/.test(phone)) await escalation.ensureWindow(bot.transport, phone, `Order ${so} cancelled — details follow`, so).catch(() => {});
    const id = await bot.transport.sendToChat(chatId, text);
    if (bot.recordOutgoing) bot.recordOutgoing(chatId, id, text);
  };
  let told = 0;
  // A salesman's order: his chat, and the customer on their own number.
  const custChat = o.requestedBy && bot.customerChatOf ? bot.customerChatOf(o) : null;
  try {
    await send(o.chatId, o.requestedBy ? forAgent(lang.for(o.chatId)) : forCustomer(lang.for(o.chatId)));
    told++;
  } catch (e) {
    store.log('orders', `${o.id}: could not tell ${o.chatId} of the cancellation: ` + String((e && e.message) || e).slice(0, 80));
  }
  if (custChat && custChat !== o.chatId) {
    try {
      await send(custChat, forCustomer(lang.for(custChat)));
      told++;
    } catch (e) {
      store.log('orders', `${o.id}: could not tell the customer on ${custChat}: ` + String((e && e.message) || e).slice(0, 80));
    }
  }
  return told;
}

let timer = null;
function start(bot) {
  if (timer) return;
  const run = () => checkOnce(bot).catch((e) => store.log('orders', 'cancel check failed: ' + String((e && e.message) || e).slice(0, 100)));
  setTimeout(run, 60 * 1000).unref();
  timer = setInterval(run, EVERY_MS);
  if (timer.unref) timer.unref();
}

module.exports = { start, checkOnce, _candidates: candidates, _isCancelled: isCancelled };
