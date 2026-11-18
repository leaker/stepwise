// In-browser stand-in for the Worker API. Loaded only when VITE_MOCK is set (see main.tsx);
// it exists so the UI can be exercised before, or without, the real backend.
import { COMMAND_BY_ID, isBuiltInVariable, MAX_ELEMENT_NAME, MAX_LOCATOR_LENGTH, MAX_STEP_TEXT, MAX_STEPS, nextUiName, sharedLabel, stepSentence, validateSteps } from '../../shared/commands'
import { stepsRevision } from '../../shared/revision'
import { aggregateStatus, describeDataProblem, hasPatterns, patternLogHeading, rowValues, settledPatterns, SUMMARY_LOG_HEADING, validateDataTable } from '../../shared/data'
import { DEVICES } from '../../shared/devices'
import { expandSteps, flatRange, NESTED_SHARED_MESSAGE, positionLabel, positionsOf, reportedSteps, type SharedLookup } from '../../shared/expand'
import type {
  ApiErrorCode,
  AssistantEvent,
  AssistantSession,
  BatchRun,
  Box,
  CaptureRequest,
  DataTable,
  ElementType,
  HealProposal,
  Locator,
  Project,
  Run,
  RunPattern,
  RunStatus,
  Step,
  StepResult,
  TestCase,
  Ui,
  UiElement,
} from '../../shared/types'
import { baseUrlProblem } from '../../shared/url'
import { setShotResolver } from '../api'

let seq = 1
const id = (p: string) => `${p}_${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`
const now = () => new Date().toISOString()
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()

// ---------- fake pages ----------

interface Spec {
  name: string
  type: ElementType
  box: Box
  text: string
  locators: Locator[]
}
interface PageSpec {
  key: string
  title: string
  path: string
  width: number
  height: number
  heading: string
  els: Spec[]
}

const el = (label: string, type: ElementType, kind: string, box: Box, idAttr: string, text = label): Spec => ({
  name: `"${label}" ${kind}`,
  type,
  box,
  text,
  locators: [
    { key: 'id', value: idAttr },
    { key: 'css', value: `${type === 'link' ? 'a' : type === 'button' ? 'button' : type === 'text' ? 'p' : 'input'}#${idAttr}` },
    { key: 'xpath', value: `//*[@id='${idAttr}']` },
  ],
})

