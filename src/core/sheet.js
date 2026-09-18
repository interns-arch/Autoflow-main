'use strict';
// Order lists that arrive as a FILE.
//
// Customers forward whatever their own system spits out — "FORD PENDING LIST
// 1-09.xlsx", a CSV export, a pasted table. There is no agreed template and
// there never will be, so nothing here assumes one: the sheet is read as a
// grid of cells and the part/quantity columns are worked out from the data.
//
// Deliberately NOT a schema. A customer is not going to re-export their file
// because our parser wanted the header in row 1.
const XLSX = require('xlsx');
const availability = require('./availability');

const HEADER_PART = /(part|item|code|art\.?\s*no|p\/?n)/i;
// NOT "order": these files open with "Order No:", "Order Date:", "Order Ref:"
// in the very first column, which handed the quantity vote to the part column.
const HEADER_QTY = /(qty|q-ty|quantity|nos\b|pcs|pieces|ordered)/i;
// Header rows sit below however many lines of letterhead the customer's system
// prints, so looking only at the top few rows misses them entirely.
const HEADER_ROWS = 12;
// The description is what a storeman actually reads down the page; echoing it
// back is how the customer matches our answer to their own row at a glance.
const HEADER_DESC = /(descrip|description|item ?name|particular|nomenclature)/i;
// Money columns read exactly like quantities — small bare numbers — so a sheet
// listing parts and prices but no quantity will happily hand over "4500" as a
// quantity. Never let a priced column win the quantity vote.
const HEADER_PRICE = /(price|rate|mrp|value|cost|total|amt|taxable|gst)/i;
// A pending list is usually SEVERAL of the customer's own orders stacked in
// one sheet, each introduced by its own number ("ORDER NO 179"). Those numbers
// are how the customer tracks the goods and how the bill has to come back to
// them, so the boundary has to survive the parse.
const SECTION_RE = /^\s*(?:order|po|p\.o\.?|indent)\s*(?:no\.?|number|#)?\s*[:\-]?\s*([A-Za-z0-9\-\/]+)\s*$/i;

// A quantity cell: a small bare number, optionally with a unit. Rejects years,
// prices and phone numbers, which is why the cap is 5 digits and not more.
function readQty(v) {
  if (v == null) return null;
  const t = String(v).trim().toLowerCase().replace(/[,\s]/g, '');
  const m = t.match(/^(\d{1,5})(?:\.0+)?(?:pcs?|pc|nos?|no|box|set|pair|pise)?$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n > 0 && n <= 99999 ? n : null;
}

function cell(v) {
  return v == null ? '' : String(v).trim();
}

// Score a column by how many of its cells look like part numbers / quantities.
// The winning column is the one the data votes for, not the one a header claims
// — headers are frequently missing, merged, or two rows deep in these files.
function pickColumns(rows) {
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  let partCol = -1;
  let qtyCol = -1;
  let bestPart = 0;
  let bestQty = 0;
  const score = [];

  for (let c = 0; c < width; c++) {
    let parts = 0;
    let qtys = 0;
    let headerPart = false;
    let headerQty = false;
    let headerPrice = false;
    for (let r = 0; r < rows.length; r++) {
      const v = cell(rows[r][c]);
      if (!v) continue;
      if (r < HEADER_ROWS && HEADER_PART.test(v)) headerPart = true;
      if (r < HEADER_ROWS && HEADER_QTY.test(v)) headerQty = true;
      if (r < HEADER_ROWS && HEADER_PRICE.test(v) && !HEADER_QTY.test(v)) headerPrice = true;
      if (availability.looksLikePartNumber(v) && /[A-Za-z]/.test(v) && /\d/.test(v)) parts++;
      else if (readQty(v) != null) qtys++;
    }
    // A matching header is a strong hint but never the whole answer — and it
    // counts for nothing without data under it. "Item Name" over a column of
    // descriptions outscored the column actually holding the part numbers, and
    // the whole sheet came back empty.
    const partScore = parts > 0 ? parts + (headerPart ? 3 : 0) : 0;
    const qtyScore = headerPrice ? 0 : qtys + (headerQty ? 3 : 0);
    score[c] = { partScore, qtyScore };
    if (partScore > bestPart) {
      bestPart = partScore;
      partCol = c;
    }
  }
  // Quantity is chosen only AFTER the part column is known, and never from it.
  // Picking both in one pass and then discarding a collision threw away the
  // real quantity column: "Order No:" in column A scored as a quantity header,
  // won the vote, collided with the part column, and left the sheet with no
  // quantities at all.
  for (let c = 0; c < width; c++) {
    if (c === partCol) continue;
    if (score[c].qtyScore > bestQty) {
      bestQty = score[c].qtyScore;
      qtyCol = c;
    }
  }

  // The description column, and ONLY if the customer's file actually has one.
  // A column qualifies by carrying a description header, or by being plainly
  // prose (multi-word text). Anything weaker would invent a column they never
  // sent. Picked last, and never able to displace the part or quantity column.
  let descCol = -1;
  let bestDesc = 0;
  for (let c = 0; c < width; c++) {
    if (c === partCol || c === qtyCol) continue;
    let prose = 0;
    let header = false;
    for (let r = 0; r < rows.length; r++) {
      const v = cell(rows[r][c]);
      if (!v) continue;
      if (r < HEADER_ROWS && HEADER_DESC.test(v)) header = true;
      if (/[A-Za-z]{3,}\s+\S/.test(v) && readQty(v) == null) prose++;
    }
    const s = header || prose >= 2 ? prose + (header ? 5 : 0) : 0;
    if (s > bestDesc) {
      bestDesc = s;
      descCol = c;
    }
  }
  return { partCol, qtyCol, descCol };
}

// Buffer (xlsx/xls/csv) -> [{ item, qty }]
// Returns [] when the file is readable but holds no order — the caller must
// tell the customer that, rather than staying silent.
function parseOrderSheet(buffer) {
  let wb;
  try {
    wb = XLSX.read(buffer, { type: 'buffer' });
  } catch {
    return null; // not a spreadsheet we can open at all
  }
  const out = [];

  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, blankrows: false, defval: '' });
    if (!rows.length) continue;
    const { partCol, qtyCol, descCol } = pickColumns(rows);
    if (partCol < 0) continue;

    let ref = null;
    for (const row of rows) {
      // "ORDER NO 179" on a line of its own opens a new section. Everything
      // below it belongs to that order of the customer's until the next one.
      const first = cell(row[0]);
      if (first && !cell(row[1])) {
        const s = first.match(SECTION_RE);
        if (s) {
          ref = s[1];
          continue;
        }
      }
      // Inside the part-number column, spaces are printing, not meaning:
      // Ford writes "AE8G 6A785 BE" for AE8G6A785BE. Safe here because the
      // column has already been identified as the part column.
      const item = cell(row[partCol]).replace(/^([A-Za-z0-9]+(?:\s+[A-Za-z0-9]+)+)$/, (s) => s.replace(/\s+/g, ''));
      if (!item || HEADER_PART.test(item)) continue;
      if (!availability.looksLikePartNumber(item) || !/[A-Za-z]/.test(item) || !/\d/.test(item)) continue;

      // Quantity comes from the quantity column or not at all. Scanning the
      // rest of the row for "some small number" is how a price becomes an
      // order for 4500 engine mounts — a mistake worth more than the sale.
      const qty = qtyCol >= 0 ? readQty(row[qtyCol]) : null;

      // NOTHING is merged. The customer's file IS the order. Adding two rows
      // together — even the same part inside one order — invents a line they
      // never wrote and cannot check against their own copy. Every row comes
      // back as its own line, in the order they sent it.
      if (!availability.normPart(item)) continue;
      out.push({
        item,
        qty: qty || 1,
        qtyMissing: qty == null,
        ref,
        desc: descCol >= 0 ? cell(row[descCol]) : '',
        key: (ref || '') + '#' + out.length, // keeps identical rows apart in the cart
      });
    }
    if (out.length) break; // first sheet that actually holds an order wins
  }
  return out;
}

