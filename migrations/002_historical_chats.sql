-- 002_historical_chats — learning from exported WhatsApp history.
--
-- ADDITIVE. Nothing in 001 is altered except the `source` CHECK on
-- bot_knowledge, which gains one more allowed value.
--
-- Three tables, because the three things have different lifetimes and
-- different trust:
--
--   historical_imports        one row per ZIP, so the same file imported twice
--                             does nothing the second time
--   historical_chat_examples  what was asked and how a person answered it.
--                             EXAMPLES, never current truth - stock, price and
--                             ETA are stripped out of them on the way in
--   historical_part_mappings  "petrol filter" -> 15410M72R00, with how many
--                             conversations said so and whether the dealer
--                             portal agrees

-- 'historical_chat' joins manual/prateek/system. A CHECK cannot be altered in
-- place, so it is dropped and rewritten with the extra value.
ALTER TABLE bot_knowledge DROP CONSTRAINT IF EXISTS bot_knowledge_source_check;
ALTER TABLE bot_knowledge ADD CONSTRAINT bot_knowledge_source_check
  CHECK (source IN ('manual', 'prateek', 'system', 'historical_chat'));

-- ------------------------------------------------------------- imports
CREATE TABLE IF NOT EXISTS historical_imports (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  file_name       TEXT        NOT NULL,
  -- sha256 of the ZIP. The whole idempotency story: same bytes, same import.
  file_hash       TEXT        NOT NULL UNIQUE,
  chats           INTEGER     NOT NULL DEFAULT 0,
  messages        INTEGER     NOT NULL DEFAULT 0,
  examples        INTEGER     NOT NULL DEFAULT 0,
  mappings        INTEGER     NOT NULL DEFAULT 0,
  duplicates      INTEGER     NOT NULL DEFAULT 0,
  stats           JSONB,
  imported_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------ examples
CREATE TABLE IF NOT EXISTS historical_chat_examples (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  import_id           BIGINT      REFERENCES historical_imports(id) ON DELETE CASCADE,
  conversation_id     TEXT        NOT NULL,   -- the chat export it came from
  message_id          TEXT,                   -- timestamp+sender, the best the export offers
  -- sha256 of question+answer. Two exports of the same chat produce the same
  -- hash, so re-importing adds nothing.
  content_hash        TEXT        NOT NULL UNIQUE,

  customer_id         TEXT,                   -- phone, when the export shows one
  employee_id         TEXT,                   -- display name, e.g. "Alam - Founder Team - Cartrend"

  customer_message    TEXT        NOT NULL,
  employee_response   TEXT        NOT NULL,
  -- The response with live numbers removed. What the bot may imitate; the
  -- original response is kept beside it only for audit.
  response_pattern    TEXT,

  normalized_part_no  TEXT,
  resolved_part_no    TEXT,
  intent              TEXT,
  employee_action     TEXT,
  category            TEXT,

  -- Examples are never global business truth. Scope still decides who may be
  -- shown one, exactly as bot_knowledge does.
  scope               TEXT        NOT NULL DEFAULT 'global'
                      CHECK (scope IN ('global', 'customer', 'agent', 'customer_agent')),

  source              TEXT        NOT NULL DEFAULT 'historical_chat',
  confidence          REAL        NOT NULL DEFAULT 0.5,
  review_status       TEXT        NOT NULL DEFAULT 'pending_review'
                      CHECK (review_status IN ('pending_review', 'approved', 'rejected', 'archived')),
  -- true when the answer quoted stock, a price or an ETA. Those examples may
  -- teach wording and intent and must never be quoted back.
  has_dynamic_facts   BOOLEAN     NOT NULL DEFAULT false,

  embedding           vector(768),
  usage_count         INTEGER     NOT NULL DEFAULT 0,
  last_used_at        TIMESTAMPTZ,
  message_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hce_embedding_idx ON historical_chat_examples
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX IF NOT EXISTS hce_status_idx   ON historical_chat_examples (review_status, scope);
CREATE INDEX IF NOT EXISTS hce_part_idx     ON historical_chat_examples (normalized_part_no);
CREATE INDEX IF NOT EXISTS hce_intent_idx   ON historical_chat_examples (intent);
CREATE INDEX IF NOT EXISTS hce_customer_idx ON historical_chat_examples (customer_id);

-- ------------------------------------------------------- part mappings
-- One row per (what customers call it -> what it actually is), NOT one row per
-- conversation that said so. 500 chats saying the same thing are one mapping
-- with evidence_count 500.
CREATE TABLE IF NOT EXISTS historical_part_mappings (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- the customer's words, lowercased ("barek oil cap"), or their shorthand
  phrase              TEXT        NOT NULL,
  normalized_phrase   TEXT        NOT NULL,
  resolved_part_no    TEXT        NOT NULL,
  normalized_part_no  TEXT        NOT NULL,

  evidence_count      INTEGER     NOT NULL DEFAULT 1,
  -- other part numbers the same words pointed at. A name with rivals is a
  -- variant family ("air filter" fits three cars), never a safe alias.
  competing_parts     JSONB       NOT NULL DEFAULT '[]',
  confidence          REAL        NOT NULL DEFAULT 0.5,

  -- Does the dealer portal actually carry this part number? The portal is the
  -- authority; a chat is only evidence.
  portal_verified     BOOLEAN,
  portal_name         TEXT,
  portal_checked_at   TIMESTAMPTZ,

  review_status       TEXT        NOT NULL DEFAULT 'pending_review'
                      CHECK (review_status IN ('pending_review', 'approved', 'rejected', 'archived')),
  -- true once it has been written into the bot's own alias store
  applied             BOOLEAN     NOT NULL DEFAULT false,

  source_conversations JSONB      NOT NULL DEFAULT '[]',
  first_seen_at       TIMESTAMPTZ,
  last_seen_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (normalized_phrase, normalized_part_no)
);

CREATE INDEX IF NOT EXISTS hpm_phrase_idx ON historical_part_mappings (normalized_phrase);
CREATE INDEX IF NOT EXISTS hpm_status_idx ON historical_part_mappings (review_status, applied);
