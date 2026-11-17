// Optional shared-secret gate for the whole API (set the ACCESS_CODE secret to enable it).
import type { Context, MiddlewareHandler } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import type { Env } from './env'

const COOKIE = 'sw_access'
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

async function isAuthorized(c: Context<{ Bindings: Env }>): Promise<boolean> {
  const code = c.env.ACCESS_CODE
  if (!code) return true
  const header = c.req.header('Authorization')
  if (header?.startsWith('Bearer ') && (await safeEqual(header.slice(7).trim(), code))) return true
  const cookie = getCookie(c, COOKIE)
  return !!cookie && (await safeEqual(cookie, toHex(await sha256(code))))
}

export const accessGate: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (c.req.path === '/api/session') return next()
  if (await isAuthorized(c)) return next()
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
  if (!given || !(await safeEqual(given, code))) return c.json({ error: 'Wrong access code' }, 401)
  setCookie(c, COOKIE, toHex(await sha256(code)), {
    httpOnly: true,
    sameSite: 'Lax',
    secure: new URL(c.req.url).protocol === 'https:',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  })
  return c.json({ ok: true })
}
