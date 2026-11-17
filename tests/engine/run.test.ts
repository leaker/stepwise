import { chromium } from 'playwright'
import type { Browser, BrowserContext, Page } from 'playwright'
import type { Server } from 'node:http'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Step } from '../../shared/types'
import { capture, jpegSize, ref, run, startDemoServer, step } from './helpers'
import type { CapturedUi } from './helpers'

let browser: Browser
let server: Server
let baseUrl: string
let context: BrowserContext
let page: Page

interface Uis {
  login: CapturedUi
  dashboard: CapturedUi
  reserve: CapturedUi
  confirm: CapturedUi
}
let uis: Uis

/** Walks the v1 site once and captures every screen, like a user building a test would. */
async function captureAll(): Promise<Uis> {
  const p = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await p.goto(baseUrl + 'login.html')
  const login = await capture(p, 'ui-login')
  await p.fill('#email', 'demo@example.com')
  await p.fill('#password', 'demo1234')
  await p.click('#signin-button')
  await p.waitForURL(/dashboard\.html/)
  const dashboard = await capture(p, 'ui-dashboard')
  await p.click('#reserve-link')
  await p.waitForURL(/reserve\.html/)
  const reserve = await capture(p, 'ui-reserve')
  await p.fill('#checkin', '2030-05-01')
  await p.fill('#nights', '2')
  await p.selectOption('#guests', '2')
  await p.check('#breakfast')
  await p.check('#plan-deluxe')
  await p.fill('#guest-name', 'Alice Example')
  await p.fill('#notes', 'Late arrival')
  await p.click('#confirm-button')
  await p.waitForURL(/confirm\.html/)
  const confirm = await capture(p, 'ui-confirm')
  await p.close()
  return { login, dashboard, reserve, confirm }
}

function loginSteps(): Step[] {
  return [
    step('navigate', { value: 'login.html${SUFFIX}' }),
    step('input', { target: ref(uis.login, '"Email" input area'), value: '${EMAIL}' }),
    step('input', { target: ref(uis.login, '"Password" input area'), value: 'demo1234' }),
    step('check', { target: ref(uis.login, '"Remember me" checkbox') }),
    step('click', { target: ref(uis.login, '"Sign in" button') }),
  ]
}

/** 21 steps: sign in, reserve a room, check the confirmation. */
function scenario(): Step[] {
  return [
    ...loginSteps(),
    step('assert_text_equals', { target: ref(uis.dashboard, '"Welcome back, Demo User" text'), value: 'Welcome back, Demo User' }),
    step('click', { target: ref(uis.dashboard, '"Reserve a room" link') }),
    step('input', { target: ref(uis.reserve, '"Check-in date" input area'), value: '2030-05-01' }),
    step('input', { target: ref(uis.reserve, '"Nights" input area'), value: '2' }),
    step('select', { target: ref(uis.reserve, '"Guests" combo box'), value: '2 guests' }),
    step('check', { target: ref(uis.reserve, '"Add breakfast" checkbox') }),
    step('click', { target: ref(uis.reserve, '"Deluxe harbor view" radio button') }),
    step('input', { target: ref(uis.reserve, '"Full name" input area'), value: 'Alice Example' }),
    step('input', { target: ref(uis.reserve, '"Notes for the front desk" text area'), value: 'Late arrival' }),
    step('assert_text_equals', { target: ref(uis.reserve, '"$120.00" text'), value: '$420.00' }),
    step('assert_text_equals', { target: ref(uis.reserve, '"Guests" combo box'), value: '2 guests' }),
    step('click', { target: ref(uis.reserve, '"Confirm reservation" button') }),
    step('assert_url_contains', { value: 'confirm.html' }),
    step('assert_text_equals', { target: ref(uis.confirm, '"Your reservation is confirmed" text'), value: 'Your reservation is confirmed' }),
    step('assert_text_contains', { target: ref(uis.confirm, '"Deluxe harbor view" text'), value: 'harbor' }),
    step('assert_text_equals', { target: ref(uis.confirm, '"$420.00" text'), value: '$420.00' }),
  ]
}

const V1 = { SUFFIX: '', EMAIL: 'demo@example.com' }
const V2 = { SUFFIX: '?ui=v2', EMAIL: 'demo@example.com' }

beforeAll(async () => {
  ;({ server, baseUrl } = await startDemoServer())
  browser = await chromium.launch()
  uis = await captureAll()
})
afterAll(async () => {
  await browser?.close()
  server?.close()
})
beforeEach(async () => {
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  page = await context.newPage()
})
afterEach(async () => {
  await context.close()
})

