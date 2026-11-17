import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  Camera,
  Check,
  ChevronDown,
  Eye,
  EyeOff,
  Globe,
  ImageOff,
  Maximize2,
  MonitorSmartphone,
  MousePointerClick,
  Pencil,
  Plus,
  Scan,
  Trash2,
  X,
} from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { deviceOf } from '../../shared/devices'
import { locatorToString, type DeviceId, type Locator, type LocatorKey, type Step, type Ui, type UiElement } from '../../shared/types'
import { api, qk, shotUrl } from '../api'
import { Button, Confirm, DeviceChip, Dialog, Field, IconButton, Menu, Popover, Spinner, type MenuItem } from '../components/ui'
import { cx } from '../lib/format'
import { isComposing } from '../lib/hooks'
import { sameLocator } from './model'

export interface Inspect {
  uiId: string
  elementId: string
  stepId?: string
}

export interface UiPanelProps {
  tid: string
  baseUrl: string
  /** The device the test case runs (and captures) on. */
  device: DeviceId
  uis: Ui[]
  loading: boolean
  currentUiId: string | null
  onCurrentUi: (id: string | null) => void
  steps: Step[]
  selectedStep: Step | null
  /** Bumped whenever the selected step's element should pulse again. */
  flash: number
  pickFor: Step | null
  onCancelPick: () => void
  captureAfter: { id: string; n: number } | null
  capturing: string | null
  /** The failed replay behind the screen that is shown, if any. `sentence` is null when the step was removed since. */
  replayError: { n: number; sentence: string | null; message: string } | null
  onDismissReplayError: () => void
  /** Why nothing can be captured right now (the assistant is working on the test case), or null. */
  locked: string | null
  onCaptureAfter: () => void
  onCaptureUrl: (url: string) => void
  onLaunch: (url: string) => void
  onPickElement: (ui: Ui, el: UiElement) => void
  inspect: Inspect | null
  onInspect: (i: Inspect | null) => void
  /** Rename an element in every step that uses it and, when opened from a step, set that step's locator. */
  onSaveElement: (ref: { uiId: string; elementId: string }, name: string, forStep?: { stepId: string; locator: Locator; candidates: Locator[] }) => void
}

