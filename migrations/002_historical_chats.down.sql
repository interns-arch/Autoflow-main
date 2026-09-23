-- Reverse of 002_historical_chats.
--
-- Aliases already written into the bot's own store (data/state.json) are NOT
-- removed: they are the bot's knowledge now, not this migration's property,
-- and a person approved them. Drop them by hand if that is really the intent.

DROP TABLE IF EXISTS historical_part_mappings;
DROP TABLE IF EXISTS historical_chat_examples;
DROP TABLE IF EXISTS historical_imports;

-- Put the source CHECK back the way 001 had it. Any row that used the extra
-- value would block this, so those are retired first.
UPDATE bot_knowledge SET status = 'archived', source = 'system'
 WHERE source = 'historical_chat';

ALTER TABLE bot_knowledge DROP CONSTRAINT IF EXISTS bot_knowledge_source_check;
ALTER TABLE bot_knowledge ADD CONSTRAINT bot_knowledge_source_check
  CHECK (source IN ('manual', 'prateek', 'system'));
