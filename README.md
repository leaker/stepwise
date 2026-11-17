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
- **Devices** - a test case runs on the desktop browser (1280x800) or on an emulated phone (iPhone 15,
  Pixel 8): phone viewport, user agent, touch input and pixel ratio. Captures and runs use the test
  case's device, clicks become taps, and *Swipe* moves the page (directions are the finger's: swiping up
  shows what is further down). The built-in `${DEVICE}` variable (`desktop`, `iphone`, `pixel`) can be
  used in conditions, next to `${BASE_URL}` and `${BROWSER}`.
- **Single runs** - run a test case and watch results arrive step by step. *Run up to this step* and
  *Run only this step* run a range; every run starts in a fresh browser, so the steps before the range
  are replayed first as set-up and only the range is reported.
- **Batch runs** - run all or selected test cases of a project in order, with a summary of succeeded /
  failed / unresolved / aborted. Batch runs can be started from CI over HTTP.
- **Reports** - per-step status, duration, screenshot, error message and a console-style log.
- **Self-healing** - in batch runs, when a step's element cannot be found the engine looks for the
  closest match, continues with it and marks the run *unresolved*. Approving the repair saves the new
  locator to the test case and to the element on its captured screen (the screenshot is kept; capture
  again to refresh it); rejecting it turns the run into a failure. A decision is final.
