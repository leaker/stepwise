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
- **Shared steps** - a named sequence of steps (S1, S2, ...) kept once per project and called from any
  number of test cases with the *Shared step* command, also inside an If block. Editing it changes every
  test case that calls it. A shared step opens in the same editor (captures, element picking, the
  assistant) and can be run by itself for debugging. In the editor a call shows the shared step's name,
  expands to preview its steps and links to it; *Move to a new shared step* in a step's menu turns the
  selected steps (Shift+click or Shift+arrow keys to select several) into one. The project page lists
  the shared steps with the test cases that use each; one that is in use cannot be deleted.
- **Data-driven tests** - a test case can have a data table: named columns and rows of text. A run then
  executes the steps once per row (a *pattern*), one after the other, each in a fresh browser, and goes
  on after a row that failed; `${COLUMN}` in a step reads that row's cell. The table is edited in a grid
  on the test case page or from the editor's *Data* button: add, rename and remove columns and rows,
  paste a block copied from a spreadsheet, or import a `.csv` file whose first row names the columns. The
  run page has one tab per pattern with its own status, screenshots, log and repairs; a batch run counts
  the test case once and shows "2 of 3 patterns passed". *Run up to this step*, *Run only this step* and
  captures use one row, chosen in the editor.
- **Devices** - a test case runs on the desktop browser (1280x800) or on an emulated phone (iPhone 15,
  Pixel 8): phone viewport, user agent, touch input and pixel ratio. Captures and runs use the test
  case's device, clicks become taps, and *Swipe* moves the page (directions are the finger's: swiping up
  shows what is further down). The built-in `${DEVICE}` variable (`desktop`, `iphone`, `pixel`) can be
  used in conditions, next to `${BASE_URL}` and `${BROWSER}`; these three names cannot be used for
  project variables.
- **Single runs** - run a test case and watch results arrive step by step. *Run up to this step* and
  *Run only this step* run a range; every run starts in a fresh browser, so the steps before the range
  are replayed first as set-up and only the range is reported.
- **Batch runs** - run all or selected test cases of a project in order, with a summary of succeeded /
  failed / unresolved / aborted. Batch runs can be started from CI over HTTP.
- **Reports** - per-step status, duration, screenshot, error message and a console-style log.
- **Self-healing** - in batch runs, when a step's element cannot be found the engine looks for the
  closest match, continues with it and marks the run *unresolved*. Approving the repair saves the new
  locator to the test case and to the element on its captured screen (the screenshot is kept; capture
  again to refresh it); rejecting it turns the run into a failure. A decision is final. A repair of a
  step that came from a shared step is saved to the shared step, once, for every test case that calls it.
  In a data-driven run each pattern is reviewed by itself; approving a repair also approves the same
  repair in the other patterns of that run, and the locator is saved once.
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
  (`loop.ts`), the tools (`tools.ts`, `steps.ts`), the Claude client (`client.ts`), the model table with
  request settings and prices (`models.ts`).
- `migrations/` - D1 schema.
- `src/` - the React app.

A capture is synchronous: the request launches a browser, captures and returns. A run is asynchronous:
`POST` inserts a `queued` row with a snapshot of the steps and sends a queue message; the consumer
executes it and writes each step result to D1 as it happens, so the UI simply polls `GET /api/runs/:id`.
A batch run is one queue message: its test cases run one after another in one browser, each in a fresh
browser context. Aborting sets the status in D1; the consumer checks it before every step. A run has
15 minutes from the moment it starts - the whole run, so all the patterns of a data-driven test case
together (a queue consumer invocation does not live longer either); one that
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
  could not be picked on the screenshot, and a click on it would hit the overlay. A native checkbox laid
  invisibly over its own label (custom switches, "checkbox hack" menus) is the control, not an overlay.
  Fixed and sticky bars are boxed where the full-page screenshot shows them, also on a page that a
  swipe or an earlier step has scrolled.
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

- **Shared steps.** A test case stores a call as one step that holds the shared step's id. When a run
  is created (single, batch or CI), the step list it snapshots is expanded (`shared/expand.ts`): the
  call stays as a marker row, followed by the shared step's steps as they are at that moment, each
  recording the call, the shared step and its own id there. The engine skips the marker and runs the
  rest as ordinary steps, so If blocks, variables, waits and self-healing behave as if the steps were
  written in place. Reports number them under the call (`3.1`, `3.2`, ...) and group them under
  "Shared step S1: Sign in". A step range, and "capture after step N", count a call as one step: a range
  that ends on a call includes all of it. Because the run holds a copy, editing, renaming or deleting a
  shared step afterwards does not change an existing report. A call whose shared step no longer exists,
  belongs to another project, contains a call itself or has an unbalanced If block is refused when the
  run is created, with the step number.

