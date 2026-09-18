'use strict';
// The draft SO: punched, but NOT confirmed — checked before anything is
// allocated. The same step for everyone now: a customer ordering for himself
// and a salesman ordering for a customer both see the document first.
//
// Founder, 12 Sep: "maine yes bola to draft SO bhejna tha, phir confirm
// krvana tha."
//
//   yes on the list  -> punched (portal: do_status "pending", nothing
//                       allocated) and the SO PDF goes out as the draft
//   "2 hata do"      -> the order is replaced by one without that line, and a
//                       fresh draft SO comes back
//   "haan"           -> Confirm SO: allocation starts, and the CONFIRMED SO
//                       PDF follows — the copy the desk files
//   "cancel"         -> the order is deleted from the portal
//
// Three things the live portal taught us on 12 Sep, each tried against it:
//   * The Odoo SO exists the moment an order is punched — order 633 had SO
//     235954, and printed, while still pending. That is what makes a
//     draft-then-confirm flow possible at all.
//   * PUT /orders/{id} ACCEPTS a new line list and ignores it. A line dropped
//     from order 632 stayed; quantity 9 sent as 5 on pending order 633 stayed
//     9. Both HTTP 200. So an order cannot be edited.
//   * DELETE /orders/{id} works ("Order deleted", order 632 gone).
// Hence removal = cancel the order and punch the rest again, which is what a
// person does on the portal.
//
// The state lives in state.json, never in a timer: SO 626 was punched because
// a question that lived in a setTimeout died with a deploy.
const store = require('../store');

const TTL_MS = 24 * 60 * 60 * 1000;

function all() {
  const st = store.load();
  if (!st.soReview) st.soReview = {};
  return st.soReview;
}

function get(chatId) {
  const s = all()[chatId];
  if (!s) return null;
  if (Date.now() - Date.parse(s.at) > TTL_MS) {
    clear(chatId);
    return null;
  }
  return s;
}

function open(chatId, state) {
  all()[chatId] = { at: new Date().toISOString(), ...state };
  store.save();
}

function clear(chatId) {
  delete all()[chatId];
  store.save();
}

// The lines of every order in this draft, in the order they are shown.
async function lines(orderIds) {
  const portal = require('../integrations/dealerPortal');
  const out = [];
  for (const id of orderIds) {
    let o = null;
    try {
      o = await portal.order(id);
    } catch (e) {
      store.log('so', 'order ' + id + ' not readable: ' + String((e && e.message) || e).slice(0, 100));
    }
    if (!o) continue;
    for (const l of o.lines || []) out.push({ ...l, orderId: id, soName: o.odoo_so_name || null });
  }
  return out;
}

function lineText(l, i) {
  const qty = l.quantity != null ? l.quantity : l.qty;
  return i + 1 + '. ' + (l.part_no || l.item) + ' x' + qty;
}

