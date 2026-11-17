// Step executor: runs a test case's steps against a Playwright page.
import type { Locator as PwLocator, Page } from '@cloudflare/playwright'
import { COMMAND_BY_ID, stepSentence, validateSteps } from '../../shared/commands'
import type { CommandDef } from '../../shared/commands'
import { locatorToString } from '../../shared/types'
import type { ElementRef, Fingerprint, HealProposal, Locator, Step, StepResult } from '../../shared/types'
import { findReplacement } from './heal'
import type { RunOptions, RunOutcome } from './index'
import { poll, sleep, toSelector, waitForElement } from './locate'

const IF_WAIT_MS = 2000
const NAVIGATION_TIMEOUT_MS = 30_000
const MAX_FIXED_WAIT_S = 300

class StepError extends Error {}

const normalize = (s: string) => s.replace(/\s+/g, ' ').trim()
const firstLine = (e: unknown) => String(e instanceof Error ? e.message : e).split('\n')[0]
const quote = (s: string) => JSON.stringify(s)

interface Healed {
  locator: Locator
  candidates: Locator[]
  fingerprint: Fingerprint
}

interface Frame {
  /** Are the steps of the current arm being executed? */
  exec: boolean
  /** Has any arm of this branch been taken (or is the whole branch inside a skipped arm)? */
  taken: boolean
}

