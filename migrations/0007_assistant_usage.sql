-- What the assistant has used, one row per session, for the deployment's limits per 24 hours (sessions
-- started and estimated spend). It is a table of its own, without a foreign key, because the limits must
-- not depend on the sessions still being there: assistant_sessions rows are deleted with their test case,
-- and creating and deleting test cases is free.
CREATE TABLE assistant_usage (
  session_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0
);
CREATE INDEX assistant_usage_created_at ON assistant_usage(created_at);

-- The sessions that exist now keep counting.
INSERT INTO assistant_usage (session_id, created_at, cost_usd)
SELECT id, created_at, COALESCE(json_extract(usage, '$.costUsd'), 0) FROM assistant_sessions;
