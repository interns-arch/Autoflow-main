'use strict';
// Import the daily ClosingStock.csv into the bot's internal stock.
//   node scripts/import_closing_stock.js "D:\Downloads\ClosingStock.csv"
// Columns used: Name (item, includes #partno), BalQty (closing qty), MRP.
// Only rows with BalQty > 0 are kept. Tries the running server's API first
// (no restart needed); falls back to writing data/state.json directly.
const fs = require('fs');
const path = require('path');

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.error('usage: node scripts/import_closing_stock.js <ClosingStock.csv>');
  process.exit(1);
}

// minimal CSV parser (handles quoted fields with commas)
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (field !== '' || row.length) { row.push(field); rows.push(row); row = []; field = ''; }
      if (c === '\r' && text[i + 1] === '\n') i++;
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const rows = parseCsv(fs.readFileSync(file, 'utf-8'));
const header = rows[0].map((h) => h.trim().toLowerCase());
const iName = header.indexOf('name');
const iQty = header.indexOf('balqty');
const iMrp = header.indexOf('mrp');
if (iName < 0 || iQty < 0) {
  console.error('CSV must have "Name" and "BalQty" columns. Found:', header.join(', '));
  process.exit(1);
}

const lines = [];
for (const r of rows.slice(1)) {
  const item = (r[iName] || '').trim();
  const qty = Math.floor(parseFloat(r[iQty]) || 0);
  if (!item || qty <= 0) continue;
  const mrp = iMrp >= 0 ? parseFloat(r[iMrp]) || null : null;
  lines.push({ item, qty, price: mrp, shelf: '' });
}
console.log(`parsed ${rows.length - 1} rows -> ${lines.length} in-stock items (BalQty > 0)`);

(async () => {
  try {
    const res = await fetch('http://localhost:3010/api/internal-stock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lines }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    console.log(`imported via running server API: ${d.count} items live ab bot ke paas`);
  } catch (e) {
    // server not running — write the state file directly
    const config = require('../src/config');
    const store = require('../src/store');
    store.setInternalStock(lines);
    await new Promise((r) => setTimeout(r, 400)); // let the debounced save flush
    console.log(`server not reachable (${e.message}) — wrote ${lines.length} items directly to data/state.json (will load on next start)`);
  }
})();
