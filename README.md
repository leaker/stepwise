# Stepwise

Stepwise is a no-code browser test automation demo that runs entirely on Cloudflare. You capture a
screen of the site under test, click the detected UI elements to build test steps, run the test in a
real browser, read a per-step report with screenshots, and review locator repairs when the site changed.

It is an original project written after studying the public documentation of a commercial no-code
test automation product, to see how much of that workflow fits on the Workers platform. It is not
affiliated with, endorsed by, or derived from the code of any such product.

## Features

- **Projects and test cases** - numbered test cases per project, a base URL and project-wide variables.
- **Screen capture** - opens a URL (or replays the test case up to a chosen step) in a real browser and
  stores a full-page screenshot together with the UI elements detected on it.
- **Steps without code** - a step is a command (click, input, select, assertions, waits, variables,
  If / Otherwise / End branch, ...) plus an element picked from a capture. The command set is in
  `shared/commands.ts`.
- **Single runs** - run a test case (or a range of its steps) and watch results arrive step by step.
- **Batch runs** - run all or selected test cases of a project in order, with a summary of succeeded /
  failed / unresolved / aborted. Batch runs can be started from CI over HTTP.
- **Reports** - per-step status, duration, screenshot, error message and a console-style log.
- **Self-healing** - in batch runs, when a step's element cannot be found the engine looks for the
  closest match, continues with it and marks the run *unresolved*. Approving the repair updates the
  test case and the stored capture; rejecting it turns the run into a failure.
- **Abort** for single and batch runs.
- **Optional access code** for the whole API, and an optional allow-list of hosts tests may open.
- A small bundled sample site ("Harbor Inn") under `/demo` and a demo project created on first visit.

## Architecture

```
Browser (React SPA) ───────────────► Worker (Hono)              worker/index.ts
  static assets served by Workers     ├─ /api/*   JSON API      worker/api/*.ts
  Static Assets (dist/client)         ├─ /demo/*  sample site   public/demo
                                      └─ queue()  run consumer  worker/runner.ts
                                             │
        ┌──────────────┬─────────────────────┼──────────────────────┐
        ▼              ▼                     ▼                      ▼
   D1 (DB)        R2 (SHOTS)          Queue (RUN_QUEUE)      Browser Run (BROWSER)
   projects,      ui/<id>.jpg         {runId} or             Chromium driven with
   test_cases,    run/<runId>/<n>.jpg {batchRunId}           @cloudflare/playwright
   uis, runs,                         one message per run
   batch_runs                         or per batch
```

- `shared/` - types and the command catalogue used by both the Worker and the React app.
- `worker/engine/` - the test engine. It only depends on the Playwright `Page` API.
- `worker/runner.ts` - launches browsers; captures screens; consumes the run queue.
- `migrations/` - D1 schema.
- `src/` - the React app.

A capture is synchronous: the request launches a browser, captures and returns. A run is asynchronous:
`POST` inserts a `queued` row with a snapshot of the steps and sends a queue message; the consumer
executes it and writes each step result to D1 as it happens, so the UI simply polls `GET /api/runs/:id`.
A batch run is one queue message: its test cases run one after another in one browser, each in a fresh
browser context. Aborting sets the status in D1; the consumer checks it before every step. A run that
shows no progress for 15 minutes is marked failed the next time it is read, so nothing stays "running"
forever.

## How the engine works

The contract is `worker/engine/index.ts`: `captureUi(page)` and `runSteps(page, steps, options)`.

- **Detection.** `captureUi` takes a full-page screenshot and collects the visible interactive and
  text elements with their type, bounding box, a readable name such as `"Sign in" button`, and a
  *fingerprint* (tag, text, label, stable attributes, ancestor path, position).
- **Locator ranking.** Every element gets several candidate locators (`id=`, `css=`, `xpath=`) ordered
  from most to least stable; the first is the default and the user can pick another in the editor.
- **Auto-wait.** A missing element or a failing assertion is retried until a time limit (10 s in runs)
  before the step fails. Assertions can be set to "continue on failure".
- **Self-healing.** With healing on (batch runs), a step whose locator matches nothing is compared
  against the elements on the current page using the stored fingerprint. The best match above a
  threshold is used, and the step is reported as `healed` with a proposal (old and new locator,
  similarity score, before/after position) that waits for approval. Commands that expect an element to
  be absent, and conditional branches, never heal.

Each step stores its own copy of its target element, so a run does not depend on the capture still existing.

## Local development

Requirements: a current Node release and pnpm. Browser Run, D1, R2 and Queues are all simulated locally.

```sh
pnpm install
pnpm db:migrate:local     # create the local D1 database
pnpm dev                  # http://localhost:5173
```

Other scripts: `pnpm typecheck` (app, worker and shared), `pnpm test` (Vitest), `pnpm build`.

Optional settings go in `.dev.vars` (see `.dev.vars.example`):

- `ACCESS_CODE` - when set, every `/api` route except `/api/session` needs the code: the UI asks for
  it once and keeps an HttpOnly cookie; scripts send `Authorization: Bearer <code>`.
- `ALLOWED_HOSTS` - comma-separated hostnames. When set, captures and navigate steps may only open
  these hosts and the app's own origin. This is checked before a browser is launched and enforced
  again inside the browser for URLs that are built at run time.

## Deploy

You need a Cloudflare account with access to Browser Run (Browser Rendering).

```sh
pnpm exec wrangler d1 create stepwise                    # copy database_id into wrangler.jsonc
pnpm exec wrangler r2 bucket create stepwise-screenshots
pnpm exec wrangler queues create stepwise-runs
pnpm db:migrate:remote
pnpm exec wrangler secret put ACCESS_CODE                # optional but recommended on a public URL
pnpm run deploy
```

Anyone who can reach an ungated deployment can make it open arbitrary URLs in a browser on your
account, so set `ACCESS_CODE`, `ALLOWED_HOSTS` (under `vars` in `wrangler.jsonc`), or both.

## Triggering a batch run from CI

```sh
BASE=https://stepwise.example.workers.dev
PROJECT=<project id>
AUTH="Authorization: Bearer $STEPWISE_ACCESS_CODE"   # omit when no access code is set

id=$(curl -fsS -X POST "$BASE/api/projects/$PROJECT/batch-runs" \
  -H "$AUTH" -H 'content-type: application/json' \
  -d '{"trigger":"api"}' | jq -r .id)

while :; do
  status=$(curl -fsS -H "$AUTH" "$BASE/api/batch-runs/$id" | jq -r .status)
  case "$status" in queued|running) sleep 5 ;; *) break ;; esac
done

echo "Batch run finished: $status  ($BASE/api/batch-runs/$id)"
[ "$status" = succeeded ]   # failed, unresolved and aborted fail the job
```

Pass `"testCaseIds": ["...", "..."]` to run a subset. The full HTTP API is documented at the bottom of
`shared/types.ts`.

## Limits and non-goals

- One browser type (Chromium on Browser Run) at a fixed 1280x800 viewport; no mobile apps, no
  cross-browser matrix, no parallel patterns. A batch runs its test cases sequentially.
- A batch run executes inside a single queue consumer invocation, so very long batches can hit the
  platform's time limits; Browser Run's own concurrency and session limits apply too.
- No users, roles, schedules, notifications, shared steps, data-driven tests, loops or visual diffs.
- Runs are not retried automatically.
- Self-healing is a similarity heuristic, not a model; every repair needs a human decision.
- The access code is a single shared secret, not an account system.
