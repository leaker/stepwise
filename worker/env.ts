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
}

/** `origin` is the app's own origin at enqueue time; it is always an allowed navigation target. */
export type QueueMessage = { runId: string; origin: string } | { batchRunId: string; origin: string }

export const VIEWPORT = { width: 1280, height: 800 } as const

export class HttpError extends Error {
  readonly status: 400 | 401 | 404 | 409 | 502 | 503
  constructor(status: 400 | 401 | 404 | 409 | 502 | 503, message: string) {
    super(message)
    this.status = status
  }
}

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e))
