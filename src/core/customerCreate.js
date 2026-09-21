'use strict';
// A NEW CUSTOMER, asked for one question at a time.
//
// The paper form says "filled by the sales person, goes to Sales Head for
// approval, then to the data team for entry". This is that form, asked in
// chat — and the approval is kept, deliberately. Two of its fields are
// credit limit and brand-wise discount, and the person being onboarded does
// not get to set those. So:
//
//   customer answers  -> the facts about their firm
//   config supplies   -> the commercial defaults (core config `creation`)
//   an approver says yes -> only then is anything created on the portal
//
// The order of the questions follows the paper form, because the sales desk
// reads them in that order when they check one.
//
// No GST lookup: only the SHAPE of a GSTIN is checked here. There is no GST
// API key, so the number is recorded as given and a person verifies it at
// approval — the form has always worked that way.
const store = require('../store');
const config = require('../config');
const chatState = require('./chatState');

const open = chatState.slot('customerCreate'); // chatId -> form in progress
const MAX_AGE_MS = 6 * 60 * 60 * 1000; // a form abandoned at lunch is not resumed at five

function sweep() {
  const now = Date.now();
  for (const [chatId, f] of open) if (now - (f.at || 0) > MAX_AGE_MS) open.delete(chatId);
}

// ---------------------------------------------------------------- the form

// Shape only, never a lookup. A wrong-shaped GSTIN is a typo worth catching
// in the moment; a well-shaped one that belongs to nobody is a job for the
// person who approves this.
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z][Z][0-9A-Z]$/i;
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PIN_RE = /^[1-9][0-9]{5}$/;

const SKIP = /^(skip|nahi|nhi|no|na|-|n\/a|none|baad mein|later)$/i;
// A way OUT. Once the form is open every message is an answer to it, so
// without this a customer who changed their mind would be filling in a shop
// address to escape. Their cart is untouched — only the form closes.
const QUIT = /^(cancel|stop|rehne do|rhne do|chhodo|chodo|baad me karenge|baad mein karenge|nahi banana|abhi nahi)$/i;

const FIELDS = [
  {
    key: 'name',
    req: true,
    ask: ['Firm / shop name?', 'Firm ya shop ka naam?'],
  },
  {
    key: 'businessType',
    req: true,
    ask: ['Business type? (retailer / wholesaler / garage / fleet)', 'Business type? (retailer / wholesaler / garage / fleet)'],
  },
  {
    key: 'contactPerson',
    req: true,
    ask: ['Contact person ka naam?', 'Contact person ka naam?'],
  },
  {
    key: 'gstNo',
    req: false,
    ask: ['GST number? (nahi hai to "skip")', 'GST number? (nahi hai to "skip" likh dijiye)'],
    check: (v) => (GSTIN_RE.test(v.replace(/\s/g, '')) ? null : 'GST number 15 character ka hota hai, jaise 07AABCU9603R1ZM. Dobara bhejiye ya "skip".'),
    clean: (v) => v.replace(/\s/g, '').toUpperCase(),
  },
  {
    key: 'panNo',
    req: false,
    ask: ['PAN number? (optional)', 'PAN number? (optional, "skip" chalega)'],
    check: (v) => (PAN_RE.test(v.replace(/\s/g, '')) ? null : 'PAN 10 character ka hota hai, jaise AABCU9603R. Dobara bhejiye ya "skip".'),
    clean: (v) => v.replace(/\s/g, '').toUpperCase(),
  },
  {
    key: 'email',
    req: false,
    ask: ['Email address? (optional)', 'Email address? (optional)'],
    check: (v) => (EMAIL_RE.test(v) ? null : 'Email theek nahi lag raha. Dobara bhejiye ya "skip".'),
  },
  {
    key: 'address',
    req: true,
    ask: ['Shop ka pura address?', 'Shop ka pura address?'],
  },
  { key: 'city', req: true, ask: ['City?', 'City?'] },
  { key: 'state', req: true, ask: ['State?', 'State?'] },
  {
    key: 'pin',
    req: true,
    ask: ['PIN code?', 'PIN code?'],
    check: (v) => (PIN_RE.test(v.replace(/\s/g, '')) ? null : 'PIN 6 digit ka hota hai. Dobara bhejiye.'),
    clean: (v) => v.replace(/\s/g, ''),
  },
  {
    key: 'location',
    req: true,
    type: 'location',
    // Typing "28.6139" by hand is how a shop ends up in the sea. WhatsApp's
    // own location share is one tap and exact.
    ask: [
      'Shop ki location bhej dijiye — attach (📎) → Location → Send your current location.',
      'Shop ki location bhej dijiye — attach (📎) → Location → Send your current location.',
    ],
  },
  {
    key: 'shopPhoto',
    req: true,
    type: 'photo',
    ask: [
      'Shop ke saamne ki photo bhejiye, jisme owner bhi dikhein.',
      'Shop ke saamne ki photo bhejiye, jisme owner bhi dikhein.',
    ],
  },
  { key: 'remarks', req: false, ask: ['Aur kuch batana hai? (optional)', 'Aur kuch batana hai? (optional)'] },
];

