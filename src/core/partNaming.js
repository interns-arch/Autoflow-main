'use strict';
// Standard product names for new inventory.
//
// Every part the team puts in the catalogue is named one way. The reference
// list, partNameExamples.txt (482 Maruti parts), is that style written down:
//
//   Shocker| Rear | Maruti Alto (old, 2000-2012) | All Variants | #41800M79G00
//   Shocker | Left Side | Maruti XL6 | All Variants | #41602M51U00
//   Air Filter|  | Maruti S-Presso | Petrol | #13780M62B00      (no position: blank)
//
// On the portal that one string goes into BOTH part_name and attribute_desc —
// every hand-made part read on 11 Sep carries the two identical.
//
// The request mail only says "windshield", and on 11 Sep that bare word went
// into the portal for two Skoda parts. The founder's rule since: the name must
// be exactly in the list's format, and nothing wrong may be created. So:
//
//   1. list       the part number is in the list: its name, verbatim
//   2. confirmed  a person already OK'd or corrected this part's name on
//                 WhatsApp (core/partApprovals): that name
//   3. learned    a Maruti number whose family (41800 = rear shocker) and model
//                 code (M79G = old Alto) are in the list, AND every sibling
//                 agrees on the car: the siblings' name, in their exact format
//   4. ai         the model, searching the web for the part number, in the
//                 team's rules
//   5. basic      what the mail says, in the same shape
//
// Created without asking (safeToCreate): 1 and 2 always, and 3 only in a
// family the list itself proves — hide each member, name it from the rest,
// and every one comes out character-for-character (11 Sep: rear shockers
// 114/114, left-side 144/144; front-right 110/117 and air filters 8/17 do
// not). Anything else is asked on WhatsApp first ("naam ye rakhun?"), and the
// answer is remembered, so the next part like it is named right.
const fs = require('fs');
const path = require('path');
const config = require('../config');
const store = require('../store');

const EXAMPLES_FILE = path.join(__dirname, 'partNameExamples.txt');
const SEP = ' | ';

// Names a person confirmed or corrected on WhatsApp. In the shared directory:
// the sales bot, which receives the answers, writes them, and the data-entry
// container, which names new parts, reads them.
function learnedFile() {
  return path.join(config.sharedDir, 'part-names-learned.txt');
}

// "Shocker| Rear | Maruti Alto (old, 2000-2012) | All Variants | #41800M79G00"
function parseLine(line) {
  const sec = String(line || '')
    .split('|')
    .map((s) => s.replace(/\s+/g, ' ').trim());
  if (sec.length !== 5) return null;
  const m = sec[4].match(/^#([A-Za-z0-9-]+)$/);
  if (!m || !sec[0] || !sec[2]) return null;
  return { line: String(line).trim(), part: sec[0], position: sec[1], vehicle: sec[2], variant: sec[3], partNo: m[1] };
}

// The list writes the first separator two ways — "Shocker| Rear" and
// "Air Filter|  |" for some families, "Shocker | Left Side" for others — and a
// new part is written the way its family is.
function firstSep(line) {
  return /^[^|]*\s\|/.test(line) ? ' | ' : '| ';
}
function render(sec, sep0) {
  return sec[0] + sep0 + sec[1] + SEP + sec[2] + SEP + sec[3] + SEP + sec[4];
}

// Maruti numbers: a 5-digit family, then the model code.
//   41800M79G00 -> { base: '41800', code: 'M79G' }    (M + model + series)
//   13780M824A0 -> { base: '13780', code: 'M824' }
//   4180052A70  -> { base: '41800', code: '52A' }     (older numbering, no M)
function marutiParts(partNo) {
  const m = String(partNo || '')
    .toUpperCase()
    .match(/^(\d{5})([A-Z0-9]{5,9})$/);
  if (!m) return null;
  const rest = m[2];
  return { base: m[1], code: rest[0] === 'M' ? rest.slice(0, 4) : rest.slice(0, 3) };
}

function push(map, key, e) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(e);
}

// Everything the examples teach. Newest wins for a part number, so a name
// confirmed on WhatsApp replaces the list's.
function learn(examples) {
  const unique = [...new Map(examples.map((e) => [e.partNo.toUpperCase(), e])).values()];
  const b = { examples: unique, byNo: new Map(), famEx: new Map(), famCodeEx: new Map(), codeEx: new Map() };
  for (const e of unique) {
    b.byNo.set(e.partNo.toUpperCase(), e);
    const mp = marutiParts(e.partNo);
    if (!mp) continue;
    push(b.famEx, mp.base, e);
    push(b.famCodeEx, mp.base + '/' + mp.code, e);
    push(b.codeEx, mp.code, e);
  }
  return b;
}

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/);
  } catch (_) {
    return null;
  }
}
function mtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch (_) {
    return 0;
  }
}

