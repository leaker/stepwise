# AI assistant

[Back to the README](../README.md)


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
  device and base URL, the current steps as numbered sentences, and what the last four sessions on the
  same test case were asked and how each ended (its summary, or what stopped it and the last failure),
  so a follow-up such as "continue" or "check the user name instead" is understood. It also carries today's
  date (UTC), so "next month" does not become a date in the past, the columns of the data table when
  there is one, and the language of a request written in Chinese, Japanese or Korean. The system prompt
  explains the product and lists the commands (generated from `shared/commands.ts`); it asks for the
  summary in the language of the request, with the site's own texts left as the site writes them.
- The model works through eight tools, executed in the Worker with the same code the HTTP API uses:

  | Tool | What it does |
  | --- | --- |
  | `get_steps` | Lists the current steps. |
  | `capture_screen` | Captures a URL, or the page after replaying steps 1..N. Stores a captured screen like the *Capture* button does and returns its elements, one line each (`e12 "Add breakfast" checkbox`; a pull-down menu with its options). A downscaled screenshot is added only when the model asks for one. Asked for the same page again with the same steps, it answers with the capture it already made instead of taking another. When the replay fails, the answer shows the page at that point and says which step to fix. |
  | `add_step` / `update_step` / `delete_step` | Edit the steps. An element must come from a capture this session made, on the test case's device; the step gets the element's recommended locator and keeps the other candidates. An element named without its capture is taken from the session's latest capture, and an element, value or variable passed to a command that has none is ignored; the answer says so either way. |
  | `run_steps` | Runs all steps or a range in a fresh browser with the engine (no self-healing) and reports each step; a full run of a data-driven test case tries the data rows one after another (ten at most) and stops at the first that fails. A failure comes with what to do next. Nothing is stored as a run. |
  | `set_data_table` | Sets the test case's data table, for a request that is the same flow with several sets of values ("try these three accounts"). The steps read a row's cell as `${COLUMN}`. |
  | `review_request` | Changes nothing: the model lists every separate thing the request asks for with the steps that carry it out, each marked done, substituted or not done, and gets every point back next to its steps as sentences, with warnings (a point that asks for a check and names no assertion) and the typed or selected values the request does not contain. |

  Tool input is validated before anything happens (unknown command, an element that is not in that
  capture, a missing value, a URL the deployment does not allow); a rejected call goes back to the model
  as an error it can act on.
- **Guards.** The model is told how to build a test, and the tools hold it to the parts that can be
  checked, because a rule in a prompt is followed most of the time and a refused call every time:
  - `add_step` asks for every field, `null` where the command has no use for it. With optional fields
    Haiku left out the value of an input or the capture of an element in about one call in four (130 of
    523 `add_step` calls in the 54 sessions measured before the change were refused for it); asked for all
    of them, it left none out, and a sign-in test takes 6 model requests instead of 15.
  - A run starts in a new browser on a blank page, and capturing a URL adds no step. A step that would be
    the first one needing a page gets a "Navigate to URL" step put in front of it, for the page the session
    captured by its URL; the step numbers the model wrote in the rest of that reply are read one higher.
    When no such page is known the step is refused with the step to add first, and a run or a replay over
    steps that begin without a page is refused the same way before a browser is started.
  - A `select` whose value is not one of the menu's options is refused with the options. An assertion sent
    without its expected text expects the text the capture showed, and one that expects a text the capture
    did not show is added with a note saying so.
  - A failed run says what to do about it (capture the page before the failing step; for a failed assertion,
    whether the expectation was a guess or the page really differs), and says to stop varying a step that
    has failed in three runs.
- **Finishing.** A session that changed the test can only end when (1) the whole test was run after the
  last change, (2) that run passed, and (3) `review_request` was called after the last change. When the
  model sends its closing summary before that, the loop does not accept it: the summary is not shown, the
  model gets a message saying what is missing, and the session goes on (the transcript shows "Not finished
  yet" with the reason). A test that cannot pass because the site does not do what the request expects can
  still end: the model marks that point not done with the reason, and says in the summary that the test
  fails and where. The same reason is given twice at most; the third time the session ends as failed
  with it. A closing reply that is a question, with nothing built, is sent back once (nobody answers
  during a session), and so is a summary that is not in the language of a Chinese, Japanese or Korean
  request. What the review marked as substituted or not done is in the transcript line of the review,
  whatever the summary says.
- The tool calls of one model reply run in order, and step numbers are checked against that: once a call
  has removed a step or inserted one in the middle, a later call of the same reply that names a step from
  there on is refused (it was written for the old numbering, so "delete 3, delete 4" would remove steps 3
  and 5) and the model sends it again. The same holds after an `add_step` that was refused: the steps the
  model appended after it have lower numbers than it counted on.
- While a session is queued or running the step list is read-only, in the editor and on the server:
  `PATCH /api/test-cases/:id` with `steps` answers 409 (`assistant_busy`), and the assistant's own writes
  stop the moment the session is no longer running. Saving the name, the device or the data table during
  a session is allowed and does not get in the assistant's way (a data table saved in the editor replaces
  one the assistant set, and the other way round; the Data dialog shows the saved one). The captured screens are read-only too:
  the editor does not rename or delete them or change their elements meanwhile, and `DELETE /api/uis/:id`
  answers 409. An editor in another tab finds out with
  its next save, locks, and loads the assistant's steps when the session ends. When it ends, the editor loads the steps it left and its undo stack gets
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
  with `${NAME}` in place of a project variable's value (where the value stands by itself, not inside a
  longer word, and never in the host of a URL). This narrows what an injected instruction can do;
  it does not make the model immune. The assistant can still be talked into steps the request did not ask
  for, including removing steps (one undo restores them) or typing a variable into a form of a page it was
  led to, so review what it built, and set `ALLOWED_HOSTS` when project variables hold real credentials.
