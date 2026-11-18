import { Hono } from 'hono'
import { sharedLabel, validateSteps } from '../../shared/commands'
import { hasPatterns, rowValues, runVariables } from '../../shared/data'
import { DEFAULT_DEVICE, isDeviceId } from '../../shared/devices'
import { flatRange, NESTED_SHARED_MESSAGE, positionsOf } from '../../shared/expand'
import type { DataTable, DeviceId, Step, TestCase } from '../../shared/types'
import { deleteShots, getProjectRow, getTestCaseRow, isSharedRow, lastRunsFor, newId, now, resolveBaseUrl, sweepStaleRuns, toTestCase, toUi, type TestCaseRow, type UiRow } from '../db'
import { sweepStaleSessions } from '../assistant/store'
import { HttpError, type Env } from '../env'
import { captureScreen } from '../runner'
import { assertExpanded, callersByShared, expandRow } from '../shared'
import { assertNavigateTargetsAllowed, isHostAllowed, optionalData, optionalText, parseElements, parseSteps, readBody, requireName, resolveUrl } from '../validate'

export const testCases = new Hono<{ Bindings: Env }>()

/** With the last run, and for a shared step the test cases that call it. */
async function withLastRun(db: D1Database, row: TestCaseRow): Promise<TestCase> {
  const last = await lastRunsFor(db, { testCaseId: row.id })
  const testCase = toTestCase(row, last.get(row.id) ?? null)
  if (isSharedRow(row)) testCase.usedBy = (await callersByShared(db, row.project_id)).get(row.id) ?? []
  return testCase
}

type Kind = 'test' | 'shared'
interface NewRow {
  kind: Kind
  name: string
  description: string
  device: string
  steps: Step[]
  data?: string
}

/**
 * The statements that insert a test case or a shared step with the project's next number of its kind.
 * `onlyIf` (SQL condition and its bindings) makes both conditional, for use inside a larger batch.
 */
function insertStatements(db: D1Database, projectId: string, id: string, fields: NewRow, onlyIf?: { sql: string; args: unknown[] }): D1PreparedStatement[] {
  const ts = now()
  const shared = fields.kind === 'shared'
  // A shared step's number is stored negated, so S1 and #1 can both exist (see migrations/0006).
  const number = shared ? '-next_shared_number' : 'next_case_number'
  const counter = shared ? 'next_shared_number' : 'next_case_number'
  const guard = onlyIf ? ` AND ${onlyIf.sql}` : ''
  const args = onlyIf?.args ?? []
  return [
    db
      .prepare(
        `INSERT INTO test_cases (id, project_id, number, name, description, steps, created_at, updated_at, device, kind, data) SELECT ?, id, ${number}, ?, ?, ?, ?, ?, ?, ?, ? FROM projects WHERE id = ?${guard}`,
      )
      .bind(id, fields.name, fields.description, JSON.stringify(fields.steps), ts, ts, fields.device, fields.kind, fields.data ?? '', projectId, ...args),
    db.prepare(`UPDATE projects SET ${counter} = ${counter} + 1 WHERE id = ?${guard}`).bind(projectId, ...args),
  ]
}

/** Take the next sequential number of the project and insert the row in one atomic batch. */
async function insertTestCase(db: D1Database, projectId: string, fields: NewRow): Promise<string> {
  const id = newId()
  await db.batch(insertStatements(db, projectId, id, fields))
  return id
}

const INSERT_UI = 'INSERT INTO uis (id, test_case_id, name, url, title, width, height, screenshot_key, elements, created_at, device) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
const copyUi = (db: D1Database, u: UiRow, id: string, testCaseId: string): D1PreparedStatement =>
  db.prepare(INSERT_UI).bind(id, testCaseId, u.name, u.url, u.title, u.width, u.height, u.screenshot_key, u.elements, u.created_at, u.device)

function optionalDevice(value: unknown): DeviceId | undefined {
  if (value === undefined || value === null) return undefined
  if (!isDeviceId(value)) throw new HttpError(400, "device must be 'desktop', 'iphone' or 'pixel'")
  return value
}

