#!/usr/bin/env node
'use strict';
// Import exported WhatsApp chat history.
//
//   npm run import:whatsapp-history -- "./Lagan Motors.zip"
//   npm run import:whatsapp-history -- ~/Downloads/*.zip
//   npm run import:whatsapp-history -- --dry-run ./chat.zip     parse, store nothing
//   npm run import:whatsapp-history -- --no-verify ./chat.zip   skip portal checks
//   npm run import:whatsapp-history -- --apply                  write approved aliases
//
// Importing the same file twice does nothing the second time.
require('dotenv').config();
const fs = require('fs');
const path = require('path');

function usage() {
  console.log('usage: import-whatsapp-history [--dry-run] [--no-verify] [--no-embed] [--apply] <file.zip> [more.zip ...]');
}

function fmt(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function row(label, value, note) {
  console.log('  ' + String(label).padEnd(30) + String(fmt(value)).padStart(8) + (note ? '   ' + note : ''));
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const files = argv.filter((a) => !a.startsWith('--'));
  const applyOnly = flags.has('--apply') && !files.length;
  const familiesOnly = flags.has('--families') && !files.length;

  const history = require('../src/core/history');
  if (!history.enabled()) {
    console.error('DATABASE_URL is not set. The knowledge base holds the imported history,');
    console.error('so there is nowhere to put it. See README, "Self-learning knowledge base".');
    process.exit(1);
  }

  if (familiesOnly) {
    // Ambiguous mappings are not mistakes: they are variant families, the
    // way the wiper sizes are. --dry-run shows what would be built.
    const fam = require('../src/core/history/families');
    const res = await fam.buildFromMappings({ apply: !flags.has('--dry-run') });
    for (const d of res.details) {
      console.log((d.built ? 'FAMILY  ' : 'skipped ') + '"' + d.phrase + '"' + (d.reason ? '  - ' + d.reason : ''));
      for (const v of d.variants || []) console.log('           ' + v.partNo + '  decided by: ' + ((v.decidesOn || []).join(', ') || '-') + '   [' + (v.label||'').slice(0,50) + ']');
      for (const r of d.rejected || []) console.log('           rejected ' + r.partNo + '  portal says: ' + String(r.portalName||'(not carried)').split('|')[0]);
    }
    console.log();
    console.log(res.built + ' family(ies) ' + (flags.has('--dry-run') ? 'would be built' : 'built') + ', ' + res.skipped + ' skipped, of which ' + res.review + ' are worth a person deciding');
    return;
  }

  if (applyOnly) {
    const n = await history.applyApprovedMappings();
    console.log('applied ' + n + ' approved part mapping(s) into the bot\'s alias store');
    return;
  }
  if (!files.length) {
    usage();
    process.exit(1);
  }

  const total = {
    files: 0, chats: 0, messages: 0, customerMessages: 0, employeeMessages: 0, media: 0, noise: 0,
    pairs: 0, examples: 0, duplicates: 0, mappings: 0, orderLines: 0, parts: 0,
    portalChecked: 0, portalConfirmed: 0, autoApproved: 0, needsReview: 0, skipped: 0,
    intents: {},
  };

  for (const f of files) {
    const p = path.resolve(f);
    if (!fs.existsSync(p)) {
      console.error('not found: ' + f);
      continue;
    }
    process.stdout.write('importing ' + path.basename(p) + ' ... ');
    let res;
    try {
      res = await history.importZip(p, {
        verify: !flags.has('--no-verify'),
        embed: !flags.has('--no-embed'),
        dryRun: flags.has('--dry-run'),
      });
    } catch (e) {
      console.log('FAILED');
      console.error('   ' + String((e && e.message) || e));
      continue;
    }
    if (res.skipped) {
      console.log('already imported — nothing to do');
      total.skipped++;
      continue;
    }
    const s = res.stats;
    console.log(s.examples + ' example(s), ' + s.mappings + ' mapping(s)');
    total.files++;
    for (const k of Object.keys(total)) {
      if (k === 'intents' || k === 'skipped' || k === 'files') continue;
      if (typeof s[k] === 'number') total[k] += s[k];
    }
    for (const [k, v] of Object.entries(s.intents || {})) total.intents[k] = (total.intents[k] || 0) + v;
  }

  console.log('\n=============== IMPORT SUMMARY ===============');
  row('Files processed', total.files);
  row('Files already imported', total.skipped, total.skipped ? '(skipped, idempotent)' : '');
  row('Chats processed', total.chats);
  row('Messages parsed', total.messages);
  row('  from customers', total.customerMessages);
  row('  from employees', total.employeeMessages);
  row('  media with no text', total.media);
  row('  noise / system', total.noise);
  console.log('  ' + '-'.repeat(46));
  row('Question/answer pairs', total.pairs);
  row('Historical examples stored', total.examples);
  row('Duplicates skipped', total.duplicates);
  console.log('  ' + '-'.repeat(46));
  row('Part-related order lines', total.orderLines);
  row('Unique part numbers seen', total.parts);
  row('Part mappings created', total.mappings);
  row('  checked against portal', total.portalChecked);
  row('  confirmed by portal', total.portalConfirmed);
  row('  approved automatically', total.autoApproved);
  row('  need manual review', total.needsReview);
  console.log('  ' + '-'.repeat(46));
  const intents = Object.entries(total.intents).sort((a, b) => b[1] - a[1]);
  console.log('  Intents observed:            ' + intents.length);
  for (const [k, v] of intents) console.log('      ' + String(v).padStart(6) + '  ' + k);
  console.log('==============================================');

  if (total.autoApproved) {
    console.log('\n' + total.autoApproved + ' mapping(s) are approved but NOT yet live.');
    console.log('Review them first:   GET /api/history/mappings?status=approved');
    console.log('Then apply:          npm run import:whatsapp-history -- --apply');
  }
}

main()
  .then(() => require('../src/core/kb/db').close())
  .catch((e) => {
    console.error(String((e && e.stack) || e));
    process.exit(1);
  });