export async function runSteps(page: Page, steps: Step[], opts: RunOptions): Promise<RunOutcome> {
  const waitMs = Math.max(0, opts.waitSeconds ?? 10) * 1000
  const vars: Record<string, string> = { ...opts.variables, BASE_URL: opts.baseUrl, BROWSER: 'chrome' }
  const results: StepResult[] = []
  const lines: string[] = []
  const healed = new Map<string, Healed>()
  const log = (line: string) => void lines.push(line)
  const report = async (result: StepResult) => {
    results.push(result)
    await opts.onStep?.(result, lines.join('\n'))
  }
  const finish = (status: RunOutcome['status']): RunOutcome => {
    log(`Finished: ${status}`)
    return { status, results, log: lines.join('\n') }
  }

  const structural = validateSteps(steps)
  if (structural.length) {
    const seen = new Set<string>()
    for (const problem of structural) {
      const index = steps.findIndex((s) => s.id === problem.stepId)
      log(`[${index + 1}] STEP ERROR: ${problem.message}`)
      if (seen.has(problem.stepId) || index < 0) continue
      seen.add(problem.stepId)
      await report({
        stepId: problem.stepId,
        number: index + 1,
        status: 'failed',
        sentence: stepSentence(steps[index]),
        durationMs: 0,
        error: `Step error: ${problem.message}`,
      })
    }
    return finish('failed')
  }

  const substitute = (text: string): string =>
    text.replace(/\$\{([^}]*)\}/g, (_, name: string) => {
      const key = name.trim()
      if (!(key in vars)) throw new StepError(`Variable \${${key}} is not defined`)
      return vars[key]
    })

  const absoluteUrl = (value: string): string => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value
    if (!opts.baseUrl) throw new StepError(`Cannot resolve relative URL ${quote(value)}: the project has no base URL`)
    try {
      return new URL(value, opts.baseUrl).toString()
    } catch {
      throw new StepError(`Invalid URL ${quote(value)}`)
    }
  }

  const targetKey = (t: ElementRef) => `${t.uiId}/${t.elementId}`
  const effectiveLocator = (t: ElementRef): Locator => healed.get(targetKey(t))?.locator ?? t.locator

  const takeShot = async (fullPage = false): Promise<string | undefined> => {
    try {
      const bytes = await page.screenshot({ type: 'jpeg', quality: 70, fullPage, animations: 'disabled', timeout: 15_000 })
      return await opts.saveShot(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
    } catch (e) {
      log(`    [warning] screenshot failed: ${firstLine(e)}`)
      return undefined
    }
  }

  /** Text as a user reads it: the value for inputs, the selected option's label for selects, else the visible text. */
  const readText = async (el: PwLocator): Promise<string> =>
    normalize(
      await el.evaluate((node: any) =>
        node.tagName === 'SELECT'
          ? String((node.selectedOptions && node.selectedOptions[0] && (node.selectedOptions[0].label || node.selectedOptions[0].textContent)) || '')
          : node.tagName === 'INPUT' || node.tagName === 'TEXTAREA'
            ? String(node.value ?? '')
            : String(typeof node.innerText === 'string' ? node.innerText : (node.textContent ?? '')),
      ),
    )

  const settle = async () => {
    await sleep(60)
    await page.waitForLoadState('load', { timeout: NAVIGATION_TIMEOUT_MS }).catch(() => {})
  }

  interface Outcome {
    heal?: HealProposal
  }

  /** Finds the step's element, self-healing if allowed. */
  const locate = async (step: Step, def: CommandDef, target: ElementRef, n: number, out: Outcome, timeoutMs = waitMs): Promise<PwLocator> => {
    const locator = effectiveLocator(target)
    const found = await waitForElement(page, locator, timeoutMs)
    if (found) return found
    const missing =
      step.command === 'assert_exists'
        ? `AssertionError: UI element does not exist (${locatorToString(locator)})`
        : `UI element ${target.name} was not found (${locatorToString(locator)})`
    if (!opts.heal || !def.healable) throw new StepError(missing)

    log(`[${n}] ${missing}`)
    log(`[${n}] self-healing: looking for a replacement`)
    let replacement
    try {
      replacement = await findReplacement(page, target, locator)
    } catch (e) {
      log(`[${n}] self-healing failed: ${firstLine(e)}`)
      throw new StepError(missing)
    }
    if ('reason' in replacement) {
      log(`[${n}] self-healing gave up: ${replacement.reason}`)
      throw new StepError(missing)
    }
    const { element } = replacement
    const newLocator = element.locators[0]
    const handle = await waitForElement(page, newLocator, 1000)
    if (!handle) throw new StepError(missing)
    const screenshotKey = (await takeShot(true)) ?? ''
    out.heal = {
      state: 'unresolved',
      elementName: target.name,
      oldLocator: target.locator,
      newLocator,
      newCandidates: element.locators,
      newFingerprint: element.fingerprint,
      score: replacement.score,
      before: { uiId: target.uiId, box: target.fingerprint.box },
      after: { screenshotKey, box: element.box, width: replacement.pageWidth, height: replacement.pageHeight },
    }
    healed.set(targetKey(target), { locator: newLocator, candidates: element.locators, fingerprint: element.fingerprint })
    const how = replacement.via === 'candidate' ? 'stored fallback locator' : 'fingerprint match'
    log(`[${n}] HEALED: ${target.name} ${locatorToString(locator)} -> ${locatorToString(newLocator)} (${how}, score ${replacement.score.toFixed(2)}, now ${element.name})`)
    return handle
  }

  const need = (step: Step): ElementRef => {
    if (!step.target) throw new StepError('No UI element is selected for this step')
    return step.target
  }
  const needVariable = (step: Step): string => {
    const name = (step.variable ?? '').trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new StepError(name ? `Invalid variable name ${quote(name)}` : 'No variable name is set for this step')
    return name
  }
  const seconds = (value: string, fallback: number | null): number => {
    if (!value.trim() && fallback !== null) return fallback
    const s = Number(value)
    if (!Number.isFinite(s) || s < 0) throw new StepError(`${quote(value)} is not a valid number of seconds`)
    return Math.min(s, MAX_FIXED_WAIT_S)
  }

  /** Retries a read-and-compare until it holds or the wait runs out; returns the last value read. */
  const until = async (read: () => Promise<string>, ok: (actual: string) => boolean): Promise<{ ok: boolean; actual: string }> => {
    let actual = ''
    const passed = await poll(async () => {
      actual = await read()
      return ok(actual)
    }, waitMs)
    return { ok: !!passed, actual }
  }

  const actionTimeout = Math.max(waitMs, 1000)

  /** Executes one non-structural step. Returns the branch condition for If commands. */
  const execute = async (step: Step, def: CommandDef, value: string, n: number, out: Outcome): Promise<boolean | void> => {
    const describe = (t: ElementRef) => `${t.name} (${locatorToString(effectiveLocator(t))})`
    const act = async (t: ElementRef, verb: string, fn: (el: PwLocator) => Promise<unknown>) => {
      const el = await locate(step, def, t, n, out)
      await el.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {})
      try {
        await fn(el)
      } catch (e) {
        if (e instanceof StepError) throw e
        throw new StepError(`UI element ${t.name} could not be ${verb} (${locatorToString(effectiveLocator(t))}): ${firstLine(e)}`)
      }
    }

    switch (step.command) {
      case 'navigate': {
        if (!value.trim()) throw new StepError('No URL is set for this step')
        const url = absoluteUrl(value.trim())
        try {
          await page.goto(url, { waitUntil: 'load', timeout: NAVIGATION_TIMEOUT_MS })
        } catch (e) {
          throw new StepError(`Could not open ${url}: ${firstLine(e)}`)
        }
        return
      }
      case 'click': {
        const t = need(step)
        await act(t, 'clicked', async (el) => {
          try {
            await el.click({ timeout: actionTimeout })
          } catch (e) {
            // Same fallback as a human would try: the element is there and enabled but something
            // intercepts the element-based click, so click its centre by coordinates.
            const box = await el.boundingBox().catch(() => null)
            const usable = box && (await el.isVisible().catch(() => false)) && (await el.isEnabled().catch(() => false))
            if (!box || !usable) throw e
            const x = Math.round(box.x + box.width / 2)
            const y = Math.round(box.y + box.height / 2)
            log(`[${n}] [warning] element-based click failed, retrying by coordinates; the target position: (${x}, ${y})`)
            await page.mouse.click(x, y)
          }
        })
        await settle()
        return
      }
      case 'hover':
        await act(need(step), 'hovered', (el) => el.hover({ timeout: actionTimeout }))
        return
      case 'input':
        await act(need(step), 'filled', (el) => el.fill(value, { timeout: actionTimeout }))
        return
      case 'check':
      case 'uncheck':
        await act(need(step), step.command === 'check' ? 'checked' : 'unchecked', (el) => el.setChecked(step.command === 'check', { timeout: actionTimeout }))
        await settle()
        return
      case 'select': {
        const t = need(step)
        await act(t, 'selected', async (el) => {
          const want = normalize(value)
          let known: string[] = []
          const index = await poll(async () => {
            const options: { label: string; value: string }[] = await el.evaluate((node: any) =>
              Array.from(node.options || []).map((o: any) => ({ label: String(o.label || o.textContent || ''), value: String(o.value) })),
            )
            known = options.map((o) => normalize(o.label))
            let at = known.indexOf(want)
            if (at < 0) at = options.findIndex((o) => o.value === value)
            return at >= 0 ? { at } : null
          }, waitMs)
          if (!index) throw new StepError(`Option ${quote(value)} was not found in ${describe(t)}; available options: ${known.map(quote).join(', ') || '(none)'}`)
          await el.selectOption({ index: index.at }, { timeout: actionTimeout })
        })
        await settle()
        return
      }
      case 'press_key': {
        if (!value.trim()) throw new StepError('No key is set for this step')
        try {
          await page.keyboard.press(value.trim())
        } catch (e) {
          throw new StepError(`Could not press ${quote(value)}: ${firstLine(e)}`)
        }
        await settle()
        return
      }
      case 'screenshot':
      case 'comment':
        return

      case 'assert_text_equals':
      case 'assert_text_contains': {
        const el = await locate(step, def, need(step), n, out)
        const expected = normalize(value)
        const equals = step.command === 'assert_text_equals'
        const r = await until(
          () => readText(el),
          (actual) => (equals ? actual === expected : actual.includes(expected)),
        )
        if (!r.ok) throw new StepError(`AssertionError: text ${quote(r.actual)} does not ${equals ? 'equal' : 'contain'} ${quote(expected)}`)
        return
      }
      case 'assert_exists':
        await locate(step, def, need(step), n, out)
        return
      case 'assert_not_exists': {
        const t = need(step)
        const handle = page.locator(toSelector(effectiveLocator(t)))
        const gone = await poll(async () => (await handle.count()) === 0, waitMs)
        if (!gone) throw new StepError(`AssertionError: UI element exists (${locatorToString(effectiveLocator(t))})`)
        return
      }
      case 'assert_visible': {
        const t = need(step)
        const el = await locate(step, def, t, n, out)
        if (!(await poll(() => el.isVisible(), waitMs))) throw new StepError(`AssertionError: UI element is not visible (${locatorToString(effectiveLocator(t))})`)
        return
      }
      case 'assert_url_equals':
      case 'assert_url_contains': {
        const equals = step.command === 'assert_url_equals'
        const expected = equals && opts.baseUrl && !/^[a-z][a-z0-9+.-]*:/i.test(value.trim()) ? absoluteUrl(value.trim()) : value.trim()
        const r = await until(
          async () => page.url(),
          (actual) => (equals ? actual === expected : actual.includes(expected)),
        )
        if (!r.ok) throw new StepError(`AssertionError: URL ${quote(r.actual)} does not ${equals ? 'equal' : 'contain'} ${quote(expected)}`)
        return
      }
      case 'assert_title_equals':
      case 'assert_title_contains': {
        const equals = step.command === 'assert_title_equals'
        const expected = normalize(value)
        const r = await until(
          async () => normalize(await page.title()),
          (actual) => (equals ? actual === expected : actual.includes(expected)),
        )
        if (!r.ok) throw new StepError(`AssertionError: title ${quote(r.actual)} does not ${equals ? 'equal' : 'contain'} ${quote(expected)}`)
        return
      }
      case 'assert_variable_equals': {
        const name = needVariable(step)
        if (!(name in vars)) throw new StepError(`AssertionError: variable ${name} is not defined`)
        if (vars[name] !== value) throw new StepError(`AssertionError: variable ${name} is ${quote(vars[name])}, expected ${quote(value)}`)
        return
      }

      case 'wait_visible': {
        const t = need(step)
        const max = seconds(value, 10)
        const started = Date.now()
        const el = await locate(step, def, t, n, out, max * 1000)
        const left = Math.max(0, max * 1000 - (Date.now() - started))
        if (!(await poll(() => el.isVisible(), left))) {
          throw new StepError(`UI element ${t.name} did not become visible within ${max} s (${locatorToString(effectiveLocator(t))})`)
        }
        return
      }
      case 'wait_seconds':
        await sleep(seconds(value, null) * 1000)
        return

      case 'store_text': {
        const name = needVariable(step)
        const el = await locate(step, def, need(step), n, out)
        vars[name] = await readText(el)
        log(`[${n}] ${name} = ${quote(vars[name])}`)
        return
      }
      case 'store_fixed': {
        const name = needVariable(step)
        vars[name] = value
        log(`[${n}] ${name} = ${quote(value)}`)
        return
      }
      case 'store_url': {
        const name = needVariable(step)
        vars[name] = page.url()
        log(`[${n}] ${name} = ${quote(vars[name])}`)
        return
      }

      case 'if_exists': {
        const t = need(step)
        return !!(await waitForElement(page, effectiveLocator(t), Math.min(IF_WAIT_MS, waitMs)))
      }
      case 'if_variable_equals': {
        const name = needVariable(step)
        return (vars[name] ?? '') === value
      }
      default:
        throw new StepError(`Unknown command ${quote(String(step.command))}`)
    }
  }

  const frames: Frame[] = []
  const executing = (depth = frames.length) => frames.slice(0, depth).every((f) => f.exec)
  const range = opts.range ?? null
  let failed = false
  let aborted = false

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    const n = i + 1
    if (step.disabled) continue
    if (range && (n < range.from || n > range.to)) continue
    const def: CommandDef | undefined = COMMAND_BY_ID[step.command]
    const isIf = step.command === 'if_exists' || step.command === 'if_variable_equals'

    // Branch bookkeeping for steps that are not executed.
    if (isIf && !executing()) {
      frames.push({ exec: false, taken: true })
      continue
    }
    if (step.command === 'else') {
      const top = frames[frames.length - 1]
      // No open frame: a partial run started inside the "If" arm, so its "Otherwise" arm is skipped.
      if (!top) frames.push({ exec: false, taken: true })
      else {
        top.exec = !top.taken
        top.taken = true
      }
      if (!executing(frames.length - 1)) continue
    } else if (step.command === 'end_if') {
      // No open frame: a partial run started inside the branch, so there is nothing to close.
      if (!frames.pop() || !executing()) continue
    } else if (!executing()) continue

    if (await opts.shouldAbort?.()) {
      log(`[${n}] Aborted by user`)
      aborted = true
      break
    }

    const started = Date.now()
    const result: StepResult = { stepId: step.id, number: n, status: 'passed', sentence: stepSentence(step), durationMs: 0 }
    const out: Outcome = {}
    let condition: boolean | void = undefined
    try {
      if (!def) throw new StepError(`Unknown command ${quote(String(step.command))}`)
      let value = step.value ?? ''
      let substitutionError: unknown = null
      try {
        value = substitute(value)
      } catch (e) {
        substitutionError = e
      }
      const args: string[] = []
      if (def.target) args.push(step.target ? `${step.target.name} (${locatorToString(effectiveLocator(step.target))})` : '(no element)')
      if (def.variable) args.push(step.variable ?? '')
      if (def.value !== undefined && (step.value !== undefined || !def.target)) args.push(quote(value))
      log(`[${n}] ${step.command}(${args.join(', ')})`)
      if (substitutionError) throw substitutionError
      if (step.command !== 'else' && step.command !== 'end_if') condition = await execute(step, def, value, n, out)
      if (isIf) {
        frames.push({ exec: condition === true, taken: condition === true })
        log(`[${n}] condition is ${condition === true}`)
      }
      if (out.heal) {
        result.status = 'healed'
        result.heal = out.heal
      }
    } catch (e) {
      result.status = 'failed'
      result.error = e instanceof StepError ? e.message : `Unexpected error: ${firstLine(e)}`
      log(`[${n}] ERROR: ${result.error}`)
      if (out.heal && step.target) healed.delete(targetKey(step.target))
    }
    if (def?.shot) result.screenshotKey = await takeShot()
    result.durationMs = Date.now() - started

    if (result.status === 'failed') {
      failed = true
      for (const earlier of results) {
        if (earlier.heal && earlier.heal.state === 'unresolved') earlier.heal.warning = 'A later step failed after this repair'
      }
    }
    await report(result)
    if (result.status === 'failed' && !(def?.assertion && step.continueOnFailure)) break
    if (result.status === 'failed') log(`[${n}] continuing after the failed assertion`)
  }

  if (aborted) return finish('aborted')
  if (failed) return finish('failed')
  return finish(results.some((r) => r.status === 'healed') ? 'unresolved' : 'succeeded')
}
