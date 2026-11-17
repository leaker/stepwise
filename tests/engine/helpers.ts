// Shared fixtures for the engine tests: a static server for public/demo and step builders.
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page as NodePage } from 'playwright'
import type { CommandId, ElementRef, Step, UiElement } from '../../shared/types'
import { captureUi, runSteps } from '../../worker/engine'
import type { RunOptions, RunOutcome } from '../../worker/engine'

type EnginePage = Parameters<typeof captureUi>[0]
/** Node Playwright and @cloudflare/playwright expose the same Page API; only the nominal types differ. */
export const asEnginePage = (page: NodePage) => page as unknown as EnginePage

const ROOT = resolve(fileURLToPath(new URL('../../public', import.meta.url)))
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
}

export async function startDemoServer(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(async (req, res) => {
    try {
      const path = normalize(decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname))
      const file = join(ROOT, path.endsWith('/') ? path + 'index.html' : path)
      if (!file.startsWith(ROOT)) throw new Error('outside root')
      const body = await readFile(file)
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
      res.end(body)
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('Not found')
    }
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as AddressInfo
  return { server, baseUrl: `http://127.0.0.1:${port}/demo/` }
}

export interface CapturedUi {
  uiId: string
  elements: UiElement[]
  width: number
  height: number
  screenshot: Uint8Array
}

export async function capture(page: NodePage, uiId: string): Promise<CapturedUi> {
  const c = await captureUi(asEnginePage(page))
  return { uiId, elements: c.elements, width: c.width, height: c.height, screenshot: c.screenshot }
}

export function element(ui: CapturedUi, name: string): UiElement {
  const hits = ui.elements.filter((e) => e.name === name)
  if (hits.length === 0) throw new Error(`No element named ${name} in ${ui.uiId}. Have: ${ui.elements.map((e) => e.name).join(' | ')}`)
  return hits[0]
}

export function ref(ui: CapturedUi, name: string): ElementRef {
  const e = element(ui, name)
  return { uiId: ui.uiId, elementId: e.id, name: e.name, locator: e.locators[0], candidates: e.locators, fingerprint: e.fingerprint }
}

let nextId = 1
export function step(command: CommandId, fields: Partial<Omit<Step, 'id' | 'command'>> = {}): Step {
  return { id: `s${nextId++}`, command, ...fields }
}

export interface TestRun extends RunOutcome {
  shots: Uint8Array[]
  onStepCalls: number
}

export async function run(page: NodePage, steps: Step[], baseUrl: string, extra: Partial<RunOptions> = {}): Promise<TestRun> {
  const shots: Uint8Array[] = []
  let onStepCalls = 0
  const outcome = await runSteps(asEnginePage(page), steps, {
    baseUrl,
    variables: {},
    heal: false,
    waitSeconds: 1,
    saveShot: async (bytes) => {
      shots.push(bytes)
      return `shot-${shots.length}`
    },
    onStep: () => {
      onStepCalls++
    },
    ...extra,
  })
  return { ...outcome, shots, onStepCalls }
}

/** Width and height from a JPEG's SOF marker. */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } {
  let i = 2
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) throw new Error('Bad JPEG')
    const marker = bytes[i + 1]
    const length = (bytes[i + 2] << 8) | bytes[i + 3]
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: (bytes[i + 5] << 8) | bytes[i + 6], width: (bytes[i + 7] << 8) | bytes[i + 8] }
    }
    i += 2 + length
  }
  throw new Error('No SOF marker')
}
