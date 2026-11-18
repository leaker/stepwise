-- Shared steps and data-driven tests.
--
-- A shared step is a row of test_cases with kind = 'shared', so the editor, captured screens and step
-- validation are the same code. Shared steps have their own number sequence per project (S1, S2, ...).
-- UNIQUE (project_id, number) is kept as it is: a shared step stores its number negated (S1 is -1), which
-- can never collide with test case #1. Rebuilding the table to change the constraint would cascade-delete
-- every captured screen and assistant session. The API always reports the absolute value.
ALTER TABLE test_cases ADD COLUMN kind TEXT NOT NULL DEFAULT 'test';
ALTER TABLE projects ADD COLUMN next_shared_number INTEGER NOT NULL DEFAULT 1;
CREATE INDEX test_cases_kind ON test_cases(project_id, kind, number);

-- The data table of a data-driven test case: JSON { columns: string[], rows: string[][] }, '' for none.
ALTER TABLE test_cases ADD COLUMN data TEXT NOT NULL DEFAULT '';
-- Per-row state of a data-driven run: JSON RunPattern[] (shared/types.ts). NULL for a run without a data table.
ALTER TABLE runs ADD COLUMN patterns TEXT;