// Is this attachment worth trying to read as an order list?
function isSheet(mime, fileName) {
  const f = String(fileName || '').toLowerCase();
  const t = String(mime || '').toLowerCase();
  return (
    /\.(xlsx|xlsm|xls|csv|tsv)$/.test(f) ||
    /spreadsheet|excel|ms-excel|csv/.test(t)
  );
}

// Answer a spreadsheet order WITH a spreadsheet.
//
// A pending list is 70+ lines. As a chat message that is unreadable and
// impossible to check against the customer's own copy; as a file it drops
// straight into the sheet they already keep. Same rows, same order, same
// order numbers — with our answer added as columns beside theirs.
// Laid out the way the customer laid out theirs: the order number on its own
// line, its table beneath, blank rows, then the next order. A single flat
// table with an ORDER NO column would be correct and still unusable — they
// read these order by order, and that is how they file and pay them.
function statusOf(l) {
  const avail = l.available || 0;
  if (l.source === 'unavailable') return `On order, ETA = ${require('../config').onOrderEtaDays} days`;
  if (l.source === 'unknown' || l.source === 'unidentified') return 'Checking';
  if (avail < l.qty) return `only ${avail} available`;
  return 'Available';
}

function buildReplySheet(order) {
  // The description column only exists if the customer's own file had one. We
  // do not invent a column, and an empty one is just noise in their sheet.
  const withDesc = order.lines.some((l) => l.desc);
  const HEAD = withDesc
    ? ['S.NO.', 'PART NO.', 'DESCRIPTION', 'QTY', 'AVAILABLE NOW', 'STATUS']
    : ['S.NO.', 'PART NO.', 'QTY', 'AVAILABLE NOW', 'STATUS'];
  const groups = new Map();
  for (const l of order.lines) {
    const k = l.ref || '';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(l);
  }

  const rows = [];
  const merges = [];
  let first = true;
  for (const [ref, lines] of groups) {
    if (!first) rows.push([], [], []); // the gap between the customer's orders
    first = false;
    if (ref) {
      merges.push({ s: { r: rows.length, c: 0 }, e: { r: rows.length, c: HEAD.length - 1 } });
      rows.push([`ORDER NO ${ref}`]);
      rows.push([]);
    }
    rows.push(HEAD);
    lines.forEach((l, i) =>
      rows.push(
        withDesc
          ? [i + 1, availability.displayName(l), l.desc || '', l.qty, l.available || 0, statusOf(l)]
          : [i + 1, availability.displayName(l), l.qty, l.available || 0, statusOf(l)]
      )
    );
  }

  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = withDesc
    ? [{ wch: 7 }, { wch: 18 }, { wch: 32 }, { wch: 8 }, { wch: 15 }, { wch: 24 }]
    : [{ wch: 7 }, { wch: 18 }, { wch: 8 }, { wch: 15 }, { wch: 24 }];
  if (merges.length) ws['!merges'] = merges;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Availability');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { parseOrderSheet, isSheet, readQty, buildReplySheet };
