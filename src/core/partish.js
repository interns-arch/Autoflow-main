'use strict';
// Is this text a PART at all?
//
// That question was being answered in four places with four different rules,
// and the wrong answers all look the same to a customer: their question comes
// back as a part number they never mentioned. Three from the live line:
//
//   "GST kitna lagega"  -> the catalogue search dropped words until "GST"
//                          matched a row; the customer was answered with
//                          633100B210B0 and it was logged as a lost sale.
//   "2025 Swift"        -> `looksLikePartNumber` said yes (it has digits and
//                          no odd characters), so a car went to the portal as
//                          a part number and a person was asked to identify it.
//   "33400 M 68K31"     -> the Maruti label prints the number spaced; only
//                          "68K31" was picked up, which is not a part.
//
// One rule, in one place:
//
//   * A PART NUMBER is a single token carrying BOTH letters and digits
//     (16510M65L10, 41341-M68P00). "2025 Swift" has digits and letters but
//     never in the same token, so it is not one. A Maruti number printed with
//     spaces is joined back together before that test.
//   * A VEHICLE is never a part, however many digits are in it: "Swift 2020",
//     "i20 1.2", "alto 800". Those belong to "which vehicle?", not to the
//     catalogue.
//   * A QUESTION about money, timing or status is not a part either.
//   * Anything else with real words in it is a NAME to search the catalogue
//     by ("brake pad", "clutch plate swift").
const ai = require('./ai');

// Maruti prints "33400 M 68K31" on the box; customers copy it that way.
function joined(text) {
  return ai._internals.joinSpacedPartNumbers(String(text || '')).trim();
}

// What people drive, not what they buy. A model name anywhere in a short
// phrase means the phrase is about a car.
const VEHICLE =
  /\b(swift|dzire|desire|baleno|wagon\s?-?r|wagnor|alto|k10|celerio|ignis|ertiga|brezza|vitara|eeco|omni|ciaz|s-?cross|xl6|fronx|jimny|zen|esteem|a-?star|astar|ritz|sx4|gypsy|kizashi|i10|i20|creta|verna|venue|santro|aura|xcent|eon|accent|elantra|tucson|seltos|sonet|carens|nexon|punch|altroz|tiago|tigor|harrier|safari|zest|bolt|indica|indigo|scorpio|bolero|xuv\d*|thar|marazzo|kuv|tuv|kwid|duster|triber|kiger|lodgy|figo|ecosport|endeavour|aspire|freestyle|city|amaze|jazz|wr-?v|brio|civic|innova|fortuner|etios|glanza|urban\s?cruiser|camry|yaris|polo|vento|ameo|rapid|octavia|superb|kodiaq|creta|magnite|kicks|micra|sunny|terrano)\b/i;

// Who makes the car, as customers say it: "Maruti Suzuki ka bumper", "Tata
// Nexon front bumper". Separate from VEHICLE (the model) because a maker word
// on its own is not a car — "maruti" is half the catalogue.
const MAKER =
  /^(maruti|suzuki|hyundai|tata|mahindra|honda|toyota|kia|ford|nissan|renault|volkswagen|vw|skoda|chevrolet|datsun|mg|jeep|fiat|mitsubishi|isuzu|force|ashok|leyland|mercedes|benz|bmw|audi)$/i;

// Is this word about the CAR rather than the part? Used when searching the
// catalogue: part names are written "BUMPER FRONT | MARUTI SWIFT | ...", so a
// customer who leads with the car ("Maruti Suzuki ka bumper" — which is how
// nearly everyone SPEAKS it) needs the part words searched and the car words
// used to narrow. See dealerPortal.searchByName.
function isCarWord(word) {
  const w = String(word || '').trim();
  return MAKER.test(w) || VEHICLE.test(w);
}
function isMaker(word) {
  return MAKER.test(String(word || '').trim());
}

// Where on the car: "front", "rear", "LH". A filter on the part, never a part
// on its own - and the portal's search reads "front bumper" as a phrase, so
// these are kept out of the words it is sent.
const POSITION = /^(front|rear|back|fr|rr|lh|rh|left|right|upper|lower|side|inner|outer|agla|aage|peeche|pichla|piche)$/i;
function isPositionWord(word) {
  return POSITION.test(String(word || '').trim());
}
// Joining words a spoken name carries: "Swift Dzire KA front bumper".
const FILLER = /^(ka|ki|ke|wala|wali|wale|for|of|the|a|an|and|aur|chahiye|chaiye|chahie|hai|h)$/i;
function isFiller(word) {
  return FILLER.test(String(word || '').trim());
}

