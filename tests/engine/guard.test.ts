// The navigation guard the runner installs on every browser context (worker/guard.ts), driven with
// Node Playwright: one local server plays the app's own origin, a second one a host that is not allowed.
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { chromium } from 'playwright'
import type { Browser, BrowserContext, Page } from 'playwright'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { guardContext } from '../../worker/guard'
import type { Guard } from '../../worker/guard'
import { run, step } from './helpers'

let browser: Browser
let app: Server
let other: Server
let appOrigin: string
let otherOrigin: string
let otherHits: string[]
let context: BrowserContext
let page: Page
let guard: Guard

const html = (body: string) => `<!doctype html><html><head><title>guard</title></head><body>${body}</body></html>`

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; origin: string }> {
  const server = createServer(handler)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

beforeAll(async () => {
  ;({ server: other, origin: otherOrigin } = await listen((req, res) => {
    otherHits.push(req.url ?? '')
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(html('<h1 id="secret">internal page</h1>'))
  }))
  ;({ server: app, origin: appOrigin } = await listen((req, res) => {
    const path = req.url ?? '/'
    if (path === '/redirect') {
      res.writeHead(302, { location: `${otherOrigin}/secret` })
      return res.end()
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    if (path === '/embeds') return res.end(html(`<h1 id="title">Shop</h1><iframe id="widget" src="${otherOrigin}/widget"></iframe><button id="buy">Buy</button>`))
    if (path === '/links') return res.end(html(`<a id="out" href="${otherOrigin}/elsewhere">Leave</a><a id="hop" href="/redirect">Hop</a>`))
    res.end(html('<h1 id="title">Home</h1>'))
  }))
  browser = await chromium.launch()
})
afterAll(async () => {
  await browser?.close()
  app?.close()
  other?.close()
})
beforeEach(async () => {
  otherHits = []
  context = await browser.newContext()
  // 127.0.0.1 is a private host, so only the app's own origin may be opened.
  guard = await guardContext(context as unknown as Parameters<typeof guardContext>[0], {}, appOrigin)
  page = await context.newPage()
})
afterEach(async () => {
  await context.close()
})

describe('navigation guard', () => {
  it('leaves the page alone when an iframe on it is refused', async () => {
    await page.goto(`${appOrigin}/embeds`)
    await page.waitForTimeout(500)
    expect(page.url()).toBe(`${appOrigin}/embeds`)
    expect(await page.locator('#buy').count()).toBe(1)
    expect(otherHits).toEqual([])
    expect(guard.takeBlockedNavigation()).toBeNull()
  })

  it('fails the navigate step that is redirected to a host that is not allowed, and never shows that page', async () => {
    const r = await run(page, [step('navigate', { value: '/redirect' }), step('assert_title_equals', { value: 'guard' })], appOrigin, {
      takeBlockedNavigation: guard.takeBlockedNavigation,
    })
    expect(r.status).toBe('failed')
    expect(r.results).toHaveLength(1)
    expect(r.results[0].error).toBe(`Navigation to ${otherOrigin}/secret was blocked: the host is not allowed by this deployment's target policy`)
    await page.waitForTimeout(300)
    expect(await page.locator('#secret').count()).toBe(0)
    expect(page.url()).not.toContain(otherOrigin)
  })

  it('fails the click that leads to a host that is not allowed without sending the request', async () => {
    const out = { uiId: 'u', elementId: 'e', name: '"Leave" link', locator: { key: 'id' as const, value: 'out' }, candidates: [], fingerprint: { tag: 'a', type: 'link' as const, text: 'Leave', label: '', attrs: {}, path: 'body>a', box: { x: 0, y: 0, w: 1, h: 1 } } }
    const r = await run(page, [step('navigate', { value: '/links' }), step('click', { target: out }), step('assert_title_equals', { value: 'guard' })], appOrigin, {
      takeBlockedNavigation: guard.takeBlockedNavigation,
    })
    expect(r.results.map((x) => x.status)).toEqual(['passed', 'failed'])
    expect(r.results[1].error).toBe(`Navigation to ${otherOrigin}/elsewhere was blocked: the host is not allowed by this deployment's target policy`)
    expect(otherHits).toEqual([])
  })
})
