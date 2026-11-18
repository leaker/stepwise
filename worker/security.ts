// Security response headers and the cross-site request check for the Worker's own responses.
// public/_headers repeats SECURITY_HEADERS and APP_CSP for the static app shell; keep the two in step.
import type { MiddlewareHandler } from 'hono'
import type { Env } from './env'

/**
 * The app's policy. The shell is static and cached, so there is no per-request nonce: scripts are limited to
 * the origin's own hashed bundles (nothing user-uploaded is served as script; screenshots are images with
 * nosniff). Fonts are served from this origin. Trusted Types is enforced where the browser supports it; the app
 * has no HTML sinks.
 */
export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self' 'report-sample' https://static.cloudflareinsights.com",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self' https://cloudflareinsights.com",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "require-trusted-types-for 'script'",
].join('; ')

/** The sample site: no framing, no plugins, no <base>; its inline scripts and style attribute keep working. */
export const DEMO_CSP = "object-src 'none'; base-uri 'none'; frame-ancestors 'none'"

export const SECURITY_HEADERS: Record<string, string> = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=()',
  'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
  'Cross-Origin-Resource-Policy': 'same-origin',
  // A short max-age while the header is new; raise it to a year once it has been live without trouble.
  'Strict-Transport-Security': 'max-age=300',
}

export const securityHeaders: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  await next()
  // A response passed through from the assets binding has immutable headers: copy it first.
  const res = new Response(c.res.body, c.res)
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.headers.set(name, value)
  if (!res.headers.has('Content-Security-Policy')) res.headers.set('Content-Security-Policy', APP_CSP)
  c.res = res
}

const VARY = 'Sec-Fetch-Dest, Sec-Fetch-Mode, Sec-Fetch-Site'

/**
 * Fetch Metadata resource isolation for the API: a request another site makes the browser send is refused.
 * Requests without the header pass (curl, the seed script, CI with a Bearer token, old browsers). `same-site`
 * is not trusted: other subdomains of the same registrable domain are separate projects.
 */
export const resourceIsolation: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const site = c.req.header('Sec-Fetch-Site')
  const dest = c.req.header('Sec-Fetch-Dest') ?? ''
  // A link to a screenshot followed from another site is a plain navigation to an image.
  const shotLink = c.req.method === 'GET' && c.req.header('Sec-Fetch-Mode') === 'navigate' && dest !== 'object' && dest !== 'embed' && c.req.path.startsWith('/api/shots/')
  if (site && site !== 'same-origin' && site !== 'none' && !shotLink) return c.json({ error: 'Cross-site requests are not allowed' }, 403, { Vary: VARY })
  await next()
  // The answer depends on these request headers, so a shared cache must not reuse it across them.
  c.res.headers.append('Vary', VARY)
}
