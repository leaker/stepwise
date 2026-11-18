import { Hono } from 'hono'
import { validateSteps } from '../../shared/commands'
import { flatRange, positionLabel, positionsOf } from '../../shared/expand'
import type { BatchRun, RunStatus, Step, StepResult, UiElement } from '../../shared/types'
import {
  environmentOf,
  getBatchRunRow,
  getProjectRow,
  getRunRow,
  getTestCaseRow,
  isSharedRow,
  isUnfinished,
  newId,
  now,
  refreshBatchRun,
  resolveBaseUrl,
  RUN_SUMMARY_COLUMNS,
  sweepStaleRuns,
  toBatchRun,
  toRun,
  toRunSummary,
  type BatchRunRow,
  type RunRow,
  type TestCaseRow,
} from '../db'
import { HttpError, type Env } from '../env'
import { assertExpanded, expandRow, MAX_RUN_STEPS, sharedLookupFor } from '../shared'
import { assertNavigateTargetsAllowed, readBody } from '../validate'

export const runs = new Hono<{ Bindings: Env }>()

const INSERT_RUN =
  'INSERT INTO runs (id, project_id, test_case_id, test_case_number, test_case_name, batch_run_id, run_order, status, steps, environment, range, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'

function parseRange(value: unknown, stepCount: number): { from: number; to: number } | null {
  if (value === undefined || value === null) return null
  const r = value as { from?: unknown; to?: unknown }
  if (typeof r !== 'object' || !Number.isInteger(r.from) || !Number.isInteger(r.to)) throw new HttpError(400, 'range must be { from, to } with whole numbers')
  const from = r.from as number
  const to = r.to as number
  if (from < 1 || to < from || to > stepCount) throw new HttpError(400, `range must be within steps 1-${stepCount}`)
  return { from, to }
}

/** Is there anything to execute? The marker row of an expanded shared step call is not a step that runs. */
const hasEnabledSteps = (steps: Step[]): boolean => steps.some((s) => !s.disabled && !s.call)

const TOO_MANY_STEPS = `With its shared steps this has more than ${MAX_RUN_STEPS} steps, which is more than one run can hold`

// ---- single runs ----

runs.post('/test-cases/:tid/runs', async (c) => {
  const testCase = await getTestCaseRow(c.env.DB, c.req.param('tid'))
  const project = await getProjectRow(c.env.DB, testCase.project_id)
  const body = await readBody(c.req)
  // The run gets the steps as they are now, with every shared step call replaced by that shared step's
  // steps: later edits to the test case or to a shared step do not change what this run reports.
  const expansion = await expandRow(c.env.DB, testCase)
  const range = parseRange(body.range, expansion.own.length)
  // A partial run is refused only for a broken call it would reach.
  const reached = new Set(expansion.own.slice(0, range ? range.to : expansion.own.length).map((s) => s.id))
  assertExpanded({ ...expansion, problems: expansion.problems.filter((p) => reached.has(p.stepId)) })
  const steps = expansion.steps
  if (!hasEnabledSteps(steps)) throw new HttpError(400, `This ${isSharedRow(testCase) ? 'shared step' : 'test case'} has no steps to run`)
  if (steps.length > MAX_RUN_STEPS) throw new HttpError(400, TOO_MANY_STEPS)
  const positions = positionsOf(steps)
  if (!range) {
    const problems = validateSteps(steps)
    if (problems.length) {
      const first = problems[0]
      throw new HttpError(400, `Step ${positionLabel(positions[steps.findIndex((s) => s.id === first.stepId)])}: ${first.message}`)
    }
  }
  const origin = new URL(c.req.url).origin
  const baseUrl = resolveBaseUrl(project.base_url, origin)
  // The steps before a partial run's range are replayed as set-up, so they are checked too.
  const executed = range ? steps.slice(0, flatRange(steps, range).to) : steps
  assertNavigateTargetsAllowed(executed, baseUrl, JSON.parse(project.variables) as Record<string, string>, c.env, origin, positions)

  const id = newId()
  await c.env.DB.prepare(INSERT_RUN)
    .bind(id, project.id, testCase.id, testCase.number, testCase.name, null, 0, 'queued', JSON.stringify(steps), JSON.stringify(environmentOf(baseUrl, testCase.device)), range ? JSON.stringify(range) : null, now())
    .run()
  try {
    await c.env.RUN_QUEUE.send({ runId: id, origin })
  } catch (e) {
    await c.env.DB.prepare('DELETE FROM runs WHERE id = ?').bind(id).run()
    throw e
  }
  return c.json(toRun(await getRunRow(c.env.DB, id)), 201)
})

