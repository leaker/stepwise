// Shared steps at run time. A test case stores a call as one step (`shared_step`, value = the shared
// step's id). When a run is created its step list is expanded: the call stays as a marker row and the
// shared step's steps follow it, each remembering where it came from. Everything after that - the engine,
// the report, self-healing - works on the flat list, and these helpers translate between the flat list
// and the numbering the user sees (the call is one step; its steps are 3.1, 3.2, ...).
// Pure functions: the Worker, the editor and the in-browser mock all use them.
import { validateSteps } from './commands'
import type { SharedRef, Step } from './types'

/** What expansion needs to know about a shared step. */
export interface SharedSource extends SharedRef {
  projectId: string
  steps: Step[]
}

export type SharedLookup = (id: string) => SharedSource | undefined

export interface StepProblem {
  /** A step of the list that was expanded (for a problem inside a shared step: the call). */
  stepId: string
  message: string
}

export interface Expansion {
  steps: Step[]
  problems: StepProblem[]
}

export const NESTED_SHARED_MESSAGE = 'A shared step cannot call another shared step'

const label = (s: SharedRef): string => `S${s.number}`

/** Why this call cannot run, or null. `nested`: the list being checked is itself a shared step. */
function callProblem(step: Step, lookup: SharedLookup, projectId: string, nested: boolean): string | null {
  if (nested) return NESTED_SHARED_MESSAGE
  if (!step.value) return 'No shared step chosen'
  const shared = lookup(step.value)
  if (!shared) return 'The shared step this step calls no longer exists'
  if (shared.projectId !== projectId) return 'The shared step this step calls belongs to another project'
  if (shared.steps.some((s) => s.command === 'shared_step')) return `Shared step ${label(shared)} calls another shared step, which is not supported`
  if (validateSteps(shared.steps).length) return `Shared step ${label(shared)} has an unbalanced If / Otherwise / End branch`
  return null
}

/**
 * Replace every enabled shared step call by a marker row plus the shared step's steps. A disabled call is
 * kept as it is (nothing of it runs); a disabled step inside a shared step is copied and stays disabled.
 * A call that cannot be expanded is kept unexpanded and reported in `problems`: such a list must not run.
 * `nested`: `steps` are a shared step's own steps, where any call is an error.
 */
export function expandSteps(steps: Step[], lookup: SharedLookup, projectId: string, nested = false): Expansion {
  const out: Step[] = []
  const problems: StepProblem[] = []
  for (const step of steps) {
    // `call` and `origin` only exist in run snapshots; whatever is passed in, the result is built fresh.
    const { call: _call, origin: _origin, ...plain } = step
    if (plain.command !== 'shared_step' || plain.disabled) {
      out.push(plain)
      continue
    }
    const message = callProblem(plain, lookup, projectId, nested)
    if (message) {
      problems.push({ stepId: plain.id, message })
      out.push(plain)
      continue
    }
    const shared = lookup(plain.value!)!
    const ref: SharedRef = { id: shared.id, number: shared.number, name: shared.name }
    out.push({ ...plain, call: ref })
    // The compound id only has to be unique within the run (the same shared step can be called twice); it is never parsed.
    for (const inner of shared.steps) out.push({ ...inner, id: `${plain.id}.${inner.id}`, origin: { callId: plain.id, stepId: inner.id, shared: ref } })
  }
  return { steps: out, problems }
}

/** The problems of expandSteps without building the list: what the editor shows on a call row. */
export function callProblems(steps: Step[], lookup: SharedLookup, projectId: string, nested = false): StepProblem[] {
  const problems: StepProblem[] = []
  for (const step of steps) {
    if (step.command !== 'shared_step' || step.disabled) continue
    const message = callProblem(step, lookup, projectId, nested)
    if (message) problems.push({ stepId: step.id, message })
  }
  return problems
}

export interface StepPosition {
  /** 1-based position in the test case. A step of a shared step has the number of its call. */
  number: number
  /** 1-based position inside the shared step. */
  sub?: number
}

/** Position of every step of a run snapshot, in the numbering the user sees. Identity for a list without shared steps. */
export function positionsOf(runSteps: Step[]): StepPosition[] {
  let number = 0
  let sub = 0
  return runSteps.map((s) => {
    if (s.origin) return { number: Math.max(1, number), sub: ++sub }
    sub = 0
    return { number: ++number }
  })
}

/** `3` or `3.2`. */
export const positionLabel = (p: StepPosition): string => (p.sub ? `${p.number}.${p.sub}` : `${p.number}`)

/** How many steps the test case had: a shared step call counts as one. */
export const topLevelCount = (runSteps: Step[]): number => runSteps.reduce((n, s) => (s.origin ? n : n + 1), 0)

/**
 * A range in the user's numbering as inclusive 1-based positions in the flat list. A range that ends on a
 * call ends on the last step of that call.
 */
export function flatRange(runSteps: Step[], range: { from: number; to: number }): { from: number; to: number } {
  const positions = positionsOf(runSteps)
  const first = positions.findIndex((p) => p.number === range.from)
  const last = positions.findLastIndex((p) => p.number === range.to)
  return { from: first < 0 ? range.from : first + 1, to: last < 0 ? range.to : last + 1 }
}

/** The steps a run reports on: enabled, inside the range, and not a marker row. */
export function reportedSteps(runSteps: Step[], range: { from: number; to: number } | null): Step[] {
  const flat = range ? flatRange(runSteps, range) : { from: 1, to: runSteps.length }
  return runSteps.filter((s, i) => !s.disabled && !s.call && i + 1 >= flat.from && i + 1 <= flat.to)
}