- One session at a time per test case (409 otherwise). A message is 2000 characters at most.
- A session stops after 40 model requests, 12 minutes from the moment it starts, or an estimated $5,
  whichever comes first, and can be aborted; the steps built up to that point are kept. With five
  requests or two minutes left the model is told once to wrap up: get what is there to pass and say
  plainly what is unfinished. The time limit
  also holds inside a tool call: a run or a replay stops between two steps when the time is up, and a
  model request is cut off at the limit, retries included. A session that stops responding is closed 15
  minutes after it started, one that was never picked up 15 minutes after it was queued.
- The model's replies cost money on your Anthropic account, so the deployment as a whole has a budget per
  24 hours: by default 100 sessions and an estimated $40 (`ASSISTANT_DAILY_SESSIONS`,
  `ASSISTANT_DAILY_BUDGET_USD`); past either, a new session is refused with a 429. "One session per test
  case" alone bounds nothing, since test cases are free to create; for the same reason the use is counted
  in a table of its own (`assistant_usage`), so deleting a test case does not give its sessions back. This is a backstop, not a substitute for
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
the same 18 tasks against the bundled demo site, each in a fresh test case. Four are plain: (a) sign in and
assert the welcome message, (b) sign in with a wrong password and assert the error, (c) go from the home page
to the reservation form, book 2 nights for 2 guests with breakfast and assert the guest name on the
confirmation page (the form also insists on a check-in date the request does not mention), (d) on the
emulated iPhone open the menu, sign in and assert the greeting. The other fourteen are what people actually
type, and what went wrong in use:

| Task | The request | What the check looks for, besides a green run |
| --- | --- | --- |
| vague | "Test the reservation flow." | the reservation is confirmed and something is asserted after it |
| multi-part | sign in, book a named plan for 3 nights with breakfast and a note, check name, plan and a total of $630.00 | every part, including all three assertions |
| chinese | the reservation, asked for in Chinese | the plan the page calls "Deluxe harbor view" is chosen and asserted, and the summary is in Chinese |
| japanese | a sign-in without a password, asked for in Japanese | the page's own error text is asserted, and the summary is in Japanese |
| no-such-option | "Book the Ocean view room for 5 guests ..." (the site has neither) | the summary says there is no Ocean view plan and how many guests were chosen instead |
| false-expectation | "... check that the heading says Good morning, Demo User" (it says "Welcome back") | the summary says so; if the steps keep the check as asked, the run has to fail |
| edit-existing | a prepared six-step test: "change the dates and add a check for the total" | the two values are changed in place, the other steps are untouched, the total is asserted |
| shared-first | a test that starts with a shared step call ("Sign in") | the call is still step 1 and the sign-in is not rebuilt next to it |
| data-driven | "Use a data table to try these three accounts ..." | a data table with the three rows, its columns typed into the form, every row green |
| variables | "Sign in with the account from the project variables ..." | `${USER_EMAIL}` and `${USER_PASSWORD}` are typed, the password is in no step |
| follow-up | a second message on the same test case: "No, I meant check the email address shown under it, not the welcome message." | the email is asserted, the welcome message no longer is, the sign-in steps are there once |
| page-changes | choose a plan and add breakfast, "check that the total and the line under it have been updated" | both texts as they are after the clicks ($275.00, "with breakfast") |
| by-url | "Build a reservation test for http://.../demo/reserve.html?ui=v2 : ..." | the test starts with a Navigate step to that page |
| negative | confirm a reservation without a name and verify the error message | no name is typed and the error text is asserted |

A run passes only if every session ended `done`, a normal run of the steps it left succeeds afterwards
(every data row of a data-driven test case), and the steps contain what was asked for. All of it is checked
by the script on the steps, the data table and, where the request could not be met as written, on what the
closing summary admits; never on the model's own word that it is done.

Haiku before and after the guards and the finishing gate described above, three runs per task, medians,
effort `medium`:

