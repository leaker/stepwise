import {
  AlertTriangle,
  Check,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleMinus,
  CircleX,
  CloudOff,
  Loader2,
  Monitor,
  Smartphone,
  Wrench,
  X,
} from 'lucide-react'
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { deviceOf } from '../../shared/devices'
import type { DeviceId, RunStatus, StepStatus } from '../../shared/types'
import { cx, STATUS_LABEL } from '../lib/format'
import { isComposing, useModalDialog } from '../lib/hooks'

// ---------- Buttons ----------

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
  icon?: ReactNode
  busy?: boolean
}

export function Button({ variant = 'default', size = 'md', icon, busy, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || busy}
      className={cx('btn', `btn-${variant}`, size === 'sm' && 'btn-sm', className)}
    >
      {busy ? <Spinner size={14} /> : icon}
      {children != null && <span className="btn-label">{children}</span>}
    </button>
  )
}

/**
 * An icon-only button. `active` makes it a toggle (aria-pressed, which the pressed look is styled from).
 * `disabled` is rendered as aria-disabled and its clicks are ignored: the button stays focusable, so focus
 * is not thrown to the page when, say, Undo runs out while the keyboard is on it.
 */
export function IconButton({
  label,
  children,
  className,
  active,
  disabled,
  onClick,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      aria-label={label}
      title={rest.title ?? label}
      aria-pressed={active}
      aria-disabled={disabled || undefined}
      onClick={(e) => {
        if (disabled) return e.preventDefault()
        onClick?.(e)
      }}
      className={cx('icon-btn', className)}
    >
      {children}
    </button>
  )
}

export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return <Loader2 size={size} className={cx('spin', className)} aria-hidden />
}

// ---------- Status ----------

/** `decorative` is for places where the status is also written out next to the icon. */
export function StatusIcon({ status, size = 18, decorative = false }: { status: RunStatus | StepStatus; size?: number; decorative?: boolean }) {
  const label = STATUS_LABEL[status]
  const common = decorative ? { size, 'aria-hidden': true as const } : { size, 'aria-label': label, role: 'img' as const }
  switch (status) {
    case 'succeeded':
    case 'passed':
      return <CircleCheck {...common} className="st st-ok" />
    case 'failed':
      return <CircleX {...common} className="st st-fail" />
    case 'unresolved':
      return <CircleAlert {...common} className="st st-review" />
    case 'healed':
      return <Wrench {...common} className="st st-review" />
    case 'aborted':
    case 'skipped':
      return <CircleMinus {...common} className="st st-muted" />
    case 'running':
      return <Loader2 {...common} className="st st-run spin" />
    case 'queued':
      return <CircleDashed {...common} className="st st-muted" />
  }
}

export function StatusText({ status }: { status: RunStatus }) {
  return (
    <span className={cx('status-text', `status-${status}`)}>
      <StatusIcon status={status} size={16} />
      {STATUS_LABEL[status]}
    </span>
  )
}

// ---------- Page scaffolding ----------

export function DeviceIcon({ device, size = 13 }: { device: DeviceId; size?: number }) {
  return deviceOf(device).isMobile ? <Smartphone size={size} aria-hidden /> : <Monitor size={size} aria-hidden />
}

/** Which device profile something was captured or run on. */
export function DeviceChip({ device }: { device: DeviceId }) {
  const d = deviceOf(device)
  return (
    <span className="chip device-chip" title={`${d.label}, ${d.viewport.width} × ${d.viewport.height}${d.isMobile ? ' (emulated phone, touch)' : ''}`}>
      <DeviceIcon device={d.id} />
      {d.label}
    </span>
  )
}

export function Logo() {
  return (
    <Link to="/" className="logo" aria-label="Stepwise, all projects">
      <svg viewBox="0 0 32 32" width="24" height="24" aria-hidden>
        <rect width="32" height="32" rx="7" className="logo-tile" />
        <path d="M7 23h6v-5h6v-5h6" fill="none" className="logo-steps" strokeWidth="3" strokeLinecap="square" />
      </svg>
      <span>Stepwise</span>
    </Link>
  )
}

