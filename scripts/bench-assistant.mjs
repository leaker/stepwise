#!/usr/bin/env node
// Benchmark of the AI assistant: the same tasks on each candidate model, graded by what the assistant built
// rather than by what it says it built. It needs nothing but Node, and it spends real money on the Anthropic
// account of the server it talks to (a full run of all three models is a few US dollars).
//
//   node scripts/bench-assistant.mjs http://localhost:5173 --models claude-haiku-5-5:3,claude-sonnet-5-5:2
//
// Options:
//   --models a[:n],b[:n]   models to compare, each with its own number of repetitions (default: the server's model)
//   --reps n               repetitions for a model listed without ":n" (default 2)
//   --tasks a,b,c          which tasks (default all); the ids are in TASKS below
//   --effort level         ask every model at this effort instead of the one in worker/assistant/models.ts
//   --parallel n           sessions at a time (default 1; the local queue runs at most 2)
//   --out file.json        where the raw results go (default: a file in the system temp directory)
//   --keep                 keep the scratch project instead of deleting it afterwards
//   --code-file path       file with the access code, when the server needs one
//
// A model other than the server's own is selected per session with the X-Assistant-Model header. The server
// honours it only in local development: ASSISTANT_DEV_OVERRIDE=1 in .dev.vars and a request to localhost.
// Each task runs in a fresh test case of a scratch project against the bundled demo site (<base>/demo). Some
// tasks start from a test case this script prepares (existing steps, a shared step call), and one sends a
// second message, a correction, to the same test case.
//
// A run of a task passes only if all three hold:
//   1. every session ended "done";
//   2. a normal run of the steps it left, started by this script afterwards, succeeded (every data row of a
//      data-driven test case). The one exception is the task that asks for a check the site does not meet:
//      if the steps keep that check, the run has to fail;
//   3. the steps contain what the instruction asked for, checked on the steps themselves. Where the request
//      cannot be met as written, the closing summary must name what was done instead.
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const GUEST = 'Taylor Reed'
const ASSERT_TEXT = new Set(['assert_text_equals', 'assert_text_contains'])
const live = (steps) => steps.filter((s) => !s.disabled)
/** An enabled text assertion whose expected value matches. */
const assertsText = (steps, pattern) => live(steps).some((s) => ASSERT_TEXT.has(s.command) && pattern.test(s.value ?? ''))
const acts = (steps, command, name) => live(steps).some((s) => s.command === command && name.test(s.target?.name ?? ''))
const inputs = (steps, value) => live(steps).some((s) => s.command === 'input' && (s.value ?? '') === value)
const count = (steps, test) => live(steps).filter(test).length
/** Every step of `before` (by id) is still there, enabled and unchanged. */
const kept = (steps, before) => before.every((b) => live(steps).some((s) => s.id === b.id && s.command === b.command && (s.value ?? '') === (b.value ?? '')))
const CJK = /[㐀-鿿]/

// ---- set-up helpers: a scenario that starts from an existing test builds it the way the editor does ----

const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16)
const step = (command, fields = {}) => ({ id: newId(), command, ...fields })
/** Save the steps, replay them and capture the screen after the last one. */
async function captureAfter(testCase, steps) {
  await api('PATCH', `/test-cases/${testCase.id}`, { steps })
  const res = await api('POST', `/test-cases/${testCase.id}/uis`, { afterStepId: steps[steps.length - 1].id })
  if (res.replayError) throw new Error(`set-up: the replay stopped: ${res.replayError.message}`)
  return res.ui
}
function pick(ui, name) {
  const el = ui.elements.find((e) => name.test(e.name))
  if (!el) throw new Error(`set-up: ${ui.url} has no element like ${name}`)
  return { uiId: ui.id, elementId: el.id, name: el.name, locator: el.locators[0], candidates: el.locators, fingerprint: el.fingerprint }
}
/** The four steps that sign in with the demo account, saved on `testCase`. */
async function signInSteps(testCase) {
  const steps = [step('navigate', { value: '${BASE_URL}/login.html' })]
  const login = await captureAfter(testCase, steps)
  steps.push(step('input', { target: pick(login, /"Email"/), value: 'demo@example.com' }), step('input', { target: pick(login, /"Password"/), value: 'demo1234' }), step('click', { target: pick(login, /"Sign in" button/) }))
  await api('PATCH', `/test-cases/${testCase.id}`, { steps })
  return steps
}

