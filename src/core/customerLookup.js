'use strict';
// What the sales desk asks ABOUT a customer, without placing an order:
//
//   "Kalra ka order kab aayega"   -> that customer's real orders on the portal
//   "Kalra Motors ka ledger"      -> the balance, and the bills behind it
//   "Kalra ke credit note"        -> posted credit notes
//
// Sir, 11 Sep: before this, "Kalra ka order kab aayega" was answered with the
// SALESMAN's own draft — the bot read the question as his own order. The
// customer is found exactly as it is for an SO; core/salesOrder owns the
// picker, so "kaunsa wala?" reads the same everywhere.
//
// Money is only ever shown to the sales team and admins: the caller
// (core/salesOrder) is already behind that check.
const store = require('../store');

const ABOUT = /^([^\n]{2,60}?)\s+(?:ka|ki|ke)\s+(orders?|so|sale\s*order|ledger|balance|account|khata|hisaab|credit\s*notes?|cn)\b([\s\S]{0,80})$/i;
const STATUS_WORD = /\b(kab|status|kahan|kaha|aaya|aayega|aya|dispatch|deliver|delivery|track|pahuncha|bheja|gaya|update|hua)\b/i;
const PART_LIKE = /\b(?=[A-Za-z0-9-]*[A-Za-z])(?=[A-Za-z0-9-]*\d)[A-Za-z0-9][A-Za-z0-9-]{5,}\b/;

// The same trim core/salesOrder does. Kept here rather than imported, so the
// two modules never require each other in a circle.
function cleanName(name) {
  return String(name || '')
    .replace(/^\s*m\s*[/.]\s*s\.?\s*/i, '')
    .replace(/\s+(?:bhai|sir|ji|wale|wala)\s*$/i, '')
    .replace(/[\s.:,-]+$/, '')
    .trim();
}

// text -> { customer, intent } | null
function parse(text) {
  const line = String(text || '').trim().split('\n')[0];
  const m = line.match(ABOUT);
  if (!m) return null;
  const customer = cleanName(m[1]);
  if (customer.length < 2 || PART_LIKE.test(customer)) return null;
  const word = m[2].toLowerCase();
  const rest = m[3] || '';
  if (/ledger|balance|account|khata|hisaab/.test(word)) return { customer, intent: 'ledger' };
  if (/credit|cn/.test(word)) return { customer, intent: 'credit' };
  // "X ka order" is a question only when it asks one. "X ka order punch kar
  // do", or parts underneath, is an order and core/salesOrder takes it.
  if (STATUS_WORD.test(rest) || /^[\s?.]*$/.test(rest)) return { customer, intent: 'status' };
  return null;
}

// "486 ka bill", "order 486 ka invoice", "bill for 486". The number is the
// PORTAL order id, the one the order list above prints first.
const BILL_HI = /(?:^|\b)(?:order\s*)?#?(\d{3,7})\s+(?:ka|ki|ke)\s+(?:bill|invoice)\b/i;
const BILL_EN = /\b(?:bill|invoice)\s+(?:of|for)\s+(?:order\s*)?#?(\d{3,7})\b/i;

function parseBill(text) {
  const line = String(text || '').trim().split('\n')[0];
  const m = line.match(BILL_HI) || line.match(BILL_EN);
  return m ? { orderId: m[1] } : null;
}

// The bill as the portal's own PDF — the same file the desk downloads by hand.
// Verified 12 Sep on order 486: 97 KB of application/pdf.
async function sendBill(bot, m, orderId, reply, t) {
  const portal = require('../integrations/dealerPortal');
  let pdf = null;
  try {
    pdf = await portal.invoicePdf(orderId);
  } catch (e) {
    store.log('sales', 'bill lookup failed for order ' + orderId + ': ' + String((e && e.message) || e).slice(0, 120));
  }
  if (!pdf) return reply(t('Order ' + orderId + ' has no bill yet.', 'Order ' + orderId + ' ka bill abhi nahi bana.'));
  const tr = bot && bot.transport;
  if (!tr || typeof tr.sendDocument !== 'function') {
    return reply(t('The bill for order ' + orderId + ' is on the portal.', 'Order ' + orderId + ' ka bill portal pe hai.'));
  }
  // The bill number and the customer, so the file is recognisable in a chat
  // full of PDFs. Neither is worth failing the send over.
  let who = '';
  let billNo = '';
  try {
    const o = await portal.order(orderId);
    who = (o && (o.customer_name || o.buyer_name)) || '';
    billNo = (o && o.invoice_no) || '';
  } catch (e) {
    store.log('sales', 'order ' + orderId + ' details not read: ' + String((e && e.message) || e).slice(0, 90));
  }
  const clean = (s) => String(s || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  const file = ('Bill ' + (clean(billNo) || orderId) + (who ? ' - ' + clean(who) : '')).slice(0, 70) + '.pdf';
  await tr.sendDocument(m.chatId, pdf, file, 'application/pdf', (who ? who + ' · ' : '') + 'order ' + orderId + (billNo ? ' · ' + billNo : ''));
  store.log('sales', 'bill for order ' + orderId + ' sent to ' + m.from);
  return true;
}

// 76931.84 -> "76,932" — Indian grouping, written out rather than left to
// whatever locale data the container ships with.
function money(v) {
  const n = Math.round(Number(v) || 0);
  const s = String(Math.abs(n));
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3);
  const grouped = rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3 : last3;
  return (n < 0 ? '-' : '') + grouped;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function day(v) {
  const d = v ? new Date(v) : null;
  if (!d || isNaN(d.getTime())) return '';
  return d.getDate() + ' ' + MONTHS[d.getMonth()];
}

function same(a, b) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  return Boolean(norm(a)) && norm(a) === norm(b);
}