export interface Crumb {
  label: string
  to?: string
}

export function Shell({ crumbs = [], children }: { crumbs?: Crumb[]; children: ReactNode }) {
  return (
    <div className="shell">
      <header className="topbar">
        <Logo />
        {crumbs.length > 0 && (
          <nav className="crumbs" aria-label="Breadcrumb">
            <ol>
              {crumbs.map((c, i) => (
                <li key={i} className="crumb">
                  {c.to ? (
                    <Link to={c.to} title={c.label}>
                      {c.label}
                    </Link>
                  ) : (
                    <span aria-current="page" title={c.label}>
                      {c.label}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </nav>
        )}
      </header>
      <main className="page">{children}</main>
    </div>
  )
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="state" role="status">
      <Spinner size={20} />
      <span>{label}</span>
    </div>
  )
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="state state-error" role="alert">
      <AlertTriangle size={20} />
      <span>{error instanceof Error ? error.message : 'Something went wrong.'}</span>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  )
}

/** Over content that is on screen while refreshing it fails: the content stays, and this says it may be behind. */
export function StaleNotice({ live }: { live: boolean }) {
  return (
    <div className="banner banner-quiet" role="status">
      <CloudOff size={16} aria-hidden />
      <span>{live ? 'The connection to the server was lost, so this page may be behind. Trying again…' : 'The latest state could not be loaded, so this page may be behind.'}</span>
    </div>
  )
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  )
}

/**
 * The scroll container of a table: when the table is wider than the page it scrolls here, so the container is
 * focusable (arrow keys scroll it) and a named region.
 */
export function TableWrap({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="table-wrap" role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  )
}

/**
 * Arrow keys, Home and End for a `role="tablist"`: one tab stop, and selection follows focus (the WAI-ARIA
 * pattern; `focusgroup` would do this natively but is not yet in Firefox or Safari).
 */
export function onTablistKeyDown(e: React.KeyboardEvent<HTMLElement>) {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return
  const tabs = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]:not([disabled])'))
  const i = tabs.indexOf(document.activeElement as HTMLElement)
  if (i < 0) return
  e.preventDefault()
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
  tabs[next].focus()
  tabs[next].click()
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  children,
}: {
  tabs: { id: T; label: string; count?: number }[]
  value: T
  onChange: (id: T) => void
  /** Accessible name of the tab list. */
  label: string
  /** The selected tab's content; it is rendered as the tab panel. */
  children?: ReactNode
}) {
  const id = useId()
  return (
    <>
      <div className="tabs" role="tablist" aria-label={label} onKeyDown={onTablistKeyDown}>
        {tabs.map((t) => (
          <button
            key={t.id}
            id={`${id}-${t.id}`}
            role="tab"
            type="button"
            aria-selected={t.id === value}
            tabIndex={t.id === value ? 0 : -1}
            className={cx('tab', t.id === value && 'is-active')}
            onClick={() => onChange(t.id)}
          >
            {t.label}
            {t.count != null && <span className="tab-count">{t.count}</span>}
          </button>
        ))}
      </div>
      {children != null && (
        <div role="tabpanel" aria-labelledby={`${id}-${value}`}>
          {children}
        </div>
      )}
    </>
  )
}

// ---------- Dialog ----------

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

/** `closedby` is newer than the React typings; where it is missing, useModalDialog supplies the light dismiss. */
const LIGHT_DISMISS = { closedby: 'any' } as object

// Modal dialogs that are open, innermost last. A toast outside a modal dialog would be inert and hidden from
// assistive technology, so while one is open the innermost dialog shows the messages itself.
let modals: string[] = []
const modalListeners = new Set<() => void>()
const subscribeModals = (l: () => void) => {
  modalListeners.add(l)
  return () => {
    modalListeners.delete(l)
  }
}
const topModal = () => modals[modals.length - 1] ?? null

