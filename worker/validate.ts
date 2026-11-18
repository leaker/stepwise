// Request body validation shared by the API routes.
import { COMMAND_BY_ID, isBuiltInVariable } from '../shared/commands'
import { describeDataProblem, validateDataTable } from '../shared/data'
import { positionLabel, type StepPosition } from '../shared/expand'
import type { Box, DataTable, ElementRef, ElementType, Fingerprint, Locator, Step, UiElement } from '../shared/types'
import { HttpError, type Env } from './env'
import { newId } from './db'

export type Body = Record<string, unknown>

/** Largest request body the API accepts. D1 stores at most 2 MB per value, and steps are copied into every run. */
export const MAX_BODY_BYTES = 1024 * 1024

/**
 * The JSON object of a request. No body at all is an empty object (e.g. POST .../abort); a body that is
 * not a JSON object is an error, so a malformed request is never mistaken for "no options given".
 */
export async function readBody(req: { text(): Promise<string> }): Promise<Body> {
  const text = await req.text()
  if (text.trim() === '') return {}
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON')
  }
  if (!isObject(body)) throw new HttpError(400, 'Request body must be a JSON object')
  return body
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

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

const MAX_VARIABLES = 100
const MAX_VARIABLE_LENGTH = 2000

export function optionalVariables(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined
  if (!isObject(value)) throw new HttpError(400, 'variables must be an object of strings')
  const out: Record<string, string> = {}
  const entries = Object.entries(value)
  if (entries.length > MAX_VARIABLES) throw new HttpError(400, `A project can have at most ${MAX_VARIABLES} variables`)
  for (const [k, v] of entries) {
    if (k.length > 60 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new HttpError(400, `Invalid variable name "${k.slice(0, 60)}" (letters, digits and _ only, 60 characters at most)`)
    if (isBuiltInVariable(k)) throw new HttpError(400, `${k} is a built-in variable and cannot be a project variable${k === 'BASE_URL' ? ' (set the base URL instead)' : ''}. Remove it or use another name.`)
    if (typeof v !== 'string') throw new HttpError(400, `Variable "${k}" must be a string`)
    if (v.length > MAX_VARIABLE_LENGTH) throw new HttpError(400, `Variable "${k}" must be ${MAX_VARIABLE_LENGTH} characters or fewer`)
    out[k] = v
  }
  return out
}

/**
 * The data table of a data-driven test case. `undefined`: not sent; `null`, or a table without columns:
 * remove it. Otherwise the table, or a 400 that names the first cell that is wrong.
 */
export function optionalData(value: unknown): DataTable | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  const shape = 'data must be { columns: string[], rows: string[][] }'
  if (!isObject(value) || !Array.isArray(value.columns) || !Array.isArray(value.rows)) throw new HttpError(400, shape)
  if (!value.columns.every((c) => typeof c === 'string')) throw new HttpError(400, shape)
  if (!value.rows.every((r) => Array.isArray(r) && r.every((c) => typeof c === 'string'))) throw new HttpError(400, shape)
  const table: DataTable = { columns: value.columns as string[], rows: value.rows as string[][] }
  const first = validateDataTable(table)[0]
  if (first) throw new HttpError(400, `Data: ${describeDataProblem(table, first)}`)
  return table.columns.length === 0 ? null : table
}

// Captured elements come back from the editor inside steps and UI element lists. They are rebuilt field by
// field, so nothing but the known fields is stored, and bounded well above what a capture produces
// (detect.ts: 300 elements, 8 locators, 120-character texts, 200-character attributes).
const ELEMENT_TYPES = new Set<string>(['button', 'link', 'input', 'textarea', 'checkbox', 'radio', 'select', 'image', 'text', 'other'])
const MAX_ELEMENTS = 1000
const MAX_LOCATORS = 20
const MAX_ATTRS = 40

function text(v: unknown, max: number, what: string): string {
  if (typeof v !== 'string') throw new HttpError(400, `${what} must be a string`)
  if (v.length > max) throw new HttpError(400, `${what} is too long (${max} characters at most)`)
  return v
}

function parseLocator(v: unknown, what: string): Locator {
  if (!isObject(v) || (v.key !== 'id' && v.key !== 'css' && v.key !== 'xpath') || typeof v.value !== 'string' || v.value === '') throw new HttpError(400, `${what} is invalid`)
  return { key: v.key, value: text(v.value, 2000, what) }
}

function parseLocators(v: unknown, what: string): Locator[] {
  if (!Array.isArray(v)) throw new HttpError(400, `${what} is invalid`)
  if (v.length > MAX_LOCATORS) throw new HttpError(400, `${what} can have at most ${MAX_LOCATORS} locators`)
  return v.map((l) => parseLocator(l, what))
}

