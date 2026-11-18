// Everything that drives a real browser: UI capture, trial runs, and the queue consumer that executes
// runs and assistant sessions.
import { launch, type Browser, type BrowserContext } from '@cloudflare/playwright'
import { nextUiName } from '../shared/commands'
import { aggregateStatus, patternLogHeading, runVariables, SUMMARY_LOG_HEADING } from '../shared/data'
import { deviceOf, type DeviceProfile } from '../shared/devices'
import { flatRange, positionLabel, positionsOf } from '../shared/expand'
import { makePreview, type Preview } from './assistant/preview'
import { processAssistantSession } from './assistant/session'
import type { CaptureResponse, RunPattern, RunStatus, Step, StepResult, Ui } from '../shared/types'
import { deleteShots, getProjectRow, newId, now, refreshBatchRun, toProject, toUi, type RunRow, type TestCaseRow, type UiRow } from './db'
import { captureUi, runSteps, type RunOutcome } from './engine'
import { errorMessage, HttpError, type Env, type QueueMessage } from './env'
import { guardContext, type Guard } from './guard'

/** Browser Run refused or failed to start a session (concurrency / rate limits, an outage). Not a test failure. */
class BrowserLaunchError extends HttpError {
  constructor(cause: unknown) {
    super(503, `Could not start a browser: ${errorMessage(cause)}`)
  }
}

/** A pattern that was skipped because an earlier one already found that no browser can be started. */
class NotRun extends Error {}

async function openBrowser(env: Env): Promise<Browser> {
  try {
    // The longest idle time Browser Run allows. A long fixed wait also keeps the session busy itself (executor.ts).
    return await launch(env.BROWSER, { keep_alive: 600_000 })
  } catch (e) {
    throw new BrowserLaunchError(e)
  }
}

/** A context emulates the test case's device, and every context enforces the target policy; see guard.ts. */
async function newGuardedContext(browser: Browser, env: Env, appOrigin: string, device: DeviceProfile): Promise<{ context: BrowserContext; guard: Guard }> {
  const context = await browser.newContext({
    viewport: { ...device.viewport },
    isMobile: device.isMobile,
    hasTouch: device.hasTouch,
    deviceScaleFactor: device.deviceScaleFactor,
    ...(device.userAgent ? { userAgent: device.userAgent } : {}),
  })
  return { context, guard: await guardContext(context, env, appOrigin) }
}

/**
 * One browser for a piece of work that needs it now and then (an assistant session): started on first
 * use and again when it went away in between (Browser Run closes a session that sits idle).
 */
export interface BrowserLease {
  get(): Promise<Browser>
  close(): Promise<void>
}

export function leaseBrowser(env: Env): BrowserLease {
  let browser: Browser | undefined
  return {
    get: async () => {
      if (!browser?.isConnected()) browser = await openBrowser(env)
      return browser
    },
    close: async () => {
      await browser?.close().catch(() => {})
    },
  }
}

// ---- capture ----

export interface CaptureInput {
  testCase: TestCaseRow
  /** With shared step calls expanded (expandSteps). */
  steps: Step[]
  baseUrl: string
  variables: Record<string, string>
  /** 1-based number of the test case's step to replay up to (a shared step call is one step), or null to open `url`. */
  replayTo: number | null
  url: URL | null
  appOrigin: string
  /** Also return a downscaled copy of the screenshot. */
  preview?: boolean
  /** Asked between the steps of a replay: true (or a reason for the log) stops it, and the capture shows the page at that point. */
  shouldAbort?(): Promise<boolean | string>
}