runs.get('/test-cases/:tid/runs', async (c) => {
  const tid = c.req.param('tid')
  await getTestCaseRow(c.env.DB, tid)
  await sweepStaleRuns(c.env.DB)
  const { results } = await c.env.DB.prepare(`SELECT ${RUN_SUMMARY_COLUMNS} FROM runs WHERE test_case_id = ? AND batch_run_id IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 50`)
    .bind(tid)
    .all<RunRow>()
  return c.json(results.map(toRunSummary))
})

runs.get('/runs/:rid', async (c) => {
  await sweepStaleRuns(c.env.DB)
  return c.json(toRun(await getRunRow(c.env.DB, c.req.param('rid'))))
})

runs.post('/runs/:rid/abort', async (c) => {
  const id = c.req.param('rid')
  const run = await getRunRow(c.env.DB, id)
  if (isUnfinished(run.status)) {
    await c.env.DB.prepare("UPDATE runs SET status = 'aborted', finished_at = ?, log = log || CASE WHEN log = '' THEN '' ELSE char(10) END || 'Aborted by user.' WHERE id = ? AND status IN ('queued', 'running')")
      .bind(now(), id)
      .run()
    if (run.batch_run_id) await refreshBatchRun(c.env.DB, run.batch_run_id)
  }
  return c.json(toRun(await getRunRow(c.env.DB, id)))
})

// ---- self-healing review ----

runs.post('/runs/:rid/heals/:stepId', async (c) => {
  const id = c.req.param('rid')
  const stepId = c.req.param('stepId')
  const body = await readBody(c.req)
  const action = body.action
  if (action !== 'approve' && action !== 'reject') throw new HttpError(400, "action must be 'approve' or 'reject'")

  const run = await getRunRow(c.env.DB, id)
  if (isUnfinished(run.status)) throw new HttpError(409, 'Wait for the run to finish before reviewing its repairs')
  const results = JSON.parse(run.results) as StepResult[]
  const result = results.find((r) => r.stepId === stepId && r.heal)
  const heal = result?.heal
  if (!heal) throw new HttpError(404, 'This step has no repair proposal')
  // A decision is final: deciding twice would leave the test case and the report telling different stories.
  if (heal.state !== 'unresolved') throw new HttpError(409, `This repair was already ${heal.state}`)
  const step = (JSON.parse(run.steps ?? '[]') as Step[]).find((s) => s.id === stepId)
  const target = step?.target
  // A step that came from a shared step is repaired there, once, for every test case that calls it.
  const ownerId = step?.origin?.shared.id ?? run.test_case_id

  heal.state = action === 'approve' ? 'approved' : 'rejected'

  // Only a run that was waiting for review changes its verdict. One that failed (a failed step, a crash,
  // the time limit) or was aborted keeps it: approving a repair does not make an unfinished test pass.
  let status = run.status as RunStatus
  if (status === 'unresolved') {
    if (results.some((r) => r.status === 'failed' || r.heal?.state === 'rejected')) status = 'failed'
    else if (!results.some((r) => r.heal?.state === 'unresolved')) status = 'succeeded'
  }

  // Everything below is one transaction, and every statement only applies while the run's results are
  // still the ones this decision was based on, so two reviewers cannot overwrite each other's decision.
  const unchanged = 'EXISTS (SELECT 1 FROM runs WHERE id = ? AND results = ?)'
  const statements: D1PreparedStatement[] = []
  if (action === 'approve' && target) {
    // Apply the repair to the live test case (or shared step): every step that uses this element gets the
    // new locator. Boxes stay as captured: they are positions on the stored screenshot, which is not retaken.
    const testCase = await c.env.DB.prepare('SELECT * FROM test_cases WHERE id = ?').bind(ownerId).first<TestCaseRow>()
    if (testCase) {
      let changed = false
      const steps = (JSON.parse(testCase.steps) as Step[]).map((s) => {
        if (s.target?.uiId !== target.uiId || s.target.elementId !== target.elementId) return s
        changed = true
        return { ...s, target: { ...s.target, locator: heal.newLocator, candidates: heal.newCandidates, fingerprint: { ...heal.newFingerprint, box: s.target.fingerprint.box } } }
      })
      if (changed) {
        statements.push(
          c.env.DB.prepare(`UPDATE test_cases SET steps = ?, updated_at = ? WHERE id = ? AND ${unchanged}`).bind(JSON.stringify(steps), now(), testCase.id, id, run.results),
        )
      }
    }
    const ui = await c.env.DB.prepare('SELECT elements FROM uis WHERE id = ?').bind(target.uiId).first<{ elements: string }>()
    if (ui) {
      const elements = (JSON.parse(ui.elements) as UiElement[]).map((el) =>
        el.id === target.elementId ? { ...el, locators: heal.newCandidates.length ? heal.newCandidates : [heal.newLocator], fingerprint: { ...heal.newFingerprint, box: el.box } } : el,
      )
      statements.push(c.env.DB.prepare(`UPDATE uis SET elements = ? WHERE id = ? AND ${unchanged}`).bind(JSON.stringify(elements), target.uiId, id, run.results))
    }
  }
  const line = `Repair of step ${positionLabel(result)} (${heal.elementName}) ${heal.state} by reviewer.`
  statements.push(
    c.env.DB.prepare("UPDATE runs SET results = ?, status = ?, log = log || CASE WHEN log = '' THEN '' ELSE char(10) END || ? WHERE id = ? AND results = ? AND status = ?").bind(
      JSON.stringify(results),
      status,
      line,
      id,
      run.results,
      run.status,
    ),
  )
  const outcome = await c.env.DB.batch(statements)
  if (outcome[outcome.length - 1].meta.changes === 0) throw new HttpError(409, 'This run was changed by someone else in the meantime. Reload and try again.')
  if (run.batch_run_id) await refreshBatchRun(c.env.DB, run.batch_run_id)
  return c.json(toRun(await getRunRow(c.env.DB, id)))
})