testCases.get('/projects/:pid/test-cases', async (c) => {
  const pid = c.req.param('pid')
  await getProjectRow(c.env.DB, pid)
  await sweepStaleRuns(c.env.DB)
  const [{ results }, last] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM test_cases WHERE project_id = ? AND kind = 'test' ORDER BY number").bind(pid).all<TestCaseRow>(),
    lastRunsFor(c.env.DB, { projectId: pid }),
  ])
  return c.json(results.map((r) => toTestCase(r, last.get(r.id) ?? null)))
})

// ---- shared steps ----

testCases.get('/projects/:pid/shared-steps', async (c) => {
  const pid = c.req.param('pid')
  await getProjectRow(c.env.DB, pid)
  await sweepStaleRuns(c.env.DB)
  const [{ results }, last, callers] = await Promise.all([
    // Stored negated, so descending is S1, S2, ...
    c.env.DB.prepare("SELECT * FROM test_cases WHERE project_id = ? AND kind = 'shared' ORDER BY number DESC").bind(pid).all<TestCaseRow>(),
    lastRunsFor(c.env.DB, { projectId: pid }),
    callersByShared(c.env.DB, pid),
  ])
  return c.json(results.map((r) => ({ ...toTestCase(r, last.get(r.id) ?? null), usedBy: callers.get(r.id) ?? [] })))
})

testCases.post('/projects/:pid/shared-steps', async (c) => {
  const pid = c.req.param('pid')
  await getProjectRow(c.env.DB, pid)
  const body = await readBody(c.req)
  const name = body.name === undefined || body.name === null || body.name === '' ? 'New shared step' : requireName(body.name, 'Shared step')
  const description = optionalText(body.description, 'description', 2000) ?? ''
  const id = await insertTestCase(c.env.DB, pid, { kind: 'shared', name, description, device: optionalDevice(body.device) ?? DEFAULT_DEVICE, steps: [] })
  return c.json({ ...toTestCase(await getTestCaseRow(c.env.DB, id)), usedBy: [] }, 201)
})

/**
 * Move consecutive steps of a test case into a new shared step and leave a call in their place. Done here,
 * in one transaction, because the steps' elements point at screens captured for the test case: the shared
 * step gets its own copies of those screens (same screenshot objects), so its editor and the self-healing
 * review can show them.
 */
testCases.post('/test-cases/:tid/extract-shared', async (c) => {
  const source = await getTestCaseRow(c.env.DB, c.req.param('tid'))
  if (isSharedRow(source)) throw new HttpError(400, NESTED_SHARED_MESSAGE)
  const body = await readBody(c.req)
  const name = body.name === undefined || body.name === null || body.name === '' ? 'New shared step' : requireName(body.name, 'Shared step')
  if (!Array.isArray(body.stepIds) || body.stepIds.length === 0 || !body.stepIds.every((x) => typeof x === 'string')) throw new HttpError(400, 'stepIds must be a non-empty array of step ids')
  const wanted = new Set(body.stepIds as string[])
  const steps = JSON.parse(source.steps) as Step[]
  const first = steps.findIndex((s) => wanted.has(s.id))
  const moved = first < 0 ? [] : steps.slice(first, first + wanted.size)
  if (moved.length !== wanted.size || !moved.every((s) => wanted.has(s.id))) throw new HttpError(400, 'stepIds must be consecutive steps of this test case (save the test case first)')
  if (moved.some((s) => s.command === 'shared_step')) throw new HttpError(400, `The selection contains a shared step call. ${NESTED_SHARED_MESSAGE}.`)
  if (validateSteps(moved).length) throw new HttpError(400, 'The selection must contain whole If ... End branch blocks: a shared step cannot start or end in the middle of one')

  // The shared step gets copies of the screens its steps point at.
  const usedUiIds = [...new Set(moved.flatMap((s) => (s.target ? [s.target.uiId] : [])))]
  const { results: uis } = await c.env.DB.prepare('SELECT * FROM uis WHERE test_case_id = ? ORDER BY created_at, rowid').bind(source.id).all<UiRow>()
  const copied = uis.filter((u) => usedUiIds.includes(u.id))
  const uiIds = new Map(copied.map((u) => [u.id, newId()]))
  const sharedId = newId()
  const sharedSteps = moved.map((s) => (s.target ? { ...s, target: { ...s.target, uiId: uiIds.get(s.target.uiId) ?? s.target.uiId } } : s))
  const call: Step = { id: newId(), command: 'shared_step', value: sharedId }
  const next = JSON.stringify([...steps.slice(0, first), call, ...steps.slice(first + moved.length)])

  // The test case is rewritten only if its steps are still the ones read above and the assistant is not
  // editing them; everything else in the batch only happens if that write did.
  await sweepStaleSessions(c.env.DB)
  const applied = { sql: 'EXISTS (SELECT 1 FROM test_cases WHERE id = ? AND steps = ?)', args: [source.id, next] }
  const outcome = await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE test_cases SET steps = ?1, updated_at = ?2 WHERE id = ?3 AND steps = ?4 AND NOT EXISTS (SELECT 1 FROM assistant_sessions WHERE test_case_id = ?3 AND status IN ('queued', 'running'))",
    ).bind(next, now(), source.id, source.steps),
    ...insertStatements(c.env.DB, source.project_id, sharedId, { kind: 'shared', name, description: '', device: source.device, steps: sharedSteps }, applied),
    ...copied.map((u) =>
      c.env.DB.prepare(`${INSERT_UI.replace(/VALUES .*$/, '')}SELECT ?, id, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM test_cases WHERE id = ?`).bind(
        uiIds.get(u.id)!,
        u.name,
        u.url,
        u.title,
        u.width,
        u.height,
        u.screenshot_key,
        u.elements,
        u.created_at,
        u.device,
        sharedId,
      ),
    ),
  ])
  if (outcome[0].meta.changes === 0) throw new HttpError(409, 'The steps of this test case were changed in the meantime (by the assistant or in another tab). Reload and try again.')
  return c.json({ testCase: await withLastRun(c.env.DB, await getTestCaseRow(c.env.DB, source.id)), shared: await withLastRun(c.env.DB, await getTestCaseRow(c.env.DB, sharedId)) }, 201)
})

