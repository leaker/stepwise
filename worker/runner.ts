// Everything that drives a real browser: UI capture and the queue consumer that executes runs.
import { launch, type Browser, type BrowserContext } from '@cloudflare/playwright'
import type { CaptureResponse, RunStatus, Step, StepResult, Ui } from '../shared/types'
import { deleteShots, getProjectRow, newId, now, refreshBatchRun, toProject, toUi, type RunRow, type TestCaseRow, type UiRow } from './db'
import { captureUi, runSteps, type RunOutcome } from './engine'
import { errorMessage, HttpError, VIEWPORT, type Env, type QueueMessage } from './env'
import { guardContext, type Guard } from './guard'

/** Browser Run refused or failed to start a session (concurrency / rate limits, an outage). Not a test failure. */
class BrowserLaunchError extends HttpError {
  constructor(cause: unknown) {
    super(503, `Could not start a browser: ${errorMessage(cause)}`)
  }
}

async function openBrowser(env: Env): Promise<Browser> {
  try {
    return await launch(env.BROWSER)
  } catch (e) {
    throw new BrowserLaunchError(e)
  }
}

/** Every browser context enforces the target policy; see guard.ts. */
async function newGuardedContext(browser: Browser, env: Env, appOrigin: string): Promise<{ context: BrowserContext; guard: Guard }> {
  const context = await browser.newContext({ viewport: { ...VIEWPORT } })
  return { context, guard: await guardContext(context, env, appOrigin) }
}

// ---- capture ----

export interface CaptureInput {
  testCase: TestCaseRow
  steps: Step[]
  baseUrl: string
  variables: Record<string, string>
  /** 1-based index of the step to replay up to, or null to open `url`. */
  replayTo: number | null
  url: URL | null
  appOrigin: string
}

export async function captureScreen(env: Env, input: CaptureInput): Promise<CaptureResponse> {
  const browser = await openBrowser(env)
  try {
    const { context, guard } = await newGuardedContext(browser, env, input.appOrigin)
    const page = await context.newPage()
    let replayError: CaptureResponse['replayError']

    if (input.replayTo !== null) {
      const lastStep = input.steps[input.replayTo - 1]
      try {
        const outcome = await runSteps(page, input.steps, {
          baseUrl: input.baseUrl,
          variables: input.variables,
          heal: false,
          waitSeconds: 5,
          range: { from: 1, to: input.replayTo },
          saveShot: async () => '',
          takeBlockedNavigation: guard.takeBlockedNavigation,
        })
        if (outcome.status === 'failed') {
          const failed = [...outcome.results].reverse().find((r) => r.status === 'failed')
          replayError = { stepId: failed?.stepId ?? lastStep.id, message: failed?.error ?? 'A step failed during the replay' }
        }
      } catch (e) {
        replayError = { stepId: lastStep.id, message: errorMessage(e) }
      }
    } else if (input.url) {
      try {
        await page.goto(input.url.href, { waitUntil: 'load', timeout: 30_000 })
      } catch (e) {
        const refused = guard.takeBlockedNavigation()
        if (refused) throw new HttpError(400, `${input.url.href} leads to ${refused}, which is not in this deployment's allowed hosts`)
        throw new HttpError(502, `Could not open ${input.url.href}: ${errorMessage(e).split('\n')[0]}`)
      }
      const refused = guard.takeBlockedNavigation()
      if (refused) throw new HttpError(400, `${input.url.href} leads to ${refused}, which is not in this deployment's allowed hosts`)
    }

    const capture = await captureUi(page)
    const id = newId()
    const screenshotKey = `ui/${id}.jpg`
    await env.SHOTS.put(screenshotKey, capture.screenshot, { httpMetadata: { contentType: 'image/jpeg' } })

    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM uis WHERE test_case_id = ?').bind(input.testCase.id).first<{ n: number }>()
    const row: UiRow = {
      id,
      test_case_id: input.testCase.id,
      name: `UI${(count?.n ?? 0) + 1}`,
      url: capture.url,
      title: capture.title,
      width: Math.round(capture.width),
      height: Math.round(capture.height),
      screenshot_key: screenshotKey,
      elements: JSON.stringify(capture.elements),
      created_at: now(),
    }
    try {
      await env.DB.prepare('INSERT INTO uis (id, test_case_id, name, url, title, width, height, screenshot_key, elements, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(row.id, row.test_case_id, row.name, row.url, row.title, row.width, row.height, row.screenshot_key, row.elements, row.created_at)
        .run()
    } catch (e) {
      // The screenshot would be an orphan: nothing points at it.
      await deleteShots(env.SHOTS, [screenshotKey])
      // The test case was deleted while its capture was running (the insert fails on the foreign key).
      const exists = await env.DB.prepare('SELECT 1 AS x FROM test_cases WHERE id = ?').bind(input.testCase.id).first()
      if (!exists) throw new HttpError(404, 'Test case not found')
      throw e
    }
    const ui: Ui = toUi(row)
    return replayError ? { ui, replayError } : { ui }
  } finally {
    await browser.close().catch(() => {})
  }
}

// ---- runs ----

const appendLog = (log: string, line: string): string => (log ? `${log}\n${line}` : line)

async function failRun(env: Env, runId: string, message: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE runs SET status = 'failed', started_at = COALESCE(started_at, ?1), finished_at = ?1, log = log || CASE WHEN log = '' THEN '' ELSE char(10) END || ?2 WHERE id = ?3 AND status IN ('queued', 'running')",
  )
    .bind(now(), message, runId)
    .run()
}

