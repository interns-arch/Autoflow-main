-- 004_part_aliases — the words customers use for a part, remembered by MEANING.
--
-- WHY THIS EXISTS
--
-- Prateek sir is asked for a part number, he gives it, the portal is asked what
-- it costs, the customer is answered, and the phrase is learned — as an alias
-- in data/state.json, keyed on the customer's exact words (core/knowledge).
--
-- That key is the problem. Two customers never type the same sentence:
--
--   "swift ka clutch plate chahiye"        <- what he was asked, and answered
--   "clutch plate for swift dzire 2 pcs"   <- the next customer, a week later
--
-- Lexically those share nothing a string key can use, so the second question
-- walked past the alias it should have hit, past the portal (which matches on
-- part number and phrase, not meaning) and back to Prateek sir — who answered
-- the same question a second time. That is the one thing the knowledge shift
-- was supposed to make impossible.
--
-- So every phrase a person resolves is embedded here alongside the part number
-- it turned out to be. The next question is a vector lookup: near enough to
-- something already answered, and nobody is asked again.
--
-- WHY NOT IN bot_parts
--
-- bot_parts carries what the CATALOGUE calls a part, and a catalogue re-import
-- rewrites those rows (see 003). A phrase a person taught is not catalogue
-- data, cost somebody their afternoon, and must not be overwritten by the next
-- export. It also belongs to one part number, which several phrases share.
--
-- WHAT IS DELIBERATELY NOT HERE
--
--   price, MRP, stock, ETA
--
-- Exactly as in 003: this answers WHICH PART, and the portal is then asked what
-- it costs. A cached price is a wrong price.

CREATE TABLE IF NOT EXISTS bot_part_aliases (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- The customer's own words, as they wrote them. Kept verbatim because it is
  -- what gets embedded, and because it is the evidence for why this row exists.
  phrase        TEXT        NOT NULL,
  -- Lower case, letters and digits, single spaces: the identity column, so the
  -- same phrase taught twice updates one row instead of making two.
  norm_phrase   TEXT        NOT NULL UNIQUE,

  part_no       TEXT        NOT NULL,
  norm_part_no  TEXT        NOT NULL,
  -- What the portal calls the part, when we know. Read by the brand check that
  -- guards a vector hit, and shown in the console.
  part_name     TEXT,

  -- 'helper' (a person answered), 'portal' (the catalogue answered a phrase we
  -- had not seen), 'manual'.
  source        TEXT        NOT NULL DEFAULT 'helper',
  taught_by     TEXT,

  embedding     vector(768),

  -- How often this row saved somebody a question.
  hits          INTEGER     NOT NULL DEFAULT 0,
  last_used_at  TIMESTAMPTZ,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- lists is low for the same reason as 003: the table is empty at creation.
CREATE INDEX IF NOT EXISTS bot_part_aliases_embedding_idx
  ON bot_part_aliases USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE INDEX IF NOT EXISTS bot_part_aliases_phrase_idx ON bot_part_aliases (norm_phrase);
CREATE INDEX IF NOT EXISTS bot_part_aliases_partno_idx ON bot_part_aliases (norm_part_no);
