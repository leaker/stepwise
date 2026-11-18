// Pages that changed in ways a test tool must not paper over: a different element where the old
// one was, a locator that stopped being unique, hidden nodes, overlays. Plus markup that is common
// on real sites but absent from the demo site (custom checkboxes, shadow DOM, clickable divs).
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import type { Server } from 'node:http'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ElementRef, Fingerprint, Locator } from '../../shared/types'
import { isSpecificLocator, sameIdentity, similarity } from '../../worker/engine/heal'
import { capture, element, ref, run, startDemoServer, step } from './helpers'

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

const html = (body: string, head = '') => `<!doctype html><html><head><title>start</title>${head}</head><body>${body}</body></html>`
const strings = (locators: Locator[]) => locators.map((l) => `${l.key}=${l.value}`)
/** The same step target, but saved with another of its candidate locators. */
const using = (target: ElementRef, locator: string): ElementRef => {
  const chosen = target.candidates.find((c) => `${c.key}=${c.value}` === locator)
  if (!chosen) throw new Error(`${target.name} has no locator ${locator}: ${strings(target.candidates).join(' | ')}`)
  return { ...target, locator: chosen }
}

describe('self-healing does not accept a different element', () => {
  const form = (button: string) => html(`<main><form onsubmit="return false"><input name="email" placeholder="Email">${button}</form></main>`)

  it('refuses the unrelated button that a generic fallback locator now points at', async () => {
    await page.setContent(form(`<button type="submit" id="signin" class="btn btn-primary" onclick="document.title='SIGNED IN'">Sign in</button>`))
    const ui = await capture(page, 'ui')
    const target = ref(ui, '"Sign in" button')
    expect(strings(target.candidates)).toContain('css=button[type="submit"]')

    await page.setContent(form(`<button type="submit" class="danger" onclick="document.title='DELETED'">Delete account</button>`))
    const r = await run(page, [step('click', { target })], baseUrl, { heal: true })
    expect(r.status).toBe('failed')
    expect(r.results[0]).toMatchObject({ status: 'failed', error: 'UI element "Sign in" button was not found (id=signin)' })
    expect(r.results[0].heal).toBeUndefined()
    expect(r.log).toContain('self-healing gave up')
    expect(await page.title()).toBe('start')
  })

  it('reports the real similarity when a stored fallback locator finds the element', async () => {
    await page.setContent(form(`<button type="submit" id="signin" class="btn btn-primary" onclick="document.title='SIGNED IN'">Sign in</button>`))
    const target = ref(await capture(page, 'ui'), '"Sign in" button')

    await page.setContent(form(`<button type="submit" id="login-submit" class="btn btn-primary" onclick="document.title='SIGNED IN'">Sign in</button>`))
    const r = await run(page, [step('click', { target })], baseUrl, { heal: true })
    expect(r.status).toBe('unresolved')
    const heal = r.results[0].heal!
    expect(heal.newLocator).toEqual({ key: 'id', value: 'login-submit' })
    expect(heal.score).toBeGreaterThan(0.8)
    expect(heal.score).toBeLessThan(1)
    expect(r.log).toMatch(/HEALED: .* \(stored fallback locator, score 0\.\d\d, now "Sign in" button\)/)
    expect(await page.title()).toBe('SIGNED IN')
  })

  it('only trusts fallback locators that name the element', () => {
    const specific = ['id=signin', 'css=button[name="go"]', 'css=a[href="/cart"]', 'css=button.btn-primary', "xpath=//button[text()='Sign in']", "xpath=//p[normalize-space()='Total due']"]
    const generic = ['css=button[type="submit"]', 'css=input[type="email"]', "xpath=(//button[text()='Sign in'])[2]", "xpath=(//a[contains(@class,'nav')])[3]", 'xpath=//button', 'xpath=/html/body/main/p[2]']
    const parse = (s: string): Locator => ({ key: s.slice(0, s.indexOf('=')) as Locator['key'], value: s.slice(s.indexOf('=') + 1) })
    expect(specific.filter((s) => !isSpecificLocator(parse(s)))).toEqual([])
    expect(generic.filter((s) => isSpecificLocator(parse(s)))).toEqual([])
  })

  it('does not turn a failed "exists" assertion into a repair when another message took its place', async () => {
    await page.setContent(html(`<main><p id="flash" class="notice">Your reservation is confirmed</p></main>`))
    const target = ref(await capture(page, 'ui'), '"Your reservation is confirmed" text')

    await page.setContent(html(`<main><p class="error">Payment failed. Please try again later</p></main>`))
    const r = await run(page, [step('assert_exists', { target })], baseUrl, { heal: true })
    expect(r.status).toBe('failed')
    expect(r.results[0]).toMatchObject({ status: 'failed', error: 'AssertionError: UI element does not exist (id=flash)' })
    expect(r.results[0].heal).toBeUndefined()

    // The same message, reworded and without its id, is still the same element.
    await page.setContent(html(`<main><p class="notice">Your reservation is confirmed!</p></main>`))
    const again = await run(page, [step('assert_exists', { target: { ...target, candidates: [target.locator] } })], baseUrl, { heal: true })
    expect(again.status).toBe('unresolved')
    expect(again.results[0].heal?.newFingerprint.text).toBe('Your reservation is confirmed!')
  })

  it('needs a text, label, attribute or class to carry over, not just the same spot', () => {
    const box = { x: 100, y: 100, w: 200, h: 40 }
    const fp = (over: Partial<Fingerprint>): Fingerprint => ({ tag: 'p', type: 'text', text: '', label: '', attrs: {}, path: 'body>main>p', box, ...over })
    const stored = fp({ text: 'Your reservation is confirmed' })
    expect(similarity(stored, fp({ text: 'Payment failed. Please try again later' }))).toBe(0)
    expect(similarity(stored, fp({ text: 'Your reservation is confirmed.' }))).toBeGreaterThan(0.9)

    const button = fp({ tag: 'button', type: 'button', text: 'Sign in', path: 'body>form>button', attrs: { type: 'submit', class: 'btn btn-primary btn-block' } })
    const live = (text: string, cls: string) => fp({ ...button, text, attrs: { type: 'submit', class: cls } })
    expect(sameIdentity(button, live('Delete account', 'danger'))).toBe(false)
    expect(sameIdentity(button, live('Log in to your account', 'btn btn-solid btn-block'))).toBe(true)
    expect(sameIdentity(button, live('Sign in now', 'cta'))).toBe(true)
    // Nothing identifying was stored: only the score can decide.
    expect(sameIdentity(fp({ tag: 'input', type: 'input' }), fp({ tag: 'input', type: 'input' }))).toBe(true)
  })
})

