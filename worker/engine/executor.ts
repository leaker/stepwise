// Step executor: runs a test case's steps against a Playwright page.
import type { Locator as PwLocator, Page } from '@cloudflare/playwright'
import { BUILT_IN_VARIABLES, COMMAND_BY_ID, stepSentence, SWIPE_DIRECTIONS, validateSteps } from '../../shared/commands'
import type { CommandDef } from '../../shared/commands'
import { positionLabel } from '../../shared/expand'
import { locatorToString } from '../../shared/types'
import type { ElementRef, Fingerprint, HealProposal, Locator, Step, StepResult } from '../../shared/types'
import { findReplacement } from './heal'
import type { RunOptions, RunOutcome } from './index'
import { isRendered, poll, sleep, waitForElement } from './locate'

const IF_WAIT_MS = 2000
const NAVIGATION_TIMEOUT_MS = 30_000
const MAX_FIXED_WAIT_S = 300
/** How far a swipe moves the page, as a share of the viewport. */
const SWIPE_SHARE = 0.7

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
  const vars: Record<string, string> = { ...opts.variables, BASE_URL: opts.baseUrl, BROWSER: 'chrome', DEVICE: opts.device ?? 'desktop' }
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

  // Steps are named as the user sees them: with shared steps expanded, the flat position is not the step number.
  const position = (i: number) => opts.positions?.[i] ?? { number: i + 1 }
  const numbered = (i: number): Pick<StepResult, 'number' | 'sub'> => {
    const p = position(i)
    return p.sub ? { number: p.number, sub: p.sub } : { number: p.number }
  }

  for (const name of BUILT_IN_VARIABLES) {
    if (Object.hasOwn(opts.variables, name)) log(`[warning] the project variable ${name} is ignored: ${name} is built in (its value here is ${quote(vars[name])})`)
  }

  const structural = validateSteps(steps)
  if (structural.length) {
    const seen = new Set<string>()
    for (const problem of structural) {
      const index = steps.findIndex((s) => s.id === problem.stepId)
      log(`[${index < 0 ? '?' : positionLabel(position(index))}] STEP ERROR: ${problem.message}`)
      if (seen.has(problem.stepId) || index < 0) continue
      seen.add(problem.stepId)
      await report({
        stepId: problem.stepId,
        ...numbered(index),
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
      // scale 'css': one image pixel per CSS pixel on every device, so boxes line up and phone shots stay small.
      const bytes = await page.screenshot({ type: 'jpeg', quality: 70, fullPage, animations: 'disabled', scale: 'css', timeout: 15_000 })
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
  const locate = async (step: Step, def: CommandDef, target: ElementRef, n: string, out: Outcome, timeoutMs = waitMs): Promise<PwLocator> => {
    const locator = effectiveLocator(target)
    const found = await waitForElement(page, locator, timeoutMs)
    if (found.el) return found.el
    const missing =
      found.count > 1
        ? `UI element ${target.name} is ambiguous: its locator now matches ${found.count} elements (${locatorToString(locator)})`
        : step.command === 'assert_exists'
          ? `AssertionError: UI element does not exist (${locatorToString(locator)})`
          : `UI element ${target.name} was not found (${locatorToString(locator)})`
    // Nothing was opened yet: no locator can match, and repairing is pointless.
    const blank = page.url() === 'about:blank' && (await page.evaluate(() => !document.body || document.body.childNodes.length === 0).catch(() => false))
    if (blank) throw new StepError(`${missing}. The page is still blank: no Navigate step has run before this step, so add one that opens the page first`)
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
    const handle = (await waitForElement(page, newLocator, 1000)).el
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

  /* eslint-disable @typescript-eslint/no-explicit-any */
  /**
   * Where the page is scrolled to, and where the scrollable areas around a point of the viewport are: a wheel
   * gesture over a scrolling list, or in a layout whose <main> scrolls instead of the window, moves those and
   * leaves the window where it is. `mark` remembers the areas (the element under the point changes as things
   * move); later calls read the same ones.
   */
  const scrollState = (point: { x: number; y: number } | null): Promise<{ x: number; y: number; inner: string }> =>
    page.evaluate(
      ({ point, key }: { point: { x: number; y: number } | null; key: string }) => {
        const win = globalThis as any
        if (point) {
          const areas: any[] = []
          let node = win.document.elementFromPoint(point.x, point.y)
          while (node && node.shadowRoot) {
            const inner = node.shadowRoot.elementFromPoint(point.x, point.y)
            if (!inner || inner === node) break
            node = inner
          }
          for (; node; node = node.parentElement || (node.getRootNode && node.getRootNode().host) || null) {
            if (node === win.document.documentElement || node === win.document.body) continue // the window's own scrolling
            if (node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1) areas.push(node)
          }
          win[key] = areas
        }
        const areas: any[] = win[key] || []
        return { x: Math.round(win.scrollX || 0), y: Math.round(win.scrollY || 0), inner: areas.map((a) => `${Math.round(a.scrollLeft)},${Math.round(a.scrollTop)}`).join(' ') }
      },
      { point, key: '__stepwiseSwipeAreas' },
    )
  /* eslint-enable @typescript-eslint/no-explicit-any */

  /* eslint-disable @typescript-eslint/no-explicit-any */
  /**
   * A native checkbox or radio button that is not rendered itself (`display: none`, or clipped to a
   * pixel, with a styled label drawn in its place) is operated through that label, as a user would.
   */
  const standIn = async (el: PwLocator) => {
    const handle = await el.evaluateHandle((node: any) => {
      if (node.tagName !== 'INPUT' || (node.type !== 'checkbox' && node.type !== 'radio')) return null
      const r = node.getBoundingClientRect()
      if (r.width >= 2 && r.height >= 2 && (globalThis as any).getComputedStyle(node).visibility === 'visible') return null
      return (node.labels && node.labels[0]) || node.closest('label') || null
    })
    return handle.asElement()
  }

  /**
   * What a click at this viewport point would land on, if that is not `el`, something inside it or
   * its label: a short description such as `<div id="cookie-banner">`. Empty when the point hits `el`.
   */
  const blockerAt = (el: PwLocator, x: number, y: number): Promise<string> =>
    el.evaluate(
      (node: any, p: { x: number; y: number }) => {
        let hit = (globalThis as any).document.elementFromPoint(p.x, p.y)
        while (hit && hit.shadowRoot) {
          const inner = hit.shadowRoot.elementFromPoint(p.x, p.y)
          if (!inner || inner === hit) break
          hit = inner
        }
        if (!hit) return 'nothing (the point is outside the viewport)'
        for (let n = hit; n; n = n.parentNode || n.host) if (n === node) return ''
        const label = hit.closest ? hit.closest('label') : null
        if (label && label.control === node) return ''
        const id = hit.getAttribute('id')
        const cls = String(hit.getAttribute('class') || '').trim()
        return '<' + hit.tagName.toLowerCase() + (id ? ' id="' + id + '"' : '') + (cls ? ' class="' + cls.slice(0, 60) + '"' : '') + '>'
      },
      { x, y },
    )
  /* eslint-enable @typescript-eslint/no-explicit-any */

  /** Executes one non-structural step. Returns the branch condition for If commands. */
  const execute = async (step: Step, def: CommandDef, value: string, n: string, out: Outcome): Promise<boolean | void> => {
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
          // On a touch device a click is a tap: the page gets touch events first, then the click.
          const label = await standIn(el)
          if (label) return opts.touch ? label.tap({ timeout: actionTimeout }) : label.click({ timeout: actionTimeout })
          try {
            if (opts.touch) await el.tap({ timeout: actionTimeout })
            else await el.click({ timeout: actionTimeout })
          } catch (e) {
            // The element is there and enabled but the element-based click did not go through
            // (e.g. it never stops moving). Click its centre by coordinates, but only when that
            // point really belongs to the element: a click that lands on an overlay tests nothing.
            const box = await el.boundingBox().catch(() => null)
            const usable = box && (await el.isVisible().catch(() => false)) && (await el.isEnabled().catch(() => false))
            if (!box || !usable) throw e
            const x = Math.round(box.x + box.width / 2)
            const y = Math.round(box.y + box.height / 2)
            const blocker = await blockerAt(el, x, y).catch(() => 'another element')
            if (blocker) throw new StepError(`UI element ${t.name} could not be clicked (${locatorToString(effectiveLocator(t))}): it is covered by ${blocker}`)
            log(`[${n}] [warning] element-based click failed, retrying by coordinates; the target position: (${x}, ${y})`)
            if (opts.touch) await page.touchscreen.tap(x, y)
            else await page.mouse.click(x, y)
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
      case 'uncheck': {
        const want = step.command === 'check'
        await act(need(step), want ? 'checked' : 'unchecked', async (el) => {
          const label = await standIn(el)
          if (!label) return el.setChecked(want, { timeout: actionTimeout })
          if ((await el.isChecked()) !== want) await label.click({ timeout: actionTimeout })
          if ((await el.isChecked()) !== want) throw new Error('clicking its label did not change its state')
        })
        await settle()
        return
      }
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
      case 'swipe': {
        const direction = value.trim().toLowerCase()
        if (!direction) throw new StepError('No direction is set for this step')
        if (!SWIPE_DIRECTIONS.includes(direction)) throw new StepError(`${quote(value)} is not a swipe direction; use up, down, left or right`)
        const size = page.viewportSize() ?? { width: 1280, height: 800 }
        // Directions are the finger's: swiping up drags the page up, which scrolls it down.
        const dx = Math.round(size.width * SWIPE_SHARE) * (direction === 'left' ? 1 : direction === 'right' ? -1 : 0)
        const dy = Math.round(size.height * SWIPE_SHARE) * (direction === 'up' ? 1 : direction === 'down' ? -1 : 0)
        const centre = { x: Math.round(size.width / 2), y: Math.round(size.height / 2) }
        const before = await scrollState(centre)
        const same = (a: { x: number; y: number; inner: string }, b: { x: number; y: number; inner: string }) => a.x === b.x && a.y === b.y && a.inner === b.inner
        // A wheel gesture in the middle of the viewport goes through the browser's input pipeline, so
        // scroll listeners and scroll-snap behave as they do for a real swipe.
        try {
          await page.mouse.move(centre.x, centre.y)
          await page.mouse.wheel(dx, dy)
        } catch (e) {
          log(`[${n}] [warning] wheel gesture failed, scrolling the page instead: ${firstLine(e)}`)
        }
        let after = before
        const moved = await poll(async () => {
          after = await scrollState(null)
          return !same(after, before)
        }, 450)
        // Only when nothing took the gesture: a scrolling area under the finger that moved has consumed it, and
        // scrolling the window as well would move the page twice.
        if (!moved) {
          /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
          await page.evaluate((d: { x: number; y: number }) => (globalThis as any).scrollBy({ left: d.x, top: d.y, behavior: 'instant' }), { x: dx, y: dy })
        }
        // Let a smooth scroll come to rest before the screenshot and the next step.
        for (let i = 0; i < 12; i++) {
          await sleep(100)
          const now = await scrollState(null)
          const still = same(now, after)
          after = now
          if (still) break
        }
        /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
        await page.evaluate((key: string) => void delete (globalThis as any)[key], '__stepwiseSwipeAreas').catch(() => {})
        if (after.x !== before.x || after.y !== before.y) log(`[${n}] scrolled from (${before.x}, ${before.y}) to (${after.x}, ${after.y})`)
        else if (after.inner !== before.inner) log(`[${n}] scrolled an area inside the page from (${before.inner.split(' ').join(') (')}) to (${after.inner.split(' ').join(') (')}); the page itself stayed at (${after.x}, ${after.y})`)
        else log(`[${n}] the page did not move: there is nothing further to show in that direction`)
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
      // "Exists" means rendered, matching what a capture offers: a node that is in the DOM but
      // hidden (an empty error box, a closed dialog) does not exist for the user.
      case 'assert_exists': {
        const t = need(step)
        await locate(step, def, t, n, out)
        if (!(await poll(() => isRendered(page, effectiveLocator(t)), waitMs))) {
          throw new StepError(`AssertionError: UI element is in the page but hidden (${locatorToString(effectiveLocator(t))})`)
        }
        return
      }
      case 'assert_not_exists': {
        const t = need(step)
        const gone = await poll(async () => !(await isRendered(page, effectiveLocator(t))), waitMs)
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
        return !!(await poll(() => isRendered(page, effectiveLocator(t)), Math.min(IF_WAIT_MS, waitMs)))
      }
      case 'if_variable_equals': {
        const name = needVariable(step)
        return (vars[name] ?? '') === value
      }
      case 'shared_step':
        // Calls are replaced by the shared step's steps before a run starts (shared/expand.ts).
        throw new StepError('This shared step call was not expanded, so it cannot run')
      default:
        throw new StepError(`Unknown command ${quote(String(step.command))}`)
    }
  }

  const frames: Frame[] = []
  const executing = (depth = frames.length) => frames.slice(0, depth).every((f) => f.exec)
  const range = opts.range ?? null
  // Partial runs: the steps before the range are replayed silently so the range starts on the right page.
  const setupTo = range && opts.replaySetup ? range.from - 1 : 0
  if (setupTo > 0) log(`Set-up: replaying steps 1-${position(setupTo - 1).number} before the requested range`)
  const blockedMessage = (url: string) => `Navigation to ${url} was blocked: the host is not allowed by this deployment's target policy`
  let failed = false
  let aborted = false

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    const at = i + 1
    const n = positionLabel(position(i))
    if (step.disabled) continue
    // The marker row of an expanded shared step call: its steps follow it in the list.
    if (step.command === 'shared_step' && step.call) continue
    if (range && (at > range.to || (at < range.from && at > setupTo))) continue
    const setup = at <= setupTo
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

    const stop = await opts.shouldAbort?.()
    if (stop) {
      log(`[${n}] ${typeof stop === 'string' ? stop : 'Aborted by user'}`)
      aborted = true
      break
    }

    const started = Date.now()
    const result: StepResult = { stepId: step.id, ...numbered(i), status: 'passed', sentence: stepSentence(step), durationMs: 0 }
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
      const blocked = opts.takeBlockedNavigation?.()
      if (blocked) throw new StepError(blockedMessage(blocked))
      // A step must never pass on a dead page (page.url() and friends keep answering from cache after a crash).
      if (page.isClosed()) throw new StepError('The browser page closed unexpectedly during this step')
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
      // A refused navigation explains the failure better than whatever the step tripped over afterwards.
      const blocked = opts.takeBlockedNavigation?.()
      result.error = blocked ? blockedMessage(blocked) : e instanceof StepError ? e.message : `Unexpected error: ${firstLine(e)}`
      log(`[${n}] ERROR: ${result.error}`)
      if (out.heal && step.target) healed.delete(targetKey(step.target))
    }
    const tolerated = result.status === 'failed' && !!def?.assertion && !!step.continueOnFailure
    // A step that failed or was repaired always gets a screenshot: the report must show the page at that point.
    if (setup ? result.status === 'failed' && !tolerated : def?.shot || result.status !== 'passed') result.screenshotKey = await takeShot()
    result.durationMs = Date.now() - started

    if (setup) {
      // Set-up steps are not part of the report unless one of them stops the run.
      if (result.status !== 'failed') continue
      if (tolerated) {
        log(`[${n}] set-up: continuing after the failed assertion`)
        continue
      }
      result.error = `Set-up failed before the requested steps: ${result.error}`
    }

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