const PAGES: PageSpec[] = [
  {
    key: 'mock-login',
    title: 'Sign in | Harbor Books',
    path: '/demo/login',
    width: 1280,
    height: 860,
    heading: 'Sign in to Harbor Books',
    els: [
      el('Harbor Books', 'link', 'link', { x: 40, y: 22, w: 150, h: 28 }, 'brand'),
      el('Catalog', 'link', 'link', { x: 980, y: 24, w: 70, h: 24 }, 'nav-catalog'),
      el('Help', 'link', 'link', { x: 1070, y: 24, w: 50, h: 24 }, 'nav-help'),
      el('Email', 'input', 'input area', { x: 440, y: 250, w: 400, h: 44 }, 'email', ''),
      el('Password', 'input', 'input area', { x: 440, y: 340, w: 400, h: 44 }, 'password', ''),
      el('Remember me', 'checkbox', 'checkbox', { x: 440, y: 410, w: 20, h: 20 }, 'remember', ''),
      el('Forgot password?', 'link', 'link', { x: 710, y: 408, w: 130, h: 24 }, 'forgot'),
      el('Sign in', 'button', 'button', { x: 440, y: 460, w: 400, h: 46 }, 'sign-in'),
      el('Create an account', 'link', 'link', { x: 570, y: 530, w: 140, h: 24 }, 'create-account'),
      el('Free shipping on orders over $35', 'text', 'text', { x: 470, y: 760, w: 340, h: 22 }, 'promo'),
    ],
  },
  {
    key: 'mock-catalog',
    title: 'Catalog | Harbor Books',
    path: '/demo/catalog',
    width: 1280,
    height: 1500,
    heading: 'Welcome back, Alice',
    els: [
      el('Harbor Books', 'link', 'link', { x: 40, y: 22, w: 150, h: 28 }, 'brand'),
      el('Search books', 'input', 'input area', { x: 420, y: 18, w: 360, h: 36 }, 'search', ''),
      el('Cart (0)', 'link', 'link', { x: 1090, y: 24, w: 80, h: 24 }, 'cart'),
      el('Sign out', 'button', 'button', { x: 1180, y: 18, w: 80, h: 36 }, 'sign-out'),
      el('Welcome back, Alice', 'text', 'text', { x: 40, y: 120, w: 460, h: 40 }, 'greeting'),
      el('Sort by', 'select', 'combo box', { x: 1040, y: 124, w: 200, h: 36 }, 'sort', 'Newest'),
      ...[0, 1, 2, 3, 4, 5].flatMap((i) => {
        const col = i % 3
        const row = Math.floor(i / 3)
        const x = 40 + col * 410
        const y = 210 + row * 560
        const title = ['The Tidewater Almanac', 'Salt and Signal', 'A Field Guide to Fog', 'Night Ferries', 'Lighthouse Keeping', 'Small Harbours'][i]
        return [
          el(`Cover of ${title}`, 'image', 'image', { x, y, w: 380, h: 380 }, `cover-${i + 1}`, ''),
          el(title, 'link', 'link', { x, y: y + 394, w: 300, h: 26 }, `title-${i + 1}`),
          el(`Add ${title} to cart`, 'button', 'button', { x, y: y + 462, w: 380, h: 42 }, `add-${i + 1}`, 'Add to cart'),
        ]
      }),
      el('Load more', 'button', 'button', { x: 560, y: 1390, w: 160, h: 42 }, 'load-more'),
    ],
  },
]

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function drawPage(p: PageSpec): string {
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${p.width}" height="${p.height}" viewBox="0 0 ${p.width} ${p.height}" font-family="Georgia, serif">`,
    `<rect width="100%" height="100%" fill="#fbfaf7"/>`,
    `<rect width="100%" height="72" fill="#17324d"/>`,
    p.key === 'mock-login' ? `<text x="640" y="190" text-anchor="middle" font-size="30" fill="#17324d">${esc(p.heading)}</text>` : '',
  ]
  for (const e of p.els) {
    const { x, y, w, h } = e.box
    const inBar = y < 72
    const cy = y + h / 2 + 5
    switch (e.type) {
      case 'button':
        parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${inBar ? '#2d587f' : '#c2552d'}"/>`)
        parts.push(`<text x="${x + w / 2}" y="${cy}" text-anchor="middle" font-size="16" fill="#fff" font-family="Helvetica, Arial, sans-serif">${esc(e.text)}</text>`)
        break
      case 'input':
      case 'select':
        parts.push(`<rect x="${x + 0.5}" y="${y + 0.5}" width="${w - 1}" height="${h - 1}" rx="5" fill="#fff" stroke="#9aa7b4"/>`)
        if (!inBar) parts.push(`<text x="${x}" y="${y - 10}" font-size="14" fill="#44505c" font-family="Helvetica, Arial, sans-serif">${esc(e.name.replace(/^"(.*)".*$/, '$1'))}</text>`)
        parts.push(`<text x="${x + 12}" y="${cy}" font-size="14" fill="#8a949e" font-family="Helvetica, Arial, sans-serif">${esc(e.text || (inBar ? 'Search books' : ''))}</text>`)
        break
      case 'checkbox':
        parts.push(`<rect x="${x + 0.5}" y="${y + 0.5}" width="${w - 1}" height="${h - 1}" rx="3" fill="#fff" stroke="#9aa7b4"/>`)
        parts.push(`<text x="${x + w + 10}" y="${cy}" font-size="14" fill="#44505c" font-family="Helvetica, Arial, sans-serif">Remember me</text>`)
        break
      case 'image':
        parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#dfe6ea"/>`)
        parts.push(`<path d="M${x} ${y + h} L${x + w * 0.35} ${y + h * 0.55} L${x + w * 0.6} ${y + h * 0.8} L${x + w * 0.8} ${y + h * 0.6} L${x + w} ${y + h} Z" fill="#b9c7cf"/>`)
        break
      case 'text':
        parts.push(`<text x="${x}" y="${y + h * 0.75}" font-size="${Math.round(h * 0.72)}" fill="#17324d">${esc(e.text)}</text>`)
        break
      default:
        parts.push(`<text x="${x}" y="${cy}" font-size="${inBar && e.locators[0].value === 'brand' ? 20 : 15}" fill="${inBar ? '#fff' : '#1f5fa8'}" font-family="Helvetica, Arial, sans-serif">${esc(e.text)}</text>`)
    }
  }
  parts.push('</svg>')
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(parts.join(''))}`
}

const shotCache = new Map<string, string>()
function resolveShot(key: string): string {
  let url = shotCache.get(key)
  if (!url) {
    const page = PAGES.find((p) => key.startsWith(p.key))
    url = page ? drawPage(page) : 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800"><rect width="100%" height="100%" fill="#eee"/></svg>')
    shotCache.set(key, url)
  }
  return url
}

function toElements(p: PageSpec): UiElement[] {
  return p.els.map((e, i) => ({
    id: `${p.key}-e${i + 1}`,
    name: e.name,
    type: e.type,
    box: e.box,
    locators: e.locators,
    fingerprint: {
      tag: e.type === 'link' ? 'a' : e.type === 'button' ? 'button' : e.type === 'text' ? 'p' : e.type === 'image' ? 'img' : 'input',
      type: e.type,
      text: e.text,
      label: e.name.replace(/^"(.*)".*$/, '$1'),
      attrs: { id: e.locators[0].value },
      path: 'body>main>div',
      box: e.box,
    },
  }))
}

// ---------- state ----------

const ORIGIN = 'https://harbor-books.example'
const projects: Project[] = []
const cases: TestCase[] = []
const uis: Ui[] = []
const runs: Run[] = []
const batches: BatchRun[] = []
const assistantSessions: AssistantSession[] = []
const counters = new Map<string, { tc: number; batch: number; shared: number }>()

/** The shared steps of the mock, as expansion looks them up. */
const sharedLookup: SharedLookup = (sid) => {
  const t = cases.find((c) => c.id === sid && c.kind === 'shared')
  return t && { id: t.id, projectId: t.projectId, number: t.number, name: t.name, steps: t.steps }
}
const expand = (tc: TestCase) => expandSteps(structuredClone(tc.steps), sharedLookup, tc.projectId, tc.kind === 'shared')
/** Test cases that call a shared step. */
const callersOf = (sid: string) =>
  cases
    .filter((c) => c.kind === 'test' && c.steps.some((s) => s.command === 'shared_step' && s.value === sid))
    .sort((x, y) => x.number - y.number)
    .map((c) => ({ id: c.id, number: c.number, name: c.name }))
const withUsedBy = (t: TestCase): TestCase => (t.kind === 'shared' ? { ...t, usedBy: callersOf(t.id) } : t)

function makeUi(tcId: string, page: PageSpec, name: string): Ui {
  return {
    id: id('ui'),
    testCaseId: tcId,
    name,
    url: ORIGIN + page.path,
    title: page.title,
    device: 'desktop',
    width: page.width,
    height: page.height,
    screenshotKey: page.key,
    elements: toElements(page),
    createdAt: now(),
  }
}

const ref = (ui: Ui, n: number) => {
  const e = ui.elements[n]
  return { uiId: ui.id, elementId: e.id, name: e.name, locator: e.locators[0], candidates: e.locators, fingerprint: e.fingerprint }
}

function resultsFor(steps: Step[], failAt = -1, healAt = -1, ui?: Ui): StepResult[] {
  const out: StepResult[] = []
  let page = PAGES[0]
  const positions = positionsOf(steps)
  steps.forEach((s, i) => {
    // `failAt` and `healAt` are positions in the expanded list; the marker row of a call is not executed.
    if (s.disabled || s.call || (failAt >= 0 && i > failAt)) return
    const def = COMMAND_BY_ID[s.command]
    if (s.target && uis.find((u) => u.id === s.target!.uiId)?.screenshotKey === 'mock-catalog') page = PAGES[1]
    const r: StepResult = { stepId: s.id, ...positions[i], status: 'passed', sentence: stepSentence(s), durationMs: 180 + ((i * 337) % 900) }
    if (def.shot) r.screenshotKey = page.key
    if (i === failAt) {
      r.status = 'failed'
      r.error = s.target ? `AssertionError: expected ${s.target.name} to equal ${JSON.stringify(s.value ?? '')}, but it was "Welcome back, Alice"` : 'The step failed.'
    }
    const healUi = s.target ? (uis.find((u) => u.id === s.target!.uiId) ?? ui) : ui
    if (i === healAt && s.target && healUi) {
      r.status = 'healed'
      const box = { ...s.target.fingerprint.box, y: s.target.fingerprint.box.y + 24 }
      const heal: HealProposal = {
        state: 'unresolved',
        elementName: s.target.name,
        oldLocator: s.target.locator,
        newLocator: { key: 'css', value: "form button[type='submit']" },
        newCandidates: [
          { key: 'css', value: "form button[type='submit']" },
          { key: 'xpath', value: "//button[normalize-space()='Sign in']" },
        ],
        newFingerprint: { ...s.target.fingerprint, attrs: { type: 'submit' }, box },
        score: 0.86,
        before: { uiId: healUi.id, box: s.target.fingerprint.box },
        after: { screenshotKey: 'mock-login', box, width: 1280, height: 860 },
      }
      r.heal = heal
    }
    out.push(r)
  })
  return out
}

/** The patterns of a new run of a data-driven test case: every row, or only `rows`. */
const patternsFor = (tc: TestCase, rows?: number[]): RunPattern[] | null =>
  tc.kind === 'test' && hasPatterns(tc.data) ? (rows ?? tc.data.rows.map((_, i) => i + 1)).map((index) => ({ index, values: rowValues(tc.data!, index), status: 'queued', startedAt: null, finishedAt: null })) : null

/** `failPattern`: in a data-driven run only this pattern fails at `failAt`; `healAt` applies to every pattern. */
function makeRun(tc: TestCase, status: RunStatus, opts: { failAt?: number; failPattern?: number; healAt?: number; batch?: BatchRun; order?: number; minutesAgo?: number } = {}): Run {
  const steps = expand(tc).steps
  const done = status !== 'queued' && status !== 'running'
  const firstUi = uis.find((u) => u.testCaseId === tc.id)
  const patterns = patternsFor(tc)
  const started = ago(opts.minutesAgo ?? 5)
  let results: StepResult[] = []
  if (done && patterns) {
    for (const p of patterns) {
      const own = resultsFor(steps, opts.failPattern === p.index ? opts.failAt : -1, opts.healAt, firstUi).map((r) => ({ ...r, pattern: p.index }))
      results.push(...own)
      p.status = own.some((r) => r.status === 'failed') ? 'failed' : own.some((r) => r.status === 'healed') ? 'unresolved' : 'succeeded'
      p.startedAt = started
      p.finishedAt = new Date(Date.parse(started) + 3_000 * p.index).toISOString()
    }
  } else if (done) results = resultsFor(steps, opts.failAt, opts.healAt, firstUi)
  const run: Run = {
    id: id('run'),
    projectId: tc.projectId,
    testCaseId: tc.id,
    kind: tc.kind,
    testCaseNumber: tc.number,
    testCaseName: tc.name,
    batchRunId: opts.batch?.id ?? null,
    order: opts.order ?? 0,
    status,
    steps,
    results,
    log: done ? logFor(results, status, patterns) : '',
    environment: { browser: 'Chromium 142', device: tc.device, viewport: { ...DEVICES[tc.device].viewport }, baseUrl: ORIGIN },
    range: null,
    patterns,
    createdAt: started,
    startedAt: status === 'queued' ? null : started,
    finishedAt: done ? new Date(Date.parse(started) + 9_000).toISOString() : null,
  }
  runs.push(run)
  refreshLastRun(tc)
  return run
}

/** As the Worker: the newest run of the test case, single or inside a batch run. */
function refreshLastRun(tc: TestCase) {
  const newest = runs.filter((r) => r.testCaseId === tc.id).reduce<Run | null>((a, r) => (!a || r.createdAt >= a.createdAt ? r : a), null)
  tc.lastRun = newest ? { id: newest.id, status: newest.status, finishedAt: newest.finishedAt } : null
}

function logFor(results: StepResult[], status: RunStatus, patterns?: RunPattern[] | null): string {
  const lines = ['Environment: Cloudflare Browser Run', 'Browser: Chromium 142, viewport 1280x800']
  const steps = (own: StepResult[]) => {
    for (const r of own) {
      lines.push(`[${positionLabel(r)}] ${r.sentence}`)
      if (r.heal) lines.push(`    locator ${r.heal.oldLocator.key}=${r.heal.oldLocator.value} not found; repaired to ${r.heal.newLocator.key}=${r.heal.newLocator.value} (score ${r.heal.score})`)
      if (r.error) lines.push(`    ${r.error}`)
      lines.push(`    ${r.status} in ${r.durationMs} ms`)
    }
  }
  const done = status !== 'running' && status !== 'queued'
  if (patterns) {
    // One section per pattern, as the Worker writes it (shared/data.ts).
    for (const p of patterns) {
      if (!p.startedAt) continue
      lines.push(patternLogHeading(p.index), `Data row ${p.index}: ${Object.entries(p.values).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')}`)
      steps(results.filter((r) => r.pattern === p.index))
    }
    if (done) lines.push(SUMMARY_LOG_HEADING, ...patterns.map((p) => `Pattern ${p.index}: ${p.startedAt ? p.status : 'not run'}`))
  } else steps(results)
  if (done) lines.push(`Run ${status}.`)
  return lines.join('\n')
}

