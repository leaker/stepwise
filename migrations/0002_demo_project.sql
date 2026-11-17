-- The demo project is created here, exactly once, instead of whenever the project list is empty:
-- deleting it is final. Its base URL is the path of the bundled sample site; a base URL that starts
-- with "/" is resolved against the deployment's own origin when it is read (see resolveBaseUrl in
-- worker/db.ts), so the project keeps working when the app moves to another port or domain.
-- SITE_VERSION is empty for the original sample site; "?ui=v2" serves its redesigned variant.
INSERT OR IGNORE INTO projects (id, name, description, base_url, variables, next_case_number, created_at)
VALUES (
  'demo',
  'Harbor Inn demo',
  'Sample project that tests the bundled Harbor Inn site. To try self-healing, set the SITE_VERSION variable to ?ui=v2 (a redesign of the same site) and start a batch run.',
  '/demo',
  '{"SITE_VERSION":""}',
  2,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);

INSERT OR IGNORE INTO test_cases (id, project_id, number, name, description, steps, created_at, updated_at)
SELECT
  'demo-sign-in',
  'demo',
  1,
  'Sign in with valid credentials',
  'Capture the login screen in the editor, then pick elements to add steps.',
  '[{"id":"demo-open-login","command":"navigate","value":"${BASE_URL}/login.html${SITE_VERSION}"}]',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE NOT EXISTS (SELECT 1 FROM test_cases WHERE project_id = 'demo');

-- Databases where the demo project was already created by an earlier version of the app.
UPDATE projects SET base_url = '/demo' WHERE id = 'demo' AND base_url LIKE 'http%/demo';
UPDATE projects SET variables = json_set(variables, '$.SITE_VERSION', '')
  WHERE id = 'demo' AND json_valid(variables) AND json_type(variables, '$.SITE_VERSION') IS NULL;
UPDATE test_cases SET steps = replace(steps, '"${BASE_URL}/login.html"', '"${BASE_URL}/login.html${SITE_VERSION}"')
  WHERE project_id = 'demo';
