'use strict';
// Knowledge-base management API.
//
// Mounted under /api/kb, NOT /api/knowledge — that path already belongs to the
// part-number alias store and other things call it.
//
// Every route here is behind a token. The rest of this console has no auth
// because it was only ever meant to be open on localhost; these routes can
// change what the bot tells customers, so they do not inherit that assumption.
const config = require('../config');
const kb = require('../core/kb');
const partAliases = require('../core/parts/aliases');

// Constant-time-ish compare, so a wrong token cannot be found a character at a
// time by timing the response.
function sameToken(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

function requireToken(req, res, next) {
  // No token configured means the endpoints are CLOSED, not open. An
  // unconfigured secret standing in for "allow everyone" is how management
  // APIs end up public.
  if (!config.kb.apiToken) {
    return res.status(503).json({ error: 'KNOWLEDGE_API_TOKEN is not set; knowledge management is disabled' });
  }
  const header = String(req.get('authorization') || '');
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!sameToken(bearer, config.kb.apiToken)) return res.status(401).json({ error: 'unauthorized' });
  return next();
}

// Errors are logged in full and reported in one word. A stack trace or a
// Postgres message in an HTTP body tells an attacker the schema.
function wrap(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      require('../store').log('kb', 'api ' + req.path + ': ' + String((e && e.message) || e).slice(0, 160));
      if (!res.headersSent) res.status(500).json({ error: 'internal error' });
    }
  };
}

function mount(app) {
  app.use('/api/kb', requireToken);
  app.use('/api/escalations', requireToken);
  // Behind the same token, and for the same reason: a phrase learned here
  // decides which part a customer is quoted.
  app.use('/api/parts', requireToken);

  app.get(
    '/api/kb/health',
    wrap(async (req, res) => res.json(await kb.health())),
  );

  // Ask the knowledge base what it would answer, without messaging anybody.
  // The tuning tool: run real customer questions through it and watch the
  // score and the verdict before touching the thresholds.
  app.post(
    '/api/kb/search',
    wrap(async (req, res) => {
      const { question, customerId, agentId } = req.body || {};
      if (!question) return res.status(400).json({ error: 'question required' });
      const out = await kb.answer(question, { customerId, agentId });
      res.json(out);
    }),
  );

  app.get(
    '/api/kb',
    wrap(async (req, res) =>
      res.json({
        knowledge: await kb.list({
          status: req.query.status || null,
          limit: Math.min(parseInt(req.query.limit, 10) || 50, 200),
          offset: parseInt(req.query.offset, 10) || 0,
        }),
      }),
    ),
  );

  app.get(
    '/api/kb/analytics',
    wrap(async (req, res) => res.json(await kb.analytics())),
  );

  app.get(
    '/api/kb/:id',
    wrap(async (req, res) => {
      const row = await kb.byId(req.params.id);
      if (!row) return res.status(404).json({ error: 'not found' });
      res.json({ knowledge: row });
    }),
  );

  app.post(
    '/api/kb',
    wrap(async (req, res) => {
      const { question, answer, category, subcategory, keywords, scope, customerId, agentId } = req.body || {};
      if (!question || !answer) return res.status(400).json({ error: 'question and answer required' });
      const row = await kb.create({ question, answer, category, subcategory, keywords, scope, customerId, agentId });
      if (!row) return res.status(503).json({ error: 'knowledge base unavailable' });
      res.status(201).json({ knowledge: row });
    }),
  );

  app.post(
    '/api/kb/:id/approve',
    wrap(async (req, res) => {
      const row = await kb.approve(req.params.id, (req.body && req.body.by) || 'api');
      if (!row) return res.status(404).json({ error: 'not found' });
      res.json({ knowledge: row });
    }),
  );

  app.post(
    '/api/kb/:id/reject',
    wrap(async (req, res) => {
      const row = await kb.reject(req.params.id, (req.body && req.body.by) || 'api');
      if (!row) return res.status(404).json({ error: 'not found' });
      res.json({ knowledge: row });
    }),
  );

  app.post(
    '/api/kb/:id/archive',
    wrap(async (req, res) => {
      const row = await kb.archive(req.params.id);
      if (!row) return res.status(404).json({ error: 'not found' });
      res.json({ knowledge: row });
    }),
  );

  app.put(
    '/api/kb/:id',
    wrap(async (req, res) => {
      const row = await kb.edit(req.params.id, req.body || {});
      if (!row) return res.status(404).json({ error: 'not found' });
      res.json({ knowledge: row });
    }),
  );

  // ---- escalations ----
  app.get(
    '/api/escalations',
    wrap(async (req, res) =>
      res.json({
        escalations: await kb.listEscalations({
          status: req.query.status || null,
          limit: Math.min(parseInt(req.query.limit, 10) || 50, 200),
        }),
      }),
    ),
  );

  app.get(
    '/api/escalations/:id',
    wrap(async (req, res) => {
      const row = await kb.escalationById(req.params.id);
      if (!row) return res.status(404).json({ error: 'not found' });
      res.json({ escalation: row });
    }),
  );

  // Answer an escalation from the console rather than over WhatsApp, and learn
  // from it exactly as if it had been answered on the phone.
  app.post(
    '/api/escalations/:id/answer',
    wrap(async (req, res) => {
      const row = await kb.escalationById(req.params.id);
      if (!row) return res.status(404).json({ error: 'not found' });
      const answer = req.body && req.body.answer;
      if (!answer) return res.status(400).json({ error: 'answer required' });
      const out = await kb.learnFromHelper({
        question: row.question,
        answer,
        ctx: { localRef: row.local_ref, customerId: row.customer_id, answeredBy: (req.body && req.body.by) || 'console' },
        autoApprove: Boolean(req.body && req.body.approve),
      });
      res.json({ learned: out });
    }),
  );

  // ------------------------------------------------- learned part phrases
  //
  // What a person's answer taught the bot, remembered by meaning
  // (core/parts/aliases). Worth looking at for two reasons: it is the record of
  // what Prateek sir no longer has to answer twice, and one wrong row here
  // answers every question that MEANS the same thing — so there is a way to
  // read them and a way to delete one.
  app.get(
    '/api/parts/aliases',
    wrap(async (req, res) =>
      res.json({
        stats: await partAliases.stats(),
        aliases: await partAliases.list(Math.min(parseInt(req.query.limit, 10) || 100, 500)),
      }),
    ),
  );

  // The tuning tool, as /api/kb/search is for the knowledge base: what WOULD be
  // recalled for these words, and how sure, without messaging anybody. A reply
  // with partNo null and a `why` is the interesting case — it says which guard
  // refused and whether the threshold is in the right place.
  app.post(
    '/api/parts/aliases/search',
    wrap(async (req, res) => {
      const phrase = req.body && req.body.phrase;
      if (!phrase) return res.status(400).json({ error: 'phrase required' });
      res.json({ recall: await partAliases.recall(phrase, { threshold: req.body.threshold }) });
    }),
  );

  app.delete(
    '/api/parts/aliases',
    wrap(async (req, res) => {
      const phrase = (req.body && req.body.phrase) || req.query.phrase;
      if (!phrase) return res.status(400).json({ error: 'phrase required' });
      const removed = await partAliases.forget(phrase);
      // The string-key alias in data/state.json is a separate store and is NOT
      // touched here; say so rather than implying the bot has forgotten
      // everything about these words.
      res.json({ removed, note: removed ? 'the exact-wording alias in state.json is separate and still stands' : 'nothing matched' });
    }),
  );
}

module.exports = { mount };