// The portal's own words are for the warehouse screen ("Unallocated",
// do_status "pending"). The desk asked "kab aayega", so the answer is how far
// the order has actually come.
function where(o, t) {
  if (o.dispatched_at) return t('dispatched ' + day(o.dispatched_at), 'dispatch ho gaya ' + day(o.dispatched_at));
  if (o.invoice_no) return t('billed, ' + o.invoice_no, 'bill ban gaya, ' + o.invoice_no);
  if (/cancel/i.test(String(o.status || ''))) return t('cancelled', 'cancel ho gaya');
  if (String(o.do_status || '').toLowerCase() === 'confirmed') return t('confirmed, dispatch pending', 'confirm hai, dispatch baaki');
  return t('not allocated yet', 'abhi allocate nahi hua');
}

async function ordersFor(row, t) {
  const portal = require('../integrations/dealerPortal');
  let rows = [];
  try {
    rows = await portal.recentOrders(row.name, { limit: 8 });
  } catch (e) {
    store.log('sales', 'orders lookup failed for ' + row.name + ': ' + String((e && e.message) || e).slice(0, 120));
    return t("I can't open the order list right now - one more time in a minute?", 'Order list abhi khul nahi rahi - ek minute mein phir poochhiye?');
  }
  // buyer_search matches on the name, so keep only the account that was
  // picked: "Kalra" also brings Kalra Car Decor's orders.
  const mine = rows.filter((o) => same(o.customer_name, row.name) || same(o.buyer_name, row.name));
  const list = (mine.length ? mine : rows).slice(0, 5);
  if (!list.length) return t('Nothing on ' + row.name + "'s account yet.", row.name + ' ke naam pe abhi koi order nahi hai.');
  const lines = list.map(
    (o) =>
      '• ' +
      o.order_id +
      (o.odoo_so_name ? ' · SO ' + o.odoo_so_name : '') +
      ' · ' +
      day(o.order_date) +
      (Array.isArray(o.lines) && o.lines.length ? ' · ' + o.lines.length + ' item' : '') +
      ' · ' +
      where(o, t),
  );
  return (
    t(
      row.name + ' - last ' + list.length + ' order' + (list.length > 1 ? 's' : '') + ':',
      row.name + ' ke pichhle ' + list.length + ' order:',
    ) +
    '\n' +
    lines.join('\n')
  );
}

async function ledgerFor(row, t) {
  const odoo = require('../integrations/odoo');
  // Cheques given and not yet in Odoo count as paid (core/cheques): "owes"
  // is what is left after them, and each cheque is listed under the head.
  const pos = await require('./cheques')
    .positionOf(row.id)
    .catch(() => null);
  const withCheques = pos && pos.cheques.length;
  const head = [
    withCheques
      ? t('owes ₹', 'baaki ₹') + money(pos.afterCheques) + t(` (₹${money(row.balance)} less cheques ₹${money(pos.chequeAmount)})`, ` (₹${money(row.balance)} mein se cheque ₹${money(pos.chequeAmount)} ghata ke)`)
      : t('owes ₹', 'baaki ₹') + money(row.balance),
    !withCheques && Number(row.pdc_amount) ? 'PDC ₹' + money(row.pdc_amount) : null,
    Number(row.credit_limit)
      ? 'limit ₹' + money(row.credit_limit) + (row.credit_days ? ' / ' + row.credit_days + t(Number(row.credit_days) === 1 ? ' day' : ' days', ' din') : '')
      : null,
  ].filter(Boolean);
  const out = [row.name + ' - ' + head.join(' · ')];
  if (withCheques) out.push(t('Cheques received, not in the ledger yet:', 'Cheque mil gaye, ledger mein abhi nahi:'), ...require('./cheques').chequeLines(pos, t));

  if (odoo.enabled() && row.odoo_partner_id) {
    try {
      const l = await odoo.ledger(row.odoo_partner_id, { limit: 5 });
      if (l && l.documents.length) {
        out.push('');
        for (const d of l.documents) {
          out.push(
            '• ' +
              day(d.date) +
              ' · ' +
              d.name +
              ' · ₹' +
              money(d.total) +
              // A credit note is money the customer HAS, not money owed:
              // "pending" on one of those reads backwards.
              (d.kind === 'credit note'
                ? d.paid
                  ? t(' · used', ' · adjust ho gaya')
                  : t(' · unused', ' · baaki hai')
                : d.paid
                  ? t(' · paid', ' · paid hai')
                  : ' · ₹' + money(d.pending) + t(' pending', ' baaki')),
          );
        }
      }
    } catch (e) {
      store.log('sales', 'Odoo ledger failed for ' + row.name + ': ' + String((e && e.message) || e).slice(0, 120));
      out.push(t('(the bill list is not opening right now)', '(bill list abhi khul nahi rahi)'));
    }
  }
  return out.join('\n');
}

