// D1 access helpers: row <-> shared type mapping and the queries used by more than one route.
import type { BatchRun, Project, Run, RunStatus, Step, StepResult, TestCase, Ui, UiElement } from '../shared/types'
import { HttpError } from './env'

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
  created_at: string
  test_case_count?: number
  batch_run_count?: number
}

export interface TestCaseRow {
  id: string
  project_id: string
  number: number
  name: string
  description: string
  steps: string
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
  elements: string
  created_at: string
}

export interface RunRow {
  id: string
  project_id: string
  test_case_id: string
  test_case_number: number
  test_case_name: string
  batch_run_id: string | null
  run_order: number
  status: string
  steps?: string
  results: string
  log?: string
  environment: string
  range: string | null
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

export function toTestCase(r: TestCaseRow, lastRun: TestCase['lastRun'] = null): TestCase {
  return {
    id: r.id,
    projectId: r.project_id,
    number: r.number,
    name: r.name,
    description: r.description,
    steps: parseJson<Step[]>(r.steps, []),
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
    elements: parseJson<UiElement[]>(r.elements, []),
    createdAt: r.created_at,
  }
}

const DEFAULT_ENVIRONMENT: Run['environment'] = { browser: 'chrome', viewport: { width: 1280, height: 800 }, baseUrl: '' }

export function toRunSummary(r: RunRow): Omit<Run, 'steps' | 'log'> {
  return {
    id: r.id,
    projectId: r.project_id,
    testCaseId: r.test_case_id,
    testCaseNumber: r.test_case_number,
    testCaseName: r.test_case_name,
    batchRunId: r.batch_run_id,
    order: r.run_order,
    status: r.status as RunStatus,
    results: parseJson<StepResult[]>(r.results, []),
    environment: parseJson<Run['environment']>(r.environment, DEFAULT_ENVIRONMENT),
    range: parseJson<Run['range']>(r.range, null),
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  }
}

export function toRun(r: RunRow): Run {
  return { ...toRunSummary(r), steps: parseJson<Step[]>(r.steps, []), log: r.log ?? '' }
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
  'id, project_id, test_case_id, test_case_number, test_case_name, batch_run_id, run_order, status, results, environment, range, created_at, started_at, finished_at'

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
  const row = await db.prepare('SELECT * FROM runs WHERE id = ?').bind(id).first<RunRow>()
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

/** Delete objects best-effort; a failure here must never fail the request. */
export async function deleteShots(bucket: R2Bucket, keys: string[], prefixes: string[] = []): Promise<void> {
  try {
    for (let i = 0; i < keys.length; i += 500) await bucket.delete(keys.slice(i, i + 500))
    for (const prefix of prefixes) {
      let cursor: string | undefined
      do {
        const page = await bucket.list({ prefix, cursor })
        if (page.objects.length) await bucket.delete(page.objects.map((o) => o.key))
        cursor = page.truncated ? page.cursor : undefined
      } while (cursor)
    }
  } catch (e) {
    console.error('screenshot cleanup failed', e)
  }
}