function seed() {
  const p: Project = { id: 'p_demo', name: 'Harbor Books storefront', description: 'Sign-in, catalog and cart flows for the public shop.', baseUrl: ORIGIN, variables: { USER_EMAIL: 'alice@example.com', USER_PASSWORD: 'correct-horse' }, createdAt: ago(6000) }
  projects.push(p, { id: 'p_empty', name: 'Internal admin console with a deliberately very long project name to check truncation in breadcrumbs', description: '', baseUrl: '', variables: {}, createdAt: ago(300) })
  counters.set(p.id, { tc: 6, batch: 3, shared: 3 })
  counters.set('p_empty', { tc: 1, batch: 1, shared: 1 })

  const tc1: TestCase = { id: 'tc_signin', projectId: p.id, kind: 'test', data: null, number: 1, name: 'Sign in with a valid account', description: 'Happy path: a registered customer signs in and lands on the catalog.', device: 'desktop', steps: [], stepsRev: '', createdAt: ago(5000), updatedAt: ago(40), lastRun: null }
  const login = makeUi(tc1.id, PAGES[0], 'Sign in page')
  const catalog = makeUi(tc1.id, PAGES[1], 'Catalog after sign-in')
  uis.push(login, catalog)
  tc1.steps = [
    { id: 's1', command: 'navigate', value: '${BASE_URL}/demo/login' },
    { id: 's2', command: 'input', value: '${USER_EMAIL}', target: ref(login, 3) },
    { id: 's3', command: 'input', value: '${USER_PASSWORD}', target: ref(login, 4) },
    { id: 's4', command: 'check', target: ref(login, 5) },
    { id: 's5', command: 'click', target: ref(login, 7) },
    { id: 's6', command: 'wait_visible', value: '10', target: ref(catalog, 4) },
    { id: 's7', command: 'assert_text_equals', value: 'Welcome back, Alice', target: ref(catalog, 4) },
    { id: 's8', command: 'assert_url_contains', value: '/demo/catalog' },
    { id: 's9', command: 'comment', value: 'Cart checks live in test case #2', disabled: true },
  ]
  // A shared step with its own captured screen, called by two test cases; and one that nothing uses yet.
  const sh1: TestCase = { id: 'sh_signin', projectId: p.id, kind: 'shared', data: null, number: 1, name: 'Sign in', description: 'Signs in as the customer in USER_EMAIL / USER_PASSWORD and lands on the catalog.', device: 'desktop', steps: [], stepsRev: '', createdAt: ago(4500), updatedAt: ago(400), lastRun: null }
  const sharedLogin = makeUi(sh1.id, PAGES[0], 'Sign in page')
  uis.push(sharedLogin)
  sh1.steps = [
    { id: 'h1', command: 'navigate', value: '${BASE_URL}/demo/login' },
    { id: 'h2', command: 'input', value: '${USER_EMAIL}', target: ref(sharedLogin, 3) },
    { id: 'h3', command: 'input', value: '${USER_PASSWORD}', target: ref(sharedLogin, 4) },
    { id: 'h4', command: 'click', target: ref(sharedLogin, 7) },
  ]
  const sh2: TestCase = { id: 'sh_signout', projectId: p.id, kind: 'shared', data: null, number: 2, name: 'Sign out', description: '', device: 'desktop', stepsRev: '', steps: [{ id: 'o1', command: 'click', target: ref(catalog, 3) }], createdAt: ago(900), updatedAt: ago(900), lastRun: null }
  const tc2: TestCase = { id: 'tc_cart', projectId: p.id, kind: 'test', data: null, number: 2, name: 'Add a book to the cart', description: '', device: 'desktop', stepsRev: '', steps: [{ id: 'c1', command: 'shared_step', value: sh1.id }, { id: 'c2', command: 'click', target: ref(catalog, 8) }, { id: 'c3', command: 'assert_text_contains', value: 'Cart (1)', target: ref(catalog, 2) }], createdAt: ago(4000), updatedAt: ago(90), lastRun: null }
  const tc3: TestCase = { id: 'tc_new', projectId: p.id, kind: 'test', data: null, number: 3, name: 'New test', description: '', device: 'desktop', steps: [], stepsRev: '', createdAt: ago(10), updatedAt: ago(10), lastRun: null }
  const tc4: TestCase = { id: 'tc_search', projectId: p.id, kind: 'test', data: null, number: 4, name: 'Search the catalog', description: 'Signs in through the shared step, then searches.', device: 'desktop', stepsRev: '', steps: [{ id: 'q1', command: 'shared_step', value: sh1.id }, { id: 'q2', command: 'input', value: 'fog', target: ref(catalog, 1) }, { id: 'q3', command: 'press_key', value: 'Enter' }, { id: 'q4', command: 'assert_url_contains', value: '/demo/catalog' }], createdAt: ago(800), updatedAt: ago(70), lastRun: null }
  // A data-driven test case: the sign-in shared step with three accounts; the mock fails a step whose value contains "!fail".
  const tc5: TestCase = {
    id: 'tc_accounts',
    projectId: p.id,
    kind: 'test',
    number: 5,
    name: 'Sign in with several accounts',
    description: 'Runs once for every row of its data table.',
    device: 'desktop',
    stepsRev: '',
    data: {
      columns: ['USER_EMAIL', 'USER_PASSWORD', 'GREETING'],
      rows: [
        ['alice@example.com', 'correct-horse', 'Welcome back, Alice'],
        ['bob@example.com', 'battery-staple', 'Welcome back, Bob !fail'],
        ['carol@example.com', 'tr0ub4dor', 'Welcome back, Carol'],
      ],
    },
    steps: [
      { id: 'd1', command: 'shared_step', value: sh1.id },
      { id: 'd2', command: 'assert_text_equals', value: '${GREETING}', target: ref(catalog, 4) },
      { id: 'd3', command: 'assert_url_contains', value: '/demo/catalog' },
    ],
    createdAt: ago(700),
    updatedAt: ago(65),
    lastRun: null,
  }
  cases.push(tc1, tc2, tc3, tc4, tc5, sh1, sh2)

  makeRun(tc1, 'succeeded', { minutesAgo: 300 })
  makeRun(tc1, 'failed', { failAt: 6, minutesAgo: 120 })
  makeRun(tc2, 'succeeded', { minutesAgo: 200 })
  // Positions in the expanded list: 0 is the call's marker row, 1-4 the shared step's steps, 5 the greeting.
  makeRun(tc5, 'failed', { failAt: 5, failPattern: 2, minutesAgo: 64 })

  const b1: BatchRun = { id: 'b_1', projectId: p.id, number: 1, status: 'succeeded', trigger: 'api', counts: { total: 2, succeeded: 2, failed: 0, unresolved: 0, aborted: 0 }, createdAt: ago(1500), startedAt: ago(1500), finishedAt: ago(1499) }
  makeRun(tc1, 'succeeded', { batch: b1, order: 1, minutesAgo: 1500 })
  makeRun(tc2, 'succeeded', { batch: b1, order: 2, minutesAgo: 1499 })
  const b2: BatchRun = { id: 'b_2', projectId: p.id, number: 2, status: 'unresolved', trigger: 'manual', counts: { total: 4, succeeded: 0, failed: 1, unresolved: 3, aborted: 0 }, createdAt: ago(60), startedAt: ago(60), finishedAt: ago(59) }
  makeRun(tc1, 'unresolved', { batch: b2, order: 1, healAt: 4, minutesAgo: 60 })
  // Positions in the expanded list: 0 is the call's marker row, 1-4 the shared step's steps.
  makeRun(tc2, 'failed', { batch: b2, order: 2, failAt: 6, minutesAgo: 59 })
  // A repair inside the shared step (its "Sign in" click).
  makeRun(tc4, 'unresolved', { batch: b2, order: 3, healAt: 4, minutesAgo: 58 })
  // The same repair in each of the three patterns: approving one approves them all.
  makeRun(tc5, 'unresolved', { batch: b2, order: 4, healAt: 4, minutesAgo: 57 })
  batches.push(b2, b1)
}

