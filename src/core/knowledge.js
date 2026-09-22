'use strict';
// Permanent knowledge — the founder's "knowledge shift" requirement:
//
//   "vo kahega bhaiya mujhe samjhao ... aur hamesha ke liye vo knowledge mein
//    store ho jana chahiye, taki agli baar usse koi same sawal poochhe to
//    vapas mujhse na poochhe."
//
// Two kinds of learning, both persisted in data/state.json:
//
//   aliases — a customer phrase -> the real part number. Written every time
//             a human resolves an escalation, and every time the portal
//             answers a phrase we had not seen before. Consulted BEFORE the
//             portal on the next message, so the same question is never
//             escalated twice.
//   notes   — free-form things a human taught us (fitment, replaceability)
//             that are not a simple phrase->part mapping.
const store = require('../store');

function key(phrase) {
  return String(phrase || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function bank() {
  const s = store.load();
  if (!s.knowledge) s.knowledge = { aliases: {}, notes: [] };
  if (!s.knowledge.aliases) s.knowledge.aliases = {};
  if (!s.knowledge.notes) s.knowledge.notes = [];
  // Part numbers a human has confirmed are CORRECT even though the portal's
  // catalogue does not carry them. Without this the same part goes back to a
  // person every time it is asked for, and they answer "yes that's right"
  // again and again — the exact repetition this whole module exists to stop.
  if (!s.knowledge.onOrder) s.knowledge.onOrder = {};
  return s.knowledge;
}

function normNo(v) {
  return String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]+/g, '');
}

// "This part number is right, we just don't stock it." The customer hears the
// founder's line — on order, about a week — instead of being asked again.
function markOnOrder(partNo, source) {
  const k = normNo(partNo);
  if (!k) return;
  const b = bank();
  b.onOrder[k] = { partNo: String(partNo).toUpperCase(), source: source || 'helper', at: new Date().toISOString(), hits: 0 };
  store.save();
  store.log('knowledge', `confirmed valid, not stocked: ${partNo}`);
}

function isOnOrder(partNo) {
  const rec = bank().onOrder[normNo(partNo)];
  if (!rec) return false;
  rec.hits = (rec.hits || 0) + 1;
  store.save();
  return true;
}

// phrase -> part number, or null. Exact key first, then a contained-phrase
// match so "5 clutch plate swift" still finds "clutch plate swift".
// A key that is itself a part number (one token, letters AND digits) is a
// typo someone corrected - "26510m65l10" taught as 16510M65L10. Useful
// only when typed exactly; never as a "name", and never by substring.
function isPartShaped(k) {
  return /^(?=[a-z0-9-]*[a-z])(?=[a-z0-9-]*[0-9])[a-z0-9-]{5,}$/.test(String(k || ''));
}

function lookupAlias(phrase) {
  const k = key(phrase);
  if (!k) return null;
  const aliases = bank().aliases;
  if (aliases[k]) return aliases[k].partNo;
  // Looser matching is for NAMES only, and on whole words: "clutch set dzire
  // petrol please" still finds "clutch set dzire petrol". A part-number typo
  // is never matched inside anything, and a phrase that is itself a part
  // number never borrows someone else's alias.
  if (isPartShaped(k)) return null;
  const padded = ' ' + k + ' ';
  for (const [alias, entry] of Object.entries(aliases)) {
    if (isPartShaped(alias) || alias.length < 4 || alias.indexOf(' ') < 0) continue;
    if (padded.includes(' ' + alias + ' ')) return entry.partNo;
  }
  return null;
}

// Teach a phrase -> part number. `source` records who taught it.
function learnAlias(phrase, partNo, source) {
  const k = key(phrase);
  if (!k || !partNo) return null;
  const aliases = bank().aliases;
  const existing = aliases[k];
  aliases[k] = {
    partNo: String(partNo),
    source: source || 'human',
    learnedAt: existing ? existing.learnedAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    hits: existing ? existing.hits || 0 : 0,
  };
  store.save();
  store.log('knowledge', `learned: "${k}" -> ${partNo} (${source || 'human'})`);
  return aliases[k];
}

function noteAliasHit(phrase) {
  const k = key(phrase);
  const entry = bank().aliases[k];
  if (entry) {
    entry.hits = (entry.hits || 0) + 1;
    entry.lastUsedAt = new Date().toISOString();
    store.save();
  }
}

// Every learned phrase — offered to the message parser as its catalog.
// Every learned NAME - offered to the message parser as its catalog. Typo
// aliases are left out: given "26510m65l10" as a known item, Claude turned a
// customer's correct 16510M65L10 into it.
function aliasNames() {
  return Object.keys(bank().aliases).filter((a) => !isPartShaped(a));
}

function addNote(question, answer, source) {
  const note = {
    id: 'KN-' + Date.now(),
    question: String(question || '').trim(),
    answer: String(answer || '').trim(),
    source: source || 'human',
    createdAt: new Date().toISOString(),
  };
  bank().notes.push(note);
  store.save();
  store.log('knowledge', `note saved: "${note.question.slice(0, 60)}"`);
  return note;
}

// Best-effort recall of a previously answered question.
//
// Same words, in any order, give or take one: "cartrend wiper blade 16
// number" finds what the helper said about "Cartrend wiper blade 16 no.". A
// substring was not enough - "wiper" alone would have found every note that
// mentions a wiper, and answered a question nobody asked.
function findNote(question) {
  const k = key(question);
  if (k.length < 4) return null;
  const DROP = /^(ka|ki|ke|ko|hai|h|chahiye|chaiye|number|no|pcs|pc|piece|pieces|pise|nos|qty|the|a|of)$/;
  const words = (s) => new Set(key(s).split(' ').filter((w) => w && !DROP.test(w)));
  const mine = words(question);
  if (!mine.size) return null;
  let best = null;
  let bestScore = 0;
  for (const n of bank().notes) {
    const theirs = words(n.question);
    if (!theirs.size) continue;
    let common = 0;
    for (const w of mine) if (theirs.has(w)) common++;
    const union = mine.size + theirs.size - common;
    const score = common / union;
    // Every word of the shorter one present, and at most one extra word.
    const ok = common === Math.min(mine.size, theirs.size) && union - common <= 1;
    if (ok && score > bestScore) {
      best = n;
      bestScore = score;
    }
  }
  // Latest wins among equals: bank().notes is in the order they were taught.
  return best;
}

function all() {
  const b = bank();
  return { aliases: b.aliases, notes: b.notes };
}

module.exports = { lookupAlias, learnAlias, noteAliasHit, aliasNames, addNote, findNote, markOnOrder, isOnOrder, all };
