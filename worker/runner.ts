// Everything that drives a real browser: UI capture and the queue consumer that executes runs.
import { launch, type Browser, type BrowserContext } from '@cloudflare/playwright'
import type { CaptureResponse, RunStatus, Step, StepResult, Ui } from '../shared/types'
import { getProjectRow, newId, now, refreshBatchRun, toProject, toUi, type RunRow, type TestCaseRow, type UiRow } from './db'
import { captureUi, runSteps, type RunOutcome } from './engine'
import { errorMessage, HttpError, VIEWPORT, type Env, type QueueMessage } from './env'
import { isHostAllowed, isPrivateHost, parseHttpUrl } from './validate'

async function openBrowser(env: Env): Promise<Browser> {
  try {
    return await launch(env.BROWSER)
  } catch (e) {
    throw new HttpError(503, `Could not start a browser: ${errorMessage(e)}`)
  }
}

/**
 * Every browser context enforces the target policy (private hosts always blocked, plus ALLOWED_HOSTS when set):
 * - documents (top-level and iframes) must be on an allowed host;
 * - sub-resources may come from any public host, but never from a private one;
 * - redirects are not re-routed by Playwright, so every committed frame URL is re-checked and the page is
 *   blanked if a redirect or client-side navigation landed somewhere that is not allowed.
 */
async function newGuardedContext(browser: Browser, env: Env, appOrigin: string): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { ...VIEWPORT } })
  const documentAllowed = (raw: string): boolean => {
    if (raw === 'about:blank' || raw.startsWith('about:srcdoc') || raw.startsWith('data:') || raw.startsWith('blob:')) return true
    const url = parseHttpUrl(raw)
    return url !== null && isHostAllowed(url, env, appOrigin)
  }
  await context.route('**/*', async (route) => {
    const request = route.request()
    const url = parseHttpUrl(request.url())
    if (url) {
      const ok = request.isNavigationRequest() ? isHostAllowed(url, env, appOrigin) : url.origin === appOrigin || !isPrivateHost(url.hostname)
      if (!ok) return route.abort('blockedbyclient')
    }
    return route.fallback()
  })
  context.on('page', (page) => {
    page.on('framenavigated', (frame) => {
      if (documentAllowed(frame.url())) return
      const blocked = frame.url()
      console.warn(`Blocked navigation to disallowed host: ${blocked}`)
      void page.goto('about:blank').catch(() => {})
    })
  })
  return context
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
    const context = await newGuardedContext(browser, env, input.appOrigin)
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
        throw new HttpError(502, `Could not open ${input.url.href}: ${errorMessage(e).split('\n')[0]}`)
      }
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
    await env.DB.prepare('INSERT INTO uis (id, test_case_id, name, url, title, width, height, screenshot_key, elements, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(row.id, row.test_case_id, row.name, row.url, row.title, row.width, row.height, row.screenshot_key, row.elements, row.created_at)
      .run()
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
    const project = toProject(await getProjectRow(env.DB, run.project_id))
    const baseUrl = environment.baseUrl ?? project.baseUrl

    header = [
      `Run ${run.id} - test case #${run.test_case_number} ${run.test_case_name}`,
      `Environment: Cloudflare Browser Run`,
      `Platform: Chrome (${VIEWPORT.width}x${VIEWPORT.height})`,
      `Base URL: ${baseUrl || '(none)'}`,
      `Self-healing: ${heal ? 'on' : 'off'}${range ? `, steps ${range.from}-${range.to}` : ''}`,
      `Started: ${startedAt}`,
    ].join('\n')
    await env.DB.prepare("UPDATE runs SET log = ? WHERE id = ? AND status = 'running'").bind(header, runId).run()

    context = await newGuardedContext(browser, env, appOrigin)
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
          return row?.status !== 'running'
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

async function processSingle(env: Env, runId: string, appOrigin: string): Promise<void> {
  const row = await env.DB.prepare('SELECT status FROM runs WHERE id = ?').bind(runId).first<{ status: string }>()
  if (!row || row.status !== 'queued') return
  let browser: Browser | undefined
  try {
    browser = await openBrowser(env)
    await executeRun(env, browser, runId, false, appOrigin)
  } catch (e) {
    await failRun(env, runId, errorMessage(e))
  } finally {
    await browser?.close().catch(() => {})
  }
}

async function processBatch(env: Env, batchRunId: string, appOrigin: string): Promise<void> {
  const { results: runs } = await env.DB.prepare('SELECT id FROM runs WHERE batch_run_id = ? ORDER BY run_order').bind(batchRunId).all<{ id: string }>()
  if (runs.length === 0) return
  let browser: Browser | undefined
  try {
    browser = await openBrowser(env)
    for (const { id } of runs) {
      // One browser for the whole batch; if it died mid-way, start another for the remaining cases.
      if (!browser.isConnected()) browser = await openBrowser(env)
      await executeRun(env, browser, id, true, appOrigin)
      await refreshBatchRun(env.DB, batchRunId)
    }
  } catch (e) {
    const message = errorMessage(e)
    await env.DB.batch(runs.map(({ id }) =>
      env.DB.prepare(
        "UPDATE runs SET status = 'failed', started_at = COALESCE(started_at, ?1), finished_at = ?1, log = log || CASE WHEN log = '' THEN '' ELSE char(10) END || ?2 WHERE id = ?3 AND status IN ('queued', 'running')",
      ).bind(now(), message, id),
    ))
  } finally {
    await browser?.close().catch(() => {})
    await refreshBatchRun(env.DB, batchRunId)
  }
}

/** Queue consumer. Messages are never retried (max_retries 0): a run either finishes or is marked failed. */
export async function handleQueue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    const body = message.body
    try {
      if ('batchRunId' in body) await processBatch(env, body.batchRunId, body.origin)
      else await processSingle(env, body.runId, body.origin)
    } catch (e) {
      console.error('queue message failed', body, e)
    } finally {
      message.ack()
    }
  }
}
