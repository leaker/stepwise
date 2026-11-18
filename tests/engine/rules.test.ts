// Engine rules that do not need the demo scenario: URL resolution, variables, partial runs, waits,
// a page that goes away, and how much of a value ends up in messages.
import { chromium } from 'playwright'
import type { Browser, BrowserContext, Page } from 'playwright'
import type { Server } from 'node:http'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ElementRef } from '../../shared/types'
import { run, startDemoServer, step } from './helpers'

let browser: Browser
let server: Server
/** As a project stores it: no trailing slash. */
let base: string
let origin: string
let context: BrowserContext
let page: Page

const target = (id: string): ElementRef => ({
  uiId: 'ui',
  elementId: id,
  name: `"${id}" element`,
  locator: { key: 'id', value: id },
  candidates: [{ key: 'id', value: id }],
  fingerprint: { tag: 'div', type: 'text', text: '', label: '', attrs: {}, path: '', box: { x: 0, y: 0, w: 10, h: 10 } },
})
const html = (body: string) => `data:text/html,${encodeURIComponent(`<!doctype html><title>t</title><body>${body}</body>`)}`

beforeAll(async () => {
  browser = await chromium.launch()
  const started = await startDemoServer()
  server = started.server
  base = started.baseUrl.replace(/\/$/, '')
  origin = new URL(base).origin
})
afterAll(async () => {
  await browser.close()
  await new Promise((done) => server.close(done))
})
beforeEach(async () => {
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  page = await context.newPage()
})
afterEach(async () => {
  await context.close()
})

describe('relative URLs', () => {
  it('are appended to a base URL that has a path, with or without a leading slash', async () => {
    const r = await run(page, [step('navigate', { value: 'login.html' }), step('assert_url_equals', { value: 'login.html' }), step('navigate', { value: '/index.html' }), step('assert_url_equals', { value: '/index.html' })], base)
    expect(r.log).not.toContain('ERROR')
    expect(r.status).toBe('succeeded')
    expect(page.url()).toBe(`${base}/index.html`)
  })

  it('never name another host', async () => {
    const r = await run(page, [step('navigate', { value: '//other.example/x' })], base)
    expect(r.results[0].error).toBe('Invalid URL "//other.example/x"')
    expect(page.url()).toBe('about:blank')
  })
})

describe('Assert URL equals', () => {
  it('takes two spellings of the same URL as equal', async () => {
    const steps = [
      step('navigate', { value: '${BASE_URL}' }),
      step('assert_url_equals', { value: '${BASE_URL}' }), // the browser reports it with a trailing slash
      step('assert_url_equals', { value: origin.replace('http://', 'HTTP://') }),
      step('assert_url_equals', { value: '${BASE_URL}/demo' }),
    ]
    const r = await run(page, steps, origin)
    expect(r.results.map((x) => x.status)).toEqual(['passed', 'passed', 'passed', 'failed'])
    expect(r.results[3].error).toBe(`AssertionError: URL "${origin}/" does not equal "${origin}/demo"`)
  })
})

describe('variables', () => {
  it('do not find the names every object has, and can be stored under them', async () => {
    const steps = [
      step('if_variable_equals', { variable: 'constructor', value: '' }), // undefined compares as empty
      step('store_fixed', { variable: '__proto__', value: 'kept' }),
      step('end_if'),
      step('assert_variable_equals', { variable: '__proto__', value: 'kept' }),
      step('store_fixed', { variable: 'COPY', value: '${__proto__}' }),
      step('assert_variable_equals', { variable: 'COPY', value: 'kept' }),
      step('store_fixed', { variable: 'X', value: '${constructor}' }),
    ]
    const r = await run(page, steps, base)
    expect(r.results.map((x) => x.status)).toEqual(['passed', 'passed', 'passed', 'passed', 'passed', 'passed', 'failed'])
    expect(r.results.at(-1)?.error).toBe('Variable ${constructor} is not defined')
  })

  it('are not looked up in a comment', async () => {
    const r = await run(page, [step('comment', { value: 'log in as ${USER}, costs ${' }), step('store_fixed', { variable: 'A', value: '1' })], base)
    expect(r.status).toBe('succeeded')
    expect(r.log).toContain('[1] comment("log in as ${USER}, costs ${")')
  })
})

