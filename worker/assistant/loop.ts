// The assistant's agent loop: ask the model, run the tools it calls, feed the results back, repeat.
// It knows nothing about D1, browsers or the Anthropic client: those come in as ModelClient, ToolHost
// and SessionSink, which is what lets tests/assistant drive it with scripted model turns.
import type Anthropic from '@anthropic-ai/sdk'
import type { AssistantEvent, AssistantToolName, AssistantUsage } from '../../shared/types'
import { errorMessage } from '../env'
import { costOf, hasPrice, isSupportedModel, type Tokens } from './models'
import type { Verdict } from './review'

export type ModelMessage = Anthropic.Beta.BetaMessageParam
/** The parts of a model response the loop reads. */
export type ModelTurn = Pick<Anthropic.Beta.BetaMessage, 'content' | 'stop_reason' | 'usage' | 'model'> & Partial<Pick<Anthropic.Beta.BetaMessage, 'stop_details'>>

export interface ModelClient {
  /** One model request for the conversation so far. Throws on API errors. */
  create(messages: ModelMessage[], options: { timeoutMs: number }): Promise<ModelTurn>
  /** A sentence for the user about an error create() threw. */
  describeError(error: unknown): string
}

export type ToolResultContent = Anthropic.Beta.BetaToolResultBlockParam['content']

export interface ToolOutcome {
  /** What the model gets back. */
  content: ToolResultContent
  /** The call was rejected or could not be carried out; the model is told so and may try again. */
  isError?: boolean
  /** The transcript line for the user. */
  event: string
  detail?: string
  /** The call itself was fine but what it reports is a failure (a run with a failed step). */
  failed?: boolean
}

export interface ToolContext {
  /** When the session runs out of time (same clock as LoopOptions.now). A tool that can take long stops by then. */
  deadline: number
}

export interface ToolHost {
  call(name: string, input: unknown, context: ToolContext): Promise<ToolOutcome>
  /**
   * Called before the tool calls of one model reply are run. The model wrote them all at once, seeing the
   * same step numbering, and they are run one after another: the host uses this to notice a call whose step
   * number was shifted by an earlier call of the same reply.
   */
  beginTurn?(): void
  /**
   * Asked when the model sends a reply without tool calls, which would end the session: may it end here?
   * `closing` is the text of that reply. The host knows what was built and whether it was verified
   * (worker/assistant/review.ts); when it says no, the loop gives the model the reminder and goes on.
   */
  finish?(closing: string): Verdict | Promise<Verdict>
}

export interface SessionSink {
  /** Is the session still running? False once it was aborted (or failed from outside). */
  active(): Promise<boolean>
  event(event: Omit<AssistantEvent, 'at'>): Promise<void>
  usage(usage: AssistantUsage): Promise<void>
}

export interface LoopOptions {
  model: ModelClient
  host: ToolHost
  sink: SessionSink
  /** The first user message: the instruction with the test case as it is now. */
  task: string
  modelName: string
  /** Model requests allowed before the session is stopped. */
  maxTurns?: number
  /** Wall-clock budget for the whole session. */
  maxMs?: number
  /** Estimated spend after which the session is stopped. */
  maxCostUsd?: number
  now?: () => number
}

export type LoopResult = { status: 'done' } | { status: 'aborted' } | { status: 'failed'; error: string }

export const MAX_TURNS = 40
/** With this many model requests left, or this little time, the model is told to wrap up. */
export const WRAP_UP_TURNS = 5
export const WRAP_UP_MS = 2 * 60 * 1000
export const MAX_SESSION_MS = 12 * 60 * 1000
/** A session of 40 requests normally costs well under a dollar; this stops one whose context grew out of hand. */
export const MAX_SESSION_COST_USD = 5
const REQUEST_TIMEOUT_MS = 4 * 60 * 1000

/**
 * What one response used, per model that worked on it. With server-side fallbacks a response can be the work
 * of two models: the top-level usage then covers only the attempt that produced the message, while
 * `usage.iterations` has one entry per attempt, each with its own model (a declined attempt is billed too).
 */
