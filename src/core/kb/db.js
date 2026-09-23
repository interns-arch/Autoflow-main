'use strict';
// The Postgres connection for the knowledge base, and nothing else.
//
// The rest of the bot does not depend on this. Orders, part aliases, learned
// ranges and open escalations all still live in data/state.json, so a database
// that is down, unreachable or simply not configured costs the bot its
// knowledge RECALL — it asks a person instead — and costs it nothing else.
// That is the whole reason `ok()` exists and why every caller checks it.
const config = require('../../config');
const store = require('../../store');

let _pool = null;
let _down = 0; // when the last failure was, so we stop hammering a dead server

// How long to stay out of the way after a connection failure. Every query in
// this module is on a customer's critical path, and a Postgres that is down
// answers slowly (a full TCP timeout) rather than quickly — so retrying every
// message would add that timeout to every reply.
const COOLDOWN_MS = 30 * 1000;

function configured() {
  return Boolean(config.kb && config.kb.databaseUrl);
}

function pool() {
  if (_pool) return _pool;
  const { Pool } = require('pg');
  _pool = new Pool({
    connectionString: config.kb.databaseUrl,
    max: config.kb.poolMax,
    connectionTimeoutMillis: config.kb.connectTimeoutMs,
    idle_in_transaction_session_timeout: 10000,
    ssl: config.kb.ssl ? { rejectUnauthorized: false } : undefined,
  });
  // An idle client erroring takes the process down if nobody is listening.
  _pool.on('error', (e) => {
    _down = Date.now();
    store.log('kb', 'pool error: ' + String((e && e.message) || e).slice(0, 120));
  });
  return _pool;
}

// Is it worth trying a query right now?
function ok() {
  if (!configured()) return false;
  if (_down && Date.now() - _down < COOLDOWN_MS) return false;
  return true;
}

// Run a query, or return `fallback` if the database cannot answer.
//
// NEVER throws. A knowledge lookup that fails must become "ask a person",
// never an exception halfway through handling a customer's message.
async function query(text, params, fallback = null) {
  if (!ok()) return fallback;
  try {
    const res = await pool().query(text, params);
    _down = 0;
    return res;
  } catch (e) {
    // A BROKEN QUERY IS NOT A BROKEN SERVER. Treating both as "down" meant a
    // permanent SQL bug quietly disabled the knowledge base for 30 seconds at
    // a time, forever, looking exactly like a flaky network. Postgres gives
    // syntax, undefined-column and type errors their own SQLSTATEs (class 42),
    // and those are ours to fix, not to wait out.
    const code = String((e && e.code) || '');
    const ourBug = /^(42|22|23)/.test(code);
    if (!ourBug) _down = Date.now();
    // The real error goes to our log; the customer never sees a word of it.
    store.log(
      'kb',
      (ourBug ? 'BAD QUERY (fix this, not a connection problem) ' : 'query failed ') +
        (code ? '[' + code + '] ' : '') +
        String((e && e.message) || e).slice(0, 160),
    );
    return fallback;
  }
}

// Several statements as one unit, or nothing. Used where a half-written
// correction would leave two live answers to the same question.
async function tx(fn, fallback = null) {
  if (!ok()) return fallback;
  let client = null;
  try {
    client = await pool().connect();
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    _down = 0;
    return out;
  } catch (e) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (_) {}
    }
    _down = Date.now();
    store.log('kb', 'transaction failed: ' + String((e && e.message) || e).slice(0, 160));
    return fallback;
  } finally {
    if (client) client.release();
  }
}

// Does the schema exist? Called once at boot so a missing migration is a line
// in the log at startup, not a surprise on the first customer question.
async function health() {
  if (!configured()) return { ok: false, reason: 'DATABASE_URL not set' };
  const res = await query("SELECT to_regclass('public.bot_knowledge') AS t", []);
  if (!res) return { ok: false, reason: 'cannot reach the database' };
  if (!res.rows[0] || !res.rows[0].t) return { ok: false, reason: 'schema missing — run: npm run migrate' };
  const n = await query('SELECT count(*)::int AS n FROM bot_knowledge WHERE status = $1', ['approved']);
  return { ok: true, approved: n && n.rows[0] ? n.rows[0].n : 0 };
}

async function close() {
  if (_pool) await _pool.end();
  _pool = null;
}

// Tests swap in a stand-in that speaks the same two methods.
function _setPoolForTests(p) {
  _pool = p;
  _down = 0;
}

module.exports = { configured, ok, pool, query, tx, health, close, _setPoolForTests };
