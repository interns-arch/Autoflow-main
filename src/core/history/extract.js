'use strict';
// Turning parsed messages into things worth keeping.
//
// Two very different outputs, because they carry very different trust:
//
//   part mappings   "petrol filter" -> 15410M72R00. Checkable against the
//                   dealer portal, and once checked, genuinely useful.
//   examples        what a customer asked and how a person answered. Useful
//                   for wording and intent, NEVER for stock, price or ETA —
//                   those are stripped before anything is stored.

// ------------------------------------------------------------------ parts
//
// A Maruti/Suzuki part number: five digits, a letter, then the rest, with an
// optional colour or trim suffix ("-C48", "-5PK", "-V6N"). Deliberately tight:
// a loose pattern matched invoice numbers (CT-DL-26-27/1711) far more often
// than parts, which is how 328 "part numbers" turned out to be one invoice
// series repeated.
const PART_NO = /\b(\d{5}[A-Z]\d{2}[A-Z0-9]{2,3}(?:-[A-Z0-9]{2,5})?)\b/gi;

// "5pcs shocker buffer 42111M79M00" — quantity, what the customer calls it,
// and what it actually is. The single most valuable line shape in the whole
// export: it is the customer's own wording, including their spelling, against
// a real part number.
const ORDER_LINE = /^\s*(\d{1,4})\s*(?:pcs?|pc|nos?\.?|no\.?|qty)\s+(.+?)\s+((?:\d{5}[A-Z]\d{2}[A-Z0-9]{2,3}(?:-[A-Z0-9]{2,5})?))\s*$/i;

// Words that describe nothing on their own. "5pcs part 42111M79M00" teaches us
// only that a part is a part.
const EMPTY_NAME = /^(part|parts|item|items|piece|pieces|pcs|no|number|ye|this|wo|that|same|above)$/i;