export function Dialog({
  title,
  onClose,
  children,
  footer,
  width = 480,
  onSubmit,
}: {
  title: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: number
  onSubmit?: () => void
}) {
  const id = useId()
  const titleId = `${id}-title`
  // The first field or the marked control gets focus, not the Close button that comes first in the DOM.
  const ref = useModalDialog(onClose, (el) => el.querySelector<HTMLElement>('[data-autofocus]') ?? el.querySelectorAll<HTMLElement>(FOCUSABLE)[1])

  useLayoutEffect(() => {
    modals = [...modals, id]
    modalListeners.forEach((l) => l())
    return () => {
      modals = modals.filter((m) => m !== id)
      modalListeners.forEach((l) => l())
    }
  }, [id])
  const isTop = useSyncExternalStore(subscribeModals, topModal) === id
  const notices = useToasts()

  const body = (
    <>
      <header className="dialog-head">
        <h2 id={titleId}>{title}</h2>
        <IconButton label="Close" onClick={onClose}>
          <X size={18} />
        </IconButton>
      </header>
      <div className="dialog-body">{children}</div>
      {isTop && notices.length > 0 && (
        <div className="dialog-notices">
          {notices.map((t) => (
            <ToastItem key={t.id} toast={t} />
          ))}
        </div>
      )}
      {footer && <footer className="dialog-foot">{footer}</footer>}
    </>
  )

  return (
    <dialog ref={ref} aria-labelledby={titleId} className="dialog" style={{ width }} {...LIGHT_DISMISS}>
      {onSubmit ? (
        <form
          className="dialog-form"
          onSubmit={(e) => {
            e.preventDefault()
            onSubmit()
          }}
        >
          {body}
        </form>
      ) : (
        body
      )}
    </dialog>
  )
}

export function Confirm({
  title,
  children,
  confirmLabel,
  busy,
  onConfirm,
  onClose,
}: {
  title: string
  children: ReactNode
  confirmLabel: string
  busy?: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <Dialog
      title={title}
      onClose={onClose}
      width={420}
      footer={
        <>
          <Button onClick={onClose} data-autofocus>
            Cancel
          </Button>
          <Button variant="danger" busy={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="confirm-text">{children}</p>
    </Dialog>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  )
}

// ---------- Popover & menu ----------

export type Anchor = { el: HTMLElement } | { x: number; y: number }

/** Floating layer positioned next to an element or at a point; closes on outside press, Escape, scroll or resize. */
export function Popover({
  anchor,
  onClose,
  children,
  className,
  align = 'start',
  matchWidth,
}: {
  anchor: Anchor
  onClose: () => void
  children: ReactNode
  className?: string
  align?: 'start' | 'end'
  matchWidth?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  // Measured off screen first. Not hidden with `visibility`: a menu focuses its first item in a layout effect
  // that runs before this component's own, and a hidden element cannot take focus.
  const [pos, setPos] = useState<CSSProperties>({ left: -9999, top: -9999 })
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    const vw = window.innerWidth
    const vh = window.innerHeight
    let left: number
    let top: number
    let minWidth: number | undefined
    // The corner that touches the trigger: the opening animation grows out of it.
    let above = false
    if ('el' in anchor) {
      const r = anchor.el.getBoundingClientRect()
      left = align === 'end' ? r.right - w : r.left
      top = r.bottom + 4
      if (top + h > vh - 8 && r.top - h - 4 >= 8) {
        top = r.top - h - 4
        above = true
      }
      if (matchWidth) minWidth = r.width
    } else {
      left = anchor.x
      top = anchor.y
      if (top + h > vh - 8) {
        top = Math.max(8, anchor.y - h)
        above = true
      }
    }
    left = Math.max(8, Math.min(left, vw - w - 8))
    top = Math.max(8, Math.min(top, vh - h - 8))
    setPos({ left, top, minWidth, transformOrigin: `${above ? 'bottom' : 'top'} ${'el' in anchor && align === 'end' ? 'right' : 'left'}` })
  }, [anchor, align, matchWidth])

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) closeRef.current()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isComposing(e)) {
        // preventDefault keeps a modal dialog around the popover open: this Escape closes the popover only.
        e.preventDefault()
        e.stopPropagation()
        closeRef.current()
      }
    }
    const away = (e: Event) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return
      closeRef.current()
    }
    document.addEventListener('mousedown', down, true)
    document.addEventListener('keydown', key, true)
    window.addEventListener('resize', away)
    window.addEventListener('scroll', away, true)
    return () => {
      document.removeEventListener('mousedown', down, true)
      document.removeEventListener('keydown', key, true)
      window.removeEventListener('resize', away)
      window.removeEventListener('scroll', away, true)
    }
  }, [])

  return createPortal(
    <div ref={ref} className={cx('popover', className)} style={pos}>
      {children}
    </div>,
    // Inside a modal dialog everything outside it is inert, so the layer has to live in the dialog.
    ('el' in anchor && anchor.el.closest('dialog:modal')) || document.body,
  )
}