async function creditNotesFor(row, t) {
  const odoo = require('../integrations/odoo');
  if (!odoo.enabled() || !row.odoo_partner_id) {
    return t("I can't see credit notes right now.", 'Credit note abhi dikh nahi paa rahe.');
  }
  let rows;
  try {
    rows = await odoo.creditNotes(row.odoo_partner_id, { limit: 6 });
  } catch (e) {
    store.log('sales', 'Odoo credit notes failed for ' + row.name + ': ' + String((e && e.message) || e).slice(0, 120));
    return t('The credit note list is not opening right now.', 'Credit note list abhi khul nahi rahi.');
  }
  if (!rows || !rows.length) return t('No credit note for ' + row.name + '.', row.name + ' ka koi credit note nahi hai.');
  const left = rows.reduce((s, c) => s + (c.pending || 0), 0);
  const lines = rows.map(
    (c) =>
      '• ' + day(c.date) + ' · ' + c.name + ' · ₹' + money(c.total) + (c.pending ? t(' · unused', ' · baaki hai') : t(' · used', ' · adjust ho gaya')),
  );
  return (
    t(
      row.name + ' - ' + rows.length + ' credit note' + (rows.length > 1 ? 's' : '') + (left ? ', ₹' + money(left) + ' unused' : ''),
      row.name + ' ke ' + rows.length + ' credit note' + (left ? ', ₹' + money(left) + ' baaki' : ''),
    ) +
    ':\n' +
    lines.join('\n')
  );
}

// ---------------------------------------------------------------- their OWN account
//
// Until 12 Sep only a salesman could ask "Kalra ka ledger". A customer asking
// about themselves - "8502 OUTSTANDING AMOUNT", "Send credit of returned
// items", "Billed or not?" - was handed to a person every time, and the desk
// answered with a ledger PDF and a balance. Founder, 12 Sep: "SBKE LIYE
// KRO..BOT AUR SALESMAN, ADMIN". So the same answers, about the account the
// phone belongs to and no other.
//
// There is no name in these questions, so the account comes from the number
// that sent them: resolve(phone) -> buyer id -> the account row that carries
// the balance, the PDC and the credit limit.
const OWN = [
  // "credit limit" is a limit, not a credit note, and it is asked about far
  // more often — so it is matched first.
  { re: /\bcredit\s*limit\b/i, intent: 'ledger' },
  { re: /\b(credits?|credit\s*notes?|cn)\b/i, intent: 'credit' },
  { re: /\b(ledger|ledgar|ladger|ladgar|leger|legar|lejer|lezer|legder|ledgr|statement|khata|khaata|hisaab|hisab)\b/i, intent: 'ledger' },
  { re: /\b(balance|baki|baaki|bakaya|baqaya|outstanding|kitna dena|kitne paise|due)\b/i, intent: 'ledger' },
  { re: /\b(billed|bill\s*(hua|ho\s*gaya|kiya|kar\s*diya|banaya)|invoice\s*(hua|ho\s*gaya))\b/i, intent: 'billed' },
  { re: /\b(mera|hamara|humara|meri|hamari)\b[^\n]{0,20}\b(order|maal|saman|samaan)\b/i, intent: 'status' },
  { re: /\b(order|maal|saman|samaan)\b[^\n]{0,25}\b(kahan|kaha|kab|dispatch|delivery|bheja|nikla)\b/i, intent: 'status' },
];

// Only when there is no customer NAME in the line - "Kalra ka ledger" belongs
// to the salesman flow, which already knows how to pick between two Kalras.
// "Baki bill kardo" is not a question about a balance — it is "bill the rest
// of it", an instruction for the desk. The word "baki" alone must not turn it
// into a ledger.
const BILL_ME = /\bbill\s*(kar|kr|bana|banao|banado|kardo|kar\s*do|kardijiye)/i;

function parseOwn(text) {
  const line = String(text || '').trim();
  if (!line || line.length > 120) return null;
  if (parse(line) || BILL_ME.test(line)) return null;
  for (const o of OWN) if (o.re.test(line)) return { intent: o.intent };
  return null;
}

// The portal account this phone belongs to, with the money fields on it.
// `resolve` gives the buyer id; the account row with the balance comes from
// the name search, matched back by that id so a similar name cannot stand in.
async function ownRow(phone) {
  const portal = require('../integrations/dealerPortal');
  const customers = require('./customers');
  const ctx = await customers.resolve(phone);
  if (!ctx || !ctx.found || !ctx.name) return null;
  let rows = [];
  try {
    rows = await portal.searchAccounts(ctx.name);
  } catch (e) {
    store.log('sales', 'own account lookup failed for ' + phone + ': ' + String((e && e.message) || e).slice(0, 110));
    return null;
  }
  const exact = rows.find((r) => String(r.id) === String(ctx.buyerId));
  return exact || rows.find((r) => same(r.name, ctx.name)) || null;
}