// ---- batch runs ----

async function loadBatchRun(db: D1Database, id: string, withRuns: boolean): Promise<BatchRun> {
  const row = await getBatchRunRow(db, id)
  const { results } = await db.prepare(`SELECT ${RUN_SUMMARY_COLUMNS} FROM runs WHERE batch_run_id = ? ORDER BY run_order`).bind(id).all<RunRow>()
  const batch = toBatchRun(
    row,
    results.map((r) => r.status),
  )
  if (withRuns) batch.runs = results.map(toRunSummary)
  return batch
}

runs.get('/projects/:pid/batch-runs', async (c) => {
  const pid = c.req.param('pid')
  await getProjectRow(c.env.DB, pid)
  await sweepStaleRuns(c.env.DB)
  const [batches, statuses] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT * FROM batch_runs WHERE project_id = ? ORDER BY number DESC LIMIT 100').bind(pid),
    c.env.DB.prepare('SELECT batch_run_id, status FROM runs WHERE project_id = ? AND batch_run_id IS NOT NULL').bind(pid),
  ])
  const byBatch = new Map<string, string[]>()
  for (const r of statuses.results as { batch_run_id: string; status: string }[]) {
    const list = byBatch.get(r.batch_run_id)
    if (list) list.push(r.status)
    else byBatch.set(r.batch_run_id, [r.status])
  }
  return c.json((batches.results as BatchRunRow[]).map((b) => toBatchRun(b, byBatch.get(b.id) ?? [])))
})