// ---------- run simulation ----------

function recount(b: BatchRun) {
  const mine = runs.filter((r) => r.batchRunId === b.id)
  const n = (s: RunStatus) => mine.filter((r) => r.status === s).length
  b.counts = { total: mine.length, succeeded: n('succeeded'), failed: n('failed'), unresolved: n('unresolved'), aborted: n('aborted') }
  if (mine.every((r) => ['succeeded', 'failed', 'unresolved', 'aborted'].includes(r.status))) {
    b.status = b.counts.aborted ? 'aborted' : b.counts.failed ? 'failed' : b.counts.unresolved ? 'unresolved' : 'succeeded'
    b.finishedAt = b.finishedAt ?? now()
  }
}

function simulate(run: Run, onDone?: () => void) {
  const positions = positionsOf(run.steps)
  const todo = reportedSteps(run.steps, run.range).map((s) => ({ s, i: run.steps.indexOf(s) }))
  const project = projects.find((x) => x.id === run.projectId)
  // As the engine: a step in a branch arm that is not taken is not executed and gets no result. The mock
  // decides an "If variable equals" from the project variables, the data row and the values stored by
  // "Store fixed value"; an "If UI element exists" is always true.
  const taken = (p: RunPattern | null) => {
    const vars: Record<string, string> = { ...(project?.variables ?? {}), ...(p?.values ?? {}) }
    const frames: { exec: boolean; taken: boolean }[] = []
    const executing = (depth = frames.length) => frames.slice(0, depth).every((f) => f.exec)
    return todo.filter(({ s }) => {
      if (s.command === 'if_exists' || s.command === 'if_variable_equals') {
        if (!executing()) return frames.push({ exec: false, taken: true }) && false
        const holds = s.command === 'if_exists' || (vars[s.variable ?? ''] ?? '') === (s.value ?? '').replace(/\$\{(\w+)\}/g, (m, name: string) => vars[name] ?? m)
        frames.push({ exec: holds, taken: holds })
        return true
      }
      if (s.command === 'else') {
        const top = frames[frames.length - 1]
        if (!top) frames.push({ exec: false, taken: true })
        else {
          top.exec = !top.taken
          top.taken = true
        }
        return executing(frames.length - 1)
      }
      if (s.command === 'end_if') return !!frames.pop() && executing()
      if (!executing()) return false
      if (s.command === 'store_fixed' && s.variable) vars[s.variable] = s.value ?? ''
      return true
    })
  }
  // A data-driven run goes through its patterns one after the other and goes on after one that failed.
  const plan = (run.patterns ?? [null]).flatMap((p) => taken(p).map((item) => ({ ...item, p })))
  let k = 0
  const finish = (status: RunStatus) => {
    run.status = run.patterns ? aggregateStatus(run.patterns.map((p) => p.status)) : status
    run.finishedAt = now()
    run.log = logFor(run.results, run.status, run.patterns)
    const tc = cases.find((c) => c.id === run.testCaseId)
    if (tc) refreshLastRun(tc)
    onDone?.()
  }
  const tick = () => {
    if (run.status === 'aborted') {
      const tc = cases.find((c) => c.id === run.testCaseId)
      if (tc) refreshLastRun(tc)
      return onDone?.()
    }
    if (run.status === 'queued') {
      run.status = 'running'
      run.startedAt = now()
      return void setTimeout(tick, 500)
    }
    const item = plan[k++]
    if (!item) return finish('succeeded')
    const { s, i, p } = item
    if (p && p.status === 'queued') Object.assign(p, { status: 'running', startedAt: now() })
    const def = COMMAND_BY_ID[s.command]
    const r: StepResult = { stepId: s.id, ...positions[i], status: 'passed', sentence: stepSentence(s), durationMs: 200 + Math.round(Math.random() * 600) }
    if (p) r.pattern = p.index
    const onCatalog = s.target ? uis.find((u) => u.id === s.target!.uiId)?.screenshotKey === 'mock-catalog' : /catalog/.test(s.value ?? '')
    if (def.shot) r.screenshotKey = onCatalog ? 'mock-catalog' : 'mock-login'
    // The value as the pattern sees it: a data row can carry the "!fail" that fails a step in the mock.
    const value = (s.value ?? '').replace(/\$\{(\w+)\}/g, (m, name: string) => p?.values[name] ?? m)
    const fail = value.includes('!fail')
    if (fail) {
      r.status = 'failed'
      r.error = `AssertionError: the value contained "!fail", which the mock treats as a failing step`
    }
    run.results = [...run.results, r]
    const stop = fail && !s.continueOnFailure
    if (p && (stop || plan[k]?.p !== p)) Object.assign(p, { status: stop ? 'failed' : 'succeeded', finishedAt: now() })
    // The rest of a failed pattern is not run.
    if (stop && p) while (plan[k]?.p === p) k++
    run.log = logFor(run.results, 'running', run.patterns)
    if (stop && !p) return finish('failed')
    setTimeout(tick, 650)
  }
  setTimeout(tick, 600)
}

