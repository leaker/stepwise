// The assistant's self-review, enforced: what has to be true before a session may end, and the checklist
// that sets the request against the steps. The model is asked to do both in the prompt; this is what holds
// when it does not. Pure: no database, no browser.
import { COMMAND_BY_ID, stepSentence } from '../../shared/commands'
import type { Step } from '../../shared/types'
import type { SharedNames } from './prompt'
import { ToolInputError, type Input } from './steps'

// ---- may the session end? ----

export type Verdict =
  | { ok: true }
  /**
   * `reminder` goes to the model, `event` into the transcript. `final`: the model was reminded of this
   * before and nothing came of it, so the session ends here, as failed, with `event` as the reason.
   */
  | { ok: false; reminder: string; event: string; final: boolean }

/** How often the model is sent back for the same reason, and in total, before the session is stopped. */
const MAX_SAME_REMINDER = 2
const MAX_REMINDERS = 6

const FROM = 'Stepwise (automatic check, not the user):'

/**
 * The language a request is written in, where its script tells: the summary has to be in it, and a model
 * that has read pages and tool results in English for a whole session tends to answer in English.
 */
export function requestLanguage(request: string): { name: string; script: RegExp } | null {
  if (/[\u3040-\u30ff]/.test(request)) return { name: 'Japanese', script: /[\u3040-\u30ff]/ }
  if (/[\uac00-\ud7af]/.test(request)) return { name: 'Korean', script: /[\uac00-\ud7af]/ }
  if (/[\u3400-\u9fff]/.test(request)) return { name: 'Chinese', script: /[\u3400-\u9fff]/ }
  return null
}
const QUESTION = /[?？]\s*$/

/**
 * What happened to the test in this session, as far as finishing is concerned. A session that changed the
 * test may only end when the whole test was run after the last change, that run passed (or the model has
 * stated in review_request what it could not do), and the request was set against the final steps.
 */
export class Completion {
  /** The steps or the data table were changed in this session. */
  touched = false
  /** They were changed since the last run of the whole test. */
  private unverified = false
  private lastRun: { passed: boolean; what: string } | null = null
  /** The checklist made after the last change: how many points it left as not done. */
  private review: { notDone: number } | null = null
  private reminded = new Map<string, number>()
  private reminders = 0

  /** `request`: what the user wrote, for the language the summary has to be in. */
  constructor(private readonly request = '') {}

  changed(): void {
    this.touched = true
    this.unverified = true
    this.review = null
  }

  /** A run finished. `whole`: every step (and every data row tried) was run; `what`: one line about a failure. */
  ran(whole: boolean, passed: boolean, what: string): void {
    if (whole) this.unverified = false
    if (whole || !passed) this.lastRun = { passed, what }
  }

  reviewed(notDone: number): void {
    this.review = { notDone }
  }

  /** What review_request tells the model about the state of the test. */
  state(): { verified: boolean; note: string } {
    if (this.unverified) return { verified: false, note: 'The steps were changed after the last run of the whole test: run it (run_steps without arguments) before you finish.' }
    if (this.lastRun && !this.lastRun.passed) return { verified: false, note: `The last run failed: ${this.lastRun.what}` }
    return { verified: true, note: this.lastRun ? 'The last run of the whole test passed, and nothing was changed since.' : 'Nothing was changed in this session.' }
  }

  /** `closing`: the text the model wants to end with. */
  verdict(closing: string): Verdict {
    const problem = this.problem(closing)
    if (!problem) return { ok: true }
    const times = (this.reminded.get(problem.key) ?? 0) + 1
    this.reminded.set(problem.key, times)
    this.reminders++
    return { ok: false, reminder: `${FROM} ${problem.reminder}`, event: problem.event, final: times > MAX_SAME_REMINDER || this.reminders > MAX_REMINDERS }
  }

  private problem(closing: string): { key: string; reminder: string; event: string } | null {
    const language = requestLanguage(this.request)
    // Asked for once; a summary in the wrong language is still a summary.
    const wrongLanguage =
      language && closing.trim() !== '' && !language.script.test(closing) && !this.reminded.has('language')
        ? {
            key: 'language',
            event: `The summary was not written in ${language.name}, the language of the request`,
            reminder: `the request is written in ${language.name}, and your summary is not. Write the same summary again in ${language.name}, and nothing else. Texts of the site (element names, values, expected texts) stay as the site writes them.`,
          }
        : null
    if (!this.touched) {
      if (wrongLanguage) return wrongLanguage
      // Nothing was built. That is fine for a question about the test; a question back to the user is not an answer.
      if (!QUESTION.test(closing.trim()) || this.reminded.has('question')) return null
      return {
        key: 'question',
        event: 'The assistant asked a question instead of working; nobody answers during a session',
        reminder:
          'your reply ends with a question, and nobody can answer during a session. Decide it yourself: take the most likely meaning of the request, look at the page (capture_screen) for anything you need to know, build the test, and name the choices you made in your summary. If the request really cannot be carried out, say what is missing as a statement.',
      }
    }
    if (this.unverified) {
      return {
        key: 'run',
        event: 'The steps were changed after the last full run',
        reminder:
          'you are not finished: the steps were changed after the last run of the whole test, so nothing shows that the test works as it is now. Call run_steps without arguments. If a step fails, fix it and run again. Then call review_request, and only then write your summary.',
      }
    }
    if (this.lastRun && !this.lastRun.passed && !(this.review && this.review.notDone > 0)) {
      return {
        key: 'failed',
        event: `The last run failed: ${this.lastRun.what}`,
        reminder: `you are not finished: the last run of the test failed (${this.lastRun.what}). Read the error, capture the screen before the failing step if you need to see the page (capture_screen with after_step one less than the failing step), fix the step and run the whole test again. Only if it cannot be made to pass (the site itself does not do what the request expects, or it needs something you were not given): call review_request with that point marked not_done and a note saying why, then tell the user plainly in your summary that the test does not pass and why.`,
      }
    }
    if (!this.review) {
      return {
        key: 'review',
        event: 'The request was not yet checked against the final steps',
        reminder:
          'before you finish, call review_request: list every separate thing the request asks for (each action, each value, each check) with the step numbers that carry it out, and mark honestly what you substituted or could not do. If that shows something missing, add it and run the whole test again. Then write your summary.',
      }
    }
    return wrongLanguage
  }
}

