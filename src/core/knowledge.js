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
  // A RANGE a person taught in one message: "Cartrends wiper blade - 12
  // inch is CTWBSI26P-12INCH, 14 inch is ..., 26 inch is ...". One entry, so
  // "cartrend wiper blade 18 number" finds the 18 without anyone being asked.
  if (!s.knowledge.families) s.knowledge.families = [];
  return s.knowledge;
}

// ---- families ----
// Words that name nothing: "Wiper Blade FOR Cartrends", "it HAS SIZES".
const FAMILY_FILLER = /^(for|of|the|a|an|and|ka|ki|ke|hai|h|size|sizes|inch|inches|number|no|part|parts|pcs|pc|chahiye|wala|wali|brand|company|ke liye)$/;
// "cartrends" and "cartrend" are the same brand; "blades" and "blade" the same part.
const stem = (w) => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w);
function familyWords(text) {
  return key(text)
    .split(' ')
    .filter((w) => w && !/^\d+$/.test(w) && !FAMILY_FILLER.test(w))
    .map(stem);
}

// One letter out is the normal case, not the exception: every wiper-blade
// question in the queue was raised as "Cartend", and the instruction that
// answered them all said "Cartrends". Matched strictly, a person's answer
// never reaches the question they were answering.
//
// Held down hard, because a family that matches too much answers the wrong
// part with confidence: a word carrying a digit is never matched loosely
// ("10w30" and "10w40" are one edit apart and are different oils), short
// words are never matched loosely, the first letter must agree, and only
// ONE word of a family may be a near miss.
function within1(a, b) {
  if (a === b) return true;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (l.length - s.length > 1) return false;
  let i = 0;
  let j = 0;
  let diff = 0;
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) {
      i++;
      j++;
      continue;
    }
    if (++diff > 1) return false;
    if (s.length === l.length) i++;
    j++;
  }
  return true;
}

function near(a, b) {
  if (a === b) return true;
  if (a.length < 5 || b.length < 5) return false;
  if (/[0-9]/.test(a) || /[0-9]/.test(b)) return false;
  if (a[0] !== b[0]) return false;
  return within1(a, b);
}

// Is every word of `words` present in `mine`, allowing one near miss?
function coversWords(words, mine) {
  let loose = 0;
  for (const w of words) {
    if (mine.has(w)) continue;
    let hit = false;
    for (const m of mine) {
      if (near(w, m)) {
        hit = true;
        break;
      }
    }
    if (!hit) return false;
    if (++loose > 1) return false;
  }
  return true;
}

// subject: "Cartrends wiper blade"; variants: [{ key: '16', label, partNo }]
function learnFamily(subject, variants, source) {
  const words = [...new Set(familyWords(subject))];
  const vs = (variants || []).filter((v) => v && v.partNo && v.key);
  if (!words.length || !vs.length) return null;
  const fams = bank().families;
  const same = fams.find((f) => f.words.length === words.length && f.words.every((w) => words.includes(w)));
  const entry = {
    id: same ? same.id : 'FAM-' + Date.now(),
    subject: String(subject).trim(),
    words,
    variants: vs.map((v) => ({
      key: String(v.key),
      label: String(v.label || v.key),
      partNo: String(v.partNo),
      // WORDS that pick this variant out, when a number cannot.
      //
      // Wiper blades are chosen by size, so the key IS the number. An air
      // filter is chosen by which car it fits, and the portal knows: "Air
      // Filter| | Ciaz / Ertiga 2nd Gen / SCross / XL6". Only words unique to
      // ONE variant belong here — "ertiga" fits two of the three air filters,
      // so it decides nothing and is left out, and the customer is shown the
      // choice instead of being guessed at.
      match: [...new Set((v.match || []).map((w) => String(w).toLowerCase().trim()).filter(Boolean))],
    })),
    source: source || 'human',
    learnedAt: new Date().toISOString(),
  };
  if (same) Object.assign(same, entry);
  else fams.push(entry);
  store.save();

  // A PART NUMBER WITH A SPACE IN IT survives being learned and then dies on
  // the way to the portal: "CTWBSI26P-16 Inch" is cut at the space by the
  // part-number reader, only "CTWBSI26P-16" is sent, and nothing comes back —
  // one size of eleven answering "checking" while the rest quoted a price.
  // Learned as an alias of itself, the whole spelling survives the trip.
  for (const v of entry.variants) {
    if (!/\s/.test(v.partNo)) continue;
    learnAlias(v.partNo, v.partNo, source || 'portal');
    learnAlias(v.partNo.replace(/\s+/g, ''), v.partNo, source || 'portal');
  }

  store.log('knowledge', `family learned: "${entry.subject}" - ${entry.variants.length} variant(s)`);
  return entry;
}

