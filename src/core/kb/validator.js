'use strict';
// The second stage of retrieval: does the entry we found actually ANSWER the
// question that was asked?
//
// Vector search is a similarity test, not an answer test. "Delivery takes 2-3
// days" and "Can I get delivery today?" are about the same subject, share most
// of their words, and sit very close together — but the first does not answer
// the second, and sending it would be the bot inventing a delivery promise.
// So the model is used here for ONE judgement, with no freedom to write
// anything the customer will see.
const config = require('../../config');
const ai = require('../ai');
const kblog = require('./log');

const SYSTEM =
  'You decide whether a stored answer directly answers a customer question for a car-parts dealership. ' +
  'You do NOT answer the question yourself and you do NOT add information. ' +
  'Say can_answer=true ONLY when the stored answer resolves what the customer actually asked. ' +
  'If it is merely about the same topic, or answers a narrower or different question, or the customer is asking for an exception to it, say can_answer=false. ' +
  'Return ONLY JSON: {"can_answer": boolean, "confidence": number between 0 and 1, "reason": "one short sentence"}.';

// Never throws. Anything unexpected is a "no", because the cost of a wrong
// "yes" is a customer acting on an answer nobody approved.
async function validate(question, entry) {
  if (!entry) return { can_answer: false, confidence: 0, reason: 'nothing retrieved' };

  // No model configured at all. The similarity threshold is the only gate
  // left, and on its own it is not enough to promise a customer anything.
  if (!ai.modelAvailable()) {
    return { can_answer: false, confidence: 0, reason: 'no model available to check relevance' };
  }

  const user =
    'Customer question:\n' +
    String(question).slice(0, 600) +
    '\n\nStored question:\n' +
    String(entry.canonical_question || '').slice(0, 600) +
    '\n\nStored answer:\n' +
    String(entry.answer || '').slice(0, 1500);

  let j = null;
  try {
    j = await ai._claude(SYSTEM, user);
  } catch (e) {
    kblog.event('knowledge_validation', { knowledge_id: entry.id, reason: 'model error' });
    return { can_answer: false, confidence: 0, reason: 'relevance check failed' };
  }

  // A model that answers in the wrong shape is a model that did not answer.
  if (!j || typeof j !== 'object') {
    return { can_answer: false, confidence: 0, reason: 'unreadable relevance reply' };
  }
  const can = j.can_answer === true || String(j.can_answer).toLowerCase() === 'true';
  let conf = Number(j.confidence);
  // An unreadable score is NO score — which fails the minConfidence gate below
  // and sends the question to a person. Fail closed, deliberately.
  if (!Number.isFinite(conf) || conf < 0 || conf > 1) conf = 0;
  const reason = String(j.reason || '').slice(0, 200);

  return { can_answer: can && conf >= config.kb.minConfidence, confidence: conf, reason };
}

module.exports = { validate };
