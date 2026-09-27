'use strict';
// Stage 5 of the pipeline: Understand. ONE model call that sees the message
// and the chat around it, and returns a typed decision.
//
// Phase 3 of the pipeline review this runs in SHADOW only
// (pipeline/shadow). Its decision is written to a log next to what the gate
// chain in customerBot actually did, and nobody is answered from it. Phase 4
// routes on it once a week of live traffic says it is at least as good.
//
// Today's classifier (ai.parseCustomerMessage) sees one sentence. "haan",
// "iska rate", "2 aur 5 hata do" only mean something next to the question we
// asked, the cart and what was just discussed - so all of that goes in.
//
// Two things stay in code, because the model gets them wrong in ways that cost
// money:
//   * a message ending in "?" is never a confirm or a cancel
//   * a part number the model returns must already exist - in the message,
//     the hints, the cart or the discussion. It can pick, never invent.
const ai = require('../core/ai');
const partish = require('../core/partish');

const INTENTS = [
  'greet', 'order', 'inquiry', 'rate', 'answer', 'confirm', 'cancel', 'remove',
  'setQty', 'listEdit', 'ownAccount', 'orderStatus', 'orderFor', 'chat', 'handoff',
];
const HANDOFF = ['VOICE', 'UNREADABLE', 'DOCUMENT', 'NOT_A_PART', 'RATE'];
const TIMEOUT_MS = 30000;

let stub = null; // tests replace the model call

const SYSTEM = [
  'You are the counter person at Cartrends, an auto-parts distributor in India, reading one WhatsApp message from a',
  'customer or a salesman (English, Hindi or Hinglish). You do not reply. You decide what the message MEANS, given the',
  'chat so far, the open question we asked, the cart, and the parts just discussed.',
  '',
  'Reply ONLY with JSON:',
  '{"intent": one of ' + INTENTS.join('|') + ',',
  ' "lines": [{"item": str, "qty": int|null, "qtyMissing": bool}],',
  ' "target": [str],',
  ' "answer": {"to": str, "value": str} | null,',
  ' "orderFor": str | null,',
  ' "handoffReason": ' + HANDOFF.join('|') + ' | null,',
  ' "confidence": number 0..1,',
  ' "why": str (one short sentence)}',
  '',
  'Intents:',
  '- order: they want parts added (a part number or name, usually with a quantity). inquiry: asking stock/availability.',
  '- rate: asking price, MRP, discount or GST of a part. target = which part(s).',
  '- answer: replying to the OPEN QUESTION (a quantity, "alto wali", a number from a list, haan/nahi to a read-back).',
  '  answer.to = the open question kind, answer.value = what they said it is.',
  '- confirm: a yes to OUR confirm question. The same steps for everyone - customer, salesman, admin:',
  '    1. we show the cart list and ask "Confirm karun?" / "punch kar dun?" (open question confirmAsk)',
  '    2. a yes to that punches a DRAFT SO; we send it and ask "Sahi hai?" (open question soReview)',
  '    3. only a yes to THAT confirms the SO.',
  '  So "ok", "haan", "hn", "dedo", "bhej do", "place order" are confirm ONLY while confirmAsk or soReview is open.',
  '  With neither open the same words are chat. cancel: drop the whole order.',
  '- remove / setQty / listEdit: change lines already in the cart or a numbered list we sent. target = those parts.',
  '- orderStatus: where an order ALREADY placed stands - "so bn gya?", "order kahan hai", "dispatch hua?", "kab aayega",',
  '  "is it done?", "billed or not?". Not a new order and not chat.',
  '- ownAccount: their balance, ledger, credit, outstanding, payments.',
  '- orderFor: a salesman naming the customer he is ordering for or asking about ("Kalra ka SO bana do"). orderFor = the name.',
  '- greet: only a greeting. chat: anything else a person answers in words. handoff: only a person can deal with it.',
  '',
  'Rules:',
  '- Copy part numbers EXACTLY as they appear in the message, the hints, the cart or the discussion. Never make one up.',
  '- target holds bare part numbers ("55810M75J30"), or the item name only when that part has no number. No labels, no brackets.',
  '- "iska", "ye wala", "same", "this" point at the part just discussed. Resolve them into target.',
  '- haan / ok / theek / yes answer the open question if there is one. With no open question they are chat, not confirm.',
  '- A message ending in "?" is never confirm or cancel.',
  '- A car model, a year or a question is not an item. "brake pad swift" is one item.',
  '- qtyMissing = true when no quantity was given for that line; qty then null.',
].join('\n');

