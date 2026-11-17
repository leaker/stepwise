// Locator resolution and polling helpers shared by the executor and self-healing.
import type { Locator as PwLocator, Page } from '@cloudflare/playwright'
import type { Locator } from '../../shared/types'

/** Playwright selector for one of our locators. */
export function toSelector(l: Locator): string {
  if (l.key === 'id') return `css=[id="${l.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`
  if (l.key === 'xpath') return `xpath=${l.value}`
  return `css=${l.value}`
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const POLL_MS = 150

/**
 * Calls `attempt` until it returns a truthy value or `timeoutMs` has passed. Errors thrown by an
 * attempt (page navigating, detached nodes) count as "not yet". Always tries at least once.
 */
export async function poll<T>(attempt: () => Promise<T | null | undefined | false>, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const value = await attempt()
      if (value) return value
    } catch {
      // retry
    }
    const left = deadline - Date.now()
    if (left <= 0) return null
    await sleep(Math.min(POLL_MS, left))
  }
}

export interface Resolved {
  /** The element, when the locator matches exactly one node. */
  el: PwLocator | null
  /** How many nodes the locator matched when the wait ended: 0 = missing, more than 1 = ambiguous. */
  count: number
}

/**
 * Waits until the locator matches exactly one node. A locator is unique when it is captured, so
 * one that matches several nodes later has stopped identifying its element: acting on the first
 * match would silently test something else, hence no element is returned for it.
 */
export async function waitForElement(page: Page, locator: Locator, timeoutMs: number): Promise<Resolved> {
  const handle = page.locator(toSelector(locator))
  let count = 0
  const found = await poll(async () => (count = await handle.count()) === 1, timeoutMs)
  return { el: found ? handle : null, count: found ? 1 : count }
}

/**
 * Is any node matched by the locator rendered (it has a box and is not `visibility: hidden`)?
 * This is what "exists" means to the person who built the test: captures only offer elements
 * that can be seen, and an empty `display: none` error box is not an error on the screen.
 */
export async function isRendered(page: Page, locator: Locator): Promise<boolean> {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  return page.locator(toSelector(locator)).evaluateAll((nodes: any[]) =>
    nodes.some((node) => {
      const r = node.getBoundingClientRect()
      return r.width > 0 && r.height > 0 && (globalThis as any).getComputedStyle(node).visibility === 'visible'
    }),
  )
  /* eslint-enable @typescript-eslint/no-explicit-any */
}
