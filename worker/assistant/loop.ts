// The assistant's agent loop: ask the model, run the tools it calls, feed the results back, repeat.
// It knows nothing about D1, browsers or the Anthropic client: those come in as ModelClient, ToolHost
// and SessionSink, which is what lets tests/assistant drive it with scripted model turns.
import type Anthropic from '@anthropic-ai/sdk'
import type { AssistantEvent, AssistantToolName, AssistantUsage } from '../../shared/types'
import { errorMessage } from '../env'

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

export const MAX_TURNS = 30
export const MAX_SESSION_MS = 12 * 60 * 1000
/** A session of 30 requests normally costs well under a dollar; this stops one whose context grew out of hand. */
export const MAX_SESSION_COST_USD = 5
const REQUEST_TIMEOUT_MS = 4 * 60 * 1000

/**
 * USD per million tokens (list prices, platform.claude.com/docs/en/about-claude/pricing). Cache writes are
 * billed at 1.25x input (5 minute TTL). Besides the assistant's own model this lists the models a declined
 * request can be re-run on (`fallbacks: "default"`), which bill at their own rates.
 */
const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
}
const DEFAULT_PRICE = PRICES['claude-opus-5-5']

export const hasPrice = (model: string): boolean => Object.hasOwn(PRICES, model)

type Tokens = Pick<AssistantUsage, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>

/** A model without a known price is charged like the assistant's own model; the caller marks the estimate incomplete. */
export function costOf(model: string, u: Tokens): number {
  const p = hasPrice(model) ? PRICES[model] : DEFAULT_PRICE
  return (u.inputTokens * p.input + u.cacheWriteTokens * p.input * 1.25 + u.cacheReadTokens * p.cacheRead + u.outputTokens * p.output) / 1_000_000
}

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
      return fail(o.model.describeError(e))
    }

    usage.turns++
    for (const part of usageParts(turn, o.modelName)) {
      usage.inputTokens += part.inputTokens
      usage.outputTokens += part.outputTokens
      usage.cacheReadTokens += part.cacheReadTokens
      usage.cacheWriteTokens += part.cacheWriteTokens
      usage.costUsd += costOf(part.model, part)
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
    for (const block of turn.content) {
      if (block.type === 'text' && block.text.trim()) await o.sink.event({ kind: 'assistant', text: block.text.trim() })
    }

    // Truncated output: a tool call in it may be incomplete, so none of this turn's tools are run.
    if (turn.stop_reason === 'max_tokens') return fail(`The model's reply was cut off at the output limit. ${KEPT}`)

    // Appended exactly as received: thinking blocks and tool calls must come back unchanged.
    messages.push({ role: 'assistant', content: turn.content as Anthropic.Beta.BetaContentBlockParam[] })
    if (turn.stop_reason === 'pause_turn') continue

    const calls = turn.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
    if (calls.length === 0) return { status: 'done' }

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
    messages.push({ role: 'user', content: results })
  }
}
