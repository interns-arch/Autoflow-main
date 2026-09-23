'use strict';
// Turning the AMBIGUOUS part mappings into families.
//
// "air filter" pointed at three different part numbers across the exports, and
// an alias either way would be wrong for two cars out of three. But the portal
// says what each of them actually is:
//
//   13780M76SA0  Air Filter| | Grand Vitara / Ertiga / XL6 / Baleno / Brezza / Fronx | Petrol / CNG
//   13780M72R00  Air Filter  Ciaz / Ertiga 2nd Gen / SCross / XL6 (1.5 K15) | Petrol / CNG
//   13780M82RA0  Air Filter| | Ciaz (2019+, 1.5 E15A DDiS) | Diesel
//
// so the three are one family with three variants, exactly like the wiper
// sizes — chosen by which car it is for instead of by how many inches.
//
// The words that choose are only the ones belonging to ONE variant. "Ertiga"
// fits the first two, so it decides nothing; "brezza", "scross" and "diesel"
// each decide. A question that names none of them gets shown the choice.
const store = require('../../store');
const knowledge = require('../knowledge');
const repository = require('./repository');

// "Air Filter| | Maruti Ciaz / Ertiga 2nd Gen | Petrol / CNG"
//   -> { what: 'air filter', side: '', models: [...], fuel: 'petrol / cng' }
function parsePortalName(name) {
  const parts = String(name || '')
    .split('|')
    .map((s) => s.trim())
    .filter((s, i) => s.length || i);
  const what = (parts[0] || '').toLowerCase().trim();
  // Two shapes appear: "Name| Side | Models | Fuel" and "Name| | Models | Fuel".
  // Lowercased before comparing, or "Petrol / CNG" never equals the `fuel` it
  // was just read into and the fuel ends up filed as a car model — which is
  // how "air filter scross" came back with nothing to choose on.
  const rest = parts.slice(1).map((s) => s.trim().toLowerCase());
  const side = rest.find((s) => /^(left|right)\s*side$/.test(s)) || '';
  const fuel = rest.find((s) => /^(petrol|diesel|cng)(\s*\/\s*(petrol|diesel|cng))*$/.test(s)) || '';
  const models = rest.filter((s) => s && s !== side && s !== fuel).join(' / ');
  return { what, side, fuel, models };
}

// Words in a portal name that could name a car or a side. Trim levels, engine
// codes and marketing words are not what a customer types.
const STOP = new Set([
  'maruti', 'suzuki', 'gen', '1st', '2nd', '3rd', '4th', 'petrol', 'diesel', 'cng', 'incl',
  'and', 'or', 'the', 'for', 'with', 'side', 'assembly', 'assy', 'verify', 'needs', 'catalogue',
  'photo', 'code', 'new', 'old', 'model', 'type', 'part', 'left', 'right',
]);

function tokensOf(parsed) {
  const out = new Set();
  const add = (s) => {
    for (const w of String(s || '')
      .toLowerCase()
      .replace(/\([^)]*\)/g, ' ')  // "(1.5 K15)" is an engine code, not a car
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')) {
      if (!w || w.length < 3 || STOP.has(w)) continue;
      if (/^\d+$/.test(w)) continue;
      out.add(w);
    }
  };
  add(parsed.models);
  // Some catalogue entries have no pipe after the part name, so the cars end
  // up inside it: "Air Filter Ciaz / Ertiga 2nd Gen / SCross / XL6 (1.5 K15)".
  // Reading that segment too costs nothing — "air" and "filter" are in every
  // variant of an air-filter family, so they cancel out and decide nothing.
  if (!parsed.models) add(parsed.what);
  if (parsed.side) out.add(parsed.side.replace(/\s*side$/, '')); // "left" / "right"
  if (parsed.fuel && /diesel/.test(parsed.fuel) && !/petrol/.test(parsed.fuel)) out.add('diesel');
  return out;
}

// Does the portal think this is the same KIND of thing the dealer called it?
//
// The exports contain mappings that evidence counting would happily bless and
// that are simply wrong: "clutch bearing" against a part the portal calls a
// Clutch Master Cylinder, "coolant bottel" against a Wiper Bottle. One shared
// significant word is a low bar, and it catches both.
function sig(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length >= 3 && !STOP.has(w));
}

// Same word, allowing for how dealers spell: "bottel"/"bottle",
// "fandar"/"fender", "assy"/"assembly".
function sameWord(a, b) {
  if (a === b) return true;
  const n = Math.min(a.length, b.length) <= 4 ? 3 : 4;
  return a.length >= n && b.length >= n && a.slice(0, n) === b.slice(0, n);
}

function namesAgree(phrase, portalName) {
  const a = sig(phrase);
  const b = sig(String(portalName || '').split('|')[0]); // the part's own name
  if (!a.length || !b.length) return false;

  // The HEAD NOUN has to agree, not merely some word.
  //
  // Matching on any shared word blessed "clutch bearing" against a part the
  // portal calls a Clutch Master Cylinder — they share "clutch", and a bearing
  // is not a master cylinder. What the dealer is naming is the last word:
  // bearing, plate, filter, coil.
  const head = a[a.length - 1];
  return b.some((w) => sameWord(head, w));
}

