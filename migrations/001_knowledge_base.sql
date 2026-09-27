-- 001_knowledge_base — the self-learning knowledge base.
--
-- ADDITIVE ONLY. This project's own data (orders, aliases, part families,
-- open escalations) lives in data/state.json and is NOT touched, moved or
-- copied by this migration. Postgres holds two new things:
--
--   bot_knowledge    verified, reusable business answers + their embeddings
--   bot_escalations  the learning record of every question a person answered
--
-- Live escalation ROUTING stays in src/core/escalation.js, which keeps its own
-- state so the bot still answers when Postgres is down. The table here is the
-- durable log the knowledge pipeline, the API and the analytics read.

CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------- knowledge
CREATE TABLE IF NOT EXISTS bot_knowledge (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  canonical_question TEXT        NOT NULL,
  answer             TEXT        NOT NULL,
  category           TEXT,
  subcategory        TEXT,
  keywords           TEXT[]      NOT NULL DEFAULT '{}',

  -- Who may be told this. A discount agreed with one dealer must never be
  -- read out to another, so scope is enforced in SQL, not in a code path
  -- somebody can forget to call.
  scope              TEXT        NOT NULL DEFAULT 'global'
                     CHECK (scope IN ('global', 'customer', 'agent', 'customer_agent')),
  customer_id        TEXT,
  agent_id           TEXT,

  source             TEXT        NOT NULL DEFAULT 'prateek'
                     CHECK (source IN ('manual', 'prateek', 'system')),
  source_message_id  TEXT,

  status             TEXT        NOT NULL DEFAULT 'pending_review'
                     CHECK (status IN ('pending_review', 'approved', 'rejected', 'archived')),

  embedding          vector(768),

  usage_count        INTEGER     NOT NULL DEFAULT 0,
  last_used_at       TIMESTAMPTZ,

  -- When this entry replaced an earlier one (a correction), so a conflicting
  -- pair is always readable as old -> new rather than two live answers.
  supersedes_id      BIGINT      REFERENCES bot_knowledge(id) ON DELETE SET NULL,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at        TIMESTAMPTZ,
  approved_by        TEXT,

  -- A scoped entry without its owner is a global answer wearing a disguise.
  CONSTRAINT bot_knowledge_scope_has_owner CHECK (
    (scope = 'global')
    OR (scope = 'customer'       AND customer_id IS NOT NULL)
    OR (scope = 'agent'          AND agent_id    IS NOT NULL)
    OR (scope = 'customer_agent' AND customer_id IS NOT NULL AND agent_id IS NOT NULL)
  )
);

-- Only approved rows are ever searched, so the vector index covers just those.
-- ivfflat needs rows present before it can be built well; it is created here
-- empty and should be REINDEXed once a few hundred entries exist.
CREATE INDEX IF NOT EXISTS bot_knowledge_embedding_idx
  ON bot_knowledge USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE INDEX IF NOT EXISTS bot_knowledge_status_scope_idx ON bot_knowledge (status, scope);
CREATE INDEX IF NOT EXISTS bot_knowledge_customer_idx     ON bot_knowledge (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS bot_knowledge_agent_idx        ON bot_knowledge (agent_id)    WHERE agent_id    IS NOT NULL;
CREATE INDEX IF NOT EXISTS bot_knowledge_category_idx     ON bot_knowledge (category);
CREATE INDEX IF NOT EXISTS bot_knowledge_keywords_idx     ON bot_knowledge USING gin (keywords);

-- ------------------------------------------------------------- escalations
CREATE TABLE IF NOT EXISTS bot_escalations (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- The id escalation.js knows this question by, so the two systems can be
  -- reconciled by hand when something looks wrong.
  local_ref           TEXT,

  customer_id         TEXT,
  agent_id            TEXT,
  conversation_id     TEXT,
  customer_message_id TEXT,

  question            TEXT        NOT NULL,
  reason              TEXT,

  status              TEXT        NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'answered', 'converted_to_knowledge', 'closed')),
  assigned_to         TEXT,

  prateek_response    TEXT,
  response_message_id TEXT,
  knowledge_id        BIGINT      REFERENCES bot_knowledge(id) ON DELETE SET NULL,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  answered_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS bot_escalations_status_idx    ON bot_escalations (status, created_at DESC);
CREATE INDEX IF NOT EXISTS bot_escalations_local_ref_idx ON bot_escalations (local_ref);
CREATE INDEX IF NOT EXISTS bot_escalations_customer_idx  ON bot_escalations (customer_id);

-- ------------------------------------------------------------- unanswered
-- Every question the bot could not answer, whether or not a person was asked.
-- This is the list that says which business knowledge is missing.
CREATE TABLE IF NOT EXISTS bot_knowledge_misses (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  question     TEXT        NOT NULL,
  customer_id  TEXT,
  agent_id     TEXT,
  best_score   REAL,
  reason       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bot_knowledge_misses_created_idx ON bot_knowledge_misses (created_at DESC);
