// Optional shared-secret gate for the whole API (set the ACCESS_CODE secret to enable it).
import type { Context, MiddlewareHandler } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import type { Env } from './env'

const COOKIE = 'sw_access'
/**
 * Over https the cookie is `__Host-sw_access`: the prefix makes the browser refuse it unless it is Secure,
 * for Path=/ and without a Domain, so neither a sibling subdomain nor a network attacker can plant one.
 * Local development runs over http, where a prefixed cookie would be rejected, so it keeps the plain name.
 */
const isSecure = (c: Context<{ Bindings: Env }>): boolean => new URL(c.req.url).protocol === 'https:'
const encoder = new TextEncoder()

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))
}

const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

/** Compare two strings without leaking where they differ: hash both, then compare the digests in constant time. */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([sha256(a), sha256(b)])
  let diff = 0
  for (let i = 0; i < da.length; i++) diff |= da[i] ^ db[i]
  return diff === 0
}

const bearerOf = (c: Context<{ Bindings: Env }>): string | null => {
  const header = c.req.header('Authorization')
  return header?.startsWith('Bearer ') ? header.slice(7).trim() : null
}

async function hasSessionCookie(c: Context<{ Bindings: Env }>, code: string): Promise<boolean> {
  const cookie = isSecure(c) ? getCookie(c, COOKIE, 'host') : getCookie(c, COOKIE)
  return !!cookie && (await safeEqual(cookie, toHex(await sha256(code))))
}

async function isAuthorized(c: Context<{ Bindings: Env }>): Promise<boolean> {
  const code = c.env.ACCESS_CODE
  if (!code) return true
  const bearer = bearerOf(c)
  if (bearer !== null && !isLockedOut(c) && (await safeEqual(bearer, code))) return true
  return hasSessionCookie(c, code)
}

// ---- guessing the access code ----
// With the ACCESS_LIMITER rate limiting binding, wrong codes are counted per client address. An address
// that went over the limit is not listened to for a minute: its codes are refused without being compared,
// so guessing faster gains nothing. Only wrong codes count, and requests with a valid session cookie are
// never affected. The binding counts per Cloudflare location and this memory is per Worker instance, so
// this slows guessing down to a crawl; what makes a code safe is still its length.

const LOCKOUT_MS = 60_000
const TOO_MANY = 'Too many wrong access codes from this address. Wait a minute and try again.'
const lockedUntil = new Map<string, number>()
const clientKey = (c: Context<{ Bindings: Env }>): string => c.req.header('cf-connecting-ip') ?? 'unknown'

function isLockedOut(c: Context<{ Bindings: Env }>): boolean {
  if (!c.env.ACCESS_LIMITER) return false
  const key = clientKey(c)
  const until = lockedUntil.get(key)
  if (until === undefined) return false
  if (until > Date.now()) return true
  lockedUntil.delete(key)
  return false
}

/** Count a wrong code. True when this address is now over the limit. */
async function countWrongCode(c: Context<{ Bindings: Env }>): Promise<boolean> {
  const limiter = c.env.ACCESS_LIMITER
  if (!limiter) return false
  const key = clientKey(c)
  // A limiter that cannot answer must not lock anybody out.
  const { success } = await limiter.limit({ key }).catch(() => ({ success: true }))
  if (success) return false
  if (lockedUntil.size > 10_000) lockedUntil.clear()
  lockedUntil.set(key, Date.now() + LOCKOUT_MS)
  return true
}

const tooMany = (c: Context<{ Bindings: Env }>): Response => c.json({ error: TOO_MANY }, 429, { 'Retry-After': '60' })

export const accessGate: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (c.req.path === '/api/session') return next()
  const code = c.env.ACCESS_CODE
  if (!code) return next()
  const bearer = bearerOf(c)
  if (bearer !== null) {
    if (isLockedOut(c)) return (await hasSessionCookie(c, code)) ? next() : tooMany(c)
    if (await safeEqual(bearer, code)) return next()
    if (await hasSessionCookie(c, code)) return next()
    return (await countWrongCode(c)) ? tooMany(c) : c.json({ error: 'Access code required' }, 401)
  }
  if (await hasSessionCookie(c, code)) return next()
  return c.json({ error: 'Access code required' }, 401)
}

export async function getSession(c: Context<{ Bindings: Env }>): Promise<Response> {
  return c.json({ required: !!c.env.ACCESS_CODE, ok: await isAuthorized(c) })
}

export async function postSession(c: Context<{ Bindings: Env }>): Promise<Response> {
  const code = c.env.ACCESS_CODE
  if (!code) return c.json({ ok: true })
  const body: unknown = await c.req.json().catch(() => null)
  const given = body && typeof body === 'object' && typeof (body as { code?: unknown }).code === 'string' ? (body as { code: string }).code : ''
  if (isLockedOut(c)) return tooMany(c)
  if (!given || !(await safeEqual(given, code))) return (await countWrongCode(c)) ? tooMany(c) : c.json({ error: 'Wrong access code' }, 401)
  const secure = isSecure(c)
  setCookie(c, COOKIE, toHex(await sha256(code)), {
    ...(secure ? { prefix: 'host' as const } : {}),
    httpOnly: true,
    sameSite: 'Lax',
    secure,
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  })
  return c.json({ ok: true })
}