// The list plus every confirmed name, rebuilt when the confirmed file changes
// (the other container may have written to it).
let cached = null;
function book() {
  const seen = mtime(learnedFile());
  if (cached && (cached.pinned || cached.learnedAt === seen)) return cached;
  const list = readLines(EXAMPLES_FILE);
  if (!list) store.log('naming', 'reference list not readable: ' + EXAMPLES_FILE);
  const confirmed = (readLines(learnedFile()) || [])
    .map(parseLine)
    .filter(Boolean)
    .map((e) => ({ ...e, confirmed: true }));
  cached = learn([...(list || []).map(parseLine).filter(Boolean), ...confirmed]);
  cached.trusted = trustedFamilies(cached.examples);
  cached.learnedAt = seen;
  return cached;
}

// The one value every entry agrees on, or null when they differ.
function agreed(list, pick) {
  const seen = new Set(list.map((e) => JSON.stringify(pick(e))));
  return seen.size === 1 ? JSON.parse([...seen][0]) : null;
}

// A sibling in the same family with the same model code is the same part on
// the same car: 41800M79G99 is a rear shocker for the old Alto, like G00-G60.
// Only when they ALL say so. One model code can cover two cars (M792 is an
// Omni filter in 13780M79250 and an 800/Alto one in 13780M79201).
function fromFamily(partNo, b) {
  const mp = marutiParts(partNo);
  if (!mp) return null;
  const fam = b.famEx.get(mp.base) || [];
  const sibs = b.famCodeEx.get(mp.base + '/' + mp.code) || [];
  if (!fam.length || !sibs.length) return null;
  const kind = agreed(fam, (e) => [e.part, e.position]);
  const car = agreed(sibs, (e) => [e.vehicle, e.variant]);
  if (!kind || !car) return null;
  const sep0 = agreed(fam, (e) => firstSep(e.line)) || SEP;
  return render([kind[0], kind[1], car[0], car[1], '#' + partNo], sep0);
}

// Families where the examples themselves prove the sibling rule: hide each
// member in turn, name it from the rest, and every member that can be named
// must come out exactly as written — and at least ten of them.
function trustedFamilies(examples) {
  const score = new Map();
  for (const e of examples) {
    const mp = marutiParts(e.partNo);
    if (!mp) continue;
    const got = fromFamily(e.partNo, learn(examples.filter((x) => x !== e)));
    if (!got) continue;
    const s = score.get(mp.base) || { n: 0, ok: 0 };
    s.n++;
    if (got === render([e.part, e.position, e.vehicle, e.variant, '#' + e.partNo], firstSep(e.line))) s.ok++;
    score.set(mp.base, s);
  }
  return new Set([...score].filter(([, s]) => s.n >= 10 && s.ok === s.n).map(([base]) => base));
}

function titleCase(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(^|[\s/(-])([a-z])/g, (x, a, c) => a + c.toUpperCase());
}

function basicName({ partNo, partName, brand }) {
  return [titleCase(partName) || 'Part', '', titleCase(brand), '', '#' + partNo].join(SEP);
}

