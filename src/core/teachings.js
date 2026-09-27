'use strict';
// WHAT A PERSON TOLD US, READ AS AN INSTRUCTION.
//
// The helper answers a part question in words, and those words are written
// for the BOT, not for the customer (founder, 22 Sep): "Whenever any customer
// ask for Wiper Blade for Cartrends then it has sizes. 12 INCHES PART NUMBER:
// CTWBSI26P-12INCH, 14 INCHES PART NUMBER: ...". Sent on as written, the
// customer read an instruction meant for us. Read, it says: the family
// "Cartrends wiper blade", eleven sizes, and the part number of each - which
// is learned, looked up on the portal, and answered from there.
//
// A model reads it when there is one; the shapes people actually type are
// read without one too, so this never depends on a model being up.
const store = require('../store');
const lang = require('./lang');

// "CTWBSI26P-16 Inch" is "CTWBSI26P-16INCH": the space is a typing habit.
function cleanPartNo(p) {
  return String(p || '')
    .trim()
    .replace(/[.,;:]+$/, '')
    .replace(/-\s*(\d+)\s+(inch(?:es)?|mm|cm)\b/i, (_, n, u) => '-' + n + u)
    .replace(/\s+/g, '')
    .toUpperCase();
}

// A token that could be a part number: letters AND digits, six or more.
const PN = /[A-Za-z0-9][A-Za-z0-9-]*\d[A-Za-z0-9-]*(?:\s+inch(?:es)?\b)?|[A-Za-z0-9-]*\d[A-Za-z0-9-]*[A-Za-z][A-Za-z0-9-]*(?:\s+inch(?:es)?\b)?/gi;
// A number and its unit is a size, not a part: "16 inch", "1L", "500ml".
const MEASURE = /^\d+(?:\.\d+)?(?:INCH|INCHES|IN|MM|CM|M|L|LTR|LITRE|LITER|ML|KG|GM|G|PCS|PC|NOS|V|W|AH)$/;
function partTokens(s) {
  return (String(s || '').match(PN) || [])
    .map(cleanPartNo)
    .filter((t) => t.length >= 6 && /[A-Z]/.test(t) && /\d/.test(t) && !MEASURE.test(t));
}

