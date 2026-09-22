'use strict';
// Ordering by LINE NUMBER off a list we sent.
//
// Kalra Motor did this seven times in eighteen days, and it is the single
// habit the bot could not read at all:
//
//   Ronak sends a numbered availability list  ->  they swipe-reply to it
//   "Leave 9no. Item"        remove line 9
//   "4th. No. Item 3pc"      line 4, quantity 3
//   "8no. Item 2pc"          line 8, quantity 2
//   "LEAVE 6no. Item 9 no. 1pc"   remove 6, and line 9 becomes 1
//   "2-9-14-16-21-24-25-43-44-46-74 ye no saman hata do"   remove eleven lines
//
// The thing that makes this solvable rather than a guess: WhatsApp says WHICH
// message they replied to (`context.id`), and we already read that — it is how
// the helper's swipe-reply finds its question. So when the bot sends the list,
// it knows precisely which list "item 9" means.
//
// The list lives as long as the ORDER does, and on disk, not in memory. A
// customer who replies to this morning's list after lunch — or after a deploy
// restarted the process — must still be understood. Availability is never
// taken from here: the numbers only name a line, and every quantity change
// re-checks the portal (orders.setQty -> availability.resolveOne).
const store = require('../store');
const config = require('../config');

// The same clock the cart runs on. Once the draft is expired the list refers
// to an order that no longer exists, so keeping it longer buys nothing.
const maxAgeMs = () => config.dealerPortal.quoteMaxAgeHours * 60 * 60 * 1000;

function bucket() {
  const s = store.load();
  if (!s.numberedLists) s.numberedLists = {};
  return s.numberedLists;
}

function sweep() {
  const b = bucket();
  const now = Date.now();
  let dropped = 0;
  for (const [chatId, l] of Object.entries(b)) {
    if (now - (l.at || 0) > maxAgeMs()) {
      delete b[chatId];
      dropped++;
    }
  }
  if (dropped) store.save();
}

// Called right after the bot sends a numbered list. `wamid` may be null on
// transports that do not return one — the fallback still works.
function remember(chatId, wamid, lines) {
  if (!chatId || !lines || !lines.length) return;
  sweep();
  bucket()[chatId] = {
    wamid: wamid || null,
    at: Date.now(),
    lines: lines.map((l) => ({ item: l.requested || l.item, partNo: l.partNo || null, qty: l.qty })),
  };
  store.save();
  store.log('lists', `${chatId}: numbered list of ${lines.length} remembered${wamid ? '' : ' (no wamid)'}`);
}

// The list this message is about: the one they quoted, or the last one we sent.
function forReply(chatId, contextId) {
  sweep();
  const l = bucket()[chatId];
  if (!l) return null;
  if (contextId && l.wamid && contextId !== l.wamid) return null; // quoted something else
  return l;
}

function clear(chatId) {
  const b = bucket();
  if (b[chatId]) {
    delete b[chatId];
    store.save();
  }
}

// ---------------------------------------------------------------- parsing
//
// "9no.", "2nd no.", "4th. No.", "6 no", "9 no." — the same idea spelled six
// ways in one chat. The ordinal suffix is optional and so is the dot.
const N = '(\\d{1,3})\\s*(?:st|nd|rd|th)?\\s*\\.?\\s*(?:no|number|nos)?\\s*\\.?';
const ITEM = '(?:item|items|saman|no|nos)?';

