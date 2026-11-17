import type { BrowserWorker } from '@cloudflare/playwright'

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
export type QueueMessage = { runId: string; origin: string } | { batchRunId: string; origin: string } | { assistantSessionId: string; origin: string; override?: AssistantOverride }

/** A model (and effort) for one assistant session instead of the deployment's; see ASSISTANT_DEV_OVERRIDE. */
export interface AssistantOverride {
  model?: string
  effort?: string
}

export class HttpError extends Error {
  readonly status: 400 | 401 | 404 | 409 | 429 | 502 | 503
  constructor(status: 400 | 401 | 404 | 409 | 429 | 502 | 503, message: string) {
    super(message)
    this.status = status
  }
}

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e))