// "detail of order 686", "order 686", "SO 686 ka status". The number is the
// PORTAL order id. 14 Sep, live: "detail of order 686" was read as "analysis"
// and answered with another customer's parts.
const ORDER_NO = /\b(?:order|so|s\.o\.?)\s*(?:no\.?|number|#)?\s*#?(\d{3,7})\b|\b(\d{3,7})\s+(?:ka|ki|ke)\s+(?:order|so)\b/i;
function parseOrderDetail(text) {
  const line = String(text || '').trim();
  if (!line || line.length > 80 || line.indexOf('\n') >= 0) return null;
  if (/\b(bill|invoice)\b/i.test(line)) return null; // "486 ka bill" sends the PDF
  const m = line.match(ORDER_NO);
  return m ? { orderId: m[1] || m[2] } : null;
}

async function orderDetail(orderId, t) {
  const portal = require('../integrations/dealerPortal');
  let o = null;
  try {
    o = await portal.order(orderId);
  } catch (e) {
    if (e && e.status === 404) {
      return t(
        'Order ' + orderId + ' is not on the portal - it was cancelled, or the number is wrong.',
        'Order ' + orderId + ' portal pe nahi mila - cancel ho chuka hai ya number galat hai.',
      );
    }
    store.log('sales', 'order ' + orderId + ' lookup failed: ' + String((e && e.message) || e).slice(0, 110));
    return t("I can't open order " + orderId + ' right now - one more time in a minute?', 'Order ' + orderId + ' abhi khul nahi raha - ek minute mein phir poochhiye?');
  }
  if (!o) return t('Order ' + orderId + ' is not on the portal.', 'Order ' + orderId + ' portal pe nahi mila.');
  const lines = (o.lines || []).map((l, i) => {
    const qty = Number(l.final_quantity) || Number(l.quantity) || 0;
    const unit = Number(l.discounted_unit_price) || Number(l.final_price) || Number(l.price) || 0;
    return i + 1 + '. ' + l.part_no + ' x' + qty + (unit ? ' · ₹' + money(unit) + '/pc' : '');
  });
  const total = Number(o.total_amount);
  return [
    'Order ' + (o.order_id || orderId) + (o.odoo_so_name ? ' · SO ' + o.odoo_so_name : '') + (o.order_date ? ' · ' + day(o.order_date) : '') + (o.customer_name || o.buyer_name ? ' · ' + (o.customer_name || o.buyer_name) : ''),
    where(o, t),
    '',
    ...lines,
    total ? '\nTotal ₹' + money(total) : '',
  ]
    .join('\n')
    .trim();
}

// ---- desk lookups over WhatsApp (founder, 14 Sep) -------------------------
// Things the desk otherwise opens the portal for, each one read-only GET the
// bot's sales user was checked to be allowed (memory portal-api-permissions):
//   "639 kahan hai" / "track 639"       -> where the order is
//   "639 ka challan"                     -> the delivery challan PDF
//   "639 ka bill bana?"                  -> invoice made or not
//   "shortage list" / "Kalra ki shortage"-> parts asked for that were not there
//   "16510M65L10 ka status"              -> the part's POs, SOs and stock
//   "aane wala maal"                     -> goods on the way in
// The second half of each came from the founder's "nahi chalega" list (14 Sep):
// "639 wala order kidhar gaya", "639 ki delivery slip", "bill hua kya 639",
// "kya kya kam pada", "16510M65L10 kitna bika", "kya stock aa raha hai".
const TRACK_RE = /\b(?:order\s+|so\s+)?#?(\d{3,7})\s+(?:wala\s+|wale\s+|wali\s+)?(?:order\s+|so\s+)?(?:ka\s+|ki\s+)?(?:kahan|kaha|kidhar|kab|track|tracking|dispatch|pahuncha|pahucha|pohcha|gaya|gya)\b|\b(?:track|tracking|dispatch)\s+(?:of\s+)?(?:order\s+|so\s+)?#?(\d{3,7})\b/i;
const CHALLAN_RE = /\b(\d{3,7})\s*(?:ka|ki|ke)?\s*(?:challan|delivery\s*slip|delivery\s*challan|dc)\b|\b(?:challan|delivery\s*slip)\s*(?:of|for|bhejo)?\s*(?:order\s*)?#?(\d{3,7})\b/i;
const BILL_STATUS_RE = /\b(\d{3,7})\s*(?:ka|ki|ke)?\s*(?:bill|invoice)\s*(?:bana|bna|bn|ban|hua|hogaya|ho gaya|status|kya)|\b(?:bill|invoice)\s*(?:status|bana|bna|hua|ban\s*gaya)\s*(?:kya\s*)?(?:of\s*)?(?:order\s*)?#?(\d{3,7})\b/i;
const SHORTAGE_RE = /\b(shortages?|short\s*list|out\s*of\s*stock\s*list|oos\s*list|kam\s*pad[ae]?|kami)\b/i;
const PART_STATUS_RE = /\b(status|haal|history|bika|biki|bike|kharida|purchase|sale)\b/i;
const INCOMING_RE = /\b(aane\s*wala\s*maal|aane\s*wala|(?:maal|stock)\s*aa\s*raha|kya\s*(?:kya\s*)?(?:stock\s*|maal\s*)?aa\s*raha|incoming|in[- ]?transit|shipments?)\b/i;
// Words that say "this is a desk question" when none of the patterns above
// caught it - the only messages the model is asked about (classifyDesk).
const DESK_HINT_RE = /\b(challan|bill|invoice|dispatch|deliver\w*|pahu?n?ch\w*|kidhar|kahan|track\w*|pod|shortage|kam\s*pad\w*|kami|maal|aa\s*raha|incoming|transit|bika|biki|kharida|history|haal)\b/i;

function parseDesk(text) {
  const line = String(text || '').trim();
  if (!line || line.length > 80 || line.indexOf('\n') >= 0) return null;
  let m = line.match(CHALLAN_RE);
  if (m) return { kind: 'challan', orderId: m[1] || m[2] };
  m = line.match(BILL_STATUS_RE);
  if (m) return { kind: 'billStatus', orderId: m[1] || m[2] };
  m = line.match(TRACK_RE);
  if (m) return { kind: 'track', orderId: m[1] || m[2] };
  if (SHORTAGE_RE.test(line)) {
    const name = line
      .replace(SHORTAGE_RE, ' ')
      .replace(/\b(list|ki|ka|ke|of|for|batao|dikhao|bhejo|show|me|the|kya|hai|all|sab|saari)\b/gi, ' ')
      .replace(/[^A-Za-z0-9&.\s-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { kind: 'shortage', name: name.length >= 3 ? name : null };
  }
  if (INCOMING_RE.test(line)) return { kind: 'incoming' };
  const part = require('./partish').partNumber(line);
  if (part && PART_STATUS_RE.test(line) && !/\b(order|so)\b/i.test(line)) return { kind: 'partStatus', part };
  return null;
}

// When no pattern matched but the message sounds like a desk question
// (founder, 14 Sep: "yahan ai nhi lga skte ki vo smjh jaye?"). One model call,
// and its answer is only used if the order number or part number it names is
// really in the message - it can pick, never invent.
async function classifyDesk(text) {
  const line = String(text || '').trim();
  if (!line || line.length > 120 || line.indexOf('\n') >= 0 || !DESK_HINT_RE.test(line)) return null;
  const config = require('../config');
  const ai = require('./ai');
  if (!require('./ai').modelAvailable()) return null;
  let r = null;
  try {
    r = await ai._model(
      'You sort one WhatsApp message from the Cartrends sales desk (Hindi, English or Hinglish) into what the person wants to look up. ' +
        'Reply ONLY with JSON: {"kind": "track"|"challan"|"billStatus"|"shortage"|"partStatus"|"incoming"|"none", "orderId": str|null, "part": str|null, "name": str|null}. ' +
        'track = where an order is / dispatched / delivered / POD. challan = the delivery challan or delivery slip document. ' +
        'billStatus = whether an order is billed. shortage = parts customers asked for that were short (name = customer, if one is named). ' +
        'partStatus = one part number\'s purchases, sales or stock history. incoming = goods or stock on the way in. ' +
        'orderId is a 3-7 digit portal order number exactly as written. part is a part number exactly as written. Use "none" when unsure.',
      line,
    );
  } catch (e) {
    store.log('sales', 'desk classify failed: ' + String((e && e.message) || e).slice(0, 90));
    return null;
  }
  const kinds = ['track', 'challan', 'billStatus', 'shortage', 'partStatus', 'incoming'];
  if (!r || !kinds.includes(r.kind)) return null;
  const inText = (v) => v && new RegExp('(^|[^A-Za-z0-9])' + String(v).replace(/[^A-Za-z0-9]/g, '') + '([^A-Za-z0-9]|$)', 'i').test(line.replace(/[-_]/g, ''));
  if (['track', 'challan', 'billStatus'].includes(r.kind)) {
    const id = String(r.orderId || '').replace(/\D/g, '');
    return id.length >= 3 && id.length <= 7 && inText(id) ? { kind: r.kind, orderId: id, byModel: true } : null;
  }
  if (r.kind === 'partStatus') {
    const part = require('./partish').partNumber(line);
    return part ? { kind: 'partStatus', part, byModel: true } : null;
  }
  if (r.kind === 'shortage') {
    const name = r.name && line.toLowerCase().includes(String(r.name).toLowerCase()) ? String(r.name) : null;
    return { kind: 'shortage', name, byModel: true };
  }
  return { kind: 'incoming', byModel: true };
}

const STAGE = {
  pending: ['pending', 'pending'],
  'DO Confirmed': ['confirmed, packing next', 'confirm hai, packing baaki'],
  confirmed: ['confirmed', 'confirm hai'],
  assigned: ['given to a rider', 'rider ko de diya'],
  packed: ['packed', 'pack ho gaya'],
  dispatched: ['dispatched', 'dispatch ho gaya'],
  delivered: ['delivered', 'deliver ho gaya'],
  cancelled: ['cancelled', 'cancel ho gaya'],
  returned_from_customer: ['returned by the customer', 'customer ne wapas kiya'],
};
const stageText = (s, t) => (STAGE[s] ? t(STAGE[s][0], STAGE[s][1]) : s || t('status unknown', 'status pata nahi'));

async function trackText(orderId, t) {
  const portal = require('../integrations/dealerPortal');
  const config = require('../config');
  let tr = null;
  let disp = null;
  try {
    tr = await portal.trackOrder(orderId);
  } catch (e) {
    if (e && e.status === 404) return t('Order ' + orderId + ' is not on the portal.', 'Order ' + orderId + ' portal pe nahi mila.');
    store.log('sales', 'track ' + orderId + ' failed: ' + String((e && e.message) || e).slice(0, 110));
  }
  try {
    disp = await portal.dispatchFor(orderId, config.dealerPortal.sourceBranchDealerId || null);
  } catch (e) {
    store.log('sales', 'dispatch lookup ' + orderId + ' failed: ' + String((e && e.message) || e).slice(0, 110));
  }
  const o = tr && Array.isArray(tr.orders) ? tr.orders.find((x) => String(x.order_id) === String(orderId)) || tr.orders[0] : null;
  if (!o && !disp) return t("I can't open order " + orderId + ' right now - one more time in a minute?', 'Order ' + orderId + ' abhi khul nahi raha - ek minute mein phir poochhiye?');
  const stage = (disp && disp.tracker_status) || (o && o.tracker_status) || (o && o.status);
  const who = o && (o.customer_name || o.buyer_name);
  const via = [tr && tr.delivery_mode, (disp && disp.transporter) || (tr && tr.transporter)].filter(Boolean).join(' · ');
  const out = ['Order ' + orderId + (who ? ' · ' + who : '')];
  out.push(stageText(stage, t) + (disp && disp.dispatched_at && /dispatched|delivered/.test(String(stage)) ? ' ' + day(disp.dispatched_at) : '') + (via ? ' · ' + via : ''));
  const bill = (disp && disp.invoice_no) || null;
  if (bill || (o && o.payment_status)) out.push([bill ? t('Bill ', 'Bill ') + bill : null, o && o.payment_status ? t('payment ', 'payment ') + String(o.payment_status).toLowerCase() : null].filter(Boolean).join(' · '));
  if (disp) out.push(disp.pod_id || disp.pod_outcome_type ? 'POD: ' + (disp.pod_outcome_type || t('uploaded', 'upload ho gaya')) + (disp.pod_uploaded_at ? ' ' + day(disp.pod_uploaded_at) : '') : t('POD: not yet', 'POD: abhi nahi'));
  if (o && (o.line_count || o.total_amount)) out.push((o.line_count ? o.line_count + ' item' : '') + (o.total_qty ? ' · qty ' + o.total_qty : '') + (Number(o.total_amount) ? ' · ₹' + money(o.total_amount) : ''));
  return out.join('\n');
}

async function invoiceStatusText(orderId, t) {
  const portal = require('../integrations/dealerPortal');
  let s = null;
  try {
    s = await portal.invoiceStatus(orderId);
  } catch (e) {
    if (e && e.status === 404) return t('Order ' + orderId + ' is not on the portal.', 'Order ' + orderId + ' portal pe nahi mila.');
    store.log('sales', 'invoice status ' + orderId + ' failed: ' + String((e && e.message) || e).slice(0, 110));
    return t("I can't check order " + orderId + "'s bill right now.", 'Order ' + orderId + ' ka bill abhi check nahi ho raha.');
  }
  if (!s) return t('Order ' + orderId + ' is not on the portal.', 'Order ' + orderId + ' portal pe nahi mila.');
  if (s.invoiced || s.invoice_no) {
    return t(
      'Order ' + orderId + ' is billed: ' + (s.invoice_no || '-') + (s.odoo_invoice_state ? ' (' + s.odoo_invoice_state + ')' : ''),
      'Order ' + orderId + ' ka bill ban gaya: ' + (s.invoice_no || '-') + (s.odoo_invoice_state ? ' (' + s.odoo_invoice_state + ')' : ''),
    );
  }
  return t('Order ' + orderId + ' is not billed yet' + (s.invoice_status ? ' (' + s.invoice_status + ')' : '') + '.', 'Order ' + orderId + ' ka bill abhi nahi bana' + (s.invoice_status ? ' (' + s.invoice_status + ')' : '') + '.');
}

async function shortageText(name, t) {
  const portal = require('../integrations/dealerPortal');
  let rows = [];
  try {
    rows = await portal.shortages();
  } catch (e) {
    store.log('sales', 'shortage list failed: ' + String((e && e.message) || e).slice(0, 110));
    return t("I can't open the shortage list right now.", 'Shortage list abhi khul nahi rahi.');
  }
  const words = name ? String(name).toLowerCase().split(/\s+/).filter((w) => w.length >= 2) : [];
  // Only real shortages: the portal's list also carries lines that were filled
  // in full (shortfall 0 - "mila 1 · kam 0" on 14 Sep, live).
  const short = rows.filter((r) => (Number(r.shortfall) || 0) > 0);
  const mine = words.length ? short.filter((r) => words.every((w) => String(r.customer_name || '').toLowerCase().includes(w))) : short;
  if (!mine.length) return name ? t('No shortage for ' + name + '.', name + ' ki koi shortage nahi mili.') : t('The shortage list is empty.', 'Shortage list khaali hai.');
  const list = [...mine].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''))).slice(0, 10);
  const head = name
    ? t((list[0].customer_name || name) + ' - shortage (' + mine.length + '):', (list[0].customer_name || name) + ' ki shortage (' + mine.length + '):')
    : t('Shortage list - latest ' + list.length + ' of ' + mine.length + ':', 'Shortage list - ' + mine.length + ' mein se latest ' + list.length + ':');
  const lines = list.map(
    (r) =>
      '• ' + day(r.created_at) + ' · ' + r.part_no + ' x' + (r.requested_qty || 0) +
      t(' · got ', ' · mila ') + (r.available_qty || 0) + t(' · short ', ' · kam ') + (r.shortfall || 0) +
      (name ? '' : ' · ' + (r.customer_name || '-')),
  );
  return head + '\n' + lines.join('\n');
}