/**
 * `messages`: what the user writes, one assistant session each (a second one is a follow-up on the same test
 * case). `setup` prepares the test case before the first message and returns what `check` wants to compare
 * with. `check(steps, info)` returns null when the steps hold what was asked for, otherwise what is missing;
 * `info` has what set-up returned (`before`), the test case as it ended (`testCase`) and the assistant's
 * closing words of the last session (`summary`).
 */
const TASKS = [
  {
    id: 'signin',
    device: 'desktop',
    messages: ['Sign in with the demo account and check that the welcome message is shown.'],
    check: (steps) => (assertsText(steps, /welcome back/i) ? null : 'no text assertion on the welcome message'),
  },
  {
    id: 'wrong-password',
    device: 'desktop',
    messages: ["Try to sign in with the demo account's email but a wrong password, and check the error message."],
    check: (steps) => {
      if (inputs(steps, 'demo1234')) return 'the correct password was typed'
      return assertsText(steps, /incorrect/i) ? null : 'no text assertion on the error message'
    },
  },
  {
    id: 'reserve',
    device: 'desktop',
    messages: [`Start on the home page and go to the reservation page from there. Book 2 nights for 2 guests with breakfast under the name ${GUEST}, confirm the reservation, and check that the guest name is shown on the confirmation page.`],
    check: (steps) => {
      if (!live(steps).some((s) => s.command === 'input' && s.value === '2')) return 'the number of nights was not set to 2'
      if (!live(steps).some((s) => s.command === 'select' && /2/.test(s.value ?? ''))) return 'the number of guests was not selected'
      if (!acts(steps, 'check', /breakfast/i) && !acts(steps, 'click', /breakfast/i)) return 'breakfast was not added'
      return assertsText(steps, new RegExp(GUEST, 'i')) ? null : 'no text assertion on the guest name'
    },
  },
  {
    id: 'mobile-signin',
    device: 'iphone',
    messages: ['Open the menu, go to the sign-in page from it, sign in with the demo account and check the greeting.'],
    check: (steps) => {
      if (!acts(steps, 'click', /menu/i)) return 'the menu was not opened'
      return assertsText(steps, /welcome back/i) ? null : 'no text assertion on the greeting'
    },
  },
  // ---- harder: what people actually type ----
  {
    id: 'vague',
    device: 'desktop',
    messages: ['Test the reservation flow.'],
    check: (steps) => {
      const confirm = live(steps).findIndex((s) => s.command === 'click' && /confirm/i.test(s.target?.name ?? ''))
      if (confirm < 0) return 'the reservation was never confirmed'
      return live(steps).slice(confirm + 1).some((s) => s.command.startsWith('assert_')) ? null : 'nothing is asserted after the reservation is confirmed'
    },
  },
  {
    id: 'multi-part',
    device: 'desktop',
    messages: [
      'Sign in with the demo account, then go to the reservation page from the guest area and book the Deluxe harbor view room for 3 nights for 2 guests with breakfast, under the name Morgan Lee, with the note "Late arrival". On the confirmation page check the guest name, the room plan, and that the total is $630.00.',
    ],
    check: (steps) => {
      if (!inputs(steps, 'demo1234')) return 'did not sign in'
      if (!inputs(steps, '3')) return 'the number of nights was not set to 3'
      if (!inputs(steps, 'Late arrival')) return 'the note was not typed'
      if (!live(steps).some((s) => ['click', 'check'].includes(s.command) && /deluxe/i.test(s.target?.name ?? ''))) return 'the Deluxe plan was not chosen'
      if (!assertsText(steps, /Morgan Lee/)) return 'no text assertion on the guest name'
      if (!assertsText(steps, /Deluxe harbor view/)) return 'no text assertion on the room plan'
      return assertsText(steps, /630\.00/) ? null : 'no text assertion on the total'
    },
  },
  {
    id: 'chinese',
    device: 'desktop',
    messages: ['打开预订页面，预订豪华海景房，住 2 晚，2 位客人，姓名填 Li Wei。确认预订后，检查确认页面上显示了客人姓名和房型。'],
    check: (steps, { summary }) => {
      if (!inputs(steps, '2')) return 'the number of nights was not set to 2'
      if (!live(steps).some((s) => ['click', 'check'].includes(s.command) && /deluxe/i.test(s.target?.name ?? ''))) return 'the Deluxe plan was not chosen'
      if (!assertsText(steps, /Li Wei/)) return 'no text assertion on the guest name'
      if (!assertsText(steps, /Deluxe harbor view/)) return 'no text assertion on the room plan (as the page writes it)'
      return CJK.test(summary) ? null : 'the summary is not in Chinese'
    },
  },
  {
    id: 'no-such-option',
    device: 'desktop',
    // The form offers 1-4 guests and has no plan of that name: whatever is chosen instead has to be said.
    messages: ['Book the Ocean view room for 5 guests under the name Sam Park and check that the confirmation page shows the name.'],
    check: (steps, { summary }) => {
      if (!assertsText(steps, /Sam Park/)) return 'no text assertion on the guest name'
      if (!/ocean/i.test(summary)) return 'the summary does not say that there is no Ocean view plan'
      const guests = live(steps).find((s) => s.command === 'select')?.value ?? '1 guest'
      const digit = /\d/.exec(guests)?.[0] ?? '1'
      if (!/\b5\b/.test(summary) || !new RegExp(`\\b${digit}\\b|four|maximum|at most|up to`, 'i').test(summary)) return `the summary does not say that ${guests} was chosen instead of 5 guests`
      return null
    },
  },
  {
    id: 'edit-existing',
    device: 'desktop',
    async setup(testCase) {
      const steps = [step('navigate', { value: '${BASE_URL}/reserve.html' })]
      const form = await captureAfter(testCase, steps)
      steps.push(
        step('input', { target: pick(form, /"Check-in date"/), value: '2026-12-01' }),
        step('input', { target: pick(form, /"Nights"/), value: '2' }),
        step('input', { target: pick(form, /"Full name"/), value: 'Alex Kim' }),
        step('click', { target: pick(form, /"Confirm reservation" button/) }),
      )
      const done = await captureAfter(testCase, steps)
      steps.push(step('assert_text_equals', { target: pick(done, /"Alex Kim"/), value: 'Alex Kim' }))
      await api('PATCH', `/test-cases/${testCase.id}`, { steps })
      return { steps }
    },
    messages: ['Change the check-in date to 2027-01-15 and the stay to 4 nights, and add a check for the total on the confirmation page.'],
    check: (steps, { before }) => {
      const [navigate, , , name, confirm, guest] = before.steps
      if (!kept(steps, [navigate, name, confirm, guest])) return 'steps the request did not mention were changed or removed'
      if (!inputs(steps, '2027-01-15') || inputs(steps, '2026-12-01')) return 'the check-in date was not changed'
      if (!inputs(steps, '4') || count(steps, (s) => s.command === 'input' && /nights/i.test(s.target?.name ?? '')) !== 1) return 'the nights were not changed to 4 in place'
      if (count(steps, (s) => s.command === 'navigate') !== 1) return 'the test was rebuilt next to the existing steps'
      return assertsText(steps, /480\.00/) ? null : 'no text assertion on the total ($480.00)'
    },
  },
  {
    id: 'shared-first',
    device: 'desktop',
    async setup(testCase, project) {
      const shared = await api('POST', `/projects/${project.id}/shared-steps`, { name: `Sign in ${newId().slice(0, 6)}`, device: 'desktop' })
      await signInSteps(shared)
      const steps = [step('shared_step', { value: shared.id })]
      await api('PATCH', `/test-cases/${testCase.id}`, { steps })
      return { steps }
    },
    messages: ['After signing in, go to the reservation page from the guest area and check that the total shows $120.00 before anything is filled in.'],
    check: (steps, { before }) => {
      if (steps[0]?.id !== before.steps[0].id || steps[0].disabled) return 'the shared step call is no longer the first step'
      if (inputs(steps, 'demo1234')) return 'signed in again with its own steps instead of using the shared step'
      if (!acts(steps, 'click', /reserve/i)) return 'did not go to the reservation page from the guest area'
      return assertsText(steps, /120\.00/) ? null : 'no text assertion on the total'
    },
  },
  {
    id: 'data-driven',
    device: 'desktop',
    messages: [
      'Use a data table to try these three accounts, one run each: anna@example.com / wrong1, ben@example.com / wrong2, demo@example.com / Demo1234. Each of them must be refused with the error message.',
    ],
    check: (steps, { testCase }) => {
      const table = testCase.data
      if (!table || table.rows.length !== 3) return 'the test case has no data table with three rows'
      const cells = table.rows.flat()
      for (const text of ['anna@example.com', 'wrong1', 'ben@example.com', 'wrong2', 'demo@example.com', 'Demo1234']) if (!cells.includes(text)) return `the data table does not hold ${text}`
      const typed = live(steps).filter((s) => s.command === 'input').map((s) => s.value ?? '')
      if (!table.columns.every((c) => typed.some((v) => v.includes(`\${${c}}`)))) return 'not every column of the data table is typed into the form'
      return assertsText(steps, /incorrect/i) ? null : 'no text assertion on the error message'
    },
  },
  {
    id: 'follow-up',
    device: 'desktop',
    messages: ['Sign in with the demo account and check that the welcome message is shown.', 'No, I meant check the email address shown under it, not the welcome message.'],
    check: (steps) => {
      if (count(steps, (s) => s.command === 'input' && s.value === 'demo1234') !== 1) return 'the sign-in steps were duplicated or lost'
      if (assertsText(steps, /welcome back/i)) return 'the welcome message is still asserted'
      return assertsText(steps, /demo@example\.com/) ? null : 'no text assertion on the email address'
    },
  },
  {
    id: 'page-changes',
    device: 'desktop',
    // The total and the line under it only change after the clicks: both have to be read from a new capture.
    messages: ["On the reservation page choose the Captain's suite and add breakfast, then check that the total and the line under it have been updated."],
    check: (steps) => {
      if (!assertsText(steps, /275\.00/)) return 'no text assertion on the updated total ($275.00)'
      return assertsText(steps, /with breakfast/) ? null : 'no text assertion on the updated line under the total'
    },
  },
  {
    id: 'by-url',
    device: 'desktop',
    // The page is named by its address and is the redesigned variant of the site: nothing but a capture shows
    // what it offers, and nothing but a Navigate step gets a run there.
    messages: [(base) => `Build a reservation test for ${base}/demo/reserve.html?ui=v2 : 3 nights, the name Dana Fox, then confirm and check the name on the page that follows.`],
    check: (steps) => {
      const first = live(steps)[0]
      if (first?.command !== 'navigate' || !/reserve\.html\?ui=v2/.test(first.value ?? '')) return 'the test does not start by opening the page that was named'
      if (!inputs(steps, '3')) return 'the number of nights was not set to 3'
      return assertsText(steps, /Dana Fox/) ? null : 'no text assertion on the guest name'
    },
  },
  {
    id: 'japanese',
    device: 'desktop',
    messages: ['ログインページでメールアドレスだけを入力してサインインボタンを押し、表示されるエラーメッセージを確認するテストを作ってください。'],
    check: (steps, { summary }) => {
      if (live(steps).some((s) => s.command === 'input' && /password/i.test(s.target?.name ?? '') && (s.value ?? '') !== '')) return 'a password was typed'
      if (!assertsText(steps, /Enter your email and password/)) return 'no text assertion on the error message (as the page writes it)'
      return /[\u3040-\u30ff]/.test(summary) ? null : 'the summary is not in Japanese'
    },
  },
  {
    id: 'variables',
    device: 'desktop',
    project: { variables: { USER_EMAIL: 'demo@example.com', USER_PASSWORD: 'demo1234' } },
    messages: ["Sign in with the account from the project variables and check that the guest area shows that account's email address."],
    check: (steps) => {
      if (!inputs(steps, '${USER_EMAIL}') || !inputs(steps, '${USER_PASSWORD}')) return 'the project variables were not used to sign in'
      if (inputs(steps, 'demo1234')) return 'the password was written into a step'
      return live(steps).some((s) => ASSERT_TEXT.has(s.command) && /\$\{USER_EMAIL\}|demo@example\.com/.test(s.value ?? '')) ? null : 'no text assertion on the email address'
    },
  },
  {
    id: 'false-expectation',
    device: 'desktop',
    // The page says "Welcome back". Whether the assertion is kept as asked (the test then fails, which is the
    // finding) or changed to what the page says, the user has to be told that the page does not say this.
    messages: ['Sign in with the demo account and check that the heading on the next page says "Good morning, Demo User".'],
    expectRun: (steps) => (assertsText(steps, /good morning/i) ? 'failed' : 'succeeded'),
    check: (steps, { summary }) => {
      if (!inputs(steps, 'demo1234')) return 'did not sign in'
      if (!assertsText(steps, /good morning|welcome back/i)) return 'no text assertion on the heading'
      return /good morning/i.test(summary) && /welcome back/i.test(summary) ? null : 'the summary does not say that the heading reads "Welcome back", not "Good morning"'
    },
  },
  {
    id: 'negative',
    device: 'desktop',
    messages: ['Check that a reservation cannot be confirmed without a name: fill in a check-in date, leave the name empty, confirm, and verify the error message.'],
    check: (steps) => {
      if (live(steps).some((s) => s.command === 'input' && /full name/i.test(s.target?.name ?? '') && (s.value ?? '') !== '')) return 'a name was typed'
      if (!live(steps).some((s) => s.command === 'input' && /^\d{4}-\d{2}-\d{2}$/.test(s.value ?? ''))) return 'no check-in date was typed'
      return assertsText(steps, /name of the main guest/i) ? null : 'no text assertion on the error message'
    },
  },
]

