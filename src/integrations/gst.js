'use strict';
// GSTIN -> the firm, from gstinapi.in.
//
//   GET https://gstinapi.in/v1/gstin/{gstin}
//   header: x-api-key
//
// VERIFIED 21 Sep against the live API. Two things worth writing down,
// because both cost an hour to find:
//   * there is NO /api prefix. /api/v1/gstin/... answers
//     {"error":"Route not found"} for every auth style, which reads exactly
//     like a bad key.
//   * the key goes in x-api-key. An Authorization: Bearer header is ignored
//     and the call comes back 401 saying so.
//
// Lookups are METERED (the reply carries credits_remaining). A GSTIN that
// does not exist is not charged, which is why the shape check runs first:
// a typo should never cost a credit.
//
// What comes back is a FIRM, not a person — legal name, trade name, the
// registered address and whether the registration is live. That is public
// record on the GST portal, and it is exactly the half of the customer form
// nobody should have to type on a phone.
const config = require('../config');
const store = require('../store');

// 15 characters: 2 state + 10 PAN + 1 entity + Z + 1 check.
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z][Z][0-9A-Z]$/;

// The first two digits are the state, and the reply gives only that number.
const STATES = {
  '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh',
  '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh',
  10: 'Bihar', 11: 'Sikkim', 12: 'Arunachal Pradesh', 13: 'Nagaland', 14: 'Manipur',
  15: 'Mizoram', 16: 'Tripura', 17: 'Meghalaya', 18: 'Assam', 19: 'West Bengal',
  20: 'Jharkhand', 21: 'Odisha', 22: 'Chhattisgarh', 23: 'Madhya Pradesh', 24: 'Gujarat',
  26: 'Dadra & Nagar Haveli and Daman & Diu', 27: 'Maharashtra', 29: 'Karnataka',
  30: 'Goa', 31: 'Lakshadweep', 32: 'Kerala', 33: 'Tamil Nadu', 34: 'Puducherry',
  35: 'Andaman & Nicobar Islands', 36: 'Telangana', 37: 'Andhra Pradesh', 38: 'Ladakh',
};

function enabled() {
  return Boolean(config.gst.apiKey);
}

function looksValid(gstin) {
  return GSTIN_RE.test(String(gstin || '').replace(/\s/g, '').toUpperCase());
}

function stateOf(code, gstin) {
  const c = String(code || String(gstin || '').slice(0, 2)).padStart(2, '0');
  return STATES[c] || STATES[String(Number(c))] || null;
}

// The reply, reduced to what the customer form has boxes for.
function readGst(body) {
  const d = (body && body.data) || {};
  const clean = (v) => {
    const s = String(v === null || v === undefined ? '' : v).trim();
    // The API sends the STRING "null" for empty fields, not null.
    return !s || s.toLowerCase() === 'null' ? null : s;
  };
  const a = d.address_details || {};
  return {
    gstin: clean(d.gstin) || clean(body && body.gstin),
    // The trade name is what is over the door; the legal name is what is on
    // the certificate. Prefer the one a customer would recognise.
    name: clean(d.trade_name) || clean(d.legal_name),
    legalName: clean(d.legal_name),
    status: clean(d.status),
    taxpayerType: clean(d.taxpayer_type),
    businessType: clean(d.business_constitution),
    address: clean(d.address),
    city: clean(d.city) || clean(a.locality) || clean(a.city),
    state: stateOf(clean(d.state_code), clean(d.gstin)),
    pin: clean(d.pincode) || clean(a.pincode),
    registeredOn: clean(d.registration_date),
  };
}

// gstin -> firm | { error: 'shape' | 'notfound' } | null
//
// Never throws. A lookup that cannot be done leaves the form asking the
// questions by hand, which is how it worked before this existed.
// Every lookup is a paid credit. 22 Sep: the provider wrote to say the same
// GSTINs were being checked again and again - 06CIYPK2053H1ZZ twice in one
// afternoon, from the same customer retrying. An answer is kept for a day
// (the chatState janitor drops it after that), so a retry costs nothing.
// Only real answers are kept: a failed call is tried again next time.
const cache = require('../core/chatState').slot('gst.lookups'); // gstin -> { at, firm }
const CACHE_MS = 24 * 60 * 60 * 1000;