const norm = (s) => String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');

function lineText(l) {
  return [l.item, l.partNo && l.partNo !== l.item ? '(' + l.partNo + ')' : '', l.qty ? 'x' + l.qty : '', l.status || '', l.rate ? 'rate ' + l.rate : '']
    .filter(Boolean)
    .join(' ');
}

// Everything the model is told, as plain text.
function prompt(snap) {
  const out = [];
  out.push('Sender role: ' + snap.role);
  if (snap.onBehalf) out.push('Salesman is speaking for customer: ' + snap.onBehalf);
  out.push(
    'Open question: ' +
      (snap.open.length ? snap.open.map((o) => o.kind + ' (' + o.minutesAgo + ' min ago) - ' + o.about).join(' | ') : 'none'),
  );
  out.push(snap.draft && snap.draft.lines.length ? 'Cart:\n' + snap.draft.lines.map((l, i) => '  ' + (i + 1) + '. ' + lineText(l)).join('\n') : 'Cart: empty');
  out.push(snap.focus.length ? 'Just discussed: ' + snap.focus.map(lineText).join('; ') : 'Just discussed: nothing');
  out.push('Recent chat (oldest first):\n' + (snap.turns || '(none)'));
  out.push('Part-number hints read from the message: ' + (snap.hints.length ? snap.hints.join(', ') : 'none') + ' (message looks like: ' + snap.shape + ')');
  if (snap.kind !== 'text') out.push('The message is a ' + snap.kind + (snap.text ? ' with caption' : ' with no caption'));
  if (snap.quoted) out.push('They swiped to reply to one of our earlier messages.');
  out.push('Message: """' + snap.text + '"""');
  return out.join('\n\n');
}

// The model can pick, never invent - and "?" is never a yes.
function guard(raw, snap) {
  const d = raw && typeof raw === 'object' ? raw : {};
  const guards = [];
  const decision = {
    intent: INTENTS.includes(d.intent) ? d.intent : 'chat',
    lines: Array.isArray(d.lines) ? d.lines.filter((l) => l && String(l.item || '').trim()) : [],
    target: Array.isArray(d.target) ? d.target.map(String).filter((s) => s.trim()) : [],
    answer: d.answer && typeof d.answer === 'object' ? d.answer : null,
    orderFor: d.orderFor ? String(d.orderFor) : null,
    handoffReason: HANDOFF.includes(d.handoffReason) ? d.handoffReason : null,
    confidence: typeof d.confidence === 'number' ? d.confidence : null,
    why: d.why ? String(d.why).slice(0, 200) : null,
  };
  if (!INTENTS.includes(d.intent)) guards.push('unknown intent "' + String(d.intent).slice(0, 30) + '" read as chat');

  if (/\?\s*$/.test(snap.text) && (decision.intent === 'confirm' || decision.intent === 'cancel')) {
    guards.push(decision.intent + ' on a question read as chat');
    decision.intent = 'chat';
  }

  const known = norm(
    [
      snap.text,
      snap.hints.join(' '),
      // What was really said in this chat is not invented either: "Need 5pc"
      // after we wrote about 84702M69R00 means that part.
      snap.turns || '',
      ...(snap.draft ? snap.draft.lines.map((l) => l.item + ' ' + (l.partNo || '')) : []),
      ...snap.focus.map((l) => l.item + ' ' + (l.partNo || '')),
      ...snap.open.map((o) => o.about),
    ].join(' '),
  );
  const invented = (s) => {
    const p = partish.partNumber(String(s || ''));
    return Boolean(p) && known.indexOf(norm(p)) < 0;
  };
  decision.lines = decision.lines.filter((l) => {
    if (!invented(l.item)) return true;
    guards.push('dropped invented part ' + String(l.item).slice(0, 30));
    return false;
  });
  decision.target = decision.target.filter((s) => {
    if (!invented(s)) return true;
    guards.push('dropped invented target ' + s.slice(0, 30));
    return false;
  });
  return { decision, guards };
}

async function understand(snap) {
  const call = stub || ai._model;
  const t0 = Date.now();
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('model took over ' + TIMEOUT_MS / 1000 + 's')), TIMEOUT_MS);
    if (timer.unref) timer.unref();
  });
  try {
    const raw = await Promise.race([call(SYSTEM, prompt(snap)), timeout]);
    return { ...guard(raw, snap), ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  understand,
  INTENTS,
  _prompt: prompt,
  _guard: guard,
  _setModel: (fn) => {
    stub = fn || null;
  },
  _stubbed: () => Boolean(stub),
};
