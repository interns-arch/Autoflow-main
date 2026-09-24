'use strict';
// THE WORDS A PERSON'S ANSWER WAS ABOUT — remembered by meaning.
//
// core/knowledge already remembers "this phrase means that part number". It
// remembers it under a string key, which is right for a shortcut somebody types
// the same way every time ("CTWB 18") and useless for a sentence:
//
//   asked, answered by Prateek sir:  "swift ka clutch plate chahiye"
//   a week later, another customer:  "clutch plate chahiye swift dzire, 2 pcs"
//
// Nothing a string key can do connects those two, so the second customer's
// question went back to Prateek sir and he answered it again. This module is
// the other half: the phrase is embedded, and the next question near enough to
// it resolves to the same part number without anybody being asked.
//
// WHAT IT NEVER DOES
//
//   * never stores a price, a stock figure or an ETA. It answers WHICH PART,
//     and the portal is then asked what it costs — as everywhere else here.
//   * never guesses. Two remembered phrases that disagree about which part they
//     mean are a tie, and a tie goes to a person. A phrase that contradicts
//     what the customer actually said is refused by the same brand check the
//     catalogue index and the portal search already use.
//   * never throws, and never blocks a reply. A database that is down costs the
//     bot its recall and nothing else, exactly as in core/kb/db.
const config = require('../../config');
const store = require('../../store');
const db = require('../kb/db');
const embeddings = require('../kb/embeddings');
const parse = require('./parse');

function enabled() {
  return db.configured();
}

