import { Hono } from 'hono'
import type { Step } from '../../shared/types'
import { deleteShots, getProjectRow, getTestCaseRow, lastRunsFor, newId, now, sweepStaleRuns, toTestCase, toUi, type TestCaseRow, type UiRow } from '../db'
import { HttpError, type Env } from '../env'
import { captureScreen } from '../runner'
import { assertNavigateTargetsAllowed, isHostAllowed, optionalText, parseElements, parseSteps, readBody, requireName, resolveUrl } from '../validate'

export const testCases = new Hono<{ Bindings: Env }>()

async function withLastRun(db: D1Database, row: TestCaseRow) {
  const last = await lastRunsFor(db, { testCaseId: row.id })
  return toTestCase(row, last.get(row.id) ?? null)
}

/** Take the next sequential number of the project and insert the test case in one atomic batch. */
async function insertTestCase(db: D1Database, projectId: string, fields: { name: string; description: string; steps: Step[] }): Promise<string> {
  const id = newId()
  const ts = now()
  await db.batch([
    db
      .prepare('INSERT INTO test_cases (id, project_id, number, name, description, steps, created_at, updated_at) SELECT ?1, id, next_case_number, ?2, ?3, ?4, ?5, ?5 FROM projects WHERE id = ?6')
      .bind(id, fields.name, fields.description, JSON.stringify(fields.steps), ts, projectId),
    db.prepare('UPDATE projects SET next_case_number = next_case_number + 1 WHERE id = ?').bind(projectId),
  ])
  return id
}

testCases.get('/projects/:pid/test-cases', async (c) => {
  const pid = c.req.param('pid')
  await getProjectRow(c.env.DB, pid)
  await sweepStaleRuns(c.env.DB)
  const [{ results }, last] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM test_cases WHERE project_id = ? ORDER BY number').bind(pid).all<TestCaseRow>(),
    lastRunsFor(c.env.DB, { projectId: pid }),
  ])
  return c.json(results.map((r) => toTestCase(r, last.get(r.id) ?? null)))
})

testCases.post('/projects/:pid/test-cases', async (c) => {
  const pid = c.req.param('pid')
  await getProjectRow(c.env.DB, pid)
  const body = await readBody(c.req)
  const name = body.name === undefined || body.name === null || body.name === '' ? 'New test' : requireName(body.name, 'Test case')
  const description = optionalText(body.description, 'description', 2000) ?? ''
  const id = await insertTestCase(c.env.DB, pid, { name, description, steps: [] })
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
  const name = body.name === undefined ? current.name : requireName(body.name, 'Test case')
  const description = optionalText(body.description, 'description', 2000) ?? current.description
  const steps = body.steps === undefined ? current.steps : JSON.stringify(parseSteps(body.steps))
  await c.env.DB.prepare('UPDATE test_cases SET name = ?, description = ?, steps = ?, updated_at = ? WHERE id = ?').bind(name, description, steps, now(), id).run()
  return c.json(await withLastRun(c.env.DB, await getTestCaseRow(c.env.DB, id)))
})

testCases.delete('/test-cases/:tid', async (c) => {
  const id = c.req.param('tid')
  await getTestCaseRow(c.env.DB, id)
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
  const id = await insertTestCase(c.env.DB, source.project_id, { name, description: source.description, steps })
  if (uis.length) {
    await c.env.DB.batch(
      uis.map((u) =>
        c.env.DB.prepare('INSERT INTO uis (id, test_case_id, name, url, title, width, height, screenshot_key, elements, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(
          uiIds.get(u.id)!,
          id,
          u.name,
          u.url,
          u.title,
          u.width,
          u.height,
          u.screenshot_key,
          u.elements,
          u.created_at,
        ),
      ),
    )
  }
  return c.json(toTestCase(await getTestCaseRow(c.env.DB, id)), 201)
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
  const steps = JSON.parse(testCase.steps) as Step[]
  const variables = JSON.parse(project.variables) as Record<string, string>

  let replayTo: number | null = null
  let url: URL | null = null
  if (typeof body.afterStepId === 'string' && body.afterStepId !== '') {
    const index = steps.findIndex((s) => s.id === body.afterStepId)
    if (index < 0) throw new HttpError(400, 'afterStepId does not match a step of this test case (save the test case first)')
    replayTo = index + 1
    assertNavigateTargetsAllowed(steps.slice(0, replayTo), project.base_url, variables, c.env, appOrigin)
  } else {
    if (typeof body.url !== 'string' || body.url.trim() === '') throw new HttpError(400, 'Enter the URL of the screen to capture')
    url = resolveUrl(body.url, project.base_url)
    if (!url) throw new HttpError(400, 'The URL must be an http(s) URL, or a path when the project has a base URL')
    if (!isHostAllowed(url, c.env, appOrigin)) throw new HttpError(400, `${url.hostname} is not in this deployment's allowed hosts`)
  }

  const response = await captureScreen(c.env, { testCase, steps, baseUrl: project.base_url, variables, replayTo, url, appOrigin })
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