function parseBox(v: unknown, what: string): Box {
  if (!isObject(v)) throw new HttpError(400, `${what} is invalid`)
  const n = (x: unknown): number => {
    if (typeof x !== 'number' || !Number.isFinite(x) || Math.abs(x) > 1_000_000) throw new HttpError(400, `${what} is invalid`)
    return x
  }
  return { x: n(v.x), y: n(v.y), w: n(v.w), h: n(v.h) }
}

function parseElementType(v: unknown, what: string): ElementType {
  if (typeof v !== 'string' || !ELEMENT_TYPES.has(v)) throw new HttpError(400, `${what} is invalid`)
  return v as ElementType
}

function parseFingerprint(v: unknown, what: string): Fingerprint {
  if (!isObject(v) || !isObject(v.attrs)) throw new HttpError(400, `${what} is invalid`)
  const entries = Object.entries(v.attrs)
  if (entries.length > MAX_ATTRS) throw new HttpError(400, `${what} has too many attributes`)
  const attrs: Record<string, string> = {}
  for (const [name, value] of entries) attrs[text(name, 60, `${what} attribute name`)] = text(value, 500, `${what} attribute ${name.slice(0, 60)}`)
  return {
    tag: text(v.tag, 60, `${what}.tag`),
    type: parseElementType(v.type, `${what}.type`),
    text: text(v.text, 300, `${what}.text`),
    label: text(v.label, 300, `${what}.label`),
    attrs,
    path: text(v.path, 2000, `${what}.path`),
    box: parseBox(v.box, `${what}.box`),
  }
}

function parseTarget(v: unknown, at: string): ElementRef {
  if (!isObject(v)) throw new HttpError(400, `${at}: target must be an object`)
  if (typeof v.uiId !== 'string' || typeof v.elementId !== 'string' || typeof v.name !== 'string') throw new HttpError(400, `${at}: target needs uiId, elementId and name`)
  return {
    uiId: text(v.uiId, 64, `${at}: target.uiId`),
    elementId: text(v.elementId, 64, `${at}: target.elementId`),
    name: text(v.name, 300, `${at}: target.name`),
    locator: parseLocator(v.locator, `${at}: target.locator`),
    candidates: parseLocators(v.candidates, `${at}: target.candidates`),
    fingerprint: parseFingerprint(v.fingerprint, `${at}: target.fingerprint`),
  }
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
    // `call` and `origin` exist in run snapshots only; they are not read here, so a client cannot store them.
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
  if (value.length > MAX_ELEMENTS) throw new HttpError(400, `A captured screen can have at most ${MAX_ELEMENTS} elements`)
  const seen = new Set<string>()
  return value.map((el, i) => {
    const at = `Element ${i + 1}`
    if (!isObject(el) || typeof el.id !== 'string' || el.id === '') throw new HttpError(400, `${at}: id is required`)
    if (seen.has(el.id)) throw new HttpError(400, `${at}: duplicate element id`)
    seen.add(el.id)
    if (typeof el.name !== 'string' || typeof el.type !== 'string') throw new HttpError(400, `${at}: name and type are required`)
    if (!isObject(el.box) || !isObject(el.fingerprint)) throw new HttpError(400, `${at}: box and fingerprint are required`)
    const locators = parseLocators(el.locators, `${at}: locators`)
    if (locators.length === 0) throw new HttpError(400, `${at}: locators must be a non-empty list of locators`)
    return {
      id: text(el.id, 64, `${at}: id`),
      name: text(el.name, 300, `${at}: name`),
      type: parseElementType(el.type, `${at}: type`),
      box: parseBox(el.box, `${at}: box`),
      locators,
      fingerprint: parseFingerprint(el.fingerprint, `${at}: fingerprint`),
    }
  })
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
export function assertNavigateTargetsAllowed(
  steps: Step[],
  baseUrl: string,
  variables: Record<string, string>,
  env: Pick<Env, 'ALLOWED_HOSTS'>,
  appOrigin: string,
  /** How the steps are numbered in the message when shared step calls were expanded (positionsOf). */
  positions?: StepPosition[],
): void {
  // The values a run will really use: built-ins win over a project variable of the same name (older data may
  // still hold one). DEVICE depends on the test case, so a URL built from it is left to the navigation guard.
  const vars: Record<string, string> = { ...variables, BASE_URL: baseUrl, BROWSER: 'chrome' }
  delete vars.DEVICE
  steps.forEach((step, i) => {
    if (step.disabled || step.command !== 'navigate') return
    const value = (step.value ?? '').replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, name: string) => (Object.hasOwn(vars, name) ? vars[name] : m))
    if (value.includes('${')) return
    const url = resolveUrl(value, baseUrl)
    if (url && !isHostAllowed(url, env, appOrigin)) throw new HttpError(400, `Step ${positions?.[i] ? positionLabel(positions[i]) : i + 1}: ${url.hostname} is not in this deployment's allowed hosts`)
  })
}
