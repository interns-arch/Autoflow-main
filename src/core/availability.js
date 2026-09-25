'use strict';
// Availability resolution. Replaces the old local-stock module: this process
// holds NO stock. Every answer comes from the Dealer Portal `analyze` call.
//
// Before asking the portal, each requested line passes through the learned
// alias map (core/knowledge.js) so a loose customer phrase — "clutch plate
// swift dzire petrol" — becomes the real part number a human taught us once.
const portal = require('../integrations/dealerPortal');
const knowledge = require('./knowledge');
const lang = require('./lang');
const config = require('../config');
const store = require('../store');

// Part numbers compare on letters+digits only (ProcureHub and the Dealer
// Portal both normalise this way): "DM-BP/1001" === "DMBP1001".
function normPart(v) {
  return String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]+/g, '');
}

// Loose name comparison for cart operations ("remove oil filter").
function sameItem(a, b) {
  const x = String(a == null ? '' : a).toLowerCase().trim();
  const y = String(b == null ? '' : b).toLowerCase().trim();
  if (!x || !y) return false;
  if (x === y) return true;
  if (normPart(x) && normPart(x) === normPart(y)) return true;
  return x.includes(y) || y.includes(x);
}

// A token that looks like a part number rather than a product name.
// Is the whole phrase a part number? The rule lives in core/partish: one
// token carrying BOTH letters and digits, never a car, never a question.
// This used to say yes to "2025 Swift" and "wiper blade 18 inch", and both
// went to the portal as part numbers.
function looksLikePartNumber(text) {
  return require('./partish').isPartNumber(text);
}

// Customers write the description AND the number together: "wiper bottel pipe
// 38402M72R00", "radiator cap 17920M75F00", "hendal 82802M81A60-5pk". The
// number is right there, but sending the whole phrase to the portal as a part
// number finds nothing — 60 of 74 escalations in one replay were this, every
// one of them answerable without troubling a person.
//
// A part number is the token holding BOTH a letter and a digit; a bare year
// ("2025") or a bare word never qualifies.
const EMBEDDED_PART_RE = /\b(?=[A-Za-z0-9-]*[A-Za-z])(?=[A-Za-z0-9-]*[0-9])[A-Za-z0-9][A-Za-z0-9-]{4,}\b/g;

// The part number inside a line that also carries words, or null. A Maruti
// number printed with spaces ("33400 M 68K31") is joined back together
// first - only "68K31" used to come out of those.
function extractPartNo(text) {
  const p = require('./partish');
  if (p.isPartNumber(text)) return null; // it IS the number; nothing to extract
  return p.partNumber(text);
}

// Names we can offer the message parser for matching. Sourced from what we
// have actually learned, not from a local stock table (there isn't one).
function catalogNames() {
  return knowledge.aliasNames();
}

// Ask the Dealer Portal about a batch of requested lines.
// lines: [{ item, qty }]  ->  resolved lines (see dealerPortal.normaliseLine)
// A part number the pricing call does not know, that the portal's own
// catalogue search finds perfectly well. Measured on the Kalra Motor replay
// (12 Sep), all of these went to a person for want of this one lookup:
//   "510M52M01"   -> 82510M52M01     (vision lost the first two characters)
//   "2322M50S00"  -> 72322M50S00
//   "23856-79M00" -> 23856M79M00     (the label prints a hyphen, the portal an M)
// Only an UNAMBIGUOUS match is taken - one row, and our number must sit at the
// end of it - because quoting the wrong part is worse than asking a person.
// "26300-02752", "90915-YZZD2", "43430-0K021": groups joined by a hyphen or a
// space, the way Hyundai, Kia and Toyota print them. The portal stores most
// of these WITHOUT the hyphen - 13 Sep, live: "26300-02752" is Invalid Part
// No, "2630002752" is FILTER ASSY-ENGINE OIL | HYUNDAI. All digits is fine
// here: the groups are what make it a part number and not a phone number.
const GROUPED_PART = /^[A-Za-z0-9]{3,}(?:[- ][A-Za-z0-9]{2,}){1,3}$/;
function groupedPart(text) {
  const t = String(text || '').trim();
  return GROUPED_PART.test(t) && /\d/.test(t) && t.replace(/[^A-Za-z0-9]/g, '').length >= 8 ? t : null;
}