export function usageParts(turn: ModelTurn, requested: string): ({ model: string } & Tokens)[] {
  const tokens = (u: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }): Tokens => ({
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  })
  const iterations = (turn.usage.iterations ?? []).filter((i) => i.type === 'message' || i.type === 'fallback_message')
  const last = iterations[iterations.length - 1]
  // The response's own `model` is the one that produced the message, so an entry without a model is only
  // given it when it is that last attempt.
  if (iterations.length > 0) return iterations.map((i) => ({ model: i.model ?? (i === last ? turn.model || requested : requested), ...tokens(i) }))
  return [{ model: turn.model || requested, ...tokens(turn.usage) }]
}

const KEPT = 'The steps built so far are kept.'

export async function runAssistant(o: LoopOptions): Promise<LoopResult> {
  const now = o.now ?? Date.now
  const maxTurns = o.maxTurns ?? MAX_TURNS
  const deadline = now() + (o.maxMs ?? MAX_SESSION_MS)
  const messages: ModelMessage[] = [{ role: 'user', content: o.task }]
  const usage: AssistantUsage = { model: o.modelName, turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 }

  const maxCostUsd = o.maxCostUsd ?? MAX_SESSION_COST_USD
  const outOfTime = `Stopped: the session ran into its ${Math.round((o.maxMs ?? MAX_SESSION_MS) / 60_000)} minute limit. ${KEPT}`

  // Said once, with the tool results, when the session is about to run into a limit: a test that is left
  // half built without a word is worse than a smaller one that was run and reported honestly.
  let warned = false
  const wrapUp = (): string | null => {
    const turnsLeft = maxTurns - usage.turns
    const msLeft = deadline - now()
    if (warned || (turnsLeft > WRAP_UP_TURNS && msLeft > WRAP_UP_MS)) return null
    warned = true
    const left = turnsLeft <= WRAP_UP_TURNS ? `${turnsLeft} more replies` : `about ${Math.max(1, Math.round(msLeft / 60_000))} more minute${Math.round(msLeft / 60_000) > 1 ? 's' : ''}`
    return `Stepwise (automatic notice, not the user): this session can take ${left} from you, then it is stopped. Wrap up now: stop adding to the test, get what is there to pass (run_steps without arguments, disable or remove a step you cannot fix), call review_request with what is not done marked not_done, and write your summary, saying plainly what is unfinished.`
  }

  const fail = async (error: string): Promise<LoopResult> => {
    await o.sink.event({ kind: 'error', text: error })
    return { status: 'failed', error }
  }

  for (;;) {
    if (!(await o.sink.active())) return { status: 'aborted' }
    if (usage.turns >= maxTurns) return fail(`Stopped after ${maxTurns} model turns without finishing. ${KEPT}`)
    if (usage.costUsd >= maxCostUsd) return fail(`Stopped: the session reached its cost limit (about $${maxCostUsd}). ${KEPT}`)
    const left = deadline - now()
    if (left <= 0) return fail(outOfTime)

    let turn: ModelTurn
    try {
      turn = await o.model.create(messages, { timeoutMs: Math.min(REQUEST_TIMEOUT_MS, left) })
    } catch (e) {
      // A request cut short because the session's time was up is the time limit, not a slow model:
      // "try again" would send the same long task into the same limit.
      return fail(now() >= deadline ? outOfTime : o.model.describeError(e))
    }

    usage.turns++
    for (const part of usageParts(turn, o.modelName)) {
      usage.inputTokens += part.inputTokens
      usage.outputTokens += part.outputTokens
      usage.cacheReadTokens += part.cacheReadTokens
      usage.cacheWriteTokens += part.cacheWriteTokens
      usage.costUsd += costOf(part.model, part, isSupportedModel(o.modelName) ? o.modelName : undefined)
      if (part.model !== o.modelName && !usage.otherModels?.includes(part.model)) usage.otherModels = [...(usage.otherModels ?? []), part.model]
      if (!hasPrice(part.model)) usage.costIncomplete = true
    }
    await o.sink.usage(usage)

    // A refusal can arrive with partial content, including a tool call that was cut off: read nothing from it.
    if (turn.stop_reason === 'refusal') {
      const category = turn.stop_details?.category
      return fail(`The model declined this request${category ? ` (safety category: ${category})` : ''}. Try rephrasing it. ${KEPT}`)
    }

    if (!(await o.sink.active())) return { status: 'aborted' }
    const calls = turn.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
    const said = turn.content.flatMap((b) => (b.type === 'text' && b.text.trim() ? [b.text.trim()] : []))
    const say = async (): Promise<void> => {
      for (const text of said) await o.sink.event({ kind: 'assistant', text })
    }
    // A reply without tool calls would end the session: whether it may is decided first, because a closing
    // summary that turns out to be premature ("the test passes") must not stand in the transcript.
    const closing = calls.length === 0 && turn.stop_reason !== 'max_tokens' && turn.stop_reason !== 'pause_turn'
    if (!closing) await say()

    // Truncated output: a tool call in it may be incomplete, so none of this turn's tools are run.
    if (turn.stop_reason === 'max_tokens') return fail(`The model's reply was cut off at the output limit. ${KEPT}`)

    // Appended exactly as received: thinking blocks and tool calls must come back unchanged.
    messages.push({ role: 'assistant', content: turn.content as Anthropic.Beta.BetaContentBlockParam[] })
    if (turn.stop_reason === 'pause_turn') continue

    if (closing) {
      const verdict: Verdict = (await o.host.finish?.(said.join('\n\n'))) ?? { ok: true }
      if (verdict.ok) {
        await say()
        return { status: 'done' }
      }
      if (verdict.final) {
        // What it wanted to end with is shown after all: it is the only account of the session there is.
        await say()
        return fail(`Stopped: the assistant did not finish the test. ${verdict.event}. Check the steps before relying on this test. ${KEPT}`)
      }
      await o.sink.event({ kind: 'tool', text: 'Not finished yet, the assistant goes on', detail: verdict.event })
      messages.push({ role: 'user', content: verdict.reminder })
      continue
    }

    // Every call gets a result, in one user message, even when the session is aborted half way.
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = []
    let aborted = false
    let timedOut = false
    o.host.beginTurn?.()
    for (const call of calls) {
      if (!aborted && !(await o.sink.active())) aborted = true
      // The time limit holds between tool calls too, not only between model requests.
      if (!aborted && !timedOut && now() >= deadline) timedOut = true
      if (aborted || timedOut) {
        results.push({ type: 'tool_result', tool_use_id: call.id, is_error: true, content: aborted ? 'Not run: the session was aborted.' : 'Not run: the session ran out of time.' })
        continue
      }
      let outcome: ToolOutcome
      try {
        outcome = await o.host.call(call.name, call.input, { deadline })
      } catch (e) {
        // A tool reports what went wrong instead of throwing; this is the net under an unexpected crash.
        const message = errorMessage(e).split('\n')[0]
        outcome = { content: `The tool failed unexpectedly: ${message}`, isError: true, event: `${call.name} failed`, detail: message }
      }
      results.push({ type: 'tool_result', tool_use_id: call.id, content: outcome.content, ...(outcome.isError ? { is_error: true } : {}) })
      await o.sink.event({
        kind: 'tool',
        text: outcome.event,
        tool: call.name as AssistantToolName,
        ...(outcome.detail ? { detail: outcome.detail } : {}),
        ...(outcome.isError || outcome.failed ? { failed: true } : {}),
      })
    }
    if (aborted) return { status: 'aborted' }
    if (timedOut) return fail(outOfTime)
    const notice = wrapUp()
    messages.push({ role: 'user', content: notice ? [...results, { type: 'text', text: notice }] : results })
  }
}
