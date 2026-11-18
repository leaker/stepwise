#!/usr/bin/env node
// Builds the example suite in the "Harbor Inn demo" project through the public HTTP API, the way a
// person does in the editor: save the steps, capture the screen after a step, pick elements from the
// capture by name, add steps, capture again. It builds one shared step ("Sign in") first, then the test
// cases; the last two call the shared step instead of signing in with steps of their own.
//
//   node scripts/seed-examples.mjs <baseUrl> [--code-file <path>] [--run]
//
//   <baseUrl>            the deployment, e.g. http://localhost:5173
//   --code-file <path>   file that holds the access code (sent as "Authorization: Bearer"; never printed)
//   --run                afterwards start a batch run of the example cases and print the results
//
// A test case or shared step that this script (or a person) finished is left alone, so the script can be run again. A case
// it could not finish - a failed build, Ctrl-C, a lost connection - is removed again when it can be, and is
// recognised and rebuilt by the next run when it cannot: while a case is being built its description starts
// with a marker that only the final save replaces.
// Exit code: 0 when everything was built (and, with --run, nothing failed), 1 otherwise, 130 when interrupted.
import { readFile } from 'node:fs/promises'

const PROJECT_NAME = 'Harbor Inn demo'
/** Starts the description of a case this script is still building. Never part of a finished case. */
const BUILDING = '[seed-examples: being built, not complete] '
const DEVICE_LABEL = { desktop: 'Desktop', iphone: 'iPhone 15', pixel: 'Pixel 8' }

// ---------- arguments ----------

const argv = process.argv.slice(2)
let baseUrl = ''
let codeFile = ''
let runAfter = false
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--run') runAfter = true
  else if (a === '--code-file') codeFile = argv[++i] ?? ''
  else if (a.startsWith('--code-file=')) codeFile = a.slice('--code-file='.length)
  else if (a === '-h' || a === '--help') usage(0)
  else if (a.startsWith('-')) usage(1, `Unknown option ${a}`)
  else if (!baseUrl) baseUrl = a
  else usage(1, `Unexpected argument ${a}`)
}
if (!baseUrl) usage(1, 'The base URL is required')
if (argv.includes('--code-file') && !codeFile) usage(1, '--code-file needs a path')
baseUrl = baseUrl.replace(/\/+$/, '')

function usage(code, problem) {
  if (problem) console.error(`${problem}\n`)
  console.error('Usage: node scripts/seed-examples.mjs <baseUrl> [--code-file <path>] [--run]')
  process.exit(code)
}

// ---------- HTTP ----------

let accessCode = ''
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
/** Set by Ctrl-C / SIGTERM: the build stops where it is and only the clean-up talks to the server. */
let interrupted = false
const never = new Promise(() => {})

