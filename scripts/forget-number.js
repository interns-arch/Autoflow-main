#!/usr/bin/env node
'use strict';
// FORGET ONE NUMBER — everything the bot holds about it.
//
//   node scripts/forget-number.js 917355374975          preview: changes nothing
//   node scripts/forget-number.js 917355374975 --yes    backs up, then deletes
//
// STOP THE BOT FIRST. store.js rewrites state.json whole on every save, so a bot
// that is running would write the number straight back from memory a second
// later. On the server:
//
//   docker compose stop autoflow
//   docker compose run --rm autoflow node scripts/forget-number.js <number> --yes
//   docker compose start autoflow
//
// WHAT IS REMOVED, wherever the number appears in any spelling — 917355374975,
// 7355374975, "+91 73553 74975" (the form the bot writes into its questions to
// the helper), 73553-74975:
//
//   state.json      orders, the customer record, inquiries, log lines, the
//                   conversation, language, numbered lists, every chat-state
//                   slot, open questions they raised (and them as a waiter on
//                   someone else's)
//   /shared/*.jsonl every chat-log and shadow-log line in or out of them,
//                   including the questions sent to the helper about them
//   Postgres        answers scoped to them, their escalations and misses,
//                   imported history, and the agent's conversation thread
//
// WHAT IS KEPT, on purpose:
//
//   the part knowledge   "cartend horn -> CTHNKAM889WP" is what a person taught
//                        about a PART. It answers every customer, and it was
//                        not theirs to begin with.
//   the dealer portal    their account and any order placed there live in the
//                        portal, which is the system of record. Not touched.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const config = require('../src/config');

const arg = process.argv[2];
const YES = process.argv.includes('--yes');
const digits = String(arg || '').replace(/\D/g, '');
if (digits.length < 10) {
  console.error('usage: node scripts/forget-number.js <phone number> [--yes]');
  process.exit(1);
}
const ten = digits.slice(-10);
// The number in any spelling: at most one space or hyphen between digits.
const R = new RegExp(ten.split('').join('[ -]?'));
const mentions = (x) => R.test(typeof x === 'string' ? x : JSON.stringify(x));

// Shared by every customer, never personal. See "WHAT IS KEPT" above.
const KEEP = new Set(['knowledge', 'seq', 'escalationSeq']);

// ------------------------------------------------------------ state.json
function cleanState(s) {
  const report = {};
  const count = (k, n) => {
    if (n) report[k] = (report[k] || 0) + n;
  };

  for (const [k, v] of Object.entries(s)) {
    if (KEEP.has(k) || !v || typeof v !== 'object') continue;

    // Open questions. One this number RAISED goes; one somebody else raised
    // stays, with this number taken off its list of people waiting.
    if (k === 'escalationsOpen') {
      for (const [id, e] of Object.entries(v)) {
        if (mentions([e.chatId, e.customerPhone])) {
          delete v[id];
          count(k, 1);
        } else if (Array.isArray(e.waiters) && e.waiters.some(mentions)) {
          const before = e.waiters.length;
          e.waiters = e.waiters.filter((w) => !mentions(w));
          count(k + ' (as a waiter)', before - e.waiters.length);
        }
      }
      continue;
    }

    // slot -> { chatId: value }. Only this chat's entry in each slot goes;
    // the slot itself belongs to every customer.
    if (k === 'chatState') {
      for (const entries of Object.values(v)) {
        if (!entries || typeof entries !== 'object') continue;
        for (const key of Object.keys(entries)) {
          if (mentions(key) || mentions(entries[key])) {
            delete entries[key];
            count(k, 1);
          }
        }
      }
      continue;
    }

    if (Array.isArray(v)) {
      const before = v.length;
      s[k] = v.filter((x) => !mentions(x));
      count(k, before - s[k].length);
      continue;
    }

    for (const key of Object.keys(v)) {
      if (mentions(key) || mentions(v[key])) {
        delete v[key];
        count(k, 1);
      }
    }
  }
  return report;
}

// ------------------------------------------------------- shared log files
function logFiles() {
  let names = [];
  try {
    names = fs.readdirSync(config.sharedDir);
  } catch (_) {
    return [];
  }
  return names.filter((f) => f.endsWith('.jsonl')).map((f) => path.join(config.sharedDir, f));
}