// ---- review_request ----

export type PointStatus = 'done' | 'substituted' | 'not_done'
export interface ReviewPoint {
  requirement: string
  status: PointStatus
  /** 1-based step numbers that carry the point out. */
  steps: number[]
  note: string
}

const STATUSES: readonly PointStatus[] = ['done', 'substituted', 'not_done']
const MAX_POINTS = 30
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** The model's checklist, validated against the steps as they are. */
export function parseReview(input: Input, steps: Step[]): ReviewPoint[] {
  const list = input.requirements
  if (!Array.isArray(list) || list.length === 0) throw new ToolInputError('requirements must be a list with one entry for every separate thing the request asks for.')
  if (list.length > MAX_POINTS) throw new ToolInputError(`requirements can have at most ${MAX_POINTS} entries. Group the smallest details.`)
  return list.map((raw, i) => {
    const at = `requirements[${i}]`
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new ToolInputError(`${at} must be an object with requirement, status and steps.`)
    const p = raw as Record<string, unknown>
    const requirement = typeof p.requirement === 'string' ? p.requirement.trim() : ''
    if (!requirement) throw new ToolInputError(`${at}.requirement is missing: say in a few words what the request asks for.`)
    const status = STATUSES.find((s) => s === p.status)
    if (!status) throw new ToolInputError(`${at}.status must be one of: ${STATUSES.join(', ')}.`)
    const numbers = p.steps === undefined || p.steps === null ? [] : p.steps
    if (!Array.isArray(numbers) || numbers.some((n) => typeof n !== 'number' || !Number.isInteger(n))) throw new ToolInputError(`${at}.steps must be a list of step numbers.`)
    const note = typeof p.note === 'string' ? p.note.trim() : ''
    for (const n of numbers as number[]) {
      if (n < 1 || n > steps.length) throw new ToolInputError(`${at}.steps names step ${n}, and the test case has ${steps.length} step${steps.length === 1 ? '' : 's'}. Call get_steps and use the current numbers.`)
      if (steps[n - 1].disabled && status !== 'not_done') throw new ToolInputError(`${at}.steps names step ${n}, which is disabled and never runs, so it carries nothing out.`)
    }
    if (status !== 'not_done' && numbers.length === 0 && !note) throw new ToolInputError(`${at}: name the steps that carry this out, or say in note why no step is needed for it.`)
    if (status !== 'done' && !note) throw new ToolInputError(`${at}.note is missing: for a point that is ${status}, say what was done instead, or why it could not be done. The user reads this.`)
    return { requirement: clip(requirement, 300), status, steps: numbers as number[], note: clip(note, 400) }
  })
}

/** Words of a request that ask for a check, in the languages the owner's users write in. */
const ASKS_FOR_A_CHECK = /\b(check|verif|assert|make sure|ensure|confirm that|should (show|display|be|say|contain)|is shown|is displayed)|检查|確認|确认|验证|檢查|驗證|検証|チェック|確かめ|显示了|表示され/i

/** What is doubtful about a checklist that passed validation: said to the model, which decides. */
export function reviewWarnings(points: ReviewPoint[], steps: Step[]): string[] {
  const warnings: string[] = []
  for (const [i, p] of points.entries()) {
    if (p.status === 'not_done' || p.steps.length === 0) continue
    const asserts = p.steps.some((n) => COMMAND_BY_ID[steps[n - 1].command].assertion)
    if (ASKS_FOR_A_CHECK.test(p.requirement) && !asserts) warnings.push(`Point ${i + 1} asks for a check, but none of its steps (${p.steps.join(', ')}) is an assertion. A click or an input checks nothing: add the assertion, or name the step that makes it.`)
  }
  if (!steps.some((s) => !s.disabled && COMMAND_BY_ID[s.command].assertion)) {
    warnings.push('The test has no assertion at all, so it passes whatever the site shows. Unless the request is only about actions, add a check of the result.')
  }
  return warnings
}

/** The checklist as the model gets it back: every point next to the steps it names, as sentences. */
export function reviewReport(points: ReviewPoint[], steps: Step[], shared?: SharedNames): { requirement: string; status: PointStatus; steps: string[]; note?: string }[] {
  return points.map((p) => ({
    requirement: p.requirement,
    status: p.status,
    steps: p.steps.map((n) => `${n}. ${stepSentence(steps[n - 1], shared)}`),
    ...(p.note ? { note: p.note } : {}),
  }))
}

/** One transcript line for the user: what the checklist left open. */
export function reviewDetail(points: ReviewPoint[]): string {
  return points
    .filter((p) => p.status !== 'done')
    .map((p) => `${p.status === 'substituted' ? 'Changed' : 'Not done'}: ${p.requirement} (${p.note})`)
    .join(' · ')
}