- **Abort** for single and batch runs.
- **AI assistant** (optional) - describe a test in plain language in the editor's chat panel and the
  assistant builds the steps: it captures the pages, adds steps with the elements it found, and runs
  them to check its work. See [AI assistant](#ai-assistant).
- **Optional access code** for the whole API, and an optional allow-list of hosts tests may open.
- A small bundled sample site ("Harbor Inn") under `/demo` and a demo project that tests it, created
  with the database.

## Architecture

```
Browser (React SPA) ───────────────► Worker (Hono)              worker/index.ts
  static assets served by Workers     ├─ /api/*   JSON API      worker/api/*.ts
  Static Assets (dist/client)         ├─ /demo/*  sample site   public/demo
                                      └─ queue()  run consumer  worker/runner.ts
                                                  + assistant   worker/assistant/*.ts ──► Claude API
                                             │
        ┌──────────────┬─────────────────────┼──────────────────────┐
        ▼              ▼                     ▼                      ▼
   D1 (DB)        R2 (SHOTS)          Queue (RUN_QUEUE)      Browser Run (BROWSER)
   projects,      ui/<id>.jpg         {runId} or             Chromium driven with
   test_cases,    run/<runId>/<n>.jpg {batchRunId}           @cloudflare/playwright
   uis, runs,                         {assistantSessionId}
   batch_runs,                        one message per run,
   assistant_sessions                 batch or assistant session
```

- `shared/` - types and the command catalogue used by both the Worker and the React app.
- `worker/engine/` - the test engine. It only depends on the Playwright `Page` API.
- `worker/runner.ts` - launches browsers; captures screens; consumes the run queue.
- `worker/assistant/` - the AI assistant: prompt and tool definitions (`prompt.ts`), the agent loop
  (`loop.ts`), the tools (`tools.ts`, `steps.ts`), the Claude client (`client.ts`).
- `migrations/` - D1 schema.
- `src/` - the React app.

A capture is synchronous: the request launches a browser, captures and returns. A run is asynchronous:
`POST` inserts a `queued` row with a snapshot of the steps and sends a queue message; the consumer
executes it and writes each step result to D1 as it happens, so the UI simply polls `GET /api/runs/:id`.
A batch run is one queue message: its test cases run one after another in one browser, each in a fresh
browser context. Aborting sets the status in D1; the consumer checks it before every step. A run has
15 minutes from the moment it starts (a queue consumer invocation does not live longer either); one that
is still unfinished after that is marked failed the next time it is read, so nothing stays "running"
forever.

## How the engine works

The contract is `worker/engine/index.ts`: `captureUi(page)` and `runSteps(page, steps, options)`.

- **Detection.** `captureUi` takes a full-page screenshot and collects the visible interactive and
  text elements with their type, bounding box, a readable name such as `"Sign in" button`, and a
  *fingerprint* (tag, text, label, stable attributes, ancestor path, position). Open shadow roots are
  scanned; a checkbox or radio button hidden behind a styled label is offered at that label; a
  `<div>` or `<span>` with a click handler, tab stop or pointer cursor of its own counts as clickable.
  An element that lies under an overlay (an open menu drawer, a dialog) is left out of a capture: it
  could not be picked on the screenshot, and a click on it would hit the overlay.
- **Locator ranking.** Every element gets several candidate locators (`id=`, `css=`, `xpath=`) ordered
  from most to least stable; the first is the default and the user can pick another in the editor.
  Every locator matches exactly one element when it is captured. At run time a locator that matches
  several elements is an error ("ambiguous"), never "use the first one".
- **Auto-wait.** A missing element or a failing assertion is retried until a time limit (10 s in runs)
  before the step fails. Assertions can be set to "continue on failure". "Exists" means rendered: a
  node that is in the DOM but hidden does not exist for *Assert exists / does not exist / If exists*.
- **Self-healing.** With healing on (batch runs), a step whose locator matches nothing (or more than
  one element) is compared against the elements on the current page using the stored fingerprint. The
  best match above a threshold is used, and the step is reported as `healed` with a proposal (old and
  new locator, similarity score, before/after position) that waits for approval. A replacement must
  carry over something that identifies the element - its text, label, an attribute such as `name` or
  `href`, or its classes; for a text element, the text itself. Sitting in the same place with the same
  tag is not enough, so a different message or an unrelated button is a failure, not a repair.
  Commands that expect an element to be absent, and conditional branches, never heal.

Each step stores its own copy of its target element, so a run does not depend on the capture still existing.

## Try self-healing

The sample site has a second design: any of its pages opened with `?ui=v2` renames ids, changes the
button text and wraps the form, the way a redesign would. The demo project has a `SITE_VERSION`
variable for it, and its test case opens `${BASE_URL}/login.html${SITE_VERSION}`.

1. Open the demo project's test case in the editor, capture the login screen and add steps by clicking
   elements: input `demo@example.com` and `demo1234`, click *Sign in*, capture again after that step and
   assert the "Welcome back, Demo User" text. Run it: it succeeds.
2. In the project's *Settings*, set `SITE_VERSION` to `?ui=v2` and save.
3. A single run now fails at the first element (single runs never heal). Start a **batch run** instead:
   the steps are repaired as they go and the run ends *Needs review*.
4. Open the run, review each repair (before / after, old and new locator, similarity) and approve or
   reject it. Approved locators are written back to the test case.

## Example suite

`scripts/seed-examples.mjs` builds five test cases in the demo project through the public HTTP API, the
way a person does in the editor: save the steps, capture the screen after a step, pick elements from the
capture by name, add steps, capture again. It needs nothing but Node.

```sh
pnpm seed:examples http://localhost:5173 --run                       # local dev server
pnpm seed:examples https://stepwise.example.com --code-file ~/.stepwise-code --run
```

`--code-file` names a file that holds the access code (it is sent as a bearer token and never printed).
`--run` starts a batch run of the five cases afterwards, waits for it and prints a table; the exit code
is 1 only if a case failed or the suite could not be built (runs that were repaired by self-healing and
wait for review do not count as failures). A case whose name already exists is left alone, so the script
can be run again; a case that could not be built completely is removed again.

| Test case | What it demonstrates |
| --- | --- |
| Sign in with valid credentials | The smallest complete test: navigate, input, click, assert a text, assert the URL. |
| Sign in with a wrong password shows an error | A negative path, and picking an element (the error box) that only exists after a step. |
| Reserve a room end to end | Every kind of form field (date, number, pull-down menu, checkbox, radio button, text area), a value stored in a variable (`TOTAL`) and checked on the next page with `${TOTAL}`. |
| Conditional flow with variables | Store fixed value, If variable equals / Otherwise / End branch, If UI element exists, comments, Wait until visible, Assert variable equals. |
| Mobile: open the menu and start a reservation | An emulated iPhone 15: the navigation is behind a *Menu* button there, so the test taps Menu, then Reserve, swipes and checks the form. |

The suite also works for the self-healing walkthrough above: with `SITE_VERSION` set to `?ui=v2`, a batch
run repairs the renamed elements in all five cases and ends *Needs review*.

## AI assistant

The editor's **Assistant** button opens a chat panel. You write what the test should do ("Sign in with
the demo account and check the welcome message") and the assistant builds it in the open test case.
It is optional: without the `ANTHROPIC_API_KEY` secret the panel says it is not configured, the
assistant routes answer 503, and everything else works as before.

How it works:

- One message is one **session** (`assistant_sessions` in D1). `POST /api/test-cases/:tid/assistant`
  stores it as `queued` and sends a queue message; the work never runs inside the HTTP request. The
  queue consumer runs a tool loop against the Claude API (`claude-opus-5-5`, official
  `@anthropic-ai/sdk`) and appends every event to the session as it happens. The editor polls the
  session, shows the transcript, and reloads the steps and captured screens whenever the session
  reports something new.
- Each session is a fresh model conversation. Its first message holds the instruction, the test case's
  device and base URL, and the current steps as numbered sentences. The system prompt explains the
  product and lists the commands (generated from `shared/commands.ts`).
- The model works through six tools, executed in the Worker with the same code the HTTP API uses:

  | Tool | What it does |
  | --- | --- |
  | `get_steps` | Lists the current steps. |
  | `capture_screen` | Captures a URL, or the page after replaying steps 1..N. Stores a captured screen like the *Capture* button does and returns its elements plus a downscaled screenshot the model can see. |
  | `add_step` / `update_step` / `delete_step` | Edit the steps. An element must come from a capture of this test case, on the test case's device; the step gets the element's recommended locator and keeps the other candidates. |
  | `run_steps` | Runs all steps or a range in a fresh browser with the engine (no self-healing) and reports each step. Nothing is stored as a run. |

  Tool input is validated before anything happens (unknown command, an element that is not in that
  capture, a missing value, a URL the deployment does not allow); a rejected call goes back to the model
  as an error it can act on.
- While a session is queued or running the step list is read-only. When it ends, the editor's undo stack
  gets one entry, so a single undo removes everything the assistant did.

Safety and limits:

- The assistant opens pages only through the same target policy as captures and runs
  (`ALLOWED_HOSTS`, private addresses refused, checked again inside the browser), and its routes are
  behind the access gate like the rest of the API.
- One session at a time per test case (409 otherwise). A message is 2000 characters at most.
- A session stops after 30 model requests or 12 minutes, whichever comes first, and can be aborted;
  the steps built up to that point are kept. A session that stops responding is closed after 15 minutes.
- The model's replies cost money on your Anthropic account. Each session shows its token usage and an
  estimated cost; a typical "sign in and check" test takes about five model requests. The system prompt
  and tool definitions are prompt-cached, and a request the model's safety classifiers decline is retried
  server-side on a fallback model (`fallbacks: "default"`).
- Page content (text and a screenshot of the site under test) is sent to the Claude API. Do not point
  the assistant at pages whose content must not leave your infrastructure.

## Local development

Requirements: a current Node release and pnpm. Browser Run, D1, R2 and Queues are all simulated locally.

```sh
pnpm install
pnpm db:migrate:local     # create the local D1 database and the demo project
pnpm dev                  # http://localhost:5173
```

Other scripts: `pnpm typecheck` (app, worker and shared), `pnpm test` (Vitest), `pnpm build`.

Optional settings go in `.dev.vars` (see `.dev.vars.example`):

- `ACCESS_CODE` - when set, every `/api` route except `/api/session` needs the code: the UI asks for
  it once and keeps an HttpOnly cookie; scripts send `Authorization: Bearer <code>`.
- `ANTHROPIC_API_KEY` - enables the [AI assistant](#ai-assistant). Without it the rest of the app is
  unaffected.
- `ALLOWED_HOSTS` - comma-separated hostnames. When set, captures and navigate steps may only open
  these hosts and the app's own origin. This is checked before a browser is launched and again inside
  the browser, where every request is checked before it is sent (`worker/guard.ts`): a page or iframe on
  another host is not loaded, and a step that tries to leave the allowed hosts fails with that URL.
  Private and loopback addresses are refused the same way, with or without a list. Redirects are checked
  as they happen: the navigation is cancelled and its page is never shown, but the redirected request
  itself has already left the browser by then.

## Deploy

You need a Cloudflare account with access to Browser Run (Browser Rendering).

```sh
pnpm exec wrangler d1 create stepwise                    # copy database_id into wrangler.jsonc
pnpm exec wrangler r2 bucket create stepwise-screenshots
pnpm exec wrangler queues create stepwise-runs
pnpm db:migrate:remote
pnpm exec wrangler secret put ACCESS_CODE                # optional but recommended on a public URL
pnpm exec wrangler secret put ANTHROPIC_API_KEY          # optional: enables the AI assistant
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

- Speculation rules sent as an HTTP header (for example by Cloudflare Speed Brain) are refused inside the test browser: on Cloudflare Browser Run a mouse-down prefetch tears the browser session down. Pages behave the same, but prefetch/prerender behaviour itself cannot be tested. Inline `<script type="speculationrules">` blocks are not filtered.
- One browser type (Chromium on Browser Run); no cross-browser matrix, no parallel patterns. A batch
  runs its test cases sequentially.
- Phones are emulated in that same Chromium (viewport, user agent, touch, pixel ratio). This is mobile
  *web* testing: it is not Safari or a real device, and native mobile apps cannot be tested. A swipe is
  a scroll gesture of about 70% of the viewport, not a recorded finger path.
- A batch run executes inside a single queue consumer invocation, so very long batches can hit the
  platform's time limits; Browser Run's own concurrency and session limits apply too.
- Captures do not look inside iframes or closed shadow roots, and elements inside an open shadow
  root only get CSS locators (XPath cannot reach them).
- No users, roles, schedules, notifications, shared steps, data-driven tests, loops or visual diffs.
- A run is never retried once it has started. Only a run that could not get a browser (Browser Run's
  concurrency or rate limit) is tried again, up to three times, before it is marked failed.
- A request body may be 1 MB at most; a run may take 15 minutes at most.
- Self-healing is a similarity heuristic, not a model; every repair needs a human decision.
- The assistant builds and edits steps only: it does not rename test cases, change the device, or
  manage projects. It sees the top of a very long page in its screenshot (the element list still covers
  the whole page), and it does not remember earlier sessions beyond the steps they left behind.
- The access code is a single shared secret, not an account system.
