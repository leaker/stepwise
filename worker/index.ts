import { launch } from '@cloudflare/playwright'

export default {
  async fetch(req: Request, env: any): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/api/smoke') {
      const browser = await launch(env.BROWSER)
      try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
        await page.goto(url.searchParams.get('u') ?? 'https://example.com')
        const title = await page.title()
        const shot = await page.screenshot({ type: 'jpeg', quality: 60 })
        await env.SHOTS.put('smoke.jpg', shot)
        const row = await env.DB.prepare('select 1 as ok').first()
        return Response.json({ title, bytes: shot.byteLength, row })
      } finally {
        await browser.close()
      }
    }
    return new Response('not found', { status: 404 })
  },
}
