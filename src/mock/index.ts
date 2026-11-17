// In-browser stand-in for the Worker API. Loaded only when VITE_MOCK is set (see main.tsx);
// it exists so the UI can be exercised before, or without, the real backend.
import { COMMAND_BY_ID, stepSentence } from '../../shared/commands'
import type {
  BatchRun,
  Box,
  CaptureRequest,
  ElementType,
  HealProposal,
  Locator,
  Project,
  Run,
  RunStatus,
  Step,
  StepResult,
  TestCase,
  Ui,
  UiElement,
} from '../../shared/types'
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
const counters = new Map<string, { tc: number; batch: number }>()

function makeUi(tcId: string, page: PageSpec, name: string): Ui {
  return {
    id: id('ui'),
    testCaseId: tcId,
    name,
    url: ORIGIN + page.path,
    title: page.title,
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
  steps.forEach((s, i) => {
    if (s.disabled || (failAt >= 0 && i > failAt)) return
    const def = COMMAND_BY_ID[s.command]
    if (s.target && uis.find((u) => u.id === s.target!.uiId)?.screenshotKey === 'mock-catalog') page = PAGES[1]
    const r: StepResult = { stepId: s.id, number: i + 1, status: 'passed', sentence: stepSentence(s), durationMs: 180 + ((i * 337) % 900) }
    if (def.shot) r.screenshotKey = page.key
    if (i === failAt) {
      r.status = 'failed'
      r.error = s.target ? `AssertionError: expected ${s.target.name} to equal ${JSON.stringify(s.value ?? '')}, but it was "Welcome back, Alice"` : 'The step failed.'
    }
    if (i === healAt && s.target && ui) {
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
        before: { uiId: ui.id, box: s.target.fingerprint.box },
        after: { screenshotKey: 'mock-login', box, width: 1280, height: 860 },
      }
      r.heal = heal
    }
    out.push(r)
  })
  return out
}

function makeRun(tc: TestCase, status: RunStatus, opts: { failAt?: number; healAt?: number; batch?: BatchRun; order?: number; minutesAgo?: number } = {}): Run {
  const steps = structuredClone(tc.steps)
  const done = status !== 'queued' && status !== 'running'
  const firstUi = uis.find((u) => u.testCaseId === tc.id)
  const results = done ? resultsFor(steps, opts.failAt, opts.healAt, firstUi) : []
  const started = ago(opts.minutesAgo ?? 5)
  const run: Run = {
    id: id('run'),
    projectId: tc.projectId,
    testCaseId: tc.id,
    testCaseNumber: tc.number,
    testCaseName: tc.name,
    batchRunId: opts.batch?.id ?? null,
    order: opts.order ?? 0,
    status,
    steps,
    results,
    log: done ? logFor(results, status) : '',
    environment: { browser: 'Chromium 142', viewport: { width: 1280, height: 800 }, baseUrl: ORIGIN },
    range: null,
    createdAt: started,
    startedAt: status === 'queued' ? null : started,
    finishedAt: done ? new Date(Date.parse(started) + 9_000).toISOString() : null,
  }
  runs.push(run)
  if (!opts.batch) tc.lastRun = { id: run.id, status, finishedAt: run.finishedAt }
  return run
}

function logFor(results: StepResult[], status: RunStatus): string {
  const lines = ['Environment: Cloudflare Browser Run', 'Browser: Chromium 142, viewport 1280x800']
  for (const r of results) {
    lines.push(`[${r.number}] ${r.sentence}`)
    if (r.heal) lines.push(`    locator ${r.heal.oldLocator.key}=${r.heal.oldLocator.value} not found; repaired to ${r.heal.newLocator.key}=${r.heal.newLocator.value} (score ${r.heal.score})`)
    if (r.error) lines.push(`    ${r.error}`)
    lines.push(`    ${r.status} in ${r.durationMs} ms`)
  }
  if (status !== 'running' && status !== 'queued') lines.push(`Run ${status}.`)
  return lines.join('\n')
}

