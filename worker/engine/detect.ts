// Element detection. `scanPage` runs inside the browser page, so it must stay fully
// self-contained: no references to module scope, no imports, no DOM lib types
// (the Worker tsconfig may not include them, hence the `any` handles).
import type { Page } from '@cloudflare/playwright'
import type { Locator, UiElement } from '../../shared/types'
import type { Capture } from './index'

export interface ScanArgs {
  /** Maximum number of elements to return (interactive elements win over plain text). */
  max: number
  /** Locators to resolve in the same pass; a uniquely matched element is always included in the result. */
  probes: Locator[]
}

export interface ScanResult {
  url: string
  title: string
  width: number
  height: number
  elements: UiElement[]
  /** One entry per probe: how many nodes it matched and, when exactly one, its index in `elements` (-1 otherwise). */
  probes: { count: number; index: number }[]
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function scanPage(args: ScanArgs): ScanResult {
  const win: any = globalThis
  const doc: any = win.document
  const sx: number = win.scrollX || 0
  const sy: number = win.scrollY || 0

  const norm = (s: unknown): string =>
    String(s ?? '')
      .replace(/\s+/g, ' ')
      .trim()
  const attr = (el: any, name: string): string => norm(el.getAttribute(name))
  const tagOf = (el: any): string => String(el.tagName || '').toLowerCase()
  const cut = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s)

