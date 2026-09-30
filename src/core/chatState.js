'use strict';
// Per-chat memory that survives a restart.
//
// Phase 1 of the pipeline review (13 Sep). What the bot remembers about a
// conversation lived in a dozen in-process Maps — the quantity it asked for,
// the "Kaunsi gaadi?" it is waiting on, the part just discussed, the voice
// note it read back, the customer a salesman picked, "cancel the whole order?"
// — and every deploy or crash wiped all of it mid-conversation. SO 626 was
// punched because an ask lived in memory and a deploy removed it.
//
// Each of those Maps becomes a SLOT here: same get/set/has/delete/iterate
// surface, so the module using it changes one line, but the contents live in
// state.json under `chatState.<slot>`.
//
// Rules that keep this safe:
//   * Values must be plain data. A value that cannot be written as JSON is
//     kept in memory only and logged, so one bad value can never stop
//     state.json from being saved.
//   * Timers stay out of here (the confirm and greeting nudges): a timer does
//     not survive a restart however it is stored.
//   * Each module still checks its own ages exactly as before. On top of that
//     a janitor drops anything a slot has held for more than a day, so chats
//     that never come back do not grow the file forever. It runs the first
//     time a slot is touched after the file is loaded - right after a restart,
//     when day-old leftovers are most likely - and every ten minutes after.
const store = require('../store');

const JANITOR_EVERY_MS = 10 * 60 * 1000;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const lastJanitor = new Map(); // slot name -> when it last ran
const swept = new WeakSet(); // slot objects already swept since they were loaded
const memoryOnly = new Map(); // slot name -> Map of values JSON refused

function rootOf(name) {
  const st = store.load();
  if (!st.chatState) st.chatState = {};
  if (!st.chatState[name] || typeof st.chatState[name] !== 'object') st.chatState[name] = {};
  return st.chatState[name];
}

function ageOf(value) {
  if (typeof value === 'number') return value;
  if (value && typeof value.at === 'number') return value.at;
  return null;
}

const maxAge = new Map(); // slot name -> its own age limit, when it keeps longer than a day
function janitor(name, root) {
  const now = Date.now();
  const fresh = !swept.has(root);
  if (!fresh && now - (lastJanitor.get(name) || 0) < JANITOR_EVERY_MS) return;
  swept.add(root);
  lastJanitor.set(name, now);
  let dropped = 0;
  for (const k of Object.keys(root)) {
    const at = ageOf(root[k]);
    if (at !== null && now - at > (maxAge.get(name) || MAX_AGE_MS)) {
      delete root[k];
      dropped++;
    }
  }
  if (dropped) {
    store.save();
    store.log('chatState', name + ': ' + dropped + ' stale chat(s) dropped');
  }
}

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// `opts.maxAgeMs`: a slot whose entries must outlive a day (a payment an
// order is held on waits as long as the customer takes to pay).
function slot(name, opts = {}) {
  if (opts.maxAgeMs) maxAge.set(name, opts.maxAgeMs);
  const root = () => {
    const r = rootOf(name);
    janitor(name, r);
    return r;
  };
  const mem = () => {
    if (!memoryOnly.has(name)) memoryOnly.set(name, new Map());
    return memoryOnly.get(name);
  };
  const entries = () => [...Object.entries(root()), ...mem().entries()];

  return {
    get(key) {
      const k = String(key);
      const r = root();
      return has(r, k) ? r[k] : mem().get(k);
    },
    has(key) {
      const k = String(key);
      return has(root(), k) || mem().has(k);
    },
    set(key, value) {
      const k = String(key);
      try {
        JSON.stringify(value);
      } catch (e) {
        store.log('chatState', name + ': value for ' + k + ' is not plain data (' + String(e.message).slice(0, 60) + ') - kept in memory only');
        delete root()[k];
        mem().set(k, value);
        return this;
      }
      mem().delete(k);
      root()[k] = value;
      store.save();
      return this;
    },
    delete(key) {
      const k = String(key);
      const r = root();
      const had = has(r, k) || mem().has(k);
      delete r[k];
      mem().delete(k);
      if (had) store.save();
      return had;
    },
    clear() {
      rootOf(name);
      store.load().chatState[name] = {};
      mem().clear();
      store.save();
    },
    // A value changed in place (`s.at = Date.now()`) is written on the next
    // save; call this right after such a change.
    save() {
      store.save();
    },
    get size() {
      return Object.keys(root()).length + mem().size;
    },
    keys() {
      return entries().map(([k]) => k)[Symbol.iterator]();
    },
    values() {
      return entries().map(([, v]) => v)[Symbol.iterator]();
    },
    entries() {
      return entries()[Symbol.iterator]();
    },
    // A snapshot, so deleting while iterating is as safe as it was on a Map.
    [Symbol.iterator]() {
      return entries()[Symbol.iterator]();
    },
  };
}

module.exports = { slot, MAX_AGE_MS };