/** One API call. A 503 means no browser could be started right now (a transient limit), so it is retried. */
async function api(method, path, body, { cleanup = false } = {}) {
  for (let attempt = 1; ; attempt++) {
    // After an interrupt the build must not go on writing while (or after) its work is being undone.
    if (interrupted && !cleanup) await never
    let res
    try {
      res = await fetch(`${baseUrl}/api${path}`, {
        method,
        headers: { ...(accessCode ? { authorization: `Bearer ${accessCode}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch (e) {
      throw new Error(`${method} ${path}: could not reach ${baseUrl} (${e instanceof Error ? e.message : e})`, { cause: e })
    }
    const text = await res.text()
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = null
    }
    if (interrupted && !cleanup) await never
    if (res.ok) return data
    if (res.status === 503 && attempt < 5 && !cleanup) {
      console.log(`    no browser available, trying again in ${attempt * 10} s`)
      await sleep(attempt * 10_000)
      continue
    }
    const reason = data && typeof data.error === 'string' ? data.error : `HTTP ${res.status}`
    if (res.status === 401) throw new Error(`${method} ${path}: ${reason}. This deployment needs an access code: pass --code-file <path>.`)
    throw new Error(`${method} ${path}: ${reason}`)
  }
}

// ---------- building a test case ----------

const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16)

/** The steps of one test case while it is being built. Every capture replays the saved steps in a real browser. */
class Builder {
  constructor(testCase, steps = []) {
    this.testCase = testCase
    this.steps = steps
    /** Screens captured while building, so a build that is undone can take them away again. */
    this.uiIds = []
  }

  /** Append a step. `target` is an element picked with pick(). */
  add(command, fields = {}) {
    const step = { id: newId(), command, ...fields }
    this.steps.push(step)
    return step
  }

  async save() {
    await api('PATCH', `/test-cases/${this.testCase.id}`, { steps: this.steps })
  }

  /** Save, replay everything up to the last step and capture the screen the test is on. */
  async capture() {
    await this.save()
    const last = this.steps[this.steps.length - 1]
    const res = await api('POST', `/test-cases/${this.testCase.id}/uis`, { afterStepId: last.id })
    this.uiIds.push(res.ui.id)
    if (res.replayError) {
      const n = this.steps.findIndex((s) => s.id === res.replayError.stepId) + 1
      throw new Error(`the replay before a capture stopped at step ${n}: ${res.replayError.message}`)
    }
    console.log(`    captured ${res.ui.name} after step ${this.steps.length}: ${res.ui.elements.length} elements (${res.ui.url})`)
    return res.ui
  }
}

/** The element with this name on a captured screen, as a step target. Of several, the topmost one. */
function pick(ui, name) {
  const hits = ui.elements.filter((e) => e.name === name).sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x)
  if (hits.length === 0) throw new Error(`${ui.name} (${ui.url}) has no element named ${name}. It has: ${ui.elements.map((e) => e.name).join(' | ')}`)
  const el = hits[0]
  return { uiId: ui.id, elementId: el.id, name: el.name, locator: el.locators[0], candidates: el.locators, fingerprint: el.fingerprint }
}

const LOGIN_URL = '${BASE_URL}/login.html${SITE_VERSION}'

/** Steps shared by the cases that start signed in. Returns the dashboard capture. */
async function signIn(b) {
  if (b.steps.length === 0) b.add('navigate', { value: LOGIN_URL })
  const login = await b.capture()
  b.add('input', { target: pick(login, '"Email" input area'), value: 'demo@example.com' })
  b.add('input', { target: pick(login, '"Password" input area'), value: 'demo1234' })
  b.add('click', { target: pick(login, '"Sign in" button') })
  return b.capture()
}

/** Shared steps, built before the test cases: a case's build gets their ids by name. */
const SHARED = [
  {
    kind: 'shared',
    name: 'Sign in',
    description:
      'Opens the login page and signs in with the demo account. Test cases call it with the "Shared step" command instead of repeating these four steps; changing it here changes all of them, and a locator repaired by self-healing is saved here once.',
    device: 'desktop',
    async build(b) {
      b.add('navigate', { value: LOGIN_URL })
      const login = await b.capture()
      b.add('input', { target: pick(login, '"Email" input area'), value: 'demo@example.com' })
      b.add('input', { target: pick(login, '"Password" input area'), value: 'demo1234' })
      b.add('click', { target: pick(login, '"Sign in" button') })
    },
  },
]

const CASES = [
  {
    name: 'Sign in with valid credentials',
    description: 'Opens the login page, types the demo account, clicks Sign in, then checks the welcome heading and that the URL is the dashboard. The smallest complete test: navigate, input, click, two assertions.',
    device: 'desktop',
    async build(b) {
      const dashboard = await signIn(b)
      b.add('assert_text_equals', { target: pick(dashboard, '"Welcome back, Demo User" text'), value: 'Welcome back, Demo User' })
      b.add('assert_url_contains', { value: 'dashboard' })
    },
  },
  {
    name: 'Sign in with a wrong password shows an error',
    description: 'Negative path: a wrong password must show "The email or password is incorrect." and must not leave the login page. The error box only exists after the click, so it is picked from a capture taken after that step.',
    device: 'desktop',
    async build(b) {
      b.add('navigate', { value: LOGIN_URL })
      const login = await b.capture()
      b.add('input', { target: pick(login, '"Email" input area'), value: 'demo@example.com' })
      b.add('input', { target: pick(login, '"Password" input area'), value: 'not-the-password' })
      b.add('click', { target: pick(login, '"Sign in" button') })
      const rejected = await b.capture()
      b.add('assert_text_equals', { target: pick(rejected, '"The email or password is incorrect." text'), value: 'The email or password is incorrect.' })
      b.add('assert_url_contains', { value: 'login' })
    },
  },
  {
    name: 'Reserve a room end to end',
    description:
      'Signs in, opens the reservation form and fills every kind of field (date, number, pull-down menu, checkbox, radio button, text, text area). The total price is stored in a variable before confirming, and the confirmation page must show the guest name and that same total (${TOTAL}).',
    device: 'desktop',
    async build(b) {
      const dashboard = await signIn(b)
      b.add('click', { target: pick(dashboard, '"Reserve a room" link') })
      const form = await b.capture()
      b.add('input', { target: pick(form, '"Check-in date" input area'), value: '2031-05-01' })
      b.add('input', { target: pick(form, '"Nights" input area'), value: '2' })
      b.add('select', { target: pick(form, '"Guests" combo box'), value: '2 guests' })
      b.add('check', { target: pick(form, '"Add breakfast" checkbox') })
      b.add('click', { target: pick(form, '"Deluxe harbor view" radio button') })
      b.add('input', { target: pick(form, '"Full name" input area'), value: 'Alice Example' })
      b.add('input', { target: pick(form, '"Notes for the front desk" text area'), value: 'Late arrival, around 10 PM' })
      // 2 nights x $180 + breakfast for 2 guests x 2 nights x $15 = $420.00, shown once the form is filled.
      const filled = await b.capture()
      b.add('store_text', { target: pick(filled, '"$420.00" text'), variable: 'TOTAL' })
      b.add('click', { target: pick(filled, '"Confirm reservation" button') })
      const confirmation = await b.capture()
      b.add('assert_text_equals', { target: pick(confirmation, '"Your reservation is confirmed" text'), value: 'Your reservation is confirmed' })
      b.add('assert_text_equals', { target: pick(confirmation, '"Alice Example" text'), value: 'Alice Example' })
      b.add('assert_text_equals', { target: pick(confirmation, '"$420.00" text'), value: '${TOTAL}' })
      b.add('assert_url_contains', { value: 'confirm' })
    },
  },
  {
    name: 'Conditional flow with variables',
    description:
      'Shows the logic commands: Store fixed value, If variable equals / Otherwise / End branch, If UI element exists, comments, Wait until visible and Assert variable equals. The account to sign in with is chosen by a variable, and a second branch records whether the guest area was reached.',
    device: 'desktop',
    async build(b) {
      b.add('navigate', { value: LOGIN_URL })
      const login = await b.capture()
      b.add('comment', { value: 'Choose the account with a variable' })
      b.add('store_fixed', { variable: 'ACCOUNT', value: 'member' })
      b.add('if_variable_equals', { variable: 'ACCOUNT', value: 'member' })
      b.add('store_fixed', { variable: 'PASSWORD', value: 'demo1234' })
      b.add('else')
      b.add('comment', { value: 'Any other account gets a password that is rejected' })
      b.add('store_fixed', { variable: 'PASSWORD', value: 'wrong-password' })
      b.add('end_if')
      b.add('input', { target: pick(login, '"Email" input area'), value: 'demo@example.com' })
      b.add('input', { target: pick(login, '"Password" input area'), value: '${PASSWORD}' })
      b.add('click', { target: pick(login, '"Sign in" button') })
      const dashboard = await b.capture()
      b.add('wait_visible', { target: pick(dashboard, '"Welcome back, Demo User" text'), value: '10' })
      // A condition never self-heals (a missing element is a valid answer), so it uses an element whose
      // locator does not depend on an id: this heading is found by its text in both designs of the site.
      b.add('comment', { value: 'Branch on what the page shows: only the guest area lists past stays' })
      b.add('if_exists', { target: pick(dashboard, '"Past stays" text') })
      b.add('store_fixed', { variable: 'RESULT', value: 'signed in' })
      b.add('else')
      b.add('store_fixed', { variable: 'RESULT', value: 'rejected' })
      b.add('end_if')
      b.add('assert_variable_equals', { variable: 'RESULT', value: 'signed in' })
    },
  },
  {
    name: 'Mobile: open the menu and start a reservation',
    description:
      'Runs on an emulated iPhone 15 (phone viewport, user agent and touch). On a phone the navigation is hidden behind the Menu button, so the test taps Menu, then Reserve, swipes up to move down the form and checks the form heading. The same links are directly visible on desktop.',
    device: 'iphone',
    async build(b) {
      b.add('navigate', { value: '${BASE_URL}/index.html${SITE_VERSION}' })
      const home = await b.capture()
      b.add('click', { target: pick(home, '"Menu" button') })
      const menu = await b.capture()
      b.add('click', { target: pick(menu, '"Reserve" link') })
      const form = await b.capture()
      b.add('swipe', { value: 'up' })
      b.add('assert_text_equals', { target: pick(form, '"Reserve a room" text'), value: 'Reserve a room' })
      b.add('assert_url_contains', { value: 'reserve' })
    },
  },
  // The two below start with a call to the shared step. A capture replays through the call, so the elements
  // picked after it come from the page the shared step leaves the test on.
  {
    name: 'Shared step: the guest area after signing in',
    description:
      'Step 1 calls the shared step "Sign in" (S1) instead of repeating the login steps. The rest checks what a signed-in guest sees: the welcome heading, the list of past stays and the dashboard URL.',
    device: 'desktop',
    async build(b, shared) {
      b.add('shared_step', { value: shared['Sign in'] })
      const dashboard = await b.capture()
      b.add('assert_text_equals', { target: pick(dashboard, '"Welcome back, Demo User" text'), value: 'Welcome back, Demo User' })
      b.add('assert_exists', { target: pick(dashboard, '"Past stays" text') })
      b.add('assert_url_contains', { value: 'dashboard' })
    },
  },
  {
    name: 'Shared step: start a reservation after signing in',
    description:
      'Also starts with the shared step "Sign in" (S1), then opens the reservation form from the dashboard and checks its heading. Two test cases calling one shared step is the point: edit the sign-in once, and both follow.',
    device: 'desktop',
    async build(b, shared) {
      b.add('shared_step', { value: shared['Sign in'] })
      const dashboard = await b.capture()
      b.add('click', { target: pick(dashboard, '"Reserve a room" link') })
      const form = await b.capture()
      b.add('assert_text_equals', { target: pick(form, '"Reserve a room" text'), value: 'Reserve a room' })
      b.add('assert_url_contains', { value: 'reserve' })
    },
  },
]

/** The build in progress, for the interrupt handler: undoes what was started on the server. */
let undoCurrent = null

/** `#3` for a test case, `S3` for a shared step. */
const label = (t) => `${t.kind === 'shared' ? 'S' : '#'}${t.number}`

/**
 * Create (or complete) one example case or shared step. Returns its id, or throws after undoing what it
 * started. `shared`: ids of the shared steps by name, for the cases that call one.
 */
async function seedCase(project, existing, spec, shared = {}) {
  const found = existing.find((t) => t.name === spec.name)
  // The demo project is created with case 1 holding only its "Navigate" step: that one is completed in place.
  const stub = found && found.steps.length <= 1 && found.steps.every((s) => s.command === 'navigate')
  // Left behind by a run that was cut off before it could save the finished case or undo its work.
  const partial = found && found.description.startsWith(BUILDING)
  if (found && !stub && !partial) {
    console.log(`  = ${label(found)} ${spec.name}: already there (${found.steps.length} steps), left as it is`)
    return found.id
  }
  let testCase = found
  // What to put back when the build fails. A partly built case has nothing worth keeping: its steps go.
  const before = found ? { steps: partial ? [] : found.steps, description: found.description, device: found.device } : null
  if (testCase) {
    console.log(`  + ${label(testCase)} ${spec.name}: ${partial ? 'found partly built by an earlier run that was cut off, building it again' : 'completing the existing test case'}`)
    testCase = await api('PATCH', `/test-cases/${testCase.id}`, { description: BUILDING + spec.description, device: spec.device, ...(partial ? { steps: [] } : {}) })
    // The screens the cut-off run captured belong to steps that no longer exist.
    if (partial) for (const ui of await api('GET', `/test-cases/${testCase.id}/uis`)) await api('DELETE', `/uis/${ui.id}`)
  } else {
    testCase = await api('POST', `/projects/${project.id}/${spec.kind === 'shared' ? 'shared-steps' : 'test-cases'}`, { name: spec.name, description: BUILDING + spec.description, device: spec.device })
    console.log(`  + ${label(testCase)} ${spec.name}: created (${spec.kind === 'shared' ? 'shared step' : (DEVICE_LABEL[spec.device] ?? spec.device)})`)
  }
  const builder = new Builder(testCase, found && !partial ? structuredClone(found.steps) : [])
  // Do not leave a half-built case behind. A new case is deleted (its captured screens go with it); the
  // demo project's own case gets its step back, keeps the marker if it was already partly built, and loses
  // the screens this build captured.
  const undo = async () => {
    const clean = { cleanup: true }
    if (!before) return api('DELETE', `/test-cases/${testCase.id}`, undefined, clean)
    await api('PATCH', `/test-cases/${found.id}`, before, clean)
    for (const uiId of builder.uiIds) await api('DELETE', `/uis/${uiId}`, undefined, clean).catch(() => {})
  }
  undoCurrent = { undo, label: `${label(testCase)} ${spec.name}` }
  try {
    await spec.build(builder, shared)
    // The last save is the one that makes the case complete: steps and the real description together.
    await api('PATCH', `/test-cases/${testCase.id}`, { steps: builder.steps, description: spec.description })
    undoCurrent = null
    console.log(`    saved ${builder.steps.length} steps`)
    return testCase.id
  } catch (e) {
    undoCurrent = null
    try {
      await undo()
    } catch {
      // The marker in its description is still there, so the next run builds it again instead of trusting it.
      console.error(`    could not undo the partly built ${label(testCase)}; the next run of this script will build it again`)
    }
    throw new Error(`"${spec.name}": ${e instanceof Error ? e.message : e}`, { cause: e })
  }
}

/** Ctrl-C or a kill: stop building, undo the case in progress, and exit with a failure code. */
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (interrupted) process.exit(130) // a second signal: give up on the clean-up
    interrupted = true
    const current = undoCurrent
    undoCurrent = null
    console.error(`\nInterrupted (${signal}).`)
    if (!current) process.exit(130)
    console.error(`Removing the partly built test case ${current.label} (press Ctrl-C again to skip)...`)
    current.undo().then(
      () => console.error('Done. Nothing half-built was left behind.'),
      (e) => console.error(`Could not undo it (${e instanceof Error ? e.message : e}). The next run of this script will build it again.`),
    ).finally(() => process.exit(130))
  })
}

// ---------- batch run ----------

const pad = (text, width) => String(text).padEnd(width)
const seconds = (from, to) => (from && to ? `${((Date.parse(to) - Date.parse(from)) / 1000).toFixed(1)} s` : '-')

async function runBatch(project, ids) {
  console.log(`\nStarting a batch run of ${ids.length} test cases`)
  let batch = await api('POST', `/projects/${project.id}/batch-runs`, { trigger: 'api', testCaseIds: ids })
  const startedAt = Date.now()
  let shown = ''
  while (batch.status === 'queued' || batch.status === 'running') {
    if (Date.now() - startedAt > 20 * 60_000) throw new Error(`batch run #${batch.number} did not finish within 20 minutes`)
    await sleep(2000)
    batch = await api('GET', `/batch-runs/${batch.id}`)
    const done = (batch.runs ?? []).filter((r) => r.status !== 'queued' && r.status !== 'running').length
    const line = `  ${batch.status}: ${done} / ${batch.counts.total} finished`
    if (line !== shown) console.log((shown = line))
  }

  const rows = (batch.runs ?? []).map((r) => {
    const failed = r.results.find((x) => x.status === 'failed')
    return {
      n: `#${r.testCaseNumber}`,
      name: r.testCaseName,
      device: DEVICE_LABEL[r.environment.device] ?? r.environment.device ?? '-',
      status: r.status,
      steps: `${r.results.filter((x) => x.status === 'passed' || x.status === 'healed').length} ok / ${r.results.length}`,
      time: seconds(r.startedAt, r.finishedAt),
      note: failed ? `step ${failed.number}: ${failed.error ?? 'failed'}` : r.status === 'unresolved' ? `${r.results.filter((x) => x.status === 'healed').length} repaired step(s) wait for review` : '',
    }
  })
  const width = (key, title) => Math.max(title.length, ...rows.map((r) => String(r[key]).length))
  const cols = [
    ['n', '#'],
    ['name', 'Test case'],
    ['device', 'Device'],
    ['status', 'Status'],
    ['steps', 'Steps'],
    ['time', 'Time'],
  ].map(([key, title]) => ({ key, title, w: width(key, title) }))
  console.log(`\nBatch run #${batch.number}: ${batch.status}   ${baseUrl}/b/${batch.id}`)
  console.log(cols.map((c) => pad(c.title, c.w)).join('  '))
  console.log(cols.map((c) => '-'.repeat(c.w)).join('  '))
  for (const r of rows) {
    console.log(cols.map((c) => pad(r[c.key], c.w)).join('  '))
    if (r.note) console.log(`${' '.repeat(cols[0].w + 2)}${r.note}`)
  }
  const c = batch.counts
  console.log(`\n${c.succeeded} succeeded, ${c.failed} failed, ${c.unresolved} need review, ${c.aborted} aborted`)
  if (c.unresolved && !c.failed) console.log('Steps were repaired by self-healing (is SITE_VERSION set to ?ui=v2?). Review them in the report; this is not counted as a failure.')
  // Only a real failure fails the script; repaired runs wait for a person.
  return c.failed === 0 && c.aborted === 0
}

// ---------- main ----------

async function main() {
  if (codeFile) {
    accessCode = (await readFile(codeFile, 'utf8')).trim()
    if (!accessCode) throw new Error(`${codeFile} is empty`)
  }
  const session = await api('GET', '/session')
  if (session.required && !accessCode) throw new Error('This deployment needs an access code: pass --code-file <path>.')

  const project = (await api('GET', '/projects')).find((p) => p.name === PROJECT_NAME)
  if (!project) throw new Error(`There is no project named "${PROJECT_NAME}" on ${baseUrl}. It is created with the database (migrations/0002_demo_project.sql).`)
  console.log(`Project "${project.name}" on ${baseUrl}  (base URL ${project.baseUrl})`)
  if ((project.variables.SITE_VERSION ?? '') !== '') {
    throw new Error(`The project variable SITE_VERSION is "${project.variables.SITE_VERSION}". Clear it first: the examples are built from the original design of the sample site.`)
  }

  // Shared steps first: the cases that call one need its id, and a call to a shared step that is not there cannot run.
  const existingShared = await api('GET', `/projects/${project.id}/shared-steps`)
  const shared = {}
  for (const spec of SHARED) shared[spec.name] = await seedCase(project, existingShared, spec)

  const existing = await api('GET', `/projects/${project.id}/test-cases`)
  const ids = []
  for (const spec of CASES) ids.push(await seedCase(project, existing, spec, shared))
  console.log(`\nThe example suite is in place: ${baseUrl}/p/${project.id}`)

  if (runAfter && !(await runBatch(project, ids))) process.exitCode = 1
}

main().catch((e) => {
  console.error(`\nFailed: ${e instanceof Error ? e.message : e}`)
  process.exitCode = 1
})