async function partStatusText(partNo, t) {
  const portal = require('../integrations/dealerPortal');
  let s = null;
  try {
    s = await portal.partStatus(partNo);
  } catch (e) {
    if (e && e.status === 404) return t(partNo + ' is not on the portal.', partNo + ' portal pe nahi mila.');
    store.log('sales', 'part status ' + partNo + ' failed: ' + String((e && e.message) || e).slice(0, 110));
    return t("I can't open " + partNo + ' right now.', partNo + ' abhi khul nahi raha.');
  }
  if (!s) return t(partNo + ' is not on the portal.', partNo + ' portal pe nahi mila.');
  const pos = Array.isArray(s.purchase_orders) ? s.purchase_orders : [];
  const sos = Array.isArray(s.sales_orders) ? s.sales_orders : [];
  const sum = (arr, k) => arr.reduce((n, x) => n + (Number(x[k]) || 0), 0);
  const last = (arr, k) => arr.map((x) => x[k]).filter(Boolean).sort().slice(-1)[0];
  const stock = s.stock && s.stock.bal_qty != null ? s.stock.bal_qty : null;
  return [
    String(s.part_no || partNo),
    t('Stock: ', 'Stock: ') + (stock == null ? '-' : stock),
    t('Purchase: ', 'Purchase: ') + pos.length + ' PO · ' + sum(pos, 'po_qty') + ' pcs' + (last(pos, 'po_date') ? t(' · last ', ' · last ') + day(last(pos, 'po_date')) : ''),
    t('Sale: ', 'Sale: ') + sos.length + ' SO · ' + sum(sos, 'so_qty') + ' pcs' + (last(sos, 'so_date') ? t(' · last ', ' · last ') + day(last(sos, 'so_date')) : ''),
  ].join('\n');
}

