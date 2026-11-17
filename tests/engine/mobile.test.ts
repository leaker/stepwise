// Device emulation: captures and runs on a phone profile (touch, mobile viewport, device pixel ratio 3).
import { chromium } from 'playwright'
import type { Browser, BrowserContext, Page } from 'playwright'
import type { Server } from 'node:http'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DEVICES } from '../../shared/devices'
import { capture, jpegSize, ref, run, startDemoServer, step } from './helpers'

const iphone = DEVICES.iphone
const phoneContext = { viewport: { ...iphone.viewport }, userAgent: iphone.userAgent, isMobile: iphone.isMobile, hasTouch: iphone.hasTouch, deviceScaleFactor: iphone.deviceScaleFactor }
const PHONE = { device: iphone.id, touch: true } as const

let browser: Browser
let server: Server
let baseUrl: string
let context: BrowserContext
let page: Page

beforeAll(async () => {
  ;({ server, baseUrl } = await startDemoServer())
  browser = await chromium.launch()
})
afterAll(async () => {
  await browser?.close()
  server?.close()
})
beforeEach(async () => {
  context = await browser.newContext(phoneContext)
  page = await context.newPage()
})
afterEach(async () => {
  await context.close()
})

const names = (ui: { elements: { name: string }[] }) => ui.elements.map((e) => e.name)

describe('phone profile', () => {
  it('captures the phone layout in CSS pixels: the navigation is behind the Menu button', async () => {
    await page.goto(baseUrl + 'index.html')
    const home = await capture(page, 'm-home')
    expect(home.width).toBe(iphone.viewport.width)
    // One image pixel per CSS pixel although the device pixel ratio is 3, so boxes line up with the image.
    expect(jpegSize(home.screenshot)).toEqual({ width: home.width, height: home.height })
    expect(names(home)).toContain('"Menu" button')
    expect(names(home)).not.toContain('"Rooms" link')
    for (const el of home.elements) expect(el.box.x + el.box.w).toBeLessThanOrEqual(home.width + 1)

    await page.tap('#nav-toggle')
    const open = await capture(page, 'm-home-open')
    expect(names(open)).toEqual(expect.arrayContaining(['"Home" link', '"Rooms" link', '"Sign in" link']))
    // What the open drawer covers is not offered: it could not be picked on the screenshot or clicked in a run.
    expect(names(home)).toContain('"Wake up to the tide." text')
    expect(names(open)).not.toContain('"Wake up to the tide." text')
    expect(names(open)).toContain('"Menu" button')
    // Below the fold nothing can be judged, so everything is kept.
    expect(names(open)).toContain('"Contact" link')
  })

  it('does not show the Menu button on a desktop viewport', async () => {
    const desktop = await browser.newPage({ viewport: { ...DEVICES.desktop.viewport } })
    await desktop.goto(baseUrl + 'index.html')
    const home = await capture(desktop, 'd-home')
    await desktop.close()
    expect(names(home)).not.toContain('"Menu" button')
    expect(names(home)).toContain('"Rooms" link')
  })

  it('runs a tapped-through scenario: menu, link, form input, swipe, assertions', async () => {
    await page.goto(baseUrl + 'index.html')
    const home = await capture(page, 'm-home')
    await page.tap('#nav-toggle')
    const menu = await capture(page, 'm-menu')
    const signIn = menu.elements.find((e) => e.name === '"Sign in" link' && e.box.y < 400)!
    await page.goto(baseUrl + 'login.html')
    const login = await capture(page, 'm-login')
    await page.goto(baseUrl + 'reserve.html')
    const reserve = await capture(page, 'm-reserve')
    await page.goto('about:blank')

    const steps = [
      step('navigate', { value: 'index.html' }),
      step('click', { target: ref(home, '"Menu" button') }),
      step('click', { target: { uiId: menu.uiId, elementId: signIn.id, name: signIn.name, locator: signIn.locators[0], candidates: signIn.locators, fingerprint: signIn.fingerprint } }),
      step('assert_url_contains', { value: 'login.html' }),
      step('input', { target: ref(login, '"Email" input area'), value: 'demo@example.com' }),
      step('input', { target: ref(login, '"Password" input area'), value: 'demo1234' }),
      step('check', { target: ref(login, '"Remember me" checkbox') }),
      step('click', { target: ref(login, '"Sign in" button') }),
      step('assert_url_contains', { value: 'dashboard.html' }),
      step('navigate', { value: 'reserve.html' }),
      step('swipe', { value: 'up' }),
      step('assert_text_equals', { target: ref(reserve, '"Reserve a room" text'), value: 'Reserve a room' }),
      step('if_variable_equals', { variable: 'DEVICE', value: 'iphone' }),
      step('store_fixed', { variable: 'SEEN', value: 'phone' }),
      step('else'),
      step('store_fixed', { variable: 'SEEN', value: 'other' }),
      step('end_if'),
      step('assert_variable_equals', { variable: 'SEEN', value: 'phone' }),
    ]
    const r = await run(page, steps, baseUrl, PHONE)
    expect(r.log).not.toContain('ERROR')
    expect(r.status).toBe('succeeded')
    // Step screenshots are viewport sized in CSS pixels.
    expect(jpegSize(r.shots[0])).toEqual({ ...iphone.viewport })
    expect(r.results[10].sentence).toBe('Swipe up')
    expect(r.log).toMatch(/\[11\] scrolled from \(0, 0\) to \(0, \d+\)/)
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(100)
  })

  it('fails without the Menu tap: the link is not on the phone screen', async () => {
    const desktop = await browser.newPage({ viewport: { ...DEVICES.desktop.viewport } })
    await desktop.goto(baseUrl + 'index.html')
    const home = await capture(desktop, 'd-home')
    await desktop.close()
    const r = await run(page, [step('navigate', { value: 'index.html' }), step('click', { target: ref(home, '"Reserve" link') })], baseUrl, PHONE)
    expect(r.status).toBe('failed')
    expect(r.results[1].error).toContain('could not be clicked')
  })

  it('swipes in every direction and rejects an unknown one', async () => {
    const r = await run(
      page,
      [step('navigate', { value: 'reserve.html' }), step('swipe', { value: 'up' }), step('swipe', { value: 'down' }), step('swipe', { value: 'down' }), step('swipe', { value: 'left' }), step('swipe', { value: 'sideways' })],
      baseUrl,
      PHONE,
    )
    expect(r.results.map((x) => x.status)).toEqual(['passed', 'passed', 'passed', 'passed', 'passed', 'failed'])
    expect(r.log).toMatch(/\[3\] scrolled from \(0, \d+\) to \(0, 0\)/)
    expect(r.log).toContain('[4] the page did not move')
    expect(r.results[5].error).toContain('is not a swipe direction')
  })

  it('provides DEVICE as desktop by default', async () => {
    const r = await run(page, [step('assert_variable_equals', { variable: 'DEVICE', value: 'desktop' }), step('assert_variable_equals', { variable: 'BROWSER', value: 'chrome' })], baseUrl)
    expect(r.status).toBe('succeeded')
  })
})