export function UiPanel(p: UiPanelProps) {
  const qc = useQueryClient()
  const ui = p.uis.find((u) => u.id === p.currentUiId) ?? null
  const [overlays, setOverlays] = useState(true)
  const [fit, setFit] = useState(true)
  const [listAnchor, setListAnchor] = useState<HTMLElement | null>(null)
  const [capAnchor, setCapAnchor] = useState<HTMLElement | null>(null)
  const [urlDialog, setUrlDialog] = useState(false)
  const [deleting, setDeleting] = useState<Ui | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const setUis = (fn: (old: Ui[]) => Ui[]) => qc.setQueryData<Ui[]>(qk.uis(p.tid), (old) => fn(old ?? []))
  const patchUi = useMutation({
    mutationFn: (v: { id: string; name?: string; elements?: UiElement[] }) => api.updateUi(v.id, { name: v.name, elements: v.elements }),
    onMutate: (v) => setUis((old) => old.map((u) => (u.id === v.id ? { ...u, ...(v.name != null ? { name: v.name } : {}), ...(v.elements ? { elements: v.elements } : {}) } : u))),
    onSuccess: (next) => setUis((old) => old.map((u) => (u.id === next.id ? next : u))),
    onError: () => void qc.invalidateQueries({ queryKey: qk.uis(p.tid) }),
  })
  const removeUi = useMutation({
    mutationFn: (id: string) => api.deleteUi(id),
    onSuccess: (_r, id) => {
      const rest = p.uis.filter((u) => u.id !== id)
      setUis(() => rest)
      if (p.currentUiId === id) p.onCurrentUi(rest[rest.length - 1]?.id ?? null)
      if (p.inspect?.uiId === id) p.onInspect(null)
      setDeleting(null)
    },
  })

  const target = p.selectedStep?.target ?? null
  const targetHere = target && ui && target.uiId === ui.id ? target : null
  const targetUiGone = !!target && !p.uis.some((u) => u.id === target.uiId)
  // A phone capture is shown at its own width inside a device frame; stretching it would misrepresent the screen.
  const phone = !!ui && deviceOf(ui.device).isMobile

  // Draw big boxes first so small elements stay clickable on top of their containers.
  const ordered = useMemo(() => (ui ? ui.elements.toSorted((a, b) => b.box.w * b.box.h - a.box.w * a.box.h) : []), [ui])
  const ghost = targetHere && ui && !ui.elements.some((e) => e.id === targetHere.elementId) ? targetHere : null

  useLayoutEffect(() => {
    if (!targetHere || !scrollRef.current) return
    const el = scrollRef.current.querySelector<HTMLElement>('.el-box.is-target')
    if (!el) return
    const c = scrollRef.current.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    if (r.top < c.top + 8 || r.bottom > c.bottom - 8) scrollRef.current.scrollTo({ top: scrollRef.current.scrollTop + r.top - c.top - c.height / 2 + r.height / 2, behavior: 'smooth' })
    if (r.left < c.left || r.right > c.right) scrollRef.current.scrollTo({ left: scrollRef.current.scrollLeft + r.left - c.left - c.width / 2 + r.width / 2 })
  }, [p.flash, targetHere?.elementId, ui?.id, fit]) // eslint-disable-line react-hooks/exhaustive-deps

  const captureItems: MenuItem[] = [
    {
      label: p.captureAfter ? `Capture after step ${p.captureAfter.n}` : 'Capture after selected step',
      desc: p.captureAfter
        ? `Replays steps 1–${p.captureAfter.n} in a fresh cloud browser, then captures the page it ends on.`
        : 'Add a step first, or capture a URL instead.',
      icon: <Camera size={15} />,
      disabled: !p.captureAfter,
      onSelect: p.onCaptureAfter,
    },
    { label: 'Capture URL…', desc: 'Opens a URL in a fresh cloud browser and captures it. No steps are replayed.', icon: <Globe size={15} />, onSelect: () => setUrlDialog(true) },
  ]

  const inspectUi = p.inspect ? p.uis.find((u) => u.id === p.inspect!.uiId) : undefined
  const inspectStep = p.inspect?.stepId ? p.steps.find((s) => s.id === p.inspect!.stepId) : undefined
  const inspectEl = inspectUi?.elements.find((e) => e.id === p.inspect?.elementId)

  return (
    <section className="uip" aria-label="Captured screens">
      <div className="uip-bar">
        {p.uis.length === 0 && <h2 className="uip-title">Captured screens</h2>}
        {p.uis.length > 0 && (
          <button type="button" className="uip-picker" aria-haspopup="true" aria-expanded={!!listAnchor} onClick={(e) => setListAnchor(listAnchor ? null : e.currentTarget)} title="Switch captured screen">
            <span className="truncate">{ui?.name ?? 'Choose a screen'}</span>
            <span className="uip-picker-count num">
              {ui ? p.uis.indexOf(ui) + 1 : '–'} / {p.uis.length}
            </span>
            <ChevronDown size={14} />
          </button>
        )}
        {ui && (
          <span className="uip-url truncate" title={`${ui.title}\n${ui.url}`}>
            {ui.url}
          </span>
        )}
        {ui && <DeviceChip device={ui.device} />}
        <span className="uip-gap" />
        {ui && (
          <>
            <IconButton label={overlays ? 'Hide element outlines' : 'Show element outlines'} active={overlays} onClick={() => setOverlays(!overlays)}>
              {overlays ? <Eye size={16} /> : <EyeOff size={16} />}
            </IconButton>
            {!phone && (
              <IconButton label={fit ? 'Show at 100%' : 'Fit to panel width'} active={!fit} onClick={() => setFit(!fit)}>
                {fit ? <Maximize2 size={15} /> : <Scan size={16} />}
              </IconButton>
            )}
          </>
        )}
        {p.uis.length > 0 && (
          <div className="split-btn">
            <Button
              icon={<Camera size={15} />}
              disabled={!!p.capturing || !!p.locked}
              onClick={() => (p.captureAfter ? p.onCaptureAfter() : setUrlDialog(true))}
              title={p.locked ?? (p.captureAfter ? `Replay steps 1–${p.captureAfter.n} in a fresh cloud browser, then capture` : 'Capture a URL')}
            >
              Capture
            </Button>
            <button type="button" className="btn split-caret" aria-label="Capture options" aria-haspopup="menu" title={p.locked ?? undefined} disabled={!!p.capturing || !!p.locked} onClick={(e) => setCapAnchor(capAnchor ? null : e.currentTarget)}>
              <ChevronDown size={14} />
            </button>
          </div>
        )}
      </div>

      {p.pickFor && (
        <div className="banner banner-pick">
          <MousePointerClick size={16} />
          <span>Pick the element for this step on the screen below.</span>
          <Button size="sm" onClick={p.onCancelPick}>
            Cancel
          </Button>
        </div>
      )}
      {p.replayError && (
        <div className="banner banner-warn" role="alert">
          <AlertTriangle size={16} />
          <div>
            <strong>
              {p.replayError.sentence === null ? 'The replay stopped at a step that has since been removed' : `The replay stopped at step ${p.replayError.n}: ${p.replayError.sentence}`}
            </strong>
            <p>{p.replayError.message}</p>
            <p className="muted">This capture shows the page as it was at that point.</p>
          </div>
          <IconButton label="Dismiss" onClick={p.onDismissReplayError}>
            <X size={16} />
          </IconButton>
        </div>
      )}
      {ui && ui.device !== p.device && !p.capturing && (
        <div className="banner banner-quiet">
          <MonitorSmartphone size={16} />
          <span>
            This screen was captured on {deviceOf(ui.device).label}, and the test case now runs on {deviceOf(p.device).label}. The page may look different there; capture it again to pick elements from
            the layout the test will see.
          </span>
        </div>
      )}
      {targetUiGone && !p.pickFor && (
        <div className="banner banner-quiet">
          <ImageOff size={16} />
          <span>The screen this step’s element was picked from has been deleted. The step still runs with its saved locator.</span>
        </div>
      )}

      <div className="uip-body">
        {p.loading ? (
          <div className="state">
            <Spinner /> Loading captured screens…
          </div>
        ) : !ui ? (
          <LaunchForm key={p.baseUrl} baseUrl={p.baseUrl} busy={!!p.capturing} locked={p.locked} onLaunch={p.onLaunch} hasSteps={p.steps.length > 0} />
        ) : (
          <div className="uip-scroll" ref={scrollRef}>
            <div className={cx('uip-stage', phone && 'is-phone', p.pickFor && 'is-picking', !overlays && 'no-overlays')} style={phone || !fit ? { width: ui.width } : { width: '100%' }}>
              <div className="uip-canvas" style={{ aspectRatio: `${ui.width} / ${ui.height}` }}>
                <img key={ui.screenshotKey} src={shotUrl(ui.screenshotKey)} width={ui.width} height={ui.height} decoding="async" alt={`Screenshot of ${ui.title || ui.url}`} draggable={false} />
                {ordered.map((el) => (
                  <ElementBox
                    // Remounting the selected step's element restarts its pulse animation.
                    key={targetHere?.elementId === el.id ? `${el.id}:${p.flash}` : el.id}
                    ui={ui}
                    el={el}
                    visible={overlays}
                    isTarget={targetHere?.elementId === el.id}
                    isInspected={p.inspect?.uiId === ui.id && p.inspect.elementId === el.id}
                    onPick={() => p.onPickElement(ui, el)}
                    onInspect={() => p.onInspect({ uiId: ui.id, elementId: el.id })}
                  />
                ))}
                {ghost && (
                  <span
                    key={`ghost-${p.flash}`}
                    className="el-box is-target is-ghost"
                    style={boxStyle(ghost.fingerprint.box, ui)}
                    title={`${ghost.name} (no longer in this screen's element list)`}
                  />
                )}
              </div>
            </div>
          </div>
        )}
        {ui && !p.loading && ui.elements.length === 0 && <div className="uip-note">No UI elements were detected on this screen.</div>}

        {p.capturing && <CaptureProgress label={p.capturing} />}

        {p.inspect && (inspectEl || inspectStep?.target) && (
          <ElementInspector
            key={`${p.inspect.uiId}:${p.inspect.elementId}:${p.inspect.stepId ?? ''}`}
            ui={inspectUi}
            element={inspectEl}
            step={inspectStep}
            steps={p.steps}
            saving={patchUi.isPending}
            onClose={() => p.onInspect(null)}
            onUse={inspectUi && inspectEl && !inspectStep ? () => p.onPickElement(inspectUi, inspectEl) : undefined}
            onSave={(name, locators, current) => {
              if (inspectUi && inspectEl) {
                const elements = inspectUi.elements.map((e) => (e.id === inspectEl.id ? { ...e, name, locators } : e))
                patchUi.mutate({ id: inspectUi.id, elements })
              }
              const ref = inspectStep?.target ?? (inspectUi && inspectEl ? { uiId: inspectUi.id, elementId: inspectEl.id } : null)
              if (ref) p.onSaveElement({ uiId: ref.uiId, elementId: ref.elementId }, name, inspectStep?.target ? { stepId: inspectStep.id, locator: current, candidates: locators } : undefined)
            }}
          />
        )}
      </div>

      {listAnchor && (
        <Popover anchor={{ el: listAnchor }} onClose={() => setListAnchor(null)} className="ui-list-pop">
          <div className="ui-list" role="listbox" aria-label="Captured screens">
            {p.uis.map((u, i) => (
              <div key={u.id} className={cx('ui-item', u.id === ui?.id && 'is-current')}>
                {renaming?.id === u.id ? (
                  <form
                    className="ui-rename"
                    onSubmit={(e) => {
                      e.preventDefault()
                      const name = renaming.name.trim()
                      if (name && name !== u.name) patchUi.mutate({ id: u.id, name })
                      setRenaming(null)
                    }}
                  >
                    <input
                      className="input"
                      autoFocus
                      aria-label="Screen name"
                      value={renaming.name}
                      onChange={(e) => setRenaming({ id: u.id, name: e.target.value })}
                      enterKeyHint="done"
                      onKeyDown={(e) => {
                        if (e.key === 'Escape' && !isComposing(e)) {
                          e.stopPropagation()
                          setRenaming(null)
                        }
                      }}
                    />
                    <Button size="sm" type="submit" variant="primary">
                      Rename
                    </Button>
                  </form>
                ) : (
                  <>
                    <button
                      type="button"
                      role="option"
                      aria-selected={u.id === ui?.id}
                      className="ui-item-main"
                      onClick={() => {
                        p.onCurrentUi(u.id)
                        setListAnchor(null)
                      }}
                    >
                      <span className="ui-thumb">
                        <img src={shotUrl(u.screenshotKey)} alt="" loading="lazy" />
                      </span>
                      <span className="ui-item-text">
                        <span className="ui-item-name truncate" title={u.name}>
                          <span className="muted num">{i + 1}.</span> {u.name}
                        </span>
                        <span className="ui-item-url truncate" title={u.url}>
                          {u.url}
                        </span>
                        <span className="ui-item-url">
                          {u.elements.length} elements · {deviceOf(u.device).label}
                        </span>
                      </span>
                    </button>
                    <IconButton label={`Rename ${u.name}`} onClick={() => setRenaming({ id: u.id, name: u.name })}>
                      <Pencil size={14} />
                    </IconButton>
                    <IconButton
                      label={`Delete ${u.name}`}
                      onClick={() => {
                        setListAnchor(null)
                        setDeleting(u)
                      }}
                    >
                      <Trash2 size={14} />
                    </IconButton>
                  </>
                )}
              </div>
            ))}
          </div>
        </Popover>
      )}
      {capAnchor && <Menu anchor={{ el: capAnchor }} align="end" items={captureItems} onClose={() => setCapAnchor(null)} />}
      {urlDialog && (
        <CaptureUrlDialog
          baseUrl={p.baseUrl}
          onClose={() => setUrlDialog(false)}
          onCapture={(url) => {
            setUrlDialog(false)
            p.onCaptureUrl(url)
          }}
        />
      )}
      {deleting && (
        <Confirm title="Delete captured screen?" confirmLabel="Delete screen" busy={removeUi.isPending} onConfirm={() => removeUi.mutate(deleting.id)} onClose={() => setDeleting(null)}>
          “{deleting.name}” will be removed from this test case. Steps that use its elements keep their own copy of the locator and still run.
        </Confirm>
      )}
    </section>
  )
}

