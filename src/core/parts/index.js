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
  if (!enabled()) throw new Error('DATABASE_URL is not set - nowhere to put the catalogue');

  const fileName = path.basename(filePath);
  const stats = {
    rowsRead: 0,
    skipped: 0,
    inserted: 0,
    updated: 0,
    embedded: 0,
    embedFailed: 0,
    header: [],
  };

  // READ IN PIECES, NOT ALL AT ONCE.
  //
  // This used to slurp the file into a string and parse every row into memory
  // before storing anything. A real export is 272,000 rows and 56 MB, and it
  // died with "JavaScript heap out of memory" inside a 512 MB container,
  // having imported nothing. Rows now go to the database as they are read, and
  // memory stays flat however big the catalogue gets.
  const hash = crypto.createHash('sha256');
  const reader = parse.rowReader();
  const seen = new Set();
  let col = null;

  const store_ = async (r) => {
    if (!col) {
      // The first row is the header. A file whose columns cannot be read is
      // refused HERE, before a quarter of a million rows go in against the
      // wrong ones.
      const h = parse.readHeader(r);
      if (h.error) throw new Error(h.error);
      col = h.col;
      stats.header = h.header;
      return;
    }
    const p = parse.rowToPart(r, col);
    if (!p || seen.has(p.normPartNo)) {
      stats.skipped++; // unusable, or the same part listed twice in one export
      return;
    }
    seen.add(p.normPartNo);
    stats.rowsRead++;
    await upsertPart(p, fileName, stats);
    if (opts.onRow && stats.rowsRead % 5000 === 0) opts.onRow(stats.rowsRead);
  };

  const stream = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 1 << 20 });
  for await (const chunk of stream) {
    hash.update(chunk, 'utf8');
    for (const r of reader.push(chunk)) await store_(r);
  }
  for (const r of reader.end()) await store_(r);

  if (!col) throw new Error('the file is empty');
  if (!stats.rowsRead) throw new Error('no usable rows. Columns seen: ' + stats.header.join(', '));

  // The import record is written AFTER the rows, because the row count is not
  // known until the file has been read.
  const res = await db.query(
    'INSERT INTO bot_parts_imports (file_name, file_hash, rows_read) VALUES ($1,$2,$3) RETURNING id',
    [fileName, hash.digest('hex'), stats.rowsRead],
    null,
  );
  const importId = res && res.rows[0] ? res.rows[0].id : null;

  // Rows first, embeddings after. A catalogue of a quarter of a million parts
  // is hours of embedding calls, and the rows are useful immediately: an exact
  // part-number lookup needs no vector at all.
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

// ONE PART, WRITTEN OR UPDATED.
//
// Keyed on the normalised part number, so a later export of the same catalogue
// updates what it carries instead of duplicating it. A row whose words changed
// loses its vector on purpose — whatever was embedded describes the old text.
async function upsertPart(p, fileName, stats) {
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
  if (!r || !r.rows[0]) return;
  if (r.rows[0].inserted) stats.inserted++;
  else stats.updated++;
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

    // A hundred at a time. One call per part would be days for a catalogue
    // this size; measured, a batch of 100 takes under two seconds.
    const vectors = await embeddings.embedBatch(rows.map((r) => r.searchable));

    // ONE round trip for the whole batch, not one per part. Writing them
    // individually meant 100,000 statements for a catalogue this size, and
    // the database round trip — not the embedding API — became the slow part.
    const ids = [];
    const vecs = [];
    for (let i = 0; i < rows.length; i++) {
      if (!vectors[i]) continue; // left for the next run rather than lost
      ids.push(rows[i].id);
      vecs.push(embeddings.toSqlVector(vectors[i]));
    }
    let stored = 0;
    if (ids.length) {
      const w = await db.query(
        `UPDATE bot_parts SET embedding = v.emb::vector
           FROM (SELECT unnest($1::bigint[]) AS id, unnest($2::text[]) AS emb) v
          WHERE bot_parts.id = v.id`,
        [ids, vecs],
        null,
      );
      stored = (w && w.rowCount) || 0;
      done += stored;
    }
    if (onProgress) onProgress(done);
    // Nothing came back at all: the service is down or the quota is spent, and
    // hammering it will not help. Stop and let the run be resumed.
    if (!stored) {
      store.log('parts', 'embedding stopped after ' + done + ' — nothing came back for the last batch');
      break;
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

// REMEMBER A PART THE BOT JUST WORKED OUT.
//
// The catalogue export fills this table in one go, but the bot also resolves
// parts the hard way every day — a portal search that came back with one row,
// a size out of a learned range, a number a person gave. Each of those cost
// something to find, and none of it was kept: the next customer to ask paid
// the same cost again.
//
// So every part the bot successfully identifies is written here with whatever
// the portal calls it, and embedded. The next question like it is a vector
// lookup instead of a search, a guess, or a message to a person.
//
// PRICE AND STOCK ARE STILL NOT STORED. Only which part it is.
//
// Never throws and never blocks a reply: the customer already has their
// answer by the time this runs.
async function remember(part) {
  if (!enabled()) return false;
  const partNo = String((part && part.partNo) || '').trim();
  if (!partNo) return false;
  const normed = parse.normPartNo(partNo);
  if (normed.length < 3) return false;

  try {
    const row = {
      partNo,
      name: String((part && part.name) || '').trim() || partNo,
      brand: (part && part.brand) || null,
      fitment: (part && part.fitment) || null,
      category: (part && part.category) || null,
    };
    const searchable = parse.searchableText(row);

    // Only embed when it is new or the words changed — a part seen fifty times
    // a day must not cost fifty embedding calls.
    const existing = await db.query(
      'SELECT id, searchable, embedding IS NOT NULL AS has_vec FROM bot_parts WHERE norm_part_no = $1',
      [normed],
      { rows: [] },
    );
    const prev = existing && existing.rows[0];
    if (prev && prev.searchable === searchable && prev.has_vec) return false;

    const vec = await embeddings.embed(searchable);
    await db.query(
      `INSERT INTO bot_parts (part_no, norm_part_no, name, brand, fitment, category, searchable, embedding, source, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::vector,'learned',true)
       ON CONFLICT (norm_part_no) DO UPDATE
         SET name = EXCLUDED.name,
             brand = COALESCE(EXCLUDED.brand, bot_parts.brand),
             fitment = COALESCE(EXCLUDED.fitment, bot_parts.fitment),
             searchable = EXCLUDED.searchable,
             embedding = COALESCE(EXCLUDED.embedding, bot_parts.embedding),
             active = true,
             updated_at = now()`,
      [partNo, normed, row.name, row.brand, row.fitment, row.category, searchable, vec ? embeddings.toSqlVector(vec) : null],
      null,
    );
    store.log('parts', 'remembered ' + partNo + (prev ? ' (updated)' : ' (new)'));
    return true;
  } catch (e) {
    store.log('parts', 'could not remember ' + partNo + ': ' + String((e && e.message) || e).slice(0, 80));
    return false;
  }
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

// The phrases customers use for a part, remembered by meaning (./aliases).
// Re-exported here so callers have one door into "which part is this?":
//
//   find(text)          the catalogue, by meaning
//   recall(text)        a phrase a person already answered, by meaning
//   rememberPhrase(...)  keep one, so nobody is asked it twice
const aliases = require('./aliases');

module.exports = {
  enabled,
  importFile,
  embedPending,
  find,
  remember,
  stats,
  searchableText: parse.searchableText,
  recall: aliases.recall,
  rememberPhrase: aliases.remember,
  aliases,
};
