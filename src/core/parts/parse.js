'use strict';
// Reading a catalogue export.
//
// The exact columns are not known in advance — "Name", "Item Name",
// "Part Name", "PartNo", "Part No.", "Item Code" all appear in exports from
// this kind of system — so the header is read rather than assumed, and a file
// that does not carry a part number and a name is refused with the header it
// actually had, instead of importing nonsense.
//
// The one format already known here is ClosingStock.csv (see
// scripts/import_closing_stock.js): a "Name" column that carries the part
// number inside it as "#CTWBSI26P-16", plus BalQty and MRP. Quantity and MRP
// are READ AND DISCARDED — they change hourly and belong to the portal.

// A CSV parser that survives quoted fields with commas and newlines in them,
// which part names have ("Bumper | Swift, Dzire | Front").
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = String(text || '').replace(/^﻿/, ''); // Excel writes a BOM
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ',' || c === '\t') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => String(f).trim()));
}

// THE SAME RULES, ONE CHUNK AT A TIME.
//
// parseCsv above holds the whole file as a string and every row as an array.
// A real catalogue export is 272,000 rows and 56 MB, and that is how the
// import died: "JavaScript heap out of memory", inside a container capped at
// 512 MB, having stored nothing at all.
//
// This is the identical tokenizer driven incrementally, so the file is read in
// pieces and rows are handed out as they complete. Memory stays flat whatever
// the catalogue's size. It matters beyond today: the catalogue is re-exported
// whenever prices or stock lines change, and an importer that only works on
// small files is one nobody can use twice.
//
// A quoted field may contain a newline, which is why this cannot be a
// line-by-line reader.
function rowReader() {
  let row = [];
  let field = '';
  let inQuotes = false;
  let first = true;

  const complete = (r) => r.some((f) => String(f).trim());

  return {
    // -> the rows that COMPLETED inside this chunk (often none, sometimes many)
    push(chunk) {
      const out = [];
      let s = String(chunk == null ? '' : chunk);
      if (first) {
        s = s.replace(/^﻿/, ''); // Excel writes a BOM
        first = false;
      }
      for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (inQuotes) {
          if (c === '"') {
            if (s[i + 1] === '"') {
              field += '"';
              i++;
            } else inQuotes = false;
          } else field += c;
          continue;
        }
        if (c === '"') inQuotes = true;
        else if (c === ',' || c === '\t') {
          row.push(field);
          field = '';
        } else if (c === '\n') {
          row.push(field);
          if (complete(row)) out.push(row);
          row = [];
          field = '';
        } else if (c !== '\r') field += c;
      }
      return out;
    },
    // Whatever the last line left behind, when the file did not end in a newline.
    end() {
      if (!field.length && !row.length) return [];
      row.push(field);
      const last = row;
      row = [];
      field = '';
      return complete(last) ? [last] : [];
    },
  };
}

