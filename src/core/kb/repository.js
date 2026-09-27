'use strict';
// Every SQL statement the knowledge base runs, and no business rules.
//
// Keeping the SQL here is what makes the scope rule enforceable: a customer's
// private pricing is filtered out in the WHERE clause of the one query that
// reads knowledge, not in a caller that somebody might write a second copy of.
const db = require('./db');
const embeddings = require('./embeddings');
const config = require('../../config');

const COLS = `id, canonical_question, answer, category, subcategory, keywords, scope,
              customer_id, agent_id, source, source_message_id, status, usage_count,
              last_used_at, supersedes_id, created_at, updated_at, approved_at, approved_by`;

// ----------------------------------------------------------------- search
//
// Nearest approved entries this asker is ALLOWED to see, by cosine distance.
//
// pgvector's <=> is cosine DISTANCE (0 = identical), so similarity is 1 - it.
// Ordering happens in SQL so the index does the work and only topK rows cross
// the wire.
//
// The scope filter is the security boundary. `customer_id` and `agent_id` are
// the asker's; a row scoped to somebody else can never match:
//   global          -> everyone
//   customer        -> only that customer
//   agent           -> only that agent
//   customer_agent  -> only that pair
async function search(vec, { customerId = null, agentId = null, topK = null } = {}) {
  if (!Array.isArray(vec) || !vec.length) return [];
  const k = topK || config.kb.topK;
  const res = await db.query(
    `SELECT ${COLS},
            1 - (embedding <=> $1::vector) AS similarity,
            CASE scope
              WHEN 'customer_agent' THEN 1
              WHEN 'customer'       THEN 2
              WHEN 'agent'          THEN 3
              ELSE 4
            END AS scope_rank
       FROM bot_knowledge
      WHERE status = 'approved'
        AND embedding IS NOT NULL
        AND (
              scope = 'global'
          OR (scope = 'customer'       AND customer_id = $2)
          OR (scope = 'agent'          AND agent_id    = $3)
          OR (scope = 'customer_agent' AND customer_id = $2 AND agent_id = $3)
        )
      ORDER BY embedding <=> $1::vector
      LIMIT $4`,
    [embeddings.toSqlVector(vec), customerId, agentId, k],
    { rows: [] },
  );
  return (res && res.rows) || [];
}

// Nearest entries regardless of who is asking — for duplicate detection while
// LEARNING, which is a different question from what a customer may be told.
async function nearest(vec, limit = 5) {
  if (!Array.isArray(vec) || !vec.length) return [];
  const res = await db.query(
    `SELECT ${COLS}, 1 - (embedding <=> $1::vector) AS similarity
       FROM bot_knowledge
      WHERE status IN ('approved', 'pending_review')
        AND embedding IS NOT NULL
      ORDER BY embedding <=> $1::vector
      LIMIT $2`,
    [embeddings.toSqlVector(vec), limit],
    { rows: [] },
  );
  return (res && res.rows) || [];
}

// ------------------------------------------------------------------ write
async function insert(entry) {
  const res = await db.query(
    `INSERT INTO bot_knowledge
       (canonical_question, answer, category, subcategory, keywords, scope, customer_id,
        agent_id, source, source_message_id, status, embedding, supersedes_id,
        approved_at, approved_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::vector,$13,$14,$15)
     RETURNING ${COLS}`,
    [
      entry.canonical_question,
      entry.answer,
      entry.category || null,
      entry.subcategory || null,
      entry.keywords || [],
      entry.scope || 'global',
      entry.customer_id || null,
      entry.agent_id || null,
      entry.source || 'prateek',
      entry.source_message_id || null,
      entry.status || 'pending_review',
      entry.embedding ? embeddings.toSqlVector(entry.embedding) : null,
      entry.supersedes_id || null,
      entry.status === 'approved' ? new Date() : null,
      entry.status === 'approved' ? entry.approved_by || null : null,
    ],
    null,
  );
  return res && res.rows[0] ? res.rows[0] : null;
}

async function byId(id) {
  const res = await db.query(`SELECT ${COLS} FROM bot_knowledge WHERE id = $1`, [id], { rows: [] });
  return res && res.rows[0] ? res.rows[0] : null;
}