async function repairUnknown(prepared, resolved, ctx) {
  const partish = require('./partish');
  const stuck = [];
  const askedAs = new Map();
  for (let i = 0; i < resolved.length; i++) {
    // Only a real part-number shape is worth a catalogue search. Without
    // this, "2025 Swift" would be searched and could match a Swift part.
    if (!resolved[i] || resolved[i].source !== 'unidentified') continue;
    const candidate =
      prepared[i].partNo && (partish.isPartNumber(prepared[i].partNo) || groupedPart(prepared[i].partNo))
        ? prepared[i].partNo
        : groupedPart(prepared[i].item);
    if (candidate) {
      stuck.push(i);
      askedAs.set(i, candidate);
    }
  }
  if (!stuck.length) return resolved;

  const norm = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const fixes = new Map();
  // A handwritten list of 22 parts had 13 stuck; six repairs left seven of
  // them to a person (13 Sep, live).
  for (const i of stuck.slice(0, 30)) {
    const asked = askedAs.get(i);
    const variants = [asked];
    // The same groups with nothing between them (Hyundai, Kia, Toyota) ...
    if (/[- ]/.test(asked)) variants.push(asked.replace(/[- ]+/g, ''));
    // ... or an M where the label printed a hyphen (Maruti).
    if (asked.indexOf('-') >= 0) variants.push(asked.split('-').join('M'));
    for (const v of variants) {
      let rows = [];
      try {
        rows = ((await portal.searchByName(v)) || {}).top || [];
      } catch (e) {
        store.log('avail', 'catalogue search for ' + v + ' failed: ' + String((e && e.message) || e).slice(0, 90));
      }
      const want = norm(v);
      const hit = rows.filter((r) => {
        const got = norm(r.partNo);
        return got === want || got.endsWith(want);
      });
      if (hit.length === 1) {
        fixes.set(i, hit[0].partNo);
        store.log('avail', 'part ' + asked + ' not in the pricing call; catalogue says ' + hit[0].partNo);
        break;
      }
    }
  }
  if (!fixes.size) return resolved;

  const retry = [...fixes.keys()].map((i) => ({ ...prepared[i], item: fixes.get(i), partNo: fixes.get(i) }));
  let again = [];
  try {
    // The same call the first attempt made: a known customer gets their rate,
    // MRP and GST on the repaired line too, not a bare availability answer.
    again = (ctx && (ctx.accountId || ctx.buyerId) ? await portal.commercialAnalyze(retry, ctx) : null) || (await portal.analyze(retry, ctx));
  } catch (e) {
    store.log('avail', 'retry after catalogue repair failed: ' + String((e && e.message) || e).slice(0, 110));
    return resolved;
  }
  const out = resolved.slice();
  [...fixes.keys()].forEach((i, n) => {
    if (again[n]) out[i] = { ...again[n], _repairedFrom: askedAs.get(i) };
  });
  return out;
}

