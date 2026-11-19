# Limits and non-goals

[Back to the README](../README.md)


- Speculation rules are refused inside the test browser: on Cloudflare Browser Run a mouse-down prefetch tears the browser session down. Rules sent as an HTTP header (for example by Cloudflare Speed Brain) are not loaded, and inline `<script type="speculationrules">` blocks (WordPress emits one by default) are taken out of the document as they appear. Pages behave the same, but prefetch/prerender behaviour itself cannot be tested.
- One browser type (Chromium on Browser Run); no cross-browser matrix, no parallel patterns. A batch
  runs its test cases sequentially.
- Phones are emulated in that same Chromium (viewport, user agent, touch, pixel ratio). This is mobile
  *web* testing: it is not Safari or a real device, and native mobile apps cannot be tested. A swipe is
  a scroll gesture of about 70% of the viewport in the middle of the screen, not a recorded finger path;
  it moves what a finger there would move (a scrolling list or a layout whose content area scrolls,
  otherwise the page).
- A batch run is executed in stretches of about 8 minutes, each in its own queue consumer invocation. A
  single test case still has to finish within its invocation: one that is running when the platform
  stops the invocation is reported as failed (*interrupted*), and the batch goes on with the next one.
  Browser Run's own concurrency and session limits apply too.
- Captures do not look inside iframes or closed shadow roots, and elements inside an open shadow
  root only get CSS locators (XPath cannot reach them).
- No users, roles, schedules, notifications, loops or visual diffs.
- Data-driven tests: a data table has at most 20 columns, 50 rows and 2000 characters in a cell, and
  256 KB in total as stored (JSON, UTF-8), so not every cell can be at its limit at once: the table
  lives in one D1 row with the steps and is copied into every run. Rows times steps may not exceed
  2000 step results in one run. Pasted text is split into cells at tabs, or at commas when it has
  several lines with the same number of cells; a single line without tabs is pasted into one cell (into a
  table that has no column yet it names the first column, or the columns when it is a list of names such as
  `EMAIL,PASSWORD`). An imported row with more cells than the first row has column names loses the rest,
  and the import says how many cells that was. Edits
  to the table are a draft until *Save data*: the draft is kept while the tab stays open and the browser
  asks before a reload, but it is not stored anywhere. Patterns run sequentially, never in
  parallel, and the 15 minute limit is for the whole run, so a long test case with many rows has to be
  split. Cells are text; there is no per-row device, no row filter and no shared data table between test
  cases (a shared step uses the data of the test case that calls it). A cell is a one-line field: a
  line break inside an imported or pasted cell is kept until that cell is edited. The assistant builds
  and tries steps with the first row.
- A shared step is saved even while its If / Otherwise / End steps do not balance (the editor saves
  as you type), but then no test case that calls it can run, and a batch run that includes one is
  refused; the *Shared steps* tab marks such a shared step. Step ids are 1-64 letters, digits, `-`
  or `_`. A repair proposed by an old run for a step that has since been moved to a shared step or
  deleted can still be approved, but no step gets the locator, and the report says so.
- Shared steps do not nest (a shared step cannot call another one), and a call takes no parameters:
  what varies between callers goes through variables set before the call. A shared step has no device of
  its own at run time: it runs on the device of the test case that calls it, so one captured on desktop
  and called from a phone test case may meet a different layout. A run with its shared steps expanded can
  hold 500 steps at most. The assistant keeps, disables or removes a call that is already in a test case,
  but it does not add calls or choose shared steps.
- A test case holds 500 steps at most, a step value 5000 characters, an element name 300 and a locator
  2000. The editor's fields stop there and a step over a limit is marked on its row; the API answers 400.
  An assertion that looks for an empty text (*contains*, URL, title) and a *Select* without an option are
  errors in the editor: they would pass on any page. To check that a field is empty, use *Assert UI
  element equals* with an empty text (the text of a field is its value).
- The editor saves as you type. When a save fails (no connection, a step the server refuses, the
  assistant or another tab holding the steps), it says so and keeps the changes on screen; leaving the
  editor then (a link, *Back*, the browser's back button) saves once more and asks before the changes
  are dropped. `PATCH /api/test-cases/:id` writes only the fields it is sent, so a save of the steps and a
  save of the data table or the name cannot undo each other.
- Deleting a test case deletes its captured screens and the results of its single runs. Its results
  inside batch runs stay in those reports, marked as belonging to a deleted test case. *Recent runs* on
  the test case page lists single runs and runs inside batch runs.
- A run is never retried once it has started. Only a run that could not get a browser (Browser Run's
  concurrency or rate limit) is tried again, up to three times, before it is marked failed.
- A request body may be 1 MB at most; a run may take 15 minutes at most, all of its patterns included.
  A run is stored as one row (its steps, and a result and a log line per step and data row), which D1
  bounds at 2 MB: a run that would come to more than about 1.5 MB is refused when it is created.
- Screenshots of a deleted project or test case are removed after the response; a large clean-up is put
  on the queue in pieces and retried there.
- Self-healing is a similarity heuristic, not a model; every repair needs a human decision.
- The assistant builds and edits steps only: it does not rename test cases, change the device, or
  manage projects. It works from the element list of a page and looks at a screenshot only when it asks for one (which
  shows the top of a very long page; the element list covers the whole page, up to 200 elements), and of earlier sessions it knows the steps they left behind and, for the last four, the request and how it ended, not the whole conversation.
- The access code is a single shared secret, not an account system. Guessing it is rate limited per
  client address and Cloudflare location, not globally.
