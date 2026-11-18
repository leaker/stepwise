import type { CommandId, ElementType, SharedRef, Step } from './types'

export type Category = 'UI operation' | 'UI input' | 'System' | 'Assertion' | 'Wait' | 'Variable' | 'Conditional'

export interface CommandDef {
  id: CommandId
  label: string
  category: Category
  /** Whether the command acts on a UI element. */
  target: boolean
  /** Label of the `value` parameter, if the command has one. */
  value?: string
  /** Label of the `variable` parameter, if the command has one. */
  variable?: string
  /** Sentence template. {target} {value} {variable} are substituted. */
  sentence: string
  /** Assertions can be set to continue on failure. */
  assertion?: boolean
  /** Whether a screenshot is taken after the step. */
  shot: boolean
  /** May self-healing look for a replacement when the target is missing? */
  healable?: boolean
}

/**
 * Variables every run provides. A project variable cannot use one of these names: the built-in value would
 * silently win at run time.
 */
export const BUILT_IN_VARIABLES = ['BASE_URL', 'BROWSER', 'DEVICE'] as const
export const isBuiltInVariable = (name: string): boolean => (BUILT_IN_VARIABLES as readonly string[]).includes(name)

export const COMMANDS: CommandDef[] = [
  { id: 'click', label: 'Click', category: 'UI operation', target: true, sentence: 'Click {target}', shot: true, healable: true },
  { id: 'hover', label: 'Hover', category: 'UI operation', target: true, sentence: 'Hover over {target}', shot: true, healable: true },
  { id: 'check', label: 'Check', category: 'UI operation', target: true, sentence: 'Check {target}', shot: true, healable: true },
  { id: 'uncheck', label: 'Uncheck', category: 'UI operation', target: true, sentence: 'Uncheck {target}', shot: true, healable: true },
  { id: 'swipe', label: 'Swipe', category: 'UI operation', target: false, value: 'Direction', sentence: 'Swipe {value}', shot: true },

  { id: 'input', label: 'Input', category: 'UI input', target: true, value: 'Text', sentence: 'Input {value} to {target}', shot: true, healable: true },
  { id: 'select', label: 'Select pull-down menu', category: 'UI input', target: true, value: 'Option', sentence: 'Select {value} in {target}', shot: true, healable: true },
  { id: 'press_key', label: 'Input keyboard key', category: 'UI input', target: false, value: 'Key', sentence: 'Press {value} key', shot: true },

  { id: 'navigate', label: 'Navigate to URL', category: 'System', target: false, value: 'URL', sentence: 'Navigate to {value}', shot: true },
  { id: 'screenshot', label: 'Take screenshot', category: 'System', target: false, value: 'Name', sentence: 'Take screenshot {value}', shot: true },
  { id: 'comment', label: 'Comment', category: 'System', target: false, value: 'Comment', sentence: '// {value}', shot: false },
  // Calls a project-level shared step; `value` is its id. A run replaces the call with the shared step's steps (shared/expand.ts).
  { id: 'shared_step', label: 'Shared step', category: 'System', target: false, value: 'Shared step', sentence: 'Shared step {value}', shot: false },

  { id: 'assert_text_equals', label: 'Assert UI element equals', category: 'Assertion', target: true, value: 'Expected text', sentence: 'Assert {target} equals {value}', assertion: true, shot: true, healable: true },
  { id: 'assert_text_contains', label: 'Assert UI element contains', category: 'Assertion', target: true, value: 'Expected text', sentence: 'Assert {target} contains {value}', assertion: true, shot: true, healable: true },
  { id: 'assert_exists', label: 'Assert UI element exists', category: 'Assertion', target: true, sentence: 'Assert {target} exists', assertion: true, shot: true, healable: true },
  { id: 'assert_not_exists', label: 'Assert UI element does not exist', category: 'Assertion', target: true, sentence: 'Assert {target} does not exist', assertion: true, shot: true },
  { id: 'assert_visible', label: 'Assert UI element is visible', category: 'Assertion', target: true, sentence: 'Assert {target} is visible', assertion: true, shot: true, healable: true },
  { id: 'assert_url_equals', label: 'Assert URL equals', category: 'Assertion', target: false, value: 'URL', sentence: 'Assert URL equals {value}', assertion: true, shot: true },
  { id: 'assert_url_contains', label: 'Assert URL contains', category: 'Assertion', target: false, value: 'Text', sentence: 'Assert URL contains {value}', assertion: true, shot: true },
  { id: 'assert_title_equals', label: 'Assert the page title equals', category: 'Assertion', target: false, value: 'Title', sentence: 'Assert the page title equals {value}', assertion: true, shot: true },
  { id: 'assert_title_contains', label: 'Assert the page title contains', category: 'Assertion', target: false, value: 'Text', sentence: 'Assert the page title contains {value}', assertion: true, shot: true },
  { id: 'assert_variable_equals', label: 'Assert variable equals', category: 'Assertion', target: false, variable: 'Variable', value: 'Expected value', sentence: 'Assert variable {variable} equals {value}', assertion: true, shot: false },

  { id: 'wait_visible', label: 'Wait until UI element is visible', category: 'Wait', target: true, value: 'Max seconds', sentence: 'Wait until {target} is visible (up to {value} s)', shot: true, healable: true },
  { id: 'wait_seconds', label: 'Wait for fixed seconds', category: 'Wait', target: false, value: 'Seconds', sentence: 'Wait for {value} seconds', shot: false },

  { id: 'store_text', label: 'Store value', category: 'Variable', target: true, variable: 'Variable', sentence: 'Store the text of {target} to {variable}', shot: false, healable: true },
  { id: 'store_fixed', label: 'Store fixed value', category: 'Variable', target: false, variable: 'Variable', value: 'Value', sentence: 'Store {value} to {variable}', shot: false },
  { id: 'store_url', label: 'Store URL', category: 'Variable', target: false, variable: 'Variable', sentence: 'Store the current URL to {variable}', shot: false },

  { id: 'if_exists', label: 'If UI element exists', category: 'Conditional', target: true, sentence: 'If {target} exists', shot: false },
  { id: 'if_variable_equals', label: 'If variable equals', category: 'Conditional', target: false, variable: 'Variable', value: 'Value', sentence: 'If variable {variable} equals {value}', shot: false },
  { id: 'else', label: 'Otherwise', category: 'Conditional', target: false, sentence: 'Otherwise', shot: false },
  { id: 'end_if', label: 'End branch', category: 'Conditional', target: false, sentence: 'End branch', shot: false },
]

