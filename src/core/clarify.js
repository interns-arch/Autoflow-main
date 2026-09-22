'use strict';
// Narrowing a loose part name down to one part, the way the sales desk does it
// — one short question at a time.
//
// The catalogue has 592 brake pads. Listing them, or asking "please send the
// part number", is not how the Cartrends team writes: they ask "kaunsi gaadi?",
// the customer says "alto", they ask "front ya rear?", and then they answer.
// Each question is chosen from what our OWN catalogue actually distinguishes,
// so we never ask something that would not narrow anything down.
//
// No prices here or anywhere else the customer can see. The CRM team does not
// quote rates over WhatsApp and neither does the bot.
const store = require('../store');
const lang = require('./lang');

// chatId -> { base, qty, ref, key, asked:[], at }
const chatState = require('./chatState');
const pending = chatState.slot('clarify.pending');
const MAX_AGE_MS = 30 * 60 * 1000;

// Part names read "BRAKE PAD | MARUTI SUZUKI ALTO K10 | FRONT | 1.0L".
// Segment 0 is the part, the rest are the qualifiers worth asking about.
function facets(matches) {
  const cols = [];
  for (const m of matches) {
    String(m.name || '')
      .split('|')
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((v, i) => {
        if (i === 0) return; // the part name itself never narrows anything
        (cols[i] = cols[i] || new Map()).set(v.toUpperCase(), (cols[i].get(v.toUpperCase()) || 0) + 1);
      });
  }
  return cols;
}

const FRONT_REAR = /^(FRONT|REAR|UPPER|LOWER|LEFT|RIGHT|RH|LH)$/;
const FUEL = /^(PETROL|DIESEL|CNG|ELECTRIC)$/;

// The next question to ask, or null when the list is short enough to answer.
// `alreadyAsked` stops us circling back to a facet the customer just answered.
// Few enough to simply show? Then no question — a short list IS the answer,
// and one more round trip would just be a delay.
const SHOW_LIMIT = 6;

function nextQuestion(matches, alreadyAsked = [], chatId) {
  const t = lang.for(chatId);
  if (matches.length <= SHOW_LIMIT) return null;
  const cols = facets(matches);

  for (let i = 1; i < cols.length; i++) {
    if (!cols[i] || alreadyAsked.includes(i)) continue;
    const values = [...cols[i].entries()].sort((a, b) => b[1] - a[1]);
    if (values.length < 2) continue; // everything agrees — nothing to ask

    const names = values.map((v) => v[0]);
    if (names.every((v) => FRONT_REAR.test(v))) {
      return { facet: i, text: names.slice(0, 4).map(cap).join(t(' or ', ' ya ')) + '?' };
    }
    if (names.every((v) => FUEL.test(v))) {
      return { facet: i, text: names.slice(0, 3).map(cap).join(t(' or ', ' ya ')) + '?' };
    }
    // A handful of options is worth showing; 270 vehicles is not — for those
    // an open question is shorter for everyone.
    if (values.length <= 5) {
      return { facet: i, text: t('Which one?', 'Kaunsa?') + ` ${names.slice(0, 5).map(cap).join(' / ')}` };
    }
    return {
      facet: i,
      text:
        i === 1
          ? t('Which vehicle?', 'Kaunsi gaadi?')
          : t('Could you give me a little more detail?', 'Thoda aur detail bata dijiye?'),
    };
  }
  return null;
}

