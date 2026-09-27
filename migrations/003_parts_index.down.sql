-- Reverse of 003_parts_index. The catalogue is a cache of somebody else's
-- data, so dropping it loses nothing that cannot be re-imported from the
-- export.

DROP TABLE IF EXISTS bot_parts_imports;
DROP TABLE IF EXISTS bot_parts;
