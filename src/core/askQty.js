'use strict';
// "Customer bina qty ke sirf part number bhejta hai to quantity poochh lo."
//
// A part number with no quantity is not an order for one. The bot used to
// invent a quantity of 1, put it in the cart and print "*YES* = confirm" under
// a message where the customer had only asked whether we have the part. So the
// items wait HERE — answered on availability, but out of the cart — until the
// customer says how many.
//
// Deliberately in memory, like clarify.js: a question nobody answered for half
// an hour is not worth keeping, and a restart should not resurrect one.
const store = require('../store');

const chatState = require('./chatState');
const pending = chatState.slot('askQty.pending'); // chatId -> { items, at }   we ASKED, they answer
const recent = chatState.slot('askQty.recent'); // chatId -> { items, at }   we ANSWERED, they may amend
const MAX_AGE_MS = 30 * 60 * 1000;

function sweep() {
  const now = Date.now();
  for (const [chatId, p] of pending) if (now - p.at > MAX_AGE_MS) pending.delete(chatId);
  for (const [chatId, p] of recent) if (now - p.at > MAX_AGE_MS) recent.delete(chatId);
}

// The parts we just answered about. A quantity arriving in the NEXT message
// belongs to these — "Add 2pc", "6pc needed", "Bhejo 5pc" — and twelve of
// those went unanswered in seventeen days of the Kalra Motor chat because the
// bot only listened for a quantity when it had asked for one itself.
function remember(chatId, items) {
  sweep();
  if (!chatId || !items || !items.length) return;
  recent.set(chatId, { items: items.map((i) => ({ ...i })), at: Date.now() });
}

function lastAnswered(chatId) {
  sweep();
  return recent.get(chatId) || null;
}

function forget(chatId) {
  recent.delete(chatId);
}

// items: the customer's own requested lines, minus the quantity.
//
// A new ask() USED to overwrite the whole pending record. Two photos sent as
// separate messages seconds apart (13 Sep, live) each asked "how many do you
// need?" and the second call silently dropped the first photo's part from
// what we were waiting on — it never got answered, and its "how many?" just
// sat there unresolved while the customer answered the newer one. So an item
// still unanswered from a moment ago is kept, not replaced.
function ask(chatId, items) {
  sweep();
  if (!chatId || !items || !items.length) return;
  const merged = items.map((i) => ({ ...i }));
  const prior = pending.get(chatId);
  if (prior && prior.items && prior.items.length) {
    const seen = new Set(merged.map((i) => String(i.key || i.ref || i.item || '').toUpperCase()).filter(Boolean));
    for (const old of prior.items) {
      const k = String(old.key || old.ref || old.item || '').toUpperCase();
      if (k && !seen.has(k)) {
        seen.add(k);
        merged.push(old);
      }
    }
  }
  pending.set(chatId, { items: merged, at: Date.now() });
  store.log('askqty', `${chatId}: waiting on qty for ${merged.length} item(s)`);
}

function get(chatId) {
  sweep();
  return pending.get(chatId) || null;
}

function clear(chatId) {
  pending.delete(chatId);
}

// "2 quantity", "1 qty" (30 Sep, live, Ujjwal: read as a part named "quantity").
const UNIT = '(?:pcs?|pc|pise|peices?|pieces?|nos?|no|set|sets|box|boxes|pkts?|packets?|qty|qtys|quantity|quantities)';

// Read a quantity answer against `count` waiting items. Returns an array of
// quantities (one per item) or null when the message is not an answer at all.
//
// The three shapes that actually arrive, straight from the chats:
//   "2"  "2pc"  "3pise"       -> that many of each
//   "All one pcs each"  "1 each"  -> that many of each
//   "2,3,1"  "2 3 1"          -> one per item, in order
// The words wrapped around the number in a real chat. Stripped before the
// shapes below are tried, so "Add 2pc", "??need 15pc", "6pc needed" and
// "Add 2pc if available" all reduce to the same thing.
// "I need ...", "We want ...", "Mujhe ... chahiye" — a subject in front of the
// verb that LEAD used to require to be the very first word, so "I need one
// piece of each item" (13 Sep, live) matched nothing and fell through to the
// free-text parser instead of closing the pending ask.
const LEAD = /^[?\s]*(?:then|toh|to|ok|okay)?\s*(?:i|we|hum|hume|humein|mujhe)?\s*(?:add|send|sent|bhejo|bhej\s*do|bhej|de\s*do|dedo|dena|chahiye|need(?:ed)?|want|order|qty|quantity|give|please|pls)?\s*(?:[:=-]\s*)?/i;
const TAIL = /\s*(?:needed|chahiye|required|reqd|if\s+available|if\s+avl|if\s+possible|avl|available|only|more|extra|bhi)?\s*[.!]*$/i;

function readAnswer(text, count) {
  let t = String(text || '').trim();
  if (!t || t.length > 40 || !count) return null;
  const stripped = t.replace(LEAD, '').replace(TAIL, '').trim();
  // Only accept the stripped form when something was actually stripped AND
  // what is left still starts with a number — digit OR a spelled-out one, so
  // "add" alone, or "if available" alone, is never read as a quantity.
  if (stripped && stripped !== t && /^(?:\d|one|two|three)\b/i.test(stripped)) t = stripped;

  // "one piece of each item", "2pc of each part", "1 each" - the ", of each"
  // was previously required to be the FINAL word "each" with nothing after
  // it, so "of each item"/"of each part" (how people actually type it) never
  // matched and the bot re-asked instead of applying the answer.
  const each = t.match(new RegExp(`^(?:all\\s+)?(\\d{1,4}|one|two|three)\\s*${UNIT}?\\s*(?:of\\s+)?(?:each|all)(?:\\s+(?:item|items|part|parts|one))?\\.?$`, 'i'));
  if (each) {
    const n = { one: 1, two: 2, three: 3 }[each[1].toLowerCase()] || parseInt(each[1], 10);
    if (n > 0 && n <= 9999) return new Array(count).fill(n);
  }
  // "each 2"
  const each2 = t.match(new RegExp(`^each\\s+(\\d{1,4})\\s*${UNIT}?\\.?$`, 'i'));
  if (each2) {
    const n = parseInt(each2[1], 10);
    if (n > 0 && n <= 9999) return new Array(count).fill(n);
  }

  // One number for everything.
  const one = t.match(new RegExp(`^(?:send|bhejo|bhej\\s*do|chahiye|need|want|qty)?\\s*(\\d{1,4})\\s*${UNIT}?\\.?$`, 'i'));
  if (one) {
    const n = parseInt(one[1], 10);
    if (n > 0 && n <= 9999) return new Array(count).fill(n);
  }

  // One number per item, in the order they were listed.
  if (count > 1) {
    const nums = t.split(/[,\s/]+/).filter(Boolean);
    if (nums.length === count && nums.every((n) => /^\d{1,4}$/.test(n))) {
      const qs = nums.map((n) => parseInt(n, 10));
      if (qs.every((q) => q > 0 && q <= 9999)) return qs;
    }
  }
  return null;
}

module.exports = { ask, get, clear, readAnswer, remember, lastAnswered, forget };
