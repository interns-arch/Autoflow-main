#!/usr/bin/env node
'use strict';
// Import the parts catalogue into the search index.
//
//   npm run import:parts -- ./ClosingStock.csv
//   npm run import:parts -- --dry-run ./parts.csv    read it, store nothing
//   npm run import:parts -- --no-embed ./parts.csv   rows now, vectors later
//   npm run import:parts -- --embed                  finish embedding
//   npm run import:parts -- --stats                  what the index holds
//
// Re-importing is safe: rows are keyed on the part number, so a newer export
// updates what it carries instead of duplicating it.
//
// PRICE AND STOCK ARE NOT IMPORTED. They are read from the portal at the
// moment a customer asks, because a cached price is a wrong price.
require('dotenv').config();
const fs = require('fs');
const path = require('path');

async function main() {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const files = argv.filter((a) => !a.startsWith('--'));

  const parts = require('../src/core/parts');
  if (!parts.enabled()) {
    console.error('DATABASE_URL is not set — the catalogue index lives in Postgres.');
    process.exit(1);
  }

  if (flags.has('--stats') && !files.length) {
    const s = await parts.stats();
    console.log('  parts indexed : ' + s.total);
    console.log('  with a vector : ' + s.embedded + (s.total > s.embedded ? '   (' + (s.total - s.embedded) + ' still to embed)' : ''));
    console.log('  ever used     : ' + s.used);
    return;
  }

  if (flags.has('--embed') && !files.length) {
    process.stdout.write('embedding... ');
    const n = await parts.embedPending(Infinity, (d) => process.stdout.write(d + ' '));
    console.log('\n  ' + n + ' part(s) embedded');
    const s = await parts.stats();
    if (s.total > s.embedded) console.log('  ' + (s.total - s.embedded) + ' still without a vector — run again');
    return;
  }

  if (!files.length) {
    console.log('usage: import-parts [--dry-run] [--no-embed] <catalogue.csv>');
    console.log('       import-parts --embed     finish embedding');
    console.log('       import-parts --stats     what the index holds');
    process.exit(1);
  }

  for (const f of files) {
    const p = path.resolve(f);
    if (!fs.existsSync(p)) {
      console.error('not found: ' + f);
      continue;
    }

    if (flags.has('--dry-run')) {
      // Read it and show what WOULD be imported. Worth doing first on a new
      // export: the columns are read from the header, not assumed, and this
      // is where a mismatch shows up harmlessly.
      const parse = require('../src/core/parts/parse');
      const parsed = parse.parseCatalogue(fs.readFileSync(p, 'utf8'));
      console.log('\n' + path.basename(p));
      console.log('  columns found : ' + parsed.header.join(', '));
      if (parsed.error) {
        console.log('  PROBLEM       : ' + parsed.error);
        continue;
      }
      console.log('  usable rows   : ' + parsed.rows.length);
      console.log('  skipped       : ' + parsed.skipped + '   (no part number, or listed twice)');
      console.log('  first few, as they would be indexed:');
      for (const r of parsed.rows.slice(0, 5)) {
        console.log('    ' + String(r.partNo).padEnd(22) + parse.searchableText(r).slice(0, 78));
      }
      continue;
    }

    console.log('\nimporting ' + path.basename(p) + ' ...');
    let s;
    try {
      s = await parts.importFile(p, {
        embed: !flags.has('--no-embed'),
        onProgress: (n) => process.stdout.write('  embedded ' + n + '\r'),
      });
    } catch (e) {
      console.error('  FAILED: ' + String((e && e.message) || e));
      continue;
    }
    console.log('  rows read     : ' + s.rowsRead);
    console.log('  new parts     : ' + s.inserted);
    console.log('  updated       : ' + s.updated);
    console.log('  skipped       : ' + s.skipped);
    console.log('  embedded      : ' + s.embedded);
    const st = await parts.stats();
    if (st.total > st.embedded) {
      console.log('\n  ' + (st.total - st.embedded) + ' part(s) have no vector yet.');
      console.log('  Finish with:  npm run import:parts -- --embed');
      console.log('  (exact part-number lookups already work without one.)');
    }
  }
}

main()
  .then(() => require('../src/core/kb/db').close())
  .catch((e) => {
    console.error(String((e && e.stack) || e));
    process.exit(1);
  });