// What a CUSTOMER is never asked. These are the Sales Head's to set, and
// they are filled from config so the request is complete when it reaches
// them — an approver changing a number is a conversation, a customer
// choosing one is not.
function commercialDefaults() {
  return {
    creditDays: config.creation.defaultCreditDays,
    creditLimit: config.creation.defaultCreditLimit,
  };
}

// "Create customer", "account bana do", "naya account chahiye".
//
// 21 Sep, live: a customer typed "Create coustomer" and the bot searched the
// catalogue for it, answering with sixty headlight restorers. There was no
// way to ASK for the form — it only opened by itself when an unregistered
// number confirmed an order. Spellings are loose on purpose: coustomer,
// custmer and costumer are all how it actually arrives.
const WORD_ACCOUNT = '(?:customer|coustomer|custmer|costumer|custumer|account|akaunt|khata|khaata|id)';
const WORD_MAKE = '(?:creat\\w*|new|naya|nayi|register|registr\\w*|banao|bana\\s?do|bana\\s?dijiye|banana|banwana|kholo|khol\\s?do|open|add)';
const START_RE = new RegExp(
  `\\b${WORD_MAKE}\\b[\\s\\S]{0,24}\\b${WORD_ACCOUNT}\\b` +
    `|\\b${WORD_ACCOUNT}\\b[\\s\\S]{0,24}\\b${WORD_MAKE}\\b` +
    `|\\b${WORD_ACCOUNT}\\s+(?:chahiye|chaiye|kab\\s+banega|nahi\\s+hai)\\b`,
  'i',
);
// The same words appear in questions ABOUT an account, which are not a
// request to open one. "Account balance", "khata dekho", a ledger.
const NOT_START_RE = /\b(balance|statement|ledger|bakaya|baaki|outstanding|bill|invoice|payment|due|kitna|number|no\.?)\b/i;

function wantsToStart(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 90) return false;
  if (NOT_START_RE.test(t)) return false;
  return START_RE.test(t);
}

// ------------------------------------------------------------- the machine

function pending(chatId) {
  sweep();
  return open.get(chatId) || null;
}

function cancel(chatId) {
  open.delete(chatId);
}

function fieldAt(i) {
  return FIELDS[i] || null;
}

// Start the form. `by` is whoever is filling it in — a salesman on the
// customer's behalf, or the customer themselves.
function start(chatId, phone, t) {
  sweep();
  const filler = store.normPhone(phone);
  const form = {
    at: Date.now(),
    chatId,
    phone: filler,
    // A number on the creation team is a colleague filling this in; anyone
    // else is the customer registering themselves. Recorded because the
    // approver needs to know which they are reading.
    byName: config.creation.team[filler] || null,
    idx: 0,
    answers: { phone: filler },
  };
  open.set(chatId, form);
  store.log('create', `${chatId}: customer form started by ${form.byName || filler}`);
  return t(
    `Account banane ke liye kuch details chahiye — ek ek karke poochta hoon.\n\n${FIELDS[0].ask[1]}`,
    `Account banane ke liye kuch details chahiye — ek ek karke poochta hoon.\n\n${FIELDS[0].ask[1]}`,
  );
}

// One answer. `m` is the whole message, so a photo or a dropped pin can be
// the answer as easily as text.
//
// Returns { reply, done, form } — `done` true when every field is in.
function answer(chatId, m, text, t) {
  const form = pending(chatId);
  if (!form) return null;
  const field = fieldAt(form.idx);
  if (!field) return null;

  const said = String(text || '').trim();
  form.at = Date.now();

  if (QUIT.test(said)) {
    open.delete(chatId);
    store.log('create', `${chatId}: customer form cancelled by the customer`);
    return {
      reply: t(
        'Theek hai, rehne dete hain. Jab kahiye tab bana denge — aapki list waise hi hai.',
        'Theek hai, rehne dete hain. Jab kahiye tab bana denge — aapki list waise hi hai.',
      ),
      done: false,
      quit: true,
      form,
    };
  }

  // "skip" on an optional field moves on; on a required one it does not.
  if (SKIP.test(said)) {
    if (field.req && field.type !== 'location' && field.type !== 'photo') {
      return { reply: t('Ye chhod nahi sakte sir — ' + field.ask[1], 'Ye chhod nahi sakte sir — ' + field.ask[1]), done: false, form };
    }
    if (!field.req) return advance(form, t);
  }

  if (field.type === 'location') {
    const loc = m && m.location;
    if (!loc || !Number.isFinite(loc.lat)) {
      return {
        reply: t(
          'Location attach karke bhejiye (📎 → Location). Type karne ki zarurat nahi.',
          'Location attach karke bhejiye (📎 → Location). Type karne ki zarurat nahi.',
        ),
        done: false,
        form,
      };
    }
    form.answers.lat = loc.lat;
    form.answers.lng = loc.lng;
    return advance(form, t);
  }

  if (field.type === 'photo') {
    if (!m || !m.mediaBase64 || !/^image\//.test(m.mediaMime || '')) {
      return {
        reply: t('Photo bhejiye sir — shop ke saamne ki, owner ke saath.', 'Photo bhejiye sir — shop ke saamne ki, owner ke saath.'),
        done: false,
        form,
      };
    }
    // The bytes are NOT kept in state.json: it is rewritten whole on every
    // save and a photo in it would be copied on every write. chatLog already
    // stored this image on disk when it arrived; the approver is sent the
    // picture itself, which is what they actually look at.
    form.answers.shopPhoto = { mime: m.mediaMime, bytes: m.mediaBase64.length };
    form._photo = m.mediaBase64;
    return advance(form, t);
  }

  if (!said) {
    return { reply: t(field.ask[1], field.ask[1]), done: false, form };
  }
  if (field.check) {
    const problem = field.check(said);
    if (problem) return { reply: problem, done: false, form };
  }
  form.answers[field.key] = field.clean ? field.clean(said) : said;
  return advance(form, t);
}

