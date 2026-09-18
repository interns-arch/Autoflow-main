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
function ask(chatId, items) {
  sweep();
  if (!chatId || !items || !items.length) return;
  pending.set(chatId, { items: items.map((i) => ({ ...i })), at: Date.now() });
  store.log('askqty', `${chatId}: waiting on qty for ${items.length} item(s)`);
}

function get(chatId) {
  sweep();
  return pending.get(chatId) || null;
}

function clear(chatId) {
  pending.delete(chatId);
}

const UNIT = '(?:pcs?|pc|pise|peices?|pieces?|nos?|no|set|sets|box|boxes|pkts?|packets?)';

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
const LEAD = /^[?\s]*(?:add|send|sent|bhejo|bhej\s*do|bhej|de\s*do|dedo|dena|chahiye|need(?:ed)?|want|order|qty|give|please|pls)?\s*/i;
const TAIL = /\s*(?:needed|chahiye|required|reqd|if\s+available|if\s+avl|if\s+possible|avl|available|only|more|extra|bhi)?\s*[.!]*$/i;

function readAnswer(text, count) {
  let t = String(text || '').trim();
  if (!t || t.length > 40 || !count) return null;
  const stripped = t.replace(LEAD, '').replace(TAIL, '').trim();
  // Only accept the stripped form when something was actually stripped AND
  // what is left still starts with a digit — so "add" alone, or "if available"
  // alone, is never read as a quantity.
  if (stripped && stripped !== t && /^\d/.test(stripped)) t = stripped;

  const each = t.match(new RegExp(`^(?:all\\s+)?(\\d{1,4}|one|two|three)\\s*${UNIT}?\\s*(?:each|per\\s*item|ea)\\.?$`, 'i'));
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
