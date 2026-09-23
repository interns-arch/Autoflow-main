'use strict';
// The catalogue, searchable by meaning — and nothing else.
//
// This module answers ONE question: which part is the customer talking about?
// It never answers what it costs or whether we have it. Those come from the
// portal every time, because a cached price is a wrong price.
//
//   customer words -> [vector search here] -> part number -> portal -> reply
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const config = require('../../config');
const store = require('../../store');
const db = require('../kb/db');
const embeddings = require('../kb/embeddings');
const parse = require('./parse');

function enabled() {
  return db.configured();
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ------------------------------------------------------------------ import
//
// Idempotent on the part number, not on the file: a later export of the same
// catalogue UPDATES the rows it carries rather than duplicating them, which is
// what makes re-importing after a catalogue change safe.
async function importFile(filePath, opts = {}) {
  if (!enabled()) throw new Error('DATABASE_URL is not set — nowhere to put the catalogue');
  const buf = fs.readFileSync(filePath);
  const parsed = parse.parseCatalogue(buf.toString('utf8'));
  if (parsed.error) throw new Error(parsed.error);
  if (!parsed.rows.length) throw new Error('no usable rows. Columns seen: ' + parsed.header.join(', '));

  const fileName = path.basename(filePath);
  const stats = {
    rowsRead: parsed.rows.length,
    skipped: parsed.skipped,
    inserted: 0,
    updated: 0,
    embedded: 0,
    embedFailed: 0,
    header: parsed.header,
  };

  const res = await db.query(
    'INSERT INTO bot_parts_imports (file_name, file_hash, rows_read) VALUES ($1,$2,$3) RETURNING id',
    [fileName, sha(buf), parsed.rows.length],
    null,
  );
  const importId = res && res.rows[0] ? res.rows[0].id : null;

  // Rows first, embeddings after. A catalogue of a hundred thousand parts is
  // hours of embedding calls, and the rows are useful immediately: an exact
  // part-number lookup needs no vector at all.
  for (const p of parsed.rows) {
    const searchable = parse.searchableText(p);
    const r = await db.query(
      `INSERT INTO bot_parts (part_no, norm_part_no, name, brand, fitment, category, searchable, source_file, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)
       ON CONFLICT (norm_part_no) DO UPDATE
         SET part_no = EXCLUDED.part_no,
             name = EXCLUDED.name,
             brand = COALESCE(EXCLUDED.brand, bot_parts.brand),
             fitment = COALESCE(EXCLUDED.fitment, bot_parts.fitment),
             category = COALESCE(EXCLUDED.category, bot_parts.category),
             -- the text changed, so whatever was embedded is stale
             embedding = CASE WHEN bot_parts.searchable IS DISTINCT FROM EXCLUDED.searchable
                              THEN NULL ELSE bot_parts.embedding END,
             searchable = EXCLUDED.searchable,
             source_file = EXCLUDED.source_file,
             active = true,
             updated_at = now()
       RETURNING (xmax = 0) AS inserted`,
      [p.partNo, p.normPartNo, p.name, p.brand, p.fitment, p.category, searchable, fileName],
      null,
    );
    if (!r || !r.rows[0]) continue;
    if (r.rows[0].inserted) stats.inserted++;
    else stats.updated++;
  }

  if (opts.embed !== false) {
    stats.embedded = await embedPending(opts.embedLimit || Infinity, (n) => {
      if (opts.onProgress) opts.onProgress(n);
    });
  }

  if (importId) {
    await db.query(
      'UPDATE bot_parts_imports SET inserted=$2, updated=$3, skipped=$4, embedded=$5, stats=$6 WHERE id=$1',
      [importId, stats.inserted, stats.updated, stats.skipped, stats.embedded, JSON.stringify(stats)],
    );
  }
  store.log('parts', `catalogue import ${fileName}: +${stats.inserted} new, ${stats.updated} updated`);
  return stats;
}

// Embed whatever has no vector yet. Safe to stop and re-run — it picks up
// where it left off, which matters when the catalogue is large.
async function embedPending(limit = 500, onProgress) {
  if (!enabled() || !embeddings.available()) return 0;
  let done = 0;
  const BATCH = 100;
  while (done < limit) {
    const res = await db.query(
      'SELECT id, searchable FROM bot_parts WHERE embedding IS NULL AND active ORDER BY id LIMIT $1',
      [Math.min(BATCH, limit - done)],
      { rows: [] },
    );
    const rows = (res && res.rows) || [];
    if (!rows.length) break;
    for (const row of rows) {
      const vec = await embeddings.embed(row.searchable);
      if (!vec) return done; // the service is down; the rest waits for next time
      await db.query('UPDATE bot_parts SET embedding = $2::vector WHERE id = $1', [
        row.id,
        embeddings.toSqlVector(vec),
      ]);
      done++;
      if (onProgress && done % 50 === 0) onProgress(done);
    }
  }
  return done;
}

// ------------------------------------------------------------------ lookup
//
// -> { partNo, name, similarity, exact } | null
//
// An EXACT part number wins outright and costs no embedding call: a customer
// who typed the number does not need to be guessed at.
async function find(text, opts = {}) {
  if (!enabled()) return null;
  const asked = String(text || '').trim();
  if (!asked) return null;

  const exactKey = parse.normPartNo(asked);
  if (exactKey.length >= 5) {
    const r = await db.query(
      'SELECT part_no, name, brand, fitment FROM bot_parts WHERE norm_part_no = $1 AND active LIMIT 1',
      [exactKey],
      { rows: [] },
    );
    if (r && r.rows[0]) {
      await noteUsed(r.rows[0].part_no);
      return { partNo: r.rows[0].part_no, name: r.rows[0].name, similarity: 1, exact: true };
    }
  }

  const vec = await embeddings.embed(asked);
  if (!vec) return null;

  const k = opts.topK || config.parts.topK;
  const res = await db.query(
    `SELECT part_no, name, brand, fitment, 1 - (embedding <=> $1::vector) AS similarity
       FROM bot_parts
      WHERE active AND embedding IS NOT NULL
      ORDER BY embedding <=> $1::vector
      LIMIT $2`,
    [embeddings.toSqlVector(vec), k],
    { rows: [] },
  );
  const rows = (res && res.rows) || [];
  if (!rows.length) return null;

  const best = rows[0];
  const second = rows[1];
  const sim = Number(best.similarity);
  const threshold = opts.threshold || config.parts.threshold;
  if (sim < threshold) return { candidates: rows, similarity: sim, partNo: null };

  // TOO CLOSE TO CALL. Two parts within a whisker of each other is the wiper
  // case again: the right size in the wrong brand sits next to the right one.
  // A near-tie is shown, not chosen.
  if (second && sim - Number(second.similarity) < config.parts.margin) {
    return { candidates: rows, similarity: sim, partNo: null, tooClose: true };
  }

  // A CLOSE MATCH IS STILL NOT PERMISSION TO IGNORE THE BRAND.
  //
  // Nearest-neighbour will happily return a Fortuner blade for "Cartend wiper
  // blade 17 number" when no Cartrends 17 exists — it is the nearest thing in
  // the catalogue, and being nearest is not being right. So the same rule the
  // keyword path uses applies here: every distinctive word the customer said
  // has to appear somewhere in the part's name, number, brand or fitment.
  //
  // This is why the export wants a brand column. Without one, "Cartrends" is
  // nowhere in "Wiper Blade | 16 Inches | All Cars" and the customer is shown
  // the options instead — safe, but one question more than necessary.
  const availability = require('../availability');
  const trusted = availability.matchTrustworthy(asked, {
    partNo: best.part_no,
    name: [best.name, best.brand, best.fitment].filter(Boolean).join(' '),
  });
  if (!trusted) {
    store.log('parts', `"${asked.slice(0, 40)}" nearest is ${best.part_no} but it contradicts the question - showing options`);
    return { candidates: rows, similarity: sim, partNo: null, contradicts: true };
  }

  await noteUsed(best.part_no);
  return { partNo: best.part_no, name: best.name, similarity: sim, exact: false, candidates: rows };
}

async function noteUsed(partNo) {
  await db.query(
    'UPDATE bot_parts SET usage_count = usage_count + 1, last_used_at = now() WHERE part_no = $1',
    [partNo],
  );
}

async function stats() {
  const r = await db.query(
    `SELECT count(*)::int AS total,
            count(embedding)::int AS embedded,
            count(*) FILTER (WHERE usage_count > 0)::int AS used
       FROM bot_parts WHERE active`,
    [],
    { rows: [] },
  );
  return (r && r.rows[0]) || { total: 0, embedded: 0, used: 0 };
}

module.exports = { enabled, importFile, embedPending, find, stats, searchableText: parse.searchableText };
