CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  base_url TEXT NOT NULL DEFAULT '',
  variables TEXT NOT NULL DEFAULT '{}',
  next_case_number INTEGER NOT NULL DEFAULT 1,
  next_batch_number INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE test_cases (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  steps TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, number)
);

CREATE TABLE uis (
  id TEXT PRIMARY KEY,
  test_case_id TEXT NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  screenshot_key TEXT NOT NULL,
  elements TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX uis_test_case ON uis(test_case_id, created_at);

CREATE TABLE batch_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  status TEXT NOT NULL,
  trigger TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  UNIQUE (project_id, number)
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  test_case_id TEXT NOT NULL,
  test_case_number INTEGER NOT NULL,
  test_case_name TEXT NOT NULL,
  batch_run_id TEXT REFERENCES batch_runs(id) ON DELETE CASCADE,
  run_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  steps TEXT NOT NULL,
  results TEXT NOT NULL DEFAULT '[]',
  log TEXT NOT NULL DEFAULT '',
  environment TEXT NOT NULL DEFAULT '{}',
  range TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX runs_test_case ON runs(test_case_id, created_at);
CREATE INDEX runs_batch ON runs(batch_run_id, run_order);
