// Public surface of the test engine. Implementation lives in the sibling files.
// The engine only depends on the Playwright `Page` API, so it runs unchanged on
// Cloudflare Browser Run (@cloudflare/playwright) and on Node Playwright (tests).
import type { StepPosition } from '../../shared/expand'
import type { DeviceId, StepResult, UiElement } from '../../shared/types'

export interface Capture {
  url: string
  title: string
  width: number
  height: number
  /** Full-page JPEG, one image pixel per CSS pixel whatever the device pixel ratio. */
  screenshot: Uint8Array
  elements: UiElement[]
}

export interface RunOptions {
  baseUrl: string
  /** Project variables; steps may add more. BASE_URL, BROWSER and DEVICE are provided automatically. */
  variables: Record<string, string>
  /** Value of the built-in DEVICE variable: the device profile the page's context emulates. Default 'desktop'. */
  device?: DeviceId
  /** The context has touch input (an emulated phone): clicks are sent as taps. */
  touch?: boolean
  /** Try to self-heal missing elements (batch runs). */
  heal: boolean
  /** Inclusive 1-based range for partial runs: positions in `steps` as passed (see flatRange in shared/expand.ts). */
  range?: { from: number; to: number } | null
  /**
   * How each step is numbered in results and in the log, when that differs from its position in `steps`:
   * with shared step calls expanded, the steps of a call are 3.1, 3.2, ... (positionsOf in shared/expand.ts).
   */
  positions?: StepPosition[]
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
