// Turning the model's tool input into a Step, with every rule the editor and the engine enforce checked
// up front so a mistake comes back as a message the model can act on. Pure: no database, no browser.
import { COMMAND_BY_ID, EMPTY_VALUE_PROBLEM, isBuiltInVariable, KEYS, MAX_STEP_TEXT, SWIPE_DIRECTIONS } from '../../shared/commands'
import type { CommandId, ElementRef, Step, Ui, UiElement } from '../../shared/types'

export class ToolInputError extends Error {}

const fail = (message: string): never => {
  throw new ToolInputError(message)
}

export type Input = Record<string, unknown>

export function asInput(value: unknown): Input {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail('The tool input must be a JSON object.')
  return value as Input
}

export function optionalString(input: Input, key: string, max = MAX_STEP_TEXT): string | undefined {
  const v = input[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') return fail(`${key} must be a string.`)
  if (v.length > max) return fail(`${key} is too long (${max} characters at most).`)
  return v
}

export function optionalInt(input: Input, key: string): number | undefined {
  const v = input[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isInteger(v)) return fail(`${key} must be a whole number.`)
  return v
}

export function requiredInt(input: Input, key: string): number {
  return optionalInt(input, key) ?? fail(`${key} is required.`)
}

/** A 1-based step number that exists. */
export function stepIndex(steps: Step[], n: number, key = 'step'): number {
  if (steps.length === 0) return fail('The test case has no steps yet.')
  if (n < 1 || n > steps.length) return fail(`${key} must be between 1 and ${steps.length} (the test case has ${steps.length} step${steps.length === 1 ? '' : 's'}).`)
  return n - 1
}

/** Told to the model when it tries to write a shared step call. */
export const SHARED_STEP_NOTE =
  'A shared step call cannot be added or changed here: which shared step a test case calls is up to the user. An existing call can be removed with delete_step or switched off with update_step (disabled). Tell the user if the test needs a shared step.'

export function commandOf(value: unknown): CommandId {
  if (value === 'shared_step') return fail(SHARED_STEP_NOTE)
  if (typeof value !== 'string' || !Object.hasOwn(COMMAND_BY_ID, value)) return fail(`Unknown command "${String(value)}". Use a command id from the catalogue, for example click, input, navigate or assert_text_equals.`)
  return value as CommandId
}

/**
 * `latest`: the capture this session made last. A model that names an element and leaves the capture out
 * means that one (the element ids it has just read), so the step is built from it and the answer says so.
 */
export function targetFrom(uis: Ui[], uiId: string | undefined, elementId: string | undefined, device: string, latest?: string | null): ElementRef {
  if (!elementId) return fail(`This command acts on an element, and element_id is missing${uiId ? '' : ' (so is ui_id)'}. Pass the ui_id of a capture_screen result and an element_id from its element list.`)
  if (!uiId) {
    if (!latest || !uis.some((u) => u.id === latest)) return fail(`ui_id is missing: element_id "${elementId}" only means something together with the ui_id of the capture it was listed in. Capture the screen with capture_screen first, then pass its ui_id with the element_id.`)
    if (!uis.find((u) => u.id === latest)!.elements.some((e) => e.id === elementId)) return fail(`ui_id is missing, and the latest capture (ui_id "${latest}") has no element "${elementId}". Send the call again with the ui_id of the capture this element_id was listed in.`)
    uiId = latest
  }
  const ui = uis.find((u) => u.id === uiId)
  if (!ui) return fail(`There is no capture with ui_id "${uiId}" in this test case. Use the ui_id returned by capture_screen.`)
  if (ui.device !== device) return fail(`Capture ${ui.name} was taken on another device (${ui.device}); this test case runs on ${device}. Capture the screen again and use an element from the new capture.`)
  const el = ui.elements.find((e) => e.id === elementId)
  if (!el) return fail(`Capture ${ui.name} (ui_id ${ui.id}) has no element "${elementId}". Element ids belong to one capture: use one from that capture's element list.`)
  if (el.locators.length === 0) return fail(`Element "${elementId}" has no usable locator. Pick another element.`)
  // locators[0] is the most stable candidate: the recommended one.
  return { uiId: ui.id, elementId: el.id, name: el.name, locator: el.locators[0], candidates: el.locators, fingerprint: el.fingerprint }
}

/** Commands whose value may not be empty (an empty text to type or to compare with is legitimate). */
const NEEDS_TEXT = new Set<CommandId>(['navigate', 'press_key', 'swipe', 'wait_seconds', 'assert_title_equals', ...(Object.keys(EMPTY_VALUE_PROBLEM) as CommandId[])])
/** Values the editor fills in for a new step. */
export const DEFAULT_VALUE: Partial<Record<CommandId, string>> = { wait_visible: '10', screenshot: '' }

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Check a complete step against what its command needs. `checkUrl` applies the deployment's target policy to a navigate URL. */
export function checkStep(step: Step, checkUrl: (value: string) => string | null): void {
  const def = COMMAND_BY_ID[step.command]
  if (def.target && !step.target) fail(`${step.command} acts on an element: pass ui_id and element_id from a capture_screen result.`)
  if (!def.target && step.target) fail(`${step.command} does not take an element. Leave out ui_id and element_id.`)
  if (!def.value && step.value !== undefined) fail(`${step.command} does not take a value. Leave it out.`)
  if (!def.variable && step.variable !== undefined) fail(`${step.command} does not take a variable. Leave it out.`)

  const value = step.value ?? ''
  const dynamic = value.includes('${')
  if (def.variable && !VARIABLE_NAME.test(step.variable ?? '')) fail(`${step.command} needs variable: a bare name of letters, digits and _ (no \${}), for example ORDER_ID.`)
  if (def.value && step.value === undefined) fail(`${step.command} needs value (${def.value}).`)
  if (NEEDS_TEXT.has(step.command) && value.trim() === '') fail(`${step.command} needs a value that is not empty (${def.value}).`)
  if (step.command === 'press_key' && !dynamic && !KEYS.includes(value)) fail(`press_key takes one of: ${KEYS.join(', ')}.`)
  if (step.command === 'swipe' && !dynamic && !SWIPE_DIRECTIONS.includes(value.trim().toLowerCase())) fail(`swipe takes one of: ${SWIPE_DIRECTIONS.join(', ')}.`)
  if ((step.command === 'wait_seconds' || step.command === 'wait_visible') && !dynamic && value.trim() !== '') {
    const n = Number(value)
    // Well below what the engine allows (MAX_WAIT_SECONDS): a session has minutes, and a step that needs longer is a sign of a wrong approach.
    if (!Number.isFinite(n) || n < 0 || n > 120) fail(`${step.command} takes a number of seconds between 0 and 120, as a string such as "2".`)
  }
  if (step.command === 'navigate') {
    const problem = checkUrl(value)
    if (problem) fail(problem)
  }
}

// ---- step numbers within one model reply ----

/**
 * The tool calls of one model reply were all written against the same step list, but they run one after
 * another. Once a call has removed a step or inserted one in the middle, every number from that point on
 * means a different step than the model had in mind: "delete 3, delete 4" would remove the original steps
 * 3 and 5. Such a call is refused, with nothing changed, so the model sends it again knowing the new numbers.
 * Numbers below the change, and appending at the end, are unaffected.
 */
export class TurnNumbering {
  /** The lowest step number whose meaning changed in this reply. */
  private shiftedFrom = Infinity
  /** What changed it: a step that was removed or inserted, or an add_step that was refused. */
  private cause: 'moved' | 'add_step' = 'moved'

  /** A new model reply: its calls see the list as it is now. */
  reset(): void {
    this.shiftedFrom = Infinity
    this.cause = 'moved'
  }

  /** Refuse a step number that an earlier call of this reply has moved. */
  check(n: number, key: string): void {
    if (n < this.shiftedFrom) return
    if (this.cause === 'add_step') {
      fail(
        `Not done: an earlier add_step in this reply was refused, so the step that was to become number ${this.shiftedFrom} was not added and the numbers from there on are not the ones you counted on: ${key} ${n} is another step than you meant, or none. Nothing was changed by this call. Fix the refused add_step first, then send this call again with the number from the current list (get_steps shows it).`,
      )
    }
    fail(
      `Not done: an earlier call in this reply removed or inserted a step, so the steps from number ${this.shiftedFrom} on have moved and ${key} ${n} may no longer be the step you meant. Nothing was changed by this call. Send it again with the number from the current list (get_steps shows it). To change several steps in one reply, work from the highest number down.`,
    )
  }

  /**
   * Step numbers from `from` on now mean other steps: a removal at `from`, an insertion before it, or
   * (`cause` add_step) an append that was refused, which would have been number `from`.
   */
  shift(from: number, cause: 'moved' | 'add_step' = 'moved'): void {
    if (from >= this.shiftedFrom) return
    this.shiftedFrom = from
    this.cause = cause
  }
}

// ---- where a step the assistant writes may send project variables ----

/** The host a URL value will open, as far as it can be told without the variables' values; null when it depends on one. */
function hostBeforeVariables(value: string, baseUrl: string): string | null {
  const known = value.trim().replace(/\$\{\s*BASE_URL\s*\}/g, baseUrl)
  const at = known.indexOf('${')
  const head = at < 0 ? known : known.slice(0, at)
  if (/^[a-z][a-z0-9+.-]*:/i.test(head)) {
    // The whole authority has to be written out before the first variable: scheme://host/ or ?/#.
    const m = /^https?:\/\/([^/?#\\]+)[/?#]/i.exec(head)
    if (!m) return null
    try {
      return new URL(`${head.slice(0, head.indexOf(':'))}://${m[1]}/`).host.toLowerCase()
    } catch {
      return null
    }
  }
  // No scheme: a path on the base URL, unless a variable (or "//host") could turn it into something else.
  if (head === '' || /^[/\\]{2}/.test(head) || !baseUrl) return null
  try {
    return new URL(baseUrl).host.toLowerCase()
  } catch {
    return null
  }
}

/**
 * A navigate step can carry a project variable's value to whatever host its URL names, on every later run.
 * The assistant reads pages it does not control, so a step it writes may only do that towards the site
 * under test: the base URL's host, the app itself, or a host the deployment lists in ALLOWED_HOSTS ("any
 * public host" when no list is configured is not enough here). Returns what is wrong, or null.
 */
export function variableUrlProblem(value: string, o: { baseUrl: string; appOrigin: string; allowedHosts: string | undefined }): string | null {
  const names = [...value.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1].trim())
  const carried = names.filter((n) => !isBuiltInVariable(n))
  if (carried.length === 0) return null
  const what = `This URL sends the value of \${${carried[0]}} along`
  const host = hostBeforeVariables(value, o.baseUrl)
  if (host === null) return `${what}, so the host it opens must be written out before the first variable (or be \${BASE_URL}); a variable cannot decide where its own value is sent.`
  const trusted = new Set<string>()
  for (const url of [o.baseUrl, o.appOrigin]) {
    try {
      trusted.add(new URL(url).host.toLowerCase())
    } catch {
      /* no base URL */
    }
  }
  const listed = (o.allowedHosts ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)
  if (trusted.has(host) || listed.includes(host.replace(/:\d+$/, ''))) return null
  return `${what} to ${host}, which is not the site under test. A step with a variable in its URL may only open the base URL's host${listed.length ? ' or a host on the deployment\'s allow-list' : ''}. If the user really wants this, tell them to add the step themselves in the editor.`
}

/**
 * Put ${NAME} back where a project variable's value shows up in text that goes to the model (a run's error
 * message, the URL a capture ended on). The values are the user's, sometimes credentials; the model only
 * needs to know which variable was there. Short values are left alone: they would match by accident.
 */
export function maskVariables(text: string, variables: Record<string, string>): string {
  // A value is only replaced where it stands by itself. Values are often ordinary words (test, admin, 1234):
  // replaced inside longer words they would turn "Contest results" into "Con${USER} results", and a model
  // that copies such a text into a step ties the step to a variable that has nothing to do with it.
  const names = new Map<string, string>()
  for (const [name, value] of Object.entries(variables)) {
    if (value.length < 4) continue
    for (const form of [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)]) if (!names.has(form)) names.set(form, name)
  }
  if (names.size === 0) return text
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // "By itself": no letter or digit right before or after. A percent-escape before it (%20) is a separator too.
  const alone = (form: string) => `${/^[A-Za-z0-9]/.test(form) ? '(?<=^|[^A-Za-z0-9]|%[0-9A-Fa-f]{2})' : ''}${escape(form)}${/[A-Za-z0-9]$/.test(form) ? '(?![A-Za-z0-9])' : ''}`
  // One pass, longest first: a value is never looked for inside a ${NAME} this function has just written.
  const pattern = new RegExp(
    [...names.keys()]
      .sort((a, b) => b.length - a.length)
      .map(alone)
      .join('|'),
    'g',
  )
  return text.replace(pattern, (found) => `\${${names.get(found) ?? ''}}`)
}

/**
 * maskVariables for a URL the page ended on. The host is left as it is: it is not a secret (the model
 * needs it to tell which site it is on), and a value that happens to be part of a host name must not turn
 * the URL into one the model cannot use.
 */
export function maskUrl(url: string, variables: Record<string, string>): string {
  const m = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)(.*)$/is.exec(url)
  return m ? m[1] + maskVariables(m[2], variables) : maskVariables(url, variables)
}

