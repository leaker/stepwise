#!/usr/bin/env node
// Benchmark of the AI assistant: the same four tasks on each candidate model, graded by what the assistant
// built rather than by what it says. It needs nothing but Node, and it spends real money on the Anthropic
// account of the server it talks to (a full run of all three models is a few US dollars).
//
//   node scripts/bench-assistant.mjs http://localhost:5173 --models claude-haiku-5-5:3,claude-sonnet-5-5:2
//
// Options:
//   --models a[:n],b[:n]   models to compare, each with its own number of repetitions (default: the server's model)
//   --reps n               repetitions for a model listed without ":n" (default 2)
//   --tasks a,b,c,d        which tasks (default all): signin, wrong-password, reserve, mobile-signin
//   --effort level         ask every model at this effort instead of the one in worker/assistant/models.ts
//   --parallel n           sessions at a time (default 1; the local queue runs at most 2)
//   --out file.json        where the raw results go (default: a file in the system temp directory)
//   --keep                 keep the scratch project instead of deleting it afterwards
//   --code-file path       file with the access code, when the server needs one
//
// A model other than the server's own is selected per session with the X-Assistant-Model header. The server
// honours it only in local development: ASSISTANT_DEV_OVERRIDE=1 in .dev.vars and a request to localhost.
// Each task runs in a fresh test case of a scratch project against the bundled demo site (<base>/demo).
//
// A run of a task passes only if all three hold:
//   1. the session ended "done";
//   2. a normal run of the steps it left, started by this script afterwards, succeeded;
//   3. the steps contain what the instruction asked for, checked on the steps themselves.
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

/** `check` returns null when the steps hold what was asked for, otherwise what is missing. */
const TASKS = [
  {
    id: 'signin',
    device: 'desktop',
    message: 'Sign in with the demo account and check that the welcome message is shown.',
    check: (steps) => (assertsText(steps, /welcome back/i) ? null : 'no text assertion on the welcome message'),
  },
  {
    id: 'wrong-password',
    device: 'desktop',
    message: "Try to sign in with the demo account's email but a wrong password, and check the error message.",
    check: (steps) => {
      if (inputs(steps, 'demo1234')) return 'the correct password was typed'
      return assertsText(steps, /incorrect/i) ? null : 'no text assertion on the error message'
    },
  },
  {
    id: 'reserve',
    device: 'desktop',
    message: `Start on the home page and go to the reservation page from there. Book 2 nights for 2 guests with breakfast under the name ${GUEST}, confirm the reservation, and check that the guest name is shown on the confirmation page.`,
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
    message: 'Open the menu, go to the sign-in page from it, sign in with the demo account and check the greeting.',
    check: (steps) => {
      if (!acts(steps, 'click', /menu/i)) return 'the menu was not opened'
      return assertsText(steps, /welcome back/i) ? null : 'no text assertion on the greeting'
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
  const record = { model, task: task.id, rep, pass: false, session: null, run: null, reason: null, turns: 0, seconds: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, steps: [] }
  try {
    const testCase = await api('POST', `/projects/${project.id}/test-cases`, { name: `${task.id} / ${model} / ${rep}`, device: task.device })
    const started = Date.now()
    const created = await api('POST', `/test-cases/${testCase.id}/assistant`, { message: task.message }, { 'x-assistant-model': model, ...(effort ? { 'x-assistant-effort': effort } : {}) })
    const session = await poll(`/assistant/${created.id}`, (s) => s.status !== 'queued' && s.status !== 'running', 16 * 60_000)
    record.seconds = Math.round((Date.now() - started) / 100) / 10
    record.session = session.status
    // The transcript goes into the raw results: it is what explains a failed run once the scratch project is gone.
    record.transcript = session.events.map((e) => `${e.kind}: ${e.text}${e.detail ? ` [${e.detail}]` : ''}`)
    const u = session.usage
    if (u) {
      // The server ignored the header: the numbers would be filed under the wrong model.
      if (u.model !== model) throw new Error(`the session ran on ${u.model}, not ${model}. Set ASSISTANT_DEV_OVERRIDE=1 in .dev.vars and use a localhost URL.`)
      Object.assign(record, { turns: u.turns, inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: u.cacheReadTokens, cacheWriteTokens: u.cacheWriteTokens, costUsd: u.costUsd })
      if (u.otherModels?.length) record.otherModels = u.otherModels
    }
    const steps = (await api('GET', `/test-cases/${testCase.id}`)).steps
    record.steps = steps.map((s) => ({ command: s.command, ...(s.target ? { target: s.target.name } : {}), ...(s.value !== undefined ? { value: s.value } : {}), ...(s.disabled ? { disabled: true } : {}) }))
    if (session.status !== 'done') {
      record.reason = `session ${session.status}${session.error ? `: ${session.error}` : ''}`
      return record
    }
    if (steps.length === 0) {
      record.reason = 'no steps were built'
      return record
    }
    const queued = await api('POST', `/test-cases/${testCase.id}/runs`, {})
    const run = await poll(`/runs/${queued.id}`, (r) => r.status !== 'queued' && r.status !== 'running', 16 * 60_000)
    record.run = run.status
    if (run.status !== 'succeeded') {
      const failed = (run.steps ?? []).find((s) => s.status === 'failed')
      record.reason = `independent run ${run.status}${failed?.error ? `: ${String(failed.error).split('\n')[0]}` : ''}`
      return record
    }
    record.reason = task.check(steps)
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
  if (!keep) await api('DELETE', `/projects/${project.id}`).catch((e) => console.error(`Could not delete the scratch project: ${e.message}`))
}
report(results, models)
process.exit(stop ? 2 : results.every((r) => r.pass) ? 0 : 1)
