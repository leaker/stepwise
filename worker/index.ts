// Stepwise Worker: JSON API under /api, the bundled demo site under /demo, and the run queue consumer.
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { assistant } from './api/assistant'
import { projects } from './api/projects'
import { runs } from './api/runs'
import { testCases } from './api/testCases'
import { accessGate, getSession, postSession } from './auth'
import { HttpError, type Env, type QueueMessage } from './env'
import { handleQueue } from './runner'
import { MAX_BODY_BYTES } from './validate'

const app = new Hono<{ Bindings: Env }>()

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status)
  // Details (database errors, parse errors of stored data, ...) stay in the Worker log.
  console.error(err)
  return c.json({ error: 'Internal error' }, 500)
})

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
  if (!res.ok || !res.headers.get('Content-Type')?.includes('text/html')) return res
  const html = await res.text()
  // The fallback serves the app shell (index.html), which is the only page with the React mount point.
  if (html.includes('<div id="root">')) return c.text('Not found', 404)
  return new Response(html, res)
})

app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw))

export default {
  fetch: app.fetch,
  queue: (batch: MessageBatch<QueueMessage>, env: Env) => handleQueue(batch, env),
} satisfies ExportedHandler<Env, QueueMessage>