const pct = (n: number, of: number) => `${(n / of) * 100}%`
function boxStyle(b: { x: number; y: number; w: number; h: number }, ui: Ui) {
  return { left: pct(b.x, ui.width), top: pct(b.y, ui.height), width: pct(b.w, ui.width), height: pct(b.h, ui.height) }
}

function ElementBox({
  ui,
  el,
  visible,
  isTarget,
  isInspected,
  onPick,
  onInspect,
}: {
  ui: Ui
  el: UiElement
  visible: boolean
  isTarget: boolean
  isInspected: boolean
  onPick: () => void
  onInspect: () => void
}) {
  if (!visible && !isTarget && !isInspected) return null
  const below = el.box.y < 34
  const right = el.box.x + el.box.w / 2 > ui.width * 0.6
  return (
    <div
      role="button"
      tabIndex={-1}
      aria-label={el.name}
      data-el={el.id}
      className={cx('el-box', isTarget && 'is-target', isInspected && 'is-inspected')}
      style={boxStyle(el.box, ui)}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('.el-tip-edit')) return
        if (e.shiftKey) onInspect()
        else onPick()
      }}
    >
      <span className={cx('el-tip', below && 'is-below', right && 'is-right')}>
        <span className="el-tip-name">{el.name}</span>
        <button type="button" className="el-tip-edit" aria-label={`Edit ${el.name}`} title="Edit name and locator (Shift+click)" onClick={onInspect}>
          <Pencil size={12} />
        </button>
      </span>
    </div>
  )
}

