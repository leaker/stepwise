// Stepwise Worker: JSON API under /api, the bundled demo site under /demo, and the run queue consumer.
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { assistant } from './api/assistant'
import { projects } from './api/projects'
import { runs } from './api/runs'
import { testCases } from './api/testCases'
import { accessGate, getSession, postSession } from './auth'
import { DEMO_CSP, resourceIsolation, securityHeaders } from './security'
import { HttpError, type Env, type QueueMessage } from './env'
import { handleQueue } from './runner'
import { MAX_BODY_BYTES } from './validate'

const app = new Hono<{ Bindings: Env }>()

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message, ...(err.code ? { code: err.code } : {}) }, err.status)
  // Details (database errors, parse errors of stored data, ...) stay in the Worker log.
  console.error(err)
  return c.json({ error: 'Internal error' }, 500)
})

// Response headers for everything the Worker answers itself (/api, /demo, /assets). The app shell is served
// by the assets layer without running the Worker; public/_headers carries the same values for it.
app.use('*', securityHeaders)
// Before the access gate: a refused cross-site request must not reveal whether a session exists.
app.use('/api/*', resourceIsolation)
app.use('/api/*', accessGate)
app.use(
  '/api/*',
  bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: async (c) => {
      // Read the upload to its end without keeping it: answering while the client is still sending
      // resets the connection on some proxies (the local dev server among them) instead of delivering the 413.
      await c.req.raw.body?.pipeTo(new WritableStream()).catch(() => {})
      return c.json({ error: `Request body is too large (${MAX_BODY_BYTES / 1024 / 1024} MB at most)` }, 413)
    },
  }),
)
app.get('/api/session', getSession)
app.post('/api/session', postSession)

app.route('/api', projects)
app.route('/api', testCases)
app.route('/api', runs)
app.route('/api', assistant)

// Screenshot keys contain slashes (ui/<id>.jpg, run/<runId>/<n>.jpg), hence the wildcard.
app.get('/api/shots/*', async (c) => {
  let key = ''
  try {
    key = decodeURIComponent(c.req.path.slice('/api/shots/'.length))
  } catch {
    /* malformed percent-encoding: not a key we ever issued */
  }
  if (!/^(ui|run)\/[A-Za-z0-9/_.-]+$/.test(key) || key.includes('..')) return c.json({ error: 'Screenshot not found' }, 404)
  const object = await c.env.SHOTS.get(key)
  if (!object) return c.json({ error: 'Screenshot not found' }, 404)
  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType ?? 'image/jpeg',
      // Keys are never rewritten, so the browser may keep them forever (private: the API can be gated).
      'Cache-Control': 'private, max-age=31536000, immutable',
      ETag: object.httpEtag,
    },
  })
})

app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404))

// The demo site is plain static files. It is routed through the Worker so that a missing page is a real
// 404 instead of the single-page-app fallback (a test must see a broken link as broken).
app.all('/demo/*', async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw)
  // The demo pages carry inline scripts (they are a test target and stay as they are), so they get a policy
  // without script-src instead of the app's.
  const demo = (body: BodyInit | null) => {
    const out = new Response(body, res)
    out.headers.set('Content-Security-Policy', DEMO_CSP)
    return out
  }
  if (!res.ok || !res.headers.get('Content-Type')?.includes('text/html')) return demo(res.body)
  const html = await res.text()
  // The fallback serves the app shell (index.html), which is the only page with the React mount point.
  if (html.includes('<div id="root">')) return c.text('Not found', 404)
  return demo(html)
})

// A hashed file that does not exist (a tab opened before a deployment asks for the previous build's chunk, or
// a request reaches a location that does not have the new build yet) must not be answered with the app shell:
// public/_headers marks everything under /assets as immutable for a year, and a browser would keep the HTML
// under that script's address. The single-page-app fallback is the only HTML under /assets.
app.all('/assets/*', async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw)
  if (!res.headers.get('Content-Type')?.includes('text/html')) return res
  return c.text('Not found', 404, { 'Cache-Control': 'no-store' })
})

app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw))

export default {
  fetch: app.fetch,
  queue: (batch: MessageBatch<QueueMessage>, env: Env) => handleQueue(batch, env),
} satisfies ExportedHandler<Env, QueueMessage>