// ------------------------------------------------------------------ facts
//
// THE SAME PORTAL CALLS AS THE *Text FUNCTIONS ABOVE, RETURNED AS DATA.
//
// The template path sends those texts as they stand. The agent does not: it
// is given the facts and writes the reply itself, in the customer's words and
// language — a salesman reading his screen, not a screen being forwarded. So
// these carry no sentences, no translator and no formatting, only what the
// portal said. The *Text functions are left exactly as they were; each fact
// function reads the same fields as the text beside it.
//
// Every one returns { error } instead of throwing, so a tool can pass the
// failure on without a try/catch of its own.

// Where an order has got to, as the words `where()` uses, without `t`.
function stageOf(o) {
  if (o.dispatched_at) return { stage: 'dispatched', on: day(o.dispatched_at) || null };
  if (o.invoice_no) return { stage: 'billed', invoiceNo: o.invoice_no };
  if (/cancel/i.test(String(o.status || ''))) return { stage: 'cancelled' };
  if (String(o.do_status || '').toLowerCase() === 'confirmed') return { stage: 'confirmed, not dispatched yet' };
  return { stage: 'not allocated yet' };
}

async function orderListFacts(row) {
  const portal = require('../integrations/dealerPortal');
  let rows = [];
  try {
    rows = await portal.recentOrders(row.name, { limit: 8 });
  } catch (e) {
    store.log('sales', 'orders lookup failed for ' + row.name + ': ' + String((e && e.message) || e).slice(0, 120));
    return { error: 'the portal did not answer' };
  }
  const mine = rows.filter((o) => same(o.customer_name, row.name) || same(o.buyer_name, row.name));
  const list = (mine.length ? mine : rows).slice(0, 5);
  return {
    customer: row.name,
    orders: list.map((o) => ({
      orderId: o.order_id,
      salesOrder: o.odoo_so_name || null,
      date: day(o.order_date) || null,
      items: Array.isArray(o.lines) ? o.lines.length : null,
      ...stageOf(o),
    })),
  };
}

