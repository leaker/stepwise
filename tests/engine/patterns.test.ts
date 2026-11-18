// A data-driven run end to end: the HTTP routes create it, the queue consumer executes it in a real
// browser (Node Playwright in place of Browser Run) against the bundled demo site, on a real SQLite.
import { Hono } from 'hono'
import { chromium, type Browser } from 'playwright'
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { logOfPattern, splitLog } from '../../shared/data'
import type { BatchRun, DataTable, Run, Step, TestCase } from '../../shared/types'
import { runs } from '../../worker/api/runs'
import { testCases } from '../../worker/api/testCases'
import { HttpError, type Env, type QueueMessage } from '../../worker/env'
import { handleQueue } from '../../worker/runner'
import { memoryD1 } from '../assistant/d1'
import { capture, ref, startDemoServer, type CapturedUi } from './helpers'

let browser: Browser
let contextsOpened = 0
let launches = 0
/** Set by a test to make Browser Run answer differently; by default it hands out the one browser. */
let onLaunch: (() => Promise<Browser>) | null = null
vi.mock('@cloudflare/playwright', () => ({
  launch: async () => {
    launches++
    return onLaunch ? onLaunch() : browser
  },
}))

let server: Server
let origin: string
let db: D1Database
let env: Env
let login: CapturedUi
const sent: QueueMessage[] = []
const PID = 'p1'

