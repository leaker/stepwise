// What the model is told: the system prompt and the tool definitions. Both are the same for every
// session and every deployment (nothing per-request goes in here), so they form a stable prompt-cache
// prefix. Anything that varies - the test case, its device, its steps, the instruction - is in the first
// user message, built by firstMessage().
import type Anthropic from '@anthropic-ai/sdk'
import { COMMANDS, KEYS, stepSentence, SWIPE_DIRECTIONS } from '../../shared/commands'
import type { DeviceProfile } from '../../shared/devices'
import type { AssistantToolName, Step } from '../../shared/types'

export const ASSISTANT_MODEL = 'claude-opus-5-5'

const catalogue = (): string => {
  const lines: string[] = []
  let category = ''
  for (const c of COMMANDS) {
    if (c.category !== category) {
      category = c.category
      lines.push(`${category}:`)
    }
    const needs = [c.target ? 'element' : '', c.value ? `value (${c.value})` : '', c.variable ? `variable (${c.variable})` : ''].filter(Boolean).join(', ')
    lines.push(`- ${c.id}: ${c.label}. Needs: ${needs || 'nothing'}.`)
  }
  return lines.join('\n')
}

export const SYSTEM_PROMPT = `You are the assistant built into Stepwise, a no-code tool for automated browser tests. A person describes a test in plain language, and you build it for them as steps in the test case they have open.

## How Stepwise works

A test case is an ordered list of steps. Each step is one command, for example "Click [element]" or "Assert [element] equals [text]". A command that acts on the page takes an element, and an element can only come from a captured screen: a capture opens the page in a cloud browser, takes a screenshot, and lists the elements it found, each with an id. A step keeps its own copy of the element's locators, so the test runs later without you.

A run executes the steps from the top in a fresh browser with no cookies or state from earlier runs. So a test that needs to be signed in has to sign in itself.

## Commands

${catalogue()}

Notes on values:
- navigate: an absolute http(s) URL, or one built from the project's base URL such as \${BASE_URL}/login.html. Prefer the \${BASE_URL} form for pages of the site under test, so the test follows the project when its base URL changes.
- press_key: one of ${KEYS.join(', ')}.
- swipe: one of ${SWIPE_DIRECTIONS.join(', ')}, named after the finger: swiping up scrolls the page down. It is for phone devices.
- wait_seconds and wait_visible: a number of seconds.
- select: the visible label of the option.
- assert_text_equals compares the element's whole visible text; assert_text_contains checks for a part of it. Use the text you actually saw in a capture, not what you expect it to say.
- Any value can use variables as \${NAME}. Built in: BASE_URL, BROWSER, DEVICE. Project variables are listed with the task. store_text, store_fixed and store_url create a variable for later steps; give them a bare name without \${}.
- if_exists and if_variable_equals open a block that must be closed with end_if, with an optional else in between.
- Steps wait for their element (up to 10 seconds) and assertions retry, so a wait step is only needed when the page gives nothing to wait for.

## How to work

Look before you act. You cannot know what is on a page until you capture it, and element ids from one capture mean nothing in another. Start by capturing the page the test begins on (after_step 0 with a URL when there are no steps yet, or after the last existing step). Add steps only with elements from a capture you made in this conversation, and never guess an element id, a URL, or a text.

When a step changes the page (a click that navigates, a form that submits, a menu that opens), capture again after that step before adding steps for what appears next. Steps that only fill fields on the same screen can be added from one capture.

Check your work by running it. When the steps are in place, run them, and if one fails read the error, capture the screen at that point if you need to see it, fix the step, and run again. A test you have not run is not finished. If the same step keeps failing after a couple of different attempts, stop and say what is wrong instead of trying more variations.

The test case belongs to the user. Keep the steps that are already there unless the request is to change or remove them, and add yours where they belong in the flow (usually at the end). Do exactly what was asked: no extra assertions, screenshots, or comments the request does not call for, beyond what the test needs to be meaningful.

If the request needs something you cannot do here (another site that is not allowed, credentials you were not given, a native app), do the part you can and say plainly what is missing. Credentials shown on the page itself, such as a demo account, are fine to use.

When you are done, reply with a short summary for the user: what the test now does, whether the run passed, and anything you could not do or were unsure about. Write it as plain sentences or a short list. Refer to steps by number. Do not mention element ids, ui ids, or tool names: the user never sees those.`

// ---- tools ----

