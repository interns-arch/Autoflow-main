'use strict';
// PDFs — an input the bot used to turn away.
//
// Both go out to a small Python script, because the libraries that do this
// well are Python ones and there is no honest JavaScript equivalent:
//
//   scripts/pdf/read_pdf.py   pdfplumber, and PyMuPDF for scanned pages
//
// Neither is required for the bot to work. If Python or a library is missing
// the call returns null and the caller falls back to what it did before —
// asking a person. That matters: this runs on a shared box, and a missing
// dependency must degrade the feature, not the bot.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../config');
const store = require('../store');

const PY_DIR = path.join(__dirname, '..', '..', 'scripts');

function python() {
  return process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
}

// Run a script and parse its JSON. Never throws, never rejects.
function run(script, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(
      python(),
      [script, ...args],
      { timeout: timeoutMs || 60000, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err && !stdout) {
          store.log('doc', `${path.basename(script)} failed: ${String((err && err.message) || err).slice(0, 120)}`);
          return resolve(null);
        }
        try {
          const out = JSON.parse(String(stdout || '').trim());
          if (out && out.error) {
            store.log('doc', `${path.basename(script)}: ${out.error}`);
            return resolve(null);
          }
          resolve(out);
        } catch (e) {
          store.log(
            'doc',
            `${path.basename(script)}: unreadable output ${String(stdout || stderr || '').slice(0, 100)}`
          );
          resolve(null);
        }
      }
    );
  });
}

function tmpFile(base64, ext) {
  const p = path.join(os.tmpdir(), `autoflow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
  fs.writeFileSync(p, Buffer.from(base64, 'base64'));
  return p;
}

// ------------------------------------------------------------------- PDF
//
// Returns { text, tables, images, how } or null.
//   how === 'text'   the PDF really had text; `text` and `tables` are filled
//   how === 'render' it was a scan; `images` are PNG paths for the vision path
async function readPdf(base64) {
  if (!config.documents.pdf) return null;
  const file = tmpFile(base64, 'pdf');
  const dir = file.replace(/\.pdf$/, '-pages');
  try {
    const out = await run(path.join(PY_DIR, 'pdf', 'read_pdf.py'), [file, '--render-dir', dir], 90000);
    if (!out) return null;
    store.log('doc', `pdf: ${out.pages || '?'} page(s), read by ${out.how}, ${(out.text || '').length} chars`);
    return out;
  } finally {
    try { fs.unlinkSync(file); } catch (_) {}
  }
}

// Tidy up the PNGs a scanned PDF left behind.
function cleanupRendered(images) {
  for (const p of images || []) {
    try { fs.unlinkSync(p); } catch (_) {}
  }
  if (images && images.length) {
    try { fs.rmdirSync(path.dirname(images[0])); } catch (_) {}
  }
}

// A table is worth more than its flat text: the part number and the quantity
// stay on the same row. Turned into the lines the order parser already reads.
function tableLines(tables) {
  const out = [];
  for (const rows of tables || []) {
    for (const row of rows) {
      const line = row.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      if (line) out.push(line);
    }
  }
  return out.join('\n');
}

// Our OWN paperwork, coming back at us. Customers forward the sales order, the
// invoice, the delivery challan and the ledger constantly — to ask about them,
// never to order from them. Read as an order list they are a disaster: a GSTIN
// becomes a part number and its digits become a quantity ("06CIYPK2053H1ZZ
// x22001"), which is exactly what every PDF in the Kalra export produced
// before this.
const OUR_PAPERWORK =
  /(tax\s*invoice|gst\s*invoice|credit\s*note|debit\s*note|delivery\s*challan|sales\s*order|purchase\s*order|ledger|statement of account|e-?invoice|irn|hsn|[cis]gst|authorised signatory)/i;

function isOurPaperwork(text) {
  return OUR_PAPERWORK.test(String(text || ''));
}

// PDF -> order lines, or []. All the judgement lives here so the bot does not
// have to hold it.
function orderLinesFrom(doc) {
  if (!doc) return [];
  const ai = require('./ai');
  const text = String(doc.text || '');
  if (isOurPaperwork(text)) {
    store.log('doc', 'pdf is paperwork (invoice / SO / challan / ledger) — not an order');
    return [];
  }
  // Table rows first: they keep a part number and its quantity on one line.
  const rows = tableLines(doc.tables);
  let lines = ai.parseLinesBlock(rows || text) || [];
  if (!lines.length && rows) lines = ai.parseLinesBlock(text) || [];
  // The same sanity filter a photo goes through.
  return ai._internals.sanitizeOrderLines(lines, text);
}

module.exports = { readPdf, tableLines, cleanupRendered, orderLinesFrom, isOurPaperwork };