function CaptureProgress({ label }: { label: string }) {
  const [sec, setSec] = useState(0)
  useEffect(() => {
    const t0 = Date.now()
    const t = window.setInterval(() => setSec(Math.floor((Date.now() - t0) / 1000)), 250)
    return () => window.clearInterval(t)
  }, [])
  return (
    <div className="uip-progress" role="status">
      <div className="uip-progress-card">
        <Spinner size={22} />
        <div>
          <strong>{label}</strong>
          <p className="muted">A fresh cloud browser is starting. This usually takes 5 to 30 seconds.</p>
        </div>
        <span className="uip-progress-time num">{sec} s</span>
      </div>
    </div>
  )
}

const looksLikeUrl = (v: string) => /^(https?:\/\/|\/|\$\{)/.test(v.trim())

function LaunchForm({ baseUrl, busy, locked, hasSteps, onLaunch }: { baseUrl: string; busy: boolean; locked: string | null; hasSteps: boolean; onLaunch: (url: string) => void }) {
  const [url, setUrl] = useState(baseUrl)
  const ok = looksLikeUrl(url)
  return (
    <form
      className="launch"
      onSubmit={(e) => {
        e.preventDefault()
        if (ok && !busy && !locked) onLaunch(url.trim())
      }}
    >
      <div className="launch-art" aria-hidden>
        <span />
        <span />
        <span />
      </div>
      <h2>Capture the first screen</h2>
      <p>
        Stepwise opens the page in a cloud browser, takes a full-page screenshot and outlines every button, link and field it finds. Click an outlined element to
        turn it into a step.
      </p>
      <div className="launch-row">
        <input className="input" type="text" inputMode="url" enterKeyHint="go" autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-label="URL to capture" placeholder="https://example.com/login" value={url} onChange={(e) => setUrl(e.target.value)} autoFocus />
        <Button type="submit" variant="primary" icon={<Camera size={15} />} disabled={!ok || !!locked} busy={busy} title={locked ?? undefined}>
          Launch &amp; capture
        </Button>
      </div>
      <p className="muted launch-hint">
        {locked ? 'The assistant is working on this test case: it captures the screens it needs, and they appear here.' : hasSteps ? 'The URL is opened directly; existing steps are not replayed.' : 'This also adds “Navigate to URL” as step 1, so the test starts on the same page.'}
      </p>
    </form>
  )
}

function CaptureUrlDialog({ baseUrl, onClose, onCapture }: { baseUrl: string; onClose: () => void; onCapture: (url: string) => void }) {
  const [url, setUrl] = useState(baseUrl)
  const ok = looksLikeUrl(url)
  return (
    <Dialog
      title="Capture URL"
      onClose={onClose}
      onSubmit={() => ok && onCapture(url.trim())}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" icon={<Camera size={15} />} disabled={!ok}>
            Capture
          </Button>
        </>
      }
    >
      <Field label="URL" hint="Opened in a fresh cloud browser without replaying any steps. Pages behind a login need “Capture after step” instead.">
        <input className="input" data-autofocus inputMode="url" enterKeyHint="go" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/pricing" />
      </Field>
    </Dialog>
  )
}