/**
 * Execute one run in its own browser context. Every write is conditional on the run still being
 * `running`, so an abort (or the stale-run sweep) is never overwritten by late progress.
 */
async function executeRun(env: Env, browser: Browser, runId: string, heal: boolean, appOrigin: string): Promise<void> {
  const startedAt = now()
  const claimed = await env.DB.prepare("UPDATE runs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'").bind(startedAt, runId).run()
  if (claimed.meta.changes === 0) return // aborted or deleted before it started
  await env.DB.prepare("UPDATE batch_runs SET status = 'running', started_at = COALESCE(started_at, ?1) WHERE id = (SELECT batch_run_id FROM runs WHERE id = ?2) AND status = 'queued'")
    .bind(startedAt, runId)
    .run()

  let header = ''
  let results: StepResult[] = []
  let context: BrowserContext | undefined
  try {
    const run = await env.DB.prepare('SELECT * FROM runs WHERE id = ?').bind(runId).first<RunRow>()
    if (!run) return
    const steps = JSON.parse(run.steps ?? '[]') as Step[]
    const range = run.range ? (JSON.parse(run.range) as { from: number; to: number }) : null
    const environment = JSON.parse(run.environment) as { baseUrl?: string }
    const project = toProject(await getProjectRow(env.DB, run.project_id), appOrigin)
    const baseUrl = environment.baseUrl ?? project.baseUrl

    header = [
      `Run ${run.id} - test case #${run.test_case_number} ${run.test_case_name}`,
      `Environment: Cloudflare Browser Run`,
      `Platform: Chrome (${VIEWPORT.width}x${VIEWPORT.height})`,
      `Base URL: ${baseUrl || '(none)'}`,
      `Self-healing: ${heal ? 'on' : 'off'}${range ? `, steps ${range.from}-${range.to}${range.from > 1 ? ` (steps 1-${range.from - 1} are replayed first as set-up)` : ''}` : ''}`,
      `Started: ${startedAt}`,
    ].join('\n')
    await env.DB.prepare("UPDATE runs SET log = ? WHERE id = ? AND status = 'running'").bind(header, runId).run()

    const guarded = await newGuardedContext(browser, env, appOrigin)
    context = guarded.context
    const page = await context.newPage()
    let shot = 0
    let engineLog = ''

    let outcome: RunOutcome
    try {
      outcome = await runSteps(page, steps, {
        baseUrl,
        variables: project.variables,
        heal,
        range,
        replaySetup: true,
        takeBlockedNavigation: guarded.guard.takeBlockedNavigation,
        waitSeconds: 10,
        saveShot: async (bytes) => {
          const key = `run/${runId}/${++shot}.jpg`
          await env.SHOTS.put(key, bytes, { httpMetadata: { contentType: 'image/jpeg' } })
          return key
        },
        onStep: async (result, log) => {
          const at = results.findIndex((r) => r.stepId === result.stepId)
          if (at >= 0) results[at] = result
          else results.push(result)
          engineLog = log
          await env.DB.prepare("UPDATE runs SET results = ?, log = ? WHERE id = ? AND status = 'running'")
            .bind(JSON.stringify(results), appendLog(header, log), runId)
            .run()
        },
        shouldAbort: async () => {
          const row = await env.DB.prepare('SELECT status FROM runs WHERE id = ?').bind(runId).first<{ status: string }>()
          if (row?.status === 'running') return false
          // Aborted by the user, or failed from outside (the time limit); the log should say which.
          return row?.status === 'aborted' ? true : 'Stopped: the run is no longer active (it ran into the time limit or was removed)'
        },
      })
    } catch (e) {
      outcome = { status: 'failed', results, log: appendLog(engineLog, `Unexpected error: ${errorMessage(e)}`) }
    }
    results = outcome.results

    const finishedAt = now()
    const log = appendLog(appendLog(header, outcome.log), `Finished: ${finishedAt} - ${outcome.status}`)
    // Keep a status that was set from outside (aborted / timed out); otherwise record the engine's verdict.
    await env.DB.prepare("UPDATE runs SET results = ?1, log = ?2, status = CASE WHEN status = 'running' THEN ?3 ELSE status END, finished_at = COALESCE(finished_at, ?4) WHERE id = ?5")
      .bind(JSON.stringify(outcome.results), log, outcome.status satisfies RunStatus, finishedAt, runId)
      .run()
  } catch (e) {
    console.error(`run ${runId} crashed`, e)
    await failRun(env, runId, `Unexpected error: ${errorMessage(e)}`)
  } finally {
    await context?.close().catch(() => {})
  }
}

