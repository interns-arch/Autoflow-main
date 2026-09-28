'use strict';
// THE NEW ACCOUNT'S DISCOUNT, set up by the agent who opened it.
//
// Founder, 22 Sep: once a new customer goes for approval, the agent is asked
// for the discount rule - brand-wise or part-wise, which brand or part, how
// much, the quantity and amount limits, and for how long - exactly the fields
// of the portal's "Create Discount Rule" screen. Nothing is created then: the
// rules wait on the request, and are created on the portal the moment the
// account is approved, starting that day. A rejected account takes its rules
// with it.
//
// The rule is named "<customer as the portal has them> <brand or part> <n>%".
const store = require('../store');
const chatState = require('./chatState');

const open = chatState.slot('discountSetup'); // agent chatId -> { requestId, customer, step, draft, at }
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

const STEPS = ['type', 'target', 'value', 'minQty', 'maxQty', 'minAmount', 'maxAmount', 'duration', 'confirm', 'more'];
const SKIP = /^(skip|nahi|nhi|no|na|-|none|kuch nahi|default|n\/a)$/i;
const LATER = /^(abhi nahi|baad mein|baad me|later|rehne do|rhne do|cancel|stop|DSC_LATER)$/i;
const YES = /^(haan+|han|ha|yes|y|ok|okay|ji|sahi|sahi hai|theek|thik|done|DSC_YES|DSC_MORE_YES)\b/i;
const NO = /^(nahi+|nhi|no|n|na|mat|DSC_NO|DSC_MORE_NO)\b/i;

function get(chatId) {
  const s = open.get(chatId);
  if (s && Date.now() - (s.at || 0) > MAX_AGE_MS) {
    open.delete(chatId);
    return null;
  }
  return s || null;
}
const pending = (chatId) => Boolean(get(chatId));
function save(chatId, s) {
  s.at = Date.now();
  open.set(chatId, s);
}
function cancel(chatId) {
  open.delete(chatId);
}

