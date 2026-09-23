'use strict';
// SQL for the historical-chat tables, and nothing else.
const db = require('../kb/db');
const embeddings = require('../kb/embeddings');

const EX_COLS = `id, conversation_id, message_id, customer_id, employee_id, customer_message,
                 employee_response, response_pattern, normalized_part_no, resolved_part_no,
                 intent, employee_action, category, scope, source, confidence, review_status,
                 has_dynamic_facts, usage_count, last_used_at, message_at, created_at`;

const MAP_COLS = `id, phrase, normalized_phrase, resolved_part_no, normalized_part_no,
                  evidence_count, competing_parts, confidence, portal_verified, portal_name,
                  portal_checked_at, review_status, applied, source_conversations,
                  first_seen_at, last_seen_at, created_at, updated_at`;

// ------------------------------------------------------------------ imports
// The same ZIP twice does nothing the second time: the hash is UNIQUE, so the
// insert is simply skipped and the caller is told which import it was.
async function findImport(fileHash) {
  const r = await db.query('SELECT * FROM historical_imports WHERE file_hash = $1', [fileHash], { rows: [] });
  return r && r.rows[0] ? r.rows[0] : null;
}

async function createImport(fileName, fileHash) {
  const r = await db.query(
    'INSERT INTO historical_imports (file_name, file_hash) VALUES ($1,$2) ON CONFLICT (file_hash) DO NOTHING RETURNING *',
    [fileName, fileHash],
    null,
  );
  return r && r.rows[0] ? r.rows[0] : null;
}

async function finishImport(id, stats) {
  await db.query(
    `UPDATE historical_imports
        SET chats = $2, messages = $3, examples = $4, mappings = $5, duplicates = $6, stats = $7
      WHERE id = $1`,
    [id, stats.chats, stats.messages, stats.examples, stats.mappings, stats.duplicates, JSON.stringify(stats)],
  );
}

async function listImports(limit = 50) {
  const r = await db.query('SELECT * FROM historical_imports ORDER BY imported_at DESC LIMIT $1', [limit], { rows: [] });
  return (r && r.rows) || [];
}

// ----------------------------------------------------------------- examples
// -> 'inserted' | 'duplicate'
async function upsertExample(e, importId) {
  const r = await db.query(
    `INSERT INTO historical_chat_examples
       (import_id, conversation_id, message_id, content_hash, customer_id, employee_id,
        customer_message, employee_response, response_pattern, normalized_part_no,
        resolved_part_no, intent, employee_action, category, scope, confidence,
        review_status, has_dynamic_facts, embedding, message_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::vector,$20)
     ON CONFLICT (content_hash) DO NOTHING
     RETURNING id`,
    [
      importId, e.conversationId, e.messageId, e.contentHash, e.customerId || null, e.employeeId || null,
      e.customerMessage, e.employeeResponse, e.responsePattern || null, e.normalizedPartNo || null,
      e.resolvedPartNo || null, e.intent || null, e.employeeAction || null, e.category || null,
      e.scope || 'global', e.confidence == null ? 0.5 : e.confidence,
      e.reviewStatus || 'pending_review', Boolean(e.hasDynamicFacts),
      e.embedding ? embeddings.toSqlVector(e.embedding) : null,
      e.messageAt || null,
    ],
    null,
  );
  return r && r.rows[0] ? 'inserted' : 'duplicate';
}

// Nearest APPROVED examples this asker may see. Same scope rule as
// bot_knowledge — an example from one dealer's chat is not shown to another
// unless it was judged general.
async function searchExamples(vec, { customerId = null, agentId = null, limit = 5 } = {}) {
  if (!Array.isArray(vec) || !vec.length) return [];
  const r = await db.query(
    `SELECT ${EX_COLS}, 1 - (embedding <=> $1::vector) AS similarity
       FROM historical_chat_examples
      WHERE review_status = 'approved'
        AND embedding IS NOT NULL
        AND (
              scope = 'global'
          OR (scope = 'customer'       AND customer_id = $2)
          OR (scope = 'agent'          AND employee_id = $3)
          OR (scope = 'customer_agent' AND customer_id = $2 AND employee_id = $3)
        )
      ORDER BY embedding <=> $1::vector
      LIMIT $4`,
    [embeddings.toSqlVector(vec), customerId, agentId, limit],
    { rows: [] },
  );
  return (r && r.rows) || [];
}