function normalizePart(p) {
  return String(p || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normalizePhrase(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function partsIn(text) {
  PART_NO.lastIndex = 0;
  const out = [];
  let m;
  while ((m = PART_NO.exec(String(text || '')))) out.push(m[1].toUpperCase());
  return [...new Set(out)];
}

// -> [{ phrase, partNo, qty }]
function orderLines(text) {
  const out = [];
  for (const line of String(text || '').split(/\n+/)) {
    const m = ORDER_LINE.exec(line.trim());
    if (!m) continue;
    const phrase = m[2].trim().replace(/\s+/g, ' ');
    if (phrase.length < 3 || EMPTY_NAME.test(phrase)) continue;
    // A name that is itself a part number teaches nothing.
    if (partsIn(phrase).length) continue;
    out.push({ phrase, partNo: m[3].toUpperCase(), qty: parseInt(m[1], 10) || 1 });
  }
  return out;
}

// ---------------------------------------------------------------- intents
//
// These categories come from reading the 16 supplied exports, not from a
// textbook. The biggest real cluster in this data is not part lookup at all —
// it is fulfilment chatter ("please share invoices", "material ready", "porter
// book"), which is why LOGISTICS and DOCUMENT_REQUEST exist and why most
// examples land there.
const INTENTS = [
  ['CHECK_MRP', /\bmrp\b/i],
  ['CHECK_PRICE', /\b(rate|price|kitne? ka|kitna|cost|amount)\b/i],
  ['DISCOUNT_REQUEST', /\b(discount|less kar|offer|scheme)\b/i],
  ['DOCUMENT_REQUEST', /\b(invoice|bill|ledger|e-?way|gst certificate|quotation)\b/i],
  ['ORDER_PROBLEM', /\b(short|missing|damage[d]?|wrong|galat|kam aaya|nahi aaya|defective|replace)\b/i],
  ['RETURN_REQUEST', /\b(return|wapas|refund)\b/i],
  ['DELIVERY_STATUS', /\b(dispatch|porter|delivery|transport|booking|kab aayega|kab tak|bhej d|material ready|ready hai)\b/i],
  ['PAYMENT', /\b(payment|paid|outstanding|clear kar|utr|neft|rtgs)\b/i],
  ['CHECK_STOCK', /\b(available|avl|stock|milega|milegi|hai kya|h kya|kitna stock)\b/i],
  ['PART_NUMBER_LOOKUP', /\b(part\s*(no|number)|pn\b|number kya)\b/i],
  ['FIND_ALTERNATIVE', /\b(alternative|alternate|substitute|iske badle|koi aur)\b/i],
  ['WARRANTY', /\b(warranty|guarantee)\b/i],
  ['GST', /\bgst\b/i],
];

function intentOf(text, hasParts, hasOrderLines) {
  const t = String(text || '');
  for (const [name, re] of INTENTS) if (re.test(t)) return name;
  if (hasOrderLines) return 'ORDER_REQUEST';
  if (hasParts) return 'PART_NUMBER_LOOKUP';
  return 'OTHER';
}

// What did the person actually DO about it? Kept as a hint for the bot about
// which tool the question calls for, never as an instruction.
function actionOf(response) {
  const t = String(response || '');
  if (/\b(invoice|bill|ledger)\b/i.test(t)) return 'share_document';
  if (/\b(ready|porter|dispatch|book)\b/i.test(t)) return 'confirm_dispatch';
  if (/^\s*\d+(\.\d+)?\s*$/.test(t)) return 'quote_figure';
  if (partsIn(t).length) return 'give_part_number';
  if (/\b(available|hai|stock)\b/i.test(t)) return 'check_stock';
  if (/\b(nahi|not available|out of stock|no stock)\b/i.test(t)) return 'report_unavailable';
  return 'reply';
}

// ------------------------------------------------------- dynamic vs stable
//
// THE RULE THAT MATTERS (spec section 7 and 21): a chat from June saying "4
// piece hain" or "499" is evidence that somebody asked, not a fact about
// today. Any example carrying a live number is marked, and the version the bot
// may imitate has the number taken out. Stock, price and ETA come from the
// portal or they do not get said.
const DYNAMIC = [
  /\b\d+\s*(pcs?|piece|nos?)\b/i,                 // "4 pcs"
  /(?:rs\.?|inr|₹)\s*\d+/i,                        // "Rs 499"
  /\b\d+(?:\.\d+)?\s*(?:%|percent|pct)\b/i,        // "10%"
  /\b(?:mrp|rate|price)\s*[:\-]?\s*\d+/i,          // "MRP 499"
  /^\s*\d{2,6}(?:\.\d+)?\s*$/,                     // a bare figure, the whole reply
  /\b\d+\s*(?:din|days?|hafta|week)\b/i,           // "2 days"
];

function hasDynamicFacts(text) {
  return DYNAMIC.some((re) => re.test(String(text || '')));
}

// The reply with its live numbers replaced by placeholders. This is what gets
// embedded and what the bot may learn wording from.
function responsePattern(text) {
  let t = String(text || '');
  t = t.replace(/(?:rs\.?|inr|₹)\s*\d+(?:\.\d+)?/gi, '{price}');
  t = t.replace(/\b\d+(?:\.\d+)?\s*(?:%|percent|pct)\b/gi, '{discount}');
  t = t.replace(/\b\d+\s*(pcs?|piece|nos?)\b/gi, '{qty} $1');
  t = t.replace(/\b(mrp|rate|price)(\s*[:\-]?\s*)\d+(?:\.\d+)?/gi, '$1$2{price}');
  t = t.replace(/\b\d+\s*(din|days?|hafta|week)\b/gi, '{eta} $1');
  t = t.replace(/^\s*\d{2,6}(?:\.\d+)?\s*$/, '{price}');
  return t.trim();
}

// ---------------------------------------------------------------- pairing
//
// A customer asked; a person answered. In a group with eleven people the next
// employee message is often NOT a reply, so this is deliberately strict:
// the reply must come soon after, from a person, and neither side may be
// noise. It still produces some mismatched pairs — which is why examples are
// EXAMPLES and arrive as pending_review.
const REPLY_WINDOW_MS = 2 * 60 * 60 * 1000;

function pairs(messages) {
  const out = [];
  let pending = null;
  for (const m of messages) {
    if (m.noise || !m.text) continue;
    if (m.senderType === 'CUSTOMER') {
      pending = m;
      continue;
    }
    if (m.senderType !== 'EMPLOYEE' || !pending) continue;
    const gap = m.at && pending.at ? m.at.getTime() - pending.at.getTime() : 0;
    if (gap < 0 || gap > REPLY_WINDOW_MS) {
      pending = null;
      continue;
    }
    // One-word acknowledgements answer nothing.
    if (/^(ok(ay|ey)?|yes|yeah|ji|haan|hmm+|thanks?|thank you|👍|🙏|\.\.\.|\?)$/i.test(m.text.trim())) {
      pending = null;
      continue;
    }
    out.push({ question: pending, answer: m });
    pending = null;
  }
  return out;
}

// ------------------------------------------------------------------ build
//
// -> { examples, mappings, counts }
function fromChat(messages, conversationId) {
  const examples = [];
  const mappingRows = new Map(); // normalizedPhrase||normalizedPart -> row
  const counts = { orderLines: 0, parts: new Set(), intents: new Map() };

  // The customer on this chat: the phone number that speaks most. A dealer
  // group has one dealer and several of our people.
  const talkers = new Map();
  for (const m of messages) {
    if (m.senderType !== 'CUSTOMER') continue;
    talkers.set(m.sender, (talkers.get(m.sender) || 0) + 1);
  }
  const customerId = [...talkers].sort((a, b) => b[1] - a[1]).map(([s]) => s.replace(/\D/g, ''))[0] || null;

  // part mappings, from anybody's structured lines
  for (const m of messages) {
    if (m.noise || !m.text) continue;
    for (const ol of orderLines(m.text)) {
      counts.orderLines++;
      counts.parts.add(ol.partNo);
      const k = normalizePhrase(ol.phrase) + '||' + normalizePart(ol.partNo);
      const row = mappingRows.get(k) || {
        phrase: ol.phrase,
        normalizedPhrase: normalizePhrase(ol.phrase),
        resolvedPartNo: ol.partNo,
        normalizedPartNo: normalizePart(ol.partNo),
        evidence: 0,
        conversations: new Set(),
        firstSeen: m.at,
        lastSeen: m.at,
      };
      row.evidence++;
      row.conversations.add(conversationId);
      if (m.at && (!row.firstSeen || m.at < row.firstSeen)) row.firstSeen = m.at;
      if (m.at && (!row.lastSeen || m.at > row.lastSeen)) row.lastSeen = m.at;
      mappingRows.set(k, row);
    }
  }

  // examples, from customer -> employee pairs
  for (const p of pairs(messages)) {
    const q = p.question.text;
    const a = p.answer.text;
    const qParts = partsIn(q);
    const qLines = orderLines(q);
    const intent = intentOf(q, qParts.length > 0, qLines.length > 0);
    counts.intents.set(intent, (counts.intents.get(intent) || 0) + 1);
    const aParts = partsIn(a);
    examples.push({
      conversationId,
      messageId: (p.question.at ? p.question.at.toISOString() : 'x') + '|' + p.question.sender,
      customerId,
      employeeId: p.answer.sender,
      customerMessage: q,
      employeeResponse: a,
      responsePattern: responsePattern(a),
      hasDynamicFacts: hasDynamicFacts(a),
      normalizedPartNo: qParts.length ? normalizePart(qParts[0]) : null,
      resolvedPartNo: aParts.length ? aParts[0] : qParts[0] || null,
      intent,
      employeeAction: actionOf(a),
      messageAt: p.question.at,
    });
  }

  return { examples, mappings: [...mappingRows.values()], counts, customerId };
}

module.exports = {
  fromChat,
  orderLines,
  partsIn,
  normalizePart,
  normalizePhrase,
  intentOf,
  actionOf,
  hasDynamicFacts,
  responsePattern,
  pairs,
  INTENTS,
};
