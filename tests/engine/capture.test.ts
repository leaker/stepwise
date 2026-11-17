import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import type { Server } from 'node:http'
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest'
import { toSelector } from '../../worker/engine/locate'
import { capture, element, jpegSize, startDemoServer } from './helpers'
import type { CapturedUi } from './helpers'

let browser: Browser
let server: Server
let baseUrl: string
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
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
})
afterEach(async () => {
  await page.close()
})

/** Every element must have locators that each resolve to exactly one node, at the element's box. */
async function expectSoundLocators(ui: CapturedUi) {
  expect(ui.elements.length).toBeGreaterThan(5)
  expect(new Set(ui.elements.map((e) => e.id)).size).toBe(ui.elements.length)
  for (const e of ui.elements) {
    expect(e.locators.length, e.name).toBeGreaterThan(0)
    expect(e.box.w, e.name).toBeGreaterThan(0)
    expect(e.box.x + e.box.w, e.name).toBeLessThanOrEqual(ui.width + 1)
    expect(e.box.y + e.box.h, e.name).toBeLessThanOrEqual(ui.height + 1)
    for (const l of e.locators) {
      const handle = page.locator(toSelector(l))
      expect(await handle.count(), `${e.name} ${l.key}=${l.value}`).toBe(1)
      const box = await handle.evaluate((node) => {
        const r = node.getBoundingClientRect()
        return { x: Math.round(r.left + window.scrollX), y: Math.round(r.top + window.scrollY) }
      })
      expect(box, `${e.name} ${l.key}=${l.value}`).toEqual({ x: e.box.x, y: e.box.y })
    }
  }
}

async function signIn() {
  await page.goto(baseUrl + 'login.html')
  await page.fill('#email', 'demo@example.com')
  await page.fill('#password', 'demo1234')
  await page.click('#signin-button')
  await page.waitForURL(/dashboard\.html/)
}

describe('captureUi', () => {
  it('captures the landing page with a matching full-page screenshot', async () => {
    await page.goto(baseUrl + 'index.html')
    const ui = await capture(page, 'index')
    await expectSoundLocators(ui)
    const size = jpegSize(ui.screenshot)
    expect(size).toEqual({ width: ui.width, height: ui.height })
    expect(ui.height).toBeGreaterThan(800)

    const names = ui.elements.map((e) => e.name)
    for (const name of ['"Home" link', '"Rooms" link', '"Reserve a room" link', '"Harbor Inn" link', '"Standard room" image', '"Wake up to the tide." text', '"$120 per night" text']) {
      expect(names, name).toContain(name)
    }
    // Duplicate texts stay separate elements with distinct, unique locators.
    expect(names.filter((n) => n === '"View plan" link')).toHaveLength(3)
    expect(names.filter((n) => n === '"Sign in" link')).toHaveLength(2)
    expect(names.filter((n) => n === '"Reserve" link')).toHaveLength(2)
    expect(element(ui, '"Reserve a room" link').locators[0]).toEqual({ key: 'id', value: 'cta-reserve' })
    expect(ui.elements.filter((e) => e.name === '"View plan" link').map((e) => e.locators[0].value)).toEqual([
      'a[href="reserve.html#plan=standard"]',
      'a[href="reserve.html#plan=deluxe"]',
      'a[href="reserve.html#plan=suite"]',
    ])
    // The logo sits inside the brand link, so it is not offered a second time.
    expect(names).not.toContain('"Harbor Inn logo" image')
  })

  it('names form controls by their labels on the login page', async () => {
    await page.goto(baseUrl + 'login.html')
    const ui = await capture(page, 'login')
    await expectSoundLocators(ui)
    const email = element(ui, '"Email" input area')
    expect(email.type).toBe('input')
    expect(email.locators[0]).toEqual({ key: 'id', value: 'email' })
    expect(email.locators.map((l) => `${l.key}=${l.value}`)).toEqual(
      expect.arrayContaining(['css=input[name="email"]', 'css=input[placeholder="you@example.com"]', 'css=input[type="email"]']),
    )
    expect(email.fingerprint).toMatchObject({ tag: 'input', type: 'input', label: 'Email', text: '', path: 'body>main>div>form>div>input' })
    expect(email.fingerprint.attrs).toMatchObject({ id: 'email', name: 'email', type: 'email', placeholder: 'you@example.com' })

    expect(element(ui, '"Password" input area').locators[0]).toEqual({ key: 'id', value: 'password' })
    expect(element(ui, '"Remember me" checkbox').type).toBe('checkbox')
    const button = element(ui, '"Sign in" button')
    expect(button.locators.map((l) => `${l.key}=${l.value}`)).toEqual(expect.arrayContaining(['id=signin-button', "xpath=//button[text()='Sign in']"]))
    expect(button.fingerprint.text).toBe('Sign in')

    const names = ui.elements.map((e) => e.name)
    expect(names).toContain('"Sign in" text') // the heading
    // Labels of inputs are not separate elements, and the empty alert is not offered.
    expect(names).not.toContain('"Email" text')
    expect(names).not.toContain('"Remember me" text')
    expect(ui.elements.some((e) => e.fingerprint.attrs.role === 'alert')).toBe(false)
  })

  it('detects an inline alert once it is shown', async () => {
    await page.goto(baseUrl + 'login.html')
    await page.fill('#email', 'nobody@example.com')
    await page.fill('#password', 'wrong')
    await page.click('#signin-button')
    const ui = await capture(page, 'login-error')
    const alert = element(ui, '"The email or password is incorrect." text')
    expect(alert.locators[0]).toEqual({ key: 'id', value: 'login-error' })
  })

  it('captures the dashboard', async () => {
    await signIn()
    const ui = await capture(page, 'dashboard')
    await expectSoundLocators(ui)
    const names = ui.elements.map((e) => e.name)
    for (const name of ['"Welcome back, Demo User" text', '"Reserve a room" link', '"Sign out" button', '"Signed in as demo@example.com" text', '"Deluxe harbor view" text']) {
      expect(names, name).toContain(name)
    }
  })

  it('captures the reservation form and the confirmation page', async () => {
    await page.goto(baseUrl + 'reserve.html')
    const ui = await capture(page, 'reserve')
    await expectSoundLocators(ui)
    const types = Object.fromEntries(ui.elements.map((e) => [e.name, e.type]))
    expect(types).toMatchObject({
      '"Check-in date" input area': 'input',
      '"Nights" input area': 'input',
      '"Guests" combo box': 'select',
      '"Add breakfast" checkbox': 'checkbox',
      '"Standard room" radio button': 'radio',
      '"Deluxe harbor view" radio button': 'radio',
      '"Full name" input area': 'input',
      '"Notes for the front desk" text area': 'textarea',
      '"Confirm reservation" button': 'button',
      '"$120.00" text': 'text',
    })
    expect(element(ui, '"Deluxe harbor view" radio button').locators.map((l) => `${l.key}=${l.value}`)).toContain('css=input[name="plan"][value="deluxe"]')
    // A price is volatile text: the text XPath must not be the recommended locator.
    expect(element(ui, '"$120.00" text').locators[0]).toEqual({ key: 'id', value: 'total' })

    await page.fill('#checkin', '2030-05-01')
    await page.fill('#guest-name', 'Alice Example')
    await page.click('#confirm-button')
    await page.waitForURL(/confirm\.html/)
    const done = await capture(page, 'confirm')
    await expectSoundLocators(done)
    const names = done.elements.map((e) => e.name)
    for (const name of ['"Your reservation is confirmed" text', '"Alice Example" text', '"Back to home" link']) expect(names, name).toContain(name)
  })
})
