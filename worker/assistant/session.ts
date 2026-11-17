// Runs one assistant session in the queue consumer: wires the loop to D1, the browser and the model.
import type { AssistantUsage } from '../../shared/types'
import { now } from '../db'
import { errorMessage, type Env } from '../env'
import { leaseBrowser } from '../runner'
import { anthropicClient } from './client'
import { runAssistant, type LoopResult, type ModelClient, type SessionSink } from './loop'
import { ASSISTANT_MODEL, firstMessage } from './prompt'
import { appendEvent } from './store'
import { assistantTools } from './tools'

const finish = async (env: Env, id: string, result: LoopResult): Promise<void> => {
  // An abort is recorded by the abort route; a status set from outside is never overwritten.
  if (result.status === 'aborted') return
  await env.DB.prepare("UPDATE assistant_sessions SET status = ?1, error = ?2, finished_at = ?3 WHERE id = ?4 AND status = 'running'")
    .bind(result.status, result.status === 'failed' ? result.error : null, now(), id)
    .run()
}

/** `model` is injectable for tests; by default it is Claude with the deployment's API key. */
export async function processAssistantSession(env: Env, sessionId: string, appOrigin: string, model?: ModelClient): Promise<void> {
  const claimed = await env.DB.prepare("UPDATE assistant_sessions SET status = 'running' WHERE id = ? AND status = 'queued' RETURNING test_case_id, events").bind(sessionId).first<{ test_case_id: string; events: string }>()
  if (!claimed) return // aborted, deleted, or delivered twice

  const active = async (): Promise<boolean> => {
    const row = await env.DB.prepare('SELECT status FROM assistant_sessions WHERE id = ?').bind(sessionId).first<{ status: string }>()
    return row?.status === 'running'
  }
  const sink: SessionSink = {
    active,
    event: (event) => appendEvent(env.DB, sessionId, event, 'running'),
    usage: async (usage: AssistantUsage) => {
      await env.DB.prepare('UPDATE assistant_sessions SET usage = ? WHERE id = ?').bind(JSON.stringify(usage), sessionId).run()
    },
  }

  const browser = leaseBrowser(env)
  let result: LoopResult
  try {
    if (!model && !env.ANTHROPIC_API_KEY) throw new Error('The assistant is not configured on this deployment (ANTHROPIC_API_KEY is not set).')
    const instruction = (JSON.parse(claimed.events) as { kind: string; text: string }[]).find((e) => e.kind === 'user')?.text ?? ''
    const tools = assistantTools(env, claimed.test_case_id, appOrigin, browser, active)
    result = await runAssistant({
      model: model ?? anthropicClient(env.ANTHROPIC_API_KEY!),
      host: tools,
      sink,
      task: firstMessage(await tools.context(), instruction),
      modelName: ASSISTANT_MODEL,
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