async function resolve(lines, ctx) {
  // Last guard before the portal. A blank part number is rejected with a 422
  // that takes the whole batch down with it, so a single bad line from any
  // parser path would lose every good line beside it.
  const prepared = (lines || [])
    .filter((l) => l && String(l.item || '').trim())
    .map((l) => {
    const alias = knowledge.lookupAlias(l.item);
    return {
      item: l.item,
      // alias wins; then a part number embedded in the customer's words; then
      // the phrase itself if it already IS a part number.
      partNo:
        alias ||
        extractPartNo(l.item) ||
        (looksLikePartNumber(l.item) ? require('./partish').joined(l.item) : null),
      qty: Number(l.qty) || 1,
      ref: l.ref || null, // the customer's own order number, if their file had one
      key: l.key || null, // identifies THIS row, so identical rows stay apart
      desc: l.desc || '', // the customer's own description, echoed back untouched
      // The customer never said how many. Carried through so the bot can ask
      // instead of quietly ordering one.
      qtyMissing: Boolean(l.qtyMissing),
      _aliased: Boolean(alias),
    };
  });

  // The commercial answer first: stock AND this customer's rate, MRP,
  // discount, tax and TAT in one call. It needs the customer's account, so a
  // number the portal does not know still goes down the old road - which
  // answers availability perfectly well, just without any money on it.
  let answered = null;
  // Was this priced for the person ASKING, or merely priced? The difference
  // decides whether the rate may be repeated to them (see describe/priceOf).
  // config.dealerPortal.listPriceAccountId is the fallback used to read MRP
  // for a number the portal does not know — its discount is not theirs.
  const ownAccount = Boolean(
    ctx &&
      (ctx.accountId || ctx.buyerId) &&
      String(ctx.accountId || ctx.buyerId) !== String(config.dealerPortal.listPriceAccountId || ''),
  );
  // A number the portal does not know still gets an MRP, by pricing against
  // the fallback account. Only the MRP is then repeatable (ownAccount is
  // false above), so the customer hears "MRP Rs.799" and never that account's
  // negotiated Rs.187. Without this, an unregistered customer got no money
  // information at all and every "Price" went to a person.
  const priceCtx =
    ctx && (ctx.accountId || ctx.buyerId)
      ? ctx
      : config.dealerPortal.listPriceAccountId
        ? { ...(ctx || {}), accountId: config.dealerPortal.listPriceAccountId }
        : null;

  if (priceCtx) {
    try {
      answered = await portal.commercialAnalyze(prepared, priceCtx);
    } catch (e) {
      store.log('avail', 'commercial-analyze failed, falling back: ' + String((e && e.message) || e).slice(0, 120));
    }
  }
  if (!answered) answered = await portal.analyze(prepared, ctx);
  const resolved = await repairUnknown(prepared, answered, ctx);

  // Keep the customer's own wording in replies — they recognise what they
  // typed, not our internal part name.
  return resolved.map((r, i) => {
    // A part a human has already confirmed is a REAL part we simply do not
    // stock must never go back to that human. They said "this number is
    // correct" once; asking again is the repetition this whole flow exists to
    // remove. The customer hears "on order, about a week" instead.
    const out =
      r.source === 'unidentified' && prepared[i].partNo && knowledge.isOnOrder(prepared[i].partNo)
        ? { ...r, source: 'unavailable', eta: `on order — ETA = ${config.onOrderEtaDays} days` }
        : r;
    return {
    ...out,
    // Only true when the portal priced against this customer's own account.
    pricedForCustomer: ownAccount,
    requested: prepared[i].item,
    item: out.item || prepared[i].item,
    // Dropping this here collapsed four of the customer's orders back into
    // one flat list the moment availability was resolved.
      ref: prepared[i].ref,
      key: prepared[i].key,
      desc: prepared[i].desc,
      qtyMissing: prepared[i].qtyMissing,
    };
  });
}

// Catalogue lookup by NAME, for customers who write "Brake pad - 5" instead of
// a part number. `analyze` only speaks part numbers, so without this the line
// was unresolvable and the customer got nothing back at all.
// A question is not a part to look up, and neither is a car. One rule for
// all of it lives in core/partish.
//
// 12 Sep, live: "GST kitna lagega" went into the catalogue search, which
// drops words until something matches - and "GST" matched a row. The
// customer was answered with a part number they never mentioned, and it was
// recorded as a lost sale.
function notSearchable(query) {
  const p = require('./partish');
  return p.isQuestion(query) || p.isVehicle(query);
}

