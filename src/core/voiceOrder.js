'use strict';
// An order the bot HEARD rather than read, waiting to be confirmed.
//
// A transcript is not a message. "16510M65L10" and "16510M65L70" sound nearly
// identical down a phone in a workshop, and one of them is an order for the
// wrong part that somebody pays to ship back. So a heard part number never
// goes straight into the cart:
//
//   customer sends a voice note
//     -> Gemini transcribes it
//     -> the part number is looked up in the portal catalogue
//     -> the bot reads it BACK to the customer and waits for a yes
//     -> only then does it become an order line
//
// Two things make that safe rather than merely polite:
//
//   1. The part must EXIST in the catalogue. A mis-heard digit almost always
//      produces a number that is in no catalogue at all, so the common failure
//      lands on a person by itself, before the customer is ever asked.
//   2. The customer sees the exact number in writing before anything happens.
//      They read their own part numbers all day; they will catch a wrong one
//      faster than we can.
//
// Nothing here touches price, stock or ETA — the lines go through the ordinary
// order path once confirmed, so availability is checked fresh at that point.
const store = require('../store');

// Long enough for someone to look up from the counter, short enough that a
// "haan" an hour later is not read as agreement to something forgotten.
const MAX_AGE_MS = 15 * 60 * 1000;
const chatState = require('./chatState');
const pending = chatState.slot('voiceOrder'); // chatId -> { at, lines, transcript }

function sweep() {
  const now = Date.now();
  for (const [chatId, p] of pending) if (now - p.at > MAX_AGE_MS) pending.delete(chatId);
}

// kind: 'voice' (a transcript) or 'text' (a typed message the Understand model
// read, customerBot.understood). A "nahi" means something different for each:
// a recording a person can listen to, or nothing to hand over at all.
function remember(chatId, lines, transcript, kind = 'voice') {
  if (!chatId || !lines || !lines.length) return;
  sweep();
  pending.set(chatId, { at: Date.now(), lines, transcript: String(transcript || '').slice(0, 300), kind });
  store.log('voice', `${chatId}: heard ${lines.length} line(s), waiting for a yes`);
}

function get(chatId) {
  sweep();
  return pending.get(chatId) || null;
}

function take(chatId) {
  sweep();
  const p = pending.get(chatId);
  pending.delete(chatId);
  return p || null;
}

function clear(chatId) {
  pending.delete(chatId);
}

// "haan", "yes", "sahi hai", "ok", "correct", "theek hai", "hn", "ha ji".
//
// Deliberately narrower than the order-confirm list: this is agreement that we
// HEARD right, and a question mark means they are asking, not agreeing —
// "sahi hai?" is the customer checking with us.
const YES =
  /^(?:y|ya|yes|yeah|yep|ok|okay|okey|k|hn|hnn|ha|haan|han|haa|ji|ji haan|haan ji|sahi|sahi hai|shi|shi hai|correct|right|theek|thik|theek hai|thik hai|bilkul|pakka|done|confirm|confirmed)\b[\s.!]*$/i;
// "nahi", "galat", "no", "wrong", "aisa nahi".
const NO = /^(?:n|no|nope|nahi|nhi|na|galat|glt|wrong|not correct|nahi hai|nhi hai)\b[\s.!]*$/i;

function readAnswer(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 40) return null;
  if (/\?\s*$/.test(t)) return null; // a question, not an answer
  if (YES.test(t)) return 'yes';
  if (NO.test(t)) return 'no';
  return null;
}

module.exports = { remember, get, take, clear, readAnswer, MAX_AGE_MS };
