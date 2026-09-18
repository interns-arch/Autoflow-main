'use strict';
// Reply in the language the customer is writing in.
//
// Founder's rule: "the customer who speaks in Hindi, send message in Hindi;
// and tomorrow speaks in English, English."
//
// Two things make this work in a parts chat:
//
//   1. Most messages carry NO language signal at all. "16510M65L10 10" is
//      neither Hindi nor English. So the language is STICKY: it is stored per
//      chat and only changes when a message actually says something. A bare
//      part number never flips a Hindi customer into English.
//   2. Hindi here means the Roman Hinglish this trade actually writes
//      ("rate bhej dijiye"), not Devanagari. A customer who types in
//      Devanagari reads Roman perfectly well; the reverse is not true, and
//      almost every real message in these chats is Roman.
const store = require('../store');

const DEVANAGARI = /[ऀ-ॿ]/;

// Words that only a Hindi/Hinglish writer uses. One hit is enough — nobody
// writing English drops "chahiye" into a sentence by accident.
const HINDI =
  /\b(chahiye|chaiye|chahie|nahi|nahin|nhi|kya|kyu|kyun|kyon|hai|hain|kitna|kitne|kitni|mujhe|muje|hume|humein|humko|aap|aapka|apka|aapko|aapke|bhej|bhejo|bheje|bhejna|bhejiye|bhejdo|bhejde|dijiye|dijiyega|dena|dedo|dedena|karo|karna|kariye|kijiye|krna|kro|krdo|krdena|milega|milegi|milta|milti|batao|bataiye|batana|bata|hoga|hogi|thik|theek|thek|accha|acha|abhi|jaldi|kripya|dhanyavad|dhanyawad|haan|hanji|bhai|wala|vala|wali|vali|chalega|lagega|karke|kaunsa|kaunsi|konsa|konsi|kaise|kaisa|sirf|zarurat|jarurat|zaroorat|bilkul|thoda|poora|pura|saath|rehne|dikkat|paisa|maal|lena|leni|dalo|daal|dal do|bna|bana|banao|bnao|banado|bnado|lga|laga|lagao|lgao|lgado|lagado|mt|rhne|hn|kr|kardo|krdo|gaya|gya|mera|meri|mere|ruko|bhi)\b/i;
// "Ok order bna do" was read as English on 13 Sep: "order" is an English
// marker and "bna" was missing from the list above. Short Hinglish spellings
// ("bna", "lga", "mt", "kr") are how this trade types on a phone.

// Used ONLY when a message carries no Hindi marker, so shared Hinglish words
// ("rate bhejo") never land here.
const ENGLISH =
  /\b(please|kindly|need|needed|want|require|required|send|sent|share|available|availability|price|rate|stock|order|confirm|confirmed|thanks|thank|dispatch|urgent|what|when|where|which|how|much|many|you|your|have|has|the|and|for|with|this|that|these|quote|delivery|deliver|payment|pending|check|checking)\b/i;

function bank() {
  const s = store.load();
  if (!s.chatLang) s.chatLang = {};
  return s.chatLang;
}

// What language is this ONE message in? null = it does not say.
function detect(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (DEVANAGARI.test(t)) return 'hi';
  if (HINDI.test(t)) return 'hi';
  if (ENGLISH.test(t)) return 'en';
  // Three or more real words with no marker either way — an English sentence
  // we simply have no keyword for. Part numbers and quantities are excluded,
  // so a 40-line order list never counts as a language signal.
  const words = t.split(/\s+/).filter((w) => /^[A-Za-z]{2,}$/.test(w));
  if (words.length >= 3) return 'en';
  return null;
}

// Remember what this customer writes in. Called on every inbound message.
function note(chatId, text) {
  const l = detect(text);
  if (!l || !chatId) return of(chatId);
  const b = bank();
  if (b[chatId] !== l) {
    b[chatId] = l;
    store.save();
    store.log('lang', `${chatId} -> ${l}`);
  }
  return l;
}

// English until a customer shows us otherwise.
function of(chatId) {
  return (chatId && bank()[chatId]) || 'en';
}

// t = translate. `t(chatId)` gives a chooser used inline at every message:
//   const t = lang.for(m.chatId);
//   t('Removed.', 'Hata diya.')
function forChat(chatId) {
  const hi = of(chatId) === 'hi';
  return (en, hindi) => (hi && hindi ? hindi : en);
}

function set(chatId, l) {
  if (!chatId || (l !== 'hi' && l !== 'en')) return;
  bank()[chatId] = l;
  store.save();
}

module.exports = { detect, note, of, for: forChat, set };
