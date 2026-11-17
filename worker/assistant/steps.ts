// Turning the model's tool input into a Step, with every rule the editor and the engine enforce checked
// up front so a mistake comes back as a message the model can act on. Pure: no database, no browser.
import { COMMAND_BY_ID, KEYS, SWIPE_DIRECTIONS } from '../../shared/commands'
import type { CommandId, ElementRef, Step, Ui } from '../../shared/types'

export class ToolInputError extends Error {}

const fail = (message: string): never => {
  throw new ToolInputError(message)
}

export type Input = Record<string, unknown>

export function asInput(value: unknown): Input {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail('The tool input must be a JSON object.')
  return value as Input
}

export function optionalString(input: Input, key: string, max = 5000): string | undefined {
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

export function commandOf(value: unknown): CommandId {
  if (typeof value !== 'string' || !Object.hasOwn(COMMAND_BY_ID, value)) return fail(`Unknown command "${String(value)}". Use a command id from the catalogue, for example click, input, navigate or assert_text_equals.`)
  return value as CommandId
}

export function targetFrom(uis: Ui[], uiId: string | undefined, elementId: string | undefined, device: string): ElementRef {
  if (!uiId || !elementId) return fail('This command acts on an element: pass ui_id and element_id from a capture_screen result.')
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
const NEEDS_TEXT = new Set<CommandId>(['navigate', 'press_key', 'swipe', 'select', 'wait_seconds', 'assert_text_contains', 'assert_url_equals', 'assert_url_contains', 'assert_title_equals', 'assert_title_contains'])
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
    if (!Number.isFinite(n) || n < 0 || n > 120) fail(`${step.command} takes a number of seconds between 0 and 120, as a string such as "2".`)
  }
  if (step.command === 'navigate') {
    const problem = checkUrl(value)
    if (problem) fail(problem)
  }
}
