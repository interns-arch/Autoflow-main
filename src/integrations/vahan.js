'use strict';
// Number plate -> what the car IS, so a customer can ask for a part without
// knowing its number.
//
// The registry is VAHAN (Ministry of Road Transport), which nobody outside an
// RTO, a bank or an insurer can call directly. This goes through Cashfree's
// verification suite, which wraps it:
//
//   POST https://api.cashfree.com/verification/vehicle-rc
//   headers: x-client-id, x-client-secret
//   body:    { vehicle_number, verification_id }
//
// VERIFIED 21 Sep: that path authenticates and reaches the IP check; the two
// other paths tried (/vehicle-rc-advance, /rc) are 404. Cashfree production
// answers 403 ip_validation_failed until the calling machine's public IP is
// whitelisted in their dashboard — so a deploy to a new box needs its IP
// added, and a broadband IP that changes will start failing silently.
//
// ---------------------------------------------------------------------------
// WE TAKE THE CAR, NOT THE OWNER.
//
// An RC record carries the owner's name, address and father's name. None of
// that helps sell a bumper, and all of it is somebody's personal data sitting
// in state.json and the chat log if it is kept. readRc() lifts the six
// fitment fields and drops the rest on the floor — before anything is logged,
// stored, or shown to a model.
// ---------------------------------------------------------------------------
//
// The response SHAPE is not verified yet: the live call is IP-blocked at the
// time of writing, so the reader below accepts every field name Cashfree is
// known to use for the same thing, and logs the key list once on the first
// real answer. When that lands, tighten readRc() to what actually arrives —
// the same way dealerPortal's analyze reader was tightened.
const config = require('../config');
const store = require('../store');

const v = () => config.vahan;

function enabled() {
  return Boolean(v().apiKey && v().url);
}
const isMock = () => !enabled();

// Indian registration numbers, in the shapes people actually type them:
//   DL7CW1692 · DL 7 CW 1692 · DL-7-CW-1692 · HR26DQ5551 · MH12AB1234
//   KA01A1234 (one series letter) · 22BH1234AA (the newer BH series)
//
// Anchored on a REAL state code rather than "two letters", because a part
// number is also letters and digits and the two must never be confused:
// 23820M79J20 and 92402C4000 are parts, not cars.
const STATE =
  '(?:AN|AP|AR|AS|BR|CG|CH|DD|DL|DN|GA|GJ|HP|HR|JH|JK|KA|KL|LA|LD|MH|ML|MN|MP|MZ|NL|OD|OR|PB|PY|RJ|SK|TN|TR|TS|UK|UA|UP|WB)';
const SEP = '[\\s-]?';
const PLATE_RE = new RegExp(`\\b(${STATE}${SEP}\\d{1,2}${SEP}[A-Z]{0,3}${SEP}\\d{4})\\b`, 'i');
// 22 BH 1234 AA — the series that is not tied to a state at all.
const BH_RE = new RegExp(`\\b(\\d{2}${SEP}BH${SEP}\\d{4}${SEP}[A-Z]{1,2})\\b`, 'i');

// The plate in a message, normalised to DL7CW1692, or null.
function plateIn(text) {
  const t = String(text || '').toUpperCase();
  const m = t.match(BH_RE) || t.match(PLATE_RE);
  if (!m) return null;
  const plate = m[1].replace(/[\s-]/g, '');
  // A four-digit tail is the one thing every real plate has. Without this a
  // bare "DL 7" would pass.
  return /\d{4}/.test(plate) ? plate : null;
}

// Is the WHOLE message a plate and nothing else? "DL7CW1692" on its own is a
// customer telling us their car; "DL7CW1692 ka bumper" is that plus an order.
function isOnlyPlate(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  const p = plateIn(t);
  return Boolean(p) && t.replace(/[\s-]/g, '').toUpperCase() === p;
}

// Everything we keep. Nothing else from the RC record is read, so nothing
// else can leak into a log, a reply, or a prompt.
function readRc(data) {
  const d = (data && (data.data || data.result || data)) || {};
  const pick = (...names) => {
    for (const n of names) {
      const hit = d[n] !== undefined ? d[n] : data && data[n];
      if (hit !== undefined && hit !== null && String(hit).trim() !== '') return String(hit).trim();
    }
    return null;
  };
  const regDate = pick('registration_date', 'regn_dt', 'registrationDate');
  const yearFrom = (s) => {
    const m = String(s || '').match(/(19|20)\d{2}/);
    return m ? m[0] : null;
  };
  return {
    plate: pick('registration_number', 'rc_number', 'vehicle_number', 'regn_no'),
    maker: pick('maker_description', 'maker', 'manufacturer', 'maker_model'),
    model: pick('maker_model', 'model', 'vehicle_model', 'model_name'),
    variant: pick('variant', 'body_type', 'vehicle_class_description', 'vehicle_class'),
    fuel: pick('fuel_type', 'fuel', 'fuel_norms'),
    year: yearFrom(pick('manufacturing_date', 'manufacturing_year', 'mfg_year')) || yearFrom(regDate),
  };
}

