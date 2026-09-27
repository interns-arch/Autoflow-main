'use strict';
// Two-stage retrieval: find candidates cheaply, then check the best ones
// properly. Nothing here talks to WhatsApp and nothing here writes a customer
// reply — it answers one question: "do we already know this, and may this
// person be told?"
const config = require('../../config');
const embeddings = require('./embeddings');
const repository = require('./repository');
const validator = require('./validator');
const kblog = require('./log');

// Scope priority, most specific first. A customer's own agreed terms beat the
// general policy — but priority only decides ORDER, never whether something is
// used: a more specific entry still has to clear the threshold and the
// relevance check like everything else (spec §16).
function byPriorityThenScore(a, b) {
  if (a.scope_rank !== b.scope_rank) return a.scope_rank - b.scope_rank;
  return b.similarity - a.similarity;
}

// -> { hit, entry, similarity, confidence, reason, candidates }
//
// `hit` false means: ask a person. It never means "make something up".
async function find(question, { customerId = null, agentId = null } = {}) {
  const q = String(question || '').trim();
  const miss = (reason, bestScore = null, candidates = []) => ({
    hit: false,
    entry: null,
    similarity: bestScore,
    confidence: 0,
    reason,
    candidates,
  });

  if (!q) return miss('empty question');

  const vec = await embeddings.embed(q);
  // No embedding = no search. Deliberately not a keyword fallback: a keyword
  // match dressed up as a knowledge hit is how the wrong policy reaches a
  // customer.
  if (!vec) return miss('embedding unavailable');

  const rows = await repository.search(vec, { customerId, agentId });
  kblog.event('knowledge_search', { question: q, customer_id: customerId, count: rows.length });
  if (!rows.length) return miss('nothing stored for this');

  const best = rows[0] ? Number(rows[0].similarity) : null;

  // Stage one: anything below the threshold is not a candidate at all. This is
  // what keeps the model out of the loop for the common case of a question
  // nobody has ever answered.
  const near = rows
    .filter((r) => Number(r.similarity) >= config.kb.similarityThreshold)
    .sort(byPriorityThenScore);

  if (!near.length) {
    kblog.event('knowledge_not_found', { question: q, customer_id: customerId, score: best });
    return miss('below similarity threshold', best, rows);
  }

  // Stage two: the best few, checked one at a time. Ordered by scope priority,
  // so a customer's own terms are offered to the check before the general
  // policy — and the first one the check accepts is the answer.
  for (const row of near.slice(0, 3)) {
    kblog.event('knowledge_match', {
      knowledge_id: row.id,
      score: row.similarity,
      scope: row.scope,
      customer_id: customerId,
    });
    const verdict = await validator.validate(q, row);
    kblog.event('knowledge_validation', {
      knowledge_id: row.id,
      confidence: verdict.confidence,
      reason: verdict.reason,
    });
    if (verdict.can_answer) {
      return {
        hit: true,
        entry: row,
        similarity: Number(row.similarity),
        confidence: verdict.confidence,
        reason: verdict.reason,
        candidates: near,
      };
    }
  }

  kblog.event('knowledge_not_found', { question: q, customer_id: customerId, score: best, reason: 'failed relevance check' });
  return miss('retrieved knowledge did not answer the question', best, near);
}

module.exports = { find };