async function byName(query) {
  // A wide sample, because the FOLLOW-UP QUESTION is chosen from it: five rows
  // would show five cars and ask "which of these?" when the catalogue actually
  // holds 270. Only a few are ever shown to the customer.
  if (notSearchable(query)) {
    store.log('avail', 'not searched as a part (' + require('./partish').classify(query) + '): ' + String(query).slice(0, 40));
    return { total: 0, top: [] };
  }
  const r = await portal.searchByName(query, 60);
  return r && r.top ? r : { total: 0, top: [] };
}

// Is this something we should look up by name? Not a part number, not a
// question, not a car, and not a phrase a human has already taught us.
function isNameQuery(item) {
  const p = require('./partish');
  return p.isNameQuery(item) && !knowledge.lookupAlias(item);
}

// Convenience for a single line.
async function resolveOne(item, qty, ctx) {
  const [line] = await resolve([{ item, qty: qty || 1 }], ctx);
  return line;
}

// What to call this line back to the customer.
//
// When the customer typed the part number itself, echo the PORTAL's spelling,
// not theirs: they type "13780m68p01" and the catalogue says "13780M68P01".
// Quoting it back in their lowercase looks like a different part, and a dealer
// reading the reply cannot match it against a printed invoice. When they typed
// a name ("brake pad") that is not the part number at all, keep their words.
function displayName(line) {
  const asked = line.requested || line.item;
  if (line.partNo && sameItem(asked, line.partNo)) return line.partNo;
  return asked;
}

// Availability line for a quote. Kept to the length a person at a parts
// counter would actually type — the customer asked one thing, not for a
// paragraph. `eta` used to be appended to an already-"available" line, which
// read as "available (Rs.450) — available".
// What may be said about money for this line, as a short suffix.
//
// `pricedForCustomer` is set by resolve() only when the portal priced against
// the asking customer's own account. Without it the rate on the line is
// somebody else's, and only the MRP is repeatable.
// ONE MATCH IS NOT THE SAME AS THE RIGHT MATCH.
//
// 23 Sep: a customer asked for "Cartend wiper blade 17 number". The catalogue
// search drops words it cannot use, so the portal was asked for "wiper blade
// 17 number", returned exactly one row — WIPER BLADE 17 | FORTUNER / ENDEAVOUR
// / GLOSTER / XUV700 — and the bot quoted it. Right size, wrong brand, and
// "only one match" was doing all the work. Cartrends' own CTWBSI26P-16 Inch
// was sitting in the same catalogue.
//
// So a single hit is trusted only when it does not CONTRADICT the question:
// every distinctive word the customer used has to appear somewhere in the
// part's name or number. Words that describe nothing on their own are
// ignored, and so are the sizes, which the search already matched on.
//
// The Hindi half of that list earns its keep twice over now that a remembered
// PHRASE is matched against a new question (core/parts/aliases): both sides are
// somebody's own sentence, so the words they wrap a part in decide nothing and
// must not be read as a contradiction. "clutch plate chahiye swift KE LIYE"
// against "swift ka clutch plate chahiye" was refused on the word "liye" — the
// same part, the same car, sent back to a person over a postposition.
//
// How many, and in what packaging — "5 set", "1 pair", "2 box" — name nothing
// either. "Cartend ka Horan 5 SET" against a remembered "cartend horn" was
// refused on the word "set", which is a unit of counting, not a part.
const MATCH_FILLER =
  /^(number|no|nos|pcs|pc|piece|pieces|qty|quantity|set|sets|pair|pairs|pack|packet|box|dozen|ka|ki|ke|ko|hai|liye|lie|mujhe|hume|humein|bhai|chahiye|chaiye|chahiyega|wala|wali|lena|leni|jaldi|urgent|batao|bata|new|old|latest|model|type|size|sizes|inch|inches|for|the|and|with|please|plz|sir|kitne|kitna|kitni|kya|kaun|kaunsi|milega|milegi|price|rate|mrp|cost|stock|available|avl|dena|bhejo|bhej|bhejna|bhejiye)$/i;

// Words that name the SAME thing. A customer writes "Maruti Suzuki"; the
// catalogue writes "MARUTI". Treating the missing half as a contradiction
// would send every Maruti question to a list.
const SYNONYMS = [['maruti', 'suzuki', 'msil']];

