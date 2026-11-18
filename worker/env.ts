import type { BrowserWorker } from '@cloudflare/playwright'
import type { ApiErrorCode } from '../shared/types'

export interface Env {
  DB: D1Database
  SHOTS: R2Bucket
  BROWSER: BrowserWorker
  RUN_QUEUE: Queue<QueueMessage>
  ASSETS: Fetcher
  /** Optional secret. When set, the API requires it (cookie or bearer token). */
  ACCESS_CODE?: string
  /** Optional comma-separated hostnames that captures and navigate steps may open. */
  ALLOWED_HOSTS?: string
  /** Optional secret. When set, the AI assistant is available (worker/assistant). */
  ANTHROPIC_API_KEY?: string
  /** Optional rate limiting binding. When present, wrong access codes are counted per client address (worker/auth.ts). */
  ACCESS_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> }
  /** Optional. Assistant sessions the whole deployment may start in 24 hours (default 100). */
  ASSISTANT_DAILY_SESSIONS?: string
  /** Optional. Estimated assistant spend in USD per 24 hours after which no new session starts (default 40). */
  ASSISTANT_DAILY_BUDGET_USD?: string
  /** Optional. The Claude model the assistant asks; one of worker/assistant/models.ts (default: its DEFAULT_MODEL). */
  ASSISTANT_MODEL?: string
  /**
   * Local development only (.dev.vars, never a deployed var): "1" lets a request from localhost choose the
   * model of one assistant session with a header, which is how scripts/bench-assistant.mjs compares models.
   */
  ASSISTANT_DEV_OVERRIDE?: string
}

/** `origin` is the app's own origin at enqueue time; it is always an allowed navigation target. */
export type QueueMessage =
  | { runId: string; origin: string }
  /** `resumed`: the rest of a batch that an earlier invocation handed on when its time was nearly up. */
  | { batchRunId: string; origin: string; resumed?: boolean }
  | { assistantSessionId: string; origin: string; override?: AssistantOverride }
  /** Screenshots of deleted projects, test cases and runs: objects by key, and everything under a prefix. */
  | { cleanup: { keys?: string[]; prefixes?: string[] } }

/** A model (and effort) for one assistant session instead of the deployment's; see ASSISTANT_DEV_OVERRIDE. */
export interface AssistantOverride {
  model?: string
  effort?: string
}

export class HttpError extends Error {
  readonly status: 400 | 401 | 404 | 409 | 429 | 502 | 503
  /** A machine-readable reason, for the errors the app reacts to (shared/types.ts: ApiErrorCode). */
  readonly code?: ApiErrorCode
  constructor(status: 400 | 401 | 404 | 409 | 429 | 502 | 503, message: string, code?: ApiErrorCode) {
    super(message)
    this.status = status
    if (code) this.code = code
  }
}

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e))
