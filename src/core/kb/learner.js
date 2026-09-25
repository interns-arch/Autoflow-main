'use strict';
// Prateek sir's answer -> a knowledge entry the next customer can be served
// from.
//
// The model's job here is narrow: read what a person wrote and put it in a
// shape we can search. It may tidy the wording and add labels. It may NOT add
// a fact, soften a condition, or round a number — so the answer it returns is
// checked against the one that was written, and the original wins whenever
// they disagree about anything that matters.
const config = require('../../config');
const ai = require('../ai');
const embeddings = require('./embeddings');
const repository = require('./repository');
const kblog = require('./log');

// Money, terms and tax. An answer containing any of this is either a general
// policy or somebody's private commercial terms, and the difference decides
// who may be told — so it is never guessed at. See scopeFor() below.
const SENSITIVE =
  /\b(discount|rebate|less|price|rate|mrp|cost|gst|tax|hsn|warranty|guarantee|credit|payment terms|margin|commission)\b/i;

// A number with money or percent attached: "10%", "10 percent", "Rs 4500",
// "₹450/-", "4500 rupees".
//
// The word form matters as much as the sign. People type "10 percent" and
// "15 pct" constantly, and a guard that only saw "%" let a discount agreed
// with one dealer be saved as everybody's discount.
const HAS_FIGURE =
  /\d+(?:\.\d+)?\s*(?:%|percent|pct|fisdi|feesdi)|(?:rs\.?|inr|₹|rupees?)\s*\d|\d+\s*(?:rs\.?|inr|rupees?)|\b\d{3,}\b/i;

const SYSTEM =
  'You turn a manager\'s reply to a customer question into a reusable knowledge entry for a car-parts dealership. ' +
  'Return ONLY JSON: {"canonical_question": string, "answer": string, "category": string, "subcategory": string|null, "keywords": string[], "scope": "global"|"customer", "is_business_rule": boolean}. ' +
  '"canonical_question" restates what was asked in one clear neutral sentence. ' +
  '"answer" carries the manager\'s reply with the SAME meaning: keep every number, condition, exception and time period exactly as written. Do not add anything they did not say, do not remove a condition, do not make it more certain or more generous. Remove only internal remarks and staff names. ' +
  '"category" is one of: returns, warranty, delivery, payment, gst, pricing, stock, fitment, company, other. ' +
  '"keywords" are 3-8 short search terms, including Hinglish forms a customer would type. ' +
  '"scope" is "customer" when the reply is about one customer\'s own terms, price or account, otherwise "global". ' +
  '"is_business_rule" is true when the answer states money, tax, warranty or policy terms.';

// Does the structured answer still say what the person said? A model that
// drops "only if unopened" turns a conditional policy into a promise, so any
// figure present in the original must survive into the rewrite.
function keepsMeaning(original, rewritten) {
  const figures = (s) => new Set((String(s).match(/\d+(?:\.\d+)?/g) || []).map(String));
  const before = figures(original);
  const after = figures(rewritten);
  for (const n of before) if (!after.has(n)) return false;
  // A rewrite far shorter than the original has dropped something.
  if (String(rewritten).length < String(original).length * 0.4) return false;
  return true;
}

// Who may be told this.
//
// The rule that matters: a figure agreed with one dealer must never become
// everyone's figure. So an answer that states money or terms AND came from a
// conversation with a particular customer is theirs alone unless a person says
// otherwise — and if we do not even know whose conversation it was, it is held
// for review rather than published to everybody.
function scopeFor(structured, ctx) {
  const text = (structured.canonical_question || '') + ' ' + (structured.answer || '');
  const sensitive = SENSITIVE.test(text) && HAS_FIGURE.test(structured.answer || '');
  const modelSaysCustomer = structured.scope === 'customer';

  if (modelSaysCustomer || sensitive) {
    if (ctx.customerId) return { scope: 'customer', customer_id: ctx.customerId, needsReview: sensitive };
    // Commercial terms with nobody attached: not global by default.
    return { scope: 'global', customer_id: null, needsReview: true };
  }
  return { scope: 'global', customer_id: null, needsReview: false };
}

