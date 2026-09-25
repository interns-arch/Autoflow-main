'use strict';
// The knowledge base, as the rest of the bot sees it.
//
// Two calls matter:
//   answer(question, ctx)   do we already know this? -> words for the customer
//   learnFromHelper(...)    a person answered; keep it for next time
//
// Everything else here is management (approve, reject, edit, archive) and
// bookkeeping. WhatsApp knows nothing about this module and this module knows
// nothing about WhatsApp.
const config = require('../../config');
const ai = require('../ai');
const db = require('./db');
const embeddings = require('./embeddings');
const repository = require('./repository');
const retrieval = require('./retrieval');
const learner = require('./learner');
const kblog = require('./log');

function enabled() {
  return db.configured();
}

// ------------------------------------------------------------------ answer
//
// Turn a stored answer into something that reads like a person wrote it, in
// the language the customer is using.
//
// The model is given the approved answer and told to rephrase it. It is not
// given the freedom to answer the question: a reply containing a number that
// is not in the stored answer is thrown away and the stored answer is sent as
// written. That is the whole defence against an invented discount.
async function phrase(entry, question, chatId) {
  const stored = String(entry.answer || '').trim();
  if (!ai.modelAvailable()) return stored;

  const system =
    'You are a WhatsApp assistant for a car-parts dealership. You are given an APPROVED answer and a customer question. ' +
    'Rewrite the approved answer as a short, polite WhatsApp reply in the customer\'s language (Hinglish if they wrote Hindi in Latin script). ' +
    'You must not add any fact, number, percentage, price, date or condition that is not in the approved answer, and you must not remove a condition. ' +
    'If the approved answer does not fully cover the question, say only what it does cover. ' +
    'Return ONLY JSON: {"reply": "..."}';

  let out = null;
  try {
    const j = await ai._model(
      system,
      'Customer question:\n' + String(question).slice(0, 500) + '\n\nApproved answer:\n' + stored,
    );
    out = j && j.reply ? String(j.reply).trim() : null;
  } catch (e) {
    return stored;
  }
  if (!out) return stored;

  // A figure the approved answer does not contain is a figure the model made
  // up. "10%" must not become "15%", and "2-3 days" must not become "today".
  const nums = (s) => (String(s).match(/\d+(?:\.\d+)?/g) || []).map(String);
  const allowed = new Set(nums(stored));
  for (const n of nums(out)) {
    if (!allowed.has(n)) {
      kblog.event('knowledge_answered', { knowledge_id: entry.id, reason: 'rephrase added a figure — sent as stored' });
      return stored;
    }
  }
  // Silence about the guarantee is better than a wrong guarantee: if the
  // rewrite is suspiciously short, the approved words go as they are.
  if (out.length < stored.length * 0.3) return stored;
  // The model was told to answer in the customer's language, so there is
  // nothing left to pick between here.
  return out;
}

// Do we already know the answer, and may this person be told it?
//
// -> { answered: true, text, entry } | { answered: false, reason }
async function answer(question, ctx = {}) {
  if (!enabled()) return { answered: false, reason: 'knowledge base not configured' };

  kblog.event('question_received', {
    question,
    customer_id: ctx.customerId,
    agent_id: ctx.agentId,
    conversation_id: ctx.chatId,
  });

  const found = await retrieval.find(question, { customerId: ctx.customerId, agentId: ctx.agentId });
  if (!found.hit) {
    // What we could not answer, so the gaps are visible later (spec §18).
    await repository.recordMiss({
      question,
      customerId: ctx.customerId,
      agentId: ctx.agentId,
      bestScore: found.similarity,
      reason: found.reason,
    });
    // The score comes back on a MISS too. /api/kb/search is the tuning tool,
    // and a miss is exactly when the number matters: "0.62, below threshold"
    // tells you to lower it, "0.81 but the check said no" tells you not to.
    // Without it the endpoint answered "no" and hid its reasoning.
    return {
      answered: false,
      reason: found.reason,
      similarity: found.similarity,
      candidates: (found.candidates || []).slice(0, 3).map((c) => ({
        id: c.id,
        similarity: Number(c.similarity),
        scope: c.scope,
        question: c.canonical_question,
      })),
    };
  }

  // ctx.raw: the approved words as stored, for a caller that writes the reply
  // itself (the agent). Everyone else gets them rephrased for the customer.
  const text = ctx.raw ? String(found.entry.answer || '').trim() : await phrase(found.entry, question, ctx.chatId);
  await repository.noteUsed(found.entry.id);
  kblog.event('knowledge_answered', {
    knowledge_id: found.entry.id,
    score: found.similarity,
    confidence: found.confidence,
    customer_id: ctx.customerId,
  });
  return { answered: true, text, entry: found.entry, similarity: found.similarity, confidence: found.confidence };
}

