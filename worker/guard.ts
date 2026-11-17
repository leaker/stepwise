// Target policy for every browser context the runner opens. Kept free of runtime imports from
// @cloudflare/playwright so the tests can install it on a Node Playwright context.
import type { BrowserContext, Page, Request } from '@cloudflare/playwright'
import type { Env } from './env'
import { isHostAllowed, isPrivateHost, parseHttpUrl } from './validate'

/** Runs in every document before its own scripts. Plain source text: nothing from this module exists in the page. */
const DROP_INLINE_SPECULATION_RULES = `(() => {
  const isRules = (n) => n && n.nodeType === 1 && n.localName === 'script' && String(n.getAttribute('type') || '').trim().toLowerCase() === 'speculationrules'
  const drop = (n) => {
    if (isRules(n)) n.remove()
    else if (n && n.nodeType === 1 && n.querySelectorAll) for (const s of n.querySelectorAll('script[type="speculationrules" i]')) s.remove()
  }
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes') drop(r.target)
      else for (const n of r.addedNodes) drop(n)
    }
  }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['type'] })
})()`

export interface Guard {
  /** URL of a top-level navigation that was refused since the last call (and forget it), or null. */
  takeBlockedNavigation(): string | null
}

/**
 * Enforce the target policy (private hosts always refused, plus ALLOWED_HOSTS when set) inside the browser:
 * - a request whose URL is not allowed is aborted before it is sent: documents (top-level and iframes) must be
 *   on an allowed host; sub-resources may come from any public host, but never from a private one;
 * - a refused top-level navigation is remembered, so the step that caused it fails with that URL instead of
 *   silently continuing on an error page. A refused iframe just stays empty; the page around it is untouched;
 * - Playwright does not route redirect hops, so they are checked as they happen: a navigation that is redirected
 *   to a host that is not allowed is cancelled and the frame is blanked. That hop's request has left the browser
 *   by then (its response is never shown), and a redirected sub-resource can only be logged.
 */
export async function guardContext(context: BrowserContext, env: Pick<Env, 'ALLOWED_HOSTS'>, appOrigin: string): Promise<Guard> {
  let blocked: string | null = null
  const refuse = (url: string) => {
    blocked ??= url
    console.warn(`Blocked navigation to a host that is not allowed: ${url}`)
  }
  // Pages the browser shows on its own, including the error page of a request that was aborted above.
  const builtIn = (raw: string): boolean => raw === '' || raw.startsWith('about:') || raw.startsWith('data:') || raw.startsWith('blob:') || raw.startsWith('chrome-error:')
  const documentAllowed = (raw: string): boolean => {
    if (builtIn(raw)) return true
    const url = parseHttpUrl(raw)
    return url !== null && isHostAllowed(url, env, appOrigin)
  }
  const resourceAllowed = (url: URL): boolean => url.origin === appOrigin || !isPrivateHost(url.hostname)
  const inMainFrame = (request: Request): boolean => {
    try {
      const frame = request.frame()
      return frame === frame.page().mainFrame()
    } catch {
      return false // service worker requests have no frame
    }
  }

  await context.route('**/*', async (route) => {
    const request = route.request()
    const url = parseHttpUrl(request.url())
    // Speculation rules (e.g. the `Speculation-Rules: "/cdn-cgi/speculation"` header Cloudflare Speed Brain adds)
    // make Chrome prefetch a link on mouse-down. On Cloudflare Browser Run that prefetch tears the whole browser
    // session down, so every click on a link of such a site would kill the run. Refusing the rule set keeps the
    // browser from speculating; the page itself behaves the same. (Rules written into the page are handled below.)
    if (request.headers()['sec-fetch-dest'] === 'speculationrules' || url?.pathname === '/cdn-cgi/speculation') return route.abort('blockedbyclient')
    if (url) {
      const navigation = request.isNavigationRequest()
      if (!(navigation ? isHostAllowed(url, env, appOrigin) : resourceAllowed(url))) {
        if (navigation && inMainFrame(request)) refuse(url.href)
        return route.abort('blockedbyclient')
      }
    }
    return route.fallback()
  })

  // Rules written into the page itself (<script type="speculationrules">, which WordPress emits by default) fetch
  // nothing that could be refused, and the prefetch they cause does not pass through the route above. Taking the
  // script element out of the document withdraws its rules, so that is done in every frame as soon as one appears.
  await context.addInitScript(DROP_INLINE_SPECULATION_RULES)

  const watch = (page: Page) => {
    const blank = (frame: ReturnType<Page['mainFrame']>, url: string) => {
      if (frame === page.mainFrame()) refuse(url)
      else console.warn(`Blanked an iframe that was redirected to a host that is not allowed: ${url}`)
      void frame.goto('about:blank').catch(() => {})
    }
    page.on('request', (request) => {
      if (!request.redirectedFrom()) return
      const url = parseHttpUrl(request.url())
      if (!url) return
      if (!request.isNavigationRequest()) {
        if (!resourceAllowed(url)) console.warn(`A sub-resource was redirected to a private host: ${url.href}`)
        return
      }
      if (isHostAllowed(url, env, appOrigin)) return
      try {
        blank(request.frame(), url.href)
      } catch {
        /* the frame is gone */
      }
    })
    // Last line of defence for anything that committed anyway (e.g. a client-side navigation the route missed).
    page.on('framenavigated', (frame) => {
      if (!documentAllowed(frame.url())) blank(frame, frame.url())
    })
  }
  for (const page of context.pages()) watch(page)
  context.on('page', watch)

  return {
    takeBlockedNavigation: () => {
      const url = blocked
      blocked = null
      return url
    },
  }
}
