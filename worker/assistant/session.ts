// Runs one assistant session in the queue consumer: wires the loop to D1, the browser and the model.
import type { AssistantEvent, AssistantUsage } from '../../shared/types'
import { now } from '../db'
import { errorMessage, type AssistantOverride, type Env } from '../env'
import { leaseBrowser } from '../runner'
import { anthropicClient } from './client'
import { runAssistant, type LoopResult, type ModelClient, type SessionSink } from './loop'
import { sessionModel } from './models'
import { firstMessage, type EarlierSession } from './prompt'
import { appendEvent } from './store'
import { assistantTools } from './tools'

const finish = async (env: Env, id: string, result: LoopResult): Promise<void> => {
  // An abort is recorded by the abort route; a status set from outside is never overwritten.
  if (result.status === 'aborted') return
  await env.DB.prepare("UPDATE assistant_sessions SET status = ?1, error = ?2, finished_at = ?3 WHERE id = ?4 AND status = 'running'")
    .bind(result.status, result.status === 'failed' ? result.error : null, now(), id)
    .run()
}

/** How many earlier sessions of the test case a new one is told about. */
const HISTORY_SESSIONS = 4

/**
 * What the sessions before this one on the same test case asked for and how they ended, oldest first. A
 * session is a fresh conversation, but the panel shows them as one chat: a follow-up ("no, check the user
 * name instead", "continue") only makes sense with what came before.
 */
export async function sessionHistory(db: D1Database, testCaseId: string, sessionId: string): Promise<EarlierSession[]> {
  const { results } = await db
    .prepare(
      `SELECT status, events, error FROM assistant_sessions
       WHERE test_case_id = ?1 AND id <> ?2 AND status IN ('done', 'failed', 'aborted')
         AND created_at <= (SELECT created_at FROM assistant_sessions WHERE id = ?2)
       ORDER BY created_at DESC, rowid DESC LIMIT ?3`,
    )
    .bind(testCaseId, sessionId, HISTORY_SESSIONS)
    .all<{ status: string; events: string; error: string | null }>()
  return results.reverse().flatMap((row) => {
    let events: AssistantEvent[] = []
    try {
      events = JSON.parse(row.events) as AssistantEvent[]
    } catch {
      /* an unreadable transcript is left out */
    }
    const request = events.find((e) => e.kind === 'user')?.text ?? ''
    if (!request) return []
    const said = events.findLast((e) => e.kind === 'assistant')?.text ?? ''
    const stopped = row.error ?? events.findLast((e) => e.kind === 'error')?.text ?? ''
    // A failed step of its last run is the most useful thing to know about a session that did not finish.
    const lastFailure = events.findLast((e) => e.kind === 'tool' && e.failed)
    const failure = row.status !== 'done' && lastFailure ? ` Last failure: ${lastFailure.text}${lastFailure.detail ? ` (${lastFailure.detail})` : ''}.` : ''
    const outcome = row.status === 'done' ? said : `${stopped}${failure}${said ? ` Before that it said: ${said}` : ''}`.trim()
    return [{ request, status: row.status, outcome }]
  })
}

/** `model` is injectable for tests; by default it is Claude with the deployment's API key. */
export async function processAssistantSession(env: Env, sessionId: string, appOrigin: string, model?: ModelClient, override?: AssistantOverride): Promise<void> {
  const claimed = await env.DB.prepare("UPDATE assistant_sessions SET status = 'running', started_at = ?1 WHERE id = ?2 AND status = 'queued' RETURNING test_case_id, events").bind(now(), sessionId).first<{ test_case_id: string; events: string }>()
  if (!claimed) return // aborted, deleted, or delivered twice

  const active = async (): Promise<boolean> => {
    const row = await env.DB.prepare('SELECT status FROM assistant_sessions WHERE id = ?').bind(sessionId).first<{ status: string }>()
    return row?.status === 'running'
  }
  const sink: SessionSink = {
    active,
    event: (event) => appendEvent(env.DB, sessionId, event, 'running'),
    usage: async (usage: AssistantUsage) => {
      await env.DB.batch([
        env.DB.prepare('UPDATE assistant_sessions SET usage = ? WHERE id = ?').bind(JSON.stringify(usage), sessionId),
        // The deployment's budget is counted here: this row stays when the test case and its sessions are deleted.
        env.DB.prepare('UPDATE assistant_usage SET cost_usd = ? WHERE session_id = ?').bind(usage.costUsd, sessionId),
      ])
    },
  }

  const browser = leaseBrowser(env)
  let result: LoopResult
  try {
    if (!model && !env.ANTHROPIC_API_KEY) throw new Error('The assistant is not configured on this deployment (ANTHROPIC_API_KEY is not set).')
    const instruction = (JSON.parse(claimed.events) as { kind: string; text: string }[]).find((e) => e.kind === 'user')?.text ?? ''
    const tools = assistantTools(env, { testCaseId: claimed.test_case_id, sessionId, request: instruction }, appOrigin, browser, active)
    const chosen = sessionModel(env, override)
    result = await runAssistant({
      model: model ?? anthropicClient(env.ANTHROPIC_API_KEY!, chosen.model, chosen.effort),
      host: tools,
      sink,
      task: firstMessage(await tools.context(), instruction, await sessionHistory(env.DB, claimed.test_case_id, sessionId)),
      modelName: chosen.model,
    })
  } catch (e) {
    console.error(`assistant session ${sessionId} crashed`, e)
    const error = `Unexpected error: ${errorMessage(e).split('\n')[0]}`
    await sink.event({ kind: 'error', text: error }).catch(() => {})
    result = { status: 'failed', error }
  } finally {
    await browser.close()
  }
  await finish(env, sessionId, result)
}