// -> structured entry, or null when the model cannot be reached or its answer
// cannot be trusted. Null means the bot still answered this customer (the
// helper's words were handled by escalation.js as before) but learned nothing,
// which is the safe direction to fail in.
async function structure(question, answer, ctx) {
  if (!ai.modelAvailable()) return null;
  let j = null;
  try {
    j = await ai._model(
      SYSTEM,
      'Customer asked:\n' + String(question).slice(0, 600) + '\n\nManager replied:\n' + String(answer).slice(0, 2000),
    );
  } catch (e) {
    kblog.event('knowledge_created', { reason: 'model error while structuring' });
    return null;
  }
  if (!j || typeof j !== 'object' || !j.answer || !j.canonical_question) return null;

  const rewritten = String(j.answer).trim();
  // The safest repair for a rewrite that lost something is the original text.
  const finalAnswer = keepsMeaning(answer, rewritten) ? rewritten : String(answer).trim();

  const structured = {
    canonical_question: String(j.canonical_question).trim().slice(0, 500),
    answer: finalAnswer,
    category: String(j.category || 'other').toLowerCase().slice(0, 40),
    subcategory: j.subcategory ? String(j.subcategory).slice(0, 40) : null,
    keywords: Array.isArray(j.keywords) ? j.keywords.map((k) => String(k).slice(0, 40)).slice(0, 8) : [],
    scope: j.scope === 'customer' ? 'customer' : 'global',
  };
  const placed = scopeFor(structured, ctx || {});
  structured.scope = placed.scope;
  structured.customer_id = placed.customer_id;
  structured._needsReview = placed.needsReview;

  // Whose salesman was in this conversation. Without it, agent_id was read
  // everywhere and written nowhere, so an agent-scoped answer could only ever
  // be created by hand through the API — the scope existed in the schema and
  // was unreachable from learning.
  //
  // A customer-scoped answer that ALSO came through a salesman belongs to that
  // pair, which is the narrowest scope and the one the retrieval order tries
  // first.
  if (ctx && ctx.agentId) {
    structured.agent_id = ctx.agentId;
    if (structured.scope === 'customer') structured.scope = 'customer_agent';
    else if (structured.scope === 'global' && placed.needsReview) structured.scope = 'agent';
  }
  return structured;
}

// Is this the same question we already have an answer to? Four phrasings of
// "can I return this" must not become four entries.
//
// Same-but-different-answer is a CORRECTION, and correcting is not the same as
// merging: the old answer is archived so the two never compete.
async function existingFor(vec, structured) {
  if (!vec) return null;
  const near = await repository.nearest(vec, 3);
  for (const row of near) {
    if (Number(row.similarity) < config.kb.duplicateThreshold) continue;
    // Different owners are different answers even when worded identically:
    // one dealer's terms must not overwrite another's.
    if ((row.customer_id || null) !== (structured.customer_id || null)) continue;
    if ((row.agent_id || null) !== (structured.agent_id || null)) continue;
    return row;
  }
  return null;
}

// The whole pipeline for one answered question.
//
// `autoApprove` is true when the person who answered IS the approver — Prateek
// sir replying on his own number. Anything else waits for a human.
//
// -> { entry, action } | null
async function learn({ question, answer, ctx = {}, autoApprove = true, sourceMessageId = null }) {
  const structured = await structure(question, answer, ctx);
  if (!structured) return null;

  const vec = await embeddings.embed(embeddings.searchableText(structured));

  const approved = autoApprove && !structured._needsReview;
  const entry = {
    canonical_question: structured.canonical_question,
    answer: structured.answer,
    category: structured.category,
    subcategory: structured.subcategory,
    keywords: structured.keywords,
    scope: structured.scope,
    customer_id: structured.customer_id || null,
    agent_id: structured.agent_id || null,
    source: 'prateek',
    source_message_id: sourceMessageId,
    status: approved ? 'approved' : 'pending_review',
    approved_by: approved ? ctx.answeredBy || 'prateek' : null,
    embedding: vec,
  };

  const existing = await existingFor(vec, structured);

  // Same question, same answer, nothing to do but keep the one we have.
  if (existing && String(existing.answer).trim() === String(entry.answer).trim()) {
    kblog.event('knowledge_created', { knowledge_id: existing.id, reason: 'already known, not duplicated' });
    return { entry: existing, action: 'unchanged' };
  }

  // Same question, different answer: a correction. Old one archived.
  if (existing) {
    const row = await repository.supersede(existing.id, entry);
    if (!row) return null;
    kblog.event('knowledge_created', {
      knowledge_id: row.id,
      scope: row.scope,
      status: row.status,
      reason: 'correction, replaced #' + existing.id,
    });
    return { entry: row, action: 'corrected', replaced: existing.id };
  }

  const row = await repository.insert(entry);
  if (!row) return null;
  kblog.event('knowledge_created', { knowledge_id: row.id, scope: row.scope, status: row.status });
  return { entry: row, action: 'created' };
}

module.exports = { learn, structure, scopeFor, keepsMeaning, existingFor };
