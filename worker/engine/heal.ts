// Self-healing: find the element a broken locator used to point at by comparing the
// fingerprint stored at capture time with every element currently on the page.
import type { Page } from '@cloudflare/playwright'
import type { ElementRef, ElementType, Fingerprint, Locator, UiElement } from '../../shared/types'
import { scan } from './detect'

/** A replacement is accepted only above this similarity ... */
export const HEAL_MIN_SCORE = 0.55
/** ... and only when it beats the second best candidate by this much. */
export const HEAL_MIN_MARGIN = 0.08
/**
 * Below this, a text / label / attribute is treated as "a different one". Structure and position
 * alone never make a match: something that says *which* element it is has to carry over.
 */
export const IDENTITY_MIN_SCORE = 0.5
const HEAL_SCAN_LIMIT = 1500

const CLICKABLE: ElementType[] = ['button', 'link', 'other']
const TYPING: ElementType[] = ['input', 'textarea']

/** 1 for the same element type, 0.5 for interchangeable ones (button/link, input/textarea), else 0. */
export function typeCompatibility(a: ElementType, b: ElementType): number {
  if (a === b) return 1
  if (CLICKABLE.includes(a) && CLICKABLE.includes(b)) return 0.5
  if (TYPING.includes(a) && TYPING.includes(b)) return 0.5
  return 0
}

const clean = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1))
    }
    prev = row
  }
  return prev[b.length]
}

const tokens = (s: string) => s.split(/[^a-z0-9]+/).filter(Boolean)

function jaccard(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0
  const setB = new Set(b)
  const shared = new Set(a.filter((t) => setB.has(t))).size
  return shared / (new Set(a).size + setB.size - shared)
}

/**
 * 0..1 similarity of two short strings. Tolerates edits that keep the original wording,
 * e.g. "Register" -> "Register now" scores about 0.87.
 */
export function textSimilarity(rawA: string, rawB: string): number {
  const a = clean(rawA)
  const b = clean(rawB)
  if (!a || !b) return 0
  if (a === b) return 1
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  const contained = short.length >= 3 && long.includes(short) ? 0.6 + 0.4 * (short.length / long.length) : 0
  const edit = 1 - levenshtein(a, b) / long.length
  return Math.max(contained, edit, jaccard(tokens(a), tokens(b)))
}

function pathSimilarity(a: string, b: string): number {
  const x = a.split('>')
  const y = b.split('>')
  if (!x.length || !y.length) return 0
  // Longest common subsequence, so an added or removed wrapper costs one segment only.
  const table = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0))
  for (let i = 1; i <= x.length; i++) {
    for (let j = 1; j <= y.length; j++) {
      table[i][j] = x[i - 1] === y[j - 1] ? table[i - 1][j - 1] + 1 : Math.max(table[i - 1][j], table[i][j - 1])
    }
  }
  return table[x.length][y.length] / Math.max(x.length, y.length)
}

const ATTR_WEIGHTS: Record<string, number> = {
  name: 2,
  'data-testid': 2,
  placeholder: 1.5,
  href: 1.5,
  'aria-label': 1.5,
  alt: 1.5,
  id: 1,
  type: 1,
  title: 1,
  value: 1,
  role: 0.5,
}

