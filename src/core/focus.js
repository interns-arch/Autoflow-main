'use strict';
// What we were just talking about, per chat.
//
// On 11 Sep M/S Maan Motors sent a coolant, asked its selling price, got an
// answer, and then wrote "Es ki MRP kya h". The bot replied "Kis part ka?" —
// it had forgotten the coolant between one message and the next. A person at
// the counter never does that: "es ki", "iska", "ye", "this" all mean the
// thing we were discussing a minute ago.
//
// So every time the bot answers about specific parts — or sends one to a
// person to answer — it remembers them here. When the next message points
// back instead of naming a part, the callers use this before asking.
//
// It is deliberately short-lived and small: half an hour, five parts. Longer
// than that and "iska" is as likely to mean something else as the old part,
// and guessing wrong about a PART is worse than asking.
const MAX_AGE_MS = 30 * 60 * 1000;
const MAX_ITEMS = 5;
const chatState = require('./chatState');
const last = chatState.slot('focus'); // chatId -> { at, items: [{ item, partNo }] }

function sweep() {
  const now = Date.now();
  for (const [chatId, f] of last) if (now - f.at > MAX_AGE_MS) last.delete(chatId);
}

// lines: anything with an item/requested/partNo — resolved lines, order
// lines, or plain { item } objects.
function remember(chatId, lines) {
  if (!chatId || !lines || !lines.length) return;
  sweep();
  const seen = new Set();
  const items = [];
  for (const l of lines) {
    const partNo = (l && l.partNo) || null;
    const item = String((l && (l.requested || l.item)) || partNo || '').trim();
    if (!item) continue;
    const key = (partNo || item).toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ item, partNo });
    if (items.length >= MAX_ITEMS) break;
  }
  if (items.length) last.set(chatId, { at: Date.now(), items });
}

// The parts we were just discussing, or null.
function get(chatId) {
  sweep();
  const f = last.get(chatId);
  return f && f.items.length ? f.items : null;
}

// What to call them in a reply or a question: the part number when we have
// one, otherwise the customer's own words.
function names(chatId) {
  const items = get(chatId); // get() hands back the list itself, not the record
  return items ? items.map((x) => x.partNo || x.item) : [];
}

function clear(chatId) {
  last.delete(chatId);
}

// Words that POINT at something instead of naming it. "Es ki MRP", "iska
// rate", "isaka price", "ye kitne ka hai", "this one", "same wala".
//
// Not the bare English "is", "it" or "that": "Is the shop open today?" would
// then be read as a question about the last part. The Hindi "is ka rate"
// does not need them — rate questions use the remembered part whether or not
// the message points.
// "dono" and its family are the plural of this: not "that part" but "those
// two we were just talking about". 21 Sep, live: "In dono ka total price
// kitna hoga" was read as a part called "in dono total hoga" and sent to a
// person, while the two parts it meant were sitting in the customer's cart.
// "jo bheja tha", "previously sent", "parts from photo" are the same thing
// in the words the model normalises them into.
const POINTER =
  /\b(?:iss|es|ess|isk[aie]|iske|isak[aie]|esk[aie]|esak[aie]|isko|esko|isme|isi|ye|yeh|yahi|yehi|wahi|wohi|same|this|ink[aie]|inko|inme|inhe|unk[aie]|unko|unhe|these|them|those|dono|donon|teeno|tino|sab|sabhi|saare|sare|both|above|previous(?:ly)?|earlier|bheja|bheji|bheje|pichl[aei]|puran[aei])\b/i;
// "Inka mrp batana" (13 Sep, live) - "inka" was searched in the catalogue as a
// part name and came back as a list of insulation tapes.

function pointsBack(text) {
  return POINTER.test(String(text || ''));
}

// A "part name" that is really just a pointer or filler — "iska", "Eski
// saleing", "ye wala". Looking these up as parts is how "iska" reached the
// portal as a part name.
//
// "item"/"part" (and their plurals) belong here too: "this item" is a pointer
// PLUS a generic noun, naming nothing on its own. Without them, "What is the
// price of this item" (13 Sep, live) left "this item" as the named part — it
// beat the actual part just discussed (still remembered here, in `last`) to
// the answer, and the customer got "Rate for item — our team will send it to
// you shortly" instead of the price of the part their photo was about.
const FILLER =
  /^(?:is|iss|es|ess|isk[aie]|iske|isak[aie]|esk[aie]|esak[aie]|isko|esko|isme|isi|ye|yeh|yahi|yehi|wahi|wohi|same|this|it|that|wala|wali|wale|one|saleing|selling|saling|sale|sell|mrp|price|rate|stock|h|he|hai|hain|kya|kitna|kitne|kitni|ka|ki|ke|batao|bata|do|please|pls|plz|sir|ji|bhai|ink[aie]|inko|inhe|unk[aie]|unko|unhe|these|them|those|batana|btao|bta|bataiye|bhejna|of|item|items|part|parts|dono|donon|teeno|tino|sab|sabhi|saare|sare|both|un|unn|in|inn|total|amount|hoga|hogi|honge|quantity|qty|chahiye|abhi|jo|tha|thi|the|maine|mera|meri|uska|uski|previous|previously|earlier|above|sent|from|photo|photos|pic|bheja|bheji|bheje|pichl[aei]|puran[aei])$/i;

function isOnlyPointer(phrase) {
  const words = String(phrase || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  return words.length > 0 && words.every((w) => FILLER.test(w));
}

// The phrase with the pointer and filler words taken out, so what is left
// is what they actually named: "oil filter h" -> "oil filter", "Es h" -> "".
function stripPointers(phrase) {
  return String(phrase || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !FILLER.test(w))
    .join(' ')
    .trim();
}

module.exports = { remember, get, names, clear, pointsBack, isOnlyPointer, stripPointers, MAX_AGE_MS, MAX_ITEMS };
