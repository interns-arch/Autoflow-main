'use strict';
// WHICH CAR we are talking about, per chat.
//
// core/focus remembers the PARTS just discussed, so "iska rate" resolves.
// This is the other half: the car those parts are for, so "is gaadi ka
// bumper" and "mujhe apni car ke liye ye chahiye" mean something.
//
// It comes from a number plate the customer sent (integrations/vahan), and
// it is the difference between searching the catalogue for "bumper" — which
// matches every bumper we sell — and searching for "bumper invicto".
//
// Kept longer than focus (a whole day, not half an hour): the part being
// discussed changes every few messages, but a customer does not change car
// mid-conversation. Cleared when they send a different plate.
//
// ONLY the fitment fields are ever stored here. vahan.js drops the owner's
// name and address before this module sees the record, so state.json never
// holds somebody's personal details because they asked about a bumper.
const chatState = require('./chatState');

const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const last = chatState.slot('vehicle'); // chatId -> { at, car }

function sweep() {
  const now = Date.now();
  for (const [chatId, v] of last) if (now - (v.at || 0) > MAX_AGE_MS) last.delete(chatId);
}

function remember(chatId, car) {
  if (!chatId || !car || (!car.maker && !car.model)) return null;
  sweep();
  const keep = {
    plate: car.plate || null,
    maker: car.maker || null,
    model: car.model || null,
    variant: car.variant || null,
    fuel: car.fuel || null,
    year: car.year || null,
  };
  last.set(chatId, { at: Date.now(), car: keep });
  return keep;
}

function get(chatId) {
  sweep();
  const v = chatId ? last.get(chatId) : null;
  return (v && v.car) || null;
}

function clear(chatId) {
  last.delete(chatId);
}

// The catalogue search, narrowed to this customer's car. "bumper" ->
// "bumper invicto". The portal's own search already filters on the extra
// words, so this needs nothing new on the portal side.
function narrow(chatId, phrase) {
  const car = get(chatId);
  const base = String(phrase || '').trim();
  if (!car || !base) return base;
  const words = require('../integrations/vahan').searchWords(car);
  if (!words) return base;
  // Already named the car themselves ("invicto ka bumper") — adding it again
  // would search for it twice and narrow to nothing.
  const have = base.toLowerCase();
  const add = words
    .split(/\s+/)
    .filter((w) => w.length > 2 && !have.includes(w.toLowerCase()))
    .join(' ');
  return add ? `${base} ${add}` : base;
}

module.exports = { remember, get, clear, narrow, MAX_AGE_MS };