// ------------------------------------------------------------------- learn
//
// Called when a person has answered a question. Never throws and never blocks
// anything the customer is waiting for — the customer has already been
// answered by the time this runs.
async function learnFromHelper({ question, answer: reply, ctx = {}, sourceMessageId = null, autoApprove = true }) {
  if (!enabled()) return null;
  try {
    kblog.event('prateek_answer_received', {
      question,
      customer_id: ctx.customerId,
      escalation_id: ctx.localRef,
    });
    const out = await learner.learn({ question, answer: reply, ctx, autoApprove, sourceMessageId });
    if (!out) return null;

    // Tie the answer back to the question it came from, so the escalation log
    // shows what it produced.
    if (ctx.localRef) {
      const esc = await repository.answerEscalation(ctx.localRef, reply, sourceMessageId);
      if (esc) await repository.linkKnowledge(esc.id, out.entry.id);
    }
    return out;
  } catch (e) {
    kblog.event('knowledge_created', { reason: 'learning failed: ' + String((e && e.message) || e).slice(0, 80) });
    return null;
  }
}

// A question went to a person — recorded for analytics and for the API.
async function recordEscalation(e) {
  if (!enabled()) return null;
  try {
    const row = await repository.createEscalation(e);
    kblog.event('escalation_created', {
      escalation_id: row && row.id,
      customer_id: e.customer_id,
      question: e.question,
    });
    return row;
  } catch (_) {
    return null;
  }
}

// -------------------------------------------------------------- management
async function approve(id, who) {
  const row = await repository.setStatus(id, 'approved', who);
  if (!row) return null;
  // Approved before the embedding service could be reached: fill it in now,
  // otherwise the entry is approved but unsearchable.
  if (row) {
    const vec = await embeddings.embed(embeddings.searchableText(row));
    if (vec) await repository.setEmbedding(row.id, vec);
  }
  kblog.event('knowledge_approved', { knowledge_id: id, status: 'approved' });
  return row;
}

async function reject(id, who) {
  const row = await repository.setStatus(id, 'rejected', who);
  kblog.event('knowledge_rejected', { knowledge_id: id, status: 'rejected' });
  return row;
}

async function archive(id) {
  const row = await repository.setStatus(id, 'archived', null);
  kblog.event('knowledge_rejected', { knowledge_id: id, status: 'archived' });
  return row;
}

// An edit changes the words, so it changes the embedding too.
async function edit(id, fields) {
  const current = await repository.byId(id);
  if (!current) return null;
  const merged = { ...current, ...fields };
  const vec = await embeddings.embed(embeddings.searchableText(merged));
  return repository.update(id, fields, vec);
}

async function create({ question, answer: text, category, subcategory, keywords, scope, customerId, agentId, who }) {
  const entry = {
    canonical_question: question,
    answer: text,
    category: category || 'other',
    subcategory: subcategory || null,
    keywords: keywords || [],
    scope: scope || 'global',
    customer_id: customerId || null,
    agent_id: agentId || null,
    source: 'manual',
    status: 'pending_review',
  };
  entry.embedding = await embeddings.embed(embeddings.searchableText(entry));
  const row = await repository.insert(entry);
  if (row) kblog.event('knowledge_created', { knowledge_id: row.id, scope: row.scope, status: row.status });
  return row;
}

// Entries approved while the embedding service was down are unsearchable until
// they get one. Run at boot and hourly; silent when there is nothing to do.
async function backfillEmbeddings() {
  if (!enabled()) return 0;
  // Housekeeping rides along with the hourly pass rather than having a timer
  // of its own.
  await repository.pruneMisses(90).catch(() => {});
  if (!embeddings.available()) return 0;
  const rows = await repository.needingEmbedding(20);
  let n = 0;
  for (const row of rows) {
    const vec = await embeddings.embed(embeddings.searchableText(row));
    if (!vec) break; // the service is down; try again on the next run
    await repository.setEmbedding(row.id, vec);
    n++;
  }
  return n;
}

module.exports = {
  enabled,
  answer,
  phrase,
  learnFromHelper,
  recordEscalation,
  approve,
  reject,
  archive,
  edit,
  create,
  backfillEmbeddings,
  health: db.health,
  list: repository.list,
  byId: repository.byId,
  listEscalations: repository.listEscalations,
  escalationById: repository.escalationById,
  analytics: repository.analytics,
};
