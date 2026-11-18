// The capture route and the queue consumer end to end: the HTTP routes, a real browser (Node Playwright in
// place of Browser Run) against the bundled demo site, and a real SQLite. The project's base URL has a
// path and no trailing slash, as a stored base URL always has.
import { Hono } from 'hono'
import { chromium, type Browser } from 'playwright'
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { BatchRun, CaptureResponse, Run, Step, TestCase, Ui } from '../../shared/types'
import { runs } from '../../worker/api/runs'
import { testCases } from '../../worker/api/testCases'
import { HttpError, type Env, type QueueMessage } from '../../worker/env'
import { BATCH_SLICE_MS, handleQueue } from '../../worker/runner'
import { memoryD1 } from '../assistant/d1'
import { startDemoServer } from './helpers'

let browser: Browser
vi.mock('@cloudflare/playwright', () => ({ launch: async () => browser }))

let server: Server
let origin: string
let db: D1Database
let env: Env
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
async function request<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T; error: string }> {
  const res = await app().request(`${origin}/api${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }, env, ctx)
  const json = (await res.json()) as T & { error?: string }
  return { status: res.status, body: json, error: json.error ?? '' }
}
async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await request<T>(method, path, body)
  if (res.status >= 400) throw new Error(`${method} ${path}: ${res.error}`)
  return res.body
}
/** Deliver what the routes put on the queue, as the Worker's consumer gets it. */
async function drain(o: { attempts?: number; clock?: () => number } = {}): Promise<void> {
  const messages = sent.splice(0).map((body) => ({ body, attempts: o.attempts ?? 1, ack: () => {}, retry: () => {} }))
  await handleQueue({ messages } as unknown as MessageBatch<QueueMessage>, env, o.clock)
}
const newCase = async (name: string, steps: Step[]): Promise<TestCase> => {
  const created = await call<TestCase>('POST', `/projects/${PID}/test-cases`, { name })
  return call<TestCase>('PATCH', `/test-cases/${created.id}`, { steps })
}
const uisOf = (id: string) => call<Ui[]>('GET', `/test-cases/${id}/uis`)

beforeAll(async () => {
  const real = await chromium.launch()
  // The runner closes the browser it "launched" after each queue message and capture; the test keeps one.
  real.close = async () => {}
  browser = real
  const demo = await startDemoServer()
  server = demo.server
  origin = new URL(demo.baseUrl).origin
  db = memoryD1()
  env = { DB: db, RUN_QUEUE: { send: async (m: QueueMessage) => void sent.push(m) }, SHOTS: { put: async () => {}, delete: async () => {}, list: async () => ({ objects: [], truncated: false }) } } as unknown as Env
  await db.prepare('INSERT INTO projects (id, name, base_url, variables, created_at) VALUES (?, ?, ?, ?, ?)').bind(PID, 'Inn', '/demo', '{}', '2026-01-01T00:00:00.000Z').run()
})

afterAll(async () => {
  for (const c of browser.contexts()) await c.close()
  await Object.getPrototypeOf(browser).close.call(browser)
  await new Promise((done) => server.close(done))
})

describe('a relative URL with a base URL that has a path', () => {
  it('opens the same page in a capture and in a run', async () => {
    const t = await newCase('Relative', [
      { id: 'open', command: 'navigate', value: 'login.html' },
      { id: 'url', command: 'assert_url_equals', value: '/login.html' },
      { id: 'title', command: 'assert_title_contains', value: 'Sign in' },
    ])
    const captured = await call<CaptureResponse>('POST', `/test-cases/${t.id}/uis`, { url: 'login.html' })
    expect(captured.ui.url).toBe(`${origin}/demo/login.html`)
    const queued = await call<Run>('POST', `/test-cases/${t.id}/runs`)
    await drain()
    const run = await call<Run>('GET', `/runs/${queued.id}`)
    expect(run.log).toContain(`Base URL: ${origin}/demo`)
    expect(run.results.map((r) => r.status)).toEqual(['passed', 'passed', 'passed'])
    expect(run.status).toBe('succeeded')
  }, 120_000)
})

describe('capturing after a step', () => {
  it('names captures so that a deleted one\'s name is not used again', async () => {
    const t = await newCase('Names', [{ id: 'open', command: 'navigate', value: 'login.html' }])
    const first = await call<CaptureResponse>('POST', `/test-cases/${t.id}/uis`, { afterStepId: 'open' })
    const second = await call<CaptureResponse>('POST', `/test-cases/${t.id}/uis`, { afterStepId: 'open' })
    expect([first.ui.name, second.ui.name]).toEqual(['UI1', 'UI2'])
    await call('DELETE', `/uis/${first.ui.id}`)
    const third = await call<CaptureResponse>('POST', `/test-cases/${t.id}/uis`, { afterStepId: 'open' })
    expect(third.ui.name).toBe('UI3')
  }, 120_000)

  it('captures the page asked for when an assertion that is set to continue fails on the way', async () => {
    const t = await newCase('Tolerated', [
      { id: 'open', command: 'navigate', value: 'login.html' },
      { id: 'soft', command: 'assert_title_equals', value: 'not the title', continueOnFailure: true },
      { id: 'next', command: 'navigate', value: 'index.html' },
    ])
    const res = await call<CaptureResponse>('POST', `/test-cases/${t.id}/uis`, { afterStepId: 'next' })
    expect(res.replayError).toBeUndefined()
    expect(res.tolerated).toEqual([{ stepId: 'soft', message: expect.stringContaining('does not equal "not the title"') }])
    expect(res.ui.url).toBe(`${origin}/demo/index.html`)
  }, 120_000)

  it('still says where the replay stopped when a step ended it', async () => {
    const t = await newCase('Stopped', [
      { id: 'open', command: 'navigate', value: 'login.html' },
      { id: 'hard', command: 'assert_title_equals', value: 'not the title' },
      { id: 'next', command: 'navigate', value: 'index.html' },
    ])
    const res = await call<CaptureResponse>('POST', `/test-cases/${t.id}/uis`, { afterStepId: 'next' })
    expect(res.replayError).toMatchObject({ stepId: 'hard' })
    expect(res.ui.url).toBe(`${origin}/demo/login.html`)
  }, 120_000)

  it('captures inside a branch that is not closed yet', async () => {
    const t = await newCase('Building a branch', [
      { id: 'open', command: 'navigate', value: 'login.html' },
      { id: 'if', command: 'if_variable_equals', variable: 'DEVICE', value: 'desktop' },
      { id: 'go', command: 'navigate', value: 'index.html' },
    ])
    const res = await call<CaptureResponse>('POST', `/test-cases/${t.id}/uis`, { afterStepId: 'go' })
    expect(res.replayError).toBeUndefined()
    expect(res.ui.url).toBe(`${origin}/demo/index.html`)
    expect(res.ui.elements.length).toBeGreaterThan(0)
  }, 120_000)

  it('stores nothing when the replay ended before a page was opened', async () => {
    const t = await newCase('Blank', [
      { id: 'early', command: 'assert_title_equals', value: 'nothing is open yet' },
      { id: 'open', command: 'navigate', value: 'login.html' },
    ])
    const res = await request('POST', `/test-cases/${t.id}/uis`, { afterStepId: 'open' })
    expect(res.status).toBe(400)
    expect(res.error).toContain('Nothing was captured: the replay stopped at step 1 before any page was opened.')
    expect(await uisOf(t.id)).toEqual([])
  }, 120_000)
})

describe('a partial run', () => {
  it('that executes none of its steps says so in the log', async () => {
    const t = await newCase('Branch', [
      { id: 'set', command: 'store_fixed', variable: 'RESULT', value: 'ok' },
      { id: 'if', command: 'if_variable_equals', variable: 'RESULT', value: 'ok' },
      { id: 'yes', command: 'comment', value: 'fine' },
      { id: 'else', command: 'else' },
      { id: 'no', command: 'assert_title_equals', value: 'never checked' },
      { id: 'end', command: 'end_if' },
    ])
    const queued = await call<Run>('POST', `/test-cases/${t.id}/runs`, { range: { from: 5, to: 5 } })
    await drain()
    const run = await call<Run>('GET', `/runs/${queued.id}`)
    expect([run.status, run.results]).toEqual(['succeeded', []])
    expect(run.log).toContain('[5] skipped: it is in an arm of the "If" at step 2 that this run did not take')
  }, 120_000)
})

describe('a batch', () => {
  const simple = (name: string) => newCase(name, [{ id: 'open', command: 'navigate', value: 'login.html' }])

  it('hands the rest to a new invocation when its time is nearly up, and that one finishes it', async () => {
    const cases = [await simple('One'), await simple('Two'), await simple('Three')]
    const batch = await call<BatchRun>('POST', `/projects/${PID}/batch-runs`, { testCaseIds: cases.map((t) => t.id) })
    // Every look at the clock is a whole slice later: after one test case the time is up.
    let now = 0
    const clock = () => (now += BATCH_SLICE_MS)
    await drain({ clock })
    let state = await call<BatchRun>('GET', `/batch-runs/${batch.id}`)
    expect(state.runs?.map((r) => r.status)).toEqual(['succeeded', 'queued', 'queued'])
    expect(state.status).toBe('running')
    expect(sent).toEqual([{ batchRunId: batch.id, origin, resumed: true }])
    await drain()
    state = await call<BatchRun>('GET', `/batch-runs/${batch.id}`)
    expect(state.runs?.map((r) => r.status)).toEqual(['succeeded', 'succeeded', 'succeeded'])
    expect(state.status).toBe('succeeded')
    expect(sent).toEqual([])
  }, 120_000)

  it('that is delivered again fails the test case its stopped worker left running, at once, and runs the rest', async () => {
    const cases = [await simple('Four'), await simple('Five')]
    const batch = await call<BatchRun>('POST', `/projects/${PID}/batch-runs`, { testCaseIds: cases.map((t) => t.id) })
    // The first invocation claimed the first test case and was stopped by the platform in the middle of it.
    await db.prepare("UPDATE runs SET status = 'running', started_at = ? WHERE batch_run_id = ? AND run_order = 1").bind(new Date().toISOString(), batch.id).run()
    await drain({ attempts: 2 })
    const state = await call<BatchRun>('GET', `/batch-runs/${batch.id}`)
    expect(state.runs?.map((r) => r.status)).toEqual(['failed', 'succeeded'])
    expect(state.status).toBe('failed')
    const interrupted = await call<Run>('GET', `/runs/${state.runs![0].id}`)
    expect(interrupted.log).toContain('Interrupted: the worker that was executing this batch was stopped by the platform')
    expect(interrupted.log).not.toContain('timed out')
  }, 120_000)
})
