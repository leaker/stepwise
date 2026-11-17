import { COMMAND_BY_ID, COMMANDS, validateSteps, type CommandDef } from '../../shared/commands'
import type { CommandId, ElementRef, Locator, Step, Ui, UiElement } from '../../shared/types'
import { uid } from '../lib/format'

export type Part = { kind: 'target' } | { kind: 'value' } | { kind: 'variable' } | { kind: 'word'; text: string }

const T: Part = { kind: 'target' }
const V: Part = { kind: 'value' }
const N: Part = { kind: 'variable' }
const w = (text: string): Part => ({ kind: 'word', text })

/** What follows the command dropdown on a row, so the row reads as a sentence. */
export const ROW_PARTS: Record<CommandId, Part[]> = {
  navigate: [V],
  click: [T],
  hover: [T],
  check: [T],
  uncheck: [T],
  input: [V, w('to'), T],
  select: [V, w('in'), T],
  press_key: [V],
  screenshot: [w('named'), V],
  comment: [V],
  assert_text_equals: [T, w('is'), V],
  assert_text_contains: [T, w('includes'), V],
  assert_exists: [T],
  assert_not_exists: [T],
  assert_visible: [T],
  assert_url_equals: [V],
  assert_url_contains: [V],
  assert_title_equals: [V],
  assert_title_contains: [V],
  assert_variable_equals: [N, w('is'), V],
  wait_visible: [T, w('for up to'), V, w('seconds')],
  wait_seconds: [V, w('s')],
  store_text: [T, w('as'), N],
  store_fixed: [V, w('as'), N],
  store_url: [w('as'), N],
  if_exists: [T],
  if_variable_equals: [N, w('is'), V],
  else: [],
  end_if: [],
}

const NUMERIC: CommandId[] = ['wait_seconds', 'wait_visible']
export const isNumeric = (c: CommandId) => NUMERIC.includes(c)

const DEFAULT_VALUE: Partial<Record<CommandId, string>> = { wait_seconds: '1', wait_visible: '10', press_key: 'Enter' }

export function newStep(command: CommandId, patch: Partial<Step> = {}): Step {
  const step: Step = { id: uid(), command, ...patch }
  if (step.value === undefined && DEFAULT_VALUE[command] !== undefined) step.value = DEFAULT_VALUE[command]
  return step
}

/** Commands offered by a row's dropdown: an element step can only become another element command. */
export function commandChoices(step: Step): CommandDef[] {
  const def = COMMAND_BY_ID[step.command]
  if (step.target) return COMMANDS.filter((c) => c.target)
  if (def?.target) return COMMANDS
  return COMMANDS.filter((c) => !c.target)
}

export function changeCommand(step: Step, command: CommandId): Step {
  const def = COMMAND_BY_ID[command]
  const next: Step = { ...step, command }
  if (next.value === undefined && def.value && DEFAULT_VALUE[command] !== undefined) next.value = DEFAULT_VALUE[command]
  if (!def.assertion) delete next.continueOnFailure
  return next
}

export function makeTarget(ui: Ui, el: UiElement): ElementRef {
  const locator: Locator = el.locators[0] ?? { key: 'css', value: el.fingerprint.tag }
  return { uiId: ui.id, elementId: el.id, name: el.name, locator, candidates: el.locators, fingerprint: el.fingerprint }
}

/** Errors that block a run: branch structure plus element commands without an element. */
export function stepErrors(steps: Step[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const s of steps) {
    if (!s.disabled && COMMAND_BY_ID[s.command]?.target && !s.target) map.set(s.id, 'No UI element chosen. Click the placeholder, then pick an element on the captured screen.')
  }
  for (const e of validateSteps(steps)) if (!map.has(e.stepId)) map.set(e.stepId, e.message)
  return map
}

/** Indentation of each row inside If / Otherwise / End branch blocks. */
export function stepDepths(steps: Step[]): number[] {
  let depth = 0
  return steps.map((s) => {
    if (s.disabled) return depth
    if (s.command === 'else' || s.command === 'end_if') depth = Math.max(0, depth - 1)
    const mine = depth
    if (s.command === 'if_exists' || s.command === 'if_variable_equals' || s.command === 'else') depth++
    return mine
  })
}

export const sameLocator = (a: Locator, b: Locator) => a.key === b.key && a.value === b.value