async function setStatus(id, status, who) {
  const res = await db.query(
    `UPDATE bot_knowledge
        SET status = $2,
            approved_at = CASE WHEN $2 = 'approved' THEN now() ELSE approved_at END,
            approved_by = CASE WHEN $2 = 'approved' THEN $3 ELSE approved_by END,
            updated_at = now()
      WHERE id = $1
      RETURNING ${COLS}`,
    [id, status, who || null],
    null,
  );
  return res && res.rows[0] ? res.rows[0] : null;
}

// An edit can change the words, so the embedding is rewritten with them.
async function update(id, fields, vec) {
  const sets = [];
  const vals = [id];
  const put = (col, v) => {
    vals.push(v);
    sets.push(col + ' = $' + vals.length);
  };
  if (fields.canonical_question !== undefined) put('canonical_question', fields.canonical_question);
  if (fields.answer !== undefined) put('answer', fields.answer);
  if (fields.category !== undefined) put('category', fields.category);
  if (fields.subcategory !== undefined) put('subcategory', fields.subcategory);
  if (fields.keywords !== undefined) put('keywords', fields.keywords);
  if (fields.scope !== undefined) put('scope', fields.scope);
  if (fields.customer_id !== undefined) put('customer_id', fields.customer_id);
  if (fields.agent_id !== undefined) put('agent_id', fields.agent_id);
  if (vec) {
    vals.push(embeddings.toSqlVector(vec));
    sets.push('embedding = $' + vals.length + '::vector');
  }
  if (!sets.length) return byId(id);
  const res = await db.query(
    `UPDATE bot_knowledge SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING ${COLS}`,
    vals,
    null,
  );
  return res && res.rows[0] ? res.rows[0] : null;
}

// A correction, done as one unit: the old answer is archived and the new one
// recorded as replacing it. Half of this would leave two live answers to the
// same question, which is the one outcome worse than no answer.
async function supersede(oldId, entry) {
  return db.tx(async (client) => {
    await client.query(
      "UPDATE bot_knowledge SET status = 'archived', updated_at = now() WHERE id = $1",
      [oldId],
    );
    const res = await client.query(
      `INSERT INTO bot_knowledge
         (canonical_question, answer, category, subcategory, keywords, scope, customer_id,
          agent_id, source, source_message_id, status, embedding, supersedes_id,
          approved_at, approved_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::vector,$13,$14,$15)
       RETURNING ${COLS}`,
      [
        entry.canonical_question,
        entry.answer,
        entry.category || null,
        entry.subcategory || null,
        entry.keywords || [],
        entry.scope || 'global',
        entry.customer_id || null,
        entry.agent_id || null,
        entry.source || 'prateek',
        entry.source_message_id || null,
        entry.status || 'pending_review',
        entry.embedding ? embeddings.toSqlVector(entry.embedding) : null,
        oldId,
        entry.status === 'approved' ? new Date() : null,
        entry.status === 'approved' ? entry.approved_by || null : null,
      ],
    );
    return res.rows[0];
  }, null);
}

// Best-effort: a missed counter is not worth failing a customer's reply over.
async function noteUsed(id) {
  await db.query(
    'UPDATE bot_knowledge SET usage_count = usage_count + 1, last_used_at = now() WHERE id = $1',
    [id],
    null,
  );
}

async function list({ status = null, limit = 50, offset = 0 } = {}) {
  const res = await db.query(
    `SELECT ${COLS} FROM bot_knowledge
      WHERE ($1::text IS NULL OR status = $1)
      ORDER BY updated_at DESC LIMIT $2 OFFSET $3`,
    [status, limit, offset],
    { rows: [] },
  );
  return (res && res.rows) || [];
}

// Entries with no embedding yet — approved before the embedding service could
// be reached. Re-embedded in the background rather than lost.
async function needingEmbedding(limit = 20) {
  const res = await db.query(
    `SELECT ${COLS} FROM bot_knowledge
      WHERE embedding IS NULL AND status = 'approved' ORDER BY created_at LIMIT $1`,
    [limit],
    { rows: [] },
  );
  return (res && res.rows) || [];
}

async function setEmbedding(id, vec) {
  await db.query('UPDATE bot_knowledge SET embedding = $2::vector, updated_at = now() WHERE id = $1', [
    id,
    embeddings.toSqlVector(vec),
  ]);
}