const norm = (h) => String(h || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');

// header name -> what it is. First match wins, so the more specific spellings
// come first.
const COLUMNS = {
  partNo: ['partno', 'partnumber', 'partcode', 'itemcode', 'code', 'sku', 'mcode', 'partno1'],
  name: ['name', 'itemname', 'partname', 'description', 'itemdescription', 'productname'],
  brand: ['brand', 'make', 'manufacturer', 'company'],
  fitment: ['fitment', 'model', 'vehicle', 'application', 'car', 'suitablefor'],
  category: ['category', 'group', 'type', 'segment'],
};

function mapHeader(header) {
  const found = {};
  const seen = header.map(norm);
  for (const [field, names] of Object.entries(COLUMNS)) {
    for (const n of names) {
      const i = seen.indexOf(n);
      if (i >= 0) {
        found[field] = i;
        break;
      }
    }
  }
  return found;
}

// "Wiper Blade | 16 Inches | All Cars | All Variants | #CTWBSI26P-16 Inch"
// The catalogue writes the part number into the name after a #. When there is
// no part-number column, that is where it lives.
function partNoInName(name) {
  const m = /#\s*([A-Za-z0-9][A-Za-z0-9 .\/-]{3,})\s*$/.exec(String(name || ''));
  return m ? m[1].trim() : null;
}

function stripPartNo(name) {
  return String(name || '')
    .replace(/#\s*[A-Za-z0-9][A-Za-z0-9 .\/-]{3,}\s*$/, '')
    .replace(/\s*\|\s*$/, '')
    .trim();
}

const normPartNo = (p) => String(p || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// -> { rows: [{partNo, name, brand, fitment, category}], header, skipped }
// Never throws on a bad row: one malformed line must not lose the file.
function parseCatalogue(text) {
  const raw = parseCsv(text);
  if (!raw.length) return { rows: [], header: [], skipped: 0, error: 'the file is empty' };

  const header = raw[0].map((h) => String(h).trim());
  const col = mapHeader(header);

  if (col.partNo === undefined && col.name === undefined) {
    return {
      rows: [],
      header,
      skipped: raw.length - 1,
      error:
        'no part-number or name column found. Columns present: ' +
        header.join(', ') +
        '. Expected one of: ' +
        [...COLUMNS.partNo, ...COLUMNS.name].slice(0, 8).join(', '),
    };
  }

  const out = [];
  let skipped = 0;
  const seen = new Set();

  for (const r of raw.slice(1)) {
    const p = rowToPart(r, col);
    if (!p || seen.has(p.normPartNo)) {
      skipped++; // unusable, or the same part listed twice in one export
      continue;
    }
    seen.add(p.normPartNo);
    out.push(p);
  }
  return { rows: out, header, skipped };
}

// ONE ROW OF THE EXPORT -> one part, or null when it carries no usable part
// number. Shared by the in-memory reader above and the streaming one, so a
// 200-row file and a 272,000-row file cannot drift into reading the same
// columns differently.
function rowToPart(r, col) {
  const get = (i) => (i === undefined ? '' : String(r[i] == null ? '' : r[i]).trim());
  const rawName = get(col.name);
  let partNo = get(col.partNo);
  let name = rawName;

  // No part-number column: it is inside the name, after the #.
  if (!partNo && rawName) {
    const inName = partNoInName(rawName);
    if (inName) {
      partNo = inName;
      name = stripPartNo(rawName);
    }
  } else if (rawName) {
    name = stripPartNo(rawName);
  }

  if (!partNo || normPartNo(partNo).length < 3) return null;

  return {
    partNo,
    normPartNo: normPartNo(partNo),
    name: name || partNo,
    brand: get(col.brand) || null,
    fitment: get(col.fitment) || null,
    category: get(col.category) || null,
  };
}

// Is this header usable, and which column is which? Pulled out so the
// streaming reader can check the first row and fail loudly before it has
// inserted a quarter of a million rows against the wrong columns.
function readHeader(headerRow) {
  const header = (headerRow || []).map((h) => String(h).trim());
  const col = mapHeader(header);
  if (col.partNo === undefined && col.name === undefined) {
    return {
      header,
      col: null,
      error:
        'no part-number or name column found. Columns present: ' +
        header.join(', ') +
        '. Expected one of: ' +
        [...COLUMNS.partNo, ...COLUMNS.name].slice(0, 8).join(', '),
    };
  }
  return { header, col, error: null };
}

// What gets embedded. Part number included on purpose: customers type it, and
// a number is the least ambiguous thing in the row.
//
// NO price, NO stock — those are asked of the portal when the part is known.
function searchableText(p) {
  return [p.partNo, p.name, p.brand, p.fitment, p.category].filter(Boolean).join(' | ');
}

module.exports = { parseCatalogue, parseCsv, rowReader, rowToPart, readHeader, searchableText, partNoInName, stripPartNo, normPartNo, mapHeader };