function advance(form, t) {
  form.idx += 1;
  const next = fieldAt(form.idx);
  if (next) {
    open.set(form.chatId, form);
    return { reply: t(next.ask[1], next.ask[1]), done: false, form };
  }
  // Every field is in. The commercial terms join it here, from config.
  Object.assign(form.answers, commercialDefaults(), { kind: 'customer' });
  form.answers.requestId = 'WA-' + Date.now().toString(36).toUpperCase();
  open.set(form.chatId, form);
  store.log('create', `${form.chatId}: form complete — ${form.answers.name} (${form.answers.requestId})`);
  return { reply: null, done: true, form };
}

// What the approver reads. Every field, in the order of the paper form, so
// it can be checked against one.
function summary(form, t) {
  const a = form.answers;
  const line = (label, v) => (v === undefined || v === null || v === '' ? null : `${label}: ${v}`);
  return [
    `*New customer* — ${a.requestId}`,
    form.byName ? `Bheja: ${form.byName}` : `Bheja: customer khud (${a.phone})`,
    '',
    line('Firm', a.name),
    line('Business type', a.businessType),
    line('Contact', a.contactPerson),
    line('Mobile', a.phone),
    line('GSTIN', a.gstNo),
    line('PAN', a.panNo),
    line('Email', a.email),
    '',
    line('Address', a.address),
    line('City', a.city),
    line('State', a.state),
    line('PIN', a.pin),
    a.lat ? `Location: ${a.lat}, ${a.lng}` : null,
    '',
    line('Credit days', a.creditDays),
    line('Credit limit', a.creditLimit),
    line('Remarks', a.remarks),
    '',
    t(
      `Reply *OK ${a.requestId}* to create, or *NO ${a.requestId}* to reject.`,
      `*OK ${a.requestId}* bhejiye banane ke liye, ya *NO ${a.requestId}* reject karne ke liye.`,
    ),
  ]
    .filter((l) => l !== null)
    .join('\n');
}

// "OK WA-ABC123" / "NO WA-ABC123" from an approver.
function readDecision(text) {
  const m = String(text || '').trim().match(/^(ok|yes|haan|approve|no|nahi|reject)\s+(WA-[A-Z0-9]+)$/i);
  if (!m) return null;
  return { yes: /^(ok|yes|haan|approve)$/i.test(m[1]), requestId: m[2].toUpperCase() };
}

function isApprover(phone) {
  return Boolean(config.creation.approvers[store.normPhone(phone)]);
}
function approverName(phone) {
  return config.creation.approvers[store.normPhone(phone)] || store.normPhone(phone);
}

// Forms waiting on a yes, by request id. Kept out of the per-chat slot
// because the approver answers from THEIR chat, not the customer's.
const awaiting = chatState.slot('customerCreate.awaiting');

function park(form) {
  awaiting.set(form.answers.requestId, { at: Date.now(), chatId: form.chatId, answers: form.answers, byName: form.byName });
  open.delete(form.chatId);
}
function parked(requestId) {
  return awaiting.get(String(requestId || '').toUpperCase()) || null;
}
function unpark(requestId) {
  awaiting.delete(String(requestId || '').toUpperCase());
}

module.exports = {
  wantsToStart,
  start,
  answer,
  pending,
  cancel,
  summary,
  readDecision,
  isApprover,
  approverName,
  park,
  parked,
  unpark,
  FIELDS,
  _internals: { GSTIN_RE, PAN_RE, PIN_RE, commercialDefaults },
};