function seed() {
  const p: Project = { id: 'p_demo', name: 'Harbor Books storefront', description: 'Sign-in, catalog and cart flows for the public shop.', baseUrl: ORIGIN, variables: { USER_EMAIL: 'alice@example.com', USER_PASSWORD: 'correct-horse' }, createdAt: ago(6000) }
  projects.push(p, { id: 'p_empty', name: 'Internal admin console with a deliberately very long project name to check truncation in breadcrumbs', description: '', baseUrl: '', variables: {}, createdAt: ago(300) })
  counters.set(p.id, { tc: 4, batch: 3 })
  counters.set('p_empty', { tc: 1, batch: 1 })

  const tc1: TestCase = { id: 'tc_signin', projectId: p.id, number: 1, name: 'Sign in with a valid account', description: 'Happy path: a registered customer signs in and lands on the catalog.', steps: [], createdAt: ago(5000), updatedAt: ago(40), lastRun: null }
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
  const tc2: TestCase = { id: 'tc_cart', projectId: p.id, number: 2, name: 'Add a book to the cart', description: '', steps: [{ id: 'c1', command: 'navigate', value: '/demo/catalog' }, { id: 'c2', command: 'click', target: ref(catalog, 8) }, { id: 'c3', command: 'assert_text_contains', value: 'Cart (1)', target: ref(catalog, 2) }], createdAt: ago(4000), updatedAt: ago(90), lastRun: null }
  const tc3: TestCase = { id: 'tc_new', projectId: p.id, number: 3, name: 'New test', description: '', steps: [], createdAt: ago(10), updatedAt: ago(10), lastRun: null }
  cases.push(tc1, tc2, tc3)

  makeRun(tc1, 'succeeded', { minutesAgo: 300 })
  makeRun(tc1, 'failed', { failAt: 6, minutesAgo: 120 })
  makeRun(tc2, 'succeeded', { minutesAgo: 200 })

  const b1: BatchRun = { id: 'b_1', projectId: p.id, number: 1, status: 'succeeded', trigger: 'api', counts: { total: 2, succeeded: 2, failed: 0, unresolved: 0, aborted: 0 }, createdAt: ago(1500), startedAt: ago(1500), finishedAt: ago(1499) }
  makeRun(tc1, 'succeeded', { batch: b1, order: 1, minutesAgo: 1500 })
  makeRun(tc2, 'succeeded', { batch: b1, order: 2, minutesAgo: 1499 })
  const b2: BatchRun = { id: 'b_2', projectId: p.id, number: 2, status: 'unresolved', trigger: 'manual', counts: { total: 2, succeeded: 0, failed: 1, unresolved: 1, aborted: 0 }, createdAt: ago(60), startedAt: ago(60), finishedAt: ago(59) }
  makeRun(tc1, 'unresolved', { batch: b2, order: 1, healAt: 4, minutesAgo: 60 })
  makeRun(tc2, 'failed', { batch: b2, order: 2, failAt: 2, minutesAgo: 59 })
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
  const from = run.range?.from ?? 1
  const to = run.range?.to ?? run.steps.length
  const todo = run.steps.map((s, i) => ({ s, i })).filter(({ s, i }) => !s.disabled && i + 1 >= from && i + 1 <= to)
  let k = 0
  const finish = (status: RunStatus) => {
    run.status = status
    run.finishedAt = now()
    run.log = logFor(run.results, status)
    const tc = cases.find((c) => c.id === run.testCaseId)
    if (tc && !run.batchRunId) tc.lastRun = { id: run.id, status, finishedAt: run.finishedAt }
    onDone?.()
  }
  const tick = () => {
    if (run.status === 'aborted') return onDone?.()
    if (run.status === 'queued') {
      run.status = 'running'
      run.startedAt = now()
      return void setTimeout(tick, 500)
    }
    const item = todo[k++]
    if (!item) return finish('succeeded')
    const { s, i } = item
    const def = COMMAND_BY_ID[s.command]
    const r: StepResult = { stepId: s.id, number: i + 1, status: 'passed', sentence: stepSentence(s), durationMs: 200 + Math.round(Math.random() * 600) }
    const onCatalog = s.target ? uis.find((u) => u.id === s.target!.uiId)?.screenshotKey === 'mock-catalog' : /catalog/.test(s.value ?? '')
    if (def.shot) r.screenshotKey = onCatalog ? 'mock-catalog' : 'mock-login'
    const fail = (s.value ?? '').includes('!fail')
    if (fail) {
      r.status = 'failed'
      r.error = `AssertionError: the value contained "!fail", which the mock treats as a failing step`
    }
    run.results = [...run.results, r]
    run.log = logFor(run.results, 'running')
    if (fail && !s.continueOnFailure) return finish('failed')
    setTimeout(tick, 650)
  }
  setTimeout(tick, 600)
}

