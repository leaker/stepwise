import { Hono } from 'hono'
import type { AssistantEvent, AssistantStatus } from '../../shared/types'
import { ASSISTANT_MODEL } from '../assistant/prompt'
import { appendEvent, getSessionRow, sweepStaleSessions, toSession, type AssistantSessionRow } from '../assistant/store'
import { getTestCaseRow, newId, now } from '../db'
import { HttpError, type Env } from '../env'
import { readBody } from '../validate'

export const assistant = new Hono<{ Bindings: Env }>()

const MAX_MESSAGE = 2000

function requireEnabled(env: Env): void {
  if (!env.ANTHROPIC_API_KEY) throw new HttpError(503, 'The AI assistant is not configured on this deployment. Set the ANTHROPIC_API_KEY secret to enable it.')
}

assistant.get('/assistant/status', (c) => c.json({ enabled: !!c.env.ANTHROPIC_API_KEY, model: ASSISTANT_MODEL } satisfies AssistantStatus))

assistant.post('/test-cases/:tid/assistant', async (c) => {
  requireEnabled(c.env)
  const testCase = await getTestCaseRow(c.env.DB, c.req.param('tid'))
  const body = await readBody(c.req)
  const message = typeof body.message === 'string' ? body.message.trim() : ''
  if (message === '') throw new HttpError(400, 'Describe what the test should do')
  if (message.length > MAX_MESSAGE) throw new HttpError(400, `The message must be ${MAX_MESSAGE} characters or fewer`)

  await sweepStaleSessions(c.env.DB)
  const id = newId()
  const ts = now()
  const events: AssistantEvent[] = [{ kind: 'user', text: message, at: ts }]
  // One statement: two requests at the same moment cannot both find the test case free.
  const inserted = await c.env.DB.prepare(
    "INSERT INTO assistant_sessions (id, test_case_id, status, events, created_at) SELECT ?1, ?2, 'queued', ?3, ?4 WHERE NOT EXISTS (SELECT 1 FROM assistant_sessions WHERE test_case_id = ?2 AND status IN ('queued', 'running'))",
  )
    .bind(id, testCase.id, JSON.stringify(events), ts)
    .run()
  if (inserted.meta.changes === 0) throw new HttpError(409, 'The assistant is still working on this test case. Wait for it to finish, or abort it.')
  try {
    await c.env.RUN_QUEUE.send({ assistantSessionId: id, origin: new URL(c.req.url).origin })
  } catch (e) {
    await c.env.DB.prepare('DELETE FROM assistant_sessions WHERE id = ?').bind(id).run()
    throw e
  }
  return c.json(toSession(await getSessionRow(c.env.DB, id)), 201)
})

assistant.get('/test-cases/:tid/assistant', async (c) => {
  requireEnabled(c.env)
  const tid = c.req.param('tid')
  await getTestCaseRow(c.env.DB, tid)
  await sweepStaleSessions(c.env.DB)
  const { results } = await c.env.DB.prepare('SELECT * FROM assistant_sessions WHERE test_case_id = ? ORDER BY created_at, rowid').bind(tid).all<AssistantSessionRow>()
  return c.json(results.map(toSession))
})

assistant.get('/assistant/:sid', async (c) => {
  requireEnabled(c.env)
  await sweepStaleSessions(c.env.DB)
  return c.json(toSession(await getSessionRow(c.env.DB, c.req.param('sid'))))
})

assistant.post('/assistant/:sid/abort', async (c) => {
  requireEnabled(c.env)
  const id = c.req.param('sid')
  await getSessionRow(c.env.DB, id)
  const aborted = await c.env.DB.prepare("UPDATE assistant_sessions SET status = 'aborted', finished_at = ? WHERE id = ? AND status IN ('queued', 'running')").bind(now(), id).run()
  if (aborted.meta.changes > 0) await appendEvent(c.env.DB, id, { kind: 'error', text: 'Aborted. The steps built so far are kept.' })
  return c.json(toSession(await getSessionRow(c.env.DB, id)))
})