function attrSimilarity(name: string, a: string, b: string | undefined): number {
  if (b === undefined) return 0
  if (a === b) return 1
  if (name === 'type' || name === 'role') return 0
  if (name === 'href') {
    const strip = (s: string) => s.replace(/[?#].*$/, '')
    return strip(a) === strip(b) ? 0.9 : textSimilarity(strip(a), strip(b)) * 0.8
  }
  return textSimilarity(a, b)
}

const classSimilarity = (a: string, b: string | undefined) => jaccard(a.split(/\s+/).filter(Boolean), (b ?? '').split(/\s+/).filter(Boolean))

/** Attributes that identify one particular element (as opposed to `type` or `role`, which describe a kind). */
const IDENTITY_ATTRS = ['id', 'name', 'data-testid', 'placeholder', 'href', 'aria-label', 'alt', 'title', 'value']

/**
 * Does `live` carry over anything that identifies the stored element? Tag, element type, ancestor
 * path, position and size are shared by whatever happens to sit in the same spot, so they do not count.
 *
 * - A text element *is* its text: a different message in the same place is a different element
 *   (otherwise "Your reservation is confirmed" heals onto "Payment failed").
 * - Anything else needs its text, its label, an identifying attribute or its classes to survive.
 *   A renamed button that kept its styling still qualifies; an unrelated button in its place does not.
 * - A stored fingerprint with none of these has nothing to compare, so only the score decides.
 */
export function sameIdentity(stored: Fingerprint, live: Fingerprint): boolean {
  if (stored.type === 'text' && stored.text) return textSimilarity(stored.text, live.text) >= IDENTITY_MIN_SCORE
  const evidence: number[] = []
  if (stored.text) evidence.push(textSimilarity(stored.text, live.text))
  if (stored.label) evidence.push(textSimilarity(stored.label, live.label))
  for (const name of IDENTITY_ATTRS) {
    const value = stored.attrs[name]
    if (value) evidence.push(attrSimilarity(name, value, live.attrs[name]))
  }
  if (stored.attrs.class) evidence.push(classSimilarity(stored.attrs.class, live.attrs.class))
  return evidence.length === 0 || Math.max(...evidence) >= IDENTITY_MIN_SCORE
}

/**
 * Weighted similarity (0..1) between a stored fingerprint and a live element. Only features
 * the stored fingerprint actually has take part, so an input without text is not penalised for it.
 * Returns 0 for incompatible element types and for elements that fail `sameIdentity`.
 */
export function similarity(stored: Fingerprint, live: Fingerprint): number {
  const compat = typeCompatibility(stored.type, live.type)
  if (compat === 0 || !sameIdentity(stored, live)) return 0
  let total = 0
  let weight = 0
  const add = (w: number, s: number) => {
    total += w * s
    weight += w
  }

  if (stored.text) add(3, textSimilarity(stored.text, live.text))
  if (stored.label) add(3, textSimilarity(stored.label, live.label))
  for (const [name, w] of Object.entries(ATTR_WEIGHTS)) {
    const value = stored.attrs[name]
    if (value) add(w, attrSimilarity(name, value, live.attrs[name]))
  }
  if (stored.attrs.class) add(1.5, classSimilarity(stored.attrs.class, live.attrs.class))
  add(1, stored.tag === live.tag ? 1 : 0)
  add(1, compat)
  add(1.5, pathSimilarity(stored.path, live.path))

  const a = stored.box
  const b = live.box
  const distance = Math.hypot(a.x + a.w / 2 - (b.x + b.w / 2), a.y + a.h / 2 - (b.y + b.h / 2))
  add(1.5, Math.max(0, 1 - distance / 800))
  const ratio = (p: number, q: number) => (Math.max(p, q) > 0 ? Math.min(p, q) / Math.max(p, q) : 1)
  add(0.5, (ratio(a.w, b.w) + ratio(a.h, b.h)) / 2)

  return weight ? total / weight : 0
}

export interface Replacement {
  element: UiElement
  /** Fingerprint similarity between the stored element and the replacement, whichever way it was found. */
  score: number
  via: 'candidate' | 'fingerprint'
  pageWidth: number
  pageHeight: number
}

export interface HealMiss {
  /** Why nothing was accepted; goes to the run log. */
  reason: string
}

const sameLocator = (a: Locator, b: Locator) => a.key === b.key && a.value === b.value

/**
 * Fallback locators that name the element (id, test id, name, label, text, href, class) are trusted
 * to find it again. `tag[type=...]` and positional XPaths only say "the n-th thing of this kind":
 * whatever replaced the element matches them too, so those are left to the fingerprint comparison.
 */
export function isSpecificLocator(l: Locator): boolean {
  if (l.key === 'id') return true
  if (l.key === 'css') return !/^[a-z][a-z0-9-]*\[type=[^\]]*\]$/i.test(l.value)
  return !l.value.startsWith('(') && /(text\(\)|normalize-space\(\))\s*=/.test(l.value)
}

/**
 * Looks for the element `target` used to describe. `broken` is the locator that just failed
 * (it is skipped when trying the stored fallbacks).
 *
 * A stored fallback locator is accepted when it is specific, still matches exactly one element and
 * that element passes the same similarity threshold as a fingerprint match. Otherwise every element
 * on the page is ranked by fingerprint similarity and the best one must win by a clear margin.
 */
export async function findReplacement(page: Page, target: ElementRef, broken: Locator): Promise<Replacement | HealMiss> {
  const fallbacks = target.candidates.filter((c) => isSpecificLocator(c) && !sameLocator(c, broken) && !sameLocator(c, target.locator))
  const result = await scan(page, { max: HEAL_SCAN_LIMIT, probes: fallbacks })
  const size = { pageWidth: result.width, pageHeight: result.height }

  for (let i = 0; i < fallbacks.length; i++) {
    const hit = result.probes[i]
    if (!hit || hit.index < 0) continue
    const element = result.elements[hit.index]
    if (!element.locators.length) continue
    const score = similarity(target.fingerprint, element.fingerprint)
    if (score >= HEAL_MIN_SCORE) return { element, score: Math.round(score * 1000) / 1000, via: 'candidate', ...size }
  }

  const ranked = result.elements
    .filter((element) => element.locators.length > 0)
    .map((element) => ({ element, score: similarity(target.fingerprint, element.fingerprint) }))
    .filter((r) => r.score > 0)
    .sort((x, y) => y.score - x.score)
  const best = ranked[0]
  if (!best) return { reason: 'no element on the page has a compatible type and a matching text, label or attribute' }
  const runnerUp = ranked[1]?.score ?? 0
  const shown = best.score.toFixed(2)
  if (best.score < HEAL_MIN_SCORE) return { reason: `best match ${best.element.name} scored ${shown}, below ${HEAL_MIN_SCORE}` }
  if (best.score - runnerUp < HEAL_MIN_MARGIN) {
    return { reason: `ambiguous: ${best.element.name} scored ${shown} but the runner-up scored ${runnerUp.toFixed(2)}` }
  }
  return { element: best.element, score: Math.round(best.score * 1000) / 1000, via: 'fingerprint', ...size }
}