describe('a locator that matches several elements', () => {
  const signIn = `<main><form onsubmit="return false"><input type="email" placeholder="Email"><button type="submit" class="btn" onclick="document.title='SIGNED IN'">Sign in</button></form></main>`
  const search = `<header><form onsubmit="return false"><input type="search" placeholder="Search"><button type="submit" onclick="document.title='SEARCH'">Go</button></form></header>`

  it('ranks tag[type=...] below text and class locators', async () => {
    await page.setContent(html(signIn))
    const button = element(await capture(page, 'ui'), '"Sign in" button')
    expect(strings(button.locators).slice(0, 3)).toEqual(["xpath=//button[text()='Sign in']", 'css=button.btn', 'css=button[type="submit"]'])
  })

  it('fails instead of acting on the first match', async () => {
    await page.setContent(html(signIn))
    const target = using(ref(await capture(page, 'ui'), '"Sign in" button'), 'css=button[type="submit"]')

    await page.setContent(html(search + signIn))
    const r = await run(page, [step('click', { target })], baseUrl)
    expect(r.status).toBe('failed')
    expect(r.results[0].error).toBe('UI element "Sign in" button is ambiguous: its locator now matches 2 elements (css=button[type="submit"])')
    expect(await page.title()).toBe('start')
  })

  it('is repaired like a missing element when healing is on', async () => {
    await page.setContent(html(signIn))
    const target = using(ref(await capture(page, 'ui'), '"Sign in" button'), 'css=button[type="submit"]')

    await page.setContent(html(search + signIn))
    const r = await run(page, [step('click', { target })], baseUrl, { heal: true })
    expect(r.status).toBe('unresolved')
    expect(r.results[0].heal).toMatchObject({ oldLocator: { key: 'css', value: 'button[type="submit"]' }, newLocator: { key: 'xpath', value: "//button[text()='Sign in']" } })
    expect(await page.title()).toBe('SIGNED IN')
  })
})