// ---- what a capture tells the model ----

const clipText = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** Elements listed for the model per capture. A page with more keeps its controls first; see listElements. */
export const MAX_LISTED_ELEMENTS = 200

/**
 * The element list of a capture as the model reads it: one line per element, `e12 "Add breakfast" checkbox`.
 * An element's name already holds its text (or label) and its type, so the line is the id and the name; the
 * text is added only when the name does not contain it. As JSON objects with separate name, type and text
 * fields the same list took about three times the tokens, and it is re-read on every later turn.
 * Left out: elements without a locator (a step cannot use them) and, on a page with more than `max`
 * elements, the plain texts that do not fit after the controls (links, buttons, fields). Page order is kept.
 */
export function listElements(elements: UiElement[], max = MAX_LISTED_ELEMENTS): { lines: string[]; omitted: number } {
  const usable = elements.filter((e) => e.locators.length > 0)
  let keep = new Set(usable)
  if (usable.length > max) {
    const controls = usable.filter((e) => e.type !== 'text')
    const texts = usable.filter((e) => e.type === 'text')
    keep = new Set([...controls.slice(0, max), ...texts.slice(0, Math.max(0, max - controls.length))])
  }
  const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()
  const lines = usable
    .filter((e) => keep.has(e))
    .map((e) => {
      const name = oneLine(e.name)
      const text = oneLine(e.fingerprint.text)
      return `${e.id} ${name}${text && !name.includes(clipText(text, 40)) ? ` | text: ${clipText(text, 100)}` : ''}`
    })
  return { lines, omitted: usable.length - keep.size }
}
