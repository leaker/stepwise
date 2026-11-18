// Writes that must not undo each other, and requests that are refused before they can produce a useless
// run: against a real SQLite with the project's migrations, no browser.
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextUiName } from '../../shared/commands'
import { stepsRevision } from '../../shared/revision'
import type { ElementRef, HealProposal, Run, Step, StepResult, TestCase } from '../../shared/types'
import { projects } from '../../worker/api/projects'
import { estimateRunBytes, MAX_RUN_BYTES, runs } from '../../worker/api/runs'
import { testCases } from '../../worker/api/testCases'
import { deleteShots, removeShots } from '../../worker/db'
import { HttpError, type Env, type QueueMessage } from '../../worker/env'
import { failInterruptedRuns, recordRunEnd } from '../../worker/runner'
import { memoryD1 } from '../assistant/d1'

vi.mock('@cloudflare/playwright', () => ({ launch: async () => Promise.reject(new Error('no browser in this test')) }))

const ORIGIN = 'https://stepwise.test'
const PID = 'p1'

let db: D1Database
let env: Env
const sent: QueueMessage[] = []

function app() {
  const a = new Hono<{ Bindings: Env }>()
  a.onError((err, c) => (err instanceof HttpError ? c.json({ error: err.message, ...(err.code ? { code: err.code } : {}) }, err.status) : c.json({ error: String(err) }, 500)))
  a.route('/api', projects)
  a.route('/api', testCases)
  a.route('/api', runs)
  return a
}
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
async function call<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T; error: string; code?: string }> {
  const res = await app().request(`${ORIGIN}/api${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }, env, ctx)
  const json = (await res.json()) as T & { error?: string; code?: string }
  return { status: res.status, body: json, error: json.error ?? '', code: json.code }
}

const fingerprint = { tag: 'button', type: 'button' as const, text: 'Sign in', label: '', attrs: { id: 'go' }, path: 'body>form>button', box: { x: 1, y: 2, w: 3, h: 4 } }
const target = (uiId: string, elementId = 'e1'): ElementRef => ({ uiId, elementId, name: '"Sign in" button', locator: { key: 'id', value: 'go' }, candidates: [{ key: 'id', value: 'go' }], fingerprint })
const comment = (id: string, value = id): Step => ({ id, command: 'comment', value })
const newCase = async (name: string, steps: Step[] = []): Promise<TestCase> => {
  const created = (await call<TestCase>('POST', `/projects/${PID}/test-cases`, { name })).body
  return steps.length ? (await call<TestCase>('PATCH', `/test-cases/${created.id}`, { steps })).body : created
}
const stored = async (id: string) => (await call<TestCase>('GET', `/test-cases/${id}`)).body
const runRow = (id: string) => db.prepare('SELECT status, results, log, patterns FROM runs WHERE id = ?').bind(id).first<{ status: string; results: string; log: string; patterns: string | null }>()

const heal: HealProposal = {
  state: 'unresolved',
  elementName: '"Sign in" button',
  oldLocator: { key: 'id', value: 'go' },
  newLocator: { key: 'css', value: 'form button' },
  newCandidates: [{ key: 'css', value: 'form button' }],
  newFingerprint: { ...fingerprint, attrs: { type: 'submit' } },
  score: 0.9,
  before: { uiId: 'ui1', box: fingerprint.box },
  after: { screenshotKey: 'run/r/1.jpg', box: fingerprint.box, width: 1280, height: 800 },
}

beforeEach(async () => {
  db = memoryD1()
  sent.length = 0
  env = { DB: db, RUN_QUEUE: { send: async (m: QueueMessage) => void sent.push(m) }, SHOTS: { delete: async () => {}, list: async () => ({ objects: [], truncated: false }) } } as unknown as Env
  await db.prepare('INSERT INTO projects (id, name, base_url, variables, created_at) VALUES (?, ?, ?, ?, ?)').bind(PID, 'Shop', 'https://shop.example', '{}', '2026-01-01T00:00:00.000Z').run()
})

describe('saving steps from an editor', () => {
  it('is refused when the steps were changed since that editor loaded them, and nothing is written', async () => {
    const t = await newCase('Checkout', [comment('one')])
    expect(t.stepsRev).toBe(stepsRevision(JSON.stringify(t.steps)))
    // Another tab saves.
    const theirs = await call<TestCase>('PATCH', `/test-cases/${t.id}`, { steps: [comment('one'), comment('theirs')], baseStepsRev: t.stepsRev })
    expect(theirs.status).toBe(200)
    expect(theirs.body.stepsRev).not.toBe(t.stepsRev)
    // This one still has the old list.
    const stale = await call('PATCH', `/test-cases/${t.id}`, { steps: [comment('one'), comment('mine')], baseStepsRev: t.stepsRev })
    expect([stale.status, stale.code]).toEqual([409, 'steps_changed'])
    expect((await stored(t.id)).steps.map((s) => s.value)).toEqual(['one', 'theirs'])
    // Based on what is stored now, it goes through.
    expect((await call('PATCH', `/test-cases/${t.id}`, { steps: [comment('mine')], baseStepsRev: theirs.body.stepsRev })).status).toBe(200)
  })

  it('is not disturbed by a change of the name, the device or the data, and a client without a revision still overwrites', async () => {
    const t = await newCase('Checkout', [comment('one')])
    const renamed = await call<TestCase>('PATCH', `/test-cases/${t.id}`, { name: 'Renamed', data: { columns: ['A'], rows: [['1']] } })
    expect(renamed.body.stepsRev).toBe(t.stepsRev)
    expect((await call('PATCH', `/test-cases/${t.id}`, { steps: [comment('two')], baseStepsRev: t.stepsRev })).status).toBe(200)
    expect((await call('PATCH', `/test-cases/${t.id}`, { steps: [comment('script')] })).status).toBe(200)
  })

  it('writes only what the request names, so a save that crosses another one does not undo it', async () => {
    const t = await newCase('Checkout', [comment('one')])
    // Between a request reading the row and writing it, another request lands: here, right before the write.
    const crossing = (before: () => void) => {
      const real = db.prepare.bind(db)
      let once = true
      ;(db as { prepare: unknown }).prepare = (sql: string) => {
        if (once && /^UPDATE test_cases SET/.test(sql)) {
          once = false
          before()
        }
        return real(sql)
      }
      return () => ((db as { prepare: unknown }).prepare = real)
    }
    const table = JSON.stringify({ columns: ['A'], rows: [['1']] })
    // A save of the steps, crossed by a save of the data table, a rename and a change of device.
    let restore = crossing(() => void db.prepare("UPDATE test_cases SET data = ?, name = 'Renamed', description = 'New', device = 'iphone' WHERE id = ?").bind(table, t.id).run())
    expect((await call('PATCH', `/test-cases/${t.id}`, { steps: [comment('two')], baseStepsRev: t.stepsRev })).status).toBe(200)
    restore()
    let now = await stored(t.id)
    expect([now.steps.map((s) => s.value), now.data, now.name, now.description, now.device]).toEqual([['two'], JSON.parse(table), 'Renamed', 'New', 'iphone'])
    // A save of the data table, crossed by a save of the steps.
    restore = crossing(() => void db.prepare('UPDATE test_cases SET steps = ? WHERE id = ?').bind(JSON.stringify([comment('three')]), t.id).run())
    expect((await call('PATCH', `/test-cases/${t.id}`, { data: null })).status).toBe(200)
    restore()
    now = await stored(t.id)
    expect([now.steps.map((s) => s.value), now.data, now.name]).toEqual([['three'], null, 'Renamed'])
    // Nothing to write is not an error, and changes nothing.
    const same = await call<TestCase>('PATCH', `/test-cases/${t.id}`, {})
    expect([same.status, same.body.updatedAt]).toEqual([200, now.updatedAt])
  })

  it('does not delete a captured screen while the assistant works on the test case', async () => {
    const t = await newCase('Checkout', [comment('one')])
    await db.prepare("INSERT INTO uis (id, test_case_id, name, url, title, width, height, screenshot_key, elements, created_at, device) VALUES ('u1', ?, 'UI1', 'https://shop.example/', '', 10, 10, 'k', '[]', 'x', 'desktop')").bind(t.id).run()
    await db.prepare("INSERT INTO assistant_sessions (id, test_case_id, status, events, created_at, started_at) VALUES ('s1', ?, 'running', '[]', ?, ?)").bind(t.id, new Date().toISOString(), new Date().toISOString()).run()
    const refused = await call('DELETE', '/uis/u1')
    expect([refused.status, refused.code]).toEqual([409, 'assistant_busy'])
    await db.prepare("UPDATE assistant_sessions SET status = 'done' WHERE id = 's1'").run()
    expect((await call('DELETE', '/uis/u1')).status).toBe(200)
    expect(await db.prepare("SELECT 1 AS x FROM uis WHERE id = 'u1'").first()).toBeNull()
  })

  it('says it is the assistant when the assistant is what changed them', async () => {
    const t = await newCase('Checkout', [comment('one')])
    await db.prepare("INSERT INTO assistant_sessions (id, test_case_id, status, events, created_at, started_at) VALUES ('s1', ?, 'running', '[]', ?, ?)").bind(t.id, new Date().toISOString(), new Date().toISOString()).run()
    await db.prepare('UPDATE test_cases SET steps = ? WHERE id = ?').bind(JSON.stringify([comment('one'), comment('added')]), t.id).run()
    const refused = await call('PATCH', `/test-cases/${t.id}`, { steps: [comment('mine')], baseStepsRev: t.stepsRev })
    expect([refused.status, refused.code]).toEqual([409, 'assistant_busy'])
  })
})

describe('reviewing a repair', () => {
  async function healedRun(status = 'unresolved') {
    const click: Step = { id: 'b', command: 'click', target: target('ui1') }
    const t = await newCase('Checkout', [comment('a'), click])
    const run = (await call<Run>('POST', `/test-cases/${t.id}/runs`)).body
    const results: StepResult[] = [
      { stepId: 'a', number: 1, status: 'passed', sentence: '// a', durationMs: 1 },
      { stepId: 'b', number: 2, status: 'healed', sentence: 'Click "Sign in" button', durationMs: 1, heal },
    ]
    await db.prepare("UPDATE runs SET status = ?, results = ?, log = 'header', started_at = 'x' WHERE id = ?").bind(status, JSON.stringify(results), run.id).run()
    return { t, run, results }
  }

  it('makes a save from an editor that still has the old locator fail instead of putting the old locator back', async () => {
    const { t, run } = await healedRun()
    expect((await call('POST', `/runs/${run.id}/heals/b`, { action: 'approve' })).status).toBe(200)
    const repaired = await stored(t.id)
    expect(repaired.steps[1].target?.locator).toEqual({ key: 'css', value: 'form button' })
    const stale = await call('PATCH', `/test-cases/${t.id}`, { steps: t.steps, baseStepsRev: t.stepsRev })
    expect([stale.status, stale.code]).toEqual([409, 'steps_changed'])
    expect((await stored(t.id)).steps[1].target?.locator).toEqual({ key: 'css', value: 'form button' })
  })

  it('applies nothing when the steps are saved between reading them and writing the repair', async () => {
    const { t, run } = await healedRun()
    const real = db.prepare.bind(db)
    let raced = false
    ;(db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      // The editor's autosave lands right after the route has read the test case.
      if (!raced && sql.startsWith('SELECT elements FROM uis')) {
        raced = true
        void real('UPDATE test_cases SET steps = ? WHERE id = ?').bind(JSON.stringify([comment('a'), { id: 'b', command: 'click', target: target('ui1') }, comment('autosaved')]), t.id).run()
      }
      return real(sql)
    }
    const refused = await call('POST', `/runs/${run.id}/heals/b`, { action: 'approve' })
    expect(refused.status).toBe(409)
    expect(refused.error).toContain('saved by someone else')
    expect((await stored(t.id)).steps.map((s) => s.id)).toEqual(['a', 'b', 'autosaved'])
    expect(JSON.parse((await runRow(run.id))!.results)[1].heal.state).toBe('unresolved')
    // The reviewer tries again, and the repair lands on the steps as they are now.
    expect((await call('POST', `/runs/${run.id}/heals/b`, { action: 'approve' })).status).toBe(200)
    const after = await stored(t.id)
    expect(after.steps.map((s) => s.id)).toEqual(['a', 'b', 'autosaved'])
    expect(after.steps[1].target?.locator).toEqual({ key: 'css', value: 'form button' })
  })

  it('is not undone by the consumer finishing a run that was aborted in the meantime', async () => {
    const { run, results } = await healedRun('running')
    const written = { results: JSON.stringify(results), log: 'header' }
    await call('POST', `/runs/${run.id}/abort`)
    expect((await call('POST', `/runs/${run.id}/heals/b`, { action: 'approve' })).status).toBe(200)
    // The consumer comes back from the step it was on.
    const late: StepResult[] = [...results, { stepId: 'c', number: 3, status: 'passed', sentence: '// c', durationMs: 1 }]
    await recordRunEnd(db, run.id, { status: 'aborted', finishedAt: 'later', results: late, patterns: null, log: 'header\n[3] comment("c")\nFinished: later - aborted', written, body: 'header\n[3] comment("c")' })
    const row = (await runRow(run.id))!
    expect(row.status).toBe('aborted')
    expect(JSON.parse(row.results).map((r: StepResult) => r.heal?.state)).toEqual([undefined, 'approved'])
    expect(row.log).toBe('header\nAborted by user.\nRepair of step 2 ("Sign in" button) approved by reviewer.\n[3] comment("c")')
  })

  it('leaves room for the consumer to complete an aborted run that nobody reviewed, and a running one to end normally', async () => {
    const { run, results } = await healedRun('running')
    const written = { results: JSON.stringify(results), log: 'header' }
    const late: StepResult[] = [...results, { stepId: 'c', number: 3, status: 'passed', sentence: '// c', durationMs: 1 }]
    const end = { status: 'aborted' as const, finishedAt: 'later', results: late, patterns: null, log: 'header\n[3] x\nFinished: later - aborted', written, body: 'header\n[3] x' }
    await call('POST', `/runs/${run.id}/abort`)
    await recordRunEnd(db, run.id, end)
    let row = (await runRow(run.id))!
    expect(JSON.parse(row.results)).toHaveLength(3)
    expect(row.log).toBe('header\nAborted by user.\n[3] x')

    const other = await healedRun('running')
    await recordRunEnd(db, other.run.id, { ...end, status: 'unresolved', written: { results: JSON.stringify(other.results), log: 'header' } })
    row = (await runRow(other.run.id))!
    expect([row.status, row.log]).toEqual(['unresolved', 'header\n[3] x\nFinished: later - aborted'])
  })
})

describe('creating a run', () => {
  const branch = (): Step[] => [comment('a'), { id: 'if', command: 'if_variable_equals', variable: 'A', value: '1' }, comment('in'), { id: 'off', command: 'comment', value: 'off', disabled: true }]

  it('accepts a partial run before or inside a branch that is not closed yet, and still refuses the whole test', async () => {
    const t = await newCase('Branching', branch())
    expect((await call('POST', `/test-cases/${t.id}/runs`, { range: { from: 1, to: 1 } })).status).toBe(201)
    expect((await call('POST', `/test-cases/${t.id}/runs`, { range: { from: 3, to: 3 } })).status).toBe(201)
    const whole = await call('POST', `/test-cases/${t.id}/runs`)
    expect([whole.status, whole.error]).toEqual([400, 'Step 2: "If" is missing its "End branch"'])
    const broken = await newCase('Broken', [{ id: 'end', command: 'end_if' }, comment('b')])
    const partial = await call('POST', `/test-cases/${broken.id}/runs`, { range: { from: 2, to: 2 } })
    expect([partial.status, partial.error]).toEqual([400, 'Step 1: "End branch" has no matching "If"'])
  })

  it('refuses a partial run of nothing but disabled steps', async () => {
    const t = await newCase('Branching', branch())
    const refused = await call('POST', `/test-cases/${t.id}/runs`, { range: { from: 4, to: 4 } })
    expect([refused.status, refused.error]).toEqual([400, 'Step 4 is disabled, so there is nothing to run'])
  })

  it('refuses a run whose row could not hold its results, by size and not only by count', async () => {
    const long = (i: number): Step => ({ id: `s${i}`, command: 'store_fixed', variable: 'A', value: 'x'.repeat(4900) })
    const steps = Array.from({ length: 150 }, (_, i) => long(i))
    expect(estimateRunBytes(steps, steps, null)).toBeGreaterThan(MAX_RUN_BYTES)
    const t = await newCase('Long values', steps)
    const refused = await call('POST', `/test-cases/${t.id}/runs`)
    expect(refused.status).toBe(400)
    expect(refused.error).toContain('more data than one run can hold')
    const few = steps.slice(0, 20)
    expect(estimateRunBytes(few, few, null)).toBeLessThan(MAX_RUN_BYTES)
  })

  it('checks the branch structure of the steps a capture replays, and only of those', async () => {
    const t = await newCase('Branching', [{ id: 'end', command: 'end_if' }, ...branch()])
    const refused = await call('POST', `/test-cases/${t.id}/uis`, { afterStepId: 'a' })
    expect([refused.status, refused.error]).toEqual([400, 'Step 1: "End branch" has no matching "If". Fix the branch structure, then capture again.'])
    // Past the check and on to the browser, which this test does not have.
    const open = await newCase('Open branch', branch())
    expect((await call('POST', `/test-cases/${open.id}/uis`, { afterStepId: 'in' })).status).toBe(503)
  })
})

describe('a batch whose worker was stopped', () => {
  it('fails the test case that was running with what happened, and leaves the others alone', async () => {
    const ids = ['r1', 'r2', 'r3']
    await db.prepare("INSERT INTO batch_runs (id, project_id, number, status, trigger, created_at) VALUES ('b1', ?, 1, 'running', 'manual', 'x')").bind(PID).run()
    for (const [i, id] of ids.entries()) {
      await db
        .prepare("INSERT INTO runs (id, project_id, test_case_id, test_case_number, test_case_name, batch_run_id, run_order, status, steps, environment, created_at, started_at) VALUES (?, ?, 't', 1, 'T', 'b1', ?, ?, '[]', '{}', 'x', 'x')")
        .bind(id, PID, i + 1, ['succeeded', 'running', 'queued'][i])
        .run()
    }
    expect(await failInterruptedRuns(db, 'b1')).toBe(1)
    const rows = await Promise.all(ids.map(runRow))
    expect(rows.map((r) => r!.status)).toEqual(['succeeded', 'failed', 'queued'])
    expect(rows[1]!.log).toContain('Interrupted: the worker that was executing this batch was stopped')
  })
})

describe('deleting screenshots', () => {
  function bucket(objects: string[], failing: (prefix: string) => boolean = () => false) {
    const left = new Set(objects)
    let calls = 0
    const r2 = {
      delete: async (keys: string | string[]) => {
        calls++
        for (const k of [keys].flat()) left.delete(k)
      },
      list: async ({ prefix, cursor }: { prefix: string; cursor?: string }) => {
        calls++
        if (failing(prefix)) throw new Error('R2 is unavailable')
        // Two objects a page, to go through the cursor.
        const mine = [...left].filter((k) => k.startsWith(prefix)).slice(0, 2)
        return { objects: mine.map((key) => ({ key })), truncated: [...left].filter((k) => k.startsWith(prefix)).length > 2, cursor: cursor ?? 'next' }
      },
    }
    return { r2: r2 as unknown as R2Bucket, left, calls: () => calls }
  }

  it('goes through every prefix and page, and reports the prefix that failed instead of giving up on the rest', async () => {
    const objects = ['ui/a.jpg', ...Array.from({ length: 25 }, (_, run) => Array.from({ length: 5 }, (_, n) => `run/r${run}/${n}.jpg`)).flat()]
    const b = bucket(objects, (prefix) => prefix === 'run/r7/')
    const left = await deleteShots(
      b.r2,
      ['ui/a.jpg'],
      Array.from({ length: 25 }, (_, run) => `run/r${run}/`),
    )
    expect(left).toEqual({ keys: [], prefixes: ['run/r7/'] })
    expect([...b.left].every((k) => k.startsWith('run/r7/'))).toBe(true)
    expect(b.left.size).toBe(5)
  })

  it('queues a large job in pieces, and what a small one could not delete', async () => {
    const b = bucket([])
    const many = Array.from({ length: 250 }, (_, i) => `run/r${i}/`)
    await removeShots({ SHOTS: b.r2, RUN_QUEUE: env.RUN_QUEUE }, ['ui/a.jpg'], many)
    expect(b.calls()).toBe(0)
    expect(sent.map((m) => ('cleanup' in m ? [m.cleanup.keys?.length ?? 0, m.cleanup.prefixes?.length ?? 0] : null))).toEqual([[1, 0], [0, 100], [0, 100], [0, 50]])

    sent.length = 0
    const failing = bucket(['run/a/1.jpg'], () => true)
    await removeShots({ SHOTS: failing.r2, RUN_QUEUE: env.RUN_QUEUE }, [], ['run/a/'])
    expect(sent).toEqual([{ cleanup: { prefixes: ['run/a/'] } }])
  })
})

describe('naming a capture', () => {
  it('never hands out the name of a capture that was deleted, whatever the others are called', () => {
    expect(nextUiName([])).toBe('UI1')
    expect(nextUiName(['UI2'])).toBe('UI3')
    expect(nextUiName(['UI1', 'Login page', 'UI10', 'UI2 copy'])).toBe('UI11')
  })
})
