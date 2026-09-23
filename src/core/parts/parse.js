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

    if (!partNo || normPartNo(partNo).length < 3) {
      skipped++;
      continue;
    }
    const key = normPartNo(partNo);
    if (seen.has(key)) {
      skipped++; // the same part listed twice in one export
      continue;
    }
    seen.add(key);

    out.push({
      partNo,
      normPartNo: key,
      name: name || partNo,
      brand: get(col.brand) || null,
      fitment: get(col.fitment) || null,
      category: get(col.category) || null,
    });
  }
  return { rows: out, header, skipped };
}

// What gets embedded. Part number included on purpose: customers type it, and
// a number is the least ambiguous thing in the row.
//
// NO price, NO stock — those are asked of the portal when the part is known.
function searchableText(p) {
  return [p.partNo, p.name, p.brand, p.fitment, p.category].filter(Boolean).join(' | ');
}

module.exports = { parseCatalogue, parseCsv, searchableText, partNoInName, stripPartNo, normPartNo, mapHeader };
