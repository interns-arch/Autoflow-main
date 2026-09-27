#!/usr/bin/env node
'use strict';
// The seven cases from the self-learning spec, run end to end.
//
// HOW THIS RUNS WITHOUT A DATABASE
// --------------------------------
// The real system is Postgres + pgvector. A developer's laptop usually has
// neither, and a test suite that only runs on one machine is a test suite
// nobody runs. So db.query/db.tx are backed here by a small in-process
// Postgres stand-in that understands exactly the statements repository.js
// issues, with cosine distance computed in JavaScript.
//
// What that does and does not prove:
//   proves      the retrieval rules, the scope boundary, duplicate detection,
//               corrections, the validator gate, and the no-invention guards
//   proves not  that the SQL text itself is valid Postgres
//
// For that, run the same file with DATABASE_URL set and the migrations
// applied: it then uses the real database and the real SQL.
//
//   npm run test:kb                     offline, stand-in database
//   DATABASE_URL=postgres://... npm run test:kb    real Postgres + pgvector
require('dotenv').config();

process.env.KNOWLEDGE_SIMILARITY_THRESHOLD = process.env.KNOWLEDGE_SIMILARITY_THRESHOLD || '0.85';
process.env.KNOWLEDGE_MIN_CONFIDENCE = process.env.KNOWLEDGE_MIN_CONFIDENCE || '0.75';
process.env.KNOWLEDGE_DUPLICATE_THRESHOLD = process.env.KNOWLEDGE_DUPLICATE_THRESHOLD || '0.93';
// A DATABASE_URL in .env means one is CONFIGURED, not that one is running.
// Decided by probing in main(), so the suite works the same on a laptop with
// no Postgres and on a machine where it is up.
let REAL_DB = false;
if (!(process.env.DATABASE_URL || '').trim()) process.env.DATABASE_URL = 'postgres://stand-in/none';
process.env.DATA_DIR = process.env.KB_TEST_DATA_DIR || require('path').join(require('os').tmpdir(), 'autoflow-kb-test');
require('fs').mkdirSync(process.env.DATA_DIR, { recursive: true });
require('fs').writeFileSync(require('path').join(process.env.DATA_DIR, 'state.json'), '{}');

const db = require('../src/core/kb/db');
const embeddings = require('../src/core/kb/embeddings');
const ai = require('../src/core/ai');

// ---------------------------------------------------------------- doubles
//
// Embeddings, deterministically. A bag-of-words vector over a fixed
// vocabulary: same words -> same direction, so paraphrases that share meaning
// score high and unrelated sentences score low, with no network call. Good
// enough to exercise thresholds; not what production uses.
// Counting shared words is NOT a usable stand-in for an embedding, and the
// first run of this suite proved it: a stored entry is question + answer +
// keywords, so it carries words the question does not, and a question that
// obviously belongs to it scored 0.82. Real embeddings put meaning first, so
// the double does too — a topic direction that dominates, with a small
// word-overlap component so two entries on one topic are not identical.
const TOPICS = {
  returns: ['return', 'returned', 'returns', 'wapas', 'refund', 'exchange', 'defect', 'defective', 'opened', 'unused', 'policy'],
  delivery: ['delivery', 'deliver', 'delivered', 'dispatch', 'ship', 'shipping', 'today', 'days', 'din', 'kab', 'when', 'transit'],
  pricing: ['discount', 'rebate', 'rate', 'price', 'mrp', 'percent', 'margin', 'account', 'special', 'cost', 'commission'],
  gst: ['gst', 'tax', 'invoice', 'bill', 'hsn', 'gstin'],
  warranty: ['warranty', 'guarantee', 'claim'],
  payment: ['payment', 'credit', 'advance', 'cheque', 'outstanding'],
};
const TOPIC_NAMES = Object.keys(TOPICS);
const LEX = [...new Set(Object.values(TOPICS).flat())];

function unit(v) {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return n ? v.map((x) => x / n) : v;
}

