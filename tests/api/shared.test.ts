// Shared steps through the HTTP routes, against a real SQLite with the project's migrations. No browser:
// what a run executes is covered by the engine tests; here it is what gets stored.
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BatchRun, ElementRef, HealProposal, Project, Run, Step, StepResult, TestCase, Ui } from '../../shared/types'
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
const callStep = (id: string, sharedId: string): Step => ({ id, command: 'shared_step', value: sharedId })

async function addUi(id: string, testCaseId: string): Promise<void> {
  const elements = [{ id: 'e1', name: '"Sign in" button', type: 'button', box: fingerprint.box, locators: [{ key: 'id', value: 'go' }], fingerprint }]
  await db
    .prepare('INSERT INTO uis (id, test_case_id, name, url, title, width, height, screenshot_key, elements, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, testCaseId, 'UI1', 'https://shop.example/login', 'Login', 1280, 800, `ui/${id}.jpg`, JSON.stringify(elements), '2026-01-01T00:00:00.000Z')
    .run()
}

const newCase = async (name: string, steps: Step[] = []): Promise<TestCase> => {
  const created = (await call<TestCase>('POST', `/projects/${PID}/test-cases`, { name })).body
  return steps.length ? (await call<TestCase>('PATCH', `/test-cases/${created.id}`, { steps })).body : created
}
const newShared = async (name: string, steps: Step[] = []): Promise<TestCase> => {
  const created = (await call<TestCase>('POST', `/projects/${PID}/shared-steps`, { name })).body
  return steps.length ? (await call<TestCase>('PATCH', `/test-cases/${created.id}`, { steps })).body : created
}
const stored = async (id: string) => (await call<TestCase>('GET', `/test-cases/${id}`)).body

beforeEach(async () => {
  db = memoryD1()
  sent.length = 0
  env = { DB: db, RUN_QUEUE: { send: async (m: unknown) => void sent.push(m) }, SHOTS: { delete: async () => {}, list: async () => ({ objects: [], truncated: false }) } } as unknown as Env
  await db.prepare('INSERT INTO projects (id, name, base_url, variables, created_at) VALUES (?, ?, ?, ?, ?)').bind(PID, 'Shop', 'https://shop.example', '{}', '2026-01-01T00:00:00.000Z').run()
})

describe('shared steps and test cases side by side', () => {
  it('numbers them separately, lists them separately, and counts only test cases', async () => {
    const t1 = await newCase('Checkout')
    const s1 = await newShared('Sign in')
    const s2 = await newShared('Sign out')
    const t2 = await newCase('Search')
    expect([t1.number, t2.number, s1.number, s2.number]).toEqual([1, 2, 1, 2])
    expect([t1.kind, s1.kind]).toEqual(['test', 'shared'])

    const cases = (await call<TestCase[]>('GET', `/projects/${PID}/test-cases`)).body
    expect(cases.map((t) => t.name)).toEqual(['Checkout', 'Search'])
    const shared = (await call<TestCase[]>('GET', `/projects/${PID}/shared-steps`)).body
    expect(shared.map((t) => [t.number, t.name, t.usedBy])).toEqual([
      [1, 'Sign in', []],
      [2, 'Sign out', []],
    ])
    expect((await call<Project>('GET', `/projects/${PID}`)).body.testCaseCount).toBe(2)
  })

  it('rows from before the migration are test cases', async () => {
    await db.prepare('INSERT INTO test_cases (id, project_id, number, name, steps, created_at, updated_at) VALUES (?, ?, 7, ?, ?, ?, ?)').bind('old', PID, 'Old', '[]', 'x', 'x').run()
    const old = await stored('old')
    expect([old.kind, old.number, old.data]).toEqual(['test', 7, null])
  })

  it('reports who calls a shared step, and keeps a duplicate a shared step', async () => {
    const s1 = await newShared('Sign in', [comment('a')])
    await newCase('Checkout', [callStep('c1', s1.id)])
    await newCase('Unrelated', [comment('x')])
    await newCase('Search', [callStep('c2', s1.id), callStep('c3', s1.id)])
    const usedBy = (await stored(s1.id)).usedBy
    expect(usedBy?.map((u) => `#${u.number} ${u.name}`)).toEqual(['#1 Checkout', '#3 Search'])

    const copy = (await call<TestCase>('POST', `/test-cases/${s1.id}/duplicate`)).body
    expect([copy.kind, copy.number, copy.name, copy.usedBy]).toEqual(['shared', 2, 'Sign in (copy)', []])
  })

  it('refuses a shared step call inside a shared step', async () => {
    const s1 = await newShared('Sign in')
    const s2 = await newShared('Outer')
    const res = await call('PATCH', `/test-cases/${s2.id}`, { steps: [comment('a'), callStep('b', s1.id)] })
    expect(res.status).toBe(400)
    expect(res.error).toBe('Step 2: A shared step cannot call another shared step')
    expect((await stored(s2.id)).steps).toEqual([])
  })

  it('does not store `call` or `origin` a client sends with a step', async () => {
    const t = await newCase('Checkout', [{ ...comment('a'), call: { id: 'x', number: 1, name: 'Forged' }, origin: { callId: 'c', stepId: 's', shared: { id: 'x', number: 1, name: 'Forged' } } }])
    expect(t.steps).toEqual([comment('a')])
  })

  it('refuses to delete a shared step that is in use and names the callers', async () => {
    const s1 = await newShared('Sign in', [comment('a')])
    const t1 = await newCase('Checkout', [callStep('c1', s1.id)])
    await newCase('Search', [callStep('c2', s1.id)])
    const refused = await call('DELETE', `/test-cases/${s1.id}`)
    expect(refused.status).toBe(409)
    expect(refused.error).toBe('Shared step S1: Sign in is used by #1 Checkout, #2 Search. Remove the calls first.')

    await call('PATCH', `/test-cases/${t1.id}`, { steps: [] })
    expect((await call('DELETE', `/test-cases/${s1.id}`)).error).toContain('is used by #2 Search.')
    await call('DELETE', `/test-cases/${(await call<TestCase[]>('GET', `/projects/${PID}/test-cases`)).body[1].id}`)
    expect((await call('DELETE', `/test-cases/${s1.id}`)).status).toBe(200)
    expect((await call('GET', `/test-cases/${s1.id}`)).status).toBe(404)
  })
})

describe('runs of a test case that calls a shared step', () => {
  it('stores the steps expanded as they are when the run is created', async () => {
    const s1 = await newShared('Sign in', [comment('a'), comment('b')])
    const t1 = await newCase('Checkout', [comment('one'), callStep('two', s1.id), comment('three')])
    const run = (await call<Run>('POST', `/test-cases/${t1.id}/runs`)).body
    expect(run.kind).toBe('test')
    expect(run.steps.map((s) => s.id)).toEqual(['one', 'two', 'two.a', 'two.b', 'three'])
    expect(run.steps[1].call).toEqual({ id: s1.id, number: 1, name: 'Sign in' })
    expect(run.steps[2].origin).toEqual({ callId: 'two', stepId: 'a', shared: { id: s1.id, number: 1, name: 'Sign in' } })
    expect(sent).toEqual([{ runId: run.id, origin: ORIGIN }])

    // Editing or renaming the shared step afterwards does not change the run.
    await call('PATCH', `/test-cases/${s1.id}`, { name: 'Log in', steps: [comment('z')] })
    const later = (await call<Run>('GET', `/runs/${run.id}`)).body
    expect(later.steps.map((s) => s.id)).toEqual(['one', 'two', 'two.a', 'two.b', 'three'])
    expect(later.steps[1].call?.name).toBe('Sign in')
  })

  it('takes a range in the numbering of the test case, where a call is one step', async () => {
    const s1 = await newShared('Sign in', [comment('a'), comment('b')])
    const t1 = await newCase('Checkout', [comment('one'), callStep('two', s1.id), comment('three')])
    const run = (await call<Run>('POST', `/test-cases/${t1.id}/runs`, { range: { from: 2, to: 3 } })).body
    expect(run.range).toEqual({ from: 2, to: 3 })
    expect(run.steps).toHaveLength(5)
    const outside = await call('POST', `/test-cases/${t1.id}/runs`, { range: { from: 1, to: 4 } })
    expect([outside.status, outside.error]).toEqual([400, 'range must be within steps 1-3'])
  })

  it('refuses to run a call whose shared step is gone, belongs to another project or has an open If', async () => {
    await db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').bind('p2', 'Other', 'x').run()
    const foreign = (await call<TestCase>('POST', '/projects/p2/shared-steps', { name: 'Elsewhere' })).body
    const open = await newShared('Open', [{ id: 'i', command: 'if_variable_equals', variable: 'X', value: '1' }])
    const t1 = await newCase('Checkout', [comment('one'), callStep('two', 'no-such-id')])
    const expectRefusal = async (message: string) => {
      const res = await call('POST', `/test-cases/${t1.id}/runs`)
      expect([res.status, res.error]).toEqual([400, message])
    }
    await expectRefusal('Step 2: The shared step this step calls no longer exists')
    await call('PATCH', `/test-cases/${t1.id}`, { steps: [comment('one'), callStep('two', foreign.id)] })
    await expectRefusal('Step 2: The shared step this step calls belongs to another project')
    await call('PATCH', `/test-cases/${t1.id}`, { steps: [comment('one'), callStep('two', open.id)] })
    await expectRefusal('Step 2: Shared step S1 has an unbalanced If / Otherwise / End branch')
    // A partial run that stops before the broken call is fine; a disabled call is not checked at all.
    expect((await call('POST', `/test-cases/${t1.id}/runs`, { range: { from: 1, to: 1 } })).status).toBe(201)
    await call('PATCH', `/test-cases/${t1.id}`, { steps: [comment('one'), { ...callStep('two', 'no-such-id'), disabled: true }] })
    expect((await call('POST', `/test-cases/${t1.id}/runs`)).status).toBe(201)
    expect(sent).toHaveLength(2)
  })

  it('checks the navigate steps inside a shared step against the target policy', async () => {
    const s1 = await newShared('Sign in', [comment('a'), { id: 'b', command: 'navigate', value: 'http://192.168.0.1/admin' }])
    const t1 = await newCase('Checkout', [comment('one'), callStep('two', s1.id)])
    const res = await call('POST', `/test-cases/${t1.id}/runs`)
    expect([res.status, res.error]).toEqual([400, "Step 2.2: 192.168.0.1 is not in this deployment's allowed hosts"])
  })

  it('has nothing to run when the only step is a call to an empty shared step', async () => {
    const s1 = await newShared('Empty')
    const t1 = await newCase('Checkout', [callStep('two', s1.id)])
    expect((await call('POST', `/test-cases/${t1.id}/runs`)).error).toBe('This test case has no steps to run')
    expect((await call('POST', `/test-cases/${s1.id}/runs`)).error).toBe('This shared step has no steps to run')
  })

  it('runs a shared step by itself as a single run', async () => {
    const s1 = await newShared('Sign in', [comment('a')])
    await newCase('Checkout', [comment('one')])
    const run = (await call<Run>('POST', `/test-cases/${s1.id}/runs`)).body
    expect([run.kind, run.testCaseNumber, run.testCaseName]).toEqual(['shared', 1, 'Sign in'])
    expect(run.steps).toEqual([comment('a')])
    expect((await call<Run[]>('GET', `/test-cases/${s1.id}/runs`)).body.map((r) => r.id)).toEqual([run.id])
    expect((await stored(s1.id)).lastRun?.id).toBe(run.id)
  })

  it('maps a run stored before shared steps existed', async () => {
    await db
      .prepare("INSERT INTO runs (id, project_id, test_case_id, test_case_number, test_case_name, status, steps, results, created_at) VALUES ('old', ?, 't', 3, 'Old', 'succeeded', ?, ?, 'x')")
      .bind(PID, JSON.stringify([comment('a')]), JSON.stringify([{ stepId: 'a', number: 1, status: 'passed', sentence: '// a', durationMs: 1 }]))
      .run()
    const run = (await call<Run>('GET', '/runs/old')).body
    expect([run.kind, run.testCaseNumber, run.patterns, run.steps.length, run.results[0].number]).toEqual(['test', 3, null, 1, 1])
  })
})

describe('batch runs', () => {
  it('run test cases only, each with its calls expanded', async () => {
    const s1 = await newShared('Sign in', [comment('a')])
    const t1 = await newCase('Checkout', [callStep('c', s1.id), comment('x')])
    const t2 = await newCase('Plain', [comment('y')])
    const batch = (await call<BatchRun>('POST', `/projects/${PID}/batch-runs`)).body
    expect(batch.runs?.map((r) => r.testCaseName)).toEqual(['Checkout', 'Plain'])
    const first = (await call<Run>('GET', `/runs/${batch.runs![0].id}`)).body
    expect(first.steps.map((s) => s.id)).toEqual(['c', 'c.a', 'x'])

    // A shared step is not something a batch can be asked to run.
    const asked = await call('POST', `/projects/${PID}/batch-runs`, { testCaseIds: [t1.id, s1.id] })
    expect([asked.status, asked.error]).toEqual([400, 'testCaseIds contains a test case that is not in this project'])
    expect((await call<BatchRun>('POST', `/projects/${PID}/batch-runs`, { testCaseIds: [t2.id] })).body.counts.total).toBe(1)
  })

  it('names the test case whose call is broken', async () => {
    await newCase('Fine', [comment('y')])
    await newCase('Broken', [comment('x'), callStep('c', 'no-such-id')])
    const res = await call('POST', `/projects/${PID}/batch-runs`)
    expect([res.status, res.error]).toEqual([400, '#2 Broken - Step 2: The shared step this step calls no longer exists'])
  })
})

describe('approving a repair of a step that came from a shared step', () => {
  const heal: HealProposal = {
    state: 'unresolved',
    elementName: '"Sign in" button',
    oldLocator: { key: 'id', value: 'go' },
    newLocator: { key: 'css', value: 'form button' },
    newCandidates: [{ key: 'css', value: 'form button' }],
    newFingerprint: { ...fingerprint, attrs: { type: 'submit' }, box: { x: 9, y: 9, w: 9, h: 9 } },
    score: 0.9,
    before: { uiId: 'ui-shared', box: fingerprint.box },
    after: { screenshotKey: 'run/r/1.jpg', box: { x: 9, y: 9, w: 9, h: 9 }, width: 1280, height: 800 },
  }

  it('saves the new locator to the shared step and its captured element, not to the calling test case', async () => {
    const s1 = await newShared('Sign in')
    await addUi('ui-shared', s1.id)
    const click: Step = { id: 'b', command: 'click', target: target('ui-shared') }
    await call('PATCH', `/test-cases/${s1.id}`, { steps: [comment('a'), click, { id: 'c', command: 'assert_exists', target: target('ui-shared') }] })
    const t1 = await newCase('Checkout', [comment('one'), callStep('two', s1.id)])
    const before = await stored(t1.id)

    const run = (await call<Run>('POST', `/test-cases/${t1.id}/runs`)).body
    const results: StepResult[] = [
      { stepId: 'one', number: 1, status: 'passed', sentence: '// one', durationMs: 1 },
      { stepId: 'two.b', number: 2, sub: 2, status: 'healed', sentence: 'Click "Sign in" button', durationMs: 1, heal },
    ]
    await db.prepare("UPDATE runs SET status = 'unresolved', results = ?, finished_at = 'x' WHERE id = ?").bind(JSON.stringify(results), run.id).run()

    const reviewed = await call<Run>('POST', `/runs/${run.id}/heals/${encodeURIComponent('two.b')}`, { action: 'approve' })
    expect(reviewed.status).toBe(200)
    expect(reviewed.body.status).toBe('succeeded')
    expect(reviewed.body.log).toContain('Repair of step 2.2 ("Sign in" button) approved by reviewer.')

    // Every step of the shared step that uses the element gets the locator; boxes stay as captured.
    const shared = await stored(s1.id)
    expect(shared.steps.map((s) => s.target?.locator)).toEqual([undefined, { key: 'css', value: 'form button' }, { key: 'css', value: 'form button' }])
    expect(shared.steps[1].target?.fingerprint.box).toEqual(fingerprint.box)
    expect(shared.steps[1].target?.fingerprint.attrs).toEqual({ type: 'submit' })
    const ui = (await call<Ui[]>('GET', `/test-cases/${s1.id}/uis`)).body[0]
    expect(ui.elements[0].locators).toEqual([{ key: 'css', value: 'form button' }])
    // The test case only holds the call: nothing in it changed.
    const after = await stored(t1.id)
    expect([after.steps, after.updatedAt]).toEqual([before.steps, before.updatedAt])
  })

  it('still records the decision when the shared step has been deleted since', async () => {
    const s1 = await newShared('Sign in', [comment('a')])
    const t1 = await newCase('Checkout', [callStep('two', s1.id)])
    const run = (await call<Run>('POST', `/test-cases/${t1.id}/runs`)).body
    const steps = run.steps.map((s) => (s.id === 'two.a' ? { ...s, command: 'click', target: target('ui-gone') } : s))
    const results: StepResult[] = [{ stepId: 'two.a', number: 1, sub: 1, status: 'healed', sentence: 'Click', durationMs: 1, heal }]
    await db.prepare("UPDATE runs SET status = 'unresolved', steps = ?, results = ?, finished_at = 'x' WHERE id = ?").bind(JSON.stringify(steps), JSON.stringify(results), run.id).run()
    await call('PATCH', `/test-cases/${t1.id}`, { steps: [] })
    expect((await call('DELETE', `/test-cases/${s1.id}`)).status).toBe(200)
    const reviewed = await call<Run>('POST', `/runs/${run.id}/heals/two.a`, { action: 'approve' })
    expect([reviewed.status, reviewed.body.status, reviewed.body.results[0].heal?.state]).toEqual([200, 'succeeded', 'approved'])
  })
})

describe('moving steps to a new shared step', () => {
  it('creates the shared step with its own copies of the screens and leaves a call in place of the steps', async () => {
    const t1 = await newCase('Checkout')
    await addUi('ui-a', t1.id)
    await addUi('ui-b', t1.id)
    const steps: Step[] = [comment('one'), { id: 'two', command: 'click', target: target('ui-a') }, comment('three'), { id: 'four', command: 'click', target: target('ui-b') }]
    await call('PATCH', `/test-cases/${t1.id}`, { steps })

    const res = await call<{ testCase: TestCase; shared: TestCase }>('POST', `/test-cases/${t1.id}/extract-shared`, { stepIds: ['two', 'three'], name: 'Sign in' })
    expect(res.status).toBe(201)
    const { testCase, shared } = res.body
    expect([shared.kind, shared.number, shared.name, shared.device]).toEqual(['shared', 1, 'Sign in', 'desktop'])
    expect(shared.usedBy?.map((u) => u.id)).toEqual([t1.id])
    expect(testCase.steps.map((s) => [s.id === 'one' || s.id === 'four' ? s.id : 'call', s.command, s.value ?? null])).toEqual([
      ['one', 'comment', 'one'],
      ['call', 'shared_step', shared.id],
      ['four', 'click', null],
    ])
    // Only the screen the moved steps use is copied; the copy shows the same screenshot.
    const copies = (await call<Ui[]>('GET', `/test-cases/${shared.id}/uis`)).body
    expect(copies).toHaveLength(1)
    expect(copies[0].screenshotKey).toBe('ui/ui-a.jpg')
    expect(copies[0].id).not.toBe('ui-a')
    expect(shared.steps.map((s) => [s.id, s.target?.uiId ?? null])).toEqual([
      ['two', copies[0].id],
      ['three', null],
    ])
    expect((await call<Ui[]>('GET', `/test-cases/${t1.id}/uis`)).body).toHaveLength(2)
    // The next one is S2: the counter moved with the insert.
    expect((await newShared('Other')).number).toBe(2)
  })

  it('refuses a selection that is not consecutive, holds a call, or cuts an If block in half', async () => {
    const s1 = await newShared('Existing', [comment('a')])
    const t1 = await newCase('Checkout', [
      comment('one'),
      { id: 'if', command: 'if_variable_equals', variable: 'X', value: '1' },
      comment('in'),
      { id: 'end', command: 'end_if' },
      callStep('call', s1.id),
    ])
    const attempt = async (stepIds: unknown) => (await call('POST', `/test-cases/${t1.id}/extract-shared`, { stepIds })).error
    expect(await attempt(['one', 'in'])).toContain('must be consecutive steps')
    expect(await attempt(['one', 'nope'])).toContain('must be consecutive steps')
    expect(await attempt([])).toBe('stepIds must be a non-empty array of step ids')
    expect(await attempt(['end', 'call'])).toContain('contains a shared step call')
    expect(await attempt(['one', 'if'])).toContain('whole If ... End branch blocks')
    expect((await call('POST', `/test-cases/${s1.id}/extract-shared`, { stepIds: ['a'] })).error).toBe('A shared step cannot call another shared step')
    // Nothing was created or changed by the refusals; a whole block can be moved.
    expect((await call<TestCase[]>('GET', `/projects/${PID}/shared-steps`)).body).toHaveLength(1)
    const ok = await call<{ testCase: TestCase; shared: TestCase }>('POST', `/test-cases/${t1.id}/extract-shared`, { stepIds: ['if', 'in', 'end'] })
    expect(ok.status).toBe(201)
    expect(ok.body.shared.name).toBe('New shared step')
    expect(ok.body.testCase.steps).toHaveLength(3)
  })
})