describe('"exists" means the user can see it', () => {
  it('treats the empty, hidden error box of the demo login page as absent', async () => {
    await page.goto(baseUrl + 'login.html')
    await page.click('#signin-button')
    const ui = await capture(page, 'ui-login-error')
    const error = ref(ui, '"Enter your email and password." text')
    expect(error.locator).toEqual({ key: 'id', value: 'login-error' })

    const r = await run(
      page,
      [
        step('navigate', { value: 'login.html' }),
        step('assert_not_exists', { target: error }),
        step('if_exists', { target: error }),
        step('store_fixed', { variable: 'BRANCH', value: 'shown' }),
        step('else'),
        step('store_fixed', { variable: 'BRANCH', value: 'hidden' }),
        step('end_if'),
        step('assert_variable_equals', { variable: 'BRANCH', value: 'hidden' }),
        step('assert_exists', { target: error, continueOnFailure: true }),
        step('click', { target: ref(ui, '"Sign in" button') }),
        step('assert_exists', { target: error }),
        step('if_exists', { target: error }),
        step('store_fixed', { variable: 'BRANCH', value: 'shown' }),
        step('end_if'),
        step('assert_variable_equals', { variable: 'BRANCH', value: 'shown' }),
        step('assert_not_exists', { target: error }),
      ],
      baseUrl,
    )
    const byNumber = Object.fromEntries(r.results.map((x) => [x.number, x]))
    expect(byNumber[2].status).toBe('passed')
    expect(r.log).toContain('[3] condition is false')
    expect(byNumber[8].status).toBe('passed')
    expect(byNumber[9]).toMatchObject({ status: 'failed', error: 'AssertionError: UI element is in the page but hidden (id=login-error)' })
    expect(byNumber[11].status).toBe('passed')
    expect(r.log).toContain('[12] condition is true')
    expect(byNumber[15].status).toBe('passed')
    expect(byNumber[16]).toMatchObject({ status: 'failed', error: 'AssertionError: UI element exists (id=login-error)' })
  })
})

describe('click', () => {
  it('does not click through to an overlay and names what is in the way', async () => {
    await page.setContent(html(`<button id="buy" onclick="document.title='BOUGHT'">Buy</button>`))
    const target = ref(await capture(page, 'ui'), '"Buy" button')
    // The overlay appears after the capture, as a dialog that a test did not expect would.
    await page.evaluate(() => {
      document.body.insertAdjacentHTML('beforeend', `<div id="modal" class="backdrop" style="position:fixed;inset:0;background:rgba(0,0,0,.4)" onclick="document.title='OVERLAY'"></div>`)
    })
    // A capture taken now no longer offers the covered button.
    expect((await capture(page, 'covered')).elements.map((e) => e.name)).not.toContain('"Buy" button')
    const r = await run(page, [step('click', { target })], baseUrl)
    expect(r.status).toBe('failed')
    expect(r.results[0].error).toBe('UI element "Buy" button could not be clicked (id=buy): it is covered by <div id="modal" class="backdrop">')
    expect(await page.title()).toBe('start')
  })

  it('still falls back to coordinates when the point belongs to the element', async () => {
    // The button never stops moving, so the element-based click times out on the stability check.
    await page.setContent(
      html(
        `<button id="buy" onclick="document.title='BOUGHT'" style="position:relative;width:200px;height:80px">Buy</button>
         <script>let i = 0; const b = document.getElementById('buy'); (function tick() { b.style.left = (i++ % 2) + 'px'; requestAnimationFrame(tick) })()</script>`,
      ),
    )
    const target = ref(await capture(page, 'ui'), '"Buy" button')
    const r = await run(page, [step('click', { target })], baseUrl)
    expect(r.status).toBe('succeeded')
    expect(r.log).toContain('retrying by coordinates')
    expect(await page.title()).toBe('BOUGHT')
  })
})