const batchFailSql =
  "UPDATE runs SET status = 'failed', started_at = COALESCE(started_at, ?1), finished_at = ?1, log = log || CASE WHEN log = '' THEN '' ELSE char(10) END || ?2 WHERE id = ?3 AND status IN ('queued', 'running')"

/** `retry`: no browser could be started and the run(s) are still queued, so the message should be delivered again. */
type Processed = 'done' | 'retry'

async function processSingle(env: Env, runId: string, appOrigin: string, canRetry: boolean): Promise<Processed> {
  const row = await env.DB.prepare('SELECT status FROM runs WHERE id = ?').bind(runId).first<{ status: string }>()
  if (!row || row.status !== 'queued') return 'done'
  let browser: Browser | undefined
  try {
    browser = await openBrowser(env)
    await executeRun(env, browser, runId, false, appOrigin)
  } catch (e) {
    // Nothing has run yet when the browser could not be started: that is not a test failure.
    if (e instanceof BrowserLaunchError && canRetry) return 'retry'
    await failRun(env, runId, errorMessage(e))
  } finally {
    await browser?.close().catch(() => {})
  }
  return 'done'
}

async function processBatch(env: Env, batchRunId: string, appOrigin: string, canRetry: boolean): Promise<Processed> {
  const { results: runs } = await env.DB.prepare('SELECT id FROM runs WHERE batch_run_id = ? ORDER BY run_order').bind(batchRunId).all<{ id: string }>()
  if (runs.length === 0) return 'done'
  let browser: Browser | undefined
  try {
    browser = await openBrowser(env)
    for (const { id } of runs) {
      // One browser for the whole batch; if it died mid-way, start another for the remaining cases.
      if (!browser.isConnected()) browser = await openBrowser(env)
      await executeRun(env, browser, id, true, appOrigin) // only claims runs that are still queued
      await refreshBatchRun(env.DB, batchRunId)
    }
  } catch (e) {
    // A launch can only fail between test cases, so every unfinished run is still queued and a later
    // delivery of the same message picks up exactly where this one stopped.
    if (e instanceof BrowserLaunchError && canRetry) return 'retry'
    const message = errorMessage(e)
    await env.DB.batch(runs.map(({ id }) => env.DB.prepare(batchFailSql).bind(now(), message, id)))
  } finally {
    await browser?.close().catch(() => {})
    await refreshBatchRun(env.DB, batchRunId)
  }
  return 'done'
}

/** Keep in step with `max_retries` of the queue consumer in wrangler.jsonc. */
const LAUNCH_RETRIES = 3
const LAUNCH_RETRY_DELAY_S = 30

/**
 * Queue consumer. A message is delivered again only when no browser could be started (Browser Run's
 * concurrency and rate limits are transient); after the last attempt the run is marked failed with that
 * reason. A run that started is never retried: it either finishes or is marked failed.
 */
export async function handleQueue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    const body = message.body
    let processed: Processed = 'done'
    try {
      const canRetry = message.attempts <= LAUNCH_RETRIES
      processed = 'batchRunId' in body ? await processBatch(env, body.batchRunId, body.origin, canRetry) : await processSingle(env, body.runId, body.origin, canRetry)
    } catch (e) {
      console.error('queue message failed', body, e)
    }
    if (processed === 'retry') {
      console.warn(`No browser available (attempt ${message.attempts}); retrying in ${LAUNCH_RETRY_DELAY_S} s`, body)
      message.retry({ delaySeconds: LAUNCH_RETRY_DELAY_S })
    } else message.ack()
  }
}