describe('runSteps', () => {
  it('runs the login -> reserve -> confirm scenario built from captured elements', async () => {
    const steps = scenario()
    const r = await run(page, steps, baseUrl, { variables: V1 })
    expect(r.log).not.toContain('ERROR')
    expect(r.status).toBe('succeeded')
    expect(r.results.map((x) => x.status)).toEqual(steps.map(() => 'passed'))
    expect(r.results.map((x) => x.number)).toEqual(steps.map((_, i) => i + 1))
    expect(r.onStepCalls).toBe(steps.length)
    expect(r.results.every((x) => x.screenshotKey)).toBe(true)
    expect(jpegSize(r.shots[0])).toEqual({ width: 1280, height: 800 })
    expect(r.results[4].sentence).toBe('Click "Sign in" button')
    expect(r.log).toContain(`[1] navigate("login.html")`)
    expect(r.log).toContain('[2] input("Email" input area (id=email), "demo@example.com")')
    expect(r.log).toContain('[5] click("Sign in" button (id=signin-button))')
    expect(page.url()).toBe(baseUrl + 'confirm.html')
  })

  it('fails a wrong assertion with the actual and expected text and stops', async () => {
    const steps = [
      ...loginSteps(),
      step('assert_text_equals', { target: ref(uis.dashboard, '"Welcome back, Demo User" text'), value: 'Welcome back, Bob' }),
      step('click', { target: ref(uis.dashboard, '"Reserve a room" link') }),
    ]
    const r = await run(page, steps, baseUrl, { variables: V1 })
    expect(r.status).toBe('failed')
    expect(r.results).toHaveLength(6)
    expect(r.results[5]).toMatchObject({ status: 'failed', number: 6, error: 'AssertionError: text "Welcome back, Demo User" does not equal "Welcome back, Bob"' })
    expect(r.results[5].screenshotKey).toBeTruthy()
    expect(r.log).toContain('[6] ERROR: AssertionError: text "Welcome back, Demo User" does not equal "Welcome back, Bob"')
    expect(page.url()).toContain('dashboard.html')
  })

  it('continues after a failed assertion when asked to, and still ends failed', async () => {
    const steps = [
      step('navigate', { value: '${BASE_URL}login.html' }),
      step('assert_title_equals', { value: 'Wrong title', continueOnFailure: true }),
      step('assert_text_contains', { target: ref(uis.login, '"Sign in" button'), value: 'Register', continueOnFailure: true }),
      step('assert_title_contains', { value: 'Harbor Inn' }),
      step('assert_url_equals', { value: 'login.html' }),
    ]
    const r = await run(page, steps, baseUrl)
    expect(r.status).toBe('failed')
    expect(r.results.map((x) => x.status)).toEqual(['passed', 'failed', 'failed', 'passed', 'passed'])
    expect(r.results[1].error).toBe('AssertionError: title "Sign in | Harbor Inn" does not equal "Wrong title"')
    expect(r.results[2].error).toBe('AssertionError: text "Sign in" does not contain "Register"')
  })

  it('shows the inline error for wrong credentials and waits for it', async () => {
    const errorPage = await browser.newPage()
    await errorPage.goto(baseUrl + 'login.html')
    await errorPage.fill('#email', 'x@example.com')
    await errorPage.fill('#password', 'nope')
    await errorPage.click('#signin-button')
    const errorUi = await capture(errorPage, 'ui-login-error')
    await errorPage.close()
    const alert = ref(errorUi, '"The email or password is incorrect." text')

    const steps = [
      step('navigate', { value: 'login.html' }),
      step('assert_not_exists', { target: ref(uis.dashboard, '"Sign out" button') }),
      step('input', { target: ref(uis.login, '"Email" input area'), value: 'demo@example.com' }),
      step('input', { target: ref(uis.login, '"Password" input area'), value: 'wrong' }),
      step('press_key', { value: 'Enter' }),
      step('wait_visible', { target: alert, value: '3' }),
      step('assert_visible', { target: alert }),
      step('assert_text_equals', { target: alert, value: 'The email or password is incorrect.' }),
      step('assert_url_contains', { value: 'login.html' }),
    ]
    const r = await run(page, steps, baseUrl)
    expect(r.log).not.toContain('ERROR')
    expect(r.status).toBe('succeeded')
  })

  it('supports variables, nested If / Otherwise / End branch and disabled steps', async () => {
    const steps = [
      step('navigate', { value: 'login.html' }), // 1
      step('store_fixed', { variable: 'ROLE', value: 'guest' }), // 2
      step('if_exists', { target: ref(uis.dashboard, '"Sign out" button') }), // 3 false
      step('store_fixed', { variable: 'WHERE', value: 'dashboard' }), // 4 skipped
      step('if_variable_equals', { variable: 'ROLE', value: 'guest' }), // 5 skipped (nested in a skipped arm)
      step('store_fixed', { variable: 'WHERE', value: 'nested' }), // 6 skipped
      step('end_if'), // 7 skipped
      step('else'), // 8
      step('store_fixed', { variable: 'WHERE', value: 'login' }), // 9
      step('if_variable_equals', { variable: 'ROLE', value: 'guest' }), // 10 true
      step('store_text', { target: ref(uis.login, '"Sign in" button'), variable: 'LABEL' }), // 11
      step('else'), // 12
      step('store_fixed', { variable: 'LABEL', value: 'never' }), // 13 skipped
      step('end_if'), // 14
      step('end_if'), // 15
      step('store_fixed', { variable: 'WHERE', value: 'disabled', disabled: true }), // 16 disabled
      step('assert_variable_equals', { variable: 'WHERE', value: 'login' }), // 17
      step('assert_variable_equals', { variable: 'LABEL', value: 'Sign in' }), // 18
      step('store_url', { variable: 'HERE' }), // 19
      step('assert_variable_equals', { variable: 'HERE', value: '${BASE_URL}login.html' }), // 20
      step('assert_variable_equals', { variable: 'BROWSER', value: 'chrome' }), // 21
      step('input', { target: ref(uis.login, '"Email" input area'), value: '${ROLE}@${NOPE}' }), // 22 fails
      step('comment', { value: 'never reached' }), // 23
    ]
    const r = await run(page, steps, baseUrl)
    expect(r.results.map((x) => x.number)).toEqual([1, 2, 3, 8, 9, 10, 11, 12, 14, 15, 17, 18, 19, 20, 21, 22])
    expect(r.results.slice(0, -1).every((x) => x.status === 'passed')).toBe(true)
    expect(r.results.at(-1)).toMatchObject({ status: 'failed', error: 'Variable ${NOPE} is not defined' })
    expect(r.status).toBe('failed')
    expect(r.log).toContain('[3] condition is false')
    expect(r.log).toContain('[11] LABEL = "Sign in"')
    // Steps that do not touch the page take no screenshot.
    expect(r.results.find((x) => x.number === 2)?.screenshotKey).toBeUndefined()
  })

  it('rejects a broken branch structure before running anything', async () => {
    const steps = [step('navigate', { value: 'login.html' }), step('else'), step('if_variable_equals', { variable: 'A', value: '1' })]
    const r = await run(page, steps, baseUrl)
    expect(r.status).toBe('failed')
    expect(r.results.map((x) => [x.number, x.status, x.error])).toEqual([
      [2, 'failed', 'Step error: "Otherwise" has no matching "If"'],
      [3, 'failed', 'Step error: "If" is missing its "End branch"'],
    ])
    expect(page.url()).toBe('about:blank')
  })

  it('runs only the requested range', async () => {
    const steps = [
      step('navigate', { value: 'reserve.html' }), // 1 (not run: the test opens another page)
      step('store_fixed', { variable: 'NIGHTS', value: '9' }), // 2 not run
      step('if_variable_equals', { variable: 'X', value: 'never' }), // 3 not run
      step('store_fixed', { variable: 'NIGHTS', value: '3' }), // 4
      step('input', { target: ref(uis.reserve, '"Nights" input area'), value: '${NIGHTS}' }), // 5
      step('if_exists', { target: ref(uis.reserve, '"Guests" combo box') }), // 6
      step('select', { target: ref(uis.reserve, '"Guests" combo box'), value: '4' }), // 7 (falls back to the option value)
      step('end_if'), // 8
      step('assert_text_equals', { target: ref(uis.reserve, '"$120.00" text'), value: '$360.00' }), // 9
      step('else'), // 10: closes the arm the range started in
      step('input', { target: ref(uis.reserve, '"Nights" input area'), value: '1' }), // 11 skipped
      step('end_if'), // 12
      step('assert_text_equals', { target: ref(uis.reserve, '"Guests" combo box'), value: '4 guests' }), // 13
      step('assert_title_equals', { value: 'not run' }), // 14 not run
    ]
    await page.goto(baseUrl + 'reserve.html')
    const r = await run(page, steps, baseUrl, { range: { from: 4, to: 13 } })
    expect(r.log).not.toContain('ERROR')
    expect(r.status).toBe('succeeded')
    expect(r.results.map((x) => x.number)).toEqual([4, 5, 6, 7, 8, 9, 10, 12, 13])
  })

  it('replays the steps before the range as set-up when asked to, without reporting them', async () => {
    const steps = [
      ...loginSteps(), // 1-5: set-up
      step('store_fixed', { variable: 'GREETING', value: 'Welcome back, Demo User' }), // 6: set-up
      step('assert_title_equals', { value: 'not the title', continueOnFailure: true }), // 7: set-up, tolerated
      step('assert_text_equals', { target: ref(uis.dashboard, '"Welcome back, Demo User" text'), value: '${GREETING}' }), // 8
      step('assert_title_equals', { value: 'not run' }), // 9: after the range
    ]
    const r = await run(page, steps, baseUrl, { variables: V1, range: { from: 8, to: 8 }, replaySetup: true })
    expect(r.status).toBe('succeeded')
    expect(r.results.map((x) => x.number)).toEqual([8])
    expect(r.shots).toHaveLength(1)
    expect(r.onStepCalls).toBe(1)
    expect(r.log).toContain('Set-up: replaying steps 1-7')
  })

  it('fails a partial run with the set-up step that broke', async () => {
    const steps = [
      step('navigate', { value: 'index.html' }), // 1
      step('click', { target: ref(uis.login, '"Sign in" button') }), // 2: not on this page
      step('assert_url_contains', { value: 'dashboard' }), // 3
    ]
    const r = await run(page, steps, baseUrl, { range: { from: 3, to: 3 }, replaySetup: true })
    expect(r.status).toBe('failed')
    expect(r.results.map((x) => x.number)).toEqual([2])
    expect(r.results[0].error).toBe('Set-up failed before the requested steps: UI element "Sign in" button was not found (id=signin-button)')
    expect(r.results[0].screenshotKey).toBeTruthy()
  })

  it('takes a screenshot of a failed step even when its command normally takes none', async () => {
    const steps = [
      step('navigate', { value: 'index.html' }),
      step('store_fixed', { variable: 'A', value: '1' }),
      step('store_text', { target: ref(uis.login, '"Sign in" button'), variable: 'LABEL' }),
    ]
    const r = await run(page, steps, baseUrl)
    expect(r.status).toBe('failed')
    expect(r.results[1].screenshotKey).toBeUndefined()
    expect(r.results[2].status).toBe('failed')
    expect(r.results[2].screenshotKey).toBe('shot-2')
  })

  it('fails the step during which a top-level navigation was refused', async () => {
    const pending: (string | null)[] = [null, 'http://10.0.0.1/admin']
    const steps = [step('navigate', { value: 'index.html' }), step('assert_title_contains', { value: 'Harbor' }), step('assert_title_contains', { value: 'Harbor' })]
    const r = await run(page, steps, baseUrl, { takeBlockedNavigation: () => pending.shift() ?? null })
    expect(r.status).toBe('failed')
    expect(r.results.map((x) => x.status)).toEqual(['passed', 'failed'])
    expect(r.results[1].error).toBe("Navigation to http://10.0.0.1/admin was blocked: the host is not allowed by this deployment's target policy")
  })

  it('reports a missing element with its name and locator', async () => {
    const steps = [step('navigate', { value: 'index.html' }), step('click', { target: ref(uis.login, '"Sign in" button') })]
    const r = await run(page, steps, baseUrl)
    expect(r.status).toBe('failed')
    expect(r.results[1].error).toBe('UI element "Sign in" button was not found (id=signin-button)')
  })

  it('stops when asked to abort', async () => {
    let calls = 0
    const r = await run(page, scenario(), baseUrl, { variables: V1, shouldAbort: () => ++calls > 3 })
    expect(r.status).toBe('aborted')
    expect(r.results).toHaveLength(3)
  })

  it('logs why it stopped when the reason is not a user abort', async () => {
    const r = await run(page, [step('navigate', { value: 'index.html' })], baseUrl, { shouldAbort: () => 'Stopped: the run is no longer active' })
    expect(r.status).toBe('aborted')
    expect(r.log).toContain('[1] Stopped: the run is no longer active')
    expect(r.log).not.toContain('Aborted by user')
  })
})