// A model answer is accepted only in the house shape, ending in exactly this
// part number. Four sections means it dropped a blank one: the position when
// the second section already names the car, else the variant.
function tidy(raw, partNo, brand) {
  const sec = String(raw || '')
    .replace(/[\r\n]+/g, ' ')
    .split('|')
    .map((s) => s.replace(/\s+/g, ' ').trim());
  if (sec.length === 4) {
    const make = String(brand || '').trim().toLowerCase();
    const carFirst = /^(maruti|suzuki|hyundai|tata|mahindra|honda|toyota|skoda|vw|volkswagen|kia|renault|nissan|ford|mg)\b/i.test(sec[1]) || (make && sec[1].toLowerCase().startsWith(make));
    sec.splice(carFirst ? 1 : 3, 0, '');
  }
  if (sec.length !== 5 || !sec[0] || !sec[2]) return null;
  if (sec[4].replace(/^#/, '').toUpperCase() !== String(partNo).toUpperCase()) return null;
  if (sec.join('').length > 220) return null;
  sec[4] = '#' + partNo; // exactly as it was given
  return sec.join(SEP);
}

// A name typed by a person on WhatsApp: the same sections, the part number
// added when they left it off.
function fromPerson(text, partNo, brand) {
  const sec = String(text || '')
    .replace(/[\r\n]+/g, ' ')
    .split('|')
    .map((s) => s.replace(/\s+/g, ' ').trim());
  if (sec[sec.length - 1].replace(/^#/, '').toUpperCase() !== String(partNo).toUpperCase()) sec.push('#' + partNo);
  return tidy(sec.join(SEP), partNo, brand);
}

// Examples that teach the most about THIS part: its own family and model
// code, then parts whose numbers start the same way (confirmed Skoda names
// teach the next Skoda part), then one of each shape.
function closest(partNo, b, n = 14) {
  const picks = [];
  const add = (e) => {
    if (e && !picks.includes(e) && picks.length < n) picks.push(e);
  };
  const mp = marutiParts(partNo);
  if (mp) {
    (b.famCodeEx.get(mp.base + '/' + mp.code) || []).slice(0, 4).forEach(add);
    (b.codeEx.get(mp.code) || []).slice(0, 4).forEach(add);
    (b.famEx.get(mp.base) || []).slice(0, 3).forEach(add);
  }
  const pn = String(partNo).toUpperCase();
  const shared = (e) => {
    const q = e.partNo.toUpperCase();
    let i = 0;
    while (i < q.length && i < pn.length && q[i] === pn[i]) i++;
    return i;
  };
  b.examples
    .map((e) => [shared(e), e])
    .filter(([k]) => k >= 3)
    .sort((x, y) => y[0] - x[0])
    .slice(0, 4)
    .forEach(([, e]) => add(e));
  for (const k of ['41800M79G00', '41601M68P01', '41602M72R00', '13780M62B00', '13780M824A0', '13780M53T50']) add(b.byNo.get(k));
  return picks;
}

// The team's naming rules, as they wrote them, in the shape the catalogue
// actually stores (five sections, a blank one kept blank), plus what the desk
// used to look up by hand from the part number alone.
const RULES = [
  'You are an automotive spare-parts product naming assistant for an Indian parts distributor.',
  'Convert the part information you are given into the catalogue\'s standardized product name:',
  '',
  '[PART NAME] | [POSITION/SIDE] | [VEHICLE MAKE] [VEHICLE MODEL/GENERATION] | [VARIANT/FUEL] | #[PART NUMBER]',
  '',
  'Rules:',
  '1. Use "|" as the only separator. Always five sections; leave a section empty when it does not apply (e.g. "Air Filter |  | Maruti S-Presso | Petrol | #13780M62B00").',
  '2. Keep the name concise and human-readable.',
  '3. Use the official/common vehicle make and model names.',
  '4. If a vehicle has different generations, years, or old/new models, mention them in brackets, e.g. "Maruti Alto (old, 2000-2012)".',
  '5. Preserve important generation/year/engine information.',
  '6. If the part has a position (Front, Rear, Left Side, Front Right Side...), include it.',
  '7. If the part fits all variants, write "All Variants". If the fuel is known, write "Petrol", "Diesel", "CNG", "Petrol / CNG".',
  '8. When several vehicles share the part, list them in the vehicle section separated by " / ", as the examples do.',
  '9. Do not invent missing information. If you cannot establish which vehicle the part fits, put only the make in the vehicle section and set vehicle_known to false.',
  '10. The last section is "#" followed by the part number exactly as provided - never change it.',
  '11. No marketing words, specifications or sentences. Consistent capitalization (Title Case part names).',
  '12. Follow the style of the catalogue examples you are given; do not copy their vehicles unless they really apply.',
  '',
  'Look the part number up on the web when you can: OEM catalogues and parts sellers that list this exact number tell you the vehicle, generation, position and fuel. Trust a source only if it shows this exact part number.',
  'Also give the 8-digit Indian HSN code for this kind of part if you are confident of it, else null.',
  '',
  'Answer with JSON only: {"name": "<the standardized name>", "vehicle_known": true|false, "hsn_code": "<8 digits>"|null, "evidence": "<the page or reason the vehicle comes from>"|null}',
].join('\n');

async function askModel(fields, b) {
  const ai = require('./ai');
  const examples = closest(fields.partNo, b)
    .map((e) => e.line)
    .join('\n');
  const user = [
    'Part number: ' + fields.partNo,
    'Part name (as written in the request): ' + (fields.partName || '-'),
    'Brand: ' + (fields.brand || '-'),
    fields.hsnCode ? 'HSN code: ' + fields.hsnCode : null,
    '',
    'Catalogue examples (this is the exact style):',
    examples,
  ]
    .filter((l) => l !== null)
    .join('\n');
  let out;
  try {
    out = await ai._claudeWeb(RULES, user);
  } catch (e) {
    // Web search can be switched off for the account, or time out; the
    // model's own knowledge and the examples still make a useful suggestion.
    store.log('naming', 'web research failed for ' + fields.partNo + ', asking without it: ' + String((e && e.message) || e).slice(0, 120));
    out = await ai._claude(RULES, user);
  }
  let name = tidy(out && out.name, fields.partNo, fields.brand);
  if (!name) {
    store.log('naming', 'model answer rejected for ' + fields.partNo + ': ' + String(out && out.name).slice(0, 140));
    return null;
  }
  // No car, no variant: "All Variants" of an unknown car is a guess too.
  const unsure = out.vehicle_known === false;
  if (unsure) {
    const sec = name.split('|').map((s) => s.trim());
    sec[3] = '';
    name = sec.join(SEP);
  }
  const hsn = String((out && out.hsn_code) || '').replace(/\s/g, '');
  // Always asked first, sure or not: tried on parts hidden from the list
  // (11 Sep), it named the Jimny filter 13780M78R10 "Maruti Eeco" with full
  // confidence, reasoning from the Eeco's M78 code.
  return {
    name,
    source: 'ai',
    check: true,
    unsure,
    hsn: /^\d{8}$/.test(hsn) ? hsn : null,
    evidence: out.evidence ? String(out.evidence).slice(0, 200) : null,
  };
}

// fields: { partNo, partName, brand, hsnCode } -> { name, source, check, hsn? }
async function nameFor(fields, { useModel = true } = {}) {
  // Upper case, as the portal stores part_no, so the name's "#..." matches it.
  const partNo = String((fields && fields.partNo) || '').trim().toUpperCase();
  const f = { ...fields, partNo };
  const b = book();

  const hit = b.byNo.get(partNo);
  if (hit) return { name: hit.line, source: hit.confirmed ? 'confirmed' : 'list', check: false };

  const learned = fromFamily(partNo, b);
  if (learned) {
    // A family the list does not prove (front-right shockers, air filters):
    // the siblings' name is the best suggestion there, but a person decides.
    const proven = Boolean(b.trusted && b.trusted.has(marutiParts(partNo).base));
    return { name: learned, source: 'learned', check: !proven };
  }

  if (useModel && require('./ai').modelAvailable()) {
    try {
      const r = await askModel(f, b);
      if (r) return r;
    } catch (e) {
      store.log('naming', 'model call failed for ' + partNo + ': ' + String((e && e.message) || e).slice(0, 120));
    }
  }
  return { name: basicName(f), source: 'basic', check: true };
}

// May this name go into the live catalogue without asking? Only the list's
// own name, one a person confirmed, or its siblings' in a family the list
// proves.
function safeToCreate(nm) {
  return Boolean(nm && (nm.source === 'list' || nm.source === 'confirmed' || (nm.source === 'learned' && !nm.check)));
}

// A name a person OK'd or corrected on WhatsApp. One line per part, newest
// wins; both containers see it on their next name.
function remember(name) {
  const e = parseLine(name);
  if (!e) return false;
  const f = learnedFile();
  const lines = (readLines(f) || []).filter((l) => {
    const x = parseLine(l);
    return x && x.partNo.toUpperCase() !== e.partNo.toUpperCase();
  });
  lines.push(e.line);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f + '.tmp', lines.join('\n') + '\n');
  fs.renameSync(f + '.tmp', f);
  cached = null;
  store.log('naming', 'remembered ' + e.partNo + ': ' + e.line);
  return true;
}

module.exports = {
  nameFor,
  safeToCreate,
  remember,
  fromPerson,
  // exported for tests
  _internals: {
    parseLine,
    firstSep,
    render,
    marutiParts,
    learn,
    fromFamily,
    trustedFamilies,
    tidy,
    closest,
    basicName,
    book,
    learnedFile,
    RULES,
    // Tests only: learn from these parsed examples instead of the files (null = the files).
    useExamples(examples) {
      cached = examples ? learn(examples) : null;
      if (cached) {
        cached.trusted = trustedFamilies(cached.examples);
        cached.pinned = true;
      }
    },
  },
};