| Task | Passed before | Requests | Seconds | Cost | Passed after | Requests | Seconds | Cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| (a) sign in | 3/3 | 15 | 24 | $0.0030 | 3/3 | 6 | 26 | $0.0019 |
| (b) wrong password | 3/3 | 9 | 24 | $0.0020 | 3/3 | 6 | 26 | $0.0017 |
| (c) reservation | 3/3 | 12 | 21 | $0.0027 | 3/3 | 8 | 27 | $0.0028 |
| (d) phone menu | 3/3 | 18 | 27 | $0.0035 | 3/3 | 10 | 35 | $0.0028 |
| vague | 3/3 | 15 | 29 | $0.0034 | 3/3 | 9 | 27 | $0.0037 |
| multi-part | 3/3 | 8 | 54 | $0.0032 | 3/3 | 12 | 54 | $0.0049 |
| chinese | 3/3 | 17 | 39 | $0.0041 | 3/3 | 9 | 29 | $0.0038 |
| japanese | 2/3 | 6 | 27 | $0.0018 | 3/3 | 6 | 21 | $0.0017 |
| no-such-option | 3/3 | 14 | 84 | $0.0044 | 3/3 | 8 | 42 | $0.0029 |
| false-expectation | 3/3 | 12 | 42 | $0.0029 | 3/3 | 10 | 47 | $0.0034 |
| edit-existing | 3/3 | 6 | 24 | $0.0013 | 3/3 | 5 | 21 | $0.0013 |
| shared-first | 3/3 | 6 | 15 | $0.0012 | 3/3 | 6 | 14 | $0.0016 |
| data-driven | 0/3 | 13 | 32 | $0.0045 | 3/3 | 10 | 24 | $0.0032 |
| variables | 3/3 | 7 | 14 | $0.0017 | 3/3 | 8 | 17 | $0.0022 |
| follow-up | 3/3 | 18 | 39 | $0.0037 | 3/3 | 10 | 30 | $0.0030 |
| page-changes | 3/3 | 7 | 21 | $0.0019 | 3/3 | 8 | 27 | $0.0028 |
| by-url | 3/3 | 12 | 26 | $0.0028 | 3/3 | 8 | 20 | $0.0026 |
| negative | 3/3 | 9 | 15 | $0.0018 | 3/3 | 8 | 27 | $0.0026 |
| **all** | **50/54** | | | | **54/54** | | | |

What the numbers say, and what they do not:

- Before, the four failures were the data-driven task (the assistant had no way to write a data table) and
  one Japanese request answered with an English summary. After, all 54 runs passed. Three runs per task is
  a small sample: it shows that nothing is broken, not that nothing can fail.
- The 54 sessions took 616 model requests before and 444 after, at the same total cost ($0.15): the
  review adds a request to every session, and `add_step` no longer wastes them (133 of 523 calls were
  refused before, 1 of 369 after).
- In 2 of the 54 sessions after, the model added a step that acts on the page before any Navigate step,
  the mistake that cost a production session ten requests on a blank page. Both times the Navigate step
  was put in front and the session went on as if it had been there.
- The finishing gate sent the model back in the false-expectation task only (it wanted to end on a failed
  run without having said in the review what could not be done); everywhere else the model ran and
  reviewed by itself. The gate is a net, and these tasks rarely make the model fall into it.
- While the review was being added, 2 of 3 Chinese requests got an English summary (the session by then
  holds much more English than Chinese). The task now names the language of the request and a summary in
  another script is sent back once; after that, 7 of 7 Chinese and 7 of 7 Japanese runs answered in the
  language of the request.

The same 18 tasks on the larger models, one run each:

| Model | Passed | Requests (median) | Seconds (median) | Cost (median) | Cost of the 18 |
| --- | --- | --- | --- | --- | --- |
| `claude-haiku-5-5` (3 runs each) | 54/54 | 8 | 27 | $0.0028 | $0.05 |
| `claude-sonnet-5-5` | 18/18 | 6 | 35 | $0.035 | $0.68 |
| `claude-opus-5-5` | 18/18 | 6 | 43 | $0.073 | $1.42 |

Haiku passed every run at about a thirteenth of the price of the next model, so it stays the default, and
there is no automatic switch to a larger model when a session struggles: nothing measured here would have
been rescued by one. This is one simple site. Sonnet and Opus need fewer requests and are the ones to
switch to (`"ASSISTANT_MODEL": "claude-opus-5-5"`) when the assistant struggles with a complex application.
Seconds are wall-clock on a laptop with two sessions running at a time; most of it is the browser, not the
model.

What a session costs was also reduced independently of the model. Before, task (a) on Opus cost $0.09 to
$0.12; with the changes below it cost $0.04 to $0.07 on Opus and about $0.002 on Haiku (the review of the
request has since added a request to every session: task (a) on Opus is now $0.10).

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
pnpm bench:assistant http://localhost:5173 --models claude-haiku-5-5:3,claude-sonnet-5-5:1,claude-opus-5-5:1 --parallel 2
```

It prints the table and writes the raw results, transcripts included, to a JSON file (`--out`). The run
above (90 sessions) cost $2.25 in API usage; `--tasks` runs a selection. The script selects the model per session with an `X-Assistant-Model` header,
which the Worker honours only when that var is set and the request was addressed to localhost; on a
deployment the header does nothing, and against one the script only measures the deployed model.