// Without a model. Reads "<label> PART NUMBER: <number>" pairs, and a single
// bare part number as the answer for the one part asked about.
function readPlain(text) {
  const s = String(text || '');
  const variants = [];
  // "12 INCHES PART NUMBER: CTWBSI26P-12INCH" / "16 inch - CTWBSI26P-16INCH"
  const pair = /(\d{1,3})\s*(?:"|inch(?:es)?|in\b|mm|cm|no\.?|number)?\s*(?:part\s*(?:no\.?|number)|p\/?n)?\s*[:=\-–]?\s*([A-Za-z0-9][A-Za-z0-9-]*\d[A-Za-z0-9-]*(?:\s+inch(?:es)?\b)?)/gi;
  for (const seg of s.split(/[,;\n]+/)) {
    if (!/part\s*(?:no|number)|p\/?n|[:=]/i.test(seg)) continue;
    pair.lastIndex = 0;
    const m = pair.exec(seg);
    if (!m) continue;
    const partNo = cleanPartNo(m[2]);
    if (partNo.length < 6 || !/[A-Z]/.test(partNo) || MEASURE.test(partNo)) continue;
    variants.push({ key: String(Number(m[1])), label: m[1] + (/(inch|")/i.test(seg) ? ' inch' : ''), partNo });
  }
  // "Whenever any customer ask for Wiper Blade for Cartrends then it has sizes"
  const subj =
    /\b(?:ask(?:s|ed)?|asks?\s+for|mange|maange|puche|pooche)\s+(?:for\s+)?(.+?)(?:\s+(?:then|to|toh|tab)\b|[.,:]|$)/i.exec(s) ||
    /^(.+?)\s*(?:[:\-–]|ke\s+sizes?|sizes?\b)/i.exec(s);
  const subject = subj ? subj[1].trim() : null;
  const all = [...new Set(partTokens(s))];
  return {
    subject: variants.length >= 2 ? subject : null,
    variants: variants.length >= 2 ? variants : [],
    partNo: variants.length < 2 && all.length === 1 ? all[0] : null,
    partNos: all,
  };
}

// With a model: the same shape, from whatever the person wrote.
async function readWithModel(text, asked) {
  const ai = require('./ai');
  if (!ai.modelAvailable()) return null;
  const system =
    'You read an instruction a parts-shop manager wrote to a WhatsApp sales bot, answering a customer who asked for a part the catalogue did not recognise. ' +
    'Return ONLY JSON: {"subject": string|null, "variants": [{"key": string, "label": string, "partNo": string}], "partNo": string|null, "customerReply": string|null}. ' +
    '"subject" is the product family the instruction is about, brand included (e.g. "Cartrends wiper blade"), only when several variants are listed. ' +
    '"variants" lists each variant with its distinguishing number as "key" (e.g. size "16"), a short "label" ("16 inch") and its part number exactly as written. ' +
    '"partNo" is the one part number that answers the customer\'s request when there is exactly one. ' +
    '"customerReply" is null when the answer is a part number or list of them; otherwise one or two short lines to send the customer, in the language of the request (Hinglish if Hindi), stating only what the customer needs to know - no internal remarks, no staff names.';
  try {
    const j = await ai._model(system, `Customer asked for: ${asked}\n\nManager's instruction:\n${text}`);
    if (!j || typeof j !== 'object') return null;
    const variants = (Array.isArray(j.variants) ? j.variants : [])
      .map((v) => ({ key: String(v.key || '').replace(/\D/g, '') || String(v.key || ''), label: String(v.label || v.key || ''), partNo: cleanPartNo(v.partNo) }))
      .filter((v) => v.key && v.partNo.length >= 5 && !MEASURE.test(v.partNo));
    return {
      subject: variants.length >= 2 ? j.subject || null : null,
      variants: variants.length >= 2 ? variants : [],
      partNo: j.partNo && !MEASURE.test(cleanPartNo(j.partNo)) ? cleanPartNo(j.partNo) : null,
      customerReply: j.customerReply ? String(j.customerReply).trim() : null,
      partNos: [...new Set([...variants.map((v) => v.partNo), ...(j.partNo ? [cleanPartNo(j.partNo)] : [])])],
    };
  } catch (e) {
    store.log('teach', 'model could not read the instruction: ' + String((e && e.message) || e).slice(0, 100));
    return null;
  }
}

// { subject, variants, partNo, partNos, customerReply? }
async function read(text, asked) {
  const plain = readPlain(text);
  // A list the plain reader already understood is not worth a model call.
  if (plain.variants.length >= 2) return plain;
  const model = await readWithModel(text, asked);
  if (model && (model.variants.length || model.partNo || model.customerReply)) return model;
  return plain;
}

// Words for the customer when the instruction carries no part number at all.
// Never the instruction itself: "isko bolo kal aayega" is not for them.
function plainCustomerReply(text, asked, chatId) {
  const t = lang.for(chatId);
  // Only a plain "not available", said briefly. Anything longer carries more
  // than that - "nahi hai abhi, kal aayega" - and is not ours to shorten.
  if (String(text).trim().split(/\s+/).length <= 5 && /\b(nahi|nhi|not available|no|discontinu\w*|band|nai)\b/i.test(text)) {
    return t(`Sorry, ${asked} is not available.`, `Sorry, ${asked} abhi available nahi hai.`);
  }
  return null;
}

// The portal's own spelling of each part number, and what it knows about
// it. "CTWBSI26P-16INCH" is "CTWBSI26P-16 Inch" there, and every other size
// has no space - so numbers are compared with spaces and dashes ignored, and
// searched by their stem (CTWBSI26P) once for the whole range.
// -> Map(normalised -> { partNo, name, available })
const normPn = (p) => String(p || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
async function onPortal(partNos) {
  const portal = require('../integrations/dealerPortal');
  const want = new Map((partNos || []).map((p) => [normPn(p), p]));
  const out = new Map();
  const stems = new Set();
  for (const p of want.values()) {
    const stem = String(p).split('-')[0];
    stems.add(stem.length >= 5 ? stem : p);
  }
  for (const q of [...stems, ...want.values()]) {
    if ([...want.keys()].every((k) => out.has(k))) break;
    try {
      const rows = ((await portal.searchByName(q, 60)) || {}).top || [];
      for (const r of rows) {
        const k = normPn(r.partNo);
        if (want.has(k) && !out.has(k)) out.set(k, { partNo: r.partNo, name: r.name, available: r.available });
      }
    } catch (e) {
      store.log('teach', 'portal search failed for ' + q + ': ' + String((e && e.message) || e).slice(0, 80));
    }
  }
  return out;
}

module.exports = { read, readPlain, cleanPartNo, plainCustomerReply, onPortal, normPn };
