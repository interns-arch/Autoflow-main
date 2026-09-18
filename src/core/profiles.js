'use strict';
// Per-customer STYLE. Not per-customer terms.
//
// The line that matters, and the reason this file is shaped the way it is:
//
//   A profile may change tone, length, and what the bot leads with.
//   It may NEVER change price, stock, ETA, or the confirm flow.
//   Those come from the portal and are the same for everyone.
//
// That is not left to good intentions here. Two mechanical guards enforce it:
//
//   1. ALLOWED + auditValue — a profile may only carry known style keys, and
//      may not carry a NUMBER at all (except busyHours). A figure is the only
//      way a per-customer eta or discount could ever be substituted into a
//      message, and there is nowhere to put one. Checked at require() time,
//      so a bad profile stops the process at boot rather than at 4pm.
//
//   2. polish() — after a profile rewrites an outgoing message, every digit
//      and every part number in it must be byte-identical to the original.
//      If anything moved, the original is sent. So "ETA = 7 days" cannot
//      become "ETA = 5 days" for a favoured customer even if the styling code
//      were wrong.
//
// Everything in the Kalra profile below is COUNTED from their 18-day export.
// Nothing is guessed. Whether they are patient, price-sensitive, or what kind
// of person they are — 275 near-wordless messages do not say, so none of that
// is in here.
const store = require('../store');

// The only keys a profile may have. Anything else is a bug, loudly.
const ALLOWED = new Set([
  'name', // who this is, for logs
  'role', // what this number does in their shop, for logs
  'terse', // answer in one line; every extra line is friction
  'honorifics', // false -> no "sir", no "ji"
  'emoji', // false -> none at all
  'pieceWord', // the word THEY use for a piece — 'pise', not the number of them
  'greet', // false -> never open with a greeting
  'neverLeadRate', // do not open with price talk
  'expectsPhotos', // the camera is how they order
  'busyHours', // when speed actually matters
  'note', // one line for the model brief
]);

// Two earlier versions of this guard tried to read meaning out of English and
// were wrong three times: they rejected `pieceWord` ("pise" is a word, not a
// quantity), `neverLeadRate` (a rule about what to open with, not a rate), and
// the sentence "they asked about rate once in 18 days", which is a description
// of their behaviour and not a price. Prose does not survive a regex.
//
// So the guard checks the one thing that is unambiguous and is the actual
// danger: a profile must not carry a NUMBER. A figure is how a per-customer
// eta or discount would ever get substituted into a message; a sentence about
// them cannot be. What the model then writes is fenced separately, in
// smallTalk (MONEY, STOCK_CLAIM), and what the bot writes is frozen by
// polish() below.
function auditValue(phone, key, v) {
  // busyHours is the one place a number belongs: hours of the day.
  if (key === 'busyHours') {
    if (!Array.isArray(v) || v.some((h) => !Number.isInteger(h) || h < 0 || h > 23)) {
      throw new Error(`profiles: ${phone} busyHours must be whole hours 0-23`);
    }
    return;
  }
  if (typeof v === 'number') {
    throw new Error(`profiles: ${phone} key "${key}" carries a number. Profiles set style, never figures.`);
  }
  if (v !== null && typeof v !== 'string' && typeof v !== 'boolean') {
    throw new Error(`profiles: ${phone} key "${key}" must be a string, a boolean or null`);
  }
}

const PROFILES = {
  // Kalra Motor — the talker. Every voice note in the thread is from here;
  // 182 messages, and this is the number that amends and confirms.
  919910561996: {
    name: 'Kalra Motor',
    role: 'counter — talks, amends, confirms; all 11 voice notes are his',
    terse: true,
    honorifics: false,
    emoji: false,
    pieceWord: 'pise',
    greet: false,
    neverLeadRate: true,
    expectsPhotos: true,
    busyHours: [11, 16],
    note:
      'Kalra Motor. 275 messages in 18 days, median 10 characters, 77 sentences in total. ' +
      'Wrote "sir" zero times and used zero emoji. Answer in ONE line, no honorific, no emoji, ' +
      'no greeting. They say "pise", not "pcs". They asked about rate once in 18 days — never ' +
      'open with price. A third of what they send is a photograph with the quantity as the caption.',
  },
  // Kalra Motor — the shelf. 93 messages, 52 of them photographs, 12 text.
  // Almost never writes a sentence: photographs the box, captions the number.
  919540354506: {
    name: 'Kalra Motor',
    role: 'stores — photographs the box and captions the quantity',
    terse: true,
    honorifics: false,
    emoji: false,
    pieceWord: 'pise',
    greet: false,
    neverLeadRate: true,
    expectsPhotos: true,
    busyHours: [11, 16],
    note:
      'Kalra Motor (stores). Sends photographs, barely any text — 52 photos against 12 typed ' +
      'messages. The caption is the quantity and they write "pise", not "pcs". Answer in one ' +
      'line, no honorific, no emoji, no greeting.',
  },
};