// ---------- arguments ----------

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  if (i < 0) return undefined
  const value = args[i + 1]
  args.splice(i, 2)
  return value ?? ''
}
const has = (name) => {
  const i = args.indexOf(`--${name}`)
  if (i >= 0) args.splice(i, 1)
  return i >= 0
}
const fail = (message) => {
  console.error(message)
  process.exit(2)
}

const modelsArg = flag('models')
const defaultReps = Number(flag('reps') ?? 2)
const tasksArg = flag('tasks')
const effort = flag('effort')
const parallel = Math.max(1, Number(flag('parallel') ?? 1))
const outFile = flag('out') ?? join(tmpdir(), `stepwise-assistant-bench-${Date.now()}.json`)
const codeFile = flag('code-file')
const keep = has('keep')
const baseUrl = (args[0] ?? '').replace(/\/+$/, '')
if (!/^https?:\/\//.test(baseUrl) || args.length !== 1) fail('Usage: node scripts/bench-assistant.mjs <base URL> [--models a:3,b:2] [--reps 2] [--tasks signin,reserve] [--effort low] [--out file.json]')
if (!Number.isInteger(defaultReps) || defaultReps < 1) fail('--reps must be a positive whole number')
const tasks = tasksArg ? tasksArg.split(',').map((id) => TASKS.find((t) => t.id === id.trim()) ?? fail(`Unknown task "${id}". Tasks: ${TASKS.map((t) => t.id).join(', ')}`)) : TASKS
const accessCode = codeFile ? readFileSync(codeFile, 'utf8').trim() : ''

// ---------- HTTP ----------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function api(method, path, body, headers = {}) {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: { ...(accessCode ? { authorization: `Bearer ${accessCode}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }
  if (res.ok) return data
  throw new Error(`${method} ${path}: ${data && typeof data.error === 'string' ? data.error : `HTTP ${res.status}`}`)
}

