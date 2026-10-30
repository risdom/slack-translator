CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,            -- ISO time (UTC)
  kind TEXT NOT NULL,          -- bot_post, dm_in, mention, command, answer, translate, blocked, notion_sync, bad_signature, error
  actor_id TEXT, actor_name TEXT,
  channel_id TEXT, channel_name TEXT,
  text TEXT,                   -- what was said / done (truncated)
  flag TEXT                    -- why it needs a look (empty = routine)
);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
