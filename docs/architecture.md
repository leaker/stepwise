# Architecture and test engine

[Back to the README](../README.md)


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
  (`loop.ts`), the tools (`tools.ts`, `steps.ts`), what has to hold before a session may end and the
  review of the request (`review.ts`), the Claude client (`client.ts`), the model table with request
  settings and prices (`models.ts`).
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
forever. A batch that is not through after 8 minutes hands its remaining test cases to a new invocation
(a new queue message), so a long batch is executed in stretches; a test case that an invocation was
stopped in the middle of is failed as *interrupted* when the batch is picked up again.

Saving the steps is guarded against lost updates: a test case reports a revision of its steps
(`stepsRev`), the editor sends it back with every save (`baseStepsRev`), and a save based on an older
list than the stored one (another tab saved, a repair was approved, the assistant worked on it) is
refused with 409 `steps_changed`. The editor then stops editing and offers to load the saved steps;
undo brings back what was on screen. A client that sends no revision overwrites.

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
  before the step fails. A fixed wait may be 300 seconds at most (longer is an error, not a shorter
  wait). Assertions can be set to "continue on failure". *Assert URL equals* compares URLs, not their
  spelling: `https://example.com` and `https://example.com/` are equal. A value longer than 300
  characters is cut in error messages and in the log (a variable keeps all of it). "Exists" means rendered: a
  node that is in the DOM but hidden does not exist for *Assert exists / does not exist / If exists*.
- **Self-healing.** With healing on (batch runs), a step whose locator matches nothing (or more than
  one element) is compared against the elements on the current page using the stored fingerprint. The
  best match above a threshold is used, and the step is reported as `healed` with a proposal (old and
  new locator, similarity score, before/after position) that waits for approval. A replacement must
  carry over something that identifies the element - its text, label, an attribute such as `name` or
  `href`, or its classes; for a text element, the text itself. Sitting in the same place with the same
  tag is not enough, so a different message or an unrelated button is a failure, not a repair.
  Commands that expect an element to be absent, and conditional branches, never heal.

- **Variables.** `${NAME}` in a step's value is replaced when the step runs; a name that is not defined
  fails the step. The text of a *Comment* step is never looked at, so it may contain `${`.

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
  succeeded; an abort stops the running pattern and the rest are not run. When a run ends without the
  consumer finishing it (aborted while queued, the time limit), the API reports its unfinished patterns
  with the run's verdict, never as queued or running. If the browser session goes away during a pattern,
  that pattern fails and the next one gets a new browser; if none can be started, the remaining patterns
  fail with that reason (the run has started, so it is not put back on the queue). An approved repair is
  saved once: the same repair in other patterns is approved with it, and approving a *different* repair
  of the same element later replaces the first, which the review dialog and the log say. A step range or a capture
  replays the steps with one row (the first unless another is chosen), and navigate targets are checked
  against the allow-list with every row's values before the run starts.

Each step stores its own copy of its target element, so a run does not depend on the capture still existing.