/** A scripted assistant session: one capture, two steps, a trial run, a summary. Honours an abort between beats. */
function simulateAssistant(session: AssistantSession, tc: TestCase) {
  const say = (event: Omit<AssistantEvent, 'at'>) => session.events.push({ ...event, at: now() })
  const turn = (output: number) => {
    const u = (session.usage ??= { model: 'claude-haiku-5-5', turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 })
    u.turns++
    u.inputTokens += 900
    u.cacheReadTokens += 2400 * u.turns
    u.outputTokens += output
    u.costUsd = (u.inputTokens * 4 + u.cacheReadTokens * 0.2 + u.outputTokens * 20) / 1e6
  }
  let ui: Ui | undefined
  const beats: (() => void)[] = [
    () => {
      session.status = 'running'
    },
    () => {
      turn(120)
      ui = makeUi(tc.id, PAGES[0], nextUiName(uis.filter((u) => u.testCaseId === tc.id).map((u) => u.name)))
      uis.push(ui)
      say({ kind: 'tool', tool: 'capture_screen', text: `Captured screen of ${ui.url} (${ui.name}, ${ui.elements.length} elements)` })
    },
    () => {
      turn(260)
      if (tc.steps.length === 0) {
        tc.steps = [{ id: id('st'), command: 'navigate', value: '${BASE_URL}/' }]
        say({ kind: 'tool', tool: 'add_step', text: `Added step 1: ${stepSentence(tc.steps[0])}` })
      }
      const step: Step = { id: id('st'), command: 'click', target: ref(ui!, 0) }
      tc.steps = [...tc.steps, step]
      tc.updatedAt = now()
      say({ kind: 'tool', tool: 'add_step', text: `Added step ${tc.steps.length}: ${stepSentence(step)}` })
    },
    () => {
      turn(80)
      say({ kind: 'tool', tool: 'run_steps', text: `Ran steps 1-${tc.steps.length}: all passed` })
    },
    () => {
      turn(180)
      say({ kind: 'assistant', text: `The test now has **${tc.steps.length} steps** and the trial run passed.\n\n- This is the mock assistant: it always adds a click on the first element of \`${ui!.name}\`.\n- Use undo to remove everything it added.` })
      session.status = 'done'
      session.finishedAt = now()
    },
  ]
  const tick = () => {
    if (session.status === 'aborted') return
    beats.shift()?.()
    if (beats.length) setTimeout(tick, 1300)
  }
  setTimeout(tick, 500)
}

// ---------- router ----------

class HttpError extends Error {
  status: number
  code?: ApiErrorCode
  constructor(status: number, message: string, code?: ApiErrorCode) {
    super(message)
    this.status = status
    this.code = code
  }
}
const revisionOf = (tc: TestCase): string => stepsRevision(JSON.stringify(tc.steps))
const need = <T,>(v: T | undefined, what: string): T => {
  if (v === undefined) throw new HttpError(404, `${what} not found`)
  return v
}
const lite = (r: Run) => {
  const { steps: _s, log: _l, ...rest } = r
  return rest
}
const withCounts = (p: Project): Project => ({ ...p, testCaseCount: cases.filter((c) => c.projectId === p.id && c.kind === 'test').length, batchRunCount: batches.filter((b) => b.projectId === p.id).length })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Remove the matching items of a list in place. */
function remove<T>(list: T[], match: (item: T) => boolean) {
  for (let i = list.length - 1; i >= 0; i--) if (match(list[i])) list.splice(i, 1)
}
const nameOf = (value: unknown, what: string): string => {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!name) throw new HttpError(400, `${what} name is required`)
  if (name.length > 120) throw new HttpError(400, `${what} name must be 120 characters or fewer`)
  return name
}
const baseUrlOf = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  const problem = baseUrlProblem(text)
  if (problem) throw new HttpError(400, problem)
  return text.replace(/\/+$/, '')
}
const hasEnabledSteps = (steps: Step[]): boolean => steps.some((s) => !s.disabled && !s.call)
const assistantBusy = (testCaseId: string): boolean => assistantSessions.some((x) => x.testCaseId === testCaseId && (x.status === 'queued' || x.status === 'running'))
/** The limits of worker/validate.ts that the editor is expected to keep to. */
function checkSteps(steps: Step[]) {
  if (steps.length > MAX_STEPS) throw new HttpError(400, `A test case can have at most ${MAX_STEPS} steps`)
  steps.forEach((s, i) => {
    for (const key of ['value', 'variable'] as const) if ((s[key] ?? '').length > MAX_STEP_TEXT) throw new HttpError(400, `Step ${i + 1}: ${key} is too long (${MAX_STEP_TEXT} characters at most)`)
    if (s.target && s.target.name.length > MAX_ELEMENT_NAME) throw new HttpError(400, `Step ${i + 1}: target.name is too long (${MAX_ELEMENT_NAME} characters at most)`)
    if (s.target && [s.target.locator, ...s.target.candidates].some((l) => l.value.length > MAX_LOCATOR_LENGTH)) throw new HttpError(400, `Step ${i + 1}: target.locator is too long (${MAX_LOCATOR_LENGTH} characters at most)`)
  })
}