- **Data-driven runs.** The data table is stored with the test case (`shared/data.ts` has its limits,
  the CSV / TSV parser and the validation; the grid and the Worker use the same code). When a run is
  created it gets one *pattern* per row with that row's values, so later edits to the table do not
  change the run. The consumer executes the patterns in order: a fresh browser context for each (no
  cookies or storage carried over), the same expanded step list, and the row's values as variables.
  Precedence inside a pattern: a value stored by a step (*Store value* and friends) replaces whatever
  the name held, a column wins over a project variable of the same name, and the built-in names
  (`BASE_URL`, `BROWSER`, `DEVICE`) cannot be used as column names. Nothing a step stores carries over to
  the next pattern. A pattern that fails does not stop the others. The run is one record: every step
  result carries its pattern number, the log has one section per pattern, and the run's status combines
  the patterns - failed if any failed, otherwise unresolved if any waits for a repair review, otherwise
  succeeded; an abort stops the running pattern and the rest are not run. A step range or a capture
  replays the steps with one row (the first unless another is chosen), and navigate targets are checked
  against the allow-list with every row's values before the run starts.

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
   reject it. Approved locators are written back to the test case, or to the shared step when the
   repaired step came from one (the example suite's last two cases sign in through the shared step
   "Sign in": approve its repairs in one of them and the other passes on the next run).

## Example suite

`scripts/seed-examples.mjs` builds one shared step and eight test cases in the demo project through the public HTTP API, the
way a person does in the editor: save the steps, capture the screen after a step, pick elements from the
capture by name, add steps, capture again. It needs nothing but Node.

```sh
pnpm seed:examples http://localhost:5173 --run                       # local dev server
pnpm seed:examples https://stepwise.example.com --code-file ~/.stepwise-code --run
```

`--code-file` names a file that holds the access code (it is sent as a bearer token and never printed).
`--run` starts a batch run of the eight cases afterwards, waits for it and prints a table; the exit code
is 1 only if a case failed or the suite could not be built (runs that were repaired by self-healing and
wait for review do not count as failures). A finished case whose name already exists is left alone, so the
script can be run again (the same goes for the shared step). A case that could not be built completely is removed again, also when the script
is interrupted (Ctrl-C; exit code 130). While a case is being built its description starts with a marker,
so one that was left behind anyway (the process was killed, the connection dropped) is recognised and
built again by the next run instead of being taken for a finished one.

| Test case | What it demonstrates |
| --- | --- |
| Sign in with valid credentials | The smallest complete test: navigate, input, click, assert a text, assert the URL. |
| Sign in with a wrong password shows an error | A negative path, and picking an element (the error box) that only exists after a step. |
| Reserve a room end to end | Every kind of form field (date, number, pull-down menu, checkbox, radio button, text area), a value stored in a variable (`TOTAL`) and checked on the next page with `${TOTAL}`. |
| Conditional flow with variables | Store fixed value, If variable equals / Otherwise / End branch, If UI element exists, comments, Wait until visible, Assert variable equals. |
| Mobile: open the menu and start a reservation | An emulated iPhone 15: the navigation is behind a *Menu* button there, so the test taps Menu, then Reserve, swipes and checks the form. |
| Shared step: the guest area after signing in | Starts with a call to the shared step *Sign in* (S1) instead of its own login steps, then checks the dashboard. |
| Shared step: start a reservation after signing in | A second caller of the same shared step: the elements after the call are picked from a capture that replayed through it. |
| Data-driven: sign in with several accounts | A data table of four accounts (`EMAIL`, `PASSWORD`, `RESULT`): one run executes the steps four times. Two rows sign in, two are rejected (a wrong password, an unknown account), and an If branch on `${RESULT}` checks the welcome heading or the error message. Its screens were captured with two different rows. |

The shared step *Sign in* (navigate, two inputs, click) is built first, with its own captured screen. The
first five cases are as before: each of them still reads top to bottom on its own.

The suite also works for the self-healing walkthrough above: with `SITE_VERSION` set to `?ui=v2`, a batch
run repairs the renamed elements in all seven cases and ends *Needs review*.

## AI assistant

The editor's **Assistant** button opens a chat panel. You write what the test should do ("Sign in with
the demo account and check the welcome message") and the assistant builds it in the open test case.
It is optional: without the `ANTHROPIC_API_KEY` secret the panel says it is not configured, the
assistant routes answer 503, and everything else works as before.