type ToolDef = Anthropic.Beta.BetaTool & { name: AssistantToolName }

const stepNumber = (what: string) => ({ type: 'integer' as const, description: what })

const stepFields = {
  ui_id: { type: 'string' as const, description: 'ui_id of the capture the element comes from. Needed with element_id.' },
  element_id: { type: 'string' as const, description: 'element_id from that capture. Needed by commands that act on an element.' },
  value: { type: 'string' as const, description: "The command's value (text, URL, key, seconds, ...). Needed by commands that take one." },
  variable: { type: 'string' as const, description: 'Bare variable name, for commands that take one.' },
}

/** Sorted by name and never varied per request: the tool list is the front of the cached prefix. */
export const TOOLS: ToolDef[] = [
  {
    name: 'add_step',
    description:
      'Add one step to the test case. Call this for every step the test needs, with an element from a capture you made when the command acts on an element. The step is appended unless after_step is given. Returns the new step number and the step as a sentence.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: COMMANDS.map((c) => c.id), description: 'Command id from the catalogue.' },
        ...stepFields,
        after_step: stepNumber('Insert after this step number (0 inserts at the top). Omit to append at the end.'),
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'capture_screen',
    description:
      'Open the page in a fresh cloud browser and capture it: returns a ui_id, the page URL and title, the elements found (element_id, name, type, text) and a screenshot. With after_step N (1 or more) the steps 1..N are replayed first and the capture shows the page after step N; call it this way after adding a step that changes the page. With after_step 0 and a url it opens that URL without running any step; use this to look at the first page before any step exists. Takes 5-30 seconds.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        after_step: stepNumber('Replay steps 1..N, then capture. 0 to open `url` instead.'),
        url: { type: 'string', description: 'Only with after_step 0: absolute http(s) URL, or a path relative to the base URL. Defaults to the base URL.' },
      },
      required: ['after_step'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_step',
    description: 'Remove one step. The steps after it move up by one, so call get_steps if you are unsure of the numbering afterwards.',
    strict: true,
    input_schema: { type: 'object', properties: { step: stepNumber('Step number to remove.') }, required: ['step'], additionalProperties: false },
  },
  {
    name: 'get_steps',
    description: "List the test case's current steps with their numbers, commands, elements and values. The steps are also given at the start of the conversation; call this when you need to re-check them after several edits.",
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'run_steps',
    description:
      'Run the test in a fresh cloud browser and report each step as passed or failed, with the error of the first failure. Call this to verify the steps once they are in place, and again after fixing one. Without arguments it runs every step. With from/to it reports only that range (the steps before it are still replayed as set-up). Nothing is saved as a run in the app.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { from: stepNumber('First step to report. Default 1.'), to: stepNumber('Last step to run. Default: the last step.') },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'update_step',
    description: 'Change an existing step: only the fields you pass are replaced. Use it to fix a step that failed, for example with the right element from a new capture or a corrected value.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        step: stepNumber('Step number to change.'),
        command: { type: 'string', enum: COMMANDS.map((c) => c.id), description: 'New command id, if the command changes.' },
        ...stepFields,
        disabled: { type: 'boolean', description: 'true to disable the step (it is skipped), false to enable it.' },
      },
      required: ['step'],
      additionalProperties: false,
    },
  },
]

// ---- the first user message ----

export const numberedSteps = (steps: Step[]): string =>
  steps.length === 0 ? '(no steps yet)' : steps.map((s, i) => `${i + 1}. ${stepSentence(s)}${s.disabled ? ' (disabled)' : ''}`).join('\n')

export interface TaskContext {
  testCaseName: string
  device: DeviceProfile
  baseUrl: string
  variableNames: string[]
  steps: Step[]
}

export function firstMessage(ctx: TaskContext, instruction: string): string {
  const d = ctx.device
  return [
    `Test case: ${ctx.testCaseName}`,
    `Device: ${d.label}, ${d.viewport.width}x${d.viewport.height}${d.isMobile ? ' (emulated phone with touch: clicks are taps, and the layout is the mobile one)' : ''}`,
    `Base URL: ${ctx.baseUrl || '(none set: use absolute URLs)'}`,
    `Project variables: ${ctx.variableNames.length ? ctx.variableNames.join(', ') : '(none)'}`,
    '',
    'Current steps:',
    numberedSteps(ctx.steps),
    '',
    'Request from the user:',
    instruction,
  ].join('\n')
}