runs.post('/projects/:pid/batch-runs', async (c) => {
  const project = await getProjectRow(c.env.DB, c.req.param('pid'))
  const body = await readBody(c.req)
  const trigger = body.trigger === 'api' ? 'api' : 'manual'
  // Shared steps are not test cases: they run as part of the test cases that call them.
  const { results: all } = await c.env.DB.prepare("SELECT * FROM test_cases WHERE project_id = ? AND kind = 'test' ORDER BY number").bind(project.id).all<TestCaseRow>()

  let selected = all
  if (body.testCaseIds !== undefined && body.testCaseIds !== null) {
    if (!Array.isArray(body.testCaseIds) || !body.testCaseIds.every((x) => typeof x === 'string')) throw new HttpError(400, 'testCaseIds must be an array of test case ids')
    const wanted = new Set(body.testCaseIds as string[])
    selected = all.filter((t) => wanted.has(t.id))
    if (selected.length !== wanted.size) throw new HttpError(400, 'testCaseIds contains a test case that is not in this project')
  }
  if (selected.length === 0) throw new HttpError(400, 'Select at least one test case to run')

  // Every run gets its steps with the shared step calls expanded, as a single run does. The shared steps are
  // loaded once for the whole batch.
  const lookup = await sharedLookupFor(
    c.env.DB,
    selected.map((t) => JSON.parse(t.steps) as Step[]),
  )
  const expanded = new Map<string, Step[]>()
  for (const t of selected) {
    const expansion = await expandRow(c.env.DB, t, lookup)
    assertExpanded(expansion, `#${t.number} ${t.name} - `)
    if (expansion.steps.length > MAX_RUN_STEPS) throw new HttpError(400, `#${t.number} ${t.name} - ${TOO_MANY_STEPS}`)
    expanded.set(t.id, expansion.steps)
  }

  // A test case without steps would be reported as succeeded without having tested anything. Asked for by
  // id it is an error; in "run everything" it is left out.
  const empty = selected.filter((t) => !hasEnabledSteps(expanded.get(t.id)!))
  if (empty.length && body.testCaseIds) throw new HttpError(400, `#${empty[0].number} ${empty[0].name} has no steps to run`)
  selected = selected.filter((t) => !empty.includes(t))
  if (selected.length === 0) throw new HttpError(400, 'No test case in this project has steps to run')

  const origin = new URL(c.req.url).origin
  const baseUrl = resolveBaseUrl(project.base_url, origin)
  const variables = JSON.parse(project.variables) as Record<string, string>
  for (const t of selected) {
    try {
      const steps = expanded.get(t.id)!
      assertNavigateTargetsAllowed(steps, baseUrl, variables, c.env, origin, positionsOf(steps))
    } catch (e) {
      if (e instanceof HttpError) throw new HttpError(400, `#${t.number} ${t.name} - ${e.message}`)
      throw e
    }
  }

  const id = newId()
  const ts = now()
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO batch_runs (id, project_id, number, status, trigger, created_at) SELECT ?, id, next_batch_number, ?, ?, ? FROM projects WHERE id = ?').bind(id, 'queued', trigger, ts, project.id),
    c.env.DB.prepare('UPDATE projects SET next_batch_number = next_batch_number + 1 WHERE id = ?').bind(project.id),
    ...selected.map((t, i) => c.env.DB.prepare(INSERT_RUN).bind(newId(), project.id, t.id, t.number, t.name, id, i + 1, 'queued', JSON.stringify(expanded.get(t.id)!), JSON.stringify(environmentOf(baseUrl, t.device)), null, ts)),
  ])
  try {
    await c.env.RUN_QUEUE.send({ batchRunId: id, origin })
  } catch (e) {
    await c.env.DB.prepare('DELETE FROM batch_runs WHERE id = ?').bind(id).run()
    throw e
  }
  return c.json(await loadBatchRun(c.env.DB, id, true), 201)
})

runs.get('/batch-runs/:bid', async (c) => {
  await sweepStaleRuns(c.env.DB)
  return c.json(await loadBatchRun(c.env.DB, c.req.param('bid'), true))
})

runs.post('/batch-runs/:bid/abort', async (c) => {
  const id = c.req.param('bid')
  await getBatchRunRow(c.env.DB, id)
  await c.env.DB.prepare(
    "UPDATE runs SET status = 'aborted', finished_at = ?, log = log || CASE WHEN log = '' THEN '' ELSE char(10) END || 'Aborted by user.' WHERE batch_run_id = ? AND status IN ('queued', 'running')",
  )
    .bind(now(), id)
    .run()
  await refreshBatchRun(c.env.DB, id)
  return c.json(await loadBatchRun(c.env.DB, id, true))
})
