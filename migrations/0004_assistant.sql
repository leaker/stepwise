-- AI assistant sessions. One session is one instruction from the user: the queue consumer runs a model
-- tool loop for it and appends what happens to `events`, which the editor polls. The transcript of a test
-- case is its sessions' events, oldest session first.
CREATE TABLE assistant_sessions (
  id TEXT PRIMARY KEY,
  test_case_id TEXT NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
  -- queued | running | done | failed | aborted
  status TEXT NOT NULL,
  -- JSON array of AssistantEvent (shared/types.ts)
  events TEXT NOT NULL DEFAULT '[]',
  -- JSON AssistantUsage, or NULL until the first model turn has returned
  usage TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX assistant_sessions_test_case ON assistant_sessions(test_case_id, created_at);