// ---- one test case or shared step ----

testCases.post('/projects/:pid/test-cases', async (c) => {
  const pid = c.req.param('pid')
  await getProjectRow(c.env.DB, pid)
  const body = await readBody(c.req)
  const name = body.name === undefined || body.name === null || body.name === '' ? 'New test' : requireName(body.name, 'Test case')
  const description = optionalText(body.description, 'description', 2000) ?? ''
  const id = await insertTestCase(c.env.DB, pid, { kind: 'test', name, description, device: optionalDevice(body.device) ?? DEFAULT_DEVICE, steps: [] })
  return c.json(toTestCase(await getTestCaseRow(c.env.DB, id)), 201)
})

testCases.get('/test-cases/:tid', async (c) => {
  const row = await getTestCaseRow(c.env.DB, c.req.param('tid'))
  await sweepStaleRuns(c.env.DB)
  return c.json(await withLastRun(c.env.DB, row))
})

testCases.patch('/test-cases/:tid', async (c) => {
  const id = c.req.param('tid')
  const current = await getTestCaseRow(c.env.DB, id)
  const body = await readBody(c.req)
  const name = body.name === undefined ? current.name : requireName(body.name, isSharedRow(current) ? 'Shared step' : 'Test case')
  const description = optionalText(body.description, 'description', 2000) ?? current.description
  const device = optionalDevice(body.device) ?? current.device
  // The data table is not part of what the assistant edits, so it can be saved while a session is running.
  const table = optionalData(body.data)
  if (table && isSharedRow(current)) throw new HttpError(400, 'A shared step cannot have a data table: it uses the data of the test case that calls it')
  const data = table === undefined ? current.data : table ? JSON.stringify(table) : ''
  if (body.steps === undefined) {
    await c.env.DB.prepare('UPDATE test_cases SET name = ?, description = ?, device = ?, data = ?, updated_at = ? WHERE id = ?').bind(name, description, device, data, now(), id).run()
  } else {
    // While the assistant works on a test case it owns the step list: it reads, changes and writes it back
    // call by call, and a save from the editor (another tab, a script) in between would be lost or would
    // wipe out what the assistant added. The editor's lock is the courtesy; this is the rule.
    await sweepStaleSessions(c.env.DB)
    const parsed = parseSteps(body.steps)
    // Shared steps do not nest. (An unfinished If block is not refused here: the editor saves while the user
    // is still typing it. It is reported in the editor and refused when a run is created.)
    const nested = isSharedRow(current) ? parsed.findIndex((s) => s.command === 'shared_step') : -1
    if (nested >= 0) throw new HttpError(400, `Step ${nested + 1}: ${NESTED_SHARED_MESSAGE}`)
    const steps = JSON.stringify(parsed)
    const saved = await c.env.DB.prepare(
      "UPDATE test_cases SET name = ?1, description = ?2, device = ?3, steps = ?4, updated_at = ?5, data = ?7 WHERE id = ?6 AND NOT EXISTS (SELECT 1 FROM assistant_sessions WHERE test_case_id = ?6 AND status IN ('queued', 'running'))",
    )
      .bind(name, description, device, steps, now(), id, data)
      .run()
    if (saved.meta.changes === 0) throw new HttpError(409, 'The assistant is editing the steps of this test case. Wait for it to finish, or abort it, then try again.')
  }
  return c.json(await withLastRun(c.env.DB, await getTestCaseRow(c.env.DB, id)))
})

