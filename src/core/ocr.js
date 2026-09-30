'use strict';
// READING A PHOTO WITHOUT GEMINI (founder, 30 Sep: "bot unable to take parts
// from photo"). Live, Shubham Maurya: a stock-sheet screenshot and a Maruti box
// label both came back "Is photo se part number nahi padh paya" - Gemini had
// answered 402, its prepaid credit used up, and there was nothing behind it.
//
// This is the fallback, and only that: Gemini reads photos far better (hand
// writing, a torn label, a quantity in the caption). When it cannot answer at
// all, the words on the photo are read here (tesseract, on this machine, no
// key, no money) and handed to the same part-number parser a typed list goes
// through. The box is short of memory (the Dockerfile says why no recogniser
// was installed before), so: one worker, started on the first photo that needs
// it, one photo at a time, and shut down after a minute with nothing to read.
const fs = require('fs');
const path = require('path');
const config = require('../config');
const store = require('../store');

const IDLE_MS = 60 * 1000;
const TIMEOUT_MS = Number(process.env.OCR_TIMEOUT_MS || 45000);
let worker = null;
let starting = null;
let idle = null;
let queue = Promise.resolve();

function enabled() {
  return String(process.env.OCR_FALLBACK || 'true').toLowerCase() !== 'false';
}

async function getWorker() {
  if (worker) return worker;
  if (starting) return starting;
  starting = (async () => {
    const { createWorker } = require('tesseract.js');
    // The language data is fetched once and kept with the bot's data, so a
    // rebuild does not fetch it again.
    const cachePath = path.join(config.dataDir, 'tessdata');
    fs.mkdirSync(cachePath, { recursive: true });
    const w = await createWorker('eng', 1, { cachePath, logger: () => {} });
    worker = w;
    store.log('ocr', 'text reader started (fallback for photos Gemini cannot read)');
    return w;
  })();
  try {
    return await starting;
  } finally {
    starting = null;
  }
}

function scheduleStop() {
  if (idle) clearTimeout(idle);
  idle = setTimeout(async () => {
    const w = worker;
    worker = null;
    if (w) await w.terminate().catch(() => {});
  }, IDLE_MS);
  if (idle.unref) idle.unref();
}

// -> the text on the photo, or null.
async function readText(buffer) {
  if (!enabled() || !buffer || !buffer.length) return null;
  const run = queue.then(async () => {
    const w = await getWorker();
    const started = Date.now();
    const res = await Promise.race([w.recognize(buffer), new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), TIMEOUT_MS))]);
    const text = String((res && res.data && res.data.text) || '').trim();
    store.log('ocr', `photo read locally in ${Date.now() - started} ms: ${text.length} character(s)`);
    return text || null;
  });
  queue = run.catch(() => {});
  try {
    return await run;
  } catch (e) {
    store.log('ocr', 'local photo reading failed: ' + String((e && e.message) || e).slice(0, 100));
    return null;
  } finally {
    scheduleStop();
  }
}

// THE TEXT, AS ORDER LINES. A table's STOCK column is not a quantity
// ("13780M72R00 Air Filter Maruti 144" is 144 in stock, not 144 wanted), so
// with a stock column and no qty column every line is one piece, asked.
// What a recogniser gets wrong looks like a part number too: a batch code
// ("2509M0620001549p3pp"), a pincode run into a word ("DELHI410070"), a
// half-read line in lower case ("13700m7280p"), a phone number. A part number
// printed on a label or typed in a sheet is capitals and digits.
function plausible(tok) {
  const s = String(tok || '');
  if (s.length < 5 || s.length > 14) return false;
  if (/[a-z]/.test(s)) return false;
  if ((s.match(/\d/g) || []).length < 3) return false;
  if (/^[A-Z]{4,}\d+$/.test(s)) return false;
  if (/^(?:91)?[6-9]\d{9}$/.test(s) || /^1800\d+$/.test(s)) return false;
  return true;
}
const NOT_A_PART_LINE = /\b(batch|mrp|mfd|mfg|tel|e-?mail|customer\s*care|gst|invoice|pin)\b/i;

