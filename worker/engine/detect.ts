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
  /**
   * Leave out elements that lie under an overlay (an open menu drawer, a dialog and its backdrop, a
   * sticky bar). Captures use this: such an element cannot be pointed at on the screenshot and a click
   * on it would hit the overlay. Only elements inside the viewport can be judged; the rest are kept.
   */
  skipCovered?: boolean
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
  /** Controls that may sit inside a sentence ("Total: $120, see <a>terms</a>") without breaking it up. */
  const INLINE_CONTROLS = new Set(['a', 'button', 'img', 'input', 'select'])
  /** Children a clickable leaf (icon button built from a div or span) may have. */
  const ICON_TAGS = new Set(['i', 'img', 'svg', 'picture'])
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

  // Open shadow roots are scanned too. `roots` is filled by the walk below, before any locator is built.
  const roots: any[] = [doc]
  const parentOf = (n: any): any => n.parentElement || (n.parentNode && n.parentNode.host) || null
  const inShadow = (el: any): boolean => typeof el.getRootNode === 'function' && el.getRootNode() !== doc

  /**
   * A <div> / <span> that is wired up as a button without saying so: an inline handler, a tab stop,
   * or a pointer cursor of its own. Only leaves qualify (text and icons inside, nothing else), so a
   * clickable card keeps its heading, text and buttons as separate elements.
   */
  const isClickableLeaf = (el: any, tag: string): boolean => {
    if (tag === 'label' || tag === 'body' || tag === 'html' || tag === 'iframe' || !el.getBoundingClientRect) return false
    let hinted = el.hasAttribute('onclick') || (el.hasAttribute('tabindex') && el.tabIndex >= 0)
    if (!hinted) {
      if (win.getComputedStyle(el).cursor !== 'pointer') return false
      const parent = parentOf(el)
      hinted = !parent || win.getComputedStyle(parent).cursor !== 'pointer'
    }
    if (!hinted || el.shadowRoot || el.querySelector(INTERACTIVE_SEL)) return false
    for (const d of el.querySelectorAll('*')) {
      const t = tagOf(d)
      if (!INLINE.has(t) && !ICON_TAGS.has(t) && !(d.closest && d.closest('svg'))) return false
    }
    return true
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
    if (tag !== 'svg' && isClickableLeaf(el, tag)) return 'other'
    return null
  }

  /** `ownOpacity: false` ignores the element's own `opacity: 0` (an invisible control that still takes clicks). */
  const isVisible = (el: any, ownOpacity = true): boolean => {
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return false
    if (r.right + sx <= 0 || r.bottom + sy <= 0) return false
    const cs = win.getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility !== 'visible') return false
    if (ownOpacity && parseFloat(cs.opacity) === 0) return false
    if (typeof el.checkVisibility === 'function') {
      try {
        if (!el.checkVisibility({ checkOpacity: ownOpacity, checkVisibilityCSS: true })) return false
      } catch {
        // Older engines: fall through, the checks above are good enough.
      }
    }
    if (!ownOpacity) {
      for (let p = parentOf(el); p; p = parentOf(p)) if (parseFloat(win.getComputedStyle(p).opacity) === 0) return false
    }
    return true
  }

  /**
   * The node whose rectangle stands for `el` on the screenshot, or null when there is nothing to show.
   * Custom checkboxes, radio buttons and switches usually hide the native input (opacity 0, a
   * clipped pixel, display none) and draw the control with its label: the input is still the
   * element a test acts on, so it is reported at the label's position.
   */
  const shownAs = (el: any, type: string): any => {
    if (isVisible(el)) return el
    if ((type !== 'checkbox' && type !== 'radio') || tagOf(el) !== 'input') return null
    const label = (el.labels && el.labels[0]) || (typeof el.closest === 'function' ? el.closest('label') : null)
    if (label && isVisible(label)) return label
    return isVisible(el, false) ? el : null
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
    if (wrap && wrap !== el) return textOutsideControls(wrap)
    // <input type=checkbox><label>Buy milk</label>: a label that is only placed next to its control.
    const t = tagOf(el) === 'input' ? attr(el, 'type').toLowerCase() : ''
    if (t === 'checkbox' || t === 'radio') {
      for (const near of [el.nextElementSibling, el.previousElementSibling]) {
        if (near && tagOf(near) === 'label' && !near.control) return textOutsideControls(near)
      }
    }
    return ''
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

  const hasControls = (el: any): boolean => !!el.querySelector(INTERACTIVE_SEL)

  const isTextCandidate = (el: any, tag: string): boolean => {
    const role = attr(el, 'role').toLowerCase()
    if (role === 'alert' || role === 'status') return visibleText(el) !== ''
    if (!TEXT_TAGS.has(tag)) return false
    if (!visibleText(el)) return false
    // A sentence with a link or a control in it is still one text, as long as it has words of its own.
    const mixed = hasControls(el)
    if (!mixed && /^h[1-6]$/.test(tag)) return true
    let own = false
    for (const child of el.childNodes) {
      if (child.nodeType === 3 && norm(child.nodeValue)) own = true
      else if (child.nodeType === 1) {
        const t = tagOf(child)
        if (!INLINE.has(t) && !(mixed && INLINE_CONTROLS.has(t))) return false
      }
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
  // Playwright's css engine pierces open shadow roots, so "unique" has to mean unique across all of them.
  const cssAll = (sel: string): any[] => {
    try {
      const out: any[] = []
      for (const root of roots) for (const hit of root.querySelectorAll(sel)) out.push(hit)
      return out
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
  const STATE_CLASS = /^(active|selected|open|opened|closed|show|shown|hidden|hide|disabled|enabled|focus|focused|hover|current|checked|loading|visible|today|highlight|highlighted|pressed|expanded|collapsed|is-.*|has-.*|ui-state-.*|.*[-_](active|selected|current|today|hover|focus|focused|highlight|highlighted|checked|disabled|open|expanded|collapsed))$/i
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

    // Text based XPath. Numbers are usually volatile (prices, counters, "3 hours ago"), so a text
    // with digits ranks last, after even the positional fallback.
    const text = tag === 'input' || tag === 'select' || tag === 'textarea' || type === 'image' ? '' : norm(el.textContent)
    const usableText = text.length > 0 && text.length <= 80
    const volatile = /\d/.test(text)
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

    if (usableText && !textUnique && !volatile) {
      const twins = xpathAll(textExpr)
      const at = twins.indexOf(el)
      if (at >= 0 && twins.length > 1) tryXpath('(' + textExpr + ')[' + (at + 1) + ']')
    }

    // tag[type=...] says what kind of control this is, not which one: it is unique only until the
    // page gains a second submit button or email field, so it ranks just above the positional fallback.
    const typeAttr = attr(el, 'type')
    if (typeAttr && (tag === 'input' || tag === 'button')) tryCss(tag + '[type=' + cssQuote(typeAttr) + ']')

    // XPath does not reach into shadow roots: an element in one keeps its CSS locators only.
    if (inShadow(el)) return out

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
    if (usableText && volatile) tryXpath(textExpr, true)
    return out
  }

  // ---- element description ----
  const FP_ATTRS = ['id', 'name', 'class', 'href', 'placeholder', 'aria-label', 'role', 'type', 'data-testid', 'alt', 'title']
  /** Name of last resort for icon-only controls: a tooltip or accessible name on something inside. */
  const innerName = (el: any): string => {
    const named = el.querySelector ? el.querySelector('[aria-label],[title]') : null
    if (named) return attr(named, 'aria-label') || attr(named, 'title')
    const svgTitle = el.querySelector ? el.querySelector('svg > title') : null
    return svgTitle ? norm(svgTitle.textContent) : ''
  }

  const describe = (el: any, type: string, shown: any): UiElement => {
    const tag = tagOf(el)
    const r = shown.getBoundingClientRect()
    const box = { x: Math.round(r.left + sx), y: Math.round(r.top + sy), w: Math.round(r.width), h: Math.round(r.height) }
    const control = type === 'input' || type === 'textarea' || type === 'checkbox' || type === 'radio' || type === 'select'
    const aria = attr(el, 'aria-label')
    const associated = control || type === 'button' ? labelFor(el) : ''
    const placeholder = attr(el, 'placeholder')
    const text = ownText(el, type)
    const label = aria || associated || placeholder || text || attr(el, 'name') || attr(el, 'alt') || attr(el, 'title') || (control ? '' : innerName(el))
    const fallback = tag === 'input' ? attr(el, 'type') || 'text' : ''
    const title = cut(label || fallback, 60)
    const name = title ? '"' + title + '" ' + SUFFIX[type] : 'Unnamed ' + SUFFIX[type]

    const attrs: Record<string, string> = {}
    for (const a of FP_ATTRS) {
      const v = attr(el, a)
      if (v) attrs[a] = v.slice(0, 200)
    }
    if (type === 'button' && attr(el, 'value')) attrs.value = attr(el, 'value').slice(0, 200)
    const path: string[] = []
    for (let n = el; n && n.nodeType === 1 && n !== doc.documentElement; n = parentOf(n)) path.unshift(tagOf(n))

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
      ...(tag === 'select' ? { options: Array.prototype.slice.call(el.options || [], 0, 50).map((o: any) => norm(String(o.label || o.textContent || '')).slice(0, 80)) } : {}),
    }
  }

  // ---- walk ----
  let picked: { el: any; type: string; shown: any }[] = []
  const blockAll = new WeakSet<object>()
  const blockText = new WeakSet<object>()
  const consider = (el: any): void => {
    const tag = tagOf(el)
    if (SKIP_TAGS.has(tag)) return
    let insideText = false
    for (let p = parentOf(el); p && p !== doc.body; p = parentOf(p)) {
      if (blockAll.has(p)) return
      if (blockText.has(p)) insideText = true
    }
    const type = typeOf(el)
    if (type) {
      blockAll.add(el)
      const shown = shownAs(el, type)
      if (shown) picked.push({ el, type, shown })
      return
    }
    if (tag === 'svg') {
      blockAll.add(el)
      return
    }
    if (tag === 'label' && labelIsAssociated(el)) {
      blockText.add(el)
      return
    }
    if (insideText) return
    if (isTextCandidate(el, tag)) {
      // A plain text block hides the fragments inside it; one with links or controls in it does
      // not, so "$120" in "Total: <b>$120</b>, see <a>terms</a>" can still be picked on its own.
      if (!hasControls(el)) blockText.add(el)
      if (isVisible(el)) picked.push({ el, type: 'text', shown: el })
    }
  }
  const walk = (root: any): void => {
    for (const el of Array.from(root.querySelectorAll('*')) as any[]) {
      consider(el)
      if (el.shadowRoot && !blockAll.has(el)) {
        roots.push(el.shadowRoot)
        walk(el.shadowRoot)
      }
    }
  }
  if (doc.body) walk(doc.body)

  /**
   * Is the middle of `shown` covered by a positioned layer that the element is not part of? `el` is the
   * element `shown` stands for: a native checkbox laid transparently over its own label (the usual custom
   * checkbox, switch and "checkbox hack" menu toggle) is the control itself, not something in the way.
   */
  const isCovered = (shown: any, el: any): boolean => {
    const r = shown.getBoundingClientRect()
    const x = r.left + r.width / 2
    const y = r.top + r.height / 2
    if (x < 0 || y < 0 || x >= win.innerWidth || y >= win.innerHeight) return false
    let hit = doc.elementFromPoint(x, y)
    while (hit && hit.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(x, y)
      if (!inner || inner === hit) break
      hit = inner
    }
    if (!hit) return false
    const chain = new Set<any>()
    for (let n = shown; n; n = parentOf(n)) chain.add(n)
    // The hit is the element, inside it, or a container of it: nothing is in the way.
    for (let n = hit; n; n = parentOf(n)) if (n === shown || n === el) return false
    if (chain.has(hit)) return false
    const label = typeof hit.closest === 'function' ? hit.closest('label') : null
    if (label && label.control && chain.has(label.control)) return false
    // Something else is there. It only counts as a cover when it is a layer of its own (positioned
    // outside the normal flow), not a neighbour that an oddly shaped box happens to overlap.
    for (let n = hit; n && !chain.has(n); n = parentOf(n)) {
      const position = win.getComputedStyle(n).position
      if (position === 'absolute' || position === 'fixed' || position === 'sticky') return true
    }
    return false
  }
  if (args.skipCovered) picked = picked.filter((p) => !isCovered(p.shown, p.el))

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
    const described = describe(p.el, p.type, p.shown)
    // Only happens inside a shadow root, when no CSS locator is unique: nothing could find it at run time.
    if (!described.locators.length) continue
    indexOf.set(p.el, elements.length)
    elements.push(described)
  }
  const probes = args.probes.map((probe) => {
    const hits = resolve(probe)
    if (hits.length !== 1) return { count: hits.length, index: -1 }
    const el = hits[0]
    let index = indexOf.get(el)
    if (index === undefined) {
      if (!el || el.nodeType !== 1) return { count: 1, index: -1 }
      const type = typeOf(el) || (isTextCandidate(el, tagOf(el)) ? 'text' : 'other')
      const shown = shownAs(el, type)
      if (!shown) return { count: 1, index: -1 }
      index = elements.length
      indexOf.set(el, index)
      elements.push(describe(el, type, shown))
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

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function captureUi(page: Page): Promise<Capture> {
  await page.waitForLoadState('load', { timeout: 15_000 }).catch(() => {})
  const scroll = () => page.evaluate(() => ({ x: (globalThis as any).scrollX || 0, y: (globalThis as any).scrollY || 0 }))
  const before = await scroll()
  // The screenshot comes first: on an emulated phone a full-page screenshot leaves the page scrolled somewhere
  // else, and fixed or sticky elements are drawn where they are at that position. Scanning afterwards, at the
  // position the screenshot left behind, keeps their boxes on the pixels that show them.
  // scale 'css': an emulated phone has a device pixel ratio of 2-3, and the element boxes are in CSS pixels.
  const shot = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 70, animations: 'disabled', scale: 'css' })
  const result = await scan(page, { max: CAPTURE_MAX_ELEMENTS, probes: [], skipCovered: true })
  const after = await scroll()
  // Whoever goes on using the page (a test, a later step) finds it where it was.
  if (after.x !== before.x || after.y !== before.y) {
    await page.evaluate((to: { x: number; y: number }) => (globalThis as any).scrollTo({ left: to.x, top: to.y, behavior: 'instant' }), before).catch(() => {})
  }
  return {
    url: result.url,
    title: result.title,
    width: result.width,
    height: result.height,
    screenshot: new Uint8Array(shot.buffer, shot.byteOffset, shot.byteLength),
    elements: result.elements,
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
