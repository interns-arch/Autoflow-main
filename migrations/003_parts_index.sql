-- 003_parts_index — the catalogue, searchable by meaning.
--
-- WHY THIS EXISTS
--
-- 23 Sep, live: a customer asked for "Cartend wiper blade 17 number" and was
-- quoted a Fortuner blade. The portal's own search is a literal phrase match,
-- so the brand was dropped, one row came back, and one row was taken as proof.
-- Cartrends' CTWBSI26P-16 Inch was in the same catalogue the whole time —
-- nothing could get to it from the words the customer used.
--
-- So the catalogue is indexed here by MEANING: what a part is called and what
-- it fits, embedded, so "Cartend wiper blade 16 number" finds
-- "Wiper Blade | 16 Inches | All Cars | #CTWBSI26P-16".
--
-- WHAT IS DELIBERATELY NOT HERE
--
--   price, MRP, discount, stock, ETA
--
-- Those change hourly and belong to the portal. This table answers exactly one
-- question — WHICH PART is being asked about — and the portal is then asked
-- what it costs and whether we have it. A cached price is a wrong price.

CREATE TABLE IF NOT EXISTS bot_parts (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- As the catalogue spells it: "CTWBSI26P-16 Inch". Kept exactly, because
  -- this is what gets sent back to the portal.
  part_no       TEXT        NOT NULL,
  -- Letters and digits only, for matching. "CTWBSI26P-16 Inch" and
  -- "ctwbsi26p16inch" are one part. This is the identity column.
  norm_part_no  TEXT        NOT NULL UNIQUE,

  name          TEXT        NOT NULL,
  brand         TEXT,
  fitment       TEXT,                       -- which cars, when the export says
  category      TEXT,

  -- part number + name + brand + fitment, which is what gets embedded. Kept
  -- so a re-embed after a model change does not need the source file again.
  searchable    TEXT        NOT NULL,
  embedding     vector(768),

  source        TEXT        NOT NULL DEFAULT 'catalogue_export',
  source_file   TEXT,
  active        BOOLEAN     NOT NULL DEFAULT true,

  -- How often this row actually answered something, so a catalogue of a
  -- hundred thousand parts can be judged by the few hundred that matter.
  usage_count   INTEGER     NOT NULL DEFAULT 0,
  last_used_at  TIMESTAMPTZ,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- lists is deliberately low: ivfflat wants roughly sqrt(rows) lists, and this
-- table is empty at creation. REINDEX after the first full import.
CREATE INDEX IF NOT EXISTS bot_parts_embedding_idx
  ON bot_parts USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE INDEX IF NOT EXISTS bot_parts_partno_idx   ON bot_parts (norm_part_no);
CREATE INDEX IF NOT EXISTS bot_parts_brand_idx    ON bot_parts (brand);
CREATE INDEX IF NOT EXISTS bot_parts_active_idx   ON bot_parts (active) WHERE active;
-- Plain text search as the fallback when there is no embedding yet, and as a
-- cheap exact-name lookup.
CREATE INDEX IF NOT EXISTS bot_parts_name_trgm_idx ON bot_parts (lower(name));

-- One row per import, so a re-run of the same file is visible and the index
-- can be told which parts an old export no longer lists.
CREATE TABLE IF NOT EXISTS bot_parts_imports (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  file_name    TEXT        NOT NULL,
  file_hash    TEXT        NOT NULL,
  rows_read    INTEGER     NOT NULL DEFAULT 0,
  inserted     INTEGER     NOT NULL DEFAULT 0,
  updated      INTEGER     NOT NULL DEFAULT 0,
  skipped      INTEGER     NOT NULL DEFAULT 0,
  embedded     INTEGER     NOT NULL DEFAULT 0,
  stats        JSONB,
  imported_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bot_parts_imports_hash_idx ON bot_parts_imports (file_hash);
