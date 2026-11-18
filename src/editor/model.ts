import { COMMAND_BY_ID, COMMANDS, MAX_WAIT_SECONDS, SWIPE_DIRECTIONS, validateSteps, type CommandDef } from '../../shared/commands'
import { callProblems, type SharedLookup, type SharedSource } from '../../shared/expand'
import type { CommandId, ElementRef, Locator, Step, TestCase, Ui, UiElement } from '../../shared/types'
import { uid } from '../lib/format'

export type Part = { kind: 'target' } | { kind: 'value' } | { kind: 'variable' } | { kind: 'word'; text: string } | { kind: 'shared' }

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
  swipe: [V],
  screenshot: [w('named'), V],
  comment: [V],
  shared_step: [{ kind: 'shared' }],
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

const DEFAULT_VALUE: Partial<Record<CommandId, string>> = { wait_seconds: '1', wait_visible: '10', press_key: 'Enter', swipe: 'up' }

export function newStep(command: CommandId, patch: Partial<Step> = {}): Step {
  const step: Step = { id: uid(), command, ...patch }
  if (step.value === undefined && DEFAULT_VALUE[command] !== undefined) step.value = DEFAULT_VALUE[command]
  return step
}

/** Commands offered by a row's dropdown: an element step can only become another element command. */
export function commandChoices(step: Step): CommandDef[] {
  const def = COMMAND_BY_ID[step.command]
  // A call is added from the palette, where the shared step is chosen: no other row turns into one.
  const others = COMMANDS.filter((c) => c.id !== 'shared_step')
  if (step.target) return others.filter((c) => c.target)
  if (def?.target) return others
  return others.filter((c) => !c.target)
}

/** What a command's value is: free text, a number of seconds, a key name, a swipe direction, a shared step id, or nothing at all. */
type ValueKind = 'none' | 'text' | 'seconds' | 'key' | 'direction' | 'shared'
const valueKind = (command: CommandId): ValueKind =>
  !COMMAND_BY_ID[command]?.value ? 'none' : command === 'shared_step' ? 'shared' : isNumeric(command) ? 'seconds' : command === 'press_key' ? 'key' : command === 'swipe' ? 'direction' : 'text'

/** The project's shared steps as the look-up that expansion and validation use. */
export function sharedLookup(list: TestCase[] | undefined): SharedLookup {
  const byId = new Map((list ?? []).map((t): [string, SharedSource] => [t.id, { id: t.id, projectId: t.projectId, number: t.number, name: t.name, steps: t.steps }]))
  return (id) => byId.get(id)
}

/** What stepErrors needs to check shared step calls. */
export interface SharedContext {
  /** Absent while the project's shared steps are still loading: calls are then not checked. */
  lookup?: SharedLookup
  projectId: string
  /** The steps being checked are a shared step's own. */
  nested: boolean
}

/** Parameters only carry over to a command that reads them the same way: a text is not a number of seconds. */
export function changeCommand(step: Step, command: CommandId): Step {
  const def = COMMAND_BY_ID[command]
  const next: Step = { ...step, command }
  if (valueKind(command) !== valueKind(step.command)) delete next.value
  if (!def.variable) delete next.variable
  if (next.value === undefined && def.value && DEFAULT_VALUE[command] !== undefined) next.value = DEFAULT_VALUE[command]
  if (!def.assertion) delete next.continueOnFailure
  return next
}

export function makeTarget(ui: Ui, el: UiElement): ElementRef {
  const locator: Locator = el.locators[0] ?? { key: 'css', value: el.fingerprint.tag }
  return { uiId: ui.id, elementId: el.id, name: el.name, locator, candidates: el.locators, fingerprint: el.fingerprint }
}

/** A parameter the engine would reject as soon as the step runs, or null. Mirrors worker/engine/executor.ts. */
function parameterError(s: Step): string | null {
  const def = COMMAND_BY_ID[s.command]
  if (!def) return null
  const value = s.value ?? ''
  if (def.variable && !/^[A-Za-z_][A-Za-z0-9_]*$/.test((s.variable ?? '').trim())) {
    return (s.variable ?? '').trim() ? 'The variable name must start with a letter or _ and use only letters, digits and _.' : 'Enter a variable name.'
  }
  if (s.command === 'navigate' && !value.trim()) return 'Enter the URL to open.'
  if (s.command === 'press_key' && !value.trim()) return 'Choose a key.'
  if (s.command === 'swipe' && !value.includes('${') && !SWIPE_DIRECTIONS.includes(value.trim().toLowerCase())) return 'Choose a direction: up, down, left or right.'
  if (isNumeric(s.command) && !value.includes('${')) {
    // "Wait until visible" falls back to 10 s when left empty; a fixed wait needs a number.
    if (!value.trim()) return s.command === 'wait_seconds' ? 'Enter the number of seconds to wait.' : null
    const n = Number(value)
    if (!Number.isFinite(n) || n < 0) return `“${value}” is not a number of seconds.`
    if (n > MAX_WAIT_SECONDS) return `A step can wait ${MAX_WAIT_SECONDS} seconds at most.`
  }
  return null
}

/**
 * Errors that block a run: branch structure, element commands without an element, unusable parameters.
 * `upTo`: only what stops a partial run that ends at this step (1-based): the steps after it are not looked
 * at, and a branch that is still open there is fine.
 */
export function stepErrors(all: Step[], shared?: SharedContext, upTo?: number): Map<string, string> {
  const map = new Map<string, string>()
  const steps = upTo === undefined ? all : all.slice(0, upTo)
  if (shared && (shared.lookup || shared.nested)) {
    for (const p of callProblems(steps, shared.lookup ?? (() => undefined), shared.projectId, shared.nested)) map.set(p.stepId, `${p.message}.`)
  }
  for (const s of steps) {
    if (s.disabled || map.has(s.id)) continue
    if (COMMAND_BY_ID[s.command]?.target && !s.target) map.set(s.id, 'No UI element chosen. Click the placeholder, then pick an element on the captured screen.')
    else {
      const problem = parameterError(s)
      if (problem) map.set(s.id, problem)
    }
  }
  for (const e of validateSteps(steps, upTo === undefined ? null : { from: 1, to: steps.length })) if (!map.has(e.stepId)) map.set(e.stepId, e.message)
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

/** Would the two steps do the same thing when run? (The element's display name does not matter.) */
export function sameStep(a: Step, b: Step): boolean {
  if (a.command !== b.command || (a.value ?? '') !== (b.value ?? '') || (a.variable ?? '') !== (b.variable ?? '')) return false
  if (!!a.disabled !== !!b.disabled || !!a.continueOnFailure !== !!b.continueOnFailure) return false
  if (!a.target || !b.target) return !a.target && !b.target
  return a.target.uiId === b.target.uiId && a.target.elementId === b.target.elementId && sameLocator(a.target.locator, b.target.locator)
}
