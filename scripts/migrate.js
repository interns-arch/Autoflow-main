#!/usr/bin/env node
'use strict';
// Migration runner for the knowledge base.
//
//   npm run migrate            apply everything not yet applied
//   npm run migrate:status     what is applied, what is waiting
//   node scripts/migrate.js down 001_knowledge_base    roll one back
//
// Deliberately small: a _migrations table, files in migrations/ applied in
// filename order, each inside a transaction. A migration that fails leaves
// nothing half-applied and nothing recorded.
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'migrations');

function files() {
  return fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort();
}

function sqlFor(name, direction) {
  const file = path.join(DIR, direction === 'down' ? name + '.down.sql' : name + '.sql');
  if (!fs.existsSync(file)) throw new Error('no ' + direction + ' migration for ' + name);
  return fs.readFileSync(file, 'utf8');
}

async function main() {
  const db = require('../src/core/kb/db');
  if (!db.configured()) {
    console.error('DATABASE_URL is not set — nothing to migrate against.');
    console.error('Set it in .env, e.g. DATABASE_URL=postgres://autoflow:autoflow@localhost:5432/autoflow');
    process.exit(1);
  }

  const [cmd, which] = process.argv.slice(2);
  const pool = db.pool();

  await pool.query(
    'CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())',
  );
  const applied = new Set((await pool.query('SELECT name FROM _migrations')).rows.map((r) => r.name));

  if (cmd === 'status') {
    for (const f of files()) {
      const name = f.replace(/\.sql$/, '');
      console.log((applied.has(name) ? '  applied  ' : '  PENDING  ') + name);
    }
    return;
  }

  if (cmd === 'down') {
    const name = which || [...applied].sort().pop();
    if (!name) return console.log('nothing to roll back');
    if (!applied.has(name)) return console.log(name + ' is not applied');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sqlFor(name, 'down'));
      await client.query('DELETE FROM _migrations WHERE name = $1', [name]);
      await client.query('COMMIT');
      console.log('rolled back ' + name);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    return;
  }

  let ran = 0;
  for (const f of files()) {
    const name = f.replace(/\.sql$/, '');
    if (applied.has(name)) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sqlFor(name, 'up'));
      await client.query('INSERT INTO _migrations (name) VALUES ($1)', [name]);
      await client.query('COMMIT');
      console.log('applied  ' + name);
      ran++;
    } catch (e) {
      await client.query('ROLLBACK');
      // The most common first-run failure by far, and the message Postgres
      // gives for it does not say what to install.
      if (/type "vector" does not exist|extension "vector"/i.test(String(e.message))) {
        console.error('\n' + name + ' needs the pgvector extension, which this server does not have.');
        console.error('Install it (https://github.com/pgvector/pgvector) or use the pgvector/pgvector Docker image,');
        console.error('then run this again. Nothing was applied.');
        process.exit(1);
      }
      throw e;
    } finally {
      client.release();
    }
  }
  console.log(ran ? ran + ' migration(s) applied' : 'already up to date');
}

main()
  .then(() => require('../src/core/kb/db').close())
  .catch((e) => {
    console.error(String((e && e.message) || e));
    process.exit(1);
  });