export const COMMAND_BY_ID = Object.fromEntries(COMMANDS.map((c) => [c.id, c])) as Record<CommandId, CommandDef>

export const CATEGORIES: Category[] = ['UI operation', 'UI input', 'System', 'Assertion', 'Wait', 'Variable', 'Conditional']

/** Command a step gets when the user picks an element of this type. */
export const DEFAULT_COMMAND: Record<ElementType, CommandId> = {
  button: 'click',
  link: 'click',
  input: 'input',
  textarea: 'input',
  checkbox: 'check',
  radio: 'click',
  select: 'select',
  image: 'assert_exists',
  text: 'assert_text_equals',
  other: 'click',
}

/** Keys offered by the "Input keyboard key" command (Playwright key names). */
export const KEYS = ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']

/**
 * Directions of the "Swipe" command, named after the finger: swiping up moves the page up and shows
 * what is below, as on a phone.
 */
export const SWIPE_DIRECTIONS = ['up', 'down', 'left', 'right']

/** How a shared step is written wherever it is named: `S1: Sign in`. */
export const sharedLabel = (ref: Pick<SharedRef, 'number' | 'name'>): string => `S${ref.number}: ${ref.name}`

/**
 * Render a step as a plain sentence, e.g. `Input "alice" to "Email" input area`. A shared step call holds
 * only an id: `shared` resolves it (the steps of a run carry the name themselves, in `call`).
 */