describe('detection on markup the demo site does not have', () => {
  it('offers visually hidden checkboxes and radio buttons at their label, and can operate them', async () => {
    await page.setContent(
      html(
        `<label class="sw"><input type="checkbox" name="terms"><span class="track"></span> I accept the terms</label>
         <p><input type="checkbox" id="news" class="sr"><label for="news" class="fake">Send me news</label></p>
         <p><input type="radio" name="plan" value="pro" id="pro" class="gone"><label for="pro" class="fake">Pro plan</label></p>
         <ul><li><input class="toggle" type="checkbox"><label>Buy milk</label></li></ul>`,
        `<style>
           label { display: inline-block; padding: 6px 10px }
           .sw input { position: absolute; opacity: 0 }
           .sr { position: absolute; width: 1px; height: 1px; clip: rect(0 0 0 0); overflow: hidden; opacity: 0 }
           .gone { display: none }
           .toggle { opacity: 0; width: 40px; height: 40px; appearance: none }
         </style>`,
      ),
    )
    const ui = await capture(page, 'ui')
    const names = ui.elements.map((e) => e.name)
    for (const name of ['"I accept the terms" checkbox', '"Send me news" checkbox', '"Pro plan" radio button', '"Buy milk" checkbox']) expect(names, name).toContain(name)

    const terms = element(ui, '"I accept the terms" checkbox')
    expect(terms.locators[0]).toEqual({ key: 'css', value: 'input[name="terms"]' })
    const label = await page.locator('label.sw').boundingBox()
    expect(terms.box).toEqual({ x: Math.round(label!.x), y: Math.round(label!.y), w: Math.round(label!.width), h: Math.round(label!.height) })
    expect(element(ui, '"Send me news" checkbox').box.w).toBeGreaterThan(50)

    const r = await run(
      page,
      [
        step('check', { target: ref(ui, '"I accept the terms" checkbox') }),
        step('check', { target: ref(ui, '"Send me news" checkbox') }),
        step('click', { target: ref(ui, '"Pro plan" radio button') }),
        step('check', { target: ref(ui, '"Buy milk" checkbox') }),
      ],
      baseUrl,
    )
    expect(r.log).not.toContain('ERROR')
    expect(r.status).toBe('succeeded')
    expect(await page.evaluate(() => Array.from(document.querySelectorAll('input')).map((i) => i.checked))).toEqual([true, true, true, true])

    const off = await run(page, [step('uncheck', { target: ref(ui, '"Send me news" checkbox') })], baseUrl)
    expect(off.status).toBe('succeeded')
    expect(await page.locator('#news').isChecked()).toBe(false)
  })

  it('keeps long paragraphs and sentences with links in them', async () => {
    const long = 'Harbor Inn has welcomed guests to the old quay since 1924. '.repeat(4).trim()
    await page.setContent(html(`<main><p id="about">${long}</p><p class="total">Total: <b>$120</b> incl. tax, see <a href="/terms">terms</a></p><ul><li><a href="/home">Home</a></li></ul></main>`))
    const ui = await capture(page, 'ui')

    const about = ui.elements.find((e) => e.locators[0].value === 'about')!
    expect(about.type).toBe('text')
    expect(about.name.length).toBeLessThanOrEqual(70)
    expect(about.fingerprint.text).toBe(long.slice(0, 120))

    const total = element(ui, '"Total: $120 incl. tax, see terms" text')
    expect(total.locators[0]).toEqual({ key: 'css', value: 'p.total' })
    // The parts stay available on their own; a list item that is nothing but its link does not become a text.
    const names = ui.elements.map((e) => e.name)
    expect(names).toEqual(expect.arrayContaining(['"$120" text', '"terms" link', '"Home" link']))
    expect(names).not.toContain('"Home" text')
  })

  it('finds elements in open shadow roots and gives them locators that work at run time', async () => {
    await page.setContent(
      html(
        `<button class="act">Outside</button><x-card></x-card>
         <script>
           const root = document.querySelector('x-card').attachShadow({ mode: 'open' })
           root.innerHTML = '<p class="msg">Inside the card</p><button class="act" data-testid="save">Save</button>'
           root.querySelector('button').onclick = () => { document.title = 'SAVED' }
         </script>`,
      ),
    )
    const ui = await capture(page, 'ui')
    const save = element(ui, '"Save" button')
    expect(save.fingerprint.path).toBe('body>x-card>button')
    expect(save.locators.every((l) => l.key === 'css')).toBe(true)
    expect(save.locators[0]).toEqual({ key: 'css', value: 'button[data-testid="save"]' })
    // button.act also matches the light-DOM button at run time, so it is not unique for either of them.
    for (const name of ['"Save" button', '"Outside" button']) expect(strings(element(ui, name).locators), name).not.toContain('css=button.act')
    expect(element(ui, '"Inside the card" text').locators).toEqual([{ key: 'css', value: 'p.msg' }])

    const r = await run(page, [step('click', { target: ref(ui, '"Save" button') }), step('assert_text_equals', { target: ref(ui, '"Inside the card" text'), value: 'Inside the card' })], baseUrl)
    expect(r.status).toBe('succeeded')
    expect(await page.title()).toBe('SAVED')
  })

  it('recognises clickable elements without button semantics and names icon-only controls', async () => {
    await page.setContent(
      html(
        `<div class="card" onclick="document.title='CARD'" tabindex="0" style="width:80px;height:80px"><svg width="24" height="24"><title>Open settings</title><circle cx="12" cy="12" r="10"/></svg></div>
         <span class="close" onclick="document.title='CLOSED'">×</span>
         <div class="chip" style="cursor:pointer;width:120px">Show more</div>
         <div class="tile" style="cursor:pointer"><h3>Deluxe room</h3><p>Harbor view</p><button>Book</button></div>
         <a id="up" href="/vote"><div class="votearrow" title="upvote" style="width:10px;height:10px"></div></a>`,
      ),
    )
    const ui = await capture(page, 'ui')
    const names = ui.elements.map((e) => e.name)
    expect(names).toEqual(expect.arrayContaining(['"Open settings" element', '"×" element', '"Show more" element', '"upvote" link']))
    // A clickable container keeps its content as separate elements.
    expect(names).toEqual(expect.arrayContaining(['"Deluxe room" text', '"Harbor view" text', '"Book" button']))
    expect(ui.elements.filter((e) => e.type === 'other')).toHaveLength(3)

    const r = await run(page, [step('click', { target: ref(ui, '"×" element') })], baseUrl)
    expect(r.status).toBe('succeeded')
    expect(await page.title()).toBe('CLOSED')
  })

  it('ranks text with numbers in it last for every element type', async () => {
    await page.setContent(
      html(`<nav><a class="cart-link" href="/cart">Cart (3)</a><button class="bell">Inbox 12</button><a href="/item?id=1">1 hour ago</a></nav><p><span>230 points</span></p>`),
    )
    const ui = await capture(page, 'ui')
    const cart = strings(element(ui, '"Cart (3)" link').locators)
    expect(cart.slice(0, 2)).toEqual(['css=a[href="/cart"]', 'css=a.cart-link'])
    expect(cart.at(-1)).toBe("xpath=//a[text()='Cart (3)']")

    const bell = strings(element(ui, '"Inbox 12" button').locators)
    expect(bell[0]).toBe('css=button.bell')
    expect(bell.at(-1)).toBe("xpath=//button[text()='Inbox 12']")

    expect(strings(element(ui, '"1 hour ago" link').locators)[0]).toBe('css=a[href="/item?id=1"]')
    // Nothing but its position and its text identifies the score: the position wins.
    expect(strings(element(ui, '"230 points" text').locators)).toEqual(['xpath=//span', "xpath=//span[text()='230 points']"])
  })
})

describe('a test that never opens a page', () => {
  it('says that a Navigate step is missing instead of only "not found"', async () => {
    await page.setContent(html('<button type="submit">Sign in</button>'))
    const target = ref(await capture(page, 'ui'), '"Sign in" button')

    await page.goto('about:blank')
    const r = await run(page, [step('click', { target })], baseUrl, { heal: true, waitMs: 300 })
    expect(r.status).toBe('failed')
    expect(r.results[0].error).toContain('was not found')
    expect(r.results[0].error).toContain('no Navigate step has run before this step')
    expect(r.results[0].heal).toBeUndefined()
  })
})

describe('a class that says what state an element is in', () => {
  it('is not used as a locator: it moves to another element later', async () => {
    await page.setContent(html('<table><tr><td><a class="ui-state-default" href="#">19</a></td><td><a class="ui-state-default ui-state-active day-selected" href="#">20</a></td></tr></table>'))
    const target = ref(await capture(page, 'ui'), '"20" link')
    const all = strings([target.locator, ...target.candidates]).join(' | ')
    expect(all).not.toMatch(/ui-state-|day-selected/)
  })
})
