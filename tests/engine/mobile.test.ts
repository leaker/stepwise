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

// ---- pages with layers of their own: sticky / fixed bars, and controls drawn over their label ----

const BARS = `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Bars</title>
<style>
  body { margin: 0; background: #fff; font: 16px sans-serif }
  header { position: sticky; top: 0; height: 50px; background: #f00 }
  footer { position: fixed; left: 0; right: 0; bottom: 0; height: 60px; background: #00f }
  main { height: 3000px }
  button { margin: 10px 0 0 60px; height: 30px }
</style>
<header><button id="menu">Menu</button></header><main><p style="margin: 900px 0 0 60px" id="para">Somewhere down the page</p></main><footer><button id="buy">Buy</button></footer>`

/** The rows of a JPEG whose pixel at x is mostly red, and those where it is mostly blue (first and last row of each). */
async function colouredRows(context: BrowserContext, jpeg: Uint8Array, x: number) {
  const probe = await context.newPage()
  try {
    return await probe.evaluate(
      async ({ b64, x }) => {
        const img = new Image()
        img.src = `data:image/jpeg;base64,${b64}`
        await img.decode()
        const canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
        const g = canvas.getContext('2d')!
        g.drawImage(img, 0, 0)
        const column = g.getImageData(x, 0, 1, canvas.height).data
        const span = (is: (r: number, g: number, b: number) => boolean) => {
          let first = -1
          let last = -1
          for (let y = 0; y < canvas.height; y++) {
            if (!is(column[y * 4], column[y * 4 + 1], column[y * 4 + 2])) continue
            if (first < 0) first = y
            last = y
          }
          return { first, last }
        }
        return { red: span((r, g, b) => r > 180 && g < 90 && b < 90), blue: span((r, g, b) => b > 180 && r < 90 && g < 90) }
      },
      { b64: Buffer.from(jpeg).toString('base64'), x },
    )
  } finally {
    await probe.close()
  }
}

describe('captures of a scrolled page with sticky and fixed bars', () => {
  for (const device of [DEVICES.iphone, DEVICES.pixel, DEVICES.desktop]) {
    it(`puts the boxes of the bars where the screenshot shows them (${device.id})`, async () => {
      const ctx = await browser.newContext({ viewport: { ...device.viewport }, isMobile: device.isMobile, hasTouch: device.hasTouch, deviceScaleFactor: device.deviceScaleFactor, ...(device.userAgent ? { userAgent: device.userAgent } : {}) })
      try {
        const p = await ctx.newPage()
        await p.setContent(BARS)
        await p.evaluate(() => window.scrollTo(0, 620))
        const ui = await capture(p, 'bars')
        const rows = await colouredRows(ctx, ui.screenshot, 5)
        const menu = ui.elements.find((e) => e.name === '"Menu" button')!
        const buy = ui.elements.find((e) => e.name === '"Buy" button')!
        expect(rows.red.first).toBeGreaterThanOrEqual(0)
        expect(rows.blue.first).toBeGreaterThanOrEqual(0)
        // Each button lies inside the band of its bar (JPEG edges are soft: allow a few pixels).
        expect(menu.box.y).toBeGreaterThanOrEqual(rows.red.first - 3)
        expect(menu.box.y + menu.box.h).toBeLessThanOrEqual(rows.red.last + 4)
        expect(buy.box.y).toBeGreaterThanOrEqual(rows.blue.first - 3)
        expect(buy.box.y + buy.box.h).toBeLessThanOrEqual(rows.blue.last + 4)
        // An element in the normal flow is where it always was, and the page is left where it was.
        const para = ui.elements.find((e) => e.name.includes('Somewhere down the page'))!
        expect(Math.abs(para.box.y - (50 + 900))).toBeLessThanOrEqual(2)
        expect(await p.evaluate(() => window.scrollY)).toBe(620)
      } finally {
        await ctx.close()
      }
    })
  }
})

describe('a native checkbox laid transparently over its label', () => {
  it('is still offered by a capture (checkbox-hack menus, custom switches)', async () => {
    await page.setContent(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Toggle</title>
      <style>
        .dropdown { position: relative; display: inline-block; margin: 40px }
        .dropdown input { position: absolute; top: 0; left: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer }
        .dropdown label { display: block; padding: 8px 14px; border: 1px solid #888 }
        .cover { position: fixed; left: 0; right: 0; top: 200px; height: 80px; background: #ccc }
        #under { position: absolute; top: 220px; left: 40px }
      </style>
      <div class="dropdown"><input type="checkbox" id="main-menu" aria-label="Main menu"><label for="main-menu">Main menu</label></div>
      <button id="under">Hidden under the bar</button><div class="cover"></div>`)
    const ui = await capture(page, 'toggle')
    const toggle = ui.elements.find((e) => e.type === 'checkbox')
    expect(toggle, names(ui).join(' | ')).toBeDefined()
    expect(toggle!.name).toContain('Main menu')
    // The filter still does its job for something that really is in the way.
    expect(names(ui).join(' | ')).not.toContain('Hidden under the bar')

    const r = await run(page, [step('check', { target: { uiId: 'toggle', elementId: toggle!.id, name: toggle!.name, locator: toggle!.locators[0], candidates: toggle!.locators, fingerprint: toggle!.fingerprint } })], baseUrl, PHONE)
    expect(r.log).not.toContain('ERROR')
    expect(await page.evaluate(() => (document.getElementById('main-menu') as HTMLInputElement).checked)).toBe(true)
  })
})

describe('swipe over a scrolling area', () => {
  it('moves the area under the finger once, and leaves the window alone', async () => {
    await page.setContent(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>List</title>
      <style>body { margin: 0 } #list { height: 600px; margin-top: 126px; overflow: auto } #list div { height: 4000px } #tail { height: 3000px }</style>
      <div id="list"><div>rows</div></div><div id="tail">more</div>`)
    const r = await run(page, [step('swipe', { value: 'up' })], baseUrl, PHONE)
    expect(r.status).toBe('succeeded')
    const pos = await page.evaluate(() => ({ window: window.scrollY, list: document.getElementById('list')!.scrollTop }))
    expect(pos.list).toBeGreaterThan(300)
    expect(pos.window).toBe(0)
    expect(r.log).toMatch(/\[1\] scrolled an area inside the page from \(0,0\) to \(0,\d+\)/)
  })

  it('reports the move in an app-shell layout, where <main> scrolls and the window cannot', async () => {
    await page.setContent(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Shell</title>
      <style>html, body { height: 100%; margin: 0; overflow: hidden } main { height: 100%; overflow-y: auto } main div { height: 5000px }</style>
      <main><div>content</div></main>`)
    const r = await run(page, [step('swipe', { value: 'up' }), step('swipe', { value: 'down' }), step('swipe', { value: 'down' })], baseUrl, PHONE)
    expect(r.status).toBe('succeeded')
    expect(r.log).toMatch(/\[1\] scrolled an area inside the page/)
    expect(r.log).toMatch(/\[2\] scrolled an area inside the page/)
    expect(r.log).toContain('[3] the page did not move')
    expect(await page.evaluate(() => document.querySelector('main')!.scrollTop)).toBe(0)
  })
})

describe('built-in variables', () => {
  it('win over a project variable of the same name, and the log says so', async () => {
    const r = await run(page, [step('assert_variable_equals', { variable: 'DEVICE', value: 'iphone' })], baseUrl, { ...PHONE, variables: { DEVICE: 'tablet' } })
    expect(r.status).toBe('succeeded')
    expect(r.log).toContain('[warning] the project variable DEVICE is ignored: DEVICE is built in (its value here is "iphone")')
  })
})
