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
const requests: string[] = []
const INLINE_RULES = JSON.stringify({ prefetch: [{ source: 'document', where: { href_matches: '/*' }, eagerness: 'conservative' }] })

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/cdn-cgi/speculation') {
      rulesServed++
      res.writeHead(200, { 'content-type': 'application/speculationrules+json' })
      return res.end(JSON.stringify({ prefetch: [{ source: 'document', where: { href_matches: '/*' }, eagerness: 'conservative' }] }))
    }
    requests.push(`${req.url} ${req.headers['sec-purpose'] ?? '-'}`)
    if (req.url?.startsWith('/inline')) {
      res.writeHead(200, { 'content-type': 'text/html' })
      return res.end(`<!doctype html><title>inline</title><script type="speculationrules">${INLINE_RULES}</script><a id="next" href="/next" style="display:block;padding:40px">Next</a>`)
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

describe('speculation rules written into the page', () => {
  const pressOnLink = async (guarded: boolean) => {
    const context = await browser.newContext()
    if (guarded) await guardContext(context as never, {}, origin)
    const page = await context.newPage()
    await page.goto(origin + '/inline')
    await page.waitForTimeout(300)
    requests.length = 0
    const box = (await page.locator('#next').boundingBox())!
    await page.mouse.move(box.x + 10, box.y + 10)
    await page.mouse.down() // pressed, not released: this is when Chrome speculates
    await page.waitForTimeout(700)
    const speculative = requests.filter((r) => r.includes('prefetch') || r.includes('prerender'))
    await page.mouse.up()
    await page.waitForURL('**/next')
    await context.close()
    return speculative
  }

  it('cause a prefetch on mouse-down in an unguarded browser (what the guard is for)', async () => {
    expect(await pressOnLink(false)).toEqual(['/next prefetch'])
  })

  it('never reach the network through the guard, and the click still navigates', async () => {
    expect(await pressOnLink(true)).toEqual([])
    expect(requests.some((r) => r.startsWith('/next '))).toBe(true)
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
