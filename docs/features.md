# Features

[Back to the README](../README.md)


- **Projects and test cases** - numbered test cases per project, a base URL and project-wide variables.
  A URL without a scheme (in *Navigate*, *Assert URL equals* and the capture dialog) is appended to the
  base URL, with or without a leading slash: with the base URL `https://example.com/app`, both `login`
  and `/login` are `https://example.com/app/login`.
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
  paste a block copied from a spreadsheet, or import a `.csv` file whose first row names the columns (UTF-8,
  or UTF-16 with a byte order mark; a file in a regional encoding such as GBK or Shift_JIS is read as that
  when it matches the browser's language, and says so, and is refused otherwise). The
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
  are replayed first as set-up and only the range is reported. A range only needs the steps up to its
  last one to be sound, so it works while an If block further down is still being built; when none of its
  steps is executed (disabled, or in a branch arm this run did not take) the editor and the log say so.
- **Batch runs** - run all or selected test cases of a project in order, with a summary of succeeded /
  failed / unresolved / aborted. Batch runs can be started from CI over HTTP.
- **Reports** - per-step status, duration, screenshot, error message and a console-style log.
- **Self-healing** - in batch runs, when a step's element cannot be found the engine looks for the
  closest match, continues with it and marks the run *unresolved*. Approving the repair saves the new
  locator to the test case and to the element on its captured screen (the screenshot is kept; capture
  again to refresh it); rejecting it turns the run into a failure. A decision is final, so *Reject* asks
  once more before it is sent. A repair of a
  step that came from a shared step is saved to the shared step, once, for every test case that calls it.
  In a data-driven run each pattern is reviewed by itself; approving a repair also approves the same
  repair in the other patterns of that run, and the locator is saved once.
- **Abort** for single and batch runs.
- **AI assistant** (optional) - describe a test in plain language in the editor's chat panel and the
  assistant builds the steps: it captures the pages, adds steps with the elements it found, runs them,
  and sets what you asked for against what it built before it reports. A session cannot end with steps
  that were not run, and what it did differently from the request is said. See [AI assistant](ai-assistant.md).
- **Optional access code** for the whole API, and an optional allow-list of hosts tests may open.
- A small bundled sample site ("Harbor Inn") under `/demo` and a demo project that tests it, created
  with the database.