// ---------- router ----------

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}
const need = <T,>(v: T | undefined, what: string): T => {
  if (v === undefined) throw new HttpError(404, `${what} not found`)
  return v
}
const lite = (r: Run) => {
  const { steps: _s, log: _l, ...rest } = r
  return rest
}
const withCounts = (p: Project): Project => ({ ...p, testCaseCount: cases.filter((c) => c.projectId === p.id).length, batchRunCount: batches.filter((b) => b.projectId === p.id).length })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function handle(method: string, path: string, body: Record<string, unknown>): Promise<unknown> {
  const seg = path.split('/').filter(Boolean)
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
      const p: Project = { id: id('p'), name: String(body.name ?? 'Untitled'), description: String(body.description ?? ''), baseUrl: String(body.baseUrl ?? ''), variables: {}, createdAt: now() }
      projects.push(p)
      counters.set(p.id, { tc: 1, batch: 1 })
      return withCounts(p)
    }
    case 'GET projects/:':
      return withCounts(need(projects.find((p) => p.id === b), 'Project'))
    case 'PATCH projects/:': {
      const p = need(projects.find((x) => x.id === b), 'Project')
      Object.assign(p, body)
      return withCounts(p)
    }
    case 'DELETE projects/:':
      projects.splice(projects.findIndex((p) => p.id === b), 1)
      return { ok: true }
    case 'GET projects/:/test-cases':
      return cases.filter((x) => x.projectId === b).sort((x, y) => x.number - y.number)
    case 'POST projects/:/test-cases': {
      const ctr = need(counters.get(b), 'Project')
      const tc: TestCase = { id: id('tc'), projectId: b, number: ctr.tc++, name: String(body.name ?? 'New test'), description: String(body.description ?? ''), steps: [], createdAt: now(), updatedAt: now(), lastRun: null }
      cases.push(tc)
      return tc
    }
    case 'GET projects/:/batch-runs':
      return batches.filter((x) => x.projectId === b)
    case 'POST projects/:/batch-runs': {
      const ctr = need(counters.get(b), 'Project')
      const ids = body.testCaseIds as string[] | undefined
      const picked = cases.filter((x) => x.projectId === b && (!ids || ids.includes(x.id))).sort((x, y) => x.number - y.number)
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
      return need(cases.find((x) => x.id === b), 'Test case')
    case 'PATCH test-cases/:': {
      const tc = need(cases.find((x) => x.id === b), 'Test case')
      await sleep(250)
      Object.assign(tc, body, { updatedAt: now() })
      return tc
    }
    case 'DELETE test-cases/:':
      cases.splice(cases.findIndex((x) => x.id === b), 1)
      return { ok: true }
    case 'POST test-cases/:/duplicate': {
      const src = need(cases.find((x) => x.id === b), 'Test case')
      const ctr = need(counters.get(src.projectId), 'Project')
      const tc: TestCase = { ...structuredClone(src), id: id('tc'), number: ctr.tc++, name: `${src.name} (copy)`, lastRun: null, createdAt: now(), updatedAt: now() }
      cases.push(tc)
      return tc
    }
    case 'GET test-cases/:/uis':
      return uis.filter((u) => u.testCaseId === b)
    case 'POST test-cases/:/uis': {
      const tc = need(cases.find((x) => x.id === b), 'Test case')
      const req = body as CaptureRequest
      await sleep(2600)
      const upto = req.afterStepId ? tc.steps.findIndex((s) => s.id === req.afterStepId) : -1
      const replayed = tc.steps.slice(0, upto + 1).filter((s) => !s.disabled)
      const bad = replayed.find((s) => (s.value ?? '').includes('!fail'))
      const clicks = replayed.filter((s) => s.command === 'click').length
      const page = /catalog/.test(req.url ?? '') || (clicks > 0 && !bad) ? PAGES[1] : PAGES[0]
      const ui = makeUi(tc.id, page, `UI${uis.filter((u) => u.testCaseId === tc.id).length + 1}`)
      if (req.url) ui.url = req.url
      uis.push(ui)
      return { ui, ...(bad ? { replayError: { stepId: bad.id, message: 'TimeoutError: locator not found after 10 s (the mock fails any step whose value contains "!fail")' } } : {}) }
    }
    case 'PATCH uis/:': {
      const ui = need(uis.find((u) => u.id === b), 'UI')
      await sleep(200)
      if (typeof body.name === 'string') ui.name = body.name
      if (Array.isArray(body.elements)) ui.elements = body.elements as UiElement[]
      return ui
    }
    case 'DELETE uis/:':
      uis.splice(uis.findIndex((u) => u.id === b), 1)
      return { ok: true }
    case 'POST test-cases/:/runs': {
      const tc = need(cases.find((x) => x.id === b), 'Test case')
      const run = makeRun(tc, 'queued', { minutesAgo: 0 })
      run.range = (body.range as Run['range']) ?? null
      tc.lastRun = { id: run.id, status: 'queued', finishedAt: null }
      simulate(run)
      return run
    }
    case 'GET test-cases/:/runs':
      return runs.filter((r) => r.testCaseId === b && !r.batchRunId).sort((x, y) => y.createdAt.localeCompare(x.createdAt)).map(lite)
    case 'GET runs/:':
      return need(runs.find((r) => r.id === b), 'Run')
    case 'POST runs/:/abort': {
      const run = need(runs.find((r) => r.id === b), 'Run')
      if (run.status === 'queued' || run.status === 'running') {
        run.status = 'aborted'
        run.finishedAt = now()
        run.log = logFor(run.results, 'aborted')
      }
      return run
    }
    case 'POST runs/:/heals/:': {
      const run = need(runs.find((r) => r.id === b), 'Run')
      const res = need(run.results.find((r) => r.stepId === d && r.heal), 'Heal')
      if (run.status === 'queued' || run.status === 'running') throw new HttpError(409, 'Wait for the run to finish before reviewing its repairs')
      if (res.heal!.state !== 'unresolved') throw new HttpError(409, `This repair was already ${res.heal!.state}`)
      res.heal!.state = body.action === 'approve' ? 'approved' : 'rejected'
      if (run.status === 'unresolved') {
        if (run.results.some((r) => r.heal?.state === 'rejected' || r.status === 'failed')) run.status = 'failed'
        else if (!run.results.some((r) => r.heal?.state === 'unresolved')) run.status = 'succeeded'
      }
      const batch = batches.find((x) => x.id === run.batchRunId)
      if (batch) recount(batch)
      return run
    }
    case 'GET batch-runs/:': {
      const batch = need(batches.find((x) => x.id === b), 'Batch run')
      recount(batch)
      return { ...batch, runs: runs.filter((r) => r.batchRunId === b).sort((x, y) => x.order - y.order).map(lite) }
    }
    case 'POST batch-runs/:/abort': {
      const batch = need(batches.find((x) => x.id === b), 'Batch run')
      for (const r of runs) if (r.batchRunId === b && (r.status === 'queued' || r.status === 'running')) Object.assign(r, { status: 'aborted', finishedAt: now() })
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
      return new Response(JSON.stringify(structuredClone(data)), { status: 200, headers: { 'content-type': 'application/json' } })
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500
      return new Response(JSON.stringify({ error: err instanceof Error ? err.message : 'Mock error' }), { status, headers: { 'content-type': 'application/json' } })
    }
  }
  console.info('[stepwise] Using the in-browser mock API (VITE_MOCK).')
}
