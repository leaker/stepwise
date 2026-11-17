// Public surface of the test engine. Implementation lives in the sibling files.
// The engine only depends on the Playwright `Page` API, so it runs unchanged on
// Cloudflare Browser Run (@cloudflare/playwright) and on Node Playwright (tests).
import type { StepResult, UiElement } from '../../shared/types'

export interface Capture {
  url: string
  title: string
  width: number
  height: number
  /** Full-page JPEG. */
  screenshot: Uint8Array
  elements: UiElement[]
}

export interface RunOptions {
  baseUrl: string
  /** Project variables; steps may add more. BASE_URL and BROWSER are provided automatically. */
  variables: Record<string, string>
  /** Try to self-heal missing elements (batch runs). */
  heal: boolean
  /** Inclusive 1-based range for partial runs. */
  range?: { from: number; to: number } | null
  /**
   * Partial runs only: execute the steps before `range.from` first, without reporting them, so the range
   * starts from the page and the variables it expects. A set-up step that fails is reported and fails the run.
   * Without this the steps before the range are skipped (the page is used as it is).
   */
  replaySetup?: boolean
  /** Seconds to keep retrying a missing element or a failing assertion. Default 10. */
  waitSeconds?: number
  /** Persist a JPEG and return its storage key. */
  saveShot(bytes: Uint8Array): Promise<string>
  /** Called after every step (including skipped ones are NOT reported). */
  onStep?(result: StepResult, log: string): Promise<void> | void
  /** Return true to stop before the next step, or a sentence for the log when the reason is not a user abort. */
  shouldAbort?(): Promise<boolean | string> | boolean | string
  /**
   * Returns the URL of a top-level navigation that was refused since the last call (and forgets it), or null.
   * The step during which it happened fails with a message naming that URL.
   */
  takeBlockedNavigation?(): string | null
}

export interface RunOutcome {
  status: 'succeeded' | 'failed' | 'unresolved' | 'aborted'
  results: StepResult[]
  log: string
}

export { captureUi } from './detect'
export { runSteps } from './executor'
