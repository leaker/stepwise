// The downscaled screenshot sent to the model, produced in a real (Node Playwright) browser.
import { chromium } from 'playwright'
import type { Browser } from 'playwright'
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEVICES } from '../../shared/devices'
import { makePreview } from '../../worker/assistant/preview'
import { capture, jpegSize, startDemoServer } from '../engine/helpers'

let browser: Browser
let server: Server
let baseUrl: string

beforeAll(async () => {
  ;({ server, baseUrl } = await startDemoServer())
  browser = await chromium.launch()
})
afterAll(async () => {
  await browser?.close()
  server?.close()
})

type PreviewContext = Parameters<typeof makePreview>[0]
const decode = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64'))

describe('assistant screenshot preview', () => {
  it('keeps a desktop page that fits, scaled to at most 1024 px wide', async () => {
    const context = await browser.newContext({ viewport: { ...DEVICES.desktop.viewport } })
    const page = await context.newPage()
    await page.goto(baseUrl + 'login.html')
    const ui = await capture(page, 'p1')
    const preview = (await makePreview(context as unknown as PreviewContext, ui.screenshot))!
    expect(preview.width).toBe(1024)
    expect(preview.height).toBe(Math.round(ui.height * (1024 / ui.width)))
    expect(preview.cropped).toBe(false)
    expect(jpegSize(decode(preview.data))).toEqual({ width: preview.width, height: preview.height })
    // The helper page is closed again: only the captured page is left.
    expect(context.pages()).toHaveLength(1)
    await context.close()
  })

  it('crops a very long page to its top and says so', async () => {
    const iphone = DEVICES.iphone
    const context = await browser.newContext({ viewport: { ...iphone.viewport }, isMobile: true, hasTouch: true, deviceScaleFactor: iphone.deviceScaleFactor })
    const page = await context.newPage()
    await page.setContent('<body style="margin:0"><h1>Top</h1><div style="height:5000px;background:linear-gradient(#fff,#06c)"></div></body>')
    const ui = await capture(page, 'p2')
    expect(ui.height).toBeGreaterThan(5000)
    const preview = (await makePreview(context as unknown as PreviewContext, ui.screenshot))!
    expect(preview.cropped).toBe(true)
    // 2400 CSS px of the page are kept and scaled to fit 1600 px of height.
    expect(preview.height).toBe(1600)
    expect(preview.width).toBe(Math.round(ui.width * (1600 / 2400)))
    await context.close()
  })
})