// The portal saying it does not know either. These appear verbatim in the
// catalogue: "VERIFY - code '82S' (needs Maruti catalogue / photo)". Building a
// variant on one means keying a family on the string "82s".
function portalIsUnsure(portalName) {
  return /\bverify\b|needs (maruti )?catalogue|\bunconfirmed\b/i.test(String(portalName || ''));
}

// -> { built, skipped, details[] }
async function buildFromMappings({ apply = false } = {}) {
  const rows = await repository.listMappings({ limit: 1000 });
  const byPhrase = new Map();
  for (const r of rows) {
    if (!byPhrase.has(r.normalized_phrase)) byPhrase.set(r.normalized_phrase, []);
    byPhrase.get(r.normalized_phrase).push(r);
  }

  const details = [];
  let built = 0;
  let skipped = 0;
  let review = 0;

  for (const [phrase, group] of byPhrase) {
    if (group.length < 2) continue; // one part number is an alias, not a family

    // Only parts the portal actually carries, and only where the portal's own
    // name agrees with what the dealer called it.
    const usable = group.filter(
      (r) => r.portal_verified && r.portal_name && !portalIsUnsure(r.portal_name) && namesAgree(phrase, r.portal_name),
    );
    const rejected = group.filter((r) => !usable.includes(r));

    if (usable.length < 2) {
      // THE MIDDLE CASE, and the one worth a person's time.
      //
      // The portal carries these parts and calls them something the dealer's
      // words do not obviously match: "bonnet kabza" against Bonnet Hinge,
      // "clutch wire" against Clutch Cable, "fandar" against Fender. Those
      // three are right — kabza IS a hinge — and "clutch bearing" against a
      // Clutch Master Cylinder is wrong, and nothing here can tell them apart.
      // So they are proposed, not decided.
      const carried = group.filter((r) => r.portal_verified && r.portal_name && !portalIsUnsure(r.portal_name));
      const isSynonymCase = carried.length >= 2 && usable.length < 2;
      skipped++;
      details.push({
        phrase,
        built: false,
        needsReview: isSynonymCase,
        reason: isSynonymCase
          ? 'the portal calls it something else — a person should say whether these are the same part'
          : rejected.length === group.length
            ? 'the portal does not carry these'
            : 'only one usable variant — not a family',
        rejected: (isSynonymCase ? carried : rejected).map((r) => ({
          partNo: r.resolved_part_no,
          portalName: r.portal_name,
        })),
      });
      continue;
    }

    const parsed = usable.map((r) => ({ row: r, p: parsePortalName(r.portal_name), tokens: tokensOf(parsePortalName(r.portal_name)) }));

    // A word only discriminates if exactly one variant has it.
    const counts = new Map();
    for (const v of parsed) for (const t of v.tokens) counts.set(t, (counts.get(t) || 0) + 1);

    // A WORD THE CUSTOMER ALREADY SAID CANNOT CHOOSE BETWEEN VARIANTS.
    //
    // "front shocker" carries "front", and the portal calls one of the two
    // "front right side". Keying on "front" meant every customer asking for a
    // front shocker was handed the RIGHT one — a silent fifty-fifty error on a
    // part that comes in pairs. The words that decide have to be words the
    // question adds, not words it already contains.
    const said = new Set(sig(phrase));

    const variants = parsed.map((v) => {
      const decides = [...v.tokens].filter((t) => counts.get(t) === 1 && !said.has(t));
      return {
        key: decides[0] || v.row.resolved_part_no,
        label: (v.p.side ? v.p.side + ' ' : '') + (v.p.models || v.p.what).slice(0, 60),
        partNo: v.row.resolved_part_no,
        match: decides,
      };
    });

    const decidable = variants.filter((v) => v.match.length).length;
    if (decidable < 2) {
      skipped++;
      details.push({
        phrase,
        built: false,
        reason: 'the portal names do not tell the variants apart',
        variants: variants.map((v) => ({ partNo: v.partNo, label: v.label })),
      });
      continue;
    }

    if (apply) {
      knowledge.learnFamily(phrase, variants, 'historical_chat');
      for (const v of parsed) await repository.setMappingStatus(v.row.id, 'approved', true);
      for (const r of rejected) await repository.setMappingStatus(r.id, 'rejected', false);
    }
    built++;
    details.push({
      phrase,
      built: true,
      variants: variants.map((v) => ({ partNo: v.partNo, decidesOn: v.match.slice(0, 6), label: v.label })),
      rejected: rejected.map((r) => ({ partNo: r.resolved_part_no, portalName: r.portal_name })),
    });
  }

  for (const d of details) if (d.needsReview) review++;
  if (apply) store.log('history', `built ${built} part family(ies) from historical mappings`);
  return { built, skipped, review, details };
}

module.exports = { buildFromMappings, parsePortalName, namesAgree, portalIsUnsure, tokensOf };
