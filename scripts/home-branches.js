#!/usr/bin/env node
'use strict';
// THE HOME BRANCH OF EVERY CUSTOMER THE BOT OPENED, against the rule
// (founder, 25 Sep): Rajasthan -> Mansarovar (1078), anywhere else ->
// Bijwasan (23). Reads the portal's customer-branch mapping; with --fix,
// sets the ones that differ.
//
//   node scripts/home-branches.js          # report only
//   node scripts/home-branches.js --fix    # and correct
const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const portal = require('../src/integrations/dealerPortal');
const de = require('../src/core/dataEntryRequests');

const fix = process.argv.includes('--fix');

// Every account the bot opened: the approval log, and — for the ones opened
// before it existed — the "is open (login)" replies in the chat log.
function botAccounts() {
  const names = new Set();
  try {
    for (const line of fs.readFileSync(path.join(config.sharedDir, 'approvals.jsonl'), 'utf8').split('\n')) {
      try {
        const e = JSON.parse(line);
        if (e.kind === 'account' && e.event === 'approved' && e.customer) names.add(e.customer);
      } catch (_) {
        /* skip */
      }
    }
  } catch (_) {
    /* no log yet */
  }
  try {
    for (const line of fs.readFileSync(path.join(config.sharedDir, 'chats.jsonl'), 'utf8').split('\n')) {
      const m = line.match(/Done — (.+?) is open \(/);
      if (m) names.add(m[1].trim());
    }
  } catch (_) {
    /* no chat log */
  }
  return [...names];
}

(async () => {
  const names = botAccounts();
  console.log(`${names.length} customer(s) opened by the bot${fix ? ' — fixing mismatches' : ' — report only (--fix to correct)'}\n`);
  let wrong = 0;
  for (const name of names) {
    const row = (await portal.searchAccounts(name).catch(() => [])).find((r) => String(r.name).trim() === name);
    if (!row) {
      console.log(`?  ${name}: not found on the portal`);
      continue;
    }
    const want = de.branchFor({ state: row.state_name, address: row.address });
    const now = await portal.homeBranchOf(row.id, row.name).catch(() => null);
    const ok = now && now.id === want;
    console.log(`${ok ? 'OK' : '!!'} ${name} (#${row.id}, ${row.state_name || '?'}): portal ${now ? de.branchName(now.id) : '?'}, rule ${de.branchName(want)}`);
    if (!ok && now) {
      wrong++;
      if (fix) {
        const r = await portal.setHomeBranch(row.id, row.name, want).catch((e) => ({ ok: false, error: e.message }));
        console.log(`   -> ${r.ok ? 'set to ' + de.branchName(want) : 'NOT set: ' + (r.error || JSON.stringify(r))}`);
      }
    }
  }
  console.log(`\n${wrong} to correct${fix ? '' : ' (run with --fix)'}`);
  process.exit(0);
})().catch((e) => {
  console.log('ERR', e.message);
  process.exit(1);
});