async function poll(path, done, timeoutMs) {
  const until = Date.now() + timeoutMs
  for (;;) {
    const value = await api('GET', path)
    if (done(value)) return value
    if (Date.now() > until) throw new Error(`${path} did not finish within ${Math.round(timeoutMs / 60_000)} minutes`)
    await sleep(1500)
  }
}

// ---------- one attempt ----------

async function attempt(project, model, task, rep) {
  const record = { model, task: task.id, rep, pass: false, session: null, run: null, reason: null, turns: 0, seconds: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, steps: [], transcript: [] }
  try {
    // A task that needs a project of its own (project variables) gets one; it is deleted with the others.
    if (task.project) {
      project = await api('POST', '/projects', { name: `Assistant benchmark ${task.id} ${new Date().toISOString()}`, baseUrl: `${baseUrl}/demo` })
      scratch.push(project.id)
      await api('PATCH', `/projects/${project.id}`, task.project)
    }
    const testCase = await api('POST', `/projects/${project.id}/test-cases`, { name: `${task.id} / ${model} / ${rep}`, device: task.device })
    const before = task.setup ? await task.setup(testCase, project) : null
    let summary = ''
    for (const written of task.messages) {
      const message = typeof written === 'function' ? written(baseUrl) : written
      const started = Date.now()
      const created = await api('POST', `/test-cases/${testCase.id}/assistant`, { message }, { 'x-assistant-model': model, ...(effort ? { 'x-assistant-effort': effort } : {}) })
      const session = await poll(`/assistant/${created.id}`, (s) => s.status !== 'queued' && s.status !== 'running', 16 * 60_000)
      record.seconds = Math.round((record.seconds + (Date.now() - started) / 1000) * 10) / 10
      record.session = session.status
      // The transcript goes into the raw results: it is what explains a failed run once the scratch project is gone.
      record.transcript.push(...session.events.map((e) => `${e.kind}: ${e.text}${e.detail ? ` [${e.detail}]` : ''}`))
      summary = session.events.findLast((e) => e.kind === 'assistant')?.text ?? ''
      const u = session.usage
      if (u) {
        // The server ignored the header: the numbers would be filed under the wrong model.
        if (u.model !== model) throw new Error(`the session ran on ${u.model}, not ${model}. Set ASSISTANT_DEV_OVERRIDE=1 in .dev.vars and use a localhost URL.`)
        for (const key of ['turns', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'costUsd']) record[key] += u[key]
        if (u.otherModels?.length) record.otherModels = u.otherModels
      }
      if (session.status !== 'done') {
        record.reason = `session ${session.status}${session.error ? `: ${session.error}` : ''}`
        break
      }
    }
    const after = await api('GET', `/test-cases/${testCase.id}`)
    const steps = after.steps
    record.steps = steps.map((s) => ({ command: s.command, ...(s.target ? { target: s.target.name } : {}), ...(s.value !== undefined ? { value: s.value } : {}), ...(s.disabled ? { disabled: true } : {}) }))
    if (after.data) record.data = after.data
    if (record.reason) return record
    if (steps.length === 0) {
      record.reason = 'no steps were built'
      return record
    }
    // A data-driven test case runs once per data row here, and every row has to pass.
    const queued = await api('POST', `/test-cases/${testCase.id}/runs`, {})
    const run = await poll(`/runs/${queued.id}`, (r) => r.status !== 'queued' && r.status !== 'running', 16 * 60_000)
    record.run = run.status
    // One task asks for a check the site does not meet: a test that keeps that check is right to fail.
    const expected = task.expectRun?.(steps) ?? 'succeeded'
    if (run.status !== expected) {
      const failed = (run.steps ?? []).find((s) => s.status === 'failed')
      record.reason = `independent run ${run.status}${expected === 'failed' ? ', and the steps were expected to fail' : ''}${failed?.error ? `: ${String(failed.error).split('\n')[0]}` : ''}`
      return record
    }
    record.reason = task.check(steps, { before, testCase: after, summary })
    record.pass = record.reason === null
  } catch (e) {
    record.reason = `error: ${e instanceof Error ? e.message : e}`
    record.fatal = /ASSISTANT_DEV_OVERRIDE|budget|limit of/.test(record.reason)
  }
  return record
}