async function listExamples({ status = null, intent = null, limit = 50, offset = 0 } = {}) {
  const r = await db.query(
    `SELECT ${EX_COLS} FROM historical_chat_examples
      WHERE ($1::text IS NULL OR review_status = $1)
        AND ($2::text IS NULL OR intent = $2)
      ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
    [status, intent, limit, offset],
    { rows: [] },
  );
  return (r && r.rows) || [];
}

async function setExampleStatus(id, status) {
  const r = await db.query(
    `UPDATE historical_chat_examples SET review_status = $2 WHERE id = $1 RETURNING ${EX_COLS}`,
    [id, status],
    null,
  );
  return r && r.rows[0] ? r.rows[0] : null;
}

async function noteExampleUsed(id) {
  await db.query(
    'UPDATE historical_chat_examples SET usage_count = usage_count + 1, last_used_at = now() WHERE id = $1',
    [id],
  );
}

async function examplesNeedingEmbedding(limit = 100) {
  const r = await db.query(
    `SELECT ${EX_COLS} FROM historical_chat_examples
      WHERE embedding IS NULL AND review_status IN ('approved','pending_review')
      ORDER BY id LIMIT $1`,
    [limit],
    { rows: [] },
  );
  return (r && r.rows) || [];
}

async function setExampleEmbedding(id, vec) {
  await db.query('UPDATE historical_chat_examples SET embedding = $2::vector WHERE id = $1', [
    id,
    embeddings.toSqlVector(vec),
  ]);
}

// ------------------------------------------------------------- part mappings
// ONE row per (phrase, part). A second import of the same chats adds evidence
// rather than rows — which is what stops 500 identical conversations becoming
// 500 knowledge entries.
async function upsertMapping(m) {
  const r = await db.query(
    `INSERT INTO historical_part_mappings
       (phrase, normalized_phrase, resolved_part_no, normalized_part_no, evidence_count,
        competing_parts, confidence, source_conversations, first_seen_at, last_seen_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (normalized_phrase, normalized_part_no) DO UPDATE
       SET evidence_count = GREATEST(historical_part_mappings.evidence_count, EXCLUDED.evidence_count),
           competing_parts = EXCLUDED.competing_parts,
           confidence      = EXCLUDED.confidence,
           source_conversations = EXCLUDED.source_conversations,
           last_seen_at    = GREATEST(historical_part_mappings.last_seen_at, EXCLUDED.last_seen_at),
           updated_at      = now()
     RETURNING ${MAP_COLS}, (xmax = 0) AS inserted`,
    [
      m.phrase, m.normalizedPhrase, m.resolvedPartNo, m.normalizedPartNo,
      m.evidenceCount || 1, JSON.stringify(m.competingParts || []), m.confidence == null ? 0.5 : m.confidence,
      JSON.stringify(m.sourceConversations || []), m.firstSeenAt || null, m.lastSeenAt || null,
    ],
    null,
  );
  return r && r.rows[0] ? r.rows[0] : null;
}

async function setMappingPortal(id, verified, name) {
  await db.query(
    'UPDATE historical_part_mappings SET portal_verified = $2, portal_name = $3, portal_checked_at = now(), updated_at = now() WHERE id = $1',
    [id, verified, name || null],
  );
}

async function setMappingStatus(id, status, applied) {
  const r = await db.query(
    `UPDATE historical_part_mappings
        SET review_status = $2,
            applied = COALESCE($3, applied),
            updated_at = now()
      WHERE id = $1 RETURNING ${MAP_COLS}`,
    [id, status, applied === undefined ? null : applied],
    null,
  );
  return r && r.rows[0] ? r.rows[0] : null;
}

async function listMappings({ status = null, applied = null, limit = 200, offset = 0 } = {}) {
  const r = await db.query(
    `SELECT ${MAP_COLS} FROM historical_part_mappings
      WHERE ($1::text IS NULL OR review_status = $1)
        AND ($2::boolean IS NULL OR applied = $2)
      ORDER BY evidence_count DESC, id LIMIT $3 OFFSET $4`,
    [status, applied, limit, offset],
    { rows: [] },
  );
  return (r && r.rows) || [];
}

async function mappingById(id) {
  const r = await db.query(`SELECT ${MAP_COLS} FROM historical_part_mappings WHERE id = $1`, [id], { rows: [] });
  return r && r.rows[0] ? r.rows[0] : null;
}

async function intentCounts() {
  const r = await db.query(
    `SELECT intent, count(*)::int AS n, count(*) FILTER (WHERE review_status = 'approved')::int AS approved
       FROM historical_chat_examples GROUP BY intent ORDER BY n DESC`,
    [],
    { rows: [] },
  );
  return (r && r.rows) || [];
}

module.exports = {
  findImport, createImport, finishImport, listImports,
  upsertExample, searchExamples, listExamples, setExampleStatus, noteExampleUsed,
  examplesNeedingEmbedding, setExampleEmbedding,
  upsertMapping, setMappingPortal, setMappingStatus, listMappings, mappingById,
  intentCounts,
};