testCases.delete('/test-cases/:tid', async (c) => {
  const id = c.req.param('tid')
  const row = await getTestCaseRow(c.env.DB, id)
  if (isSharedRow(row)) {
    // Deleting it would leave those test cases with a step that cannot run.
    const callers = (await callersByShared(c.env.DB, row.project_id)).get(id) ?? []
    if (callers.length) {
      const names = callers.slice(0, 5).map((t) => `#${t.number} ${t.name}`)
      const more = callers.length - names.length
      throw new HttpError(409, `Shared step ${sharedLabel({ number: Math.abs(row.number), name: row.name })} is used by ${names.join(', ')}${more > 0 ? ` and ${more} more` : ''}. Remove the calls first.`)
    }
  }
  // Duplicated test cases share screenshot objects, so only delete the ones nobody else points to.
  const [shots, runs] = await c.env.DB.batch<{ k: string }>([
    c.env.DB.prepare('SELECT screenshot_key AS k FROM uis WHERE test_case_id = ?1 AND screenshot_key NOT IN (SELECT screenshot_key FROM uis WHERE test_case_id <> ?1)').bind(id),
    c.env.DB.prepare('SELECT id AS k FROM runs WHERE test_case_id = ? AND batch_run_id IS NULL').bind(id),
  ])
  // Single runs go with the test case; runs that belong to a batch report stay as history.
  await c.env.DB.batch([c.env.DB.prepare('DELETE FROM runs WHERE test_case_id = ? AND batch_run_id IS NULL').bind(id), c.env.DB.prepare('DELETE FROM test_cases WHERE id = ?').bind(id)])
  c.executionCtx.waitUntil(
    deleteShots(
      c.env.SHOTS,
      shots.results.map((r) => r.k),
      runs.results.map((r) => `run/${r.k}/`),
    ),
  )
  return c.json({ ok: true })
})

testCases.post('/test-cases/:tid/duplicate', async (c) => {
  const source = await getTestCaseRow(c.env.DB, c.req.param('tid'))
  const { results: uis } = await c.env.DB.prepare('SELECT * FROM uis WHERE test_case_id = ? ORDER BY created_at, rowid').bind(source.id).all<UiRow>()

  // UIs get new ids, so the copied steps must point at the copies.
  const uiIds = new Map(uis.map((u) => [u.id, newId()]))
  const steps = (JSON.parse(source.steps) as Step[]).map((s) => ({
    ...s,
    id: newId(),
    ...(s.target ? { target: { ...s.target, uiId: uiIds.get(s.target.uiId) ?? s.target.uiId } } : {}),
  }))
  const name = `${source.name} (copy)`.slice(0, 120)
  const id = await insertTestCase(c.env.DB, source.project_id, { kind: isSharedRow(source) ? 'shared' : 'test', name, description: source.description, device: source.device, steps, data: source.data })
  if (uis.length) await c.env.DB.batch(uis.map((u) => copyUi(c.env.DB, u, uiIds.get(u.id)!, id)))
  return c.json(await withLastRun(c.env.DB, await getTestCaseRow(c.env.DB, id)), 201)
})

// ---- UIs ----

testCases.get('/test-cases/:tid/uis', async (c) => {
  const tid = c.req.param('tid')
  await getTestCaseRow(c.env.DB, tid)
  const { results } = await c.env.DB.prepare('SELECT * FROM uis WHERE test_case_id = ? ORDER BY created_at, rowid').bind(tid).all<UiRow>()
  return c.json(results.map(toUi))
})

