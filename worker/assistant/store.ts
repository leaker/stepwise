// D1 access for assistant sessions.
import type { AssistantEvent, AssistantSession, AssistantSessionStatus, AssistantUsage } from '../../shared/types'
import { now } from '../db'
import { HttpError } from '../env'

export interface AssistantSessionRow {
  id: string
  test_case_id: string
  status: string
  events: string
  usage: string | null
  error: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
}

function parse<T>(text: string | null, fallback: T): T {
  if (!text) return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

export function toSession(r: AssistantSessionRow): AssistantSession {
  return {
    id: r.id,
    testCaseId: r.test_case_id,
    status: r.status as AssistantSessionStatus,
    events: parse<AssistantEvent[]>(r.events, []),
    usage: parse<AssistantUsage | null>(r.usage, null),
    error: r.error,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
  }
}

export async function getSessionRow(db: D1Database, id: string): Promise<AssistantSessionRow> {
  const row = await db.prepare('SELECT * FROM assistant_sessions WHERE id = ?').bind(id).first<AssistantSessionRow>()
  if (!row) throw new HttpError(404, 'Assistant session not found')
  return row
}

/** Appended in the database (not read-modify-write), so the consumer and the abort route never lose each other's event. */
export async function appendEvent(db: D1Database, id: string, event: Omit<AssistantEvent, 'at'>, onlyWhile?: AssistantSessionStatus): Promise<void> {
  const full: AssistantEvent = { ...event, at: now() }
  await db
    .prepare(`UPDATE assistant_sessions SET events = json_insert(events, '$[#]', json(?1)) WHERE id = ?2${onlyWhile ? ' AND status = ?3' : ''}`)
    .bind(...[JSON.stringify(full), id, ...(onlyWhile ? [onlyWhile] : [])])
    .run()
}

const STALE_MS = 15 * 60 * 1000
const STALE_RUNNING = 'The session stopped responding and was closed. The steps built so far are kept.'
const STALE_QUEUED = 'The session was not started within 15 minutes and was closed. Try again.'

/**
 * A session must never stay queued or running forever (a consumer can die without a trace), because it
 * locks the editor's step list. The loop stops itself 12 minutes after it started; this closes what is
 * still running 15 minutes after it started, and what was never picked up 15 minutes after it was queued
 * (the same rule runs follow, see sweepStaleRuns). Time spent waiting in the queue does not count against
 * a session that is working.
 */
export async function sweepStaleSessions(db: D1Database, nowMs = Date.now()): Promise<void> {
  const cutoff = new Date(nowMs - STALE_MS).toISOString()
  const at = new Date(nowMs).toISOString()
  const event = (text: string): string => JSON.stringify({ kind: 'error', text, at } satisfies AssistantEvent)
  await db
    .prepare(
      `UPDATE assistant_sessions SET status = 'failed', finished_at = ?1,
         error = CASE WHEN status = 'running' THEN ?2 ELSE ?3 END,
         events = json_insert(events, '$[#]', json(CASE WHEN status = 'running' THEN ?4 ELSE ?5 END))
       WHERE status IN ('queued', 'running') AND COALESCE(started_at, created_at) < ?6`,
    )
    .bind(at, STALE_RUNNING, STALE_QUEUED, event(STALE_RUNNING), event(STALE_QUEUED), cutoff)
    .run()
}

// ---- deployment-wide budget ----

export const DEFAULT_DAILY_SESSIONS = 100
export const DEFAULT_DAILY_BUDGET_USD = 40
export const DAY_MS = 24 * 60 * 60 * 1000

const limitOf = (text: string | undefined, fallback: number): number => {
  const n = Number((text ?? '').trim() || NaN)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/** The deployment's limits on assistant use per 24 hours. Every session costs money on the operator's account. */
export function dailyLimits(env: { ASSISTANT_DAILY_SESSIONS?: string; ASSISTANT_DAILY_BUDGET_USD?: string }): { sessions: number; budgetUsd: number } {
  return { sessions: limitOf(env.ASSISTANT_DAILY_SESSIONS, DEFAULT_DAILY_SESSIONS), budgetUsd: limitOf(env.ASSISTANT_DAILY_BUDGET_USD, DEFAULT_DAILY_BUDGET_USD) }
}

/**
 * Sessions started and the estimated spend in the 24 hours before `nowMs`, over all test cases. Counted in
 * assistant_usage, which has one row per session that is not deleted with the session: deleting a test
 * case (and with it its sessions) does not give the budget back.
 */
export async function dailyUse(db: D1Database, nowMs = Date.now()): Promise<{ sessions: number; costUsd: number }> {
  const row = await db
    .prepare('SELECT COUNT(*) AS sessions, COALESCE(SUM(cost_usd), 0) AS cost FROM assistant_usage WHERE created_at >= ?')
    .bind(new Date(nowMs - DAY_MS).toISOString())
    .first<{ sessions: number; cost: number }>()
  return { sessions: row?.sessions ?? 0, costUsd: row?.cost ?? 0 }
}
