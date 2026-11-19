# Self-healing walkthrough and example suite

[Back to the README](../README.md)

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
   repaired step came from one (two cases of the example suite sign in through the shared step
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
run repairs the renamed elements in seven of the eight cases and ends *Needs review*. The eighth,
*Conditional flow with variables*, fails on purpose: its If branches test whether an element exists, and
conditions never heal, so under `?ui=v2` it takes the other branch and its final assertion fails.