// What the CUSTOMER sees, so they can say "haan, yehi hai". VAHAN shouts in
// capitals and names the company rather than the brand — "MARUTI SUZUKI
// INDIA LTD INVICTO ZETA PLUS 7S" reads like a database row, not a car. The
// variant is kept, because that is the bit that tells them we read the right
// vehicle.
function describe(car) {
  if (!car) return '';
  // "7S", "I10", "XUV500" keep their shape; plain words get a capital.
  const nice = (s) =>
    String(s || '')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .map((w) =>
        // "PETROL/HYBRID" and "PETROL/CNG" are two words wearing one token.
        w
          .split('/')
          .map((p) => (/^[A-Za-z]+$/.test(p) ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : p))
          .join('/'),
      )
      .join(' ');
  const maker = nice(String(car.maker || '').replace(/\b(india|limited|ltd|pvt|private|motors?|company|co)\b/gi, ' '));
  const head = [maker, nice(car.model)].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  const tail = [car.year, nice(car.fuel)].filter(Boolean).join(', ');
  return head + (tail ? ` (${tail})` : '');
}

// The words worth adding to a catalogue search: the BRAND and the NAMEPLATE,
// and nothing else.
//
// VAHAN gives the maker as a company ("MARUTI SUZUKI INDIA LTD") and the
// model as the full variant ("INVICTO ZETA PLUS 7S"). Part names are written
// "BRAKE PAD | MARUTI SUZUKI ALTO K10 | FRONT", so "MARUTI" and "INVICTO"
// match and "ZETA PLUS 7S" matches nothing — and the portal's search narrows
// by requiring EVERY extra word, so one variant word finds zero parts. Year
// and fuel are left out for the same reason.
function searchWords(car) {
  if (!car) return '';
  const first = (s) =>
    String(s || '')
      .replace(/[^A-Za-z0-9\s-]/g, ' ')
      .trim()
      .split(/\s+/)[0] || '';
  const brand = first(car.maker);
  const plate = first(car.model);
  return [brand, plate].filter(Boolean).filter((w, i, a) => a.indexOf(w) === i).join(' ').trim();
}

// Offline: data/mock-vehicles.json, keyed by plate, so the whole flow runs
// without a live lookup — the same trick the Dealer Portal uses.
let mockCache = null;
function mockVehicles() {
  if (mockCache) return mockCache;
  try {
    const fs = require('fs');
    const path = require('path');
    mockCache = JSON.parse(fs.readFileSync(path.join(config.dataDir, 'mock-vehicles.json'), 'utf-8'));
  } catch {
    mockCache = {};
  }
  return mockCache;
}
function setMockVehicles(rows) {
  mockCache = rows && typeof rows === 'object' ? rows : {};
  return Object.keys(mockCache).length;
}

// plate -> { plate, maker, model, variant, fuel, year } | null
//
// Never throws. A lookup that cannot be done is not an error the customer
// should see: the bot carries on and asks which car, exactly as it did
// before any of this existed.
async function lookup(plateText) {
  const plate = plateIn(plateText) || String(plateText || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!plate) return null;

  if (isMock()) {
    const row = mockVehicles()[plate] || null;
    if (row) store.log('vahan', `MOCK ${plate} -> ${describe(row)}`);
    return row ? { ...row, plate } : null;
  }

  try {
    const headers = { 'Content-Type': 'application/json', 'x-client-secret': v().apiKey, ...v().headers };
    const body = { vehicle_number: plate };
    // Cashfree wants a caller-side reference on every verification; the field
    // it is called is env-configurable because it differs between their
    // products (VAHAN_API_REF_PARAM).
    if (v().refParam) body[v().refParam] = 'ct-' + Date.now();

    const res = await fetch(v().url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(v().timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) {
      // 403 ip_validation_failed is the one that will happen in real life:
      // a new server, or a broadband IP that moved. Say so plainly, because
      // from the outside it looks identical to "no such vehicle".
      store.log('vahan', `lookup ${plate} failed: HTTP ${res.status} ${text.slice(0, 140).replace(/\s+/g, ' ')}`);
      return null;
    }
    let data = null;
    try { data = JSON.parse(text); } catch { data = null; }
    if (!data) return null;
    const car = readRc(data);
    if (!car.maker && !car.model) {
      // Log the SHAPE, never the values: an RC body is somebody's name and
      // address. This is how the reader gets tightened once, on the first
      // real answer, without that answer being written down.
      store.log('vahan', `lookup ${plate}: no maker/model found. keys seen: ${Object.keys((data && (data.data || data)) || {}).join(',').slice(0, 200)}`);
      return null;
    }
    car.plate = car.plate || plate;
    store.log('vahan', `${plate} -> ${describe(car)}`);
    return car;
  } catch (e) {
    store.log('vahan', `lookup ${plate} failed: ${String((e && e.message) || e).slice(0, 120)}`);
    return null;
  }
}

module.exports = {
  lookup,
  plateIn,
  isOnlyPlate,
  describe,
  searchWords,
  enabled,
  get isMock() {
    return isMock();
  },
  setMockVehicles,
  _readRc: readRc,
};