describe('self-healing', () => {
  it('fails against the redesigned site when healing is off', async () => {
    const r = await run(page, scenario(), baseUrl, { variables: V2 })
    expect(r.status).toBe('failed')
    expect(r.results).toHaveLength(2)
    expect(r.results[1]).toMatchObject({ status: 'failed', error: 'UI element "Email" input area was not found (id=email)' })
  })

  it('heals the scenario against the redesigned site and ends unresolved', async () => {
    const steps = scenario()
    const r = await run(page, steps, baseUrl, { variables: V2, heal: true })
    expect(r.log).not.toContain('ERROR')
    expect(r.status).toBe('unresolved')
    expect(r.results).toHaveLength(steps.length)
    expect(page.url()).toBe(baseUrl + 'confirm.html?ui=v2')

    const healedIds = r.results.filter((x) => x.status === 'healed').map((x) => x.heal?.newFingerprint.attrs.id ?? x.heal?.newLocator.value)
    expect(healedIds).toEqual([
      'user-email',
      'user-password',
      'keep-signed-in',
      'login-submit',
      'welcome-heading',
      'book-stay',
      'arrival-date',
      'stay-nights',
      'party-size',
      'add-breakfast',
      'room-deluxe',
      'contact-name',
      'special-requests',
      'price-total',
      'submit-reservation',
      'receipt-title',
      'detail-plan',
      'detail-total',
    ])
    // Step 16 reuses the locator healed at step 10 (same element) without a second proposal.
    expect(r.results[15]).toMatchObject({ status: 'passed', number: 16 })
    expect(r.log).toContain('[16] assert_text_equals("Guests" combo box (id=party-size), "2 guests")')

    const button = r.results[4].heal!
    expect(button).toMatchObject({
      state: 'unresolved',
      elementName: '"Sign in" button',
      oldLocator: { key: 'id', value: 'signin-button' },
      newLocator: { key: 'id', value: 'login-submit' },
      before: { uiId: 'ui-login', box: uis.login.elements.find((e) => e.name === '"Sign in" button')!.box },
    })
    expect(button.warning).toBeUndefined()
    expect(button.newFingerprint.text).toBe('Log in to your account')
    expect(button.newCandidates.length).toBeGreaterThan(1)
    expect(button.score).toBeGreaterThan(0.5)
    expect(button.after.screenshotKey).toMatch(/^shot-/)
    expect(button.after.box.w).toBeGreaterThan(50)
    // The "after" screenshot is a full-page one whose size matches the reported page size.
    const afterShot = r.shots[Number(button.after.screenshotKey.slice(5)) - 1]
    expect(jpegSize(afterShot)).toEqual({ width: button.after.width, height: button.after.height })
    for (const x of r.results) {
      if (!x.heal) continue
      expect(await page.locator(`[id="${x.heal.newFingerprint.attrs.id}"]`).count(), x.sentence).toBeLessThanOrEqual(1)
      expect(x.heal.newLocator).toEqual(x.heal.newCandidates[0])
    }
  })

  it('heals by fingerprint alone when no stored fallback locator works', async () => {
    const strip = (s: Step): Step => (s.target ? { ...s, target: { ...s.target, candidates: [s.target.locator] } } : s)
    const steps = [...loginSteps().map(strip), strip(step('assert_text_equals', { target: ref(uis.dashboard, '"Welcome back, Demo User" text'), value: 'Welcome back, Demo User' }))]
    const r = await run(page, steps, baseUrl, { variables: V2, heal: true })
    expect(r.log).not.toContain('ERROR')
    expect(r.status).toBe('unresolved')
    expect(r.results.map((x) => x.heal?.newLocator.value)).toEqual([undefined, 'user-email', 'user-password', 'keep-signed-in', 'login-submit', 'welcome-heading'])
    for (const x of r.results.slice(1)) {
      expect(x.heal!.score, x.sentence).toBeGreaterThanOrEqual(0.55)
      expect(x.heal!.score, x.sentence).toBeLessThan(1)
    }
    expect(r.log).toMatch(/\[5\] HEALED: "Sign in" button id=signin-button -> id=login-submit \(fingerprint match, score 0\.\d\d, now "Log in to your account" button\)/)
  })

  it('does not heal onto an unrelated element and warns about earlier repairs', async () => {
    const steps = [
      ...loginSteps(),
      // The reservation form does not exist on the dashboard at all.
      step('click', { target: ref(uis.reserve, '"Confirm reservation" button') }),
    ]
    const r = await run(page, steps, baseUrl, { variables: V2, heal: true })
    expect(r.status).toBe('failed')
    expect(r.results.at(-1)).toMatchObject({ status: 'failed', error: 'UI element "Confirm reservation" button was not found (id=confirm-button)' })
    expect(r.results.at(-1)?.heal).toBeUndefined()
    expect(r.log).toContain('self-healing gave up')
    const proposals = r.results.filter((x) => x.heal)
    expect(proposals).toHaveLength(4)
    expect(proposals.every((x) => x.heal?.warning === 'A later step failed after this repair')).toBe(true)
  })
})