// "12", "12%", "12.5 percent" -> 12.5
function readNumber(text) {
  const m = String(text || '').replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

// "30 din", "3 mahine", "1 saal", "6 months", "2 week" -> days; "hamesha" -> null (no end)
function readDuration(text) {
  const t = String(text || '').toLowerCase().trim();
  if (/^(hamesha|always|forever|no end|koi limit nahi|unlimited|skip|-)$/.test(t)) return { days: null, label: 'no end date' };
  const n = readNumber(t);
  if (!n) return undefined;
  if (/(saal|sal|year|yr|varsh)/.test(t)) return { days: Math.round(n * 365), label: `${n} ${n === 1 ? 'year' : 'years'}` };
  if (/(mahin|mahine|month|mon\b|mth)/.test(t)) return { days: Math.round(n * 30), label: `${n} ${n === 1 ? 'month' : 'months'}` };
  if (/(hafte|hafta|week|wk)/.test(t)) return { days: Math.round(n * 7), label: `${n} ${n === 1 ? 'week' : 'weeks'}` };
  return { days: Math.round(n), label: `${n} days` };
}

function ruleName(customer, target, value) {
  return `${String(customer || '').trim()} ${String(target || '').trim()} ${value}%`.replace(/\s+/g, ' ').trim();
}

// One rule, written out for the agent to check.
function describe(r, t) {
  const lines = [
    `*${r.ruleName}*`,
    `${r.kind === 'brand' ? t('Brand', 'Brand') : t('Part', 'Part')}: ${r.target}`,
    `${t('Discount', 'Discount')}: ${r.value}%`,
    `${t('Min qty', 'Min qty')}: ${r.minQty}${r.maxQty ? ` · ${t('Max qty', 'Max qty')}: ${r.maxQty}` : ''}`,
    r.minAmount || r.maxAmount ? `${t('Amount', 'Amount')}: ${r.minAmount ? '₹' + r.minAmount : '-'} to ${r.maxAmount ? '₹' + r.maxAmount : '-'}` : null,
    `${t('Valid', 'Valid')}: ${t('from approval', 'approval ke din se')}, ${r.durationLabel}`,
  ];
  return lines.filter(Boolean).join('\n');
}

// THE START A RULE IS WRITTEN WITH: midnight the day before (see toPortal),
// or the rule's own start when that is earlier still. null stays null - the
// portal's own rules often have no start at all.
function opensFrom(existing, now = new Date()) {
  const iso = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
  const opens = new Date(now);
  opens.setDate(opens.getDate() - 1);
  opens.setHours(0, 0, 0, 0);
  if (existing === null) return null;
  if (existing && new Date(existing).getTime() <= opens.getTime()) return existing;
  return iso(opens);
}

// What the portal is sent, once the account exists. `target` is what
// dealerPortal.dealerIdForAccount found: { dealerId, accountId, odooPartnerId }.
// The rule carries the account and Odoo partner it was resolved from, and
// createDiscountRule reads the dealer back and refuses a mismatch
// (integrations/portalContracts). A bare number is taken as a dealer id only
// in tests (mock portal).
function toPortal(r, target, customerName, from = new Date()) {
  const tg = target && typeof target === 'object' ? target : { dealerId: target };
  const dealerId = tg.dealerId;
  const start = new Date(from);
  let end = null;
  if (r.days) {
    end = new Date(start.getTime() + r.days * 24 * 60 * 60 * 1000);
    end.setHours(23, 59, 59, 0);
  }
  const iso = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
  // THE RULE STARTS AT MIDNIGHT YESTERDAY, not "now". valid_from is written
  // in IST with no zone, and the portal's rule check at order punch compares
  // it with the time in UTC - so a rule made at 11:44 IST only began to count
  // at 17:14 IST. 28 Sep, live: rule 2873 (Customer Testing, MARUTI 10%,
  // APPROVED) was not even a candidate on SO 1458, punched at 12:42 IST
  // (discount_rule_eval: {winner: null, candidates: []}). A day's head start
  // covers any zone; the end date is still counted from today.
  const opens = new Date(start);
  opens.setDate(opens.getDate() - 1);
  opens.setHours(0, 0, 0, 0);
  return {
    rule_type: r.kind === 'brand' ? 'BRAND' : 'ITEM',
    brand: r.kind === 'brand' ? r.target : null,
    part_no: r.kind === 'part' ? r.target : null,
    dealer_id: dealerId,
    discount_mode: 'PERCENT',
    discount_value: r.value,
    min_qty: r.minQty || 1,
    max_qty: r.maxQty || null,
    min_amount: r.minAmount || null,
    max_amount: r.maxAmount || null,
    is_active: true,
    // Only ever sent after a Sales Head said "OK DSC-…" on WhatsApp.
    approval_status: 'APPROVED',
    valid_from: iso(opens),
    valid_to: end ? iso(end) : null,
    priority: 100,
    // The name carries the customer as the PORTAL has them, which may differ
    // from what was typed into the form.
    rule_name: ruleName(customerName || r.customer, r.target, r.value),
    rule_metadata: {
      source: 'whatsapp-bot',
      requestId: r.requestId,
      setBy: r.setBy || null,
      ...(tg.accountId ? { account_id: tg.accountId } : {}),
      ...(tg.odooPartnerId ? { odoo_partner_id: tg.odooPartnerId } : {}),
    },
  };
}

// ---- the rule that prices a line ----
//
// The portal's commercial-analyze answers every line at MRP with
// discount_percent 0 — 25 Sep, live: MIYA JI MOTORS had an approved MARUTI
// 10% rule and a MARUTI headlight came back at ₹21,310, and dealer 1002's
// APPROVED MARUTI 12% was not applied either. So the rule is applied here.
//
// A rule counts only when it is APPROVED on the portal - the same test the
// portal applies at order punch, so a quote never shows a discount the SO
// will not carry. (Until 28 Sep the bot's own PENDING rules counted too, and
// quotes said 10% off while SO 1458 was punched at 0%.) The Super Admin
// approves on the portal; from that moment quotes and orders both have it.
//
// Most specific wins: a rule for this part, then for its brand, then one for
// every part; between two of the same kind, the bigger discount.
const counts = (r) =>
  r &&
  r.is_active !== false &&
  String(r.discount_mode || 'PERCENT').toUpperCase() === 'PERCENT' &&
  // Rejected on the portal never counts, the bot's own included (26 Sep:
  // rule 2869, written to the wrong dealer and rejected in Super Admin,
  // still priced that dealer's parts at 15% off).
  String(r.approval_status || '').toUpperCase() === 'APPROVED';

// ONE MAKER, SEVERAL SPELLINGS. The portal's brand list offers "MARUTI
// SUZUKI" while a rule read back says "MARUTI" and a part row can say either
// (28 Sep, live: MIYA JI MOTORS' approved MARUTI rule #2872 punched at 0%).
// Two brands are the same when they are spelt alike, or when both are
// spellings of one maker listed below — only listed ones: "TATA" and "TATA
// AUTOCOMP" are two companies, and a wrong match is a discount nobody gave.
const SAME_MAKER = [['MARUTI', 'SUZUKI', 'MARUTISUZUKI', 'MSIL', 'MARUTISUZUKIGENUINE', 'MGP']];
const brandKey = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
function sameBrand(a, b) {
  const x = brandKey(a);
  const y = brandKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return SAME_MAKER.some((g) => g.includes(x) && g.includes(y));
}

function ruleFor(rules, { dealerId, partNo, brand, qty = 1, now = new Date() } = {}) {
  const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const t = new Date(now).getTime();
  const inDate = (r) => (!r.valid_from || new Date(r.valid_from).getTime() <= t) && (!r.valid_to || new Date(r.valid_to).getTime() >= t);
  const inQty = (r) => (!r.min_qty || qty >= Number(r.min_qty)) && (!r.max_qty || qty <= Number(r.max_qty));
  const kind = (r) => {
    const type = String(r.rule_type || '').toUpperCase();
    if (type === 'ITEM') return r.part_no && norm(r.part_no) === norm(partNo) ? 3 : 0;
    if (type === 'BRAND') return r.brand && brand && sameBrand(r.brand, brand) ? 2 : 0;
    return !r.part_no && !r.brand ? 1 : 0; // every part for this customer
  };
  let best = null;
  for (const r of rules || []) {
    if (Number(r.dealer_id) !== Number(dealerId) || !counts(r) || !inDate(r) || !inQty(r)) continue;
    const k = kind(r);
    if (!k || !(Number(r.discount_value) > 0)) continue;
    if (!best || k > best.k || (k === best.k && Number(r.discount_value) > Number(best.r.discount_value))) best = { r, k };
  }
  return best ? best.r : null;
}

// Every rule this customer has today that counts (see ruleFor), for "mere
// discount kya hain" and for the note under a price list.
function activeRules(rules, dealerId, now = new Date()) {
  const t = new Date(now).getTime();
  return (rules || [])
    .filter((r) => Number(r.dealer_id) === Number(dealerId) && counts(r) && Number(r.discount_value) > 0)
    .filter((r) => (!r.valid_from || new Date(r.valid_from).getTime() <= t) && (!r.valid_to || new Date(r.valid_to).getTime() >= t))
    .map((r) => {
      const type = String(r.rule_type || '').toUpperCase();
      return {
        on: type === 'ITEM' ? `part ${r.part_no}` : type === 'BRAND' ? `all ${r.brand} parts` : 'all parts',
        percent: Number(r.discount_value),
        minQty: Number(r.min_qty) > 1 ? Number(r.min_qty) : null,
        validTill: r.valid_to ? String(r.valid_to).slice(0, 10) : null,
      };
    });
}

// ---- approval ----
// Every rule - a new one, or a change to one that exists - goes to the Sales
// Head first (founder, 22 Sep), and the portal is only touched after "OK DSC-…".
// id -> { id, type: 'new'|'change', rule, dealerId, customer, accountRequestId,
//         ruleId, oldValue, status: 'pending'|'approved', by, chatId, at }
const requests = chatState.slot('discountRequests');

function newId() {
  let id;
  do id = 'DSC-' + Math.random().toString(36).slice(2, 6).toUpperCase();
  while (requests.get(id));
  return id;
}
function file(req) {
  req.id = req.id || newId();
  req.status = req.status || 'pending';
  req.at = Date.now();
  requests.set(req.id, req);
  return req;
}
const find = (id) => requests.get(String(id || '').toUpperCase()) || null;
const drop = (id) => requests.delete(String(id || '').toUpperCase());
// Those waiting on a new account's approval.
function forAccount(accountRequestId) {
  return [...requests.values()].filter((r) => r.accountRequestId === accountRequestId);
}

const money = (v) => '₹' + Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const round2 = (v) => Math.round(v * 100) / 100;

// "Sell 71761M67LA05PK at ₹70" against an MRP of ₹80 is 12.5% off.
function pctFromPrice(mrp, price) {
  if (!(mrp > 0) || !(price > 0) || price >= mrp) return null;
  return round2(((mrp - price) / mrp) * 100);
}
const priceAt = (mrp, pct) => round2(mrp * (1 - pct / 100));

// What the Sales Head reads: who, what, how much off - in money where there
// is a price to put it against.
function approvalText(req) {
  const r = req.rule;
  const target = r.kind === 'brand' ? `Brand: ${r.target}` : r.kind === 'dealer' ? 'All parts' : `Part: ${r.target}`;
  const money2 = r.mrp
    ? `\nMRP ${money(r.mrp)} → sells at ${money(priceAt(r.mrp, r.value))} (${r.value}% off, ${money(round2(r.mrp - priceAt(r.mrp, r.value)))} per piece)`
    : '';
  if (req.type === 'change') return changeText(req);
  const head = `*Discount rule* — ${req.id}\nCustomer: ${req.customer}${req.accountRequestId ? ` (new account ${req.accountRequestId})` : ''}\n${target} — ${r.value}%`;
  const limits = [
    r.minQty ? `Min qty ${r.minQty}` : null,
    r.maxQty ? `Max qty ${r.maxQty}` : null,
    r.minAmount ? `Min amount ${money(r.minAmount)}` : null,
    r.maxAmount ? `Max amount ${money(r.maxAmount)}` : null,
    req.type === 'change' ? null : `Valid: ${r.durationLabel || 'no end date'} from approval`,
  ].filter(Boolean);
  return (
    head +
    money2 +
    (limits.length ? '\n' + limits.join(' · ') : '') +
    `\nAsked by: ${req.by || 'customer'}` +
    `\n\nReply *OK ${req.id}* to approve, or *NO ${req.id}* to reject.`
  );
}

// ASKING FOR A DISCOUNT TO BE SET UP.
//
// A CHANGE, written so the Sales Head can decide from this message alone:
// who, which rule, what it is now, what they want instead, what that does to
// a price, and that saying OK changes only the % on the rule that exists.
function changeText(req) {
  const r = req.rule;
  const o = req.oldRule || {};
  const phone = req.customerPhone ? ` (+${String(req.customerPhone).replace(/^\+/, '')})` : '';
  const what = r.kind === 'brand' ? `Brand ${r.target}` : r.kind === 'part' ? `Part ${r.target}` : 'All parts';
  const delta = round2(r.value - req.oldValue);
  const date = (v) => (v ? new Date(v).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : null);
  const limits = [
    o.minQty ? `Min qty ${o.minQty}` : null,
    o.maxQty ? `Max qty ${o.maxQty}` : null,
    o.validTo ? `valid till ${date(o.validTo)}` : 'no end date',
  ].filter(Boolean);
  const lines = [
    `*Discount change* — ${req.id}`,
    `Customer: ${req.customer}${phone}`,
    `Rule: ${req.oldName || '#' + req.ruleId}${req.ruleId ? ` (#${req.ruleId})` : ''}`,
    `On: ${what}`,
    `Current discount: *${req.oldValue}%*`,
    `Customer wants: *${r.value}%* (${delta > 0 ? '+' : ''}${delta}%)`,
    r.mrp
      ? `MRP ${money(r.mrp)}: now ${money(priceAt(r.mrp, req.oldValue))} → would be ${money(priceAt(r.mrp, r.value))}`
      : `On MRP ₹1,000: now ${money(priceAt(1000, req.oldValue))} → would be ${money(priceAt(1000, r.value))}`,
    `Rule stays: ${limits.join(' · ')}`,
    `Asked by: ${req.by || 'customer'}`,
    '',
    `OK changes only the % on this rule — no new rule is made.`,
    `Reply *OK ${req.id}* to approve, or *NO ${req.id}* to reject.`,
  ];
  return lines.join('\n');
}

// "discount change karna hai", "mera discount badhao", "Kalra ka discount
// update", "mera discount setup kardo".
//
// That last one used to miss, and missing is expensive: the message fell
// through to small talk, which answered "seniors se confirm karke bataunga"
// — a sentence that promises a callback nobody has been asked to make. The
// customer thinks it is in hand; nothing has been filed and nobody has been
// told. Live, 24 Sep.
//
// The hole was "\bset\b", which does not match "setup": \b needs a non-word
// character after "set", and "u" is a word character. So the verbs are listed
// properly now, including the ways people actually ask for one to be MADE
// rather than changed — banao, chahiye, lagwana, karwana.
const VERB =
  '(?:change|chnage|badal\\w*|update|badha\\w*|kam\\s*kar\\w*|increase|decrease|revise|' +
  'set\\s*up|setup|set|lagao|lagana|laga\\s*do|lagw\\w*|naya|new|create|make|start|add|chalu|shuru\\w*|' +
  'bana\\w*|banw\\w*|karw\\w*|kar\\s*do|kardo|karo|karna|chahiye|chaiye|de\\s*do|dedo)';

const WANTS_RE = new RegExp(
  '\\bdiscount\\b.{0,40}\\b' + VERB + '\\b|\\b' + VERB + '\\b.{0,40}\\bdiscount\\b',
  'i',
);

// A QUESTION IS NOT A REQUEST.
//
// "discount kitna hai", "kitna milega", "aapki discount policy kya hai" are
// asking what the discount IS. Starting a nine-question setup on those would
// answer nothing they asked and take over the conversation — and "chahiye" in
// the verbs above makes that easy to trip, so the guard earns its place.
const ASKING_RE = /\b(kitna|kitni|kitne|how\s*much|what\s*is|kya\s*hai|kya\s*h|policy|milega|milta|hota\s*hai)\b/i;

// -> true when this message is asking for a discount rule to be set up or
// changed, and is not merely asking what the discount is.
function wantsSetup(text) {
  const s = String(text || '');
  return WANTS_RE.test(s) && !ASKING_RE.test(s);
}

// Kept for anything still testing the raw pattern; wantsSetup is the one to
// call, because it carries the question guard with it.
const CHANGE_RE = WANTS_RE;

module.exports = {
  open, get, pending, save, cancel, STEPS, SKIP, LATER, YES, NO, readNumber, readDuration, ruleName, describe, toPortal,
  requests, file, find, drop, forAccount, approvalText, pctFromPrice, priceAt, money, CHANGE_RE, wantsSetup, ruleFor, activeRules, opensFrom,
};
