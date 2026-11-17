// The real ModelClient: Claude through the official SDK.
import Anthropic from '@anthropic-ai/sdk'
import { errorMessage } from '../env'
import type { ModelClient } from './loop'
import { requestSettings, type AssistantModel, type Effort } from './models'
import { SYSTEM_PROMPT, TOOLS } from './prompt'

export function describeModelError(e: unknown, model = 'this model'): string {
  if (e instanceof Anthropic.AuthenticationError) return 'The model API rejected the API key. Check the ANTHROPIC_API_KEY secret of this deployment.'
  if (e instanceof Anthropic.PermissionDeniedError) return `The API key is not allowed to use ${model}.`
  if (e instanceof Anthropic.RateLimitError) return 'The model API is rate limited right now. Wait a minute and try again.'
  if (e instanceof Anthropic.BadRequestError) return `The model API rejected the request: ${e.message}`
  if (e instanceof Anthropic.APIUserAbortError) return 'The model did not answer in time. Try again.'
  if (e instanceof Anthropic.APIConnectionTimeoutError) return 'The model did not answer in time. Try again.'
  if (e instanceof Anthropic.APIConnectionError) return 'Could not reach the model API. Try again.'
  if (e instanceof Anthropic.APIError) return e.status && e.status >= 500 ? 'The model API is having trouble right now. Try again in a moment.' : `The model API returned an error: ${e.message}`
  return `Unexpected error while asking the model: ${errorMessage(e)}`
}

export function anthropicClient(apiKey: string, model: AssistantModel, effort?: Effort): ModelClient {
  const client = new Anthropic({ apiKey, maxRetries: 2 })
  const settings = requestSettings(model, effort)
  return {
    describeError: (e) => describeModelError(e, model),
    create: (messages, { timeoutMs }) =>
      client.beta.messages.create(
        {
          ...settings,
          // The marker on the system prompt caches tools + system (identical for every session of a model); the
          // top-level one moves with the growing conversation so each turn re-reads the previous one.
          system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
          cache_control: { type: 'ephemeral' },
          tools: TOOLS,
          messages,
        },
        // The SDK retries a failed attempt (rate limit, overload, a timeout) up to maxRetries times, each with the
        // full timeout again. The signal bounds the request as a whole, retries included: it is never retried.
        { timeout: timeoutMs, signal: AbortSignal.timeout(timeoutMs) },
      ),
  }
}