export type MenuItem =
  | { type?: 'item'; label: string; icon?: ReactNode; onSelect: () => void; danger?: boolean; disabled?: boolean; checked?: boolean; hint?: string; desc?: string; title?: string; mono?: boolean }
  | { type: 'separator' }
  | { type: 'heading'; label: string }

export function Menu({ anchor, items, onClose, align }: { anchor: Anchor; items: MenuItem[]; onClose: () => void; align?: 'start' | 'end' }) {
  const ref = useRef<HTMLDivElement>(null)
  // A layout effect: focus is back on the trigger before a dialog opened by the chosen item records where to return it.
  useLayoutEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    ref.current?.querySelector<HTMLElement>('[role^="menuitem"]:not([disabled])')?.focus({ preventScroll: true })
    return () => {
      if (prev && document.contains(prev)) prev.focus()
    }
  }, [])
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return
    e.preventDefault()
    const els = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])') ?? [])
    if (!els.length) return
    const i = els.indexOf(document.activeElement as HTMLElement)
    const next =
      e.key === 'Home' ? 0 : e.key === 'End' ? els.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + els.length) % els.length
    els[next].focus()
  }
  return (
    <Popover anchor={anchor} onClose={onClose} align={align} className="menu-pop">
      <div ref={ref} role="menu" className="menu" onKeyDown={onKeyDown}>
        {items.map((it, i) => {
          if (it.type === 'separator') return <div key={i} className="menu-sep" role="separator" />
          if (it.type === 'heading')
            return (
              <div key={i} className="menu-heading">
                {it.label}
              </div>
            )
          return (
            <button
              key={i}
              type="button"
              role={it.checked != null ? 'menuitemcheckbox' : 'menuitem'}
              aria-checked={it.checked != null ? it.checked : undefined}
              disabled={it.disabled}
              title={it.title}
              className={cx('menu-item', it.danger && 'is-danger')}
              onClick={() => {
                onClose()
                it.onSelect()
              }}
            >
              <span className="menu-icon">{it.checked ? <Check size={15} /> : it.icon}</span>
              <span className={cx('menu-label', it.mono && 'mono')}>
                {it.label}
                {it.desc && <span className="menu-desc">{it.desc}</span>}
              </span>
              {it.hint && <span className="menu-hint">{it.hint}</span>}
            </button>
          )
        })}
      </div>
    </Popover>
  )
}