function synonymsOf(word) {
  for (const group of SYNONYMS) if (group.includes(word)) return group;
  return [word];
}

// The words in a message that actually name something. Exported because the
// phrase memory (core/parts/aliases) compares one customer's sentence against
// another's and needs the same idea of which words carry meaning.
function distinctiveWords(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w && w.length >= 3 && !MATCH_FILLER.test(w) && !/^\d+$/.test(w));
}

function matchTrustworthy(asked, row) {
  const words = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .split(' ')
      .filter(Boolean);

  const theirs = distinctiveWords(asked);
  if (!theirs.length) return true; // nothing distinctive was said; the size matched

  const have = new Set(words(String(row.name || '') + ' ' + String(row.partNo || '')));
  for (const w of theirs) {
    let found = false;
    for (const alias of synonymsOf(w)) {
      for (const h of have) {
        // "cartend" against "cartrends", "bottel" against "bottle": dealers
        // spell by ear, and the first four letters carry it.
        if (h === alias || (h.length >= 4 && alias.length >= 4 && h.slice(0, 4) === alias.slice(0, 4))) {
          found = true;
          break;
        }
      }
      if (found) break;
    }
    if (!found) return false;
  }
  return true;
}

function priceOf(line) {
  const money = (n) => 'Rs.' + Math.round(Number(n));
  const rate = Number(line.rate);
  const mrp = Number(line.mrp);
  if (line.pricedForCustomer && Number.isFinite(rate) && rate > 0) {
    // Their approved discount, shown as what it is: MRP, the % off, and the
    // price after it — GST included, as MRP includes it.
    const pct = Number(line.discountPercent);
    const gst = Number(line.taxPercent) > 0 ? `, incl. ${Number(line.taxPercent)}% GST` : '';
    if (Number.isFinite(mrp) && mrp > rate) {
      return pct > 0 ? ` — ${money(rate)} (MRP ${money(mrp)} - ${pct}% discount${gst})` : ` — ${money(rate)} (MRP ${money(mrp)})`;
    }
    return ` — ${money(rate)}`;
  }
  if (Number.isFinite(mrp) && mrp > 0) return ` — MRP ${money(mrp)}`;
  return '';
}

function describe(line, chatId) {
  const t = lang.for(chatId);
  const name = displayName(line);
  if (line.source === 'unknown') return `${name} - ` + t('checking, will confirm shortly', 'check karke batata hoon');
  if (line.source === 'unidentified')
    return `${name} - ` + t('confirming the exact part, will get back to you', 'exact part confirm karke batata hoon');
  // Founder's rule for a not-in-stock item: never say no, say when.
  if (line.source === 'unavailable') return `${name} - on order, ETA = ${config.onOrderEtaDays} days`;
  // THE PRICE, WITHOUT BEING ASKED — but only a price that is theirs.
  //
  // The portal prices against an ACCOUNT. When it knows this customer it
  // prices for them, and that number is correct for them by definition. When
  // it does not (an unregistered number), the rate that comes back belongs to
  // whichever account the bot is logged in as — on 23 Sep that was 186.97
  // against an MRP of 799, a 76.6% discount belonging to account 3822 and to
  // nobody who was asking. MRP is public and is theirs to see; that account's
  // discount is not.
  const price = priceOf(line);
  if (line.partial)
    return (
      `${name} - ` +
      t(
        `part now${price}, rest ETA = ${config.onOrderEtaDays} days`,
        `kuch abhi${price}, baaki ETA = ${config.onOrderEtaDays} days`,
      )
    );
  return `${name} - ` + t(`available${price}`, `hai${price}`);
}

module.exports = {
  groupedPart,
  priceOf,
  matchTrustworthy,
  distinctiveWords,
  synonymsOf,
  resolve,
  resolveOne,
  describe,
  displayName,
  byName,
  isNameQuery,
  sameItem,
  normPart,
  looksLikePartNumber,
  extractPartNo,
  catalogNames,
};
