// Contract shared by the Worker (API + engine) and the React app.
// Keep this file free of runtime imports so both sides can use it.

export type LocatorKey = 'id' | 'css' | 'xpath'
export interface Locator {
  key: LocatorKey
  value: string
}
export const locatorToString = (l: Locator) => `${l.key}=${l.value}`

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export type ElementType =
  | 'button'
  | 'link'
  | 'input'
  | 'textarea'
  | 'checkbox'
  | 'radio'
  | 'select'
  | 'image'
  | 'text'
  | 'other'

/** What we remember about an element at capture time. Used by self-healing to find it again. */
export interface Fingerprint {
  tag: string
  type: ElementType
  /** Visible text, trimmed and truncated to 120 chars. */
  text: string
  /** Associated label / placeholder / aria-label, if any. */
  label: string
  /** Stable attributes only: id, name, class, href, placeholder, aria-label, role, type, data-testid, alt, title, value (buttons only). */
  attrs: Record<string, string>
  /** Ancestor tag path from <body>, e.g. "body>main>form>div>button". */
  path: string
  box: Box
}

/** An element detected on a captured UI. */
export interface UiElement {
  id: string
  /** Human readable name in the form `"Sign in" button`. Editable by the user. */
  name: string
  type: ElementType
  box: Box
  /** Candidates ordered from most to least stable. locators[0] is the recommended one. */
  locators: Locator[]
  fingerprint: Fingerprint
}

/** Where a test case runs: the desktop browser or an emulated phone. Profiles are in shared/devices.ts. */
export type DeviceId = 'desktop' | 'iphone' | 'pixel'

/** A captured screen: screenshot + detected elements. */
export interface Ui {
  id: string
  testCaseId: string
  name: string
  url: string
  title: string
  /** Full-page screenshot size in CSS pixels; element boxes are in the same coordinate space. */
  width: number
  height: number
  screenshotKey: string
  /** The device the screen was captured on. */
  device: DeviceId
  elements: UiElement[]
  createdAt: string
}

/** A step's own copy of its target element, so a run never depends on the UI still existing. */
export interface ElementRef {
  uiId: string
  elementId: string
  name: string
  locator: Locator
  candidates: Locator[]
  fingerprint: Fingerprint
}

export type CommandId =
  | 'navigate'
  | 'click'
  | 'hover'
  | 'input'
  | 'press_key'
  | 'swipe'
  | 'check'
  | 'uncheck'
  | 'select'
  | 'assert_text_equals'
  | 'assert_text_contains'
  | 'assert_exists'
  | 'assert_not_exists'
  | 'assert_visible'
  | 'assert_url_equals'
  | 'assert_url_contains'
  | 'assert_title_equals'
  | 'assert_title_contains'
  | 'assert_variable_equals'
  | 'wait_visible'
  | 'wait_seconds'
  | 'store_text'
  | 'store_fixed'
  | 'store_url'
  | 'if_exists'
  | 'if_variable_equals'
  | 'else'
  | 'end_if'
  | 'screenshot'
  | 'comment'

export interface Step {
  id: string
  command: CommandId
  target?: ElementRef
  /** Main text parameter. May contain ${VAR} references. Meaning depends on the command (see shared/commands.ts). */
  value?: string
  /** Variable name parameter (bare name, no ${}). */
  variable?: string
  /** Disabled ("commented out") steps are skipped. */
  disabled?: boolean
  /** Assertions only: record the failure and keep going. */
  continueOnFailure?: boolean
}

export interface Project {
  id: string
  name: string
  description: string
  /**
   * Value of the built-in ${BASE_URL} variable; relative navigate URLs resolve against it. A base URL on the
   * app's own origin (the demo project's) follows the app: it is stored as a path and resolved on every read.
   */
  baseUrl: string
  /** Project-wide variables available to every test case. */
  variables: Record<string, string>
  createdAt: string
  testCaseCount?: number
  batchRunCount?: number
}