/** A button that opens a menu below itself. */
export function MenuButton({
  items,
  children,
  align = 'end',
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> & { items: MenuItem[]; align?: 'start' | 'end'; label?: string }) {
  const [el, setEl] = useState<HTMLElement | null>(null)
  return (
    <>
      <button
        type="button"
        {...rest}
        aria-label={rest.label ?? rest['aria-label']}
        title={rest.title ?? rest.label}
        aria-haspopup="menu"
        aria-expanded={!!el}
        onClick={(e) => {
          e.stopPropagation()
          setEl(el ? null : e.currentTarget)
        }}
      >
        {children}
      </button>
      {el && <Menu anchor={{ el }} items={items} align={align} onClose={() => setEl(null)} />}
    </>
  )
}

// ---------- Inline edit ----------

export function InlineEdit({
  value,
  onSave,
  placeholder,
  className,
  multiline,
  label,
}: {
  value: string
  onSave: (v: string) => void
  placeholder?: string
  className?: string
  multiline?: boolean
  label: string
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  // Set when a key ended the edit: focus then returns to the button instead of being lost with the field.
  // Leaving the field with the pointer or Tab also ends the edit, and focus stays where the user put it.
  const refocus = useRef(false)
  useEffect(() => {
    if (draft != null || !refocus.current) return
    refocus.current = false
    buttonRef.current?.focus()
  }, [draft])
  const commit = () => {
    if (draft == null) return
    const v = draft.trim()
    setDraft(null)
    if (v !== value && (v || multiline)) onSave(v)
  }
  const endByKey = (save: boolean) => {
    refocus.current = true
    if (save) commit()
    else setDraft(null)
  }
  if (draft == null) {
    return (
      <button ref={buttonRef} type="button" className={cx('inline-edit', !value && 'is-empty', className)} onClick={() => setDraft(value)} title={`Edit ${label}`}>
        {value || placeholder}
      </button>
    )
  }
  const common = {
    autoFocus: true,
    'aria-label': label,
    value: draft,
    placeholder,
    className: cx('input inline-edit-input', className),
    onBlur: commit,
  }
  return multiline ? (
    <textarea
      {...common}
      rows={3}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (isComposing(e)) return
        if (e.key === 'Escape') endByKey(false)
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) endByKey(true)
      }}
    />
  ) : (
    <input
      {...common}
      onChange={(e) => setDraft(e.target.value)}
      enterKeyHint="done"
      onKeyDown={(e) => {
        // Enter and Escape that confirm or cancel an input method's conversion belong to the input method.
        if (isComposing(e)) return
        if (e.key === 'Escape') endByKey(false)
        if (e.key === 'Enter') {
          e.preventDefault()
          endByKey(true)
        }
      }}
    />
  )
}

// ---------- Toasts ----------

interface Toast {
  id: number
  kind: 'error' | 'info'
  text: string
}
let toasts: Toast[] = []
let nextToast = 1
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

function dismiss(id: number) {
  toasts = toasts.filter((t) => t.id !== id)
  emit()
}

export function toast(text: string, kind: Toast['kind'] = 'info') {
  if (toasts.some((t) => t.text === text)) return
  const id = nextToast++
  toasts = [...toasts.slice(-3), { id, kind, text }]
  emit()
  window.setTimeout(() => dismiss(id), kind === 'error' ? 8000 : 4000)
}
export const toastError = (e: unknown) => toast(e instanceof Error ? e.message : String(e), 'error')

const subscribeToasts = (l: () => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}
const useToasts = () => useSyncExternalStore(subscribeToasts, () => toasts)

function ToastItem({ toast: t }: { toast: Toast }) {
  return (
    <div className={cx('toast', `toast-${t.kind}`)} role={t.kind === 'error' ? 'alert' : 'status'}>
      {t.kind === 'error' ? <CircleX size={16} aria-hidden /> : <CircleCheck size={16} aria-hidden />}
      <span>{t.text}</span>
      <button type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
        <X size={14} aria-hidden />
      </button>
    </div>
  )
}

export function Toaster() {
  const list = useToasts()
  // While a modal dialog is open it shows the messages (see Dialog); they come back here if they outlive it.
  const modalOpen = useSyncExternalStore(subscribeModals, topModal) !== null
  return createPortal(
    <div className="toasts" role="region" aria-label="Notifications">
      {!modalOpen && list.map((t) => <ToastItem key={t.id} toast={t} />)}
    </div>,
    document.body,
  )
}