function cap(s) {
  return String(s)
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

// The last question put to this chat, so the same words are never sent twice
// in a row. "Thoda aur detail bata dijiye?" arriving twice within a second is
// the clearest possible tell that nobody is on the other end.
const lastAsked = chatState.slot('clarify.lastAsked');

function alreadyAsked(chatId, text) {
  const prev = lastAsked.get(chatId);
  return Boolean(prev && prev.text === text && Date.now() - prev.at < 5 * 60 * 1000);
}

function ask(chatId, state, question) {
  lastAsked.set(chatId, { text: question.text, at: Date.now() });
  const { base, qty, ref, key } = state;
  // Keep the facets already answered. Resetting them here made the bot ask
  // "kaunsi gaadi?" a second time after the customer had already said "alto" —
  // the one thing that makes a chatbot feel like a machine.
  const asked = [...new Set([...(state.asked || []), question.facet])];
  pending.set(chatId, { base, qty: qty || 1, ref: ref || null, key: key || null, asked, at: Date.now() });
  store.log('clarify', `"${base}" -> asking: ${question.text}`);
}

// Add the customer's answer to what we already know: "brake pad" + "alto".
function refine(chatId, answer, question) {
  const p = pending.get(chatId);
  if (!p) return null;
  p.base = `${p.base} ${answer}`.trim();
  // The clock is NOT restarted: the question is half an hour old from when it
  // was asked, however many answers came in. Restarting it kept a 10:41
  // "Kaunsi gaadi?" alive past 11:12 (13 Sep, live).
  if (question) p.asked.push(question.facet);
  pending.save(); // changed in place
  return p;
}

// Is this message an answer to what we just asked, rather than a new order?
// Only a SHORT reply with no part number counts — "alto", "front", "swift
// diesel". Anything longer is the customer moving on, and we let it.
const WHOLE_YES =
  /^(yes+|yeah|yup|ok(ay)?( ji)?|done|haan+|han+|hn+|ha|ji( haan| han)?|thik( hai)?|theek( hai)?|sahi( hai)?|pakka|final|bilkul|confirm(ed)?|yes,? confirm|confirm (karo|kar ?do)|kar ?do|order (kar ?do|laga ?do|punch kar ?do))\s*[.!]*$/i;
const WHOLE_NO = /^(cancel|stop|nahi|nhi|no|rehne do|rhne do|chhod do)\s*[.!]*$/i;

function isAnswerTo(chatId, text) {
  const p = pending.get(chatId);
  if (!p) return false;
  if (Date.now() - p.at > MAX_AGE_MS) {
    pending.delete(chatId);
    return false;
  }
  const t = String(text || '').trim();
  if (!t || t.length > 40) return false;
  // A whole-message yes or cancel answers the OTHER question the bot has
  // open - the confirm it just asked - not "Kaunsi gaadi?". On 12 Sep a
  // swipe-reply of "Yes confirm" to "4 items in the order. Confirm sir?"
  // was read as the name of a car, and the order never went in. Only a
  // message that is NOTHING BUT a yes counts here: "haan wagonr" is still
  // an answer about the car.
  if (WHOLE_YES.test(t) || WHOLE_NO.test(t)) return false;
  // Not answers about a car either: a bare number or list pick ("1.", "3"),
  // a cancel or a no anywhere in it, or a question. 13 Sep, live: "Poora kr
  // do cancel" and a swiped "1." were added to "brake pad" and answered with
  // "Which one? All Variants / With Yellow".
  if (/^\d{1,3}[.)]?$/.test(t)) return false;
  if (/\b(cancel|rehne do|rhne do|mat|mt|nahi|nhi|poora|pura|sab)\b/i.test(t)) return false;
  if (/\?\s*$/.test(t)) return false;
  const words = t.split(/\s+/);
  if (words.length > 4) return false;
  // a part number is an answer in its own right, handled by the normal path
  return !/(?=[A-Za-z0-9-]*[A-Za-z])(?=[A-Za-z0-9-]*\d)[A-Za-z0-9][A-Za-z0-9-]{4,}/.test(t);
}

function get(chatId) {
  const p = pending.get(chatId);
  if (p && Date.now() - p.at > MAX_AGE_MS) {
    pending.delete(chatId);
    return null;
  }
  return p || null;
}

function clear(chatId) {
  pending.delete(chatId);
}

// The short list shown once the questions have run out. Part number and name
// only — no rates, and never more than a screenful.
function options(matches, chatId) {
  const t = lang.for(chatId);
  const shown = matches.slice(0, SHOW_LIMIT);
  const rest = matches.length - shown.length;
  return (
    shown.map((t) => `${t.partNo} — ${t.name}`).join('\n') +
    (rest > 0 ? t(`\n(and ${rest} more)`, `\n(aur ${rest})`) : '') +
    t('\n\nWhich one do you need?', '\n\nKaunsa chahiye?')
  );
}

// The short list, shown with the question REMEMBERED. options() ends in
// "Which one do you need?" — a question — and nothing was kept to answer it:
// the customer read "BUMPER FRONT / BUMPER REAR", wrote "front", and was told
// there was no order pending (21 Sep, live, off a voice note). Asking and then
// forgetting we asked is worse than not asking.
function offer(chatId, state, matches) {
  const text = options(matches, chatId);
  const base = state && state.base;
  if (!chatId || !base) return text;
  lastAsked.set(chatId, { text, at: Date.now() });
  pending.set(chatId, {
    base,
    qty: state.qty || 1,
    ref: state.ref || null,
    key: state.key || null,
    asked: state.asked || [],
    at: Date.now(),
  });
  store.log('clarify', `"${base}" -> showed the list, waiting for their pick`);
  return text;
}

module.exports = { nextQuestion, ask, refine, isAnswerTo, get, clear, facets, options, offer, alreadyAsked };
