import type { RunStatus, StepStatus } from '../../shared/types'

export const TERMINAL: RunStatus[] = ['succeeded', 'failed', 'unresolved', 'aborted']
export const isTerminal = (s: RunStatus) => TERMINAL.includes(s)

export const STATUS_LABEL: Record<RunStatus | StepStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  unresolved: 'Needs review',
  aborted: 'Aborted',
  passed: 'Passed',
  healed: 'Repaired',
  skipped: 'Skipped',
}

const pad = (n: number) => String(n).padStart(2, '0')

/** HH:MM:SS between two ISO timestamps (to "now" while still running). */
export function clock(start: string | null, end: string | null): string {
  if (!start) return '–'
  const ms = Math.max(0, (end ? Date.parse(end) : Date.now()) - Date.parse(start))
  const s = Math.floor(ms / 1000)
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`
}

/** Like clock(), but short runs read as seconds ("3.2 s") instead of 00:00:03. */
export function duration(start: string | null, end: string | null): string {
  if (!start) return '–'
  const n = Math.max(0, (end ? Date.parse(end) : Date.now()) - Date.parse(start))
  return end && n < 60_000 ? ms(n) : clock(start, end)
}

export function ms(n: number): string {
  if (n < 1000) return `${Math.round(n)} ms`
  return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)} s`
}

const dateFmt = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '–'
  const t = Date.parse(iso)
  return Number.isNaN(t) ? '–' : dateFmt.format(t)
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

export const uid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}
