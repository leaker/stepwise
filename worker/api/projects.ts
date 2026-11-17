import { Hono } from 'hono'
import type { Step } from '../../shared/types'
import { deleteShots, getProjectRow, newId, now, toProject, type ProjectRow } from '../db'
import type { Env } from '../env'
import { optionalBaseUrl, optionalText, optionalVariables, readBody, requireName } from '../validate'

export const projects = new Hono<{ Bindings: Env }>()

const LIST_SQL = `SELECT p.*,
  (SELECT COUNT(*) FROM test_cases t WHERE t.project_id = p.id) AS test_case_count,
  (SELECT COUNT(*) FROM batch_runs b WHERE b.project_id = p.id) AS batch_run_count
  FROM projects p`

/** First visit: create a demo project that points at the bundled sample site. Fixed ids keep this idempotent under concurrent requests. */
async function seedDemo(db: D1Database, origin: string): Promise<void> {
  const ts = now()
  const steps: Step[] = [{ id: newId(), command: 'navigate', value: '${BASE_URL}/login.html' }]
  await db.batch([
    db
      .prepare('INSERT OR IGNORE INTO projects (id, name, description, base_url, variables, next_case_number, created_at) VALUES (?, ?, ?, ?, ?, 2, ?)')
      .bind('demo', 'Harbor Inn demo', 'Sample project that tests the bundled Harbor Inn demo site.', `${origin}/demo`, '{}', ts),
    db
      .prepare('INSERT OR IGNORE INTO test_cases (id, project_id, number, name, description, steps, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?)')
      .bind('demo-sign-in', 'demo', 'Sign in with valid credentials', 'Capture the login screen in the editor, then pick elements to add steps.', JSON.stringify(steps), ts, ts),
  ])
}

projects.get('/projects', async (c) => {
  const list = () => c.env.DB.prepare(`${LIST_SQL} ORDER BY p.created_at, p.rowid`).all<ProjectRow>()
  let { results } = await list()
  if (results.length === 0) {
    await seedDemo(c.env.DB, new URL(c.req.url).origin)
    ;({ results } = await list())
  }
  return c.json(results.map(toProject))
})

projects.post('/projects', async (c) => {
  const body = await readBody(c.req)
  const name = requireName(body.name, 'Project')
  const description = optionalText(body.description, 'description', 2000) ?? ''
  const baseUrl = optionalBaseUrl(body.baseUrl) ?? ''
  const id = newId()
  await c.env.DB.prepare('INSERT INTO projects (id, name, description, base_url, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, name, description, baseUrl, now()).run()
  return c.json(toProject({ ...(await getProjectRow(c.env.DB, id)), test_case_count: 0, batch_run_count: 0 }), 201)
})

async function getWithCounts(db: D1Database, id: string): Promise<ProjectRow> {
  const row = await db.prepare(`${LIST_SQL} WHERE p.id = ?`).bind(id).first<ProjectRow>()
  return row ?? (await getProjectRow(db, id)) // getProjectRow throws the 404
}

projects.get('/projects/:pid', async (c) => c.json(toProject(await getWithCounts(c.env.DB, c.req.param('pid')))))

projects.patch('/projects/:pid', async (c) => {
  const id = c.req.param('pid')
  const current = await getProjectRow(c.env.DB, id)
  const body = await readBody(c.req)
  const name = body.name === undefined ? current.name : requireName(body.name, 'Project')
  const description = optionalText(body.description, 'description', 2000) ?? current.description
  const baseUrl = optionalBaseUrl(body.baseUrl) ?? current.base_url
  const variables = optionalVariables(body.variables)
  await c.env.DB.prepare('UPDATE projects SET name = ?, description = ?, base_url = ?, variables = ? WHERE id = ?')
    .bind(name, description, baseUrl, variables ? JSON.stringify(variables) : current.variables, id)
    .run()
  return c.json(toProject(await getWithCounts(c.env.DB, id)))
})

projects.delete('/projects/:pid', async (c) => {
  const id = c.req.param('pid')
  await getProjectRow(c.env.DB, id)
  const [uis, runs] = await c.env.DB.batch<{ k: string }>([
    c.env.DB.prepare('SELECT u.screenshot_key AS k FROM uis u JOIN test_cases t ON t.id = u.test_case_id WHERE t.project_id = ?').bind(id),
    c.env.DB.prepare('SELECT id AS k FROM runs WHERE project_id = ?').bind(id),
  ])
  await c.env.DB.prepare('DELETE FROM projects WHERE id = ?').bind(id).run()
  c.executionCtx.waitUntil(
    deleteShots(
      c.env.SHOTS,
      [...new Set(uis.results.map((r) => r.k))],
      runs.results.map((r) => `run/${r.k}/`),
    ),
  )
  return c.json({ ok: true })
})
