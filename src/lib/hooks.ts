import { useEffect, useLayoutEffect, useRef, useState } from 'react'

/** Re-render once a second while `active` (for live durations). */
export function useTick(active: boolean): void {
  const [, set] = useState(0)
  useEffect(() => {
    if (!active) return
    const t = window.setInterval(() => set((n) => n + 1), 1000)
    return () => window.clearInterval(t)
  }, [active])
}

/**
 * True while an input method editor is composing text (Chinese, Japanese, Korean, ...). The Enter or Escape
 * that confirms or cancels a conversion must not also submit or dismiss. `keyCode` 229 covers Safari, which
 * reports `isComposing: false` on the confirming keydown.
 */
export function isComposing(e: KeyboardEvent | { nativeEvent: KeyboardEvent }): boolean {
  const ev = 'nativeEvent' in e ? e.nativeEvent : e
  return ev.isComposing || ev.keyCode === 229
}

/**
 * Opens a `<dialog>` as a modal for as long as the component is mounted. The browser provides the top layer,
 * the inert page, focus containment, Escape / back-gesture dismissal and the return of focus; `onClose` is
 * called for every way of dismissing it, and the owner unmounts the dialog in response.
 */
// Safari on macOS does not focus a button that is clicked, so a dialog opened with the mouse has no invoker to
// hand focus back to and it lands on <body>. The last control pressed is remembered for that case.
let lastPressed: HTMLElement | null = null
if (typeof document !== 'undefined') {
  document.addEventListener(
    'pointerdown',
    (e) => {
      lastPressed = e.target instanceof Element ? e.target.closest<HTMLElement>('button, a[href], [tabindex]') : null
    },
    true,
  )
}

export function useModalDialog(onClose: () => void, initialFocus?: (el: HTMLDialogElement) => HTMLElement | null | undefined) {
  const ref = useRef<HTMLDialogElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const focusRef = useRef(initialFocus)
  focusRef.current = initialFocus

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const active = document.activeElement
    const invoker = active instanceof HTMLElement && active !== document.body ? active : lastPressed
    if (!el.open) el.showModal()
    focusRef.current?.(el)?.focus()

    // Fired by Escape, the back gesture and (with closedby="any") a press on the backdrop.
    // An owner may decline to close (a request of the dialog is still under way). The browser has closed the
    // element all the same, and it would stay mounted but invisible: its buttons dead, and every message of
    // the app drawn inside it. So a dialog that is still there a moment later is opened again.
    let reopen = 0
    const onClosed = () => {
      if (el.open) return
      closeRef.current()
      window.clearTimeout(reopen)
      reopen = window.setTimeout(() => {
        if (!el.isConnected || el.open) return
        el.showModal()
        focusRef.current?.(el)?.focus()
      }, 60)
    }
    el.addEventListener('close', onClosed)

    // Light dismiss where `closedby` is missing (Safari): a press and release outside the dialog's box.
    let pressedOutside = false
    const outside = (e: PointerEvent) => {
      const r = el.getBoundingClientRect()
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom
    }
    const onDown = (e: PointerEvent) => {
      pressedOutside = e.target === el && outside(e)
    }
    const onUp = (e: PointerEvent) => {
      if (pressedOutside && e.target === el && outside(e)) closeRef.current()
      pressedOutside = false
    }
    const needsFallback = el.getAttribute('closedby') === 'any' && !('closedBy' in HTMLDialogElement.prototype)
    if (needsFallback) {
      el.addEventListener('pointerdown', onDown)
      el.addEventListener('pointerup', onUp)
    }
    return () => {
      window.clearTimeout(reopen)
      el.removeEventListener('close', onClosed)
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointerup', onUp)
      // Closing before React removes the node is what hands focus back to the invoker.
      if (el.open) el.close()
      // WebKit can also leave focus on a control of the closed dialog, which is about to be removed.
      const now = document.activeElement
      if (invoker?.isConnected && (now === document.body || el.contains(now))) invoker.focus()
    }
  }, [])
  return ref
}
