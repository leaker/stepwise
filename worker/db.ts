// D1 access helpers: row <-> shared type mapping and the queries used by more than one route.
import { DEVICES, deviceOf } from '../shared/devices'
import { settledPatterns } from '../shared/data'
import { stepsRevision } from '../shared/revision'
import type { BatchRun, DataTable, Project, Run, RunPattern, RunStatus, Step, StepResult, TestCase, Ui, UiElement } from '../shared/types'
import { HttpError, type QueueMessage } from './env'

export const now = (): string => new Date().toISOString()
export const newId = (): string => crypto.randomUUID().replace(/-/g, '').slice(0, 16)

function parseJson<T>(text: unknown, fallback: T): T {
  if (typeof text !== 'string' || text === '') return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

// ---- rows ----

export interface ProjectRow {
  id: string
  name: string
  description: string
  base_url: string
  variables: string
  next_case_number: number
  next_batch_number: number
  next_shared_number: number
  created_at: string
  test_case_count?: number
  batch_run_count?: number
}

export interface TestCaseRow {
  id: string
  project_id: string
  /** Negative for a shared step: S1 is stored as -1 (see migrations/0006). */
  number: number
  name: string
  description: string
  device: string
  steps: string
  /** 'test' | 'shared' */
  kind: string
  /** JSON DataTable, or '' */
  data: string
  created_at: string
  updated_at: string
}

export interface UiRow {
  id: string
  test_case_id: string
  name: string
  url: string
  title: string
  width: number
  height: number
  screenshot_key: string
  device: string
  elements: string
  created_at: string
}

export interface RunRow {
  id: string
  project_id: string
  test_case_id: string
  /** Negative when the run is of a shared step, as in test_cases.number. */
  test_case_number: number
  test_case_name: string
  /** Only when read by getRunRow: 0 once the test case was deleted. */
  case_exists?: number
  batch_run_id: string | null
  run_order: number
  status: string
  steps?: string
  results: string
  log?: string
  environment: string
  range: string | null
  patterns?: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
}

export interface BatchRunRow {
  id: string
  project_id: string
  number: number
  status: string
  trigger: string
  created_at: string
  started_at: string | null
  finished_at: string | null
}

// ---- mappers ----

/**
 * A base URL on the deployment's own origin is stored as a path ("/demo") and resolved against the
 * current origin when it is read, so such a project follows the app to another port or domain.
 */
export const storedBaseUrl = (baseUrl: string, origin: string): string => (baseUrl === origin ? '/' : baseUrl.startsWith(`${origin}/`) ? baseUrl.slice(origin.length) : baseUrl)
export const resolveBaseUrl = (stored: string, origin: string): string => (stored.startsWith('/') ? (origin + stored).replace(/\/+$/, '') : stored)

export function toProject(r: ProjectRow, origin: string): Project {
  const p: Project = {
    id: r.id,
    name: r.name,
    description: r.description,
    baseUrl: resolveBaseUrl(r.base_url, origin),
    variables: parseJson<Record<string, string>>(r.variables, {}),
    createdAt: r.created_at,
  }
  if (r.test_case_count !== undefined) p.testCaseCount = r.test_case_count
  if (r.batch_run_count !== undefined) p.batchRunCount = r.batch_run_count
  return p
}

export const isSharedRow = (r: Pick<TestCaseRow, 'kind'>): boolean => r.kind === 'shared'

/** `#3` for a test case, `S3` for a shared step. */
export const rowLabel = (r: Pick<TestCaseRow, 'kind' | 'number'>): string => `${isSharedRow(r) ? 'S' : '#'}${Math.abs(r.number)}`

export function toTestCase(r: TestCaseRow, lastRun: TestCase['lastRun'] = null): TestCase {
  return {
    id: r.id,
    projectId: r.project_id,
    kind: isSharedRow(r) ? 'shared' : 'test',
    number: Math.abs(r.number),
    name: r.name,
    description: r.description,
    device: deviceOf(r.device).id,
    steps: parseJson<Step[]>(r.steps, []),
    stepsRev: stepsRevision(r.steps),
    data: parseJson<DataTable | null>(r.data, null),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastRun,
  }
}

export function toUi(r: UiRow): Ui {
  return {
    id: r.id,
    testCaseId: r.test_case_id,
    name: r.name,
    url: r.url,
    title: r.title,
    width: r.width,
    height: r.height,
    screenshotKey: r.screenshot_key,
    device: deviceOf(r.device).id,
    elements: parseJson<UiElement[]>(r.elements, []),
    createdAt: r.created_at,
  }
}

const DEFAULT_ENVIRONMENT: Run['environment'] = { browser: 'chrome', device: 'desktop', viewport: { ...DEVICES.desktop.viewport }, baseUrl: '' }

/** What a run records about where it runs. */
export function environmentOf(baseUrl: string, device: unknown): Run['environment'] {
  const profile = deviceOf(device)
  return { browser: 'chrome', device: profile.id, viewport: { ...profile.viewport }, baseUrl }
}

/** Runs queued before device profiles existed have no `device`: they were desktop runs. */
function toEnvironment(text: string): Run['environment'] {
  const stored = parseJson<Partial<Run['environment']>>(text, {})
  return { ...DEFAULT_ENVIRONMENT, ...stored, device: deviceOf(stored.device).id }
}

export function toRunSummary(r: RunRow): Omit<Run, 'steps' | 'log'> {
  return {
    id: r.id,
    projectId: r.project_id,
    testCaseId: r.test_case_id,
    kind: r.test_case_number < 0 ? 'shared' : 'test',
    testCaseNumber: Math.abs(r.test_case_number),
    testCaseName: r.test_case_name,
    batchRunId: r.batch_run_id,
    order: r.run_order,
    status: r.status as RunStatus,
    results: parseJson<StepResult[]>(r.results, []),
    environment: toEnvironment(r.environment),
    range: parseJson<Run['range']>(r.range, null),
    patterns: settledPatterns(r.status as RunStatus, parseJson<RunPattern[] | null>(r.patterns, null)),
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  }
}

export function toRun(r: RunRow): Run {
  return { ...toRunSummary(r), ...(r.case_exists === 0 ? { testCaseDeleted: true } : {}), steps: parseJson<Step[]>(r.steps, []), log: r.log ?? '' }
}

export function toBatchRun(r: BatchRunRow, statuses: string[]): BatchRun {
  const count = (s: RunStatus) => statuses.filter((x) => x === s).length
  return {
    id: r.id,
    projectId: r.project_id,
    number: r.number,
    status: r.status as RunStatus,
    trigger: r.trigger === 'api' ? 'api' : 'manual',
    counts: {
      total: statuses.length,
      succeeded: count('succeeded'),
      failed: count('failed'),
      unresolved: count('unresolved'),
      aborted: count('aborted'),
    },
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  }
}

/** Columns of `runs` without the two big ones. */
export const RUN_SUMMARY_COLUMNS =
  'id, project_id, test_case_id, test_case_number, test_case_name, batch_run_id, run_order, status, results, environment, range, patterns, created_at, started_at, finished_at'

// ---- lookups ----

export async function getProjectRow(db: D1Database, id: string): Promise<ProjectRow> {
  const row = await db.prepare('SELECT * FROM projects WHERE id = ?').bind(id).first<ProjectRow>()
  if (!row) throw new HttpError(404, 'Project not found')
  return row
}

export async function getTestCaseRow(db: D1Database, id: string): Promise<TestCaseRow> {
  const row = await db.prepare('SELECT * FROM test_cases WHERE id = ?').bind(id).first<TestCaseRow>()
  if (!row) throw new HttpError(404, 'Test case not found')
  return row
}

export async function getRunRow(db: D1Database, id: string): Promise<RunRow> {
  const row = await db.prepare('SELECT r.*, EXISTS (SELECT 1 FROM test_cases t WHERE t.id = r.test_case_id) AS case_exists FROM runs r WHERE r.id = ?').bind(id).first<RunRow>()
  if (!row) throw new HttpError(404, 'Run not found')
  return row
}

export async function getBatchRunRow(db: D1Database, id: string): Promise<BatchRunRow> {
  const row = await db.prepare('SELECT * FROM batch_runs WHERE id = ?').bind(id).first<BatchRunRow>()
  if (!row) throw new HttpError(404, 'Batch run not found')
  return row
}

// ---- run status bookkeeping ----

export const isUnfinished = (status: string): boolean => status === 'queued' || status === 'running'

/** Batch status from its runs: failed > unresolved > aborted > succeeded once everything has finished. */
export function batchStatusOf(statuses: string[]): RunStatus {
  if (statuses.some(isUnfinished)) return statuses.every((s) => s === 'queued') ? 'queued' : 'running'
  if (statuses.includes('failed')) return 'failed'
  if (statuses.includes('unresolved')) return 'unresolved'
  if (statuses.includes('aborted')) return 'aborted'
  return 'succeeded'
}

/** Recompute a batch run's status from its runs and stamp started_at / finished_at as needed. */
export async function refreshBatchRun(db: D1Database, batchRunId: string): Promise<void> {
  const { results } = await db.prepare('SELECT status FROM runs WHERE batch_run_id = ?').bind(batchRunId).all<{ status: string }>()
  const status = batchStatusOf(results.map((r) => r.status))
  const ts = now()
  if (isUnfinished(status)) {
    await db
      .prepare("UPDATE batch_runs SET status = ?1, started_at = CASE WHEN ?1 = 'running' THEN COALESCE(started_at, ?2) ELSE started_at END, finished_at = NULL WHERE id = ?3")
      .bind(status, ts, batchRunId)
      .run()
  } else {
    await db.prepare('UPDATE batch_runs SET status = ?1, finished_at = COALESCE(finished_at, ?2) WHERE id = ?3').bind(status, ts, batchRunId).run()
  }
}

const STALE_MS = 15 * 60 * 1000

/**
 * Runs must never stay queued/running forever (a consumer can die without a trace). Called by the read
 * routes. A run gets 15 minutes from the moment it starts (a queue consumer invocation does not live
 * longer than that either); a queued run gets 15 minutes to be picked up. After that it becomes failed.
 * A run that is still waiting its turn inside a batch that is making progress is left alone.
 */
export async function sweepStaleRuns(db: D1Database): Promise<void> {
  const ts = now()
  const cutoff = new Date(Date.now() - STALE_MS).toISOString()
  const { results } = await db
    .prepare(
      `UPDATE runs SET status = 'failed', finished_at = ?1,
         log = log || CASE WHEN log = '' THEN '' ELSE char(10) END || CASE WHEN status = 'running' THEN 'Run timed out: it did not finish within the 15 minute limit; marked as failed.' ELSE 'Run timed out: it was not started within 15 minutes; marked as failed.' END
       WHERE status IN ('queued', 'running') AND COALESCE(started_at, created_at) < ?2
         AND (batch_run_id IS NULL OR status = 'running' OR NOT EXISTS (
           SELECT 1 FROM runs r2 WHERE r2.batch_run_id = runs.batch_run_id AND r2.id <> runs.id
             AND ((r2.status = 'running' AND r2.started_at >= ?2) OR r2.finished_at >= ?2)))
       RETURNING batch_run_id`,
    )
    .bind(ts, cutoff)
    .all<{ batch_run_id: string | null }>()
  const batchIds = new Set(results.map((r) => r.batch_run_id).filter((id): id is string => id !== null))
  for (const id of batchIds) await refreshBatchRun(db, id)
}

/** Newest run (single or batch) per test case, for TestCase.lastRun. */
export async function lastRunsFor(db: D1Database, where: { projectId: string } | { testCaseId: string }): Promise<Map<string, NonNullable<TestCase['lastRun']>>> {
  const filter = 'projectId' in where ? 'r.project_id = ?' : 'r.test_case_id = ?'
  const { results } = await db
    .prepare(
      `SELECT r.test_case_id, r.id, r.status, r.finished_at FROM runs r
       WHERE ${filter} AND r.id = (SELECT r2.id FROM runs r2 WHERE r2.test_case_id = r.test_case_id ORDER BY r2.created_at DESC, r2.rowid DESC LIMIT 1)`,
    )
    .bind('projectId' in where ? where.projectId : where.testCaseId)
    .all<{ test_case_id: string; id: string; status: string; finished_at: string | null }>()
  return new Map(results.map((r) => [r.test_case_id, { id: r.id, status: r.status as RunStatus, finishedAt: r.finished_at }]))
}

// ---- R2 cleanup ----

const R2_DELETE_MAX = 1000
/** Prefixes (runs) worked on at the same time: far fewer round trips in a row than one after the other. */
const PREFIXES_AT_ONCE = 10

export interface ShotWork {
  keys: string[]
  prefixes: string[]
}

/**
 * Delete objects by key and everything under the prefixes. Best-effort: it never throws, one prefix that
 * fails does not stop the others, and what could not be deleted is returned so the caller can try again.
 */
export async function deleteShots(bucket: R2Bucket, keys: string[], prefixes: string[] = []): Promise<ShotWork> {
  const left: ShotWork = { keys: [], prefixes: [] }
  for (let i = 0; i < keys.length; i += R2_DELETE_MAX) {
    const chunk = keys.slice(i, i + R2_DELETE_MAX)
    try {
      await bucket.delete(chunk)
    } catch (e) {
      console.error('screenshot cleanup failed', e)
      left.keys.push(...chunk)
    }
  }
  const one = async (prefix: string): Promise<void> => {
    try {
      let cursor: string | undefined
      do {
        const page = await bucket.list({ prefix, cursor })
        if (page.objects.length) await bucket.delete(page.objects.map((o) => o.key))
        cursor = page.truncated ? page.cursor : undefined
      } while (cursor)
    } catch (e) {
      console.error(`screenshot cleanup failed for ${prefix}`, e)
      left.prefixes.push(prefix)
    }
  }
  for (let i = 0; i < prefixes.length; i += PREFIXES_AT_ONCE) await Promise.all(prefixes.slice(i, i + PREFIXES_AT_ONCE).map(one))
  return left
}

/** What one request deletes itself after responding; more than this goes to the queue, where it can take its time and be retried. */
const INLINE_PREFIXES = 20
const PREFIXES_PER_MESSAGE = 100
const KEYS_PER_MESSAGE = 500

/**
 * Remove the screenshots of something that was just deleted from the database. Nothing points at these
 * objects any more, so whatever is not deleted now would stay for good: a small job is done right after
 * the response and what it could not delete is queued; a large one (a project with hundreds of runs) is
 * queued in pieces from the start, because a request's time after the response is short.
 */
export async function removeShots(env: { SHOTS: R2Bucket; RUN_QUEUE: Queue<QueueMessage> }, keys: string[], prefixes: string[] = []): Promise<void> {
  const enqueue = async (work: ShotWork): Promise<void> => {
    const messages: QueueMessage[] = []
    for (let i = 0; i < work.keys.length; i += KEYS_PER_MESSAGE) messages.push({ cleanup: { keys: work.keys.slice(i, i + KEYS_PER_MESSAGE) } })
    for (let i = 0; i < work.prefixes.length; i += PREFIXES_PER_MESSAGE) messages.push({ cleanup: { prefixes: work.prefixes.slice(i, i + PREFIXES_PER_MESSAGE) } })
    for (const body of messages) await env.RUN_QUEUE.send(body)
  }
  try {
    if (prefixes.length > INLINE_PREFIXES) {
      await enqueue({ keys, prefixes })
      return
    }
    const left = await deleteShots(env.SHOTS, keys, prefixes)
    if (left.keys.length || left.prefixes.length) await enqueue(left)
  } catch (e) {
    // The queue did not take it: do what can be done here.
    console.error('screenshot cleanup could not be queued', e)
    await deleteShots(env.SHOTS, keys, prefixes)
  }
}