  const INLINE = new Set(['b', 'i', 'em', 'strong', 'span', 'small', 'br', 'code', 'mark', 'u', 'sup', 'sub', 'abbr', 'time', 'wbr'])
  const TEXT_TAGS = new Set([
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'span', 'td', 'th', 'li', 'div', 'dt', 'dd', 'label', 'strong', 'em', 'b', 'small',
    'legend', 'caption', 'figcaption', 'blockquote', 'output', 'time', 'code', 'pre', 'address', 'summary',
  ])
  const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'option', 'optgroup'])
  const INTERACTIVE_SEL =
    'a[href],button,input:not([type=hidden]),select,textarea,img[alt],[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=textbox]'
  const BUTTON_INPUTS = new Set(['submit', 'button', 'reset', 'image'])
  const SUFFIX: Record<string, string> = {
    button: 'button',
    link: 'link',
    input: 'input area',
    textarea: 'text area',
    checkbox: 'checkbox',
    radio: 'radio button',
    select: 'combo box',
    image: 'image',
    text: 'text',
    other: 'element',
  }

  const typeOf = (el: any): string | null => {
    const tag = tagOf(el)
    const role = attr(el, 'role').toLowerCase()
    if (tag === 'input') {
      const t = (attr(el, 'type') || 'text').toLowerCase()
      if (t === 'hidden') return null
      if (t === 'checkbox') return 'checkbox'
      if (t === 'radio') return 'radio'
      if (BUTTON_INPUTS.has(t)) return 'button'
      if (t === 'file' || t === 'range' || t === 'color') return 'other'
      return 'input'
    }
    if (tag === 'textarea') return 'textarea'
    if (tag === 'select') return 'select'
    if (tag === 'button') return 'button'
    if (role === 'button' || role === 'tab' || role === 'menuitem') return 'button'
    if (role === 'checkbox' || role === 'switch') return 'checkbox'
    if (role === 'radio') return 'radio'
    if (role === 'textbox') return 'input'
    if (tag === 'a' && el.hasAttribute('href')) return 'link'
    if (role === 'link') return 'link'
    if (tag === 'img') return attr(el, 'alt') ? 'image' : null
    if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) return 'textarea'
    return null
  }

  const isVisible = (el: any): boolean => {
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return false
    if (r.right + sx <= 0 || r.bottom + sy <= 0) return false
    const cs = win.getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility !== 'visible' || parseFloat(cs.opacity) === 0) return false
    if (typeof el.checkVisibility === 'function') {
      try {
        if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false
      } catch {
        // Older engines: fall through, the checks above are good enough.
      }
    }
    return true
  }

  /** Text of a node without the content of nested form controls (a wrapping label must not include its select's options). */
  const textOutsideControls = (node: any): string => {
    let out = ''
    const stack: any[] = [node]
    while (stack.length) {
      const n = stack.pop()
      if (n.nodeType === 3) out += n.nodeValue
      else if (n.nodeType === 1) {
        const t = tagOf(n)
        if (n !== node && (t === 'select' || t === 'textarea' || t === 'button' || t === 'script' || t === 'style')) continue
        for (let i = n.childNodes.length - 1; i >= 0; i--) stack.push(n.childNodes[i])
      } else if (n.childNodes) {
        for (let i = n.childNodes.length - 1; i >= 0; i--) stack.push(n.childNodes[i])
      }
    }
    return norm(out)
  }

  const labelFor = (el: any): string => {
    const ids = attr(el, 'aria-labelledby')
    if (ids) {
      const parts: string[] = []
      for (const id of ids.split(' ')) {
        const ref = doc.getElementById(id)
        if (ref) parts.push(textOutsideControls(ref))
      }
      const joined = norm(parts.join(' '))
      if (joined) return joined
    }
    if (el.labels && el.labels.length) return textOutsideControls(el.labels[0])
    const wrap = typeof el.closest === 'function' ? el.closest('label') : null
    return wrap && wrap !== el ? textOutsideControls(wrap) : ''
  }

  const labelIsAssociated = (label: any): boolean => {
    if (label.control) return true
    const target = attr(label, 'for')
    if (target && doc.getElementById(target)) return true
    return !!label.querySelector('input,select,textarea')
  }

  const visibleText = (el: any): string => norm(typeof el.innerText === 'string' ? el.innerText : el.textContent)

  const ownText = (el: any, type: string): string => {
    const tag = tagOf(el)
    if (tag === 'input') {
      if (type !== 'button') return ''
      const t = attr(el, 'type').toLowerCase()
      return attr(el, 'value') || (t === 'submit' ? 'Submit' : t === 'reset' ? 'Reset' : '')
    }
    if (type === 'input' || type === 'textarea' || type === 'select' || type === 'checkbox' || type === 'radio' || type === 'image') return ''
    const text = visibleText(el)
    if (text) return text
    const img = el.querySelector ? el.querySelector('img[alt]') : null
    return img ? attr(img, 'alt') : ''
  }

  const isTextCandidate = (el: any, tag: string): boolean => {
    const role = attr(el, 'role').toLowerCase()
    if (role === 'alert' || role === 'status') return visibleText(el) !== ''
    if (!TEXT_TAGS.has(tag)) return false
    const text = visibleText(el)
    if (!text || text.length > 120) return false
    if (el.querySelector(INTERACTIVE_SEL)) return false
    if (/^h[1-6]$/.test(tag)) return true
    let own = false
    for (const child of el.childNodes) {
      if (child.nodeType === 3 && norm(child.nodeValue)) own = true
      else if (child.nodeType === 1 && !INLINE.has(tagOf(child))) return false
    }
    return own
  }

  // ---- locators ----
  const cssQuote = (s: string): string => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
  const xpathLiteral = (s: string): string => {
    if (!s.includes("'")) return "'" + s + "'"
    if (!s.includes('"')) return '"' + s + '"'
    return 'concat(' + s.split("'").map((part) => "'" + part + "'").join(', "\'", ') + ')'
  }
  const cssAll = (sel: string): any[] => {
    try {
      return Array.from(doc.querySelectorAll(sel))
    } catch {
      return []
    }
  }
  const xpathAll = (expr: string): any[] => {
    try {
      const snap = doc.evaluate(expr, doc, null, 7, null)
      const out: any[] = []
      for (let i = 0; i < snap.snapshotLength; i++) out.push(snap.snapshotItem(i))
      return out
    } catch {
      return []
    }
  }
  const resolve = (l: Locator): any[] => (l.key === 'xpath' ? xpathAll(l.value) : cssAll(l.key === 'id' ? '[id=' + cssQuote(l.value) + ']' : l.value))

  const looksGenerated = (s: string): boolean => {
    if (/\d{3,}/.test(s) || /^\d/.test(s) || /[:.\s]/.test(s)) return true
    if (/^[a-f0-9]{8,}$/i.test(s)) return true
    const last = s.split(/[-_]/).pop() || ''
    return last.length >= 6 && (last.match(/\d/g) || []).length >= 2 && /[a-z]/i.test(last)
  }
  const STATE_CLASS = /^(active|selected|open|opened|closed|show|shown|hidden|hide|disabled|enabled|focus|focused|hover|current|checked|loading|visible|is-.*|has-.*)$/i
  const stableClasses = (el: any): string[] => {
    const out: string[] = []
    const raw = typeof el.className === 'string' ? el.className : attr(el, 'class')
    for (const c of raw.split(/\s+/)) {
      if (c && /^[A-Za-z_][\w-]*$/.test(c) && !looksGenerated(c) && !STATE_CLASS.test(c) && !out.includes(c)) out.push(c)
    }
    return out
  }
  const absolutePath = (el: any): string => {
    const parts: string[] = []
    for (let n = el; n && n.nodeType === 1 && n !== doc.documentElement; n = n.parentElement) {
      const tag = tagOf(n)
      let index = 1
      let twins = false
      for (let s = n.previousElementSibling; s; s = s.previousElementSibling) if (tagOf(s) === tag) index++
      for (let s = n.nextElementSibling; s && !twins; s = s.nextElementSibling) if (tagOf(s) === tag) twins = true
      parts.unshift(index > 1 || twins ? tag + '[' + index + ']' : tag)
    }
    return '/html/' + parts.join('/')
  }

  const locatorsFor = (el: any, type: string): Locator[] => {
    const out: Locator[] = []
    const seen = new Set<string>()
    const push = (key: Locator['key'], value: string): void => {
      const k = key + '=' + value
      if (seen.has(k)) return
      seen.add(k)
      out.push({ key, value })
    }
    const tryCss = (sel: string): boolean => {
      if (out.length >= 8) return false
      const hits = cssAll(sel)
      if (hits.length !== 1 || hits[0] !== el) return false
      push('css', sel)
      return true
    }
    const tryXpath = (expr: string, force?: boolean): boolean => {
      if (out.length >= 8 && !force) return false
      const hits = xpathAll(expr)
      if (hits.length !== 1 || hits[0] !== el) return false
      push('xpath', expr)
      return true
    }
    const tag = tagOf(el)

    const id = attr(el, 'id')
    if (id && id.length <= 30 && !looksGenerated(id)) {
      const hits = cssAll('[id=' + cssQuote(id) + ']')
      if (hits.length === 1 && hits[0] === el) push('id', id)
    }
    for (const name of ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy']) {
      const v = attr(el, name)
      if (v) tryCss(tag + '[' + name + '=' + cssQuote(v) + ']')
    }
    const nameAttr = attr(el, 'name')
    if (nameAttr && !looksGenerated(nameAttr)) {
      const value = attr(el, 'value')
      if (!tryCss(tag + '[name=' + cssQuote(nameAttr) + ']') && (type === 'radio' || type === 'checkbox') && value) {
        tryCss(tag + '[name=' + cssQuote(nameAttr) + '][value=' + cssQuote(value) + ']')
      }
    }
    for (const name of ['aria-label', 'placeholder']) {
      const v = attr(el, name)
      if (v && v.length <= 80) tryCss(tag + '[' + name + '=' + cssQuote(el.getAttribute(name)) + ']')
    }
    const typeAttr = attr(el, 'type')
    if (typeAttr && (tag === 'input' || tag === 'button')) tryCss(tag + '[type=' + cssQuote(typeAttr) + ']')

    // Text based XPath. Numbers in plain text are usually volatile (prices, counters), so those rank last.
    const text = tag === 'input' || tag === 'select' || tag === 'textarea' || type === 'image' ? '' : norm(el.textContent)
    const usableText = text.length > 0 && text.length <= 80
    const volatile = type === 'text' && /\d/.test(text)
    const single = el.childNodes.length === 1 && el.childNodes[0].nodeType === 3 && el.childNodes[0].nodeValue === text
    const textExpr = '//' + tag + '[' + (single ? 'text()' : 'normalize-space()') + '=' + xpathLiteral(text) + ']'
    let textUnique = false
    if (usableText && !volatile) textUnique = tryXpath(textExpr)

    if (type === 'link') {
      const href = attr(el, 'href')
      if (href && href.length <= 120 && !/^javascript:/i.test(href)) tryCss(tag + '[href=' + cssQuote(el.getAttribute('href')) + ']')
    }
    for (const name of ['alt', 'title']) {
      const v = attr(el, name)
      if (v && v.length <= 80) tryCss(tag + '[' + name + '=' + cssQuote(el.getAttribute(name)) + ']')
    }

    const classes = stableClasses(el)
    for (const c of classes) tryCss(tag + '.' + c)
    if (classes.length > 1) tryCss(tag + '.' + classes.join('.'))
    for (let p = el.parentElement; p && p !== doc.body; p = p.parentElement) {
      const pid = attr(p, 'id')
      if (!pid || pid.length > 30 || looksGenerated(pid) || !/^[A-Za-z][\w-]*$/.test(pid) || cssAll('#' + pid).length !== 1) continue
      if (!(classes.length && tryCss('#' + pid + ' ' + tag + '.' + classes[0]))) tryCss('#' + pid + ' ' + tag)
      break
    }

    if (usableText && !textUnique) {
      if (volatile) tryXpath(textExpr)
      const twins = xpathAll(textExpr)
      const at = twins.indexOf(el)
      if (at >= 0 && twins.length > 1) tryXpath('(' + textExpr + ')[' + (at + 1) + ']')
    }

    // Positional fallback: always resolves, least stable.
    const base = classes.length ? '//' + tag + '[contains(@class,' + xpathLiteral(classes[0]) + ')]' : '//' + tag
    const group = xpathAll(base)
    const at = group.indexOf(el)
    let anchored = false
    if (at >= 0) anchored = tryXpath(group.length === 1 ? base : '(' + base + ')[' + (at + 1) + ']', true)
    if (!anchored && !out.length) {
      const path = absolutePath(el)
      if (!tryXpath(path, true)) push('xpath', path)
    }
    return out
  }

  // ---- element description ----
  const FP_ATTRS = ['id', 'name', 'class', 'href', 'placeholder', 'aria-label', 'role', 'type', 'data-testid', 'alt', 'title']
  const describe = (el: any, type: string): UiElement => {
    const tag = tagOf(el)
    const r = el.getBoundingClientRect()
    const box = { x: Math.round(r.left + sx), y: Math.round(r.top + sy), w: Math.round(r.width), h: Math.round(r.height) }
    const control = type === 'input' || type === 'textarea' || type === 'checkbox' || type === 'radio' || type === 'select'
    const aria = attr(el, 'aria-label')
    const associated = control || type === 'button' ? labelFor(el) : ''
    const placeholder = attr(el, 'placeholder')
    const text = ownText(el, type)
    const label = aria || associated || placeholder || text || attr(el, 'name') || attr(el, 'alt') || attr(el, 'title')
    const fallback = tag === 'input' ? attr(el, 'type') || 'text' : ''
    const shown = cut(label || fallback, 60)
    const name = shown ? '"' + shown + '" ' + SUFFIX[type] : 'Unnamed ' + SUFFIX[type]

    const attrs: Record<string, string> = {}
    for (const a of FP_ATTRS) {
      const v = attr(el, a)
      if (v) attrs[a] = v.slice(0, 200)
    }
    if (type === 'button' && attr(el, 'value')) attrs.value = attr(el, 'value').slice(0, 200)
    const path: string[] = []
    for (let n = el; n && n.nodeType === 1 && n !== doc.documentElement; n = n.parentElement) path.unshift(tagOf(n))

    return {
      id: '',
      name,
      type: type as UiElement['type'],
      box,
      locators: locatorsFor(el, type),
      fingerprint: {
        tag,
        type: type as UiElement['type'],
        text: text.slice(0, 120),
        label: (control ? aria || associated || placeholder : aria || attr(el, 'title')).slice(0, 120),
        attrs,
        path: path.join('>'),
        box,
      },
    }
  }

  // ---- walk ----
  const picked: { el: any; type: string }[] = []
  const blockAll = new WeakSet<object>()
  const blockText = new WeakSet<object>()
  const all: any[] = doc.body ? Array.from(doc.body.querySelectorAll('*')) : []
  for (const el of all) {
    const tag = tagOf(el)
    if (SKIP_TAGS.has(tag)) continue
    let insideControl = false
    let insideText = false
    for (let p = el.parentElement; p && p !== doc.body; p = p.parentElement) {
      if (blockAll.has(p)) {
        insideControl = true
        break
      }
      if (blockText.has(p)) insideText = true
    }
    if (insideControl) continue
    const type = typeOf(el)
    if (type) {
      blockAll.add(el)
      if (isVisible(el)) picked.push({ el, type })
      continue
    }
    if (tag === 'svg') {
      blockAll.add(el)
      continue
    }
    if (tag === 'label' && labelIsAssociated(el)) {
      blockText.add(el)
      continue
    }
    if (insideText) continue
    if (isTextCandidate(el, tag)) {
      blockText.add(el)
      if (isVisible(el)) picked.push({ el, type: 'text' })
    }
  }

  let kept = picked
  if (picked.length > args.max) {
    const controls = picked.filter((p) => p.type !== 'text').length
    let room = Math.max(0, args.max - controls)
    let quota = args.max
    kept = picked.filter((p) => {
      if (quota <= 0) return false
      if (p.type === 'text') {
        if (room <= 0) return false
        room--
      }
      quota--
      return true
    })
  }

  const elements: UiElement[] = []
  const indexOf = new Map<any, number>()
  for (const p of kept) {
    indexOf.set(p.el, elements.length)
    elements.push(describe(p.el, p.type))
  }
  const probes = args.probes.map((probe) => {
    const hits = resolve(probe)
    if (hits.length !== 1) return { count: hits.length, index: -1 }
    const el = hits[0]
    let index = indexOf.get(el)
    if (index === undefined) {
      if (!el || el.nodeType !== 1 || !isVisible(el)) return { count: 1, index: -1 }
      index = elements.length
      indexOf.set(el, index)
      elements.push(describe(el, typeOf(el) || (isTextCandidate(el, tagOf(el)) ? 'text' : 'other')))
    }
    return { count: 1, index }
  })
  elements.forEach((e, i) => {
    e.id = 'e' + (i + 1)
  })

  const de = doc.documentElement
  const body = doc.body || de
  return {
    url: String(win.location.href),
    title: String(doc.title || ''),
    width: Math.max(body.scrollWidth, de.scrollWidth, body.offsetWidth, de.offsetWidth, body.clientWidth, de.clientWidth),
    height: Math.max(body.scrollHeight, de.scrollHeight, body.offsetHeight, de.offsetHeight, body.clientHeight, de.clientHeight),
    elements,
    probes,
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Runs `scanPage` in the page. The function is shipped as source text with a no-op `__name`
 * shim, because bundlers that keep function names (esbuild/wrangler) wrap inner functions in
 * a `__name(...)` helper that does not exist inside the page.
 */
export async function scan(page: Page, args: ScanArgs): Promise<ScanResult> {
  const source = `(() => { const __name = (f) => f; return (${scanPage.toString()})(${JSON.stringify(args)}); })()`
  return (await page.evaluate(source)) as ScanResult
}

export const CAPTURE_MAX_ELEMENTS = 300

export async function captureUi(page: Page): Promise<Capture> {
  await page.waitForLoadState('load', { timeout: 15_000 }).catch(() => {})
  const result = await scan(page, { max: CAPTURE_MAX_ELEMENTS, probes: [] })
  const shot = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 70, animations: 'disabled' })
  return {
    url: result.url,
    title: result.title,
    width: result.width,
    height: result.height,
    screenshot: new Uint8Array(shot.buffer, shot.byteOffset, shot.byteLength),
    elements: result.elements,
  }
}
