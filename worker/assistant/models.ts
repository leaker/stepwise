// Which Claude model the assistant asks, how each one is asked, and what it costs. One table, so that a
// model's request settings and its price cannot drift apart. The default is chosen by measurement: see
// scripts/bench-assistant.mjs and the "AI assistant" section of the README.
import type Anthropic from '@anthropic-ai/sdk'

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** USD per million tokens. A cache write (5 minute TTL) is billed at 1.25x input. */
export interface Price {
  input: number
  output: number
  cacheRead: number
}

export interface ModelSpec {
  /** How much the model thinks and writes. Thinking is adaptive on all three (the parameter is left out). */
  effort: Effort
  /**
   * Re-run a request the model's safety classifiers decline on the model Anthropic recommends for that
   * category (`fallbacks: "default"`), instead of failing the session. Haiku 5.5 has no server-side fallback.
   */
  fallbacks: boolean
  price: Price
  /** A second rate card for a request whose prompt is longer than `above` tokens (Haiku 5.5). */
  longPrompt?: { above: number; price: Price }
}

export const MODELS = {
  'claude-haiku-5-5': {
    effort: 'medium',
    fallbacks: false,
    price: { input: 0.1, output: 0.5, cacheRead: 0.01 },
    longPrompt: { above: 100_000, price: { input: 0.5, output: 2.5, cacheRead: 0.05 } },
  },
  'claude-sonnet-5-5': { effort: 'medium', fallbacks: true, price: { input: 2, output: 10, cacheRead: 0.1 } },
  'claude-opus-5-5': { effort: 'medium', fallbacks: true, price: { input: 4, output: 20, cacheRead: 0.2 } },
} as const satisfies Record<string, ModelSpec>

export type AssistantModel = keyof typeof MODELS
export const SUPPORTED_MODELS = Object.keys(MODELS) as AssistantModel[]
export const DEFAULT_MODEL: AssistantModel = 'claude-haiku-5-5'

export const isSupportedModel = (name: string): name is AssistantModel => Object.hasOwn(MODELS, name)

/**
 * The model of this deployment: the ASSISTANT_MODEL var when it names a supported model, the default
 * otherwise. A value that is not supported is never sent to the API (the price of an unknown model is
 * unknown too, and the session budget depends on it); `invalid` carries it so the caller can say so.
 */
export function resolveModel(configured: string | undefined): { model: AssistantModel; invalid?: string } {
  const name = (configured ?? '').trim()
  if (name === '') return { model: DEFAULT_MODEL }
  return isSupportedModel(name) ? { model: name } : { model: DEFAULT_MODEL, invalid: name }
}

/** Models a declined request can be re-run on (`fallbacks: "default"`); each bills at its own rate. */
const FALLBACK_PRICES: Record<string, Price> = {
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
}

export interface Tokens {
  /** Tokens that were not read from the prompt cache and not written to it. */
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export const hasPrice = (model: string): boolean => isSupportedModel(model) || Object.hasOwn(FALLBACK_PRICES, model)

/** The rate card for one request: it depends on the model and, on Haiku 5.5, on the length of the prompt. */
export function priceOf(model: string, u: Tokens): Price | undefined {
  if (!isSupportedModel(model)) return FALLBACK_PRICES[model]
  const spec: ModelSpec = MODELS[model]
  const prompt = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens
  return spec.longPrompt && prompt > spec.longPrompt.above ? spec.longPrompt.price : spec.price
}

/**
 * What one request cost. `u` must be the usage of a single request (the rate card is chosen per request).
 * A model without a known price is charged like `assumed`, the session's own model; the caller marks the
 * estimate incomplete.
 */
export function costOf(model: string, u: Tokens, assumed: AssistantModel = DEFAULT_MODEL): number {
  const p = priceOf(model, u) ?? priceOf(assumed, u)!
  return (u.inputTokens * p.input + u.cacheWriteTokens * p.input * 1.25 + u.cacheReadTokens * p.cacheRead + u.outputTokens * p.output) / 1_000_000
}

type CreateParams = Anthropic.Beta.MessageCreateParamsNonStreaming

/** The model-specific part of a request. `effort` overrides the table (the benchmark's effort sweep). */
export function requestSettings(model: AssistantModel, effort?: Effort): Pick<CreateParams, 'model' | 'max_tokens' | 'output_config' | 'betas' | 'fallbacks'> {
  const spec: ModelSpec = MODELS[model]
  return {
    model,
    // Room for thinking plus the reply; it is a ceiling, not a cost. A reply that hits it fails the session.
    max_tokens: 16000,
    // Set explicitly: the default differs per model (medium on Haiku 5.5 and Opus 5.5, high on Sonnet 5.5).
    output_config: { effort: effort ?? spec.effort },
    ...(spec.fallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
  }
}

// ---- per-session override (local development only) ----

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * May this request pick the model of its session? Only when the Worker was started with
 * ASSISTANT_DEV_OVERRIDE=1 (a .dev.vars entry) AND the request was addressed to a loopback host. A deployed
 * Worker is never addressed as localhost, so setting the var there by mistake still opens nothing.
 */
export const overrideAllowed = (env: { ASSISTANT_DEV_OVERRIDE?: string }, requestUrl: string): boolean =>
  env.ASSISTANT_DEV_OVERRIDE === '1' && LOCAL_HOSTS.has(new URL(requestUrl).hostname)

/** The model and effort of one session: the deployment's, unless an allowed override names valid ones. */
export function sessionModel(env: { ASSISTANT_MODEL?: string; ASSISTANT_DEV_OVERRIDE?: string }, override?: { model?: string; effort?: string }): { model: AssistantModel; effort?: Effort } {
  const { model } = resolveModel(env.ASSISTANT_MODEL)
  if (env.ASSISTANT_DEV_OVERRIDE !== '1' || !override) return { model }
  const effort = EFFORTS.find((e) => e === override.effort)
  return { model: override.model && isSupportedModel(override.model) ? override.model : model, ...(effort ? { effort } : {}) }
}
