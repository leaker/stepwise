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

/** Waits until the locator matches at least one node; returns the first match, or null on timeout. */
export async function waitForElement(page: Page, locator: Locator, timeoutMs: number): Promise<PwLocator | null> {
  const handle = page.locator(toSelector(locator))
  const found = await poll(async () => (await handle.count()) > 0, timeoutMs)
  return found ? handle.first() : null
}