// ---------- Element inspector ----------

function ElementInspector({
  ui,
  element,
  step,
  steps,
  saving,
  onClose,
  onUse,
  onSave,
}: {
  ui?: Ui
  element?: UiElement
  step?: Step
  steps: Step[]
  saving: boolean
  onClose: () => void
  onUse?: () => void
  onSave: (name: string, locators: Locator[], current: Locator) => void
}) {
  const target = step?.target
  const baseName = target?.name ?? element?.name ?? ''
  const locators: Locator[] = useMemo(() => {
    const list = [...(element?.locators ?? target?.candidates ?? [])]
    if (target && !list.some((l) => sameLocator(l, target.locator))) list.unshift(target.locator)
    return list
  }, [element, target])
  const current: Locator | undefined = target?.locator ?? locators[0]
  const [name, setName] = useState(baseName)
  const [locAnchor, setLocAnchor] = useState<HTMLElement | null>(null)
  const [adding, setAdding] = useState(false)
  const [key, setKey] = useState<LocatorKey>('css')
  const [value, setValue] = useState('')
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => setName(baseName), [baseName])
  // A non-modal <dialog>: the page stays usable around it, and it stays inside the panel instead of the top layer.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    if (!el.open) el.show()
    el.querySelector<HTMLInputElement>('input')?.select()
    return () => {
      // Closing it first hands focus back to where it was before React removes the node.
      if (el.open) el.close()
    }
  }, [])

  // The inspector floats over the screenshot, so it goes where the element it is about is not: to the other
  // side, and below when that is still not enough room (a phone screen fills most of a narrow panel).
  const [dock, setDock] = useState<{ left: boolean; bottom: boolean }>({ left: false, bottom: false })
  useLayoutEffect(() => {
    const self = ref.current
    const body = self?.parentElement
    const box = body?.querySelector<HTMLElement>('.el-box.is-inspected')
    if (!self || !body || !box) return
    const b = body.getBoundingClientRect()
    const r = box.getBoundingClientRect()
    if (r.bottom < b.top || r.top > b.bottom) return // scrolled out of view: nothing to keep clear of
    const width = self.offsetWidth
    const height = self.offsetHeight
    const left = r.left + r.width / 2 > b.left + b.width / 2
    const x0 = left ? b.left + 12 : b.right - 28 - width
    const besideIt = r.right < x0 - 8 || r.left > x0 + width + 8
    // Docked at the top it covers the first `height` pixels; at the bottom, the last.
    const underTop = r.top < b.top + 12 + height + 8
    const underBottom = r.bottom > b.bottom - 12 - height - 8
    setDock({ left, bottom: !besideIt && underTop && !underBottom })
  }, [])

  const usedBy = element && ui ? steps.map((s, i) => (s.target?.uiId === ui.id && s.target.elementId === element.id ? i + 1 : 0)).filter(Boolean) : []
  const commitName = () => {
    const n = name.trim()
    if (!n) return setName(baseName)
    if (n !== baseName && current) onSave(n, locators, current)
  }
  const choose = (l: Locator) => {
    // The chosen locator moves to the front: locators[0] is the one new steps get.
    const next = [l, ...locators.filter((x) => !sameLocator(x, l))]
    onSave(name.trim() || baseName, next, l)
  }

  return (
    <dialog
      className={cx('inspector', dock.left && 'is-left', dock.bottom && 'is-bottom')}
      ref={ref}
      aria-label="UI element"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !isComposing(e)) {
          e.stopPropagation()
          onClose()
        }
      }}
    >
      <header className="inspector-head">
        <h3>UI element</h3>
        <span className="chip chip-quiet">{element?.type ?? target?.fingerprint.type}</span>
        {saving && <Spinner size={14} />}
        <span className="uip-gap" />
        <IconButton label="Close" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </header>
      <div className="inspector-body">
        <label className="field">
          <span className="field-label">Name</span>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            enterKeyHint="done"
            onKeyDown={(e) => {
              // Enter commits the name, except the Enter that confirms an input method's conversion.
              if (e.key === 'Enter' && !isComposing(e)) {
                e.preventDefault()
                e.currentTarget.blur()
              }
            }}
          />
        </label>
        <div className="field">
          <span className="field-label">Locator</span>
          <button type="button" className="locator-btn" aria-haspopup="menu" disabled={locators.length === 0} onClick={(e) => setLocAnchor(e.currentTarget)} title={current ? locatorToString(current) : undefined}>
            <span className="mono truncate">{current ? locatorToString(current) : 'No locator'}</span>
            <ChevronDown size={14} />
          </button>
          <span className="field-hint">
            {locators.length} candidate{locators.length === 1 ? '' : 's'}. The run finds the element by this locator, not by its name.
          </span>
        </div>
        {adding ? (
          <form
            className="locator-add"
            onSubmit={(e) => {
              e.preventDefault()
              const v = value.trim()
              if (!v) return
              choose({ key, value: v })
              setAdding(false)
              setValue('')
            }}
          >
            <select className="input" aria-label="Locator type" value={key} onChange={(e) => setKey(e.target.value as LocatorKey)}>
              <option value="id">id</option>
              <option value="css">css</option>
              <option value="xpath">xpath</option>
            </select>
            <input
              className="input mono"
              autoFocus
              aria-label="Locator value"
              spellCheck={false}
              placeholder={key === 'id' ? 'submit-button' : key === 'css' ? 'form button[type=submit]' : "//button[text()='Sign in']"}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              onKeyDown={(e) => {
                if (e.key === 'Escape' && !isComposing(e)) {
                  e.stopPropagation()
                  setAdding(false)
                }
              }}
            />
            <Button size="sm" type="submit" variant="primary" disabled={!value.trim()}>
              Add
            </Button>
          </form>
        ) : (
          <Button size="sm" icon={<Plus size={14} />} onClick={() => setAdding(true)}>
            Add custom locator
          </Button>
        )}
        <p className="inspector-note muted">
          {step
            ? `The name changes in every step that uses this element. The locator applies to step ${steps.indexOf(step) + 1}${element ? ' and to new steps made from the captured screen' : '; its captured screen was deleted'}.`
            : usedBy.length
              ? `Used by step${usedBy.length === 1 ? '' : 's'} ${usedBy.join(', ')}. Renaming updates them; they keep their locator (open the element from a step to change it there).`
              : 'Not used by any step yet.'}
        </p>
        {onUse && (
          <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={onUse}>
            Add step with this element
          </Button>
        )}
      </div>
      {locAnchor && (
        <Menu
          anchor={{ el: locAnchor }}
          onClose={() => setLocAnchor(null)}
          items={locators.map((l) => ({
            label: locatorToString(l),
            title: locatorToString(l),
            mono: true,
            checked: !!current && sameLocator(l, current),
            icon: <Check size={15} style={{ visibility: 'hidden' }} />,
            onSelect: () => choose(l),
          }))}
        />
      )}
    </dialog>
  )
}