function fileSafe(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// The document itself, one per portal order (a punch can make two: what is in
// stock, and what is on order). `stage` only decides what it is called.
async function sendPdfs(bot, chatId, s, t, stage) {
  const portal = require('../integrations/dealerPortal');
  const tr = bot && bot.transport;
  if (!tr || typeof tr.sendDocument !== 'function') return 0;
  const who = fileSafe(s.customerName);
  let sent = 0;
  for (const id of s.orderIds) {
    let pdf = null;
    try {
      pdf = await portal.soPdf(id, s.odooSoName || null);
    } catch (e) {
      store.log('so', 'SO PDF for order ' + id + ' failed: ' + String((e && e.message) || e).slice(0, 110));
    }
    if (!pdf) continue;
    const title = (stage === 'confirmed' ? 'SO ' : 'Draft SO ') + pdf.name + (who ? ' - ' + who : '');
    await tr.sendDocument(chatId, pdf.buffer, title + '.pdf', 'application/pdf', title);
    sent++;
  }
  return sent;
}

// The bill for these orders, when there is one (the warehouse draft invoice,
// or the final one after billing). Best effort - a missing bill is normal.
async function sendBills(bot, chatId, s, t) {
  const portal = require('../integrations/dealerPortal');
  const tr = bot && bot.transport;
  if (!tr || typeof tr.sendDocument !== 'function') return 0;
  let sent = 0;
  for (const id of s.orderIds) {
    let pdf = null;
    try {
      pdf = await portal.invoicePdf(id);
    } catch (e) {
      store.log('so', 'bill for order ' + id + ' failed: ' + String((e && e.message) || e).slice(0, 110));
    }
    if (!pdf) continue;
    const title = 'Bill ' + id + (s.customerName ? ' - ' + fileSafe(s.customerName) : '');
    await tr.sendDocument(chatId, pdf, title + '.pdf', 'application/pdf', title);
    sent++;
  }
  return sent;
}
// The draft, and the one question after it. Whoever wants a line out will say
// so — they don't need to be told they may.
async function sendDraft(bot, chatId, reply, t) {
  const s = get(chatId);
  if (!s) return false;
  const sent = await sendPdfs(bot, chatId, s, t, 'draft');
  if (sent) {
    await reply(t('All good?', 'Sahi hai?'));
    return true;
  }
  // Odoo had not printed it yet. The list still has to be checked before
  // anything is allocated.
  const list = (await lines(s.orderIds)).map(lineText).join('\n');
  await reply(t('Draft SO:\n' + list + '\n\nAll good?', 'Draft SO:\n' + list + '\n\nSahi hai?'));
  return true;
}

// Punched: hold it as a draft and show it.
// `opts.order` is the draft it was punched from — kept because a removal has
// to punch the rest again, and the portal will not edit an order.
async function start(bot, m, result, reply, t, opts) {
  const o = opts || {};
  const ids = [];
  for (const p of (result && result.placed) || [result || {}]) {
    for (const id of [p.soNumber, p.unallocatedOrderId]) if (id) ids.push(String(id));
  }
  if (!ids.length && result && result.soNumber) ids.push(String(result.soNumber));
  if (!ids.length) return false;
  const order = o.order || null;
  open(m.chatId, {
    orderIds: ids,
    phone: m.from,
    customerName: o.customerName || null,
    odooSoName: (result && result.odooSoName) || null,
    lines: (order && order.lines) || [],
    portalCustomer: (order && order.portalCustomer) || null,
  });
  store.log('so', 'draft SO for ' + m.from + ': order(s) ' + ids.join(', ') + ' - waiting to be checked');
  return sendDraft(bot, m.chatId, reply, t);
}

const REMOVE = /\b(hata|hatao|hatana|hatado|remove|nikal|nikaal|delete|chhod|chod)\b/i;
const CANCEL = /\b(cancel|rehne do|rhne do|nahi chahiye|nhi chahiye)\b/i;
const PDF_ASK = /(pdf|document|copy|softcopy|soft copy)/i;

// Which line does "2 hata do" or "41602M68P21 hata do" mean?
function targets(text, rows) {
  const ai = require('./ai');
  const part = ai.partNumberIn(text);
  if (part) {
    const want = String(part).toUpperCase();
    const hit = rows.filter((l) => String(l.part_no || l.item).toUpperCase() === want);
    if (hit.length) return hit;
  }
  const nums = (String(text).match(/\b(\d{1,2})\b/g) || []).map(Number).filter((n) => n >= 1 && n <= rows.length);
  return nums.map((n) => rows[n - 1]).filter(Boolean);
}

async function cancelAll(orderIds) {
  const portal = require('../integrations/dealerPortal');
  let gone = 0;
  for (const id of orderIds) {
    try {
      await portal.cancelOrder(id);
      gone++;
    } catch (e) {
      store.log('so', 'cancel of order ' + id + ' FAILED: ' + String((e && e.message) || e).slice(0, 130));
    }
  }
  return gone;
}

function samePart(a, b) {
  const norm = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return !!norm(a) && norm(a) === norm(b);
}

async function handle(bot, m, text, reply, t) {
  const s = get(m.chatId);
  if (!s) return false;
  // A list that is open right now owns the answer: they are talking about
  // what they are building, not about the draft SO from before.
  const orders = require('./orders');
  const fresh = orders.findDraft(m.chatId);
  if (fresh && fresh.lines.length) return false;
  const portal = require('../integrations/dealerPortal');
  const ai = require('./ai');
  const said = require('./voiceOrder').readAnswer(text);

  // ---- "pdf mai bhejo" ----
  // The document, asked for by name. It is missing for one reason only:
  // Odoo has not made the SO yet (order 640, 12 Sep - odoo_so_name null
  // minutes after the punch). Try again, and if it is still not there say
  // that, rather than sending the question to a person.
  if (PDF_ASK.test(text) && said !== 'yes') {
    const again = await sendPdfs(bot, m.chatId, s, t, s.confirmed ? 'confirmed' : 'draft');
    if (again) return reply(t('All good?', 'Sahi hai?'));
    // The Odoo SO is only made when the order reaches invoicing (641 was
    // confirmed with no SO for ten minutes; 639, already at invoice_status
    // 'draft', had one). If the bill exists, that is the document.
    const bill = await sendBills(bot, m.chatId, s, t);
    if (bill) return reply(t('That is the bill for it - the SO print is only made once it reaches billing.', 'Ye uska bill hai - SO ka print billing tak pahunchne par hi banta hai.'));
    return reply(
      t(
        'The SO print is not made yet - it comes when the order reaches billing. I will send it then.',
        'SO ka print abhi bana nahi hai - billing tak pahunchne par banta hai. Ban jaye to bhej dunga.',
      ),
    );
  }

  // ---- the yes that starts the packing ----
  if (said === 'yes') {
    const done = [];
    for (const id of s.orderIds) {
      try {
        await portal.confirmSO(id);
        done.push(id);
      } catch (e) {
        store.log('so', 'Confirm SO ' + id + ' FAILED: ' + String((e && e.message) || e).slice(0, 130));
      }
    }
    if (!done.length) {
      return reply(
        t(
          'SO ' + s.orderIds.join(', ') + ' is punched, but I could not confirm it — our team will finish it.',
          'SO ' + s.orderIds.join(', ') + ' punch hai, par confirm nahi ho paaya — hamari team poora kar degi.',
        ),
      );
    }
    clear(m.chatId);
    store.log('so', 'Confirm SO done for ' + done.join(', ') + ' (' + m.from + ')');
    const who = s.customerName ? ' — ' + s.customerName : '';
    await reply(
      t(
        '✅ SO ' + done.join(', ') + ' confirmed' + who + '. Allocation has started.',
        '✅ SO ' + done.join(', ') + ' confirm ho gaya' + who + '. Allocation shuru.',
      ),
    );
    // The same document again, now that it is confirmed — the copy that goes
    // with the bill.
    await sendPdfs(bot, m.chatId, { ...s, orderIds: done }, t, 'confirmed');
    return true;
  }

  // ---- the whole thing taken back ----
  if ((said === 'no' || CANCEL.test(text)) && !REMOVE.test(text) && !ai.partNumberIn(text)) {
    clear(m.chatId);
    const gone = await cancelAll(s.orderIds);
    store.log('so', 'draft SO ' + s.orderIds.join(', ') + ' cancelled by ' + m.from);
    if (!gone) {
      return reply(
        t(
          'I could not cancel it on the portal — our team will do it.',
          'Portal pe cancel nahi ho paya — hamari team kar degi.',
        ),
      );
    }
    return reply(t('Cancelled. Nothing has been sent.', 'Cancel kar diya. Kuch nahi bheja gaya.'));
  }

  // ---- one line out ----
  if (REMOVE.test(text) || CANCEL.test(text)) {
    const rows = await lines(s.orderIds);
    if (!rows.length) return false;
    const drop = targets(text, rows);
    if (!drop.length) return reply(t('Which one?', 'Kaunsa wala?'));
    const gone = drop.map((l) => l.part_no || l.item);

    // The portal will not edit an order (tried on 632 and 633, 12 Sep), so the
    // order goes and what is left is punched again.
    const keep = (s.lines || []).filter((l) => !gone.some((g) => samePart(g, l.partNo) || samePart(g, l.item)));
    await cancelAll(s.orderIds);
    clear(m.chatId);
    if (!keep.length) {
      return reply(
        t(
          gone.join(', ') + ' removed — nothing left, so the order is cancelled.',
          gone.join(', ') + ' hata diya — ab kuch bacha nahi, isliye order cancel kar diya.',
        ),
      );
    }

    const draft = orders.getOrCreateDraft(m.chatId, s.phone || m.from);
    if (s.portalCustomer) draft.portalCustomer = s.portalCustomer;
    orders.addLines(draft, keep, { replace: true });
    let result = null;
    try {
      result = await orders.confirm(draft);
    } catch (e) {
      store.log('so', 're-punch after removal FAILED: ' + String((e && e.message) || e).slice(0, 140));
    }
    if (!result || !result.soNumber) {
      return reply(
        t(
          gone.join(', ') + ' removed, and the old order is cancelled. I could not punch the rest just now — our team will.',
          gone.join(', ') + ' hata diya, purana order cancel ho gaya. Baaki abhi punch nahi ho paya — hamari team kar degi.',
        ),
      );
    }
    store.log('so', gone.join(', ') + ' removed; ' + s.orderIds.join(', ') + ' cancelled, re-punched as ' + result.soNumber);
    await reply(t(gone.join(', ') + ' removed. New draft SO:', gone.join(', ') + ' hata diya. Naya draft SO:'));
    return start(bot, m, result, reply, t, { order: draft, customerName: s.customerName });
  }

  return false;
}

module.exports = { start, handle, sendDraft, get, open, clear, _internals: { targets, lines, samePart } };