function fakeEmbed(text) {
  const words = String(text).toLowerCase().match(/[a-z]+/g) || [];
  const topic = TOPIC_NAMES.map((t) => words.filter((w) => TOPICS[t].includes(w)).length);
  const lex = LEX.map((w) => (words.includes(w) ? 1 : 0));
  // Topic carries the meaning; the lexical tail only separates entries that
  // share a topic. Both normalised first so neither is decided by length.
  const v = [...unit(topic), ...unit(lex).map((x) => x * 0.25)];
  if (v.every((x) => !x)) v[0] = 0.0001; // a zero vector has no direction
  // The real column is vector(768) and rejects anything else — "expected 768
  // dimensions, not 54" is what the first run against real Postgres said.
  // Zeros do not change cosine, so padding costs the comparison nothing and
  // lets the same vectors go through the real SQL.
  const want = require('../src/config').kb.embeddingDim;
  while (v.length < want) v.push(0);
  return v.slice(0, want);
}

// The relevance validator, as a rule instead of a model: the stored answer
// answers the question when they are about the same subject AND the question
// is not asking for an exception to it. That is the judgement case 6 turns on.
function fakeValidate(system, user) {
  if (/relevance|directly answers|can_answer/i.test(system)) {
    const q = (/Customer question:\n([\s\S]*?)\n\nStored question/.exec(user) || [])[1] || '';
    const sa = (/Stored answer:\n([\s\S]*)/.exec(user) || [])[1] || '';
    const subject = (s) => {
      if (/return|wapas|refund/i.test(s)) return 'returns';
      if (/deliver|ship/i.test(s)) return 'delivery';
      if (/discount|special.*rate|%/i.test(s)) return 'discount';
      if (/gst|tax/i.test(s)) return 'gst';
      return 'other';
    };
    const same = subject(q) === subject(sa) && subject(q) !== 'other';
    // "Can I get delivery TODAY?" against "delivery takes 2-3 days" is the
    // same subject and still not an answer.
    const asksException = /today|abhi|urgent|right now|aaj/i.test(q) && /\d+\s*-?\s*\d*\s*(day|din)/i.test(sa);
    const can = same && !asksException;
    return { can_answer: can, confidence: can ? 0.94 : 0.2, reason: can ? 'same subject, answered' : 'does not answer what was asked' };
  }
  // The knowledge processor.
  if (/knowledge entry|canonical_question/i.test(system)) {
    const asked = (/Customer asked:\n([\s\S]*?)\n\nManager replied/.exec(user) || [])[1] || '';
    const replied = (/Manager replied:\n([\s\S]*)/.exec(user) || [])[1] || '';
    const cat = /return|wapas/i.test(asked + replied)
      ? 'returns'
      : /deliver/i.test(asked + replied)
        ? 'delivery'
        : /discount|%/i.test(asked + replied)
          ? 'pricing'
          : 'other';
    return {
      canonical_question: asked.trim(),
      answer: replied.trim(),
      category: cat,
      subcategory: null,
      keywords: (asked + ' ' + replied).toLowerCase().match(/[a-z]+/g).slice(0, 6),
      scope: 'global',
      is_business_rule: cat === 'pricing',
    };
  }
  // The rephraser: echo the approved answer, inventing nothing.
  if (/Rewrite the approved answer|APPROVED answer/i.test(system)) {
    const appr = (/Approved answer:\n([\s\S]*)/.exec(user) || [])[1] || '';
    return { reply: appr.trim() };
  }
  return {};
}