/** `shared`: use this browser and leave it open (the capture gets its own context); otherwise one is started for the capture. */
export async function captureScreen(env: Env, input: CaptureInput, shared?: Browser): Promise<CaptureResponse & { preview?: Preview }> {
  const device = deviceOf(input.testCase.device)
  const browser = shared ?? (await openBrowser(env))
  let context: BrowserContext | undefined
  try {
    const guarded = await newGuardedContext(browser, env, input.appOrigin, device)
    context = guarded.context
    const guard = guarded.guard
    const page = await context.newPage()
    let replayError: CaptureResponse['replayError']
    const tolerated: NonNullable<CaptureResponse['tolerated']> = []
    let stoppedAt = ''

    if (input.replayTo !== null) {
      const positions = positionsOf(input.steps)
      const range = flatRange(input.steps, { from: 1, to: input.replayTo })
      const lastStep = input.steps[range.to - 1]
      // The editor knows the test case's own steps: a failure inside a shared step is reported on its call.
      const at = (step: Step, message: string): NonNullable<CaptureResponse['replayError']> => {
        if (!step.origin) return { stepId: step.id, message }
        const sub = positions[input.steps.indexOf(step)]?.sub
        return { stepId: step.origin.callId, message: `In shared step S${step.origin.shared.number} "${step.origin.shared.name}"${sub ? `, step ${sub}` : ''}: ${message}` }
      }
      try {
        const outcome = await runSteps(page, input.steps, {
          baseUrl: input.baseUrl,
          variables: input.variables,
          device: device.id,
          touch: device.hasTouch,
          heal: false,
          waitSeconds: 5,
          range,
          positions,
          saveShot: async () => '',
          takeBlockedNavigation: guard.takeBlockedNavigation,
          shouldAbort: input.shouldAbort,
        })
        // An assertion that failed but is set to continue did not stop the replay: the page is the one asked for.
        for (const r of outcome.results) {
          if (r.status !== 'failed' || r === outcome.stoppedBy) continue
          const step = input.steps.find((s) => s.id === r.stepId)
          if (step) tolerated.push(at(step, r.error ?? 'The assertion failed'))
        }
        if (outcome.stoppedBy) {
          const failed = outcome.stoppedBy
          const step = input.steps.find((s) => s.id === failed.stepId) ?? lastStep
          replayError = at(step, failed.error ?? 'A step failed during the replay')
          stoppedAt = positionLabel(positions[input.steps.indexOf(step)] ?? { number: input.replayTo })
        } else if (outcome.status === 'aborted') {
          const next = input.steps.slice(0, range.to).find((s) => !s.disabled && !s.call && !outcome.results.some((r) => r.stepId === s.id))
          replayError = at(next ?? lastStep, 'The replay was stopped before this step (the session was aborted or ran out of time)')
          stoppedAt = positionLabel(positions[input.steps.indexOf(next ?? lastStep)] ?? { number: input.replayTo })
        }
      } catch (e) {
        replayError = at(lastStep, errorMessage(e))
        stoppedAt = `${input.replayTo}`
      }
      // The replay ended before it opened anything: a capture of the empty page would be a screen with no
      // elements that only gets in the way. The caller is told why instead.
      if (replayError && page.url() === 'about:blank') throw new HttpError(400, `Nothing was captured: the replay stopped at step ${stoppedAt} before any page was opened. ${replayError.message}`)
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
    const preview = input.preview ? await makePreview(context, capture.screenshot) : undefined
    const id = newId()
    const screenshotKey = `ui/${id}.jpg`
    await env.SHOTS.put(screenshotKey, capture.screenshot, { httpMetadata: { contentType: 'image/jpeg' } })

    const { results: names } = await env.DB.prepare('SELECT name FROM uis WHERE test_case_id = ?').bind(input.testCase.id).all<{ name: string }>()
    const row: UiRow = {
      id,
      test_case_id: input.testCase.id,
      name: nextUiName(names.map((n) => n.name)),
      url: capture.url,
      title: capture.title,
      width: Math.round(capture.width),
      height: Math.round(capture.height),
      screenshot_key: screenshotKey,
      device: device.id,
      elements: JSON.stringify(capture.elements),
      created_at: now(),
    }
    try {
      await env.DB.prepare('INSERT INTO uis (id, test_case_id, name, url, title, width, height, screenshot_key, elements, created_at, device) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(row.id, row.test_case_id, row.name, row.url, row.title, row.width, row.height, row.screenshot_key, row.elements, row.created_at, row.device)
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
    return { ui, ...(replayError ? { replayError } : {}), ...(tolerated.length ? { tolerated } : {}), ...(preview ? { preview } : {}) }
  } finally {
    if (shared) await context?.close().catch(() => {})
    else await browser.close().catch(() => {})
  }
}

// ---- trial runs (the assistant checking its own work) ----

export interface TrialInput {
  device: DeviceProfile
  /** With shared step calls expanded (expandSteps). */
  steps: Step[]
  baseUrl: string
  variables: Record<string, string>
  /** In the test case's own numbering: a shared step call is one step. */
  range: { from: number; to: number } | null
  appOrigin: string
  shouldAbort(): Promise<boolean | string>
}

/** Run steps the way a single run does (same waits, no self-healing), but keep nothing: no Run row, no screenshots. */
export async function trialRun(env: Env, browser: Browser, input: TrialInput): Promise<RunOutcome> {
  const { context, guard } = await newGuardedContext(browser, env, input.appOrigin, input.device)
  try {
    const page = await context.newPage()
    return await runSteps(page, input.steps, {
      baseUrl: input.baseUrl,
      variables: input.variables,
      device: input.device.id,
      touch: input.device.hasTouch,
      heal: false,
      range: input.range ? flatRange(input.steps, input.range) : null,
      positions: positionsOf(input.steps),
      replaySetup: true,
      waitSeconds: 10,
      saveShot: async () => '',
      takeBlockedNavigation: guard.takeBlockedNavigation,
      shouldAbort: input.shouldAbort,
    })
  } finally {
    await context.close().catch(() => {})
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

/** The run's row could not take what was written to it: results and log are one row, and D1 bounds a row. */
class RunTooBig extends Error {
  constructor() {
    super('The run produced more data than one run can hold (its results and its log are stored together). Shorten long step values, remove data rows, or split the test case.')
  }
}
const isTooBig = (e: unknown): boolean => /too ?big|TOOBIG/i.test(errorMessage(e))

export interface RunEnd {
  status: RunStatus
  finishedAt: string
  results: StepResult[]
  patterns: RunPattern[] | null
  /** The whole log of a run that ended by itself. */
  log: string
  /** What the consumer last wrote while the run was running: the results, and the log. */
  written: { results: string; log: string }
  /** The log without its last line (the verdict): a run that was ended from outside gets the part of this after `written.log`, since it has its own last word. */
  body: string
}

/**
 * Record how a run ended. While the run is still `running` this is the verdict. A run that was ended from
 * outside in the meantime (aborted by the user, failed by the stale-run sweep) keeps its status, its
 * finishing time and the lines written to its log since; and because such a run can be reviewed at once,
 * its results are completed only while they are still the ones this consumer wrote, so a repair that
 * was approved or rejected in between is never undone.
 */
export async function recordRunEnd(db: D1Database, runId: string, end: RunEnd): Promise<void> {
  const results = JSON.stringify(end.results)
  const patterns = end.patterns ? JSON.stringify(end.patterns) : null
  const own = await db
    .prepare("UPDATE runs SET results = ?1, log = ?2, status = ?3, finished_at = ?4, patterns = ?5 WHERE id = ?6 AND status = 'running'")
    .bind(results, end.log, end.status, end.finishedAt, patterns, runId)
    .run()
  if (own.meta.changes > 0) return
  const late = end.body.startsWith(end.written.log) ? end.body.slice(end.written.log.length).replace(/^\n+/, '') : ''
  await db.batch([
    db.prepare("UPDATE runs SET results = ?1, patterns = ?2 WHERE id = ?3 AND status <> 'running' AND results = ?4").bind(results, patterns, runId, end.written.results),
    ...(late ? [db.prepare("UPDATE runs SET log = log || CASE WHEN log = '' THEN '' ELSE char(10) END || ?1 WHERE id = ?2 AND status <> 'running'").bind(late, runId)] : []),
  ])
}

/**
 * Execute one run. A data-driven run executes its steps once per pattern (data row), one after the other,
 * each in a browser context of its own, and goes on after a pattern that failed. The browser comes from a
 * lease, so one that went away during a pattern is replaced for the next. Every write is conditional
 * on the run still being `running`, so an abort (or the stale-run sweep) is never overwritten by late progress;
 * see recordRunEnd for the last one.
 */
async function executeRun(env: Env, lease: BrowserLease, runId: string, heal: boolean, appOrigin: string): Promise<void> {
  const startedAt = now()
  const claimed = await env.DB.prepare("UPDATE runs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'").bind(startedAt, runId).run()
  if (claimed.meta.changes === 0) return // aborted or deleted before it started
  await env.DB.prepare("UPDATE batch_runs SET status = 'running', started_at = COALESCE(started_at, ?1) WHERE id = (SELECT batch_run_id FROM runs WHERE id = ?2) AND status = 'queued'")
    .bind(startedAt, runId)
    .run()

  try {
    const run = await env.DB.prepare('SELECT * FROM runs WHERE id = ?').bind(runId).first<RunRow>()
    if (!run) return
    const steps = JSON.parse(run.steps ?? '[]') as Step[]
    const range = run.range ? (JSON.parse(run.range) as { from: number; to: number }) : null
    const patterns = run.patterns ? (JSON.parse(run.patterns) as RunPattern[]) : null
    const environment = JSON.parse(run.environment) as { baseUrl?: string; device?: string }
    const device = deviceOf(environment.device)
    const project = toProject(await getProjectRow(env.DB, run.project_id), appOrigin)
    const baseUrl = environment.baseUrl ?? project.baseUrl

    const header = [
      `Run ${run.id} - ${run.test_case_number < 0 ? `shared step S${-run.test_case_number}` : `test case #${run.test_case_number}`} ${run.test_case_name}`,
      `Environment: Cloudflare Browser Run`,
      `Platform: Chrome (${device.viewport.width}x${device.viewport.height}${device.isMobile ? `, ${device.label} emulation` : ''})`,
      `Base URL: ${baseUrl || '(none)'}`,
      `Self-healing: ${heal ? 'on' : 'off'}${range ? `, steps ${range.from}-${range.to}${range.from > 1 ? ` (steps 1-${range.from - 1} are replayed first as set-up)` : ''}` : ''}`,
      ...(patterns ? [`Data-driven: ${patterns.length === 1 ? `data row ${patterns[0].index} only` : `${patterns.length} patterns (data rows), one after the other, each in a fresh browser context`}`] : []),
      `Started: ${startedAt}`,
    ].join('\n')
    /** What this consumer last wrote to the row, for recordRunEnd. */
    const written = { results: run.results, log: run.log ?? '' }
    const write = async (fields: { results?: StepResult[]; patterns?: RunPattern[]; log: string }): Promise<void> => {
      const sets = ['log = ?1']
      const args: unknown[] = [fields.log]
      const results = fields.results ? JSON.stringify(fields.results) : null
      if (results !== null) sets.push(`results = ?${args.push(results)}`)
      if (fields.patterns) sets.push(`patterns = ?${args.push(JSON.stringify(fields.patterns))}`)
      let saved
      try {
        saved = await env.DB.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?${args.push(runId)} AND status = 'running'`)
          .bind(...args)
          .run()
      } catch (e) {
        throw isTooBig(e) ? new RunTooBig() : e
      }
      if (saved.meta.changes === 0) return
      written.log = fields.log
      if (results !== null) written.results = results
    }
    await write({ log: header })

    /** Results of the patterns that have finished, then the log sections of those patterns. */
    const done: StepResult[] = []
    const sections: string[] = []
    const logWith = (current: string): string => [header, ...sections, current].filter((s) => s !== '').join('\n')
    // Screenshot keys count through the whole run, so two patterns never write the same object.
    let shot = 0
    let last: RunOutcome['status'] = 'succeeded'
    let stopped = false
    // Set when the browser went away and no other could be started: the patterns that are left cannot run.
    let noBrowser = ''
    let tooBig: RunTooBig | undefined

    for (const pattern of patterns ?? [null]) {
      if (pattern && stopped) {
        // The run was aborted (or stopped from outside) during an earlier pattern.
        pattern.status = 'aborted'
        continue
      }
      const shown = (v: string) => JSON.stringify(v.length > 80 ? `${v.slice(0, 79)}…` : v)
      const heading = pattern
        ? `${patternLogHeading(pattern.index)}\nData row ${pattern.index}: ${Object.entries(pattern.values)
            .map(([k, v]) => `${k}=${shown(v)}`)
            .join(', ')}`
        : ''

      let own: StepResult[] = []
      let engineLog = ''
      let context: BrowserContext | undefined
      let outcome: RunOutcome
      try {
        if (tooBig) throw new NotRun(tooBig.message)
        if (pattern && patterns) {
          pattern.status = 'running'
          pattern.startedAt = now()
          await write({ patterns, log: logWith(heading) })
        }
        if (noBrowser) throw new NotRun(noBrowser)
        const guarded = await newGuardedContext(await lease.get(), env, appOrigin, device)
        context = guarded.context
        const page = await context.newPage()
        outcome = await runSteps(page, steps, {
          baseUrl,
          // The values of this data row are variables of the run; a column wins over a project variable of the same name.
          variables: runVariables(project.variables, pattern?.values),
          device: device.id,
          touch: device.hasTouch,
          heal,
          // The stored range counts a shared step call as one step; the snapshot has the call expanded.
          range: range ? flatRange(steps, range) : null,
          positions: positionsOf(steps),
          replaySetup: true,
          takeBlockedNavigation: guarded.guard.takeBlockedNavigation,
          waitSeconds: 10,
          saveShot: async (bytes) => {
            const key = `run/${runId}/${++shot}.jpg`
            await env.SHOTS.put(key, bytes, { httpMetadata: { contentType: 'image/jpeg' } })
            return key
          },
          onStep: async (result, log) => {
            if (pattern) result.pattern = pattern.index
            const at = own.findIndex((r) => r.stepId === result.stepId)
            if (at >= 0) own[at] = result
            else own.push(result)
            engineLog = log
            await write({ results: [...done, ...own], log: logWith(appendLog(heading, log)) })
          },
          shouldAbort: async () => {
            const row = await env.DB.prepare('SELECT status FROM runs WHERE id = ?').bind(runId).first<{ status: string }>()
            if (row?.status === 'running') return false
            // Aborted by the user, or failed from outside (the time limit); the log should say which.
            return row?.status === 'aborted' ? true : 'Stopped: the run is no longer active (it ran into the time limit or was removed)'
          },
        })
      } catch (e) {
        // The run has started, so a launch failure is not retried through the queue: this pattern and the rest fail with the reason.
        if (e instanceof BrowserLaunchError) noBrowser = errorMessage(e)
        if (e instanceof RunTooBig) tooBig = e
        const line = e instanceof NotRun ? `Not run: ${e.message}` : e instanceof BrowserLaunchError || e instanceof RunTooBig ? errorMessage(e) : `Unexpected error: ${errorMessage(e)}`
        outcome = { status: 'failed', results: own, log: appendLog(engineLog, line) }
      } finally {
        await context?.close().catch(() => {})
      }
      own = outcome.results
      if (pattern) for (const r of own) r.pattern = pattern.index
      done.push(...own)
      sections.push(appendLog(heading, outcome.log))
      last = outcome.status
      if (outcome.status === 'aborted') stopped = true
      if (pattern) {
        pattern.status = outcome.status
        pattern.finishedAt = now()
      }
    }

    if (tooBig) {
      // The full results are what did not fit: the row keeps what was last written, and the reason.
      await failRun(env, runId, tooBig.message)
      return
    }
    // Ended from outside by the time limit, not by the user: the pattern it stopped in failed with the run.
    const outside = await env.DB.prepare('SELECT status FROM runs WHERE id = ?').bind(runId).first<{ status: string }>()
    if (outside?.status === 'failed' && patterns) for (const p of patterns) if (p.status === 'aborted' && p.startedAt) p.status = 'failed'
    const status: RunStatus = patterns ? aggregateStatus(patterns.map((p) => p.status)) : last
    const finishedAt = now()
    const summary = patterns ? [SUMMARY_LOG_HEADING, ...patterns.map((p) => `Pattern ${p.index}: ${p.startedAt ? p.status : 'not run'}`)].join('\n') : ''
    const body = logWith(summary)
    const log = appendLog(body, `Finished: ${finishedAt} - ${status}`)
    try {
      await recordRunEnd(env.DB, runId, { status, finishedAt, results: done, patterns, log, written, body })
    } catch (e) {
      if (!isTooBig(e)) throw e
      await failRun(env, runId, new RunTooBig().message)
    }
  } catch (e) {
    console.error(`run ${runId} crashed`, e)
    await failRun(env, runId, `Unexpected error: ${errorMessage(e)}`)
  } finally {
    // The run (its test case, its project) was deleted while it was executing: the clean-up that went with
    // the deletion could not see the screenshots taken after it.
    const exists = await env.DB.prepare('SELECT 1 AS x FROM runs WHERE id = ?').bind(runId).first().catch(() => true)
    if (!exists) await deleteShots(env.SHOTS, [], [`run/${runId}/`])
  }
}

const batchFailSql =
  "UPDATE runs SET status = 'failed', started_at = COALESCE(started_at, ?1), finished_at = ?1, log = log || CASE WHEN log = '' THEN '' ELSE char(10) END || ?2 WHERE id = ?3 AND status IN ('queued', 'running')"

/** `retry`: no browser could be started and the run(s) are still queued, so the message should be delivered again. */
type Processed = 'done' | 'retry'

async function processSingle(env: Env, runId: string, appOrigin: string, canRetry: boolean): Promise<Processed> {
  const row = await env.DB.prepare('SELECT status FROM runs WHERE id = ?').bind(runId).first<{ status: string }>()
  if (!row || row.status !== 'queued') return 'done'
  const lease = leaseBrowser(env)
  try {
    // Started before the run is claimed: nothing has run yet when this fails, which is not a test failure.
    await lease.get()
    await executeRun(env, lease, runId, false, appOrigin)
  } catch (e) {
    if (e instanceof BrowserLaunchError && canRetry) return 'retry'
    await failRun(env, runId, errorMessage(e))
  } finally {
    await lease.close()
  }
  return 'done'
}

/**
 * How long one consumer invocation goes on starting test cases of a batch. The platform ends an invocation
 * after 15 minutes of wall-clock time, in the middle of whatever is running; a batch that is not through
 * by this point hands the rest to a new invocation instead (a new queue message).
 */
export const BATCH_SLICE_MS = 8 * 60 * 1000
const INTERRUPTED = 'Interrupted: the worker that was executing this batch was stopped by the platform before this test case finished (a batch gets a limited time per stretch). The test case did not fail by itself; run it again.'

/**
 * The runs of a batch that an earlier invocation left `running`. A batch is executed by one invocation at
 * a time, so when a later one starts (a redelivery, or the continuation of a long batch) nobody is working
 * on them any more: they are failed with what happened, at once, instead of sitting as running until the
 * stale-run sweep calls it a timeout.
 */
export async function failInterruptedRuns(db: D1Database, batchRunId: string): Promise<number> {
  const out = await db
    .prepare("UPDATE runs SET status = 'failed', finished_at = ?1, log = log || CASE WHEN log = '' THEN '' ELSE char(10) END || ?2 WHERE batch_run_id = ?3 AND status = 'running'")
    .bind(now(), INTERRUPTED, batchRunId)
    .run()
  return out.meta.changes
}

async function processBatch(env: Env, body: Extract<QueueMessage, { batchRunId: string }>, canRetry: boolean, redelivered: boolean, clock: () => number = Date.now): Promise<Processed> {
  const batchRunId = body.batchRunId
  const appOrigin = body.origin
  const started = clock()
  if (redelivered || body.resumed) await failInterruptedRuns(env.DB, batchRunId)
  const { results: runs } = await env.DB.prepare("SELECT id FROM runs WHERE batch_run_id = ? AND status = 'queued' ORDER BY run_order").bind(batchRunId).all<{ id: string }>()
  if (runs.length === 0) {
    await refreshBatchRun(env.DB, batchRunId)
    return 'done'
  }
  const lease = leaseBrowser(env)
  let executed = 0
  try {
    for (const { id } of runs) {
      // Never before the first test case: every invocation gets something done.
      if (executed > 0 && clock() - started >= BATCH_SLICE_MS) {
        // Sent while the rest is still queued; if it cannot be sent, this invocation goes on as far as it gets.
        const handed = await env.RUN_QUEUE.send({ batchRunId, origin: appOrigin, resumed: true }).then(
          () => true,
          (e) => (console.error('could not hand the batch on', e), false),
        )
        if (handed) break
      }
      // One browser for the whole batch; if it died mid-way, the lease starts another for the remaining cases.
      await lease.get()
      await executeRun(env, lease, id, true, appOrigin) // only claims runs that are still queued
      executed++
      await refreshBatchRun(env.DB, batchRunId)
    }
  } catch (e) {
    // A launch failure only gets here from between test cases (inside a run it fails that run's patterns),
    // so every unfinished run is still queued and a later delivery of the same message picks up exactly
    // where this one stopped.
    if (e instanceof BrowserLaunchError && canRetry) return 'retry'
    const message = errorMessage(e)
    await env.DB.batch(runs.map(({ id }) => env.DB.prepare(batchFailSql).bind(now(), message, id)))
  } finally {
    await lease.close()
    await refreshBatchRun(env.DB, batchRunId)
  }
  return 'done'
}

/** Keep in step with `max_retries` of the queue consumer in wrangler.jsonc. */
const LAUNCH_RETRIES = 3
const LAUNCH_RETRY_DELAY_S = 30

/** One clean-up message: true when everything it names is gone. */
async function cleanUpShots(bucket: R2Bucket, work: { keys?: string[]; prefixes?: string[] }): Promise<boolean> {
  const left = await deleteShots(bucket, work.keys ?? [], work.prefixes ?? [])
  return left.keys.length === 0 && left.prefixes.length === 0
}

/**
 * Queue consumer. A message is delivered again only when no browser could be started (Browser Run's
 * concurrency and rate limits are transient); after the last attempt the run is marked failed with that
 * reason. A run that started is never retried: it either finishes or is marked failed. A screenshot
 * clean-up that could not delete everything is delivered again too.
 */
export async function handleQueue(batch: MessageBatch<QueueMessage>, env: Env, clock: () => number = Date.now): Promise<void> {
  for (const message of batch.messages) {
    const body = message.body
    let processed: Processed = 'done'
    try {
      const canRetry = message.attempts <= LAUNCH_RETRIES
      if ('cleanup' in body) processed = (await cleanUpShots(env.SHOTS, body.cleanup)) || !canRetry ? 'done' : 'retry'
      else if ('assistantSessionId' in body) await processAssistantSession(env, body.assistantSessionId, body.origin, undefined, body.override)
      else processed = 'batchRunId' in body ? await processBatch(env, body, canRetry, message.attempts > 1, clock) : await processSingle(env, body.runId, body.origin, canRetry)
    } catch (e) {
      console.error('queue message failed', body, e)
    }
    if (processed === 'retry') {
      console.warn(`${'cleanup' in body ? 'Screenshot clean-up incomplete' : 'No browser available'} (attempt ${message.attempts}); retrying in ${LAUNCH_RETRY_DELAY_S} s`)
      message.retry({ delaySeconds: LAUNCH_RETRY_DELAY_S })
    } else message.ack()
  }
}