async function handle(method: string, path: string, body: Record<string, unknown>): Promise<unknown> {
  const seg = path.split('/').filter(Boolean).map(decodeURIComponent)
  const [, b, , d] = seg
  const key = `${method} ${seg.map((s, i) => (i % 2 === 1 && seg[0] !== 'session' ? ':' : s)).join('/')}`

  switch (key) {
    case 'GET session':
      return { required: false, ok: true }
    case 'POST session':
      return { ok: true }
    case 'GET projects':
      return projects.map(withCounts)
    case 'POST projects': {
      const p: Project = { id: id('p'), name: nameOf(body.name, 'Project'), description: String(body.description ?? ''), baseUrl: baseUrlOf(body.baseUrl) ?? '', variables: {}, createdAt: now() }
      projects.push(p)
      counters.set(p.id, { tc: 1, batch: 1, shared: 1 })
      return withCounts(p)
    }
    case 'GET projects/:':
      return withCounts(need(projects.find((p) => p.id === b), 'Project'))
    case 'PATCH projects/:': {
      const p = need(projects.find((x) => x.id === b), 'Project')
      // As the Worker stores them: the name trimmed, the base URL without the slash at its end, the variables checked.
      const next: Partial<Project> = {}
      if (body.name !== undefined) next.name = nameOf(body.name, 'Project')
      if (typeof body.description === 'string') next.description = body.description
      const baseUrl = baseUrlOf(body.baseUrl)
      if (baseUrl !== undefined) next.baseUrl = baseUrl
      if (body.variables !== undefined) {
        const variables = body.variables as Record<string, string>
        for (const name of Object.keys(variables)) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name.length > 60) throw new HttpError(400, `Invalid variable name "${name.slice(0, 60)}" (letters, digits and _ only, 60 characters at most)`)
          if (isBuiltInVariable(name)) throw new HttpError(400, `${name} is a built-in variable and cannot be a project variable${name === 'BASE_URL' ? ' (set the base URL instead)' : ''}. Remove it or use another name.`)
        }
        next.variables = variables
      }
      Object.assign(p, next)
      return withCounts(p)
    }
    case 'DELETE projects/:': {
      const p = need(projects.find((x) => x.id === b), 'Project')
      // Everything of the project goes with it.
      const gone = new Set(cases.filter((x) => x.projectId === p.id).map((x) => x.id))
      remove(uis, (u) => gone.has(u.testCaseId))
      remove(runs, (r) => r.projectId === p.id)
      remove(batches, (x) => x.projectId === p.id)
      remove(assistantSessions, (x) => gone.has(x.testCaseId))
      remove(cases, (x) => x.projectId === p.id)
      remove(projects, (x) => x === p)
      return { ok: true }
    }
    case 'GET projects/:/test-cases':
      return cases.filter((x) => x.projectId === b && x.kind === 'test').sort((x, y) => x.number - y.number)
    case 'GET projects/:/shared-steps':
      return cases.filter((x) => x.projectId === b && x.kind === 'shared').sort((x, y) => x.number - y.number).map(withUsedBy)
    case 'POST projects/:/shared-steps': {
      const ctr = need(counters.get(b), 'Project')
      const tc: TestCase = { id: id('sh'), projectId: b, kind: 'shared', data: null, number: ctr.shared++, name: String(body.name ?? 'New shared step'), description: String(body.description ?? ''), device: 'desktop', steps: [], stepsRev: '', createdAt: now(), updatedAt: now(), lastRun: null }
      cases.push(tc)
      return withUsedBy(tc)
    }
    case 'POST test-cases/:/extract-shared': {
      const src = need(cases.find((x) => x.id === b), 'Test case')
      const ctr = need(counters.get(src.projectId), 'Project')
      const ids = new Set(body.stepIds as string[])
      const first = src.steps.findIndex((s) => ids.has(s.id))
      const moved = first < 0 ? [] : src.steps.slice(first, first + ids.size)
      if (src.kind === 'shared') throw new HttpError(400, NESTED_SHARED_MESSAGE)
      if (!ids.size || moved.length !== ids.size || !moved.every((s) => ids.has(s.id))) throw new HttpError(400, 'stepIds must be consecutive steps of this test case (save the test case first)')
      if (moved.some((s) => s.command === 'shared_step')) throw new HttpError(400, `The selection contains a shared step call. ${NESTED_SHARED_MESSAGE}.`)
      if (validateSteps(moved).length) throw new HttpError(400, 'The selection must contain whole If ... End branch blocks: a shared step cannot start or end in the middle of one')
      await sleep(300)
      const shared: TestCase = { id: id('sh'), projectId: src.projectId, kind: 'shared', data: null, number: ctr.shared++, name: String(body.name ?? 'New shared step'), description: '', device: src.device, steps: [], stepsRev: '', createdAt: now(), updatedAt: now(), lastRun: null }
      // The shared step gets its own copies of the screens its steps point at.
      const copies = new Map<string, string>()
      for (const s of moved) {
        const from = s.target && !copies.has(s.target.uiId) ? uis.find((u) => u.id === s.target!.uiId) : undefined
        if (!from) continue
        const copy: Ui = { ...structuredClone(from), id: id('ui'), testCaseId: shared.id }
        copies.set(from.id, copy.id)
        uis.push(copy)
      }
      shared.steps = structuredClone(moved).map((s) => (s.target ? { ...s, target: { ...s.target, uiId: copies.get(s.target.uiId) ?? s.target.uiId } } : s))
      src.steps = [...src.steps.slice(0, first), { id: id('st'), command: 'shared_step', value: shared.id }, ...src.steps.slice(first + moved.length)]
      src.updatedAt = now()
      cases.push(shared)
      return { testCase: src, shared: withUsedBy(shared) }
    }
    case 'POST projects/:/test-cases': {
      const ctr = need(counters.get(b), 'Project')
      const tc: TestCase = { id: id('tc'), projectId: b, kind: 'test', data: null, number: ctr.tc++, name: String(body.name ?? 'New test'), description: String(body.description ?? ''), device: 'desktop', steps: [], stepsRev: '', createdAt: now(), updatedAt: now(), lastRun: null }
      cases.push(tc)
      return tc
    }
    case 'GET projects/:/batch-runs':
      return batches.filter((x) => x.projectId === b)
    case 'POST projects/:/batch-runs': {
      const ctr = need(counters.get(b), 'Project')
      const ids = body.testCaseIds as string[] | undefined
      let picked = cases.filter((x) => x.projectId === b && x.kind === 'test' && (!ids || ids.includes(x.id))).sort((x, y) => x.number - y.number)
      if (picked.length === 0) throw new HttpError(400, 'Select at least one test case to run')
      for (const tc of picked) {
        const problem = expand(tc).problems[0]
        if (problem) throw new HttpError(400, `#${tc.number} ${tc.name} - Step ${tc.steps.findIndex((s) => s.id === problem.stepId) + 1}: ${problem.message}`)
      }
      // A test case without steps would "succeed" without testing anything: an error when asked for by id, left out of "run everything".
      const empty = picked.filter((tc) => !hasEnabledSteps(expand(tc).steps))
      if (empty.length && ids) throw new HttpError(400, `#${empty[0].number} ${empty[0].name} has no steps to run`)
      picked = picked.filter((tc) => !empty.includes(tc))
      if (picked.length === 0) throw new HttpError(400, 'No test case in this project has steps to run')
      const batch: BatchRun = { id: id('b'), projectId: b, number: ctr.batch++, status: 'running', trigger: body.trigger === 'api' ? 'api' : 'manual', counts: { total: picked.length, succeeded: 0, failed: 0, unresolved: 0, aborted: 0 }, createdAt: now(), startedAt: now(), finishedAt: null }
      batches.unshift(batch)
      const queue = picked.map((tc, i) => makeRun(tc, 'queued', { batch, order: i + 1, minutesAgo: 0 }))
      const next = () => {
        recount(batch)
        const r = queue.shift()
        if (r && r.status === 'queued') simulate(r, next)
        else if (r) next()
      }
      if (queue.length) next()
      else recount(batch)
      return batch
    }
    case 'GET test-cases/:':
      return withUsedBy(need(cases.find((x) => x.id === b), 'Test case'))
    case 'PATCH test-cases/:': {
      const tc = need(cases.find((x) => x.id === b), 'Test case')
      await sleep(250)
      const nested = tc.kind === 'shared' && Array.isArray(body.steps) ? (body.steps as Step[]).findIndex((s) => s.command === 'shared_step') : -1
      if (nested >= 0) throw new HttpError(400, `Step ${nested + 1}: ${NESTED_SHARED_MESSAGE}`)
      // As the Worker: a save of the steps is refused while the assistant edits them, or when it was based on an older list.
      if (Array.isArray(body.steps)) {
        checkSteps(body.steps as Step[])
        if (assistantBusy(b)) throw new HttpError(409, 'The assistant is editing the steps of this test case. Wait for it to finish, or abort it, then try again.', 'assistant_busy')
        if (typeof body.baseStepsRev === 'string' && body.baseStepsRev !== revisionOf(tc)) {
          throw new HttpError(409, 'The steps were changed somewhere else in the meantime (another tab, an approved repair or the assistant). Reload them before editing, so that neither change is lost.', 'steps_changed')
        }
      }
      const { baseStepsRev: _base, ...fields } = body
      if (fields.name !== undefined) fields.name = nameOf(fields.name, tc.kind === 'shared' ? 'Shared step' : 'Test case')
      if (body.data) {
        const table = body.data as DataTable
        if (tc.kind === 'shared') throw new HttpError(400, 'A shared step cannot have a data table: it uses the data of the test case that calls it')
        const problem = validateDataTable(table)[0]
        if (problem) throw new HttpError(400, `Data: ${describeDataProblem(table, problem)}`)
      }
      Object.assign(tc, fields, { updatedAt: now() })
      return withUsedBy(tc)
    }
    case 'DELETE test-cases/:': {
      const tc = need(cases.find((x) => x.id === b), 'Test case')
      const callers = tc.kind === 'shared' ? callersOf(tc.id) : []
      if (callers.length) throw new HttpError(409, `Shared step ${sharedLabel(tc)} is used by ${callers.map((t) => `#${t.number} ${t.name}`).join(', ')}. Remove the calls first.`)
      // Its screens and its single runs go with it; a run inside a batch report stays as history.
      remove(uis, (u) => u.testCaseId === tc.id)
      remove(runs, (r) => r.testCaseId === tc.id && !r.batchRunId)
      remove(assistantSessions, (x) => x.testCaseId === tc.id)
      remove(cases, (x) => x === tc)
      return { ok: true }
    }
    case 'POST test-cases/:/duplicate': {
      const src = need(cases.find((x) => x.id === b), 'Test case')
      const ctr = need(counters.get(src.projectId), 'Project')
      const tc: TestCase = { ...structuredClone(src), id: id(src.kind === 'shared' ? 'sh' : 'tc'), number: src.kind === 'shared' ? ctr.shared++ : ctr.tc++, name: `${src.name} (copy)`, lastRun: null, createdAt: now(), updatedAt: now() }
      cases.push(tc)
      return withUsedBy(tc)
    }
    case 'GET test-cases/:/uis':
      return uis.filter((u) => u.testCaseId === b)
    case 'POST test-cases/:/uis': {
      const tc = need(cases.find((x) => x.id === b), 'Test case')
      const req = body as CaptureRequest
      await sleep(2600)
      const upto = req.afterStepId ? tc.steps.findIndex((s) => s.id === req.afterStepId) : -1
      // The replay goes through shared step calls: a call counts with all of its steps.
      const expanded = expand(tc).steps
      const broken = upto < 0 ? undefined : validateSteps(expanded, { from: 1, to: flatRange(expanded, { from: 1, to: upto + 1 }).to })[0]
      if (broken) throw new HttpError(400, `Step ${positionLabel(positionsOf(expanded)[expanded.findIndex((s) => s.id === broken.stepId)])}: ${broken.message}. Fix the branch structure, then capture again.`)
      const replayed = (upto < 0 ? [] : expanded.slice(0, flatRange(expanded, { from: 1, to: upto + 1 }).to)).filter((s) => !s.disabled && !s.call)
      // An assertion set to continue on failure does not stop the replay; it is reported next to the capture.
      const failing = replayed.filter((s) => (s.value ?? '').includes('!fail'))
      const failed = failing.find((s) => !(COMMAND_BY_ID[s.command]?.assertion && s.continueOnFailure))
      const tolerated = failing.slice(0, failed ? failing.indexOf(failed) : failing.length).map((s) => ({ stepId: s.origin?.callId ?? s.id, message: 'AssertionError: the value contained "!fail", which the mock treats as a failing step' }))
      // A failure inside a shared step is reported on the call, as the Worker does.
      const bad = failed && { id: failed.origin?.callId ?? failed.id }
      const clicks = replayed.filter((s) => s.command === 'click').length
      const page = /catalog/.test(req.url ?? '') || (clicks > 0 && !bad) ? PAGES[1] : PAGES[0]
      const ui = makeUi(tc.id, page, nextUiName(uis.filter((u) => u.testCaseId === tc.id).map((u) => u.name)))
      if (req.url) ui.url = req.url
      uis.push(ui)
      return { ui, ...(tolerated.length ? { tolerated } : {}), ...(bad ? { replayError: { stepId: bad.id, message: 'TimeoutError: locator not found after 10 s (the mock fails any step whose value contains "!fail")' } } : {}) }
    }
    case 'PATCH uis/:': {
      const ui = need(uis.find((u) => u.id === b), 'UI')
      await sleep(200)
      if (typeof body.name === 'string') ui.name = body.name
      if (Array.isArray(body.elements)) ui.elements = body.elements as UiElement[]
      return ui
    }
    case 'DELETE uis/:': {
      const ui = need(uis.find((u) => u.id === b), 'UI')
      if (assistantBusy(ui.testCaseId)) throw new HttpError(409, 'The assistant is working on this test case and may be using this screen. Wait for it to finish, or abort it, then delete the screen.', 'assistant_busy')
      remove(uis, (u) => u === ui)
      return { ok: true }
    }
    case 'POST test-cases/:/runs': {
      const tc = need(cases.find((x) => x.id === b), 'Test case')
      const problem = expand(tc).problems[0]
      if (problem) throw new HttpError(400, `Step ${tc.steps.findIndex((s) => s.id === problem.stepId) + 1}: ${problem.message}`)
      const range = (body.range as Run['range']) ?? null
      const expanded = expand(tc).steps
      if (!hasEnabledSteps(expanded)) throw new HttpError(400, `This ${tc.kind === 'shared' ? 'shared step' : 'test case'} has no steps to run`)
      const broken = validateSteps(expanded, range ? { from: 1, to: flatRange(expanded, range).to } : null)[0]
      if (broken) throw new HttpError(400, `Step ${positionLabel(positionsOf(expanded)[expanded.findIndex((s) => s.id === broken.stepId)])}: ${broken.message}`)
      if (range && reportedSteps(expanded, range).length === 0) throw new HttpError(400, range.from === range.to ? `Step ${range.from} is disabled, so there is nothing to run` : `Steps ${range.from}-${range.to} are all disabled, so there is nothing to run`)
      const run = makeRun(tc, 'queued', { minutesAgo: 0 })
      run.range = range
      // A partial run of a data-driven test case uses one data row.
      if (run.range && run.patterns) run.patterns = patternsFor(tc, [Math.min(Number(body.row) || 1, run.patterns.length)])
      simulate(run)
      return run
    }
    case 'GET test-cases/:/runs':
      // Single runs and the ones inside batch runs, newest first.
      return runs.filter((r) => r.testCaseId === b).sort((x, y) => y.createdAt.localeCompare(x.createdAt)).slice(0, 50).map(lite)
    case 'GET runs/:': {
      const run = need(runs.find((r) => r.id === b), 'Run')
      return cases.some((x) => x.id === run.testCaseId) ? run : { ...run, testCaseDeleted: true }
    }
    case 'POST runs/:/abort': {
      const run = need(runs.find((r) => r.id === b), 'Run')
      if (run.status === 'queued' || run.status === 'running') {
        run.status = 'aborted'
        run.finishedAt = now()
        for (const p of run.patterns ?? []) if (p.status === 'queued' || p.status === 'running') p.status = 'aborted'
        run.log = logFor(run.results, 'aborted', run.patterns)
        const tc = cases.find((x) => x.id === run.testCaseId)
        if (tc) refreshLastRun(tc)
      }
      return run
    }
    case 'POST runs/:/heals/:': {
      const run = need(runs.find((r) => r.id === b), 'Run')
      // In a data-driven run the step has a result in every pattern: `pattern` says which one is decided.
      if (run.patterns && !run.patterns.some((p) => p.index === body.pattern)) throw new HttpError(400, 'pattern must be the number of one of the data rows of this run')
      const res = need(run.results.find((r) => r.stepId === d && r.heal && r.pattern === (run.patterns ? body.pattern : undefined)), 'Heal')
      if (run.status === 'queued' || run.status === 'running') throw new HttpError(409, 'Wait for the run to finish before reviewing its repairs')
      if (res.heal!.state !== 'unresolved') throw new HttpError(409, `This repair was already ${res.heal!.state}`)
      res.heal!.state = body.action === 'approve' ? 'approved' : 'rejected'
      // An approved repair goes to the step's owner: the shared step for a step that came from one.
      const healed = run.steps.find((s) => s.id === d)
      const owner = cases.find((x) => x.id === (healed?.origin?.shared.id ?? run.testCaseId))
      if (body.action === 'approve' && healed?.target) {
        const t = healed.target
        const uses = (s: Step) => s.target?.uiId === t.uiId && s.target.elementId === t.elementId
        if (owner?.steps.some(uses)) {
          owner.steps = owner.steps.map((s) => (uses(s) ? { ...s, target: { ...s.target!, locator: res.heal!.newLocator, candidates: res.heal!.newCandidates } } : s))
          owner.updatedAt = now()
        } else res.heal!.notSaved = true // moved or deleted since the run: the reviewer is told
        // The element on its captured screen gets the new locators too, for the steps made from it later.
        const ui = uis.find((u) => u.id === t.uiId)
        if (ui) ui.elements = ui.elements.map((el) => (el.id === t.elementId ? { ...el, locators: res.heal!.newCandidates.length ? res.heal!.newCandidates : [res.heal!.newLocator] } : el))
        // Saved once: the same repair of the same element in the other patterns is approved with it.
        const same = new Set(run.steps.filter((s) => s.target?.uiId === t.uiId && s.target.elementId === t.elementId).map((s) => s.id))
        for (const other of run.results) {
          if (!run.patterns || other.heal?.state !== 'unresolved' || !same.has(other.stepId) || other.heal.newLocator.value !== res.heal!.newLocator.value) continue
          other.heal.state = 'approved'
          if (res.heal!.notSaved) other.heal.notSaved = true
        }
      }
      const reviewed = (status: RunStatus, own: StepResult[]): RunStatus =>
        status !== 'unresolved' ? status : own.some((r) => r.heal?.state === 'rejected' || r.status === 'failed') ? 'failed' : own.some((r) => r.heal?.state === 'unresolved') ? 'unresolved' : 'succeeded'
      if (run.patterns) {
        for (const p of run.patterns) p.status = reviewed(p.status, run.results.filter((r) => r.pattern === p.index))
        if (run.status === 'unresolved') run.status = aggregateStatus(run.patterns.map((p) => p.status))
      } else run.status = reviewed(run.status, run.results)
      const batch = batches.find((x) => x.id === run.batchRunId)
      if (batch) recount(batch)
      const tc = cases.find((x) => x.id === run.testCaseId)
      if (tc) refreshLastRun(tc)
      return run
    }
    case 'GET batch-runs/:': {
      const batch = need(batches.find((x) => x.id === b), 'Batch run')
      recount(batch)
      return { ...batch, runs: runs.filter((r) => r.batchRunId === b).sort((x, y) => x.order - y.order).map(lite) }
    }
    case 'GET assistant/:':
      if (b === 'status') return { enabled: true, model: 'claude-haiku-5-5 (mock)' }
      return need(assistantSessions.find((x) => x.id === b), 'Assistant session')
    case 'GET test-cases/:/assistant':
      return assistantSessions.filter((x) => x.testCaseId === b)
    case 'POST test-cases/:/assistant': {
      const tc = need(cases.find((x) => x.id === b), 'Test case')
      const message = typeof body.message === 'string' ? body.message.trim() : ''
      if (!message) throw new HttpError(400, 'Describe what the test should do')
      if (message.length > 2000) throw new HttpError(400, 'The message must be 2000 characters or fewer')
      if (assistantSessions.some((x) => x.testCaseId === b && (x.status === 'queued' || x.status === 'running'))) throw new HttpError(409, 'The assistant is still working on this test case. Wait for it to finish, or abort it.')
      const session: AssistantSession = { id: id('as'), testCaseId: tc.id, status: 'queued', events: [{ kind: 'user', text: message, at: now() }], usage: null, error: null, createdAt: now(), finishedAt: null }
      assistantSessions.push(session)
      simulateAssistant(session, tc)
      return session
    }
    case 'POST assistant/:/abort': {
      const session = need(assistantSessions.find((x) => x.id === b), 'Assistant session')
      if (session.status === 'queued' || session.status === 'running') {
        Object.assign(session, { status: 'aborted', finishedAt: now() })
        session.events.push({ kind: 'error', text: 'Aborted. The steps built so far are kept.', at: now() })
      }
      return session
    }
    case 'POST batch-runs/:/abort': {
      const batch = need(batches.find((x) => x.id === b), 'Batch run')
      for (const r of runs) {
        if (r.batchRunId !== b || (r.status !== 'queued' && r.status !== 'running')) continue
        Object.assign(r, { status: 'aborted', finishedAt: now(), patterns: settledPatterns('aborted', r.patterns ?? null) })
        const tc = cases.find((x) => x.id === r.testCaseId)
        if (tc) refreshLastRun(tc)
      }
      recount(batch)
      return batch
    }
  }
  throw new HttpError(404, `Mock has no route for ${method} /api${path}`)
}

export function installMock() {
  seed()
  setShotResolver(resolveShot)
  const real = window.fetch.bind(window)
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin)
    if (!url.pathname.startsWith('/api/')) return real(input, init)
    const method = (init?.method ?? 'GET').toUpperCase()
    await sleep(120)
    try {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
      const data = await handle(method, url.pathname.slice(4), body)
      // Test cases are answered from the objects in `cases`: each carries the revision of its steps as they are now.
      for (const tc of cases) tc.stepsRev = revisionOf(tc)
      return new Response(JSON.stringify(structuredClone(data)), { status: 200, headers: { 'content-type': 'application/json' } })
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500
      return new Response(JSON.stringify({ error: err instanceof Error ? err.message : 'Mock error', ...(err instanceof HttpError && err.code ? { code: err.code } : {}) }), { status, headers: { 'content-type': 'application/json' } })
    }
  }
  console.info('[stepwise] Using the in-browser mock API (VITE_MOCK).')
}