// ---------- report ----------

const median = (values) => {
  if (values.length === 0) return NaN
  const sorted = values.toSorted((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
const usd = (n) => (Number.isNaN(n) ? '-' : `$${n < 0.1 ? n.toFixed(4) : n.toFixed(3)}`)

function report(results, models) {
  const rows = [['model', 'task', 'pass', 'turns', 'seconds', 'cost', 'cache write', 'cache read', 'output']]
  for (const { model } of models) {
    const ofModel = results.filter((r) => r.model === model)
    for (const group of [...tasks.map((t) => [t.id, ofModel.filter((r) => r.task === t.id)]), ['all', ofModel]]) {
      const [name, rs] = group
      if (rs.length === 0) continue
      const m = (key) => median(rs.map((r) => r[key]))
      rows.push([model, name, `${rs.filter((r) => r.pass).length}/${rs.length}`, String(m('turns')), m('seconds').toFixed(0), usd(m('costUsd')), String(Math.round(m('cacheWriteTokens'))), String(Math.round(m('cacheReadTokens'))), String(Math.round(m('outputTokens')))])
    }
  }
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)))
  console.log('\nMedians per model and task ("all" = over every run of the model):\n')
  for (const [i, row] of rows.entries()) {
    console.log(row.map((cell, c) => (c < 2 ? cell.padEnd(widths[c]) : cell.padStart(widths[c]))).join('  '))
    if (i === 0) console.log(widths.map((w) => '-'.repeat(w)).join('  '))
  }
  const failures = results.filter((r) => !r.pass)
  if (failures.length) {
    console.log('\nFailed runs:')
    for (const r of failures) console.log(`  ${r.model} / ${r.task} / ${r.rep}: ${r.reason}`)
  }
  console.log(`\nTotal estimated spend of this benchmark: ${usd(results.reduce((sum, r) => sum + r.costUsd, 0))}`)
}