How it works:

- One message is one **session** (`assistant_sessions` in D1). `POST /api/test-cases/:tid/assistant`
  stores it as `queued` and sends a queue message; the work never runs inside the HTTP request. The
  queue consumer runs a tool loop against the Claude API (official `@anthropic-ai/sdk`; the model is
  configurable, see [Model and cost](#model-and-cost)) and appends every event to the session as it happens. The editor polls the
  session, shows the transcript, and reloads the steps and captured screens whenever the session
  reports something new.
- Each session is a fresh model conversation. Its first message holds the instruction, the test case's
  device and base URL, and the current steps as numbered sentences. The system prompt explains the
  product and lists the commands (generated from `shared/commands.ts`).
- The model works through six tools, executed in the Worker with the same code the HTTP API uses:

  | Tool | What it does |
  | --- | --- |
  | `get_steps` | Lists the current steps. |
  | `capture_screen` | Captures a URL, or the page after replaying steps 1..N. Stores a captured screen like the *Capture* button does and returns its elements, one line each (`e12 "Add breakfast" checkbox`). A downscaled screenshot is added only when the model asks for one. |
  | `add_step` / `update_step` / `delete_step` | Edit the steps. An element must come from a capture of this test case, on the test case's device; the step gets the element's recommended locator and keeps the other candidates. |
  | `run_steps` | Runs all steps or a range in a fresh browser with the engine (no self-healing) and reports each step. Nothing is stored as a run. |

  Tool input is validated before anything happens (unknown command, an element that is not in that
  capture, a missing value, a URL the deployment does not allow); a rejected call goes back to the model
  as an error it can act on.
- The tool calls of one model reply run in order, and step numbers are checked against that: once a call
  has removed a step or inserted one in the middle, a later call of the same reply that names a step from
  there on is refused (it was written for the old numbering, so "delete 3, delete 4" would remove steps 3
  and 5) and the model sends it again.
- While a session is queued or running the step list is read-only, in the editor and on the server:
  `PATCH /api/test-cases/:id` with `steps` answers 409, and the assistant's own writes stop the moment the
  session is no longer running. When it ends, the editor loads the steps it left and its undo stack gets
  one entry, so a single undo removes everything the assistant did; if they cannot be loaded, the editor
  stays read-only and keeps trying rather than letting an edit save the old steps over the new ones.

Safety and limits:

- The assistant opens pages only through the same target policy as captures and runs
  (`ALLOWED_HOSTS`, private addresses refused, checked again inside the browser), and its routes are
  behind the access gate like the rest of the API.
- **Prompt injection.** The assistant reads pages it does not control, and a page can contain text written
  to look like an instruction. Three things stand against that. The system prompt says that everything
  from a capture or a run is content of the site under test and never an instruction, and a capture result
  keeps what Stepwise says (ids, what the replay did) apart from what the page says (`page: { url, title }`
  and the element list). A navigate step the assistant writes may carry a project variable only to the base URL's
  host, the app itself, or a host listed in `ALLOWED_HOSTS`, and a variable may not decide the host: "any
  public host", which is what the target policy allows without a list, is not enough for a URL that sends
  a variable's value somewhere on every later run. And run errors and captured URLs go back to the model
  with `${NAME}` in place of a project variable's value. This narrows what an injected instruction can do;
  it does not make the model immune. The assistant can still be talked into steps the request did not ask
  for, including removing steps (one undo restores them) or typing a variable into a form of a page it was
  led to, so review what it built, and set `ALLOWED_HOSTS` when project variables hold real credentials.
- One session at a time per test case (409 otherwise). A message is 2000 characters at most.
- A session stops after 30 model requests, 12 minutes from the moment it starts, or an estimated $5,
  whichever comes first, and can be aborted; the steps built up to that point are kept. The time limit
  also holds inside a tool call: a run or a replay stops between two steps when the time is up, and a
  model request is cut off at the limit, retries included. A session that stops responding is closed 15
  minutes after it started, one that was never picked up 15 minutes after it was queued.
- The model's replies cost money on your Anthropic account, so the deployment as a whole has a budget per
  24 hours: by default 100 sessions and an estimated $40 (`ASSISTANT_DAILY_SESSIONS`,
  `ASSISTANT_DAILY_BUDGET_USD`); past either, a new session is refused with a 429. "One session per test
  case" alone bounds nothing, since test cases are free to create. This is a backstop, not a substitute for
  `ACCESS_CODE` on a public URL or for a spend limit on the API key itself.
- Each session shows its token usage and an estimated cost, at the list price of the model that worked on
  each request. The system prompt, the tool definitions and the growing conversation are prompt-cached.
  On Sonnet and Opus a request the model's safety classifiers decline is retried server-side on a fallback
  model (`fallbacks: "default"`); such a request is counted with both attempts, each at its own price, and
  the session names the other model. Haiku 5.5 has no server-side fallback: a declined request ends the
  session with a message.
- Page content (text, and a screenshot when the model asks for one) of the site under test is sent to the
  Claude API. Do not point
  the assistant at pages whose content must not leave your infrastructure.

### Model and cost

The assistant can ask `claude-haiku-5-5`, `claude-sonnet-5-5` or `claude-opus-5-5`. Each model's request
settings and price live in one table, `worker/assistant/models.ts`; the deployment picks one with the
`ASSISTANT_MODEL` var (`wrangler.jsonc`, or `.dev.vars` locally) and `GET /api/assistant/status` reports
it. A value that is not in the table is not sent to the API: the default is used and a warning is logged.

The default is **Claude Haiku 5.5**, chosen by measurement. `scripts/bench-assistant.mjs` gives every model
the same four tasks against the bundled demo site, each in a fresh test case: (a) sign in and assert the
welcome message, (b) sign in with a wrong password and assert the error, (c) go from the home page to the
reservation form, book 2 nights for 2 guests with breakfast and assert the guest name on the confirmation
page (the form also insists on a check-in date the request does not mention), (d) on the emulated iPhone
open the menu, sign in and assert the greeting. A run passes only if the session ended `done`, a normal
run of the steps it left succeeds, and the steps contain the assertion that was asked for (checked on the
steps, not on the model's summary). Medians per run, effort `medium` on all three:

| Model | Task | Passed | Requests | Seconds | Cost |
| --- | --- | --- | --- | --- | --- |
| `claude-haiku-5-5` | (a) sign in | 3/3 | 9 | 20 | $0.0018 |
| | (b) wrong password | 3/3 | 8 | 32 | $0.0016 |
| | (c) reservation | 3/3 | 10 | 32 | $0.0026 |
| | (d) phone menu | 3/3 | 11 | 74 | $0.0035 |
| `claude-sonnet-5-5` | (a) sign in | 2/2 | 10.5 | 46 | $0.041 |
| | (b) wrong password | 2/2 | 12 | 48 | $0.037 |
| | (c) reservation | 2/2 | 10 | 40 | $0.042 |
| | (d) phone menu | 2/2 | 15 | 51 | $0.046 |
| `claude-opus-5-5` | (a) sign in | 2/2 | 5 | 26 | $0.056 |
| | (b) wrong password | 2/2 | 5 | 33 | $0.044 |
| | (c) reservation | 2/2 | 7.5 | 50 | $0.080 |
| | (d) phone menu | 2/2 | 7 | 49 | $0.058 |

Haiku passed all 12 runs at about a twentieth of the price of the next model, so it is the default. This is
a small benchmark on one simple site: Opus needs about half the requests and is the one to switch to
(`"ASSISTANT_MODEL": "claude-opus-5-5"`) when the assistant struggles with a complex application. Seconds
are wall-clock on a laptop with two sessions running at a time; most of it is the browser, not the model.
During tuning Haiku ran these tasks another 118 times with one failure, a reservation it reported as
finished without the date and the assertion; the system prompt now says to keep working until the
requested check is in place and to choose a value for a detail the page insists on.

What a session costs was also reduced independently of the model. Before, task (a) on Opus cost $0.09 to
$0.12; with the changes below it costs $0.04 to $0.07 on Opus and about $0.002 on Haiku.

- **Element list.** A capture result listed every element as a JSON object with name, type and text. It is
  now one line per element (`e12 "Add breakfast" checkbox`), about a third of the tokens. Elements without
  a locator are left out, and a page with more than 200 elements keeps its controls and drops the texts
  that do not fit, saying how many.
- **Screenshot on request.** Every capture used to carry a downscaled screenshot. In the benchmark it
  changed no result (12/12 with the full image, a smaller one, and none) while making up roughly 40% of a
  session's cost, because every later request re-reads it. The model now gets the image only when it asks
  (`screenshot: true`), which the tool description reserves for a second look at a page whose element
  list was not enough.
- **Fewer requests.** Every request re-reads the conversation, so the prompt tells the model to send
  calls that do not depend on each other in one reply (the steps for a screen plus the capture after them).
- **Left as it was, after checking.** Prompt caching already works as intended: one breakpoint on the
  system prompt (shared by all sessions of a model within five minutes) and one that moves with the
  conversation, so a request pays full price for 2 to 4 tokens. Effort `low` on Haiku saved nothing
  measurable over `medium`. `max_tokens` is a ceiling and costs nothing.

To repeat or extend the comparison, start the dev server with `ASSISTANT_DEV_OVERRIDE=1` in `.dev.vars` and
run:

```sh
pnpm bench:assistant http://localhost:5173 --models claude-haiku-5-5:3,claude-sonnet-5-5:2,claude-opus-5-5:2
```

It prints the table and writes the raw results, transcripts included, to a JSON file (`--out`). The run
above cost $0.84 in API usage. The script selects the model per session with an `X-Assistant-Model` header,
which the Worker honours only when that var is set and the request was addressed to localhost; on a
deployment the header does nothing, and against one the script only measures the deployed model.

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
  it once and keeps an HttpOnly cookie (`__Host-sw_access` over https); scripts send `Authorization: Bearer <code>`.
- `ANTHROPIC_API_KEY` - enables the [AI assistant](#ai-assistant). Without it the rest of the app is
  unaffected.
- `ASSISTANT_MODEL` - the model the assistant asks: `claude-haiku-5-5` (default), `claude-sonnet-5-5` or
  `claude-opus-5-5`. See [Model and cost](#model-and-cost).
- `ASSISTANT_DAILY_SESSIONS`, `ASSISTANT_DAILY_BUDGET_USD` - how many assistant sessions the deployment
  starts in 24 hours, and the estimated spend after which it starts no more (defaults: 100 and 40).
- `ASSISTANT_DEV_OVERRIDE=1` - local development only: lets `scripts/bench-assistant.mjs` choose the model
  of each session it starts.
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

## Modern web practices

The UI was audited with Google Chrome's [Modern Web Guidance](https://www.npmjs.com/package/modern-web-guidance)
(version 1.0.1): its `legacy-scan` for the patterns it can detect, and its guides read against the code for the
rest. The tool is not a dependency of the project. A feature was adopted where the guides call it Baseline
widely available, or where the older behaviour stays as the fallback. What changed:

- **Dialogs** (`dialog`, `light-dismiss-a-dialog`, `platform-controls-dismiss-dialog`,
  `prevent-page-scroll-under-modal-dialog`). Every modal, the screenshot lightbox included, is a native
  `<dialog>` opened with `showModal()`: the browser provides the top layer, the inert page, focus containment,
  Escape and back-gesture dismissal and the return of focus, replacing a hand-written focus trap. Clicking
  outside uses `closedby="any"`, with a pointer fallback where that attribute is missing (Safari). A
  confirmation focuses *Cancel*. The element inspector is a non-modal `<dialog>`.
- **Input methods** (`ime-safe-enter-submit`). Every Enter and Escape handler on a text field (assistant
  message, inline rename, command search, element name, locator fields) ignores the keystroke that confirms or
  cancels a Chinese, Japanese or Korean conversion, including Safari's `keyCode` 229 case.
- **Messages** (`persistent-toast-notifications`). A toast outside a modal dialog is inert, so while a dialog
  is open its messages are shown inside it; the toast area is a named region.
- **Motion** (`motion`, `spinner`). No global "kill all animation" rule: under `prefers-reduced-motion`
  panels fade instead of rising, the element pulse is left out and spinners turn slowly.
- **Keyboard and assistive technology** (`accessibility`, `tabs`, `drag-and-drop`, `breadcrumbs`,
  `copy-button`). Tabs have one tab stop, arrow keys and a labelled tab panel; steps can be reordered from the
  step menu (*Move up* / *Move down*) with the move announced, not only by dragging; breadcrumbs are an
  ordered list; the copy button reports a failed copy; focus rings and the selected tab stay visible in
  forced-colours mode.
- **Forms** (`forms`, `autofill-sign-in-form`). The access code field is a labelled, required
  `current-password` field a password manager can fill; URL and identifier fields turn off autocorrect and
  set `enterkeyhint`.
- **Typography and images** (`typography`, `html`). Font sizes are in `rem`, so the browser's font-size
  setting applies; the captured screenshot and the sample site's images carry their dimensions.
- **JavaScript** (`js`). `toSorted()` / `findLast()` instead of copy-then-mutate, and `Error` `cause` in the
  seed script.

A second pass went through seventeen more guides, one by one:

- **`performance`** - applied. The editor, the result page and the batch page are loaded on demand
  (`React.lazy`), so the project list and the access form no longer download them; a tab left open across a
  deployment reloads once when a lazily loaded file is gone; the hashed files under `/assets` are served as
  `immutable` (they pass through the Worker, which answers a hashed file that does not exist with a 404
  instead of the app shell, so the shell is never cached under a script's address). The two IBM Plex families are
  self-hosted (`public/fonts/v1`, latin subset, SIL Open Font License): no third-party connection, the two weights of
  the first paint are preloaded, and the files are cached as immutable.
- **`security`** - applied. Every response carries `X-Frame-Options: DENY`, `nosniff`, a `Referrer-Policy`, a
  `Permissions-Policy`, `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy` (`public/_headers` for
  the static app shell, `worker/security.ts` for `/api` and `/demo`). The app has an enforced
  Content-Security-Policy with `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'` and Trusted
  Types; the sample site, whose pages contain inline scripts, gets the three framing and plugin directives
  only. The access cookie is `__Host-sw_access` over https. `/api` refuses requests another site makes the
  browser send (`Sec-Fetch-Site`), before the access code is checked. `Strict-Transport-Security` starts at
  `max-age=300`: raise it to a year once it has been live without trouble. Not done: `script-src` is `'self'` (plus the Cloudflare Web Analytics beacon the zone injects)
  rather than hashes with `'strict-dynamic'` (the shell is static and its only script is the hashed bundle),
  and there is no violation report endpoint, because nothing collects reports.
- **`browser-ui-theming`** - applied. Placeholder and muted text reach 4.5:1 in the light theme, text fields
  have an outline of 3:1 against their surface in both themes (`--control-line`), and the assistant's message
  box grows with its text (`field-sizing`), or can be dragged taller where that is not supported.
- **`css-layout`** - applied. Clipping uses `overflow: clip`; nested scroll areas contain their overscroll;
  lists that grow reserve their scrollbar gutter; widths that meant "the viewport" no longer use `100vw`;
  direction-related margins, paddings, borders and alignments are logical properties (offsets that script
  sets from physical coordinates, such as the inspector's side, stay physical); chip rows use
  `flex-wrap: balance` where it exists.
- **`responsive-design`** - applied. Heights limited by the viewport use `dvh`; the page sections and the
  self-healing dialog switch layout by the width of their container (`@container`), not of the window. Fluid
  type is not used, so the `clamp()` rules do not apply.
- **`form-factor-adaptation`** - applied. Controls are at least 24 by 24 pixels, and 44 on touch screens
  (`pointer: coarse`), checkboxes through the label around them (the panel divider and the element outlines
  on a screenshot excepted; the sample site's choices and menu button follow the same sizes); bars, chips and headers have minimum
  heights instead of fixed ones; the page header, title row and dialog footer wrap; a 320px page no longer
  scrolls sideways (variable rows, long words); headings use `text-wrap: balance`, paragraphs `pretty`.
- **`responsive-table`** - applied. A table's scroll container is a focusable, named region; the cell that
  names a row is a row header; in a narrow container a list table stacks into labelled blocks instead of
  squeezing its name column to nothing. Not done: sticky headers, which would turn every list into its own
  vertical scroll area inside the page. Deferred: the same region wrapper around the sample site's table,
  because a focusable wrapper is detected as a clickable element when that page is captured.
- **`single-line-overflow`** - applied. The tab strip draws its focus ring inside the tab instead of having
  it clipped; step sentences on the test case page and in the screenshot viewer wrap, and the screen list
  shows a captured address in full, so no text is readable only through a hover `title`; a validation
  message no longer cuts the value in script. Kept: the name column truncates through `max-width: 0` rather
  than `table-layout: fixed`, which would need a fixed width for every date and device column.
- **`icons`** - applied. The one informative icon without a role has `role="img"`, and the grey of the
  "aborted / skipped / queued" icons is 3:1 on hovered and selected rows too. Icons are inline SVG in
  `currentColor`; the guide's CSS icon system is not needed.
- **`navbar`** - applied to the sample site (the app has breadcrumbs, not a navigation bar). The current
  page is marked with `aria-current` and underlined; on a phone the navigation is a native popover where the
  Popover API exists (Escape and a tap outside close it), and the class toggle it replaces, now with Escape
  and outside-press handling, remains the fallback. Deferred: collapsing by measuring whether the links fit
  instead of at a fixed width. The layout of a test target would then be decided by script after load, and
  a capture taken right then could see either state.
- **`toolbar`** - applied. Toggle buttons keep one name and report their state through `aria-pressed`, which
  their pressed look (now with a 3:1 outline, also in forced colours) is styled from; unavailable icon
  buttons are `aria-disabled` and stay focusable, so focus is not lost when Undo runs out; menu buttons
  report `aria-expanded`; Undo and Redo are announced; hover styles of these buttons apply only where
  hovering exists. The view buttons and Capture are a named group; they are not a `role="toolbar"` with one
  tab stop, which the guide requires only of something declared a toolbar.
- **`natural-interactions`** - applied. Buttons, chips, menu items and links have a pressed state; a menu's
  keyboard focus is a ring, no longer the hover tint (and a menu now takes focus when it opens); the focus
  ring of a text field is a 2px accent line; popovers grow out of the corner that touches their trigger;
  the tab strip snaps; what appeared only on hover (a step's menu and grip, an element's name tip) also
  appears on keyboard focus and on touch screens; element outlines on a screenshot are reachable by
  keyboard (one tab stop, arrow keys, Enter to pick, Shift+Enter to inspect); a step in the run log opens
  its screenshot from the keyboard.
- **`interest-triggered-tooltips`** - applied. The assistant's token breakdown is a toggletip behind a
  visible button instead of a `title` on plain text; Escape hides the element name tips without moving the
  pointer. `interestfor` and `popover="hint"` are not used: neither is in every browser yet.
- **`animate-to-from-top-layer`** - applied. The dimming behind a dialog fades in with it, and the
  screenshot viewer fades in. Dialogs still close without an animation; the guide describes how to animate
  an exit but does not ask for one.
- **`accessible-error-announcement`** - applied. The access code field turns red and `aria-invalid` at the
  same moment (`:user-invalid`), and a rejected code puts focus back on the field, which reads the error; a
  project variable with a bad name is marked and points at its message, announced once typing pauses; the
  sample site's two forms mark the field at fault and move focus to it.
- **`scroll-target-on-load`** - not applicable. Nothing in the app is positioned once on load; the places
  that scroll to something (the selected step, the step's element, the end of the conversation) do so again
  on every change, which needs script. `scroll-initial-target` is also Chromium-only.
- **`navigation-drawer`** - not applicable. Neither the app nor the sample site has a drawer; the assistant
  panel is a non-modal tool panel, and the sample site's phone navigation opens under its header (see
  `navbar`).

Left as they are, on purpose: menus and popovers are positioned in script, because CSS anchor positioning is
not in Firefox yet and the Popover API is not yet Baseline widely available (the sample site's phone
navigation uses it as an enhancement over a script fallback); the light and dark themes use
`prefers-color-scheme` with `color-scheme` (the guides' own fallback for `light-dark()`); controls keep their
compact pixel heights for a mouse (the 44px minimum applies to touch screens); and `title` attributes remain
as hover hints on controls that already have an accessible name.

### Cross-browser verification

The app and the sample site were exercised with the browser builds of Playwright 1.65.1, headless on macOS:
Chromium 159.0.8154.6, WebKit 27.2 (the stand-in for Safari) and Firefox 159.0, against both the production
build served by the local Worker and the in-browser mock API. Real Safari, iOS and platforms with classic
(non-overlay) scrollbars were not tested. What differs per engine, and what the code does about it:

- **Scrolling under a modal dialog.** `overscroll-behavior: contain` on the dialog and its backdrop keeps
  the page still in Chromium only; WebKit and Firefox pass the wheel on to the document. The document
  therefore does not scroll while a modal dialog is open (`html:has(dialog:modal)`), with the scrollbar
  gutter of the scrolling pages reserved so they do not shift. The page keeps its position in all three.
- **Focus ring of a checkbox.** WebKit paints no box shadow on a native checkbox or radio button, so their
  ring is an outline, in every engine.
- **Date field (sample site).** In WebKit the segments inside the field take focus: the field never matches
  `:focus-visible` and `focus()` does not scroll it into view. The field gets the ring of the other fields
  through `:focus-within`, and a failed submit scrolls the message and the field into view itself.
- **`form.elements` by name (sample site).** Firefox drops a control from the named lookup once an id equal
  to its name is changed, which stopped the redesigned reservation form (`?ui=v2`) from working there. The
  controls are now looked up once with `querySelector`.
- **Leaving while a route is still loading.** Firefox and WebKit fail a dynamic import that a navigation
  interrupts, Chromium does not; the reload for a file that is gone after a deployment used to cancel that
  navigation. It is skipped while the page is leaving, and still happens when the file is really missing.
- **Focus after a dialog opened with the mouse.** Safari on macOS does not focus a button that is clicked,
  so a dialog had no invoker to hand focus back to. The control last pressed is remembered and focused when
  focus would otherwise end on `<body>`; the sample site's phone menu does the same.
- **Text fields on a touch screen.** iOS zooms the page when a field with text under 16px takes focus, so
  fields are at least 16px where the pointer is coarse (set from the media query; not tried on a device).
- **`flex-wrap: balance`.** Chromium only. The eight command categories wrap 4 + 4 there and 7 + 1 in WebKit
  and Firefox; this is the plain `wrap` fallback and is left as it is.
- **Console only.** WebKit logs a warning that the page is not cross-origin isolated on a full-page
  navigation (the `Cross-Origin-Opener-Policy` value is intended; nothing needs isolation). Behind the Vite
  development and preview servers, which add `Vary: Origin`, WebKit downloads the two preloaded fonts twice;
  with that header removed by a proxy it downloads them once. The deployed site's headers were not checked.

The same pass fixed seven things that behaved alike in all three engines: a click on the description while the name was being edited was lost, because the name's field took the whole line and moved what was below it; the lightbox let the page header show through its bar; on a phone the *Copy* button covered the first line of the CI command and variable names were cut; keyboard focus was lost after
*Move up* / *Move down* and after an inline rename confirmed with Enter or Escape; the "needs review" banner
squeezed its text into a narrow column on a phone; the access code field stayed marked invalid for one
keystroke after the "only spaces" message; and the sample site's *My stays* link was not marked as the
current page when the address had no `.html`.

## Limits and non-goals

- Speculation rules are refused inside the test browser: on Cloudflare Browser Run a mouse-down prefetch tears the browser session down. Rules sent as an HTTP header (for example by Cloudflare Speed Brain) are not loaded, and inline `<script type="speculationrules">` blocks (WordPress emits one by default) are taken out of the document as they appear. Pages behave the same, but prefetch/prerender behaviour itself cannot be tested.
- One browser type (Chromium on Browser Run); no cross-browser matrix, no parallel patterns. A batch
  runs its test cases sequentially.
- Phones are emulated in that same Chromium (viewport, user agent, touch, pixel ratio). This is mobile
  *web* testing: it is not Safari or a real device, and native mobile apps cannot be tested. A swipe is
  a scroll gesture of about 70% of the viewport in the middle of the screen, not a recorded finger path;
  it moves what a finger there would move (a scrolling list or a layout whose content area scrolls,
  otherwise the page).
- A batch run executes inside a single queue consumer invocation, so very long batches can hit the
  platform's time limits; Browser Run's own concurrency and session limits apply too.
- Captures do not look inside iframes or closed shadow roots, and elements inside an open shadow
  root only get CSS locators (XPath cannot reach them).
- No users, roles, schedules, notifications, loops or visual diffs.
- Data-driven tests: a data table has at most 20 columns, 50 rows and 2000 characters in a cell, and
  rows times steps may not exceed 2000 step results in one run. Patterns run sequentially, never in
  parallel, and the 15 minute limit is for the whole run, so a long test case with many rows has to be
  split. Cells are text; there is no per-row device, no row filter and no shared data table between test
  cases (a shared step uses the data of the test case that calls it). A cell is a one-line field: a
  line break inside an imported or pasted cell is kept until that cell is edited. The assistant builds
  and tries steps with the first row.
- Shared steps do not nest (a shared step cannot call another one), and a call takes no parameters:
  what varies between callers goes through variables set before the call. A shared step has no device of
  its own at run time: it runs on the device of the test case that calls it, so one captured on desktop
  and called from a phone test case may meet a different layout. A run with its shared steps expanded can
  hold 500 steps at most. The assistant keeps, disables or removes a call that is already in a test case,
  but it does not add calls or choose shared steps.
- A run is never retried once it has started. Only a run that could not get a browser (Browser Run's
  concurrency or rate limit) is tried again, up to three times, before it is marked failed.
- A request body may be 1 MB at most; a run may take 15 minutes at most, all of its patterns included.
- Self-healing is a similarity heuristic, not a model; every repair needs a human decision.
- The assistant builds and edits steps only: it does not rename test cases, change the device, or
  manage projects. It works from the element list of a page and looks at a screenshot only when it asks for one (which
  shows the top of a very long page; the element list covers the whole page, up to 200 elements), and it does not remember earlier sessions beyond the steps they left behind.
- The access code is a single shared secret, not an account system.