export interface TestCase {
  id: string
  projectId: string
  /** Sequential per project, shown as #3. Never reused. */
  number: number
  name: string
  description: string
  /** Device profile captures and runs of this test case use. */
  device: DeviceId
  steps: Step[]
  createdAt: string
  updatedAt: string
  lastRun?: { id: string; status: RunStatus; finishedAt: string | null } | null
}

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'unresolved' | 'aborted'
export type StepStatus = 'passed' | 'failed' | 'healed' | 'skipped'

export interface HealProposal {
  state: 'unresolved' | 'approved' | 'rejected'
  elementName: string
  oldLocator: Locator
  newLocator: Locator
  newCandidates: Locator[]
  newFingerprint: Fingerprint
  /** 0..1 similarity between the stored fingerprint and the element chosen at run time. */
  score: number
  /** Where the element was at capture time (on the UI the step points to). */
  before: { uiId: string; box: Box }
  /** Where the replacement was found at run time. */
  after: { screenshotKey: string; box: Box; width: number; height: number }
  /** Set when a later step failed after this heal, i.e. the heal is probably wrong. */
  warning?: string
}

export interface StepResult {
  stepId: string
  /** 1-based position among the test case's steps. */
  number: number
  status: StepStatus
  /** The step rendered as a sentence, e.g. `Click "Sign in" button`. */
  sentence: string
  durationMs: number
  /** Screenshot taken after the step. Absent for steps that do not touch the page, unless they failed or were repaired. */
  screenshotKey?: string
  error?: string
  heal?: HealProposal
}