async function trackFacts(orderId) {
  const portal = require('../integrations/dealerPortal');
  const config = require('../config');
  let tr = null;
  let disp = null;
  try {
    tr = await portal.trackOrder(orderId);
  } catch (e) {
    if (e && e.status === 404) return { orderId, found: false };
    store.log('sales', 'track ' + orderId + ' failed: ' + String((e && e.message) || e).slice(0, 110));
  }
  try {
    disp = await portal.dispatchFor(orderId, config.dealerPortal.sourceBranchDealerId || null);
  } catch (e) {
    store.log('sales', 'dispatch lookup ' + orderId + ' failed: ' + String((e && e.message) || e).slice(0, 110));
  }
  const o = tr && Array.isArray(tr.orders) ? tr.orders.find((x) => String(x.order_id) === String(orderId)) || tr.orders[0] : null;
  if (!o && !disp) return { orderId, error: 'the portal did not answer' };
  const stage = (disp && disp.tracker_status) || (o && o.tracker_status) || (o && o.status) || null;
  return {
    orderId,
    found: true,
    customer: (o && (o.customer_name || o.buyer_name)) || null,
    stage,
    dispatchedOn: disp && disp.dispatched_at ? day(disp.dispatched_at) : null,
    deliveryMode: (tr && tr.delivery_mode) || null,
    transporter: (disp && disp.transporter) || (tr && tr.transporter) || null,
    invoiceNo: (disp && disp.invoice_no) || null,
    payment: (o && o.payment_status && String(o.payment_status).toLowerCase()) || null,
    proofOfDelivery: disp
      ? disp.pod_id || disp.pod_outcome_type
        ? { status: disp.pod_outcome_type || 'uploaded', on: disp.pod_uploaded_at ? day(disp.pod_uploaded_at) : null }
        : 'not yet'
      : null,
    items: (o && o.line_count) || null,
    totalQty: (o && o.total_qty) || null,
    // The order's own total on the portal — theirs, and repeatable as given.
    total: o && Number(o.total_amount) ? '₹' + money(o.total_amount) : null,
  };
}

