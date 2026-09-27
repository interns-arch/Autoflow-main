-- Reverse of 001_knowledge_base.
--
-- Drops ONLY what 001 created. The vector extension is left installed: other
-- things may use it, and dropping an extension is not this migration's to do.
-- Nothing in data/state.json is affected either way.

DROP TABLE IF EXISTS bot_knowledge_misses;
DROP TABLE IF EXISTS bot_escalations;
DROP TABLE IF EXISTS bot_knowledge;
