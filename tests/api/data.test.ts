// Data-driven test cases through the HTTP routes, against a real SQLite with the project's migrations.
// No browser: the execution of the patterns is covered by tests/engine/patterns.test.ts.
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BatchRun, DataTable, ElementRef, HealProposal, Run, RunPattern, Step, StepResult, TestCase, Ui } from '../../shared/types'
import { projects } from '../../worker/api/projects'
import { runs } from '../../worker/api/runs'
import { testCases } from '../../worker/api/testCases'
import { HttpError, type Env } from '../../worker/env'
import { memoryD1 } from '../assistant/d1'

vi.mock('@cloudflare/playwright', () => ({ launch: async () => Promise.reject(new Error('no browser in this test')) }))

const ORIGIN = 'https://stepwise.test'
const PID = 'p1'

let db: D1Database
let env: Env
const sent: unknown[] = []

function app() {
  const a = new Hono<{ Bindings: Env }>()
  a.onError((err, c) => (err instanceof HttpError ? c.json({ error: err.message }, err.status) : c.json({ error: String(err) }, 500)))
  a.route('/api', projects)
  a.route('/api', testCases)
  a.route('/api', runs)
  return a
}
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
async function call<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T; error: string }> {
  const res = await app().request(`${ORIGIN}/api${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }, env, ctx)
  const json = (await res.json()) as T & { error?: string }
  return { status: res.status, body: json, error: json.error ?? '' }
}

const fingerprint = { tag: 'button', type: 'button' as const, text: 'Sign in', label: '', attrs: { id: 'go' }, path: 'body>form>button', box: { x: 1, y: 2, w: 3, h: 4 } }
const target = (uiId: string, elementId = 'e1'): ElementRef => ({ uiId, elementId, name: '"Sign in" button', locator: { key: 'id', value: 'go' }, candidates: [{ key: 'id', value: 'go' }], fingerprint })
const comment = (id: string, value = id): Step => ({ id, command: 'comment', value })
const TABLE: DataTable = { columns: ['EMAIL', 'PASSWORD'], rows: [['a@x.test', 'one'], ['b@x.test', 'two'], ['c@x.test', 'three']] }

async function addUi(id: string, testCaseId: string): Promise<void> {
  const elements = [{ id: 'e1', name: '"Sign in" button', type: 'button', box: fingerprint.box, locators: [{ key: 'id', value: 'go' }], fingerprint }]
  await db
    .prepare('INSERT INTO uis (id, test_case_id, name, url, title, width, height, screenshot_key, elements, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, testCaseId, 'UI1', 'https://shop.example/login', 'Login', 1280, 800, `ui/${id}.jpg`, JSON.stringify(elements), '2026-01-01T00:00:00.000Z')
    .run()
}

const newCase = async (name: string, steps: Step[] = [], data?: DataTable): Promise<TestCase> => {
  const created = (await call<TestCase>('POST', `/projects/${PID}/test-cases`, { name })).body
  return steps.length || data ? (await call<TestCase>('PATCH', `/test-cases/${created.id}`, { steps, ...(data ? { data } : {}) })).body : created
}
const stored = async (id: string) => (await call<TestCase>('GET', `/test-cases/${id}`)).body

beforeEach(async () => {
  db = memoryD1()
  sent.length = 0
  env = { DB: db, RUN_QUEUE: { send: async (m: unknown) => void sent.push(m) }, SHOTS: { delete: async () => {}, list: async () => ({ objects: [], truncated: false }) } } as unknown as Env
  await db.prepare('INSERT INTO projects (id, name, base_url, variables, created_at) VALUES (?, ?, ?, ?, ?)').bind(PID, 'Shop', 'https://shop.example', '{"HOST":"shop.example"}', '2026-01-01T00:00:00.000Z').run()
})

describe('saving a data table', () => {
  it('stores it, keeps it when only the steps are saved, and removes it with null or no columns', async () => {
    const t = await newCase('Sign in', [comment('a')], TABLE)
    expect(t.data).toEqual(TABLE)
    // The editor saves steps without sending the data.
    expect((await call<TestCase>('PATCH', `/test-cases/${t.id}`, { steps: [comment('b')] })).body.data).toEqual(TABLE)
    expect((await call<TestCase>('PATCH', `/test-cases/${t.id}`, { name: 'Renamed' })).body.data).toEqual(TABLE)
    expect((await call<TestCase>('PATCH', `/test-cases/${t.id}`, { data: null })).body.data).toBeNull()
    await call('PATCH', `/test-cases/${t.id}`, { data: TABLE })
    expect((await call<TestCase>('PATCH', `/test-cases/${t.id}`, { data: { columns: [], rows: [] } })).body.data).toBeNull()
  })

  it('refuses an invalid table and says where it is wrong', async () => {
    const t = await newCase('Sign in', [comment('a')], TABLE)
    const cases: [unknown, string][] = [
      ['x', 'data must be { columns: string[], rows: string[][] }'],
      [{ columns: ['A'], rows: [[1]] }, 'data must be { columns: string[], rows: string[][] }'],
      [{ columns: ['A', 'A'], rows: [] }, 'Data: column A: There is already a column named A'],
      [{ columns: ['BROWSER'], rows: [] }, 'Data: column BROWSER: BROWSER is a built-in variable; use another name'],
      [{ columns: ['my var'], rows: [] }, 'Data: column my var: Use letters, digits and _ only, not starting with a digit'],
      [{ columns: ['A', 'B'], rows: [['1', '2'], ['1']] }, 'Data: row 2: Row 2 has 1 cells for 2 columns'],
      [{ columns: ['A'], rows: [['ok'], ['x'.repeat(2001)]] }, 'Data: row 2, column A: A cell can have at most 2000 characters'],
      [{ columns: ['A'], rows: Array.from({ length: 51 }, () => ['']) }, 'Data: A data table can have at most 50 rows'],
      [{ columns: Array.from({ length: 21 }, (_, i) => `C${i}`), rows: [] }, 'Data: A data table can have at most 20 columns'],
    ]
    for (const [data, message] of cases) {
      const res = await call('PATCH', `/test-cases/${t.id}`, { data })
      expect([res.status, res.error]).toEqual([400, message])
    }
    expect((await stored(t.id)).data).toEqual(TABLE)
  })

  it('a shared step cannot have a data table; a duplicate keeps the table', async () => {
    const shared = (await call<TestCase>('POST', `/projects/${PID}/shared-steps`, { name: 'Sign in' })).body
    const res = await call('PATCH', `/test-cases/${shared.id}`, { data: TABLE })
    expect([res.status, res.error]).toEqual([400, 'A shared step cannot have a data table: it uses the data of the test case that calls it'])

    const t = await newCase('Sign in', [comment('a')], TABLE)
    expect((await call<TestCase>('POST', `/test-cases/${t.id}/duplicate`)).body.data).toEqual(TABLE)
  })
})

describe('runs of a data-driven test case', () => {
  it('a full run has one queued pattern per row, with the values of the row', async () => {
    const t = await newCase('Sign in', [comment('a'), comment('b')], TABLE)
    const run = (await call<Run>('POST', `/test-cases/${t.id}/runs`)).body
    expect(run.patterns).toEqual([
      { index: 1, values: { EMAIL: 'a@x.test', PASSWORD: 'one' }, status: 'queued', startedAt: null, finishedAt: null },
      { index: 2, values: { EMAIL: 'b@x.test', PASSWORD: 'two' }, status: 'queued', startedAt: null, finishedAt: null },
      { index: 3, values: { EMAIL: 'c@x.test', PASSWORD: 'three' }, status: 'queued', startedAt: null, finishedAt: null },
    ])
    // The summary used by lists carries the patterns too.
    expect((await call<Run[]>('GET', `/test-cases/${t.id}/runs`)).body[0].patterns?.length).toBe(3)
  })

  it('a partial run uses one row: the first, or the one asked for', async () => {
    const t = await newCase('Sign in', [comment('a'), comment('b')], TABLE)
    const first = (await call<Run>('POST', `/test-cases/${t.id}/runs`, { range: { from: 1, to: 1 } })).body
    expect(first.patterns?.map((p) => [p.index, p.values.EMAIL])).toEqual([[1, 'a@x.test']])
    const third = (await call<Run>('POST', `/test-cases/${t.id}/runs`, { range: { from: 2, to: 2 }, row: 3 })).body
    expect(third.patterns?.map((p) => [p.index, p.values.EMAIL])).toEqual([[3, 'c@x.test']])
    for (const row of [0, 4, 1.5, 'x']) {
      const res = await call('POST', `/test-cases/${t.id}/runs`, { range: { from: 1, to: 1 }, row })
      expect(res.status).toBe(400)
      expect(res.error).toMatch(/^row must be/)
    }
  })

  it('a test case without rows, and a run from before the feature, have no patterns', async () => {
    const t = await newCase('Plain', [comment('a')], { columns: ['EMAIL'], rows: [] })
    const run = (await call<Run>('POST', `/test-cases/${t.id}/runs`)).body
    expect(run.patterns).toBeNull()
    await db.prepare('UPDATE runs SET patterns = NULL WHERE id = ?').bind(run.id).run()
    expect((await call<Run>('GET', `/runs/${run.id}`)).body.patterns).toBeNull()
  })

  it('checks the URL a navigate step opens with the values of every row', async () => {
    env = { ...env, ALLOWED_HOSTS: 'shop.example' } as Env
    const data: DataTable = { columns: ['HOST'], rows: [['shop.example'], ['elsewhere.example']] }
    const t = await newCase('Open', [{ id: 'n', command: 'navigate', value: 'https://${HOST}/' }], data)
    const res = await call('POST', `/test-cases/${t.id}/runs`)
    expect([res.status, res.error]).toEqual([400, "Data row 2: Step 1: elsewhere.example is not in this deployment's allowed hosts"])
    // Row 1 alone is fine: the column wins over the project variable HOST either way.
    expect((await call('POST', `/test-cases/${t.id}/runs`, { range: { from: 1, to: 1 }, row: 1 })).status).toBe(201)
  })

  it('refuses a run whose rows times steps is more than one run can hold', async () => {
    const steps = Array.from({ length: 41 }, (_, i) => comment(`c${i}`))
    const t = await newCase('Big', steps, { columns: ['A'], rows: Array.from({ length: 50 }, (_, i) => [`${i}`]) })
    const res = await call('POST', `/test-cases/${t.id}/runs`)
    expect(res.status).toBe(400)
    expect(res.error).toContain('more than 2000 step results')
  })

  it('a data-driven test case that calls a shared step is expanded once and run per row', async () => {
    const shared = (await call<TestCase>('POST', `/projects/${PID}/shared-steps`, { name: 'Sign in' })).body
    await call('PATCH', `/test-cases/${shared.id}`, { steps: [{ id: 'a', command: 'store_fixed', variable: 'WHO', value: '${EMAIL}' }] })
    const t = await newCase('Accounts', [{ id: 'one', command: 'shared_step', value: shared.id }, comment('two')], TABLE)
    const run = (await call<Run>('POST', `/test-cases/${t.id}/runs`)).body
    expect(run.steps.map((s) => s.id)).toEqual(['one', 'one.a', 'two'])
    expect(run.patterns?.length).toBe(3)
  })

  it('counts once in a batch run, which carries the patterns', async () => {
    await newCase('Plain', [comment('a')])
    await newCase('Accounts', [comment('a')], TABLE)
    const batch = (await call<BatchRun>('POST', `/projects/${PID}/batch-runs`)).body
    expect(batch.counts.total).toBe(2)
    expect(batch.runs?.map((r) => r.patterns?.length ?? null)).toEqual([null, 3])
  })
})

describe('reviewing repairs of a data-driven run', () => {
  const heal = (locator = 'form button'): HealProposal => ({
    state: 'unresolved',
    elementName: '"Sign in" button',
    oldLocator: { key: 'id', value: 'go' },
    newLocator: { key: 'css', value: locator },
    newCandidates: [{ key: 'css', value: locator }],
    newFingerprint: { ...fingerprint, attrs: { type: 'submit' }, box: { x: 9, y: 9, w: 9, h: 9 } },
    score: 0.9,
    before: { uiId: 'ui1', box: fingerprint.box },
    after: { screenshotKey: 'run/r/1.jpg', box: { x: 9, y: 9, w: 9, h: 9 }, width: 1280, height: 800 },
  })
  const healed = (pattern: number, locator?: string): StepResult => ({ stepId: 'b', number: 1, pattern, status: 'healed', sentence: 'Click "Sign in" button', durationMs: 1, heal: heal(locator) })

  /** A finished run of a three-row test case with the given results and pattern statuses. */
  async function finishedRun(results: StepResult[], statuses: RunPattern['status'][], status: Run['status']): Promise<{ run: Run; testCase: TestCase }> {
    const testCase = await newCase('Accounts')
    await addUi('ui1', testCase.id)
    await call('PATCH', `/test-cases/${testCase.id}`, { steps: [{ id: 'b', command: 'click', target: target('ui1') }], data: TABLE })
    const run = (await call<Run>('POST', `/test-cases/${testCase.id}/runs`)).body
    const patterns = run.patterns!.map((p, i) => ({ ...p, status: statuses[i], startedAt: 'x', finishedAt: 'x' }))
    await db.prepare("UPDATE runs SET status = ?, results = ?, patterns = ?, finished_at = 'x' WHERE id = ?").bind(status, JSON.stringify(results), JSON.stringify(patterns), run.id).run()
    return { run, testCase: await stored(testCase.id) }
  }
  const review = (run: Run, body: unknown) => call<Run>('POST', `/runs/${run.id}/heals/b`, body)

  it('needs to know which pattern is decided', async () => {
    const { run } = await finishedRun([healed(1), healed(2), healed(3)], ['unresolved', 'unresolved', 'unresolved'], 'unresolved')
    for (const body of [{ action: 'approve' }, { action: 'approve', pattern: 9 }, { action: 'approve', pattern: '1' }]) {
      const res = await review(run, body)
      expect([res.status, res.error]).toEqual([400, 'pattern must be the number of one of the data rows of this run'])
    }
  })

  it('approving one approves the same repair in the other patterns, and saves the locator once', async () => {
    const { run, testCase } = await finishedRun([healed(1), healed(2), healed(3)], ['unresolved', 'unresolved', 'unresolved'], 'unresolved')
    const res = await review(run, { action: 'approve', pattern: 2 })
    expect(res.status).toBe(200)
    expect(res.body.results.map((r) => r.heal?.state)).toEqual(['approved', 'approved', 'approved'])
    expect(res.body.patterns?.map((p) => p.status)).toEqual(['succeeded', 'succeeded', 'succeeded'])
    expect(res.body.status).toBe('succeeded')
    expect(res.body.log).toContain('Repair of step 1 in pattern 2 ("Sign in" button) approved by reviewer, and with it the same repair in 2 other patterns.')

    const after = await stored(testCase.id)
    expect(after.steps[0].target?.locator).toEqual({ key: 'css', value: 'form button' })
    expect(after.data).toEqual(TABLE)
    expect((await call<Ui[]>('GET', `/test-cases/${testCase.id}/uis`)).body[0].elements[0].locators).toEqual([{ key: 'css', value: 'form button' }])
    // Decided: the other patterns cannot be decided again.
    expect((await review(run, { action: 'reject', pattern: 1 })).status).toBe(409)
  })

  it('a different replacement in another pattern stays open, and the run stays unresolved', async () => {
    const { run } = await finishedRun([healed(1), healed(2, 'main button'), healed(3)], ['unresolved', 'unresolved', 'unresolved'], 'unresolved')
    const res = await review(run, { action: 'approve', pattern: 1 })
    expect(res.body.results.map((r) => r.heal?.state)).toEqual(['approved', 'unresolved', 'approved'])
    expect(res.body.patterns?.map((p) => p.status)).toEqual(['succeeded', 'unresolved', 'succeeded'])
    expect(res.body.status).toBe('unresolved')
  })

  it('rejecting fails that pattern only, and with it the run', async () => {
    const { run, testCase } = await finishedRun([healed(1), healed(2), healed(3)], ['unresolved', 'unresolved', 'unresolved'], 'unresolved')
    const res = await review(run, { action: 'reject', pattern: 3 })
    expect(res.body.results.map((r) => r.heal?.state)).toEqual(['unresolved', 'unresolved', 'rejected'])
    expect(res.body.patterns?.map((p) => p.status)).toEqual(['unresolved', 'unresolved', 'failed'])
    expect(res.body.status).toBe('failed')
    expect((await stored(testCase.id)).steps).toEqual(testCase.steps)
    // The other patterns can still be reviewed; the run stays failed.
    const later = await review(run, { action: 'approve', pattern: 1 })
    expect(later.body.patterns?.map((p) => p.status)).toEqual(['succeeded', 'succeeded', 'failed'])
    expect(later.body.status).toBe('failed')
  })

  it('a run that failed in one pattern keeps that verdict when a repair in another is approved', async () => {
    const failed: StepResult = { stepId: 'b', number: 1, pattern: 2, status: 'failed', sentence: 'Click', durationMs: 1, error: 'no' }
    const { run } = await finishedRun([healed(1), failed, healed(3)], ['unresolved', 'failed', 'unresolved'], 'failed')
    const res = await review(run, { action: 'approve', pattern: 1 })
    expect(res.body.patterns?.map((p) => p.status)).toEqual(['succeeded', 'failed', 'succeeded'])
    expect(res.body.status).toBe('failed')
  })
})
