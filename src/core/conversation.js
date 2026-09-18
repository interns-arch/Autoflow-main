'use strict';
// What we were just talking about.
//
// Until now every message was handled in isolation. That is what makes a bot
// feel like a bot: the customer writes "pakka?" or "Wait" or "This also" and
// the reply either ignores it or asks them to repeat themselves. In the Kalra
// Motor replay 62 messages got no answer at all, and a good number of them
// were only understandable in the light of the message before.
//
// Kept deliberately small:
//
//   * the last MAX turns of the chat, both sides
//   * one line of state the customer can hear — what is in their cart
//   * how they write: language, and formal or casual
//
// Persisted with everything else, so a restart does not wipe the thread of a
// conversation that is still going on.
const store = require('../store');
const lang = require('./lang');

const MAX = 16; // ~8 exchanges; enough for "pakka?" and never a whole day
const MAX_AGE_MS = 12 * 60 * 60 * 1000;

function bank() {
  const s = store.load();
  if (!s.conversations) s.conversations = {};
  return s.conversations;
}

function thread(chatId) {
  const b = bank();
  if (!b[chatId]) b[chatId] = { turns: [], at: Date.now() };
  const t = b[chatId];
  // A conversation nobody has touched since yesterday is not context, it is
  // history — carrying it forward makes the bot answer this morning's message
  // with last night's subject.
  if (Date.now() - (t.at || 0) > MAX_AGE_MS) t.turns = [];
  return t;
}

function record(chatId, role, text) {
  if (!chatId || !text) return;
  const t = thread(chatId);
  const line = String(text).replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!line) return;
  t.turns.push({ role, text: line, at: Date.now() });
  if (t.turns.length > MAX) t.turns.splice(0, t.turns.length - MAX);
  t.at = Date.now();
  store.save();
}

// The recent exchange, oldest first, as plain text a model can read.
function recent(chatId, n) {
  const t = thread(chatId);
  return t.turns.slice(-(n || MAX)).map((x) => `${x.role === 'customer' ? 'Customer' : 'Us'}: ${x.text}`).join('\n');
}

function turns(chatId) {
  return thread(chatId).turns.slice();
}

// How this customer writes. `language` is the sticky one from lang.js;
// formality is read fresh each time because the same person is brisk in the
// morning and polite when they need a favour.
const FORMAL = /\b(sir|please|kindly|madam|respected|regards|dear)\b/i;
const CASUAL = /\b(bhai|yaar|arre|bro|dude|ji haan|abey)\b|😂|😅|🙏/i;

function styleOf(chatId, text) {
  const t = String(text || '');
  let formality = 'neutral';
  if (CASUAL.test(t)) formality = 'casual';
  else if (FORMAL.test(t)) formality = 'formal';
  return { language: lang.of(chatId), formality };
}

function clear(chatId) {
  delete bank()[chatId];
  store.save();
}

module.exports = { record, recent, turns, styleOf, clear, MAX };