describe('partial runs and the branch structure', () => {
  const building = () => [
    step('store_fixed', { variable: 'A', value: '1' }), // 1
    step('if_variable_equals', { variable: 'A', value: '1' }), // 2: not closed yet
    step('store_fixed', { variable: 'B', value: 'in' }), // 3
    step('if_variable_equals', { variable: 'A', value: '2' }), // 4: not closed either
    step('store_fixed', { variable: 'B', value: 'skipped' }), // 5
  ]

  it('run the steps before a branch that is not closed yet', async () => {
    const r = await run(page, building(), base, { range: { from: 1, to: 1 }, replaySetup: true })
    expect(r.status).toBe('succeeded')
    expect(r.results.map((x) => x.number)).toEqual([1])
  })

  it('run into a branch that is not closed yet, following its condition', async () => {
    const r = await run(page, building(), base, { range: { from: 1, to: 5 }, replaySetup: true })
    expect(r.status).toBe('succeeded')
    expect(r.results.map((x) => x.number)).toEqual([1, 2, 3, 4])
    expect(r.log).toContain('[5] skipped: it is in an arm of the "If" at step 4 that this run did not take')
    // The whole list is still refused.
    const whole = await run(page, building(), base)
    expect(whole.status).toBe('failed')
    expect(whole.stoppedBy?.error).toBe('Step error: "If" is missing its "End branch"')
  })

  it('still refuse an "End branch" without an "If" among the steps they execute', async () => {
    const steps = [step('store_fixed', { variable: 'A', value: '1' }), step('end_if'), step('store_fixed', { variable: 'B', value: '1' })]
    const r = await run(page, steps, base, { range: { from: 3, to: 3 }, replaySetup: true })
    expect(r.status).toBe('failed')
    expect(r.results.map((x) => x.error)).toEqual(['Step error: "End branch" has no matching "If"'])
  })

  it('say why when none of the requested steps ran', async () => {
    const steps = [
      step('store_fixed', { variable: 'RESULT', value: 'ok' }), // 1
      step('if_variable_equals', { variable: 'RESULT', value: 'ok' }), // 2
      step('comment', { value: 'fine' }), // 3
      step('else'), // 4
      step('assert_title_equals', { value: 'never checked' }), // 5
      step('end_if'), // 6
      step('assert_title_equals', { value: 'never checked', disabled: true }), // 7
    ]
    const inBranch = await run(page, steps, base, { range: { from: 5, to: 5 }, replaySetup: true })
    expect(inBranch.status).toBe('succeeded')
    expect(inBranch.results).toEqual([])
    expect(inBranch.log).toContain('[5] skipped: it is in an arm of the "If" at step 2 that this run did not take')
    expect(inBranch.log).toContain('None of the requested steps was executed')

    const disabled = await run(page, steps, base, { range: { from: 7, to: 7 }, replaySetup: true })
    expect(disabled.results).toEqual([])
    expect(disabled.log).toContain('[7] skipped: the step is disabled')
  })

  it('name the step that ended the run, but not an assertion that was set to continue', async () => {
    const tolerated = await run(page, [step('assert_title_equals', { value: 'no', continueOnFailure: true }), step('comment', { value: 'reached' })], base)
    expect(tolerated.status).toBe('failed')
    expect(tolerated.results).toHaveLength(2)
    expect(tolerated.stoppedBy).toBeUndefined()

    const stopped = await run(page, [step('assert_title_equals', { value: 'no' }), step('comment', { value: 'not reached' })], base)
    expect(stopped.results).toHaveLength(1)
    expect(stopped.stoppedBy).toBe(stopped.results[0])
  })
})

describe('fixed waits', () => {
  it('sleep in slices with a command in between, for as long as asked', async () => {
    const started = Date.now()
    const r = await run(page, [step('wait_seconds', { value: '0.4' })], base, { waitSliceMs: 50 })
    expect(r.status).toBe('succeeded')
    expect(Date.now() - started).toBeGreaterThanOrEqual(400)
  })

  it('refuse a wait that is too long or has no number, instead of shortening it', async () => {
    const long = await run(page, [step('wait_seconds', { value: '600' })], base)
    expect(long.results[0].error).toBe('"600" seconds is more than a step can wait: the longest wait is 300 seconds')
    const empty = await run(page, [step('store_fixed', { variable: 'N', value: '' }), step('wait_seconds', { value: '${N}' })], base)
    expect(empty.results[1].error).toBe('No number of seconds is set for this step')
  })
})

describe('a page that is gone', () => {
  it('is what a step that looks for an element reports, without waiting for the element', async () => {
    for (const command of ['click', 'assert_exists', 'assert_not_exists', 'assert_text_equals'] as const) {
      const ctx = await browser.newContext()
      const p = await ctx.newPage()
      const started = Date.now()
      const r = await run(p, [step('navigate', { value: html('<div id="a">a</div>') }), step(command, { target: target('a'), value: 'a' })], base, {
        waitSeconds: 8,
        heal: true,
        onStep: async (result) => {
          if (result.number === 1) await p.close()
        },
      })
      expect(r.results.at(-1)?.error, command).toBe('The browser page closed unexpectedly during this step')
      expect(r.log).not.toContain('self-healing')
      expect(Date.now() - started).toBeLessThan(6000)
      await ctx.close()
    }
  })
})

describe('long values', () => {
  it('are cut in messages and in the log, and kept whole in the variable', async () => {
    const text = 'x'.repeat(5000)
    const steps = [
      step('navigate', { value: html(`<div id="big">${text}</div>`) }),
      step('store_text', { variable: 'BIG', target: target('big') }),
      step('assert_variable_equals', { variable: 'BIG', value: text }),
      step('assert_text_contains', { target: target('big'), value: 'missing', continueOnFailure: true }),
      step('assert_text_equals', { target: target('big'), value: '${BIG}y' }),
    ]
    const r = await run(page, steps, base)
    expect(r.results.map((x) => x.status)).toEqual(['passed', 'passed', 'passed', 'failed', 'failed'])
    expect(r.results[3].error).toBe(`AssertionError: text "${'x'.repeat(300)}"… (5000 characters) does not contain "missing"`)
    expect(r.results[4].error!.length).toBeLessThan(800)
    expect(r.log.length).toBeLessThan(8000)
  })
})
