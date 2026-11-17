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
const STALE_NOTE = 'The session stopped responding and was closed. The steps built so far are kept.'

/**
 * A session must never stay queued or running forever (a consumer can die without a trace), because it
 * locks the editor's step list. The loop stops itself after 12 minutes; this closes what is left after 15.
 */
export async function sweepStaleSessions(db: D1Database): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_MS).toISOString()
  const event: AssistantEvent = { kind: 'error', text: STALE_NOTE, at: now() }
  await db
    .prepare("UPDATE assistant_sessions SET status = 'failed', error = ?1, finished_at = ?2, events = json_insert(events, '$[#]', json(?3)) WHERE status IN ('queued', 'running') AND created_at < ?4")
    .bind(STALE_NOTE, event.at, JSON.stringify(event), cutoff)
    .run()
}