function linesFrom(text) {
  const ai = require('./ai');
  const t = ai._internals.joinSpacedPartNumbers(String(text || ''));
  // A table's STOCK column is not a quantity; with one and no qty column,
  // every line is one piece, asked.
  const stockSheet = /\b(stock|available|avl|inventory)\b/i.test(t) && !/\b(qty|quantity|order\s*qty|req)\b/i.test(t);
  const found = [];
  const seen = new Set();
  for (const raw of t.split(/\n/)) {
    const line = raw.trim();
    if (!line || NOT_A_PART_LINE.test(line)) continue;
    for (const tok of line.split(/[\s|,;:]+/)) {
      const pn = ai.partNumberIn(tok);
      if (!pn || !plausible(pn)) continue;
      const k = pn.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (seen.has(k)) continue;
      seen.add(k);
      // "13780M72R00 Air Filter Maruti 144": a quantity only when the sheet
      // has no stock column, and only a small number standing at the end.
      const tail = line.match(/(?:^|\s)(\d{1,3})\s*(?:pcs?|nos?|qty)?\s*[^\w]*$/i);
      found.push({ item: pn, qty: !stockSheet && tail && !line.endsWith(pn) ? Number(tail[1]) : null });
    }
  }
  // A label: "QTY 1" is the pieces in the box - one part, that many.
  const labelQty = found.length === 1 ? (t.match(/\b[QO0]TY\s*[:.]?\s*(\d{1,4})\b/i) || [])[1] : null;
  return found.map((l) => {
    if (labelQty && !stockSheet) return { item: l.item, qty: Number(labelQty), price: null };
    if (l.qty && l.qty > 0 && l.qty <= 999) return { item: l.item, qty: l.qty, price: null };
    return { item: l.item, qty: 1, price: null, qtyMissing: true };
  });
}

// ONE CHARACTER MISREAD. The recogniser reads 5 as S, 0 as D or O, 8 as B
// ("13780M82PS0" for 13780M82P50 on Shubham Maurya's sheet). A number the
// portal does not know is tried with each such swap, all in one lookup, and
// the one the portal knows is taken. A number it knows is never touched.
const LOOKALIKE = { S: '5', '5': 'S', D: '0', O: '0', '0': 'O', B: '8', '8': 'B', I: '1', L: '1', '1': 'I', Z: '2', '2': 'Z', G: '6', Q: '0' };
function variantsOf(pn) {
  const out = [];
  const s = String(pn).toUpperCase();
  for (let i = 0; i < s.length; i++) {
    const to = LOOKALIKE[s[i]];
    if (to) out.push(s.slice(0, i) + to + s.slice(i + 1));
  }
  return [...new Set(out)].filter((v) => v !== s).slice(0, 12);
}
async function fixMisreads(lines) {
  if (!lines.length) return lines;
  const portal = require('../integrations/dealerPortal');
  const unknown = (r) => !r || r.source === 'unidentified' || r.source === 'unknown';
  try {
    const first = await portal.analyze(lines.map((l) => ({ item: l.item, qty: 1 })), null);
    const bad = lines.map((l, i) => (unknown(first[i]) ? i : -1)).filter((i) => i >= 0);
    if (!bad.length) return lines;
    const tries = [];
    for (const i of bad) for (const v of variantsOf(lines[i].item)) tries.push({ i, v });
    if (!tries.length) return lines;
    const second = await portal.analyze(tries.map((x) => ({ item: x.v, qty: 1 })), null);
    const fixed = lines.map((l) => ({ ...l }));
    const done = new Set();
    tries.forEach((x, k) => {
      if (done.has(x.i) || unknown(second[k])) return;
      store.log('ocr', `read "${fixed[x.i].item}" as ${x.v} - the one the portal knows`);
      fixed[x.i].item = x.v;
      done.add(x.i);
    });
    return fixed;
  } catch (e) {
    store.log('ocr', 'misread check skipped: ' + String((e && e.message) || e).slice(0, 80));
    return lines;
  }
}

// -> order lines read off the photo, or null when nothing could be read.
async function orderLines(base64) {
  const text = await readText(Buffer.from(String(base64 || ''), 'base64'));
  if (!text) return null;
  const lines = await fixMisreads(linesFrom(text));
  store.log('ocr', `photo gave ${lines.length} part number(s) locally${lines.length ? ': ' + lines.map((l) => l.item + ' x' + l.qty).join(', ').slice(0, 160) : ''}`);
  return lines;
}

module.exports = { enabled, readText, linesFrom, orderLines, variantsOf, fixMisreads, _stop: async () => { if (worker) { const w = worker; worker = null; await w.terminate().catch(() => {}); } } };