// The identity of a phrase: lower case, letters and digits, single spaces. So
// "CLUTCH PLATE — swift!!" and "clutch plate swift" are one row.
function normPhrase(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// A phrase worth embedding: a NAME, in words. One word is not a question
// ("clutch"), and anything carrying a part number belongs in core/knowledge's
// exact map rather than here — "26510m65l10" is one character away from a
// different real part, and nearest-neighbour on part numbers is precisely how
// the wrong part gets quoted. Those phrases are found exactly or not at all,
// which is what that map is for.
const PART_SHAPED = (t) => t.length >= 5 && /[a-z]/.test(t) && /[0-9]/.test(t);
function worthRemembering(phrase) {
  const k = normPhrase(phrase);
  if (k.length < 6) return false;
  if (k.indexOf(' ') < 0) return false;
  if (k.split(' ').some(PART_SHAPED)) return false;
  return true;
}

// ONE AT A TIME.
//
// Every caller here fires and forgets, so nothing waits on this — and a bulk
// path does exist: applying approved mappings from the imported WhatsApp
// history teaches up to 500 phrases in one loop (core/history). Un-queued, that
// is 500 embedding calls opened at once against a quota the customer-facing
// paths share. Queued, it is 500 calls in a row that nobody is waiting for, and
// the order they were taught in is preserved.
let queue = Promise.resolve();
function remember(entry) {
  const next = queue.then(() => rememberNow(entry || {}));
  queue = next.catch(() => {});
  return next;
}

// TEACH ONE. Called wherever a phrase has been resolved to a part number by
// something that cost more than a lookup: a person answering, or the portal
// answering a phrase nobody had asked before.
//
// -> true when it was stored. Never throws.
async function rememberNow({ phrase, partNo, partName, source, taughtBy } = {}) {
  if (!enabled()) return false;
  const words = String(phrase || '').trim();
  const no = String(partNo || '').trim();
  if (!words || !no || !worthRemembering(words)) return false;

  try {
    const key = normPhrase(words);
    const normNo = parse.normPartNo(no);
    if (normNo.length < 3) return false;

    // Already remembered, pointing at the same part, already embedded: nothing
    // to do. A phrase asked fifty times a day must not cost fifty embedding
    // calls.
    const prev = await db.query(
      'SELECT id, norm_part_no, embedding IS NOT NULL AS has_vec FROM bot_part_aliases WHERE norm_phrase = $1',
      [key],
      { rows: [] },
    );
    const had = prev && prev.rows[0];
    if (had && had.norm_part_no === normNo && had.has_vec) return false;

    // Re-embedded only when it is new; a correction keeps the vector it has,
    // because the WORDS did not change — only which part they meant.
    const vec = had && had.has_vec ? null : await embeddings.embed(key);

    await db.query(
      `INSERT INTO bot_part_aliases (phrase, norm_phrase, part_no, norm_part_no, part_name, source, taught_by, embedding)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::vector)
       ON CONFLICT (norm_phrase) DO UPDATE
         SET part_no = EXCLUDED.part_no,
             norm_part_no = EXCLUDED.norm_part_no,
             part_name = COALESCE(EXCLUDED.part_name, bot_part_aliases.part_name),
             source = EXCLUDED.source,
             taught_by = COALESCE(EXCLUDED.taught_by, bot_part_aliases.taught_by),
             embedding = COALESCE(EXCLUDED.embedding, bot_part_aliases.embedding),
             updated_at = now()`,
      [
        words.slice(0, 500),
        key.slice(0, 500),
        no,
        normNo,
        partName ? String(partName).slice(0, 300) : null,
        source || 'helper',
        taughtBy ? String(taughtBy).slice(0, 60) : null,
        vec ? embeddings.toSqlVector(vec) : null,
      ],
      null,
    );
    store.log('parts', `phrase remembered: "${key.slice(0, 50)}" -> ${no} (${source || 'helper'})`);
    return true;
  } catch (e) {
    store.log('parts', 'could not remember the phrase: ' + String((e && e.message) || e).slice(0, 80));
    return false;
  }
}

// RECALL ONE.
//
// -> { partNo, name, phrase, similarity, exact } when we are sure
//    { partNo: null, candidates, why }            when we are not
//    null                                          when there is nothing to say
//
// Never throws.
async function recall(asked, opts = {}) {
  if (!enabled()) return null;
  const words = String(asked || '').trim();
  if (normPhrase(words).length < 4) return null;

  // A QUESTION IS NOT A PART. "kya tum log sunday ko khule ho" is near enough
  // to plenty of remembered sentences to score well, and one of those hits
  // would quote a part number at somebody asking about opening hours. The same
  // refusal core/escalation's portal path carries.
  const partish = require('../partish');
  if (partish.isQuestion(words) || partish.isVehicle(words)) return null;

  try {
    const key = normPhrase(words);
    const exact = await db.query(
      'SELECT part_no, part_name, phrase FROM bot_part_aliases WHERE norm_phrase = $1 LIMIT 1',
      [key],
      { rows: [] },
    );
    if (exact && exact.rows[0]) {
      await noteHit(key);
      return {
        partNo: exact.rows[0].part_no,
        name: exact.rows[0].part_name || null,
        phrase: exact.rows[0].phrase,
        similarity: 1,
        exact: true,
      };
    }

    const vec = await embeddings.embed(key);
    if (!vec) return null;

    const res = await db.query(
      `SELECT norm_phrase, phrase, part_no, norm_part_no, part_name,
              1 - (embedding <=> $1::vector) AS similarity
         FROM bot_part_aliases
        WHERE embedding IS NOT NULL
        ORDER BY embedding <=> $1::vector
        LIMIT $2`,
      [embeddings.toSqlVector(vec), opts.topK || config.parts.topK],
      { rows: [] },
    );
    const rows = (res && res.rows) || [];
    if (!rows.length) return null;

    const best = rows[0];
    const sim = Number(best.similarity);
    const threshold = opts.threshold == null ? config.parts.aliasThreshold : opts.threshold;
    const cand = () => rows.map((r) => ({ partNo: r.part_no, name: r.part_name || r.phrase, phrase: r.phrase }));
    if (sim < threshold) return { partNo: null, similarity: sim, candidates: cand(), why: 'nothing remembered is close enough' };

    // TWO REMEMBERED PHRASES, ONE QUESTION.
    //
    // A near-tie only matters when the two disagree. "swift clutch plate" and
    // "clutch plate swift dzire" scoring within a whisker of each other and
    // BOTH meaning 22400M74L00 is agreement, and the strongest signal this
    // table produces. Two that mean different parts is the wiper case again —
    // right size, wrong brand — and that goes to a person.
    const runnerUp = rows.find((r) => r.norm_part_no !== best.norm_part_no);
    if (runnerUp && sim - Number(runnerUp.similarity) < config.parts.margin) {
      store.log('parts', `"${key.slice(0, 40)}" is between ${best.part_no} and ${runnerUp.part_no} — too close, asking a person`);
      return { partNo: null, similarity: sim, candidates: cand(), tooClose: true, why: 'two remembered parts are too close to call' };
    }

    // A SIZE IS THE PART, NOT A DETAIL OF IT.
    //
    // The brand check below deliberately ignores bare numbers — the catalogue
    // search it was written for had already matched on them. Here nothing has:
    // "cartrends wiper blade 22 inch" is one word from a remembered 16-inch
    // question, scores 0.80 against it, and every other guard says yes. That is
    // the 16-inch wiper bug arriving from the other direction.
    //
    // So when both sentences carry numbers and they have none in common, they
    // are about different parts. Numbers on one side only are a quantity or a
    // year and decide nothing ("2 pcs" against a phrase with no number).
    const numbers = (s) => new Set((String(s).match(/\d{1,4}/g) || []).map((n) => String(Number(n))));
    const mine = numbers(key);
    const theirs = numbers(best.phrase);
    if (mine.size && theirs.size && ![...mine].some((n) => theirs.has(n))) {
      store.log('parts', `"${key.slice(0, 40)}" and "${String(best.phrase).slice(0, 40)}" name different sizes — asking a person`);
      return { partNo: null, similarity: sim, candidates: cand(), contradicts: true, why: 'the size asked for is not the one we were taught' };
    }

    // A CLOSE PHRASE IS STILL NOT PERMISSION TO IGNORE WHAT THEY SAID.
    //
    // "cartrend wiper blade 22 number" is one word from a remembered 16-inch
    // question and means a different blade. So every distinctive word in the
    // new question has to appear in the phrase we remembered, the part's name
    // or its number — the rule the catalogue index and the portal search
    // already apply, borrowed whole.
    const availability = require('../availability');
    const trusted = availability.matchTrustworthy(words, {
      partNo: best.part_no,
      name: [best.part_name, best.phrase].filter(Boolean).join(' '),
    });
    if (!trusted) {
      store.log('parts', `"${key.slice(0, 40)}" is near "${String(best.phrase).slice(0, 40)}" but contradicts it — asking a person`);
      return { partNo: null, similarity: sim, candidates: cand(), contradicts: true, why: 'the closest thing we were taught does not match what they said' };
    }

    await noteHit(best.norm_phrase);
    store.log('parts', `"${key.slice(0, 40)}" recalled as ${best.part_no} from "${String(best.phrase).slice(0, 40)}" (${sim.toFixed(2)})`);
    return {
      partNo: best.part_no,
      name: best.part_name || null,
      phrase: best.phrase,
      similarity: sim,
      exact: false,
    };
  } catch (e) {
    store.log('parts', 'phrase recall failed: ' + String((e && e.message) || e).slice(0, 80));
    return null;
  }
}

async function noteHit(normKey) {
  await db.query(
    'UPDATE bot_part_aliases SET hits = hits + 1, last_used_at = now() WHERE norm_phrase = $1',
    [normKey],
  );
}

// Phrases approved while the embedding service was down are unrecallable until
// they get a vector. Rides along with the knowledge base's hourly backfill.
async function embedPending(limit = 100) {
  if (!enabled() || !embeddings.available()) return 0;
  const res = await db.query(
    'SELECT id, norm_phrase FROM bot_part_aliases WHERE embedding IS NULL ORDER BY id LIMIT $1',
    [limit],
    { rows: [] },
  );
  const rows = (res && res.rows) || [];
  if (!rows.length) return 0;
  const vectors = await embeddings.embedBatch(rows.map((r) => r.norm_phrase));
  const ids = [];
  const vecs = [];
  for (let i = 0; i < rows.length; i++) {
    if (!vectors[i]) continue;
    ids.push(rows[i].id);
    vecs.push(embeddings.toSqlVector(vectors[i]));
  }
  if (!ids.length) return 0;
  const w = await db.query(
    `UPDATE bot_part_aliases SET embedding = v.emb::vector, updated_at = now()
       FROM (SELECT unnest($1::bigint[]) AS id, unnest($2::text[]) AS emb) v
      WHERE bot_part_aliases.id = v.id`,
    [ids, vecs],
    null,
  );
  return (w && w.rowCount) || 0;
}

// FORGET ONE.
//
// A phrase learned wrong is worse here than in the string-key map: it answers
// everything that MEANS the same thing, not just the sentence it was taught. So
// there has to be a way to take one out — see /api/parts/aliases in the console.
//
// -> the number of rows removed.
async function forget(phrase) {
  if (!enabled()) return 0;
  const key = normPhrase(phrase);
  if (!key) return 0;
  const r = await db.query('DELETE FROM bot_part_aliases WHERE norm_phrase = $1', [key], null);
  const n = (r && r.rowCount) || 0;
  if (n) store.log('parts', `forgot the phrase "${key.slice(0, 50)}"`);
  return n;
}

async function stats() {
  const r = await db.query(
    `SELECT count(*)::int AS total,
            count(embedding)::int AS embedded,
            coalesce(sum(hits), 0)::int AS hits
       FROM bot_part_aliases`,
    [],
    { rows: [] },
  );
  return (r && r.rows[0]) || { total: 0, embedded: 0, hits: 0 };
}

async function list(limit = 100) {
  const r = await db.query(
    `SELECT phrase, part_no, part_name, source, taught_by, hits, last_used_at, created_at
       FROM bot_part_aliases ORDER BY hits DESC, created_at DESC LIMIT $1`,
    [limit],
    { rows: [] },
  );
  return (r && r.rows) || [];
}

module.exports = { enabled, remember, recall, forget, embedPending, stats, list, normPhrase, worthRemembering };