// ------------------------------------------------------------ escalations
async function createEscalation(e) {
  const res = await db.query(
    `INSERT INTO bot_escalations
       (local_ref, customer_id, agent_id, conversation_id, customer_message_id, question, reason, assigned_to)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [
      e.local_ref || null,
      e.customer_id || null,
      e.agent_id || null,
      e.conversation_id || null,
      e.customer_message_id || null,
      e.question,
      e.reason || null,
      e.assigned_to || null,
    ],
    null,
  );
  return res && res.rows[0] ? res.rows[0] : null;
}

async function answerEscalation(localRef, response, responseMessageId) {
  const res = await db.query(
    `UPDATE bot_escalations
        SET prateek_response = $2, response_message_id = $3, status = 'answered', answered_at = now()
      WHERE local_ref = $1 AND status = 'pending'
      RETURNING *`,
    [String(localRef), response, responseMessageId || null],
    null,
  );
  return res && res.rows[0] ? res.rows[0] : null;
}

async function linkKnowledge(escalationId, knowledgeId) {
  await db.query(
    "UPDATE bot_escalations SET status = 'converted_to_knowledge', knowledge_id = $2 WHERE id = $1",
    [escalationId, knowledgeId],
  );
}

async function listEscalations({ status = null, limit = 50 } = {}) {
  const res = await db.query(
    `SELECT * FROM bot_escalations
      WHERE ($1::text IS NULL OR status = $1)
      ORDER BY created_at DESC LIMIT $2`,
    [status, limit],
    { rows: [] },
  );
  return (res && res.rows) || [];
}

async function escalationById(id) {
  const res = await db.query('SELECT * FROM bot_escalations WHERE id = $1', [id], { rows: [] });
  return res && res.rows[0] ? res.rows[0] : null;
}

// --------------------------------------------------------------- analytics
async function recordMiss({ question, customerId, agentId, bestScore, reason }) {
  await db.query(
    'INSERT INTO bot_knowledge_misses (question, customer_id, agent_id, best_score, reason) VALUES ($1,$2,$3,$4,$5)',
    [question, customerId || null, agentId || null, bestScore == null ? null : bestScore, reason || null],
  );
}

// Every unanswered question is a row, forever, and on a busy line that is the
// fastest-growing table here. Ninety days is what the analytics query reads,
// so ninety days is what is kept.
async function pruneMisses(days = 90) {
  const res = await db.query(
    "DELETE FROM bot_knowledge_misses WHERE created_at < now() - ($1 || ' days')::interval",
    [String(days)],
    null,
  );
  return (res && res.rowCount) || 0;
}

async function analytics() {
  const out = { unanswered: [], mostUsed: [], neverUsed: [], corrected: [] };
  const un = await db.query(
    `SELECT lower(question) AS question, count(*)::int AS times, max(created_at) AS last_at
       FROM bot_knowledge_misses
      WHERE created_at > now() - interval '90 days'
      GROUP BY lower(question) ORDER BY times DESC, last_at DESC LIMIT 20`,
    [],
    { rows: [] },
  );
  out.unanswered = (un && un.rows) || [];

  const mu = await db.query(
    `SELECT id, canonical_question, category, usage_count, last_used_at
       FROM bot_knowledge WHERE status = 'approved' AND usage_count > 0
      ORDER BY usage_count DESC LIMIT 20`,
    [],
    { rows: [] },
  );
  out.mostUsed = (mu && mu.rows) || [];

  const nu = await db.query(
    `SELECT id, canonical_question, category, created_at
       FROM bot_knowledge WHERE status = 'approved' AND usage_count = 0
      ORDER BY created_at DESC LIMIT 20`,
    [],
    { rows: [] },
  );
  out.neverUsed = (nu && nu.rows) || [];

  // Answers a person has had to fix — the sharpest signal that a piece of
  // business knowledge was written down wrong.
  const co = await db.query(
    `SELECT n.id, n.canonical_question, o.id AS replaced_id, n.created_at
       FROM bot_knowledge n JOIN bot_knowledge o ON o.id = n.supersedes_id
      ORDER BY n.created_at DESC LIMIT 20`,
    [],
    { rows: [] },
  );
  out.corrected = (co && co.rows) || [];
  return out;
}

module.exports = {
  search,
  nearest,
  insert,
  byId,
  setStatus,
  update,
  supersede,
  noteUsed,
  list,
  needingEmbedding,
  setEmbedding,
  createEscalation,
  answerEscalation,
  linkKnowledge,
  listEscalations,
  escalationById,
  recordMiss,
  pruneMisses,
  analytics,
};