// The family this text is about, and the variant when it names one:
// "cartrend wiper blade 16 number" -> { family, variant: {key:'16', ...} }.
// Every word of the family has to be there - "wiper blade 16" without the
// brand is some other brand's blade, and gets no answer from this one.
function familyFor(text) {
  const mine = new Set(familyWords(text));
  if (!mine.size) return null;
  const nums = new Set((key(text).match(/\b\d{1,3}\b/g) || []).map((n) => String(Number(n))));
  let best = null;
  for (const f of bank().families) {
    if (!coversWords(f.words, mine)) continue;
    if (best && best.words.length >= f.words.length) continue;
    best = f;
  }
  if (!best) return null;

  // By number first — "cartrend wiper blade 18 number" names its size.
  let variant = best.variants.find((v) => /^\d+$/.test(v.key) && nums.has(String(Number(v.key)))) || null;

  // Then by word: "air filter brezza", "bonnet kabza left". A variant is only
  // picked when exactly ONE of them claims a word in the question — two
  // claiming it means the question has not actually chosen, and the caller
  // shows the options rather than picking one.
  if (!variant) {
    const said = ' ' + key(text) + ' ';
    const hits = best.variants.filter((v) => (v.match || []).some((w) => said.includes(' ' + w + ' ')));
    if (hits.length === 1) variant = hits[0];
  }
  return { family: best, variant };
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

// "We don't carry that." The one answer Prateek sir gave that was never kept:
// he said no, the customer was told, and the next person to ask the same thing
// sent him the identical question again.
//
// NOT permanent, unlike an alias. "We don't stock it" is true of a catalogue
// today and can stop being true next month, so it is remembered for a window
// and then asked once more. A wrong "not available" costs a sale, which is
// worse than one extra question.
function markNotCarried(phrase, source) {
  const k = key(phrase);
  if (!k) return null;
  const b = bank();
  if (!b.notCarried) b.notCarried = {};
  b.notCarried[k] = { phrase: String(phrase).trim(), source: source || 'helper', at: new Date().toISOString(), hits: 0 };
  store.save();
  store.log('knowledge', `not carried: "${k}" (remembered for ${config().notCarriedDays} days)`);
  return b.notCarried[k];
}

function config() {
  return require('../config').knowledgeMemory || { notCarriedDays: 30 };
}

// -> the record when we were told this recently, else null. Matched the same
// way an alias is, so "CTWB18" and "CTWB 18" are one question here too.
function notCarried(phrase) {
  const b = bank();
  if (!b.notCarried) return null;
  const k = key(phrase);
  if (!k) return null;
  let rec = b.notCarried[k];
  if (!rec) {
    const squashed = normNo(k);
    if (squashed.length >= 4) {
      for (const [kk, v] of Object.entries(b.notCarried)) {
        if (normNo(kk) === squashed) {
          rec = v;
          break;
        }
      }
    }
  }
  if (!rec) return null;
  const days = config().notCarriedDays;
  const age = (Date.now() - new Date(rec.at).getTime()) / 86400000;
  if (!Number.isFinite(age) || age > days) return null; // stale: worth asking again
  rec.hits = (rec.hits || 0) + 1;
  store.save();
  return rec;
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

  // THE SAME SHORTCUT, TYPED THE OTHER WAY. "CTWB 18", "CTWB18" and "CTWB-18"
  // are one shortcut to the person typing them, and were three different keys
  // here — so a shortcut Prateek sir had already explained went back to him
  // the moment somebody left the space out.
  //
  // Still EXACT, not a substring: "ctwb18" finds "ctwb 18" and never
  // "ctwb180". Comparing part numbers with the separators stripped is already
  // how this codebase decides two part numbers are the same (see normNo here
  // and normPn in core/teachings).
  const squashed = normNo(k);
  if (squashed.length >= 4) {
    for (const [alias, entry] of Object.entries(aliases)) {
      if (normNo(alias) === squashed) return entry.partNo;
    }
  }

  // A range someone taught, and the size they asked for.
  if (!isPartShaped(k)) {
    const fam = familyFor(phrase);
    if (fam && fam.variant) return fam.variant.partNo;
  }
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
//
// TWICE, ON PURPOSE. The string key below is exact and free, and it answers the
// shortcut somebody types the same way every day ("CTWB 18"). It cannot answer
// a SENTENCE: nobody types the same sentence twice, so a phrase Prateek sir
// answered was walked straight past by the next customer's wording and he was
// asked the same thing again. So the phrase also goes to core/parts/aliases,
// which embeds it — and there the next question only has to MEAN the same
// thing.
//
// Fire-and-forget: the customer whose question taught us this has already been
// answered, and a database that is down must cost nothing but the recall.
function learnAlias(phrase, partNo, source, opts = {}) {
  const k = key(phrase);
  if (!k || !partNo) return null;
  if (!isPartShaped(k)) {
    try {
      require('./parts')
        .rememberPhrase({ phrase, partNo, partName: opts.partName || null, source, taughtBy: opts.taughtBy || null })
        .catch(() => {});
    } catch (_) {
      // no database configured, or the module could not load: the string key
      // below still works, exactly as before this existed.
    }
  }
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

module.exports = { lookupAlias, learnAlias, noteAliasHit, aliasNames, addNote, findNote, markOnOrder, isOnOrder, markNotCarried, notCarried, all, learnFamily, familyFor, familyWords, coversWords };
