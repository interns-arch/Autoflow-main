'use strict';
// One message, processed once.
//
// Meta retries a webhook it thinks was not acknowledged, and the relay offers a
// message again when the bot never confirmed it. Nothing in the bot stopped a
// repeat: the same "Brake Pad 5" could land twice and double the cart, and the
// same "yes" could punch twice. The message id (`wamid…`) is the only thing
// that identifies a message across those retries, so it is written down.
//
// When it is written down matters (13 Sep). Marking a message seen the moment
// it ARRIVED meant a restart in the middle of handling it lost it for good:
// the relay offered it again and it was dropped as a duplicate. So:
//   begin(id) - not seen and not being handled right now? then it is ours
//   done(id)  - handled; recorded in state.json so a retry is dropped
// A duplicate arriving while the first copy is still being handled is stopped
// by the in-flight set; one arriving after is stopped by the record.
const store = require('../store');

const TTL_MS = 24 * 60 * 60 * 1000; // Meta stops retrying long before this
const MAX = 5000;
const inFlight = new Set();

function all() {
  const st = store.load();
  if (!st.seenMessages) st.seenMessages = {};
  return st.seenMessages;
}

function prune(m) {
  const cutoff = Date.now() - TTL_MS;
  for (const k of Object.keys(m)) if (!(m[k] > cutoff)) delete m[k];
  const keys = Object.keys(m);
  if (keys.length > MAX) {
    // Oldest first, keep the newest MAX.
    keys.sort((a, b) => m[a] - m[b]);
    for (const k of keys.slice(0, keys.length - MAX)) delete m[k];
  }
}

const keyOf = (key, id) => String(key || 'wa') + ':' + String(id);

// Ours to handle? A message with no id cannot be deduped - it is let through,
// because dropping a real customer message is worse than a rare duplicate.
function begin(key, id) {
  if (!id) return true;
  const k = keyOf(key, id);
  if (inFlight.has(k) || all()[k]) {
    store.log('seen', 'duplicate message ignored: ' + String(id).slice(-14));
    return false;
  }
  inFlight.add(k);
  return true;
}

// Handled - whether it went well or not. A handler that threw once would
// throw again, and a retry that half-worked would reply twice.
function done(key, id) {
  if (!id) return;
  const k = keyOf(key, id);
  inFlight.delete(k);
  const m = all();
  m[k] = Date.now();
  prune(m);
  store.save();
}

// true the FIRST time this id is seen, false every time after (begin + done
// in one step, for callers that handle a message synchronously).
function firstTime(key, id) {
  if (!begin(key, id)) return false;
  done(key, id);
  return true;
}

function forget(key, id) {
  const k = keyOf(key, id);
  inFlight.delete(k);
  delete all()[k];
  store.save();
}

module.exports = { begin, done, firstTime, forget, TTL_MS };
