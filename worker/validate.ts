// Request body validation shared by the API routes.
import { COMMAND_BY_ID } from '../shared/commands'
import type { ElementRef, Locator, Step, UiElement } from '../shared/types'
import { HttpError, type Env } from './env'
import { newId } from './db'

export type Body = Record<string, unknown>

export async function readBody(req: { json(): Promise<unknown> }): Promise<Body> {
  const body = await req.json().catch(() => null)
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return {}
  return body as Body
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

export function requireName(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new HttpError(400, `${what} name is required`)
  const name = value.trim()
  if (name.length > 120) throw new HttpError(400, `${what} name must be 120 characters or fewer`)
  return name
}

export function optionalText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be a string`)
  if (value.length > max) throw new HttpError(400, `${field} must be ${max} characters or fewer`)
  return value
}

export function optionalBaseUrl(value: unknown): string | undefined {
  const text = optionalText(value, 'baseUrl', 2000)?.trim()
  if (text === undefined || text === '') return text
  if (!parseHttpUrl(text)) throw new HttpError(400, 'baseUrl must be an http(s) URL')
  return text.replace(/\/+$/, '')
}

export function optionalVariables(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined
  if (!isObject(value)) throw new HttpError(400, 'variables must be an object of strings')
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new HttpError(400, `Invalid variable name "${k}" (letters, digits and _ only)`)
    if (typeof v !== 'string') throw new HttpError(400, `Variable "${k}" must be a string`)
    out[k] = v
  }
  return out
}

function isLocator(v: unknown): v is Locator {
  return isObject(v) && (v.key === 'id' || v.key === 'css' || v.key === 'xpath') && typeof v.value === 'string'
}

function parseTarget(v: unknown, at: string): ElementRef {
  if (!isObject(v)) throw new HttpError(400, `${at}: target must be an object`)
  if (typeof v.uiId !== 'string' || typeof v.elementId !== 'string' || typeof v.name !== 'string') throw new HttpError(400, `${at}: target needs uiId, elementId and name`)
  if (!isLocator(v.locator)) throw new HttpError(400, `${at}: target.locator is invalid`)
  if (!Array.isArray(v.candidates) || !v.candidates.every(isLocator)) throw new HttpError(400, `${at}: target.candidates is invalid`)
  if (!isObject(v.fingerprint)) throw new HttpError(400, `${at}: target.fingerprint is invalid`)
  return v as unknown as ElementRef
}

/** Structural validation only; IF nesting problems are allowed while editing and reported at run time. */
export function parseSteps(value: unknown): Step[] {
  if (!Array.isArray(value)) throw new HttpError(400, 'steps must be an array')
  if (value.length > 500) throw new HttpError(400, 'A test case can have at most 500 steps')
  const seen = new Set<string>()
  return value.map((raw, i) => {
    const at = `Step ${i + 1}`
    if (!isObject(raw)) throw new HttpError(400, `${at}: must be an object`)
    if (typeof raw.command !== 'string' || !Object.hasOwn(COMMAND_BY_ID, raw.command)) throw new HttpError(400, `${at}: unknown command "${String(raw.command)}"`)
    if (raw.id !== undefined && raw.id !== null && typeof raw.id !== 'string') throw new HttpError(400, `${at}: id must be a string`)
    const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : newId()
    if (seen.has(id)) throw new HttpError(400, `${at}: duplicate step id "${id}"`)
    seen.add(id)
    const step: Step = { id, command: raw.command as Step['command'] }
    if (raw.target !== undefined && raw.target !== null) step.target = parseTarget(raw.target, at)
    for (const key of ['value', 'variable'] as const) {
      const v = raw[key]
      if (v === undefined || v === null) continue
      if (typeof v !== 'string') throw new HttpError(400, `${at}: ${key} must be a string`)
      if (v.length > 5000) throw new HttpError(400, `${at}: ${key} is too long`)
      step[key] = v
    }
    for (const key of ['disabled', 'continueOnFailure'] as const) {
      const v = raw[key]
      if (v === undefined || v === null) continue
      if (typeof v !== 'boolean') throw new HttpError(400, `${at}: ${key} must be a boolean`)
      if (v) step[key] = true
    }
    return step
  })
}

export function parseElements(value: unknown): UiElement[] {
  if (!Array.isArray(value)) throw new HttpError(400, 'elements must be an array')
  const seen = new Set<string>()
  for (const [i, el] of value.entries()) {
    const at = `Element ${i + 1}`
    if (!isObject(el) || typeof el.id !== 'string' || el.id === '') throw new HttpError(400, `${at}: id is required`)
    if (seen.has(el.id)) throw new HttpError(400, `${at}: duplicate element id`)
    seen.add(el.id)
    if (typeof el.name !== 'string' || typeof el.type !== 'string') throw new HttpError(400, `${at}: name and type are required`)
    if (!isObject(el.box) || !isObject(el.fingerprint)) throw new HttpError(400, `${at}: box and fingerprint are required`)
    if (!Array.isArray(el.locators) || el.locators.length === 0 || !el.locators.every(isLocator)) throw new HttpError(400, `${at}: locators must be a non-empty list of locators`)
  }
  return value as UiElement[]
}

// ---- URL rules ----

export function parseHttpUrl(text: string): URL | null {
  try {
    const url = new URL(text)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

/** Absolute http(s) URLs pass through; anything else is appended to the project's base URL. */
export function resolveUrl(value: string, baseUrl: string): URL | null {
  const text = value.trim()
  if (text === '') return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return parseHttpUrl(text)
  if (!baseUrl) return null
  return parseHttpUrl(baseUrl.replace(/\/+$/, '') + (text.startsWith('/') ? '' : '/') + text)
}

/** True when the URL may be opened: no allow-list configured, the app's own origin, or a listed hostname. */
export function isHostAllowed(url: URL, env: Pick<Env, 'ALLOWED_HOSTS'>, appOrigin: string): boolean {
  const list = (env.ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
  if (url.origin === appOrigin) return true
  if (isPrivateHost(url.hostname)) return false
  if (list.length === 0) return true
  return list.includes(url.hostname.toLowerCase())
}

/**
 * Loopback, private-range, link-local and internal-only hostnames. The cloud browser must never be
 * pointed at these (the app's own origin is exempted by the callers, which is what makes local dev work).
 * This is a literal check; it does not defend against DNS names that resolve to private addresses.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (host === 'localhost' || /\.(localhost|local|internal|lan|home\.arpa)$/.test(host)) return true
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
  }
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/.test(host)) return true // integer / hex IPv4 forms
  if (host.includes(':')) {
    if (host === '::' || host === '::1') return true
    if (/^(fc|fd)[0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return true
    const mapped = host.match(/^::ffff:(.+)$/)
    if (mapped) return mapped[1].includes('.') ? isPrivateHost(mapped[1]) : true
  }
  return false
}

/**
 * Check every navigate step whose URL is known before the run starts (after substituting BASE_URL and
 * project variables). URLs that depend on run-time variables are enforced by the navigation guard in the runner.
 */
export function assertNavigateTargetsAllowed(steps: Step[], baseUrl: string, variables: Record<string, string>, env: Pick<Env, 'ALLOWED_HOSTS'>, appOrigin: string): void {
  const vars: Record<string, string> = { ...variables, BASE_URL: baseUrl }
  steps.forEach((step, i) => {
    if (step.disabled || step.command !== 'navigate') return
    const value = (step.value ?? '').replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, name: string) => (Object.hasOwn(vars, name) ? vars[name] : m))
    if (value.includes('${')) return
    const url = resolveUrl(value, baseUrl)
    if (url && !isHostAllowed(url, env, appOrigin)) throw new HttpError(400, `Step ${i + 1}: ${url.hostname} is not in this deployment's allowed hosts`)
  })
}
