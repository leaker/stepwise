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
  /** Seconds to keep retrying a missing element or a failing assertion. Default 10. */
  waitSeconds?: number
  /** Persist a JPEG and return its storage key. */
  saveShot(bytes: Uint8Array): Promise<string>
  /** Called after every step (including skipped ones are NOT reported). */
  onStep?(result: StepResult, log: string): Promise<void> | void
  /** Return true to stop before the next step. */
  shouldAbort?(): Promise<boolean> | boolean
}

export interface RunOutcome {
  status: 'succeeded' | 'failed' | 'unresolved' | 'aborted'
  results: StepResult[]
  log: string
}

export { captureUi } from './detect'
export { runSteps } from './executor'
