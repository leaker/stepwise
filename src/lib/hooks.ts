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
export function useModalDialog(onClose: () => void, initialFocus?: (el: HTMLDialogElement) => HTMLElement | null | undefined) {
  const ref = useRef<HTMLDialogElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const focusRef = useRef(initialFocus)
  focusRef.current = initialFocus

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    if (!el.open) el.showModal()
    focusRef.current?.(el)?.focus()

    // Fired by Escape, the back gesture and (with closedby="any") a press on the backdrop.
    const onClosed = () => {
      if (!el.open) closeRef.current()
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
      el.removeEventListener('close', onClosed)
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointerup', onUp)
      // Closing before React removes the node is what hands focus back to the invoker.
      if (el.open) el.close()
    }
  }, [])
  return ref
}