// A question, not a thing to sell. Kept separate from the vehicle list so the
// reason a phrase was refused can be logged honestly.
const ASK_ONLY =
  // The small joining words are here too. "Mrp of this? And gst ?" left
  // "and gst" after the rate words were stripped, and "and" not being on this
  // list made it a NAME - 11,095 catalogue matches and a person asked for the
  // rate of "and gst" (13 Sep, live).
  /^(gst|tax|rate|rates|price|prices|mrp|discount|bill|invoice|amount|total|payment|balance|ledger|pending|dues|outstanding|status|stock|available|availability|analysis|analyze|detail|details|detailed|kab|kaise|kahan|kaha|kitna|kitne|kitni|kya|kyu|kyun|hai|ho|hoga|hogi|lagega|lagta|lagti|milega|milegi|aayega|aayegi|ka|ki|ke|mera|meri|mujhe|aapka|batao|bata|bhejo|bhej|do|dena|dijiye|please|sir|ji|ok|okay|thanks|thank|you|yes|no|haan|nahi|and|aur|or|of|for|the|a|an|this|that|these|those|is|are|what|how|much|give|tell|show|me|my|iska|uska|iski|uski|iske|uske|ye|yeh|wo|woh|isme|usme)$/i;

function words(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s.-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

// Every word is a question word or a courtesy: nothing here to look up.
function isQuestion(text) {
  const w = words(text);
  return w.length > 0 && w.every((x) => ASK_ONLY.test(x));
}

// A model name and nothing that could be a part: a car, not an order line.
function isVehicle(text) {
  const t = String(text || '');
  if (!VEHICLE.test(t)) return false;
  if (ai.partNumberIn(joined(t))) return false; // "clutch plate swift 22400M83K02"
  // "clutch plate swift" is a NAME to search - it names a component as well as
  // a car. Only when nothing but the car (and its year, trim or engine) is
  // left is it a vehicle on its own.
  const rest = words(t).filter(
    (x) => !VEHICLE.test(x) && !/^(19|20)\d{2}$/.test(x) && !/^\d+(\.\d+)?$/.test(x) &&
      !/^(model|variant|vxi|lxi|zxi|vdi|ldi|zdi|sx|sxo|petrol|diesel|cng|new|old|type|gen|facelift)$/i.test(x),
  );
  return rest.length === 0;
}

// The part number inside the text, or null. Spaced Maruti numbers first.
function partNumber(text) {
  const t = joined(text);
  if (!t) return null;
  if (isVehicle(t) || isQuestion(t)) return null;
  return ai.partNumberIn(t);
}

// A registration number is letters and digits in a part-number's clothing:
// DL7CW1692 and HR26DQ5551 both satisfy every test for a part below, and a
// customer sending their plate would have had it looked up in the catalogue
// and escalated as an unknown part. It is a CAR, and integrations/vahan
// knows which one.
function isPlate(text) {
  return Boolean(require('../integrations/vahan').isOnlyPlate(text));
}

// Is the WHOLE string a part number by itself?
function isPartNumber(text) {
  const t = joined(text);
  if (t.length < 5 || isVehicle(t) || isQuestion(t) || isPlate(t)) return false;
  const found = ai.partNumberIn(t);
  if (!found) return false;
  // The token has to BE the string, not sit inside a sentence.
  const norm = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return norm(found) === norm(t);
}

// Worth searching the catalogue by name? Words, and not a question or a car.
function isNameQuery(text) {
  const t = String(text || '').trim();
  if (!t || t.length < 3) return false;
  if (isQuestion(t) || isVehicle(t)) return false;
  // A line carrying a part number is that part, not a name to search by:
  // "33400M68K31 COIL ASSY, IGNITION" searched as a name returns every
  // ignition coil we sell, which is how a photographed label was answered
  // with "which vehicle?".
  if (isPartNumber(t) || partNumber(t)) return false;
  return /[a-z]{3}/i.test(t);
}

// One word for what this text is, for logs and for callers that want to
// branch: 'number' | 'name' | 'vehicle' | 'question' | 'nothing'.
function classify(text) {
  const t = String(text || '').trim();
  if (!t) return 'nothing';
  if (isQuestion(t)) return 'question';
  if (isVehicle(t)) return 'vehicle';
  if (isPartNumber(t) || partNumber(t)) return 'number';
  if (isNameQuery(t)) return 'name';
  return 'nothing';
}

module.exports = { classify, isPartNumber, partNumber, isNameQuery, isQuestion, isVehicle, isCarWord, isMaker, isPositionWord, isFiller, joined };