async function invoiceFacts(orderId) {
  const portal = require('../integrations/dealerPortal');
  let s = null;
  try {
    s = await portal.invoiceStatus(orderId);
  } catch (e) {
    if (e && e.status === 404) return { orderId, found: false };
    store.log('sales', 'invoice status ' + orderId + ' failed: ' + String((e && e.message) || e).slice(0, 110));
    return { orderId, error: 'the portal did not answer' };
  }
  if (!s) return { orderId, found: false };
  const billed = Boolean(s.invoiced || s.invoice_no);
  return {
    orderId,
    found: true,
    billed,
    invoiceNo: s.invoice_no || null,
    state: (billed ? s.odoo_invoice_state : s.invoice_status) || null,
  };
}

async function shortageFacts(name) {
  const portal = require('../integrations/dealerPortal');
  let rows = [];
  try {
    rows = await portal.shortages();
  } catch (e) {
    store.log('sales', 'shortage list failed: ' + String((e && e.message) || e).slice(0, 110));
    return { error: 'the portal did not answer' };
  }
  const words = name ? String(name).toLowerCase().split(/\s+/).filter((w) => w.length >= 2) : [];
  const short = rows.filter((r) => (Number(r.shortfall) || 0) > 0);
  const mine = words.length ? short.filter((r) => words.every((w) => String(r.customer_name || '').toLowerCase().includes(w))) : short;
  const list = [...mine].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''))).slice(0, 10);
  return {
    customer: (list[0] && list[0].customer_name) || name || null,
    total: mine.length,
    shortages: list.map((r) => ({
      date: day(r.created_at) || null,
      partNo: r.part_no,
      ordered: Number(r.requested_qty) || 0,
      supplied: Number(r.available_qty) || 0,
      short: Number(r.shortfall) || 0,
    })),
  };
}

async function incomingText(t) {
  const portal = require('../integrations/dealerPortal');
  const config = require('../config');
  let rows = [];
  try {
    rows = await portal.incomingShipments(config.dealerPortal.sourceBranchDealerId || null);
  } catch (e) {
    store.log('sales', 'incoming shipments failed: ' + String((e && e.message) || e).slice(0, 110));
    return t("I can't open incoming shipments right now.", 'Aane wala maal abhi khul nahi raha.');
  }
  if (!rows.length) return t('Nothing on the way in right now.', 'Abhi koi maal aa nahi raha.');
  const list = rows.slice(0, 12).map((r) => '• ' + (r.po_no || r.po_id) + ' · ' + String(r.supplier || '-').trim() + ' · ' + (r.item_count || 0) + ' item · ' + (r.status || '-') + (r.eta ? ' · ETA ' + day(r.eta) : ''));
  return t('On the way in (' + rows.length + '):', 'Aane wala maal (' + rows.length + '):') + '\n' + list.join('\n');
}

// "Billed or not?" - the question this customer asked on 8 Sep, which the bot
// read as an order edit and answered with the open list.
async function billedFor(row, t) {
  const portal = require('../integrations/dealerPortal');
  let rows = [];
  try {
    rows = await portal.recentOrders(row.name, { limit: 8 });
  } catch (e) {
    store.log('sales', 'billing lookup failed for ' + row.name + ': ' + String((e && e.message) || e).slice(0, 110));
    return t("I can't open the order list right now.", 'Order list abhi khul nahi rahi.');
  }
  const mine = rows.filter((o) => same(o.customer_name, row.name) || same(o.buyer_name, row.name));
  const list = (mine.length ? mine : rows).slice(0, 5);
  if (!list.length) return t('Nothing on your account yet.', 'Aapke naam pe abhi koi order nahi hai.');
  const lines = list.map((o) => {
    const billed = o.invoice_no
      ? t('billed · ' + o.invoice_no, 'bill ban gaya · ' + o.invoice_no)
      : /cancel/i.test(String(o.status || ''))
        ? t('cancelled', 'cancel ho gaya')
        : t('not billed yet', 'abhi bill nahi bana');
    return '• ' + o.order_id + ' · ' + day(o.order_date) + ' · ' + billed;
  });
  return lines.join('\n');
}

// Everything above, answered for the number that asked. Returns null when the
// number is not a registered account - then it goes to a person as before.
async function answerOwn(phone, intent, t) {
  const row = await ownRow(phone);
  if (!row) return null;
  if (intent === 'billed') return billedFor(row, t);
  return answer(row, intent, t);
}

// row = the portal account row the desk picked.
async function answer(row, intent, t) {
  if (intent === 'ledger') return ledgerFor(row, t);
  if (intent === 'credit') return creditNotesFor(row, t);
  return ordersFor(row, t);
}

module.exports = { parse, parseOwn, answer, answerOwn, ownRow, ordersFor, parseBill, sendBill, parseOrderDetail, orderDetail, parseDesk, classifyDesk, trackText, invoiceStatusText, shortageText, partStatusText, incomingText, orderListFacts, trackFacts, invoiceFacts, shortageFacts, _internals: { money, day, where, same, cleanName, stageOf }, _ledgerFor: ledgerFor };
