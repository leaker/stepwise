import { useEffect, useState } from 'react'

/** Re-render once a second while `active` (for live durations). */
export function useTick(active: boolean): void {
  const [, set] = useState(0)
  useEffect(() => {
    if (!active) return
    const t = window.setInterval(() => set((n) => n + 1), 1000)
    return () => window.clearInterval(t)
  }, [active])
}