// ---------- main ----------

const status = await api('GET', '/assistant/status').catch((e) => fail(`Could not reach ${baseUrl}: ${e.message}`))
if (!status.enabled) fail('The assistant is not configured on this server (ANTHROPIC_API_KEY is not set).')
const models = (modelsArg ? modelsArg.split(',') : [status.model]).map((entry) => {
  const [model, reps] = entry.trim().split(':')
  const n = reps === undefined ? defaultReps : Number(reps)
  if (!model || !Number.isInteger(n) || n < 1) fail(`Bad --models entry "${entry}". Example: claude-haiku-5-5:3`)
  return { model, reps: n }
})
const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseUrl).hostname)
if (!local && models.some((m) => m.model !== status.model)) fail(`${baseUrl} runs ${status.model}. Another model can only be selected on a local dev server (ASSISTANT_DEV_OVERRIDE=1 in .dev.vars).`)
if (!local && effort) fail('--effort is only honoured by a local dev server.')

const project = await api('POST', '/projects', { name: `Assistant benchmark ${new Date().toISOString()}`, baseUrl: `${baseUrl}/demo` })
/** Every project this run created. */
const scratch = [project.id]
const jobs = models.flatMap(({ model, reps }) => tasks.flatMap((task) => Array.from({ length: reps }, (_, i) => ({ model, task, rep: i + 1 }))))
console.log(`${jobs.length} sessions on ${baseUrl} (server default: ${status.model}${effort ? `, effort ${effort}` : ''}). Raw results: ${outFile}`)

const results = []
let stop = false
const save = () => writeFileSync(outFile, JSON.stringify({ baseUrl, startedAt: project.createdAt, effort: effort ?? null, results }, null, 2))
const worker = async () => {
  for (;;) {
    const job = jobs.shift()
    if (!job || stop) return
    const r = await attempt(project, job.model, job.task, job.rep)
    results.push(r)
    save()
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.model}  ${r.task} #${r.rep}  ${r.turns} turns  ${r.seconds}s  ${usd(r.costUsd)}${r.pass ? '' : `  (${r.reason})`}`)
    if (r.fatal) stop = true
  }
}
try {
  await Promise.all(Array.from({ length: parallel }, worker))
} finally {
  save()
  if (!keep) for (const id of scratch) await api('DELETE', `/projects/${id}`).catch((e) => console.error(`Could not delete the scratch project: ${e.message}`))
}
report(results, models)
process.exit(stop ? 2 : results.every((r) => r.pass) ? 0 : 1)