function app() {
  const a = new Hono<{ Bindings: Env }>()
  a.onError((err, c) => (err instanceof HttpError ? c.json({ error: err.message }, err.status) : c.json({ error: String(err) }, 500)))
  a.route('/api', testCases)
  a.route('/api', runs)
  return a
}
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await app().request(`${origin}/api${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }, env, ctx)
  const json = (await res.json()) as T & { error?: string }
  if (!res.ok) throw new Error(`${method} ${path}: ${json.error}`)
  return json
}
/** Deliver what the routes put on the queue, as the Worker's consumer gets it. */
async function drain(): Promise<void> {
  const messages = sent.splice(0).map((body) => ({ body, attempts: 1, ack: () => {}, retry: () => {} }))
  await handleQueue({ messages } as unknown as MessageBatch<QueueMessage>, env)
}

beforeAll(async () => {
  const real = await chromium.launch()
  const newContext = real.newContext.bind(real)
  real.newContext = ((...args: Parameters<Browser['newContext']>) => {
    contextsOpened++
    return newContext(...args)
  }) as Browser['newContext']
  // The runner closes the browser it "launched" after each queue message; the test keeps one for all of them.
  real.close = async () => {}
  browser = real
  const demo = await startDemoServer()
  server = demo.server
  // The demo site is on a loopback address, which a run may only open as the app's own origin.
  origin = new URL(demo.baseUrl).origin
  const page = await real.newPage({ viewport: { width: 1280, height: 800 } })
  await page.goto(`${origin}/demo/login.html`)
  login = await capture(page, 'ui-login')
  await page.close()

  db = memoryD1()
  env = { DB: db, RUN_QUEUE: { send: async (m: QueueMessage) => void sent.push(m) }, SHOTS: { put: async () => {}, delete: async () => {}, list: async () => ({ objects: [], truncated: false }) } } as unknown as Env
  // EMAIL is also a project variable: the data column must win. GREETING only exists in the project.
  await db.prepare('INSERT INTO projects (id, name, base_url, variables, created_at) VALUES (?, ?, ?, ?, ?)').bind(PID, 'Inn', '/demo', JSON.stringify({ EMAIL: 'nobody@example.com', GREETING: 'Welcome back' }), '2026-01-01T00:00:00.000Z').run()
})

afterAll(async () => {
  for (const c of browser.contexts()) await c.close()
  await Object.getPrototypeOf(browser).close.call(browser)
  await new Promise((done) => server.close(done))
})

const DATA: DataTable = {
  columns: ['EMAIL', 'PASSWORD', 'EXPECT'],
  rows: [
    ['demo@example.com', 'demo1234', 'dashboard'],
    ['demo@example.com', 'not-the-password', 'dashboard'],
    ['DEMO@example.com', 'demo1234', 'dashboard'],
  ],
}

/** A shared step that signs in with the row's account, and a test case that calls it. */
async function build(): Promise<TestCase> {
  const shared = await call<TestCase>('POST', `/projects/${PID}/shared-steps`, { name: 'Sign in' })
  const signIn: Step[] = [
    { id: 'open', command: 'navigate', value: '${BASE_URL}/login.html' },
    { id: 'email', command: 'input', target: ref(login, '"Email" input area'), value: '${EMAIL}' },
    { id: 'password', command: 'input', target: ref(login, '"Password" input area'), value: '${PASSWORD}' },
    { id: 'go', command: 'click', target: ref(login, '"Sign in" button') },
  ]
  await call('PATCH', `/test-cases/${shared.id}`, { steps: signIn })
  const created = await call<TestCase>('POST', `/projects/${PID}/test-cases`, { name: 'Sign in with several accounts' })
  const steps: Step[] = [
    { id: 'call', command: 'shared_step', value: shared.id },
    // A step may replace a column's value for the rest of its pattern, and only for that pattern.
    { id: 'if', command: 'if_variable_equals', variable: 'PASSWORD', value: 'demo1234' },
    { id: 'store', command: 'store_fixed', variable: 'EXPECT', value: 'dashboard.html' },
    { id: 'end', command: 'end_if' },
    { id: 'url', command: 'assert_url_contains', value: '${EXPECT}' },
    { id: 'vars', command: 'store_fixed', variable: 'SEEN', value: '${EMAIL} ${GREETING}' },
  ]
  return call<TestCase>('PATCH', `/test-cases/${created.id}`, { steps, data: DATA })
}

describe('a data-driven run', () => {
  it('executes every row in its own browser context, goes on after a failed row, and reports per pattern', async () => {
    const testCase = await build()
    const queued = await call<Run>('POST', `/test-cases/${testCase.id}/runs`)
    expect(queued.patterns?.map((p) => p.status)).toEqual(['queued', 'queued', 'queued'])
    contextsOpened = 0
    await drain()
    const run = await call<Run>('GET', `/runs/${queued.id}`)

    expect(contextsOpened).toBe(3)
    expect(run.patterns?.map((p) => p.status)).toEqual(['succeeded', 'failed', 'succeeded'])
    expect(run.patterns?.every((p) => p.startedAt && p.finishedAt)).toBe(true)
    expect(run.status).toBe('failed')

    // Results are kept per pattern; the steps of the shared step are numbered 1.1 ... in each of them.
    const of = (pattern: number) => run.results.filter((r) => r.pattern === pattern)
    const labels = (pattern: number) => of(pattern).map((r) => `${r.number}${r.sub ? `.${r.sub}` : ''} ${r.status}`)
    expect(labels(1)).toEqual(['1.1 passed', '1.2 passed', '1.3 passed', '1.4 passed', '2 passed', '3 passed', '4 passed', '5 passed', '6 passed'])
    // The wrong password: the "If" is false, so EXPECT keeps the row's value and the page is still the login page.
    expect(labels(2)).toEqual(['1.1 passed', '1.2 passed', '1.3 passed', '1.4 passed', '2 passed', '4 passed', '5 failed'])
    expect(labels(3)).toEqual(labels(1))
    expect(of(2).at(-1)?.error).toContain('dashboard')
    expect(run.results.every((r) => r.pattern !== undefined)).toBe(true)
    // Screenshot keys are unique across the patterns.
    const shots = run.results.flatMap((r) => (r.screenshotKey ? [r.screenshotKey] : []))
    expect(new Set(shots).size).toBe(shots.length)

    // Variables: the column wins over the project variable EMAIL, the project variable GREETING is still there,
    // and what a step stored in pattern 1 (EXPECT) did not leak into pattern 2.
    const log = splitLog(run.log)
    expect([...log.patterns.keys()]).toEqual([1, 2, 3])
    expect(log.patterns.get(1)).toContain('Data row 1: EMAIL="demo@example.com", PASSWORD="demo1234", EXPECT="dashboard"')
    expect(log.patterns.get(1)).toContain('SEEN = "demo@example.com Welcome back"')
    expect(log.patterns.get(3)).toContain('SEEN = "DEMO@example.com Welcome back"')
    expect(log.patterns.get(1)).toContain('assert_url_contains("dashboard.html")')
    expect(log.patterns.get(2)).toContain('assert_url_contains("dashboard")')
    expect(log.header).toContain('Data-driven: 3 patterns (data rows)')
    expect(log.footer).toBe(`=== Summary ===\nPattern 1: succeeded\nPattern 2: failed\nPattern 3: succeeded\nFinished: ${run.finishedAt} - failed`)
    expect(logOfPattern(run.log, 2)).not.toContain('=== Pattern 1 ===')
  }, 120_000)

  it('a partial run executes one row; a batch run counts the test case once', async () => {
    const [testCase] = (await call<TestCase[]>('GET', `/projects/${PID}/test-cases`)).filter((t) => t.data)
    const queued = await call<Run>('POST', `/test-cases/${testCase.id}/runs`, { range: { from: 1, to: 1 }, row: 3 })
    await drain()
    const partial = await call<Run>('GET', `/runs/${queued.id}`)
    expect(partial.patterns?.map((p) => [p.index, p.status])).toEqual([[3, 'succeeded']])
    expect(partial.status).toBe('succeeded')
    expect(partial.results.map((r) => [r.pattern, r.sub])).toEqual([[3, 1], [3, 2], [3, 3], [3, 4]])
    expect(partial.log).toContain('Data-driven: data row 3 only')

    const batch = await call<BatchRun>('POST', `/projects/${PID}/batch-runs`, {})
    await drain()
    const done = await call<BatchRun>('GET', `/batch-runs/${batch.id}`)
    expect(done.counts).toEqual({ total: 1, succeeded: 0, failed: 1, unresolved: 0, aborted: 0 })
    expect(done.status).toBe('failed')
    expect(done.runs?.[0].patterns?.map((p) => p.status)).toEqual(['succeeded', 'failed', 'succeeded'])
  }, 120_000)

  it('aborting stops the pattern that is running and does not start the rest', async () => {
    const [testCase] = (await call<TestCase[]>('GET', `/projects/${PID}/test-cases`)).filter((t) => t.data)
    const queued = await call<Run>('POST', `/test-cases/${testCase.id}/runs`)
    // Abort as soon as the first pattern has finished.
    const timer = setInterval(() => {
      void (async () => {
        const row = await db.prepare('SELECT patterns FROM runs WHERE id = ?').bind(queued.id).first<{ patterns: string }>()
        if (row && (JSON.parse(row.patterns) as { status: string }[])[1].status === 'running') {
          clearInterval(timer)
          await call('POST', `/runs/${queued.id}/abort`)
        }
      })()
    }, 20)
    await drain()
    clearInterval(timer)
    const run = await call<Run>('GET', `/runs/${queued.id}`)
    expect(run.status).toBe('aborted')
    expect(run.patterns?.map((p) => p.status)).toEqual(['succeeded', 'aborted', 'aborted'])
    expect(run.patterns?.[2].startedAt).toBeNull()
    expect(run.log).toContain('Pattern 3: not run')
  }, 120_000)

  /** A second browser that goes away when its second context is asked for, i.e. between pattern 1 and 2. */
  async function dyingBrowser(): Promise<Browser> {
    const dying = await chromium.launch()
    const newContext = dying.newContext.bind(dying)
    let asked = 0
    dying.newContext = (async (...args: Parameters<Browser['newContext']>) => {
      if (++asked === 2) await Object.getPrototypeOf(dying).close.call(dying)
      return newContext(...args)
    }) as Browser['newContext']
    return dying
  }

  it('starts another browser for the next pattern when the browser went away, so only the row that was hit fails', async () => {
    const [testCase] = (await call<TestCase[]>('GET', `/projects/${PID}/test-cases`)).filter((t) => t.data)
    const queued = await call<Run>('POST', `/test-cases/${testCase.id}/runs`)
    const dying = await dyingBrowser()
    // The first launch gets the browser that dies; the one after it the healthy one.
    const answers = [dying, browser]
    onLaunch = async () => answers.shift() ?? browser
    launches = 0
    try {
      await drain()
    } finally {
      onLaunch = null
    }
    const run = await call<Run>('GET', `/runs/${queued.id}`)
    expect(launches).toBe(2)
    expect(splitLog(run.log).patterns.get(2)).toContain('Unexpected error')
    // Row 2 is the wrong password, which fails anyway; row 3 passes only because it got a live browser.
    expect(run.patterns?.map((p) => p.status)).toEqual(['succeeded', 'failed', 'succeeded'])
    expect(run.results.filter((r) => r.pattern === 3)).toHaveLength(9)
  }, 120_000)

  it('fails the patterns that are left, with the reason, when no other browser can be started', async () => {
    const created = await call<TestCase>('POST', `/projects/${PID}/test-cases`, { name: 'Four rows' })
    const testCase = await call<TestCase>('PATCH', `/test-cases/${created.id}`, {
      steps: [{ id: 's', command: 'store_fixed', variable: 'SEEN', value: '${N}' }],
      data: { columns: ['N'], rows: [['1'], ['2'], ['3'], ['4']] },
    })
    const queued = await call<Run>('POST', `/test-cases/${testCase.id}/runs`)
    const retried: unknown[] = []
    const dying = await dyingBrowser()
    let first = true
    onLaunch = async () => {
      if (!first) throw new Error('rate limit')
      first = false
      return dying
    }
    launches = 0
    try {
      const messages = sent.splice(0).map((body) => ({ body, attempts: 1, ack: () => {}, retry: () => void retried.push(body) }))
      await handleQueue({ messages } as unknown as MessageBatch<QueueMessage>, env)
    } finally {
      onLaunch = null
    }
    const run = await call<Run>('GET', `/runs/${queued.id}`)
    // The run had started: it is not put back on the queue, and one failed launch is not repeated per row.
    expect(retried).toEqual([])
    expect(launches).toBe(2)
    expect(run.status).toBe('failed')
    expect(run.patterns?.map((p) => p.status)).toEqual(['succeeded', 'failed', 'failed', 'failed'])
    const log = splitLog(run.log)
    expect(log.patterns.get(2)).toContain('Unexpected error')
    expect(log.patterns.get(3)).toContain('\nCould not start a browser: rate limit')
    expect(log.patterns.get(4)).toContain('Not run: Could not start a browser: rate limit')
  }, 120_000)
})