export function stepSentence(step: Step, shared?: (id: string) => Pick<SharedRef, 'number' | 'name'> | undefined): string {
  const def = COMMAND_BY_ID[step.command]
  if (!def) return step.command
  if (step.command === 'shared_step') {
    const ref = step.call ?? shared?.(step.value ?? '')
    if (ref) return `Shared step ${sharedLabel(ref)}`
    // Without a way to look the name up, say no more than is known.
    return !step.value ? 'Shared step (none chosen)' : shared ? 'Shared step (deleted)' : 'Shared step'
  }
  const bare = def.id === 'comment' || def.id === 'wait_seconds' || def.id === 'wait_visible' || def.id === 'press_key' || def.id === 'swipe'
  const parts: Record<string, string> = {
    target: step.target ? step.target.name : '(no element)',
    value: bare ? (step.value ?? '') : JSON.stringify(step.value ?? ''),
    variable: step.variable ?? '(no variable)',
  }
  // One pass with a function: a value such as "pa$$word" or "a$&b" is put in as it is (a replacement string
  // would read $$ and $& as patterns), and an element named "{value}" is not substituted a second time.
  return def.sentence.replace(/\{(target|value|variable)\}/g, (_, key: string) => parts[key]).trim()
}

/** Limits of what a test case stores. The API refuses more (worker/validate.ts), so the editor does not let it be entered. */
export const MAX_STEPS = 500
/** Longest value or variable name of a step, in characters. */
export const MAX_STEP_TEXT = 5000
export const MAX_ELEMENT_NAME = 300
export const MAX_LOCATOR_LENGTH = 2000

/**
 * Commands whose value must not be empty, with what the editor says when it is. An empty text is "contained"
 * in every text, so such an assertion would pass whatever the page shows. (An empty text to type, or to
 * compare a whole text with, is legitimate: that is how a field is checked to be empty.)
 */
export const EMPTY_VALUE_PROBLEM: Partial<Record<CommandId, string>> = {
  select: 'Enter the option to select.',
  assert_text_contains: 'Enter the text to look for. An empty text is found in any text, so this step would always pass.',
  assert_url_equals: 'Enter the URL to expect.',
  assert_url_contains: 'Enter the text to look for. An empty text is found in any URL, so this step would always pass.',
  assert_title_contains: 'Enter the text to look for. An empty text is found in any title, so this step would always pass.',
}

/** Longest fixed wait and longest "wait until visible" a step may ask for, in seconds. */
export const MAX_WAIT_SECONDS = 300

/**
 * Structural errors in IF / Otherwise / End branch nesting. Empty array means the steps can run.
 *
 * `span`: only the steps at these inclusive 1-based positions are executed (a partial run, or the replay
 * before a capture). A branch that is still open where the span ends is fine then: the steps that close it
 * are simply not reached, which is the normal state of a branch that is being built. And a span that does
 * not start at the first step may start inside a branch, so an "Otherwise" or "End branch" whose "If" is
 * before the span is fine too.
 */
export function validateSteps(steps: Step[], span?: { from: number; to: number } | null): { stepId: string; message: string }[] {
  const errors: { stepId: string; message: string }[] = []
  const stack: { id: string; hasElse: boolean }[] = []
  const first = span ? Math.max(1, span.from) : 1
  const last = span ? Math.min(steps.length, span.to) : steps.length
  const inside = !!span && first > 1
  for (let i = first - 1; i < last; i++) {
    const s = steps[i]
    if (s.disabled) continue
    if (s.command === 'if_exists' || s.command === 'if_variable_equals') stack.push({ id: s.id, hasElse: false })
    else if (s.command === 'else') {
      const top = stack[stack.length - 1]
      if (!top) {
        if (inside) stack.push({ id: s.id, hasElse: true })
        else errors.push({ stepId: s.id, message: '"Otherwise" has no matching "If"' })
      } else if (top.hasElse) errors.push({ stepId: s.id, message: 'This branch already has an "Otherwise"' })
      else top.hasElse = true
    } else if (s.command === 'end_if') {
      if (!stack.pop() && !inside) errors.push({ stepId: s.id, message: '"End branch" has no matching "If"' })
    }
  }
  if (!span) for (const open of stack) errors.push({ stepId: open.id, message: '"If" is missing its "End branch"' })
  return errors
}

/** The name of the next capture: one more than the highest `UI<n>` there is, so a deleted capture's name is not handed out again. */
export function nextUiName(names: string[]): string {
  let highest = 0
  for (const name of names) {
    const m = /^UI(\d{1,9})$/.exec(name)
    if (m) highest = Math.max(highest, Number(m[1]))
  }
  return `UI${highest + 1}`
}