// Refuse a bad profile at startup, not at 4pm on a Tuesday.
for (const [phone, p] of Object.entries(PROFILES)) {
  for (const k of Object.keys(p)) {
    if (!ALLOWED.has(k)) throw new Error(`profiles: ${phone} has key "${k}", which is not a style key`);
    auditValue(phone, k, p[k]);
  }
}

// The neutral customer: polite, normal length, greets back. What everyone gets
// until their own messages say otherwise.
const DEFAULT = Object.freeze({
  name: null,
  role: null,
  terse: false,
  honorifics: true,
  emoji: true,
  pieceWord: 'pcs',
  greet: true,
  neverLeadRate: false,
  expectsPhotos: false,
  busyHours: [],
  note: null,
});

function forPhone(phone) {
  const p = store.normPhone(phone || '');
  return PROFILES[p] ? Object.assign({}, DEFAULT, PROFILES[p]) : DEFAULT;
}

function has(phone) {
  return !!PROFILES[store.normPhone(phone || '')];
}

// The paragraph appended to the model's brief. Style only — the brief already
// forbids the model from stating a price or a stock figure.
function briefFor(phone) {
  const p = forPhone(phone);
  if (!p.note) return '';
  return `\n\nWHO YOU ARE WRITING TO:\n${p.note}\nThis changes only how you write. What you tell them about availability, timing and price is decided elsewhere and is the same for every customer.`;
}

// ------------------------------------------------------------------ polish
//
// Restyle an outgoing message for this customer. The facts in it are frozen:
// see the digit/part guard below.
const EMOJI =
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu;
// "sir", "ji" as a standalone word — never inside a real word, and never a
// part number.
const HONORIFIC = /(?:\s*,)?\s*\b(?:sir|ji|sirji)\b(?=[\s.,!?]|$)/gi;
// An honorific that OPENS a line takes its comma with it, and there can be
// two of them: stripping one word left "Sir, 55810M75J30" as ", 55810M75J30",
// and "Ji sir, ready hai" as ", ready hai".
const LEADING_HONORIFIC = /^[ \t]*(?:(?:sir|ji|sirji)\b[ \t]*,?[ \t]*)+/gim;

// Every number and every part number in the message, in order. If styling
// changes this list, the styling is wrong and gets thrown away.
//
// A part number must have BOTH a letter and a digit and be six characters or
// more. The first version left out the letter-and-digit test, so it counted
// "Confirm" as a part number and any wording change tripped the guard.
const FACT = /\d+|\b(?=[A-Za-z0-9-]*[A-Za-z])(?=[A-Za-z0-9-]*\d)[A-Za-z0-9][A-Za-z0-9-]{5,}\b/g;
function facts(s) {
  return (String(s).match(FACT) || []).join('|');
}

function polish(phone, text) {
  const original = String(text || '');
  if (!original) return original;
  const p = forPhone(phone);
  if (p === DEFAULT) return original;

  let out = original;
  if (p.emoji === false) out = out.replace(EMOJI, '');
  if (p.honorifics === false) {
    out = out.replace(LEADING_HONORIFIC, '').replace(HONORIFIC, '');
    // "Sir, please send it" would otherwise become "please send it".
    out = out.replace(/(^|\n)([a-z])/g, (_, br, c) => br + c.toUpperCase());
  }
  if (p.pieceWord && p.pieceWord !== 'pcs') {
    // Speak their word back to them. Only the unit word, never the number —
    // and the spacing is kept, because swallowing it turned "x2 pcs" into the
    // single token "x2pise", which the fact guard rightly read as a changed
    // part number.
    out = out.replace(/(\d\s*)pcs?\b/gi, `$1${p.pieceWord}`);
  }
  out = out
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([.,!?])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .trim();

  // THE GUARD. A restyle that moved a number or a part number is not a
  // restyle. Send what we meant to send.
  if (facts(out) !== facts(original)) {
    store.log('profiles', `polish changed a fact for ${phone} — original sent instead`);
    return original;
  }
  return out || original;
}

module.exports = { forPhone, has, briefFor, polish, facts, auditValue, ALLOWED, DEFAULT, PROFILES };
