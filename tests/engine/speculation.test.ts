// Two production findings from Cloudflare Browser Run:
// - sites that send speculation rules (Cloudflare Speed Brain adds `Speculation-Rules: "/cdn-cgi/speculation"`)
//   make Chrome prefetch on mouse-down, which tears the remote browser session down; the guard refuses the rules;
// - a step must fail, not pass, when the page died underneath it.
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { chromium } from 'playwright'
import type { Browser } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { guardContext } from '../../worker/guard'
import { run, step } from './helpers'

let browser: Browser
let server: Server
let origin: string
let rulesServed = 0

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/cdn-cgi/speculation') {
      rulesServed++
      res.writeHead(200, { 'content-type': 'application/speculationrules+json' })
      return res.end(JSON.stringify({ prefetch: [{ source: 'document', where: { href_matches: '/*' }, eagerness: 'conservative' }] }))
    }
    res.writeHead(200, { 'content-type': 'text/html', 'speculation-rules': '"/cdn-cgi/speculation"' })
    res.end(`<!doctype html><title>${req.url}</title><a id="next" href="/next">Next</a><button id="bye" onclick="window.close()">Close</button>`)
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  browser = await chromium.launch()
})

afterAll(async () => {
  await browser.close()
  await new Promise((done) => server.close(done))
})

describe('speculation rules', () => {
  it('are refused by the guard, and the page still loads and navigates', async () => {
    const context = await browser.newContext()
    await guardContext(context as never, {}, origin)
    const page = await context.newPage()
    await page.goto(origin + '/')
    await page.waitForTimeout(500)
    expect(rulesServed).toBe(0)
    await page.locator('#next').click()
    await page.waitForURL('**/next')
    expect(rulesServed).toBe(0)
    await context.close()
  })
})

describe('a page that dies during a step', () => {
  it('fails the step instead of passing on cached state', async () => {
    const context = await browser.newContext()
    const page = await context.newPage()
    const popup = await context.newPage() // window.close() only works on script-closable pages; close it from outside
    await popup.close()
    const outcome = await run(page, [step('navigate', { value: origin + '/' }), step('wait_seconds', { value: '0.3' }), step('assert_url_contains', { value: '127.0.0.1' })], origin, {
      onStep: async (result) => {
        if (result.number === 1) await page.close()
      },
    })
    expect(outcome.status).toBe('failed')
    expect(outcome.results.at(-1)?.error).toContain('closed unexpectedly')
    await context.close()
  })
})
