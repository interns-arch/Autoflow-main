'use strict';
// Looking at what the history import produced, and approving it.
//
// Behind the same token as /api/kb — these endpoints decide what the bot
// tells customers, so they do not inherit the open-on-localhost assumption the
// rest of this console was built with.
const config = require('../config');
const history = require('../core/history');

function sameToken(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

function requireToken(req, res, next) {
  if (!config.kb.apiToken) {
    return res.status(503).json({ error: 'KNOWLEDGE_API_TOKEN is not set; history management is disabled' });
  }
  const header = String(req.get('authorization') || '');
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!sameToken(bearer, config.kb.apiToken)) return res.status(401).json({ error: 'unauthorized' });
  return next();
}

function wrap(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      require('../store').log('history', 'api ' + req.path + ': ' + String((e && e.message) || e).slice(0, 160));
      if (!res.headersSent) res.status(500).json({ error: 'internal error' });
    }
  };
}

function mount(app) {
  app.use('/api/history', requireToken);

  app.get('/api/history/imports', wrap(async (req, res) => res.json({ imports: await history.listImports(50) })));

  app.get(
    '/api/history/examples',
    wrap(async (req, res) =>
      res.json({
        examples: await history.listExamples({
          status: req.query.status || null,
          intent: req.query.intent || null,
          limit: Math.min(parseInt(req.query.limit, 10) || 50, 200),
          offset: parseInt(req.query.offset, 10) || 0,
        }),
      }),
    ),
  );

  app.get('/api/history/intents', wrap(async (req, res) => res.json({ intents: await history.intentCounts() })));

  app.get(
    '/api/history/mappings',
    wrap(async (req, res) =>
      res.json({
        mappings: await history.listMappings({
          status: req.query.status || null,
          applied: req.query.applied === undefined ? null : req.query.applied === 'true',
          limit: Math.min(parseInt(req.query.limit, 10) || 200, 500),
          offset: parseInt(req.query.offset, 10) || 0,
        }),
      }),
    ),
  );

  // What would the bot make of this question, from history alone? The tuning
  // view: it shows the examples and what they suggest, and deliberately does
  // NOT answer — stock and price still come from the portal.
  app.post(
    '/api/history/similar',
    wrap(async (req, res) => {
      const { question, customerId, agentId } = req.body || {};
      if (!question) return res.status(400).json({ error: 'question required' });
      res.json({ question, matches: await history.similar(question, { customerId, agentId }) });
    }),
  );

  for (const [verb, status] of [['approve', 'approved'], ['reject', 'rejected'], ['archive', 'archived']]) {
    app.post(
      '/api/history/examples/:id/' + verb,
      wrap(async (req, res) => {
        const row = await history.setExampleStatus(req.params.id, status);
        if (!row) return res.status(404).json({ error: 'not found' });
        res.json({ example: row });
      }),
    );
    app.post(
      '/api/history/mappings/:id/' + verb,
      wrap(async (req, res) => {
        const row = await history.setMappingStatus(req.params.id, status, false);
        if (!row) return res.status(404).json({ error: 'not found' });
        res.json({ mapping: row });
      }),
    );
  }

  // Write every approved mapping into the bot's own alias store. Separate from
  // approval on purpose: approving is a judgement, applying is an action.
  app.post(
    '/api/history/mappings/apply',
    wrap(async (req, res) => res.json({ applied: await history.applyApprovedMappings() })),
  );
}

module.exports = { mount };