// --------------------------------------------------- stand-in for Postgres
//
// Understands only the statements repository.js sends. Anything else throws
// loudly rather than quietly returning nothing, so a new query cannot silently
// go untested.
function standInPool() {
  const rows = [];
  const escalations = [];
  const misses = [];
  let nextId = 1;
  const parseVec = (s) => String(s).replace(/^\[|\]$/g, '').split(',').map(Number);

  return {
    async connect() {
      return {
        query: (t, p) => this.query(t, p),
        release() {},
      };
    },
    async end() {},
    on() {},
    async query(text, params) {
      const sql = String(text).replace(/\s+/g, ' ').trim();
      const P = params || [];

      if (/^BEGIN|^COMMIT|^ROLLBACK/i.test(sql)) return { rows: [] };
      if (/to_regclass/i.test(sql)) return { rows: [{ t: 'bot_knowledge' }] };
      if (/count\(\*\)::int AS n FROM bot_knowledge/i.test(sql)) {
        return { rows: [{ n: rows.filter((r) => r.status === 'approved').length }] };
      }

      // search() — approved, visible to this asker, nearest first
      if (/FROM bot_knowledge WHERE status = 'approved' AND embedding IS NOT NULL/i.test(sql)) {
        const [vecStr, customerId, agentId, limit] = P;
        const v = parseVec(vecStr);
        const visible = rows.filter((r) => {
          if (r.status !== 'approved' || !r.embedding) return false;
          if (r.scope === 'global') return true;
          if (r.scope === 'customer') return r.customer_id === customerId;
          if (r.scope === 'agent') return r.agent_id === agentId;
          if (r.scope === 'customer_agent') return r.customer_id === customerId && r.agent_id === agentId;
          return false;
        });
        const rank = { customer_agent: 1, customer: 2, agent: 3, global: 4 };
        return {
          rows: visible
            .map((r) => ({ ...r, similarity: embeddings.cosine(v, r.embedding), scope_rank: rank[r.scope] }))
            .sort((a, b) => b.similarity - a.similarity)
            .slice(0, limit),
        };
      }

      // nearest() — duplicate detection, ignores who is asking
      if (/WHERE status IN \('approved', 'pending_review'\)/i.test(sql)) {
        const v = parseVec(P[0]);
        return {
          rows: rows
            .filter((r) => r.embedding && ['approved', 'pending_review'].includes(r.status))
            .map((r) => ({ ...r, similarity: embeddings.cosine(v, r.embedding) }))
            .sort((a, b) => b.similarity - a.similarity)
            .slice(0, P[1]),
        };
      }

      if (/^INSERT INTO bot_knowledge/i.test(sql)) {
        const row = {
          id: nextId++,
          canonical_question: P[0], answer: P[1], category: P[2], subcategory: P[3], keywords: P[4],
          scope: P[5], customer_id: P[6], agent_id: P[7], source: P[8], source_message_id: P[9],
          status: P[10], embedding: P[11] ? parseVec(P[11]) : null, supersedes_id: P[12],
          approved_at: P[13], approved_by: P[14], usage_count: 0, last_used_at: null,
          created_at: new Date(), updated_at: new Date(),
        };
        rows.push(row);
        return { rows: [row] };
      }

      if (/^UPDATE bot_knowledge SET status = 'archived'/i.test(sql)) {
        const r = rows.find((x) => x.id === Number(P[0]));
        if (r) r.status = 'archived';
        return { rows: r ? [r] : [] };
      }

      if (/^UPDATE bot_knowledge SET status = \$2/i.test(sql)) {
        const r = rows.find((x) => x.id === Number(P[0]));
        if (!r) return { rows: [] };
        r.status = P[1];
        if (P[1] === 'approved') { r.approved_at = new Date(); r.approved_by = P[2]; }
        return { rows: [r] };
      }

      if (/^UPDATE bot_knowledge SET embedding/i.test(sql)) {
        const r = rows.find((x) => x.id === Number(P[0]));
        if (r) r.embedding = parseVec(P[1]);
        return { rows: r ? [r] : [] };
      }

      if (/^UPDATE bot_knowledge SET usage_count/i.test(sql)) {
        const r = rows.find((x) => x.id === Number(P[0]));
        if (r) { r.usage_count++; r.last_used_at = new Date(); }
        return { rows: r ? [r] : [] };
      }

      if (/^UPDATE bot_knowledge SET /i.test(sql)) {
        const r = rows.find((x) => x.id === Number(P[0]));
        if (!r) return { rows: [] };
        const cols = [...sql.matchAll(/(\w+) = \$(\d+)/g)];
        for (const [, col, idx] of cols) {
          if (col === 'updated_at') continue;
          const v = P[Number(idx) - 1];
          r[col] = col === 'embedding' ? parseVec(v) : v;
        }
        return { rows: [r] };
      }

      if (/embedding IS NULL AND status = 'approved'/i.test(sql)) {
        return { rows: rows.filter((r) => !r.embedding && r.status === 'approved').slice(0, P[0]) };
      }
      if (/FROM bot_knowledge WHERE \(\$1::text IS NULL OR status/i.test(sql)) {
        return { rows: rows.filter((r) => !P[0] || r.status === P[0]).slice(0, P[1]) };
      }
      if (/FROM bot_knowledge WHERE id = \$1/i.test(sql)) {
        return { rows: rows.filter((r) => r.id === Number(P[0])) };
      }

      if (/^INSERT INTO bot_escalations/i.test(sql)) {
        const row = {
          id: escalations.length + 1, local_ref: P[0], customer_id: P[1], agent_id: P[2],
          conversation_id: P[3], customer_message_id: P[4], question: P[5], reason: P[6],
          assigned_to: P[7], status: 'pending', created_at: new Date(),
        };
        escalations.push(row);
        return { rows: [row] };
      }
      if (/^UPDATE bot_escalations SET prateek_response/i.test(sql)) {
        const r = escalations.find((x) => x.local_ref === String(P[0]) && x.status === 'pending');
        if (!r) return { rows: [] };
        Object.assign(r, { prateek_response: P[1], response_message_id: P[2], status: 'answered', answered_at: new Date() });
        return { rows: [r] };
      }
      if (/^UPDATE bot_escalations SET status = 'converted_to_knowledge'/i.test(sql)) {
        const r = escalations.find((x) => x.id === Number(P[0]));
        if (r) { r.status = 'converted_to_knowledge'; r.knowledge_id = Number(P[1]); }
        return { rows: r ? [r] : [] };
      }
      if (/FROM bot_escalations WHERE \(\$1::text IS NULL/i.test(sql)) {
        return { rows: escalations.filter((e) => !P[0] || e.status === P[0]) };
      }
      if (/FROM bot_escalations WHERE id = \$1/i.test(sql)) {
        return { rows: escalations.filter((e) => e.id === Number(P[0])) };
      }
      if (/^INSERT INTO bot_knowledge_misses/i.test(sql)) {
        misses.push({ question: P[0], customer_id: P[1], best_score: P[3], reason: P[4] });
        return { rows: [] };
      }
      if (/FROM bot_knowledge_misses/i.test(sql)) {
        const byQ = new Map();
        for (const m of misses) byQ.set(m.question.toLowerCase(), (byQ.get(m.question.toLowerCase()) || 0) + 1);
        return { rows: [...byQ].map(([question, times]) => ({ question, times })) };
      }
      if (/JOIN bot_knowledge o ON o.id = n.supersedes_id/i.test(sql)) {
        return { rows: rows.filter((r) => r.supersedes_id).map((r) => ({ id: r.id, replaced_id: r.supersedes_id })) };
      }
      if (/usage_count > 0/i.test(sql)) return { rows: rows.filter((r) => r.usage_count > 0) };
      if (/usage_count = 0/i.test(sql)) return { rows: rows.filter((r) => !r.usage_count) };

      throw new Error('stand-in database got a statement it does not know: ' + sql.slice(0, 120));
    },
  };
}

// ------------------------------------------------------------------ runner
let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  PASS  ' + name);
  } catch (e) {
    failures.push({ name, error: String((e && e.message) || e) });
    console.log('  FAIL  ' + name + '\n          ' + String((e && e.message) || e));
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  // Is a real server actually there, with the schema applied?
  const probe = await db.health();
  REAL_DB = Boolean(probe && probe.ok);
  if (REAL_DB) {
    // NEVER against a database that holds real answers.
    //
    // This suite seeds invented policies — "returns within 15 days", "delivery
    // takes 2-3 days" — and on 23 Sep they were left sitting in the production
    // knowledge base, approved and searchable. A customer asking about returns
    // would have been told a policy nobody at Cartrends had ever agreed to.
    // The rows were removed; this is so it cannot happen twice.
    const existing = await db.query('SELECT count(*)::int AS n FROM bot_knowledge', [], { rows: [{ n: 0 }] });
    const n = existing && existing.rows[0] ? existing.rows[0].n : 0;
    if (n > 0 && process.env.KB_TEST_ALLOW_NONEMPTY !== 'yes') {
      console.error('\nREFUSING TO RUN: bot_knowledge already holds ' + n + ' row(s).');
      console.error('This suite writes fabricated answers and truncates tables. Point');
      console.error('DATABASE_URL at a throwaway database, or set');
      console.error('KB_TEST_ALLOW_NONEMPTY=yes if those rows are genuinely disposable.\n');
      process.exit(1);
    }
    console.log('\nRunning against REAL Postgres + pgvector — this exercises the actual SQL');
    console.log('(bot_knowledge is empty, so nothing real is at risk)\n');
  } else {
    console.log('\nRunning offline: stand-in database, fake embeddings');
    console.log('  (' + ((probe && probe.reason) || 'no database') + ')');
    console.log('  The SQL itself is therefore NOT exercised by this run.\n');
    db._setPoolForTests(standInPool());
  }

  // Deterministic embeddings and a rule-based model, so the suite tests OUR
  // logic rather than a provider's mood.
  const realEmbed = embeddings.embed;
  embeddings.embed = async (t) => fakeEmbed(t);
  embeddings.available = () => true;
  ai._model = async (system, user) => fakeValidate(system, user);
  ai.modelAvailable = () => true;

  const kb = require('../src/core/kb');

  // Seed: the approved return policy every case below leans on.
  const seeded = await kb.create({
    question: 'What is your return policy for parts?',
    answer: 'Parts can be returned within 7 days if unused. Opened parts can only be returned if there is a manufacturing defect.',
    category: 'returns',
    keywords: ['return', 'wapas', 'refund', 'policy'],
    scope: 'global',
  });
  assert(seeded, 'seed entry was not created');
  await kb.approve(seeded.id, 'test');

  // ---------------------------------------------------------------- case 1
  await test('1. known question is answered from knowledge', async () => {
    const out = await kb.answer('What is your return policy?', { customerId: '919000000001' });
    assert(out.answered, 'expected an answer, got: ' + out.reason);
    assert(/7 days/.test(out.text), 'the approved wording was not used: ' + out.text);
  });

  // ---------------------------------------------------------------- case 2
  await test('2. same question in Hinglish retrieves it, no escalation', async () => {
    const out = await kb.answer('Ye part wapas ho sakta hai?', { customerId: '919000000002' });
    assert(out.answered, 'expected the returns entry, got: ' + out.reason);
    assert(/7 days|defect/i.test(out.text), 'wrong entry returned: ' + out.text);
  });

  // ---------------------------------------------------------------- case 3
  await test('3. unknown question is NOT invented, it escalates', async () => {
    const out = await kb.answer('Can you provide a special 20% discount?', { customerId: '919000000003' });
    assert(!out.answered, 'the bot answered a question nobody has taught it: ' + out.text);
  });

  // ---------------------------------------------------------------- case 4
  await test("4. customer A's private discount is invisible to customer B", async () => {
    const priv = await kb.create({
      question: 'What discount does this account get?',
      answer: 'This account gets 10 percent discount on all parts.',
      category: 'pricing',
      keywords: ['discount', 'rate', 'account', 'percent'],
      scope: 'customer',
      customerId: '919000000004',
    });
    await kb.approve(priv.id, 'test');

    const mine = await kb.answer('What discount does this account get?', { customerId: '919000000004' });
    assert(mine.answered, 'customer A could not see their own terms');
    assert(/10 percent/.test(mine.text), 'customer A got the wrong answer: ' + mine.text);

    const theirs = await kb.answer('What discount does this account get?', { customerId: '919000000005' });
    assert(!theirs.answered, "customer B was shown customer A's discount: " + theirs.text);
  });

  // ---------------------------------------------------------------- case 5
  await test('5. escalation -> Prateek answers -> next customer served automatically', async () => {
    const q = 'Is GST invoice provided with every order?';
    const before = await kb.answer(q, { customerId: '919000000006' });
    assert(!before.answered, 'this was supposed to be unknown at the start');

    await kb.recordEscalation({ local_ref: '9001', customer_id: '919000000006', question: q, reason: 'NOT_A_PART' });
    const learned = await kb.learnFromHelper({
      question: q,
      answer: 'Yes, a GST invoice is issued with every order.',
      ctx: { localRef: '9001', customerId: '919000000006', answeredBy: 'prateek' },
      autoApprove: true,
    });
    assert(learned && learned.entry, 'nothing was learned from the answer');
    assert(learned.entry.status === 'approved', 'expected auto-approval, got ' + learned.entry.status);

    const after = await kb.answer('Do you give GST invoice?', { customerId: '919000000007' });
    assert(after.answered, 'a different customer was not served the learned answer: ' + after.reason);
    assert(/GST invoice/i.test(after.text), 'wrong text: ' + after.text);
  });

  // ---------------------------------------------------------------- case 6
  await test('6. related but not answering -> refuses to use it', async () => {
    const d = await kb.create({
      question: 'How long does delivery take?',
      answer: 'Delivery takes 2-3 days.',
      category: 'delivery',
      keywords: ['delivery', 'days', 'time', 'when'],
      scope: 'global',
    });
    await kb.approve(d.id, 'test');
    const out = await kb.answer('Can I get delivery today?', { customerId: '919000000008' });
    assert(!out.answered, 'the bot promised same-day delivery from a 2-3 day policy: ' + out.text);
  });

  // ---------------------------------------------------------------- case 7
  await test('7. a correction archives the old answer and uses the new one', async () => {
    const q = 'What is your return policy for parts?';
    const fixed = await kb.learnFromHelper({
      question: q,
      answer: 'Parts can be returned within 15 days if unused. Opened parts can only be returned if there is a manufacturing defect.',
      ctx: { customerId: '919000000009', answeredBy: 'prateek' },
      autoApprove: true,
    });
    assert(fixed && fixed.entry, 'the correction was not learned');
    assert(fixed.action === 'corrected', 'expected a correction, got: ' + fixed.action);

    const old = await kb.byId(seeded.id);
    assert(old.status === 'archived', 'the old answer is still live: ' + old.status);

    const out = await kb.answer('What is your return policy?', { customerId: '919000000010' });
    assert(out.answered, 'no answer after the correction');
    assert(/15 days/.test(out.text), 'the old answer is still being sent: ' + out.text);
    assert(!/7 days/.test(out.text), 'both answers are live at once: ' + out.text);
  });

  // ------------------------------------------------------- extra guardrails
  await test('8. duplicate phrasings do not create duplicate entries', async () => {
    const before = (await kb.list({ limit: 200 })).length;
    await kb.learnFromHelper({
      question: 'Can I return a part?',
      answer: 'Parts can be returned within 15 days if unused. Opened parts can only be returned if there is a manufacturing defect.',
      ctx: { customerId: '919000000011', answeredBy: 'prateek' },
      autoApprove: true,
    });
    const after = (await kb.list({ limit: 200 })).length;
    assert(after === before, 'a duplicate entry was created (' + before + ' -> ' + after + ')');
  });

  await test('9. the rephraser cannot invent a figure', async () => {
    const entry = { id: 999, answer: 'Maximum 10 percent discount is available on this account.' };
    ai._model = async () => ({ reply: 'Aapko 25 percent discount mil jayega.' });
    const text = await kb.phrase(entry, 'kitna discount milega?', 'sim-1');
    assert(/10 percent/.test(text), 'an invented figure was sent: ' + text);
    assert(!/25/.test(text), 'the invented figure survived: ' + text);
    ai._model = async (s, u) => fakeValidate(s, u);
  });

  await test('10. commercial terms with no customer attached wait for review', async () => {
    const out = await kb.learnFromHelper({
      question: 'What is the dealer margin on brake pads?',
      answer: 'Dealer margin on brake pads is 18 percent.',
      ctx: { answeredBy: 'prateek' }, // nobody attached
      autoApprove: true,
    });
    assert(out && out.entry, 'nothing was learned');
    assert(out.entry.status === 'pending_review', 'commercial terms went live unreviewed: ' + out.entry.status);
  });

  await test('11. a database that is down never fabricates an answer', async () => {
    const good = db.pool();
    db._setPoolForTests({
      async query() { throw new Error('connection refused'); },
      async connect() { throw new Error('connection refused'); },
      async end() {}, on() {},
    });
    const out = await kb.answer('What is your return policy?', { customerId: '919000000012' });
    assert(!out.answered, 'the bot answered from a dead database: ' + out.text);
    db._setPoolForTests(good);
  });

  embeddings.embed = realEmbed;

  console.log('\n' + passed + ' passed, ' + failures.length + ' failed\n');
  if (failures.length) process.exit(1);
}

main().catch((e) => {
  console.error('\nsuite crashed: ' + String((e && e.stack) || e));
  process.exit(1);
});
