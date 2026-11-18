// Typed client for the Worker API documented at the bottom of shared/types.ts.
import type {
  AssistantSession,
  AssistantStatus,
  BatchRun,
  CaptureRequest,
  DataTable,
  DeviceId,
  CaptureResponse,
  Project,
  Run,
  Step,
  TestCase,
  Ui,
  UiElement,
} from '../shared/types'

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError(0, 'Could not reach the server. Check your connection and try again.')
  }
  const text = await res.text()
  let data: unknown = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = null
    }
  }
  if (!res.ok) {
    const msg =
      data && typeof data === 'object' && 'error' in data && typeof (data as { error: unknown }).error === 'string'
        ? (data as { error: string }).error
        : `Request failed (${res.status} ${res.statusText || method + ' ' + path})`
    throw new ApiError(res.status, msg)
  }
  return data as T
}

const get = <T,>(p: string) => request<T>('GET', p)
const post = <T,>(p: string, b?: unknown) => request<T>('POST', p, b ?? {})
const patch = <T,>(p: string, b: unknown) => request<T>('PATCH', p, b)
const del = <T,>(p: string) => request<T>('DELETE', p)

export type RunSummary = Omit<Run, 'steps' | 'log'>
export interface Session {
  required: boolean
  ok: boolean
}

export const api = {
  session: () => get<Session>('/session'),
  signIn: (code: string) => post<{ ok: true }>('/session', { code }),

  projects: () => get<Project[]>('/projects'),
  createProject: (b: { name: string; description?: string; baseUrl?: string }) => post<Project>('/projects', b),
  project: (pid: string) => get<Project>(`/projects/${pid}`),
  updateProject: (
    pid: string,
    b: Partial<Pick<Project, 'name' | 'description' | 'baseUrl' | 'variables'>>,
  ) => patch<Project>(`/projects/${pid}`, b),
  deleteProject: (pid: string) => del<{ ok: true }>(`/projects/${pid}`),

  testCases: (pid: string) => get<TestCase[]>(`/projects/${pid}/test-cases`),
  createTestCase: (pid: string, b: { name?: string; description?: string } = {}) =>
    post<TestCase>(`/projects/${pid}/test-cases`, b),
  testCase: (tid: string) => get<TestCase>(`/test-cases/${tid}`),
  updateTestCase: (tid: string, b: { name?: string; description?: string; device?: DeviceId; steps?: Step[]; data?: DataTable | null }) =>
    patch<TestCase>(`/test-cases/${tid}`, b),
  deleteTestCase: (tid: string) => del<{ ok: true }>(`/test-cases/${tid}`),
  duplicateTestCase: (tid: string) => post<TestCase>(`/test-cases/${tid}/duplicate`),

  // A shared step is read, renamed, edited, run and deleted through the test case calls above, by its id.
  sharedSteps: (pid: string) => get<TestCase[]>(`/projects/${pid}/shared-steps`),
  createSharedStep: (pid: string, b: { name?: string; description?: string; device?: DeviceId } = {}) => post<TestCase>(`/projects/${pid}/shared-steps`, b),
  extractShared: (tid: string, b: { stepIds: string[]; name?: string }) => post<{ testCase: TestCase; shared: TestCase }>(`/test-cases/${tid}/extract-shared`, b),

  uis: (tid: string) => get<Ui[]>(`/test-cases/${tid}/uis`),
  capture: (tid: string, b: CaptureRequest) => post<CaptureResponse>(`/test-cases/${tid}/uis`, b),
  updateUi: (uid: string, b: { name?: string; elements?: UiElement[] }) => patch<Ui>(`/uis/${uid}`, b),
  deleteUi: (uid: string) => del<{ ok: true }>(`/uis/${uid}`),

  /** `row`: the data row a partial run of a data-driven test case uses (a full run executes every row). */
  startRun: (tid: string, range?: { from: number; to: number } | null, row?: number) =>
    post<Run>(`/test-cases/${tid}/runs`, range ? { range, ...(row ? { row } : {}) } : {}),
  runs: (tid: string) => get<RunSummary[]>(`/test-cases/${tid}/runs`),
  run: (rid: string) => get<Run>(`/runs/${rid}`),
  abortRun: (rid: string) => post<Run>(`/runs/${rid}/abort`),
  /** `pattern`: required for a data-driven run, where a step has a result in every pattern. */
  heal: (rid: string, stepId: string, action: 'approve' | 'reject', pattern?: number) =>
    // A step that came from a shared step has a compound id; any step id is whatever the client that saved it chose.
    post<Run>(`/runs/${rid}/heals/${encodeURIComponent(stepId)}`, { action, ...(pattern ? { pattern } : {}) }),

  batchRuns: (pid: string) => get<BatchRun[]>(`/projects/${pid}/batch-runs`),
  startBatchRun: (pid: string, testCaseIds?: string[]) =>
    post<BatchRun>(`/projects/${pid}/batch-runs`, {
      trigger: 'manual',
      ...(testCaseIds && testCaseIds.length ? { testCaseIds } : {}),
    }),
  batchRun: (bid: string) => get<BatchRun>(`/batch-runs/${bid}`),
  abortBatchRun: (bid: string) => post<BatchRun>(`/batch-runs/${bid}/abort`),

  assistantStatus: () => get<AssistantStatus>('/assistant/status'),
  assistantSessions: (tid: string) => get<AssistantSession[]>(`/test-cases/${tid}/assistant`),
  askAssistant: (tid: string, message: string) => post<AssistantSession>(`/test-cases/${tid}/assistant`, { message }),
  abortAssistant: (sid: string) => post<AssistantSession>(`/assistant/${sid}/abort`),
}

let shotResolver: (key: string) => string = (key) => `/api/shots/${encodeURIComponent(key)}`
/** URL of a stored screenshot. */
export const shotUrl = (key: string) => shotResolver(key)
/** Used by the in-browser mock, which cannot intercept <img> requests. */
export const setShotResolver = (fn: (key: string) => string) => {
  shotResolver = fn
}

export const qk = {
  session: ['session'] as const,
  projects: ['projects'] as const,
  project: (pid: string) => ['project', pid] as const,
  testCases: (pid: string) => ['project', pid, 'test-cases'] as const,
  batchRuns: (pid: string) => ['project', pid, 'batch-runs'] as const,
  sharedSteps: (pid: string) => ['project', pid, 'shared-steps'] as const,
  testCase: (tid: string) => ['test-case', tid] as const,
  uis: (tid: string) => ['test-case', tid, 'uis'] as const,
  runs: (tid: string) => ['test-case', tid, 'runs'] as const,
  run: (rid: string) => ['run', rid] as const,
  batchRun: (bid: string) => ['batch-run', bid] as const,
  assistantStatus: ['assistant-status'] as const,
  assistant: (tid: string) => ['test-case', tid, 'assistant'] as const,
}
