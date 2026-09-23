'use strict';
// Structured events for the knowledge path, on top of the store's own log so
// they show up in the console at /api/logs like everything else.
//
// The point of naming the events is being able to answer, later, "why did the
// bot ask a person that?" — which needs the score it saw and the id it looked
// at, not prose.
//
// A customer's phone number identifies them to us but is also the most
// sensitive thing in the line, so it is written short: last 4 digits. Question
// TEXT is kept, because a question nobody can read is an analytics row nobody
// can act on; answers and customer names are not.
const store = require('../../store');

const EVENTS = [
  'question_received',
  'knowledge_search',
  'knowledge_match',
  'knowledge_validation',
  'knowledge_answered',
  'knowledge_not_found',
  'escalation_created',
  'prateek_answer_received',
  'knowledge_created',
  'knowledge_approved',
  'knowledge_rejected',
];

function short(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  return d ? '…' + d.slice(-4) : '-';
}

// event('knowledge_match', { customer_id, knowledge_id, score })
function event(name, fields) {
  const f = fields || {};
  const parts = [];
  if (f.customer_id) parts.push('cust=' + short(f.customer_id));
  if (f.agent_id) parts.push('agent=' + short(f.agent_id));
  if (f.conversation_id) parts.push('conv=' + String(f.conversation_id).slice(0, 24));
  if (f.escalation_id) parts.push('esc=' + f.escalation_id);
  if (f.knowledge_id) parts.push('kn=' + f.knowledge_id);
  if (f.score !== undefined && f.score !== null) parts.push('score=' + Number(f.score).toFixed(3));
  if (f.confidence !== undefined && f.confidence !== null) parts.push('conf=' + Number(f.confidence).toFixed(2));
  if (f.count !== undefined) parts.push('n=' + f.count);
  if (f.scope) parts.push('scope=' + f.scope);
  if (f.status) parts.push('status=' + f.status);
  if (f.reason) parts.push('reason=' + String(f.reason).slice(0, 80));
  if (f.question) parts.push('q="' + String(f.question).replace(/\s+/g, ' ').slice(0, 70) + '"');
  store.log('kb', name + (parts.length ? ' ' + parts.join(' ') : ''));
}

module.exports = { event, EVENTS };