async function lookup(gstin) {
  const g = String(gstin || '').replace(/\s/g, '').toUpperCase();
  if (!looksValid(g)) return { error: 'shape' };
  if (!enabled()) return null;
  const kept = cache.get(g);
  if (kept && Date.now() - kept.at < CACHE_MS) {
    store.log('gst', `${g}: answered from today's lookup - no credit spent`);
    return kept.firm;
  }
  const firm = await fetchFirm(g);
  if (firm) cache.set(g, { at: Date.now(), firm });
  return firm;
}

async function fetchFirm(g) {
  try {
    const res = await fetch(config.gst.url.replace(/\/$/, '') + '/' + encodeURIComponent(g), {
      headers: { 'x-api-key': config.gst.apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(config.gst.timeoutMs),
    });
    const body = await res.json().catch(() => null);
    if (res.status === 404) {
      store.log('gst', `${g}: not on the GST database`);
      return { error: 'notfound' };
    }
    if (!res.ok || !body || body.success === false) {
      store.log('gst', `${g}: HTTP ${res.status} ${JSON.stringify(body || {}).slice(0, 120)}`);
      return null;
    }
    const firm = readGst(body);
    if (!firm.name) {
      store.log('gst', `${g}: no name in the reply. keys: ${Object.keys(body.data || {}).join(',').slice(0, 160)}`);
      return null;
    }
    // Worth logging: the plan is metered and this is the only warning anyone
    // gets before lookups start failing.
    const left = body.credits_remaining;
    store.log('gst', `${g} -> ${firm.name} (${firm.status})${left !== undefined ? `, ${left} credits left` : ''}`);
    return firm;
  } catch (e) {
    store.log('gst', `${g} lookup failed: ${String((e && e.message) || e).slice(0, 120)}`);
    return null;
  }
}

// A registration that is not live must not open an account: the order would
// be billed against a GSTIN the tax portal has already cancelled.
function isLive(firm) {
  return Boolean(firm && firm.status && /^active$/i.test(firm.status));
}

// What the customer is shown, so they can say "haan, yehi hai".
function describe(firm) {
  if (!firm) return '';
  return [firm.name, [firm.city, firm.state, firm.pin].filter(Boolean).join(', ')]
    .filter(Boolean)
    .join(' — ');
}

// A GSTIN READ OFF A PHOTOGRAPH, then verified like any other.
//
// The reading is done by vision (core/ai.readGstPhoto, which holds the prompt
// and the reasons). What matters HERE is that nothing the model read is
// trusted: the shape is checked, and the number then goes to the GST register
// exactly as a typed one does. A misread character produces "not found",
// which is a question to the customer, never a wrong account.
//
// -> { gstin } | { error: 'none' } | { error: 'shape', saw } | null
async function readFromImage(base64, mediaType) {
  if (!base64) return null;
  const out = await require('../core/ai').readGstPhoto(base64, mediaType);
  if (!out) return null; // no model, or the call failed

  const raw = String(out.gstin || '').toUpperCase();
  if (!raw) {
    store.log('gst', 'no GSTIN in that photo');
    return { error: 'none' };
  }
  if (!looksValid(raw)) {
    // Something GSTIN-ish but wrong. Worth telling the customer WHAT was
    // read — they spot "it saw 0 instead of O" at a glance, and that beats
    // "send it again" with no reason given.
    store.log('gst', `photo gave "${raw.slice(0, 20)}" which is not a GSTIN shape`);
    return { error: 'shape', saw: raw.slice(0, 20) };
  }
  store.log('gst', `photo read as ${raw} - verifying against the register`);
  return { gstin: raw };
}

module.exports = { lookup, looksValid, isLive, describe, enabled, readFromImage, GSTIN_RE, _readGst: readGst };