// "leave 9no. item"  ·  "9 no. item hata do"  ·  "remove 4th no item"
const DROP_LEADING = new RegExp(
  `\\b(?:leave|remove|delete|cancel|hata\\s*do|hatao|nikal\\s*do|chhod\\s*do)\\b[^\\d]{0,12}${N}\\s*${ITEM}`,
  'gi',
);
const DROP_TRAILING = new RegExp(
  `${N}\\s*${ITEM}[^\\d]{0,14}\\b(?:hata\\s*do|hatao|nikal\\s*do|leave|remove|delete)\\b`,
  'gi',
);
// "4th. No. Item 3pc"  ·  "8no. Item 2pc"  ·  "9 no. 1pc"
//
// The unit must NOT include "no". In "LEAVE 6no. Item 9 no. 1pc" the "9 no."
// is the LINE, not a quantity of nine — reading it as one turned a removal of
// line 6 into "line 6, quantity 9".
const SET_QTY = new RegExp(
  `${N}\\s*${ITEM}\\s*[^\\dA-Za-z]{0,4}(\\d{1,4})\\s*(?:pcs?|pise|pieces?|peices?|set)\\b`,
  'gi',
);
// "2-9-14-16-21-24-25-43-44-46-74 ye no saman hata do", and once typed as
// "2ni-14-16-..." — a couple of stray letters must not lose the whole line.
const BULK =
  /(\d{1,3}(?:\s*[a-z]{0,3}\s*[-,/]\s*\d{1,3}){2,})[^\d]{0,24}\b(?:hata\s*do|hatao|nikal\s*do|leave|remove|delete)\b/i;

// A message is only about a list if it TALKS about item numbers. "16510M65L10
// 5" must never come through here.
function looksLikeListEdit(text) {
  const t = String(text || '');
  if (!t || t.length > 160) return false;
  // Checked FIRST, because "2ni-14-16-25-44-46-47" has letters and digits and
  // trips the part-number guard below. Three or more numbers joined by dashes
  // AND a removal verb is not a part number in any catalogue.
  if (BULK.test(t)) return true;
  // A real part number in the message means it is a part order, not a line
  // reference, whatever else it says.
  if (/\b(?=[A-Za-z0-9-]*[A-Za-z])(?=[A-Za-z0-9-]*\d)[A-Za-z0-9][A-Za-z0-9-]{5,}\b/.test(t)) return false;
  // "9no" / "4th. No." names a LINE only with an ordinal or the word "item"
  // beside it. On its own it is part of a part's name: "cartrend wiper blade
  // 16 number 10 pcs" is a 16-inch blade (22 Sep, live), and was answered
  // "Which item?" as if it were an edit to a list that did not exist.
  return (
    BULK.test(t) ||
    /\b(?:leave|remove|delete|hata\s*do|hatao|nikal\s*do)\b/i.test(t) ||
    /\d\s*(?:st|nd|rd|th)\s*\.?\s*(?:no|number)\b/i.test(t) ||
    (/\d\s*\.?\s*(?:no|number)\b/i.test(t) && /\bitem\b/i.test(t))
  );
}

// text -> { drop: [n], setQty: { n: qty } } or null.
function parseEdit(text) {
  const t = String(text || '');
  if (!looksLikeListEdit(t)) return null;

  const drop = new Set();
  const setQty = {};

  const bulk = t.match(BULK);
  if (bulk) {
    for (const chunk of bulk[1].split(/[-,/]/)) {
      const n = Number(String(chunk).replace(/[^\d]/g, ''));
      if (n) drop.add(n);
    }
  }

  for (const re of [DROP_LEADING, DROP_TRAILING]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(t))) if (Number(m[1])) drop.add(Number(m[1]));
  }

  SET_QTY.lastIndex = 0;
  let m;
  while ((m = SET_QTY.exec(t))) {
    const line = Number(m[1]);
    const qty = Number(m[2]);
    // "9 no. 1pc" after a "LEAVE 6no. item" is a quantity, not a removal, so a
    // number that appears in both wins as a quantity only if it was not the
    // one being dropped in the same breath.
    if (line && qty > 0 && qty <= 9999) setQty[line] = qty;
  }
  for (const n of Object.keys(setQty)) drop.delete(Number(n));

  if (!drop.size && !Object.keys(setQty).length) return null;
  return { drop: [...drop].sort((a, b) => a - b), setQty };
}

module.exports = { remember, forReply, clear, parseEdit, looksLikeListEdit, maxAgeMs };