function cleanLog(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const keep = lines.filter((l) => !R.test(l));
  return { removed: lines.length - keep.length, text: keep.join('\n') };
}

// ------------------------------------------------------------- Postgres
const TABLES = [
  // table, column, how it is matched
  ['bot_knowledge', 'customer_id', 'ends'],
  ['bot_escalations', 'customer_id', 'ends'],
  ['bot_knowledge_misses', 'customer_id', 'ends'],
  ['historical_chat_examples', 'customer_id', 'ends'],
  // The agent's conversation, keyed on the chat id ("917355374975@cloud").
  ['checkpoints', 'thread_id', 'has'],
  ['checkpoint_blobs', 'thread_id', 'has'],
  ['checkpoint_writes', 'thread_id', 'has'],
];

async function cleanDatabase() {
  const db = require('../src/core/kb/db');
  if (!db.configured()) return { skipped: 'DATABASE_URL is not set' };
  const report = {};
  for (const [table, col, how] of TABLES) {
    const there = await db.query('SELECT to_regclass($1) AS t', ['public.' + table]);
    if (!there) return { skipped: 'the database could not be reached' };
    if (!there.rows[0] || !there.rows[0].t) continue;
    const where = how === 'ends' ? `${col} LIKE '%' || $1` : `${col} LIKE '%' || $1 || '%'`;
    const n = await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, [ten]);
    const found = (n && n.rows[0] && n.rows[0].n) || 0;
    if (!found) continue;
    if (YES) await db.query(`DELETE FROM ${table} WHERE ${where}`, [ten]);
    report[table] = found;
  }
  await db.close().catch(() => {});
  return report;
}

// ------------------------------------------------------------------ run
(async () => {
  console.log(`\n${YES ? 'FORGETTING' : 'PREVIEW (nothing is changed — add --yes to delete)'}: ${digits}\n`);

  const stateFile = path.join(config.dataDir, 'state.json');
  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null;
  const stateReport = state ? cleanState(state) : {};
  const logs = logFiles().map((f) => ({ file: f, ...cleanLog(f) }));

  if (YES) {
    // Everything that is about to change, copied first. The database is not
    // backed up here: pg_dump belongs to whoever runs the server.
    const dir = path.join(config.dataDir, 'backups', `forget-${digits}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    fs.mkdirSync(dir, { recursive: true });
    if (state) fs.copyFileSync(stateFile, path.join(dir, 'state.json'));
    for (const l of logs) if (l.removed) fs.copyFileSync(l.file, path.join(dir, path.basename(l.file)));
    console.log('backup: ' + dir + '\n');

    if (state) {
      fs.writeFileSync(stateFile + '.tmp', JSON.stringify(state, null, 2));
      fs.renameSync(stateFile + '.tmp', stateFile);
    }
    for (const l of logs) {
      if (!l.removed) continue;
      fs.writeFileSync(l.file + '.tmp', l.text);
      fs.renameSync(l.file + '.tmp', l.file);
    }
  }

  console.log('state.json');
  if (!state) console.log('  (no state file at ' + stateFile + ')');
  else if (!Object.keys(stateReport).length) console.log('  nothing about this number');
  for (const [k, n] of Object.entries(stateReport)) console.log(`  ${k.padEnd(28)} ${n}`);

  console.log('\nlog files');
  const touched = logs.filter((l) => l.removed);
  if (!touched.length) console.log('  nothing about this number');
  for (const l of touched) console.log(`  ${path.basename(l.file).padEnd(28)} ${l.removed} line(s)`);

  console.log('\nPostgres');
  const dbReport = await cleanDatabase();
  if (dbReport.skipped) console.log('  skipped — ' + dbReport.skipped);
  else if (!Object.keys(dbReport).length) console.log('  nothing about this number');
  else for (const [t, n] of Object.entries(dbReport)) console.log(`  ${t.padEnd(28)} ${n} row(s)`);

  console.log(YES ? '\nDone.\n' : '\nNothing was changed. Run again with --yes to delete.\n');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