testCases.post('/test-cases/:tid/uis', async (c) => {
  const testCase = await getTestCaseRow(c.env.DB, c.req.param('tid'))
  const project = await getProjectRow(c.env.DB, testCase.project_id)
  const body = await readBody(c.req)
  const appOrigin = new URL(c.req.url).origin
  const baseUrl = resolveBaseUrl(project.base_url, appOrigin)
  // A data-driven test case is replayed with the values of one data row: the first unless `row` says otherwise.
  const table = isSharedRow(testCase) ? null : (JSON.parse(testCase.data || 'null') as DataTable | null)
  let row = 1
  if (body.row !== undefined && body.row !== null) {
    if (!Number.isInteger(body.row) || (body.row as number) < 1) throw new HttpError(400, 'row must be a whole number from 1')
    row = body.row as number
    if (hasPatterns(table) && row > table.rows.length) throw new HttpError(400, `row must be within the ${table.rows.length} data rows of this test case`)
  }
  const variables = runVariables(JSON.parse(project.variables) as Record<string, string>, hasPatterns(table) ? rowValues(table, row) : null)

  let steps: Step[] = []
  let replayTo: number | null = null
  let url: URL | null = null
  if (typeof body.afterStepId === 'string' && body.afterStepId !== '') {
    // The replay runs through shared step calls, so it uses the expanded list; afterStepId names a step of the test case itself.
    const expansion = await expandRow(c.env.DB, testCase)
    const index = expansion.own.findIndex((s) => s.id === body.afterStepId)
    if (index < 0) throw new HttpError(400, `afterStepId does not match a step of this ${isSharedRow(testCase) ? 'shared step' : 'test case'} (save it first)`)
    // Only a call that the replay reaches has to be sound.
    const reached = new Set(expansion.own.slice(0, index + 1).map((s) => s.id))
    assertExpanded({ ...expansion, problems: expansion.problems.filter((p) => reached.has(p.stepId)) })
    steps = expansion.steps
    replayTo = index + 1
    assertNavigateTargetsAllowed(steps.slice(0, flatRange(steps, { from: 1, to: replayTo }).to), baseUrl, variables, c.env, appOrigin, positionsOf(steps))
  } else {
    if (typeof body.url !== 'string' || body.url.trim() === '') throw new HttpError(400, 'Enter the URL of the screen to capture')
    url = resolveUrl(body.url, baseUrl)
    if (!url) throw new HttpError(400, 'The URL must be an http(s) URL, or a path when the project has a base URL')
    if (!isHostAllowed(url, c.env, appOrigin)) throw new HttpError(400, `${url.hostname} is not in this deployment's allowed hosts`)
  }

  const response = await captureScreen(c.env, { testCase, steps, baseUrl, variables, replayTo, url, appOrigin })
  return c.json(response, 201)
})

async function getUiRow(db: D1Database, id: string): Promise<UiRow> {
  const row = await db.prepare('SELECT * FROM uis WHERE id = ?').bind(id).first<UiRow>()
  if (!row) throw new HttpError(404, 'UI not found')
  return row
}

testCases.patch('/uis/:uid', async (c) => {
  const id = c.req.param('uid')
  const current = await getUiRow(c.env.DB, id)
  const body = await readBody(c.req)
  const name = body.name === undefined ? current.name : requireName(body.name, 'UI')
  const elements = body.elements === undefined ? current.elements : JSON.stringify(parseElements(body.elements))
  await c.env.DB.prepare('UPDATE uis SET name = ?, elements = ? WHERE id = ?').bind(name, elements, id).run()
  return c.json(toUi({ ...current, name, elements }))
})

testCases.delete('/uis/:uid', async (c) => {
  const id = c.req.param('uid')
  const current = await getUiRow(c.env.DB, id)
  await c.env.DB.prepare('DELETE FROM uis WHERE id = ?').bind(id).run()
  const shared = await c.env.DB.prepare('SELECT 1 AS x FROM uis WHERE screenshot_key = ? LIMIT 1').bind(current.screenshot_key).first()
  if (!shared) c.executionCtx.waitUntil(deleteShots(c.env.SHOTS, [current.screenshot_key]))
  return c.json({ ok: true })
})