export interface Run {
  id: string
  projectId: string
  testCaseId: string
  testCaseNumber: number
  testCaseName: string
  batchRunId: string | null
  /** Position inside the batch run (1-based); 0 for single runs. */
  order: number
  status: RunStatus
  /** Steps as they were when the run started. */
  steps: Step[]
  /** Results so far; grows while the run is in progress. */
  results: StepResult[]
  /** Console-style log, newline separated. */
  log: string
  /** As it was when the run was queued. `device` is the test case's device profile at that time. */
  environment: { browser: string; device: DeviceId; viewport: { width: number; height: number }; baseUrl: string }
  /** Inclusive 1-based step range for partial runs. The steps before it are replayed as set-up and not reported unless one fails. */
  range: { from: number; to: number } | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export interface BatchRun {
  id: string
  projectId: string
  /** Sequential per project. */
  number: number
  status: RunStatus
  trigger: 'manual' | 'api'
  counts: { total: number; succeeded: number; failed: number; unresolved: number; aborted: number }
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  /** Present on GET /api/batch-runs/:id only; without steps/log to keep it small. */
  runs?: Omit<Run, 'steps' | 'log'>[]
}

// ---- HTTP API (all JSON, all under /api) ----
// Errors: non-2xx with { error: string }. A body that is not a JSON object is a 400, one over 1 MB a 413.
// A request without a body is the same as {}.
//
// GET    /api/session                          -> { required: boolean, ok: boolean }
// POST   /api/session { code }                 -> { ok: true } (sets cookie) | 401
//
// GET    /api/projects                         -> Project[]
// POST   /api/projects { name, description?, baseUrl? } -> Project
// GET    /api/projects/:pid                    -> Project
// PATCH  /api/projects/:pid { name?, description?, baseUrl?, variables? } -> Project
// DELETE /api/projects/:pid                    -> { ok: true }
//
// GET    /api/projects/:pid/test-cases         -> TestCase[] (ordered by number)
// POST   /api/projects/:pid/test-cases { name?, description?, device? } -> TestCase
// GET    /api/test-cases/:tid                  -> TestCase
// PATCH  /api/test-cases/:tid { name?, description?, device?, steps? } -> TestCase
//          409 when `steps` is sent while an assistant session of the test case is queued or running
// DELETE /api/test-cases/:tid                  -> { ok: true }
// POST   /api/test-cases/:tid/duplicate        -> TestCase
//
// GET    /api/test-cases/:tid/uis              -> Ui[] (oldest first)
// POST   /api/test-cases/:tid/uis CaptureRequest -> CaptureResponse   (synchronous; may take 5-30 s)
// PATCH  /api/uis/:uid { name?, elements? }    -> Ui
// DELETE /api/uis/:uid                         -> { ok: true }
//
// POST   /api/test-cases/:tid/runs { range? }  -> Run (status queued)
// GET    /api/test-cases/:tid/runs             -> Omit<Run,'steps'|'log'>[] (newest first, single runs only)
// GET    /api/runs/:rid                        -> Run
// POST   /api/runs/:rid/abort                  -> Run
// POST   /api/runs/:rid/heals/:stepId { action: 'approve' | 'reject' } -> Run | 409 (run unfinished, or already decided)
//
// GET    /api/projects/:pid/batch-runs         -> BatchRun[] (newest first)
// POST   /api/projects/:pid/batch-runs { testCaseIds?: string[], trigger?: 'manual' | 'api' } -> BatchRun
// GET    /api/batch-runs/:bid                  -> BatchRun (with runs)
// POST   /api/batch-runs/:bid/abort            -> BatchRun
//
// GET    /api/shots/:key                       -> image/jpeg
//
// AI assistant (optional; needs the ANTHROPIC_API_KEY secret, otherwise every route but status is a 503):
// GET    /api/assistant/status                 -> AssistantStatus
// POST   /api/test-cases/:tid/assistant { message } -> AssistantSession (status queued)
//          400 when message is empty or over 2000 characters, 409 while another session of the test case is queued or running,
//          429 when the deployment's assistant budget for the last 24 hours is used up
// GET    /api/test-cases/:tid/assistant        -> AssistantSession[] (oldest first)
// GET    /api/assistant/:sid                   -> AssistantSession
// POST   /api/assistant/:sid/abort             -> AssistantSession

export interface CaptureRequest {
  /**
   * Replay the test case's enabled steps up to and including this step in a fresh browser, then capture.
   * Omit (or null) to capture right after `url` is opened.
   */
  afterStepId?: string | null
  /** Used when afterStepId is not given: open this URL and capture. */
  url?: string
}
export interface CaptureResponse {
  ui: Ui
  /** Set when the replay stopped early because a step failed; the capture shows the page at that point. */
  replayError?: { stepId: string; message: string }
}

// ---- AI assistant ----

export interface AssistantStatus {
  /** False when the deployment has no ANTHROPIC_API_KEY. */
  enabled: boolean
  model: string
}

export type AssistantSessionStatus = 'queued' | 'running' | 'done' | 'failed' | 'aborted'

/** Tools the assistant can call; see worker/assistant/prompt.ts. */
export type AssistantToolName = 'get_steps' | 'capture_screen' | 'add_step' | 'update_step' | 'delete_step' | 'run_steps'

/** One line of a session's transcript. */
export interface AssistantEvent {
  /** `user`: the instruction. `assistant`: text the model wrote. `tool`: something it did. `error`: why the session stopped early. */
  kind: 'user' | 'assistant' | 'tool' | 'error'
  /** Markdown for `assistant`; a plain sentence otherwise, e.g. `Added step 4: Click "Sign in" button`. */
  text: string
  at: string
  /** More about a tool event, e.g. the error of the step that failed. */
  detail?: string
  /** `tool` events: which tool, and whether the call was rejected or its run failed. */
  tool?: AssistantToolName
  failed?: boolean
}

export interface AssistantUsage {
  /** The model the assistant asks. */
  model: string
  /** Other models that worked on a request: a request the model declined is re-run on a fallback model, billed at its own price. */
  otherModels?: string[]
  /** Model requests made so far. */
  turns: number
  /** Tokens that were not read from the prompt cache. */
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** Estimate from list prices, each request at the price of the model that worked on it. */
  costUsd: number
  /** A model without a known price was involved: `costUsd` counts it at the price of `model`. */
  costIncomplete?: boolean
}

/** One instruction to the assistant and everything it did for it. */
export interface AssistantSession {
  id: string
  testCaseId: string
  status: AssistantSessionStatus
  /** Grows while the session is queued or running. */
  events: AssistantEvent[]
  usage: AssistantUsage | null
  /** Why the session failed. */
  error: string | null
  createdAt: string
  finishedAt: string | null
}
