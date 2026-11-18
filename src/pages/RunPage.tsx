import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ChevronLeft, ChevronRight, ImageOff, Pencil, Square, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { sharedLabel, stepSentence } from '../../shared/commands'
import { logOfPattern, patternSummary } from '../../shared/data'
import { deviceOf } from '../../shared/devices'
import { flatRange, nextToRun, positionLabel, positionsOf, topLevelCount } from '../../shared/expand'
import { locatorToString, type Box, type HealProposal, type Run, type RunPattern, type StepResult, type Ui } from '../../shared/types'
import { api, qk, shotUrl } from '../api'
import { Button, DeviceChip, Dialog, ErrorState, IconButton, Loading, onTablistKeyDown, Shell, Spinner, StaleNotice, StatusIcon, TableWrap, Tabs, toast } from '../components/ui'
import { cx, dateTime, duration, isTerminal, ms, plural, STATUS_LABEL } from '../lib/format'
import { useModalDialog, useTick } from '../lib/hooks'

type TabId = 'shots' | 'log' | 'info'

export function RunPage() {
  const { rid = '' } = useParams()
  const qc = useQueryClient()
  const run = useQuery({
    queryKey: qk.run(rid),
    queryFn: () => api.run(rid),
    refetchInterval: (q) => (q.state.data && isTerminal(q.state.data.status) ? false : 1000),
  })
  const pid = run.data?.projectId
  const project = useQuery({ queryKey: qk.project(pid ?? ''), queryFn: () => api.project(pid!), enabled: !!pid })
  const abort = useMutation({ mutationFn: () => api.abortRun(rid), onSuccess: (r) => qc.setQueryData(qk.run(rid), r) })
  const [tab, setTab] = useState<TabId>('shots')
  const [healStep, setHealStep] = useState<string | null>(null)
  const [lightbox, setLightbox] = useState<number | null>(null)
  const live = !!run.data && !isTerminal(run.data.status)
  useTick(live)
  const [params, setParams] = useSearchParams()

  // A live report is asked for every second. One answer that does not come must not replace the report (its
  // screenshots, an open review) with an error: that is only shown when there is no report to show.
  if (run.isError && !run.data) return <Shell><ErrorState error={run.error} onRetry={() => run.refetch()} /></Shell>
  const r = run.data
  if (!r) return <Shell><Loading /></Shell>
  // A data-driven run is read one pattern (data row) at a time: the one in the address, else the first that
  // failed, else the first that waits for a review, else the one that is running, else the first.
  const patterns = r.patterns
  const asked = Number(params.get('pattern'))
  const pattern = patterns
    ? (patterns.find((p) => p.index === asked) ??
      patterns.find((p) => p.status === 'failed') ??
      patterns.find((p) => p.status === 'unresolved') ??
      patterns.find((p) => p.status === 'running') ??
      patterns[0])
    : undefined
  // What the tabs show: the run itself, or the selected pattern as if it were a run of its own.
  const view: Run = pattern ? { ...r, status: pattern.status, results: r.results.filter((x) => x.pattern === pattern.index), log: logOfPattern(r.log, pattern.index) } : r
  const failures = view.results.filter((x) => x.status === 'failed')
  const heals = view.results.filter((x) => x.heal)
  const shots = view.results.filter((x) => x.screenshotKey)
  // The shared step a reported step came from, so a screenshot says which one it belongs to.
  const sharedOf = new Map(r.steps.flatMap((s) => (s.origin ? [[s.id, s.origin.shared] as const] : [])))
  const healResult = healStep ? view.results.find((x) => x.stepId === healStep && x.heal) : undefined
  const what = r.kind === 'shared' ? 'shared step' : 'test case'

  const crumbs = [
    { label: project.data?.name ?? 'Project', to: `/p/${r.projectId}` },
    ...(r.batchRunId ? [{ label: 'Batch run', to: `/b/${r.batchRunId}` }] : []),
    // A run inside a batch report outlives its test case: there is nothing to link to then.
    r.testCaseDeleted ? { label: r.testCaseName } : { label: r.testCaseName, to: `/t/${r.testCaseId}` },
    { label: 'Result' },
  ]

  return (
    <Shell crumbs={crumbs}>
      <div className="page-head">
        <div className="page-head-main result-head">
          <StatusIcon status={r.status} size={34} />
          <div className="result-head-text">
            <h1>
              <span className={`result-word status-${r.status}`}>{STATUS_LABEL[r.status]}</span>
            </h1>
            <p className="page-sub">
              {r.testCaseDeleted ? r.testCaseName : <Link to={`/t/${r.testCaseId}`}>{r.testCaseName}</Link>}{' '}
              <span className="hash">{r.kind === 'shared' ? `S${r.testCaseNumber}` : `#${r.testCaseNumber}`}</span>
              {r.kind === 'shared' && <span className="muted"> · shared step run by itself</span>}
              {r.testCaseDeleted && <span className="muted"> · this {what} has been deleted</span>}
            </p>
            <div className="chips">
              <span className="chip num">{duration(r.startedAt, r.finishedAt)}</span>
              <span className="chip">{r.environment.browser}</span>
              <DeviceChip device={r.environment.device} />
              <span className="chip num">
                {r.environment.viewport.width} × {r.environment.viewport.height}
              </span>
              {r.range && <span className="chip num">Steps {r.range.from === r.range.to ? r.range.from : `${r.range.from}–${r.range.to}`}</span>}
              {r.batchRunId && <span className="chip">Batch run, position {r.order}</span>}
              {patterns && <span className="chip num">{patterns.length === 1 ? `Data row ${patterns[0].index}` : isTerminal(r.status) ? patternSummary(patterns) : `${patterns.length} patterns`}</span>}
            </div>
          </div>
        </div>
        <div className="page-actions">
          {live && (
            <Button icon={<Square size={14} />} busy={abort.isPending} onClick={() => abort.mutate()}>
              Abort
            </Button>
          )}
          {!r.testCaseDeleted && (
            <Link to={`/t/${r.testCaseId}/edit`} className="btn">
              <Pencil size={15} />
              <span className="btn-label">Edit {what}</span>
            </Link>
          )}
        </div>
      </div>

      {run.isError && <StaleNotice live={live} />}

      {patterns && pattern && (
        <PatternBar
          run={r}
          current={pattern.index}
          onSelect={(index) => {
            setHealStep(null)
            setLightbox(null)
            setParams(
              (prev) => {
                prev.set('pattern', String(index))
                return prev
              },
              { replace: true },
            )
          }}
        />
      )}

      {(failures.length > 0 || heals.length > 0) && (
        <div className="messages">
          {failures.map((f) => (
            <div className="message message-fail" key={`f-${f.stepId}`}>
              <span className="message-n num">{positionLabel(f)}</span>
              <span className="message-label">Failed</span>
              <span className="message-text">{f.error || 'The step failed.'}</span>
            </div>
          ))}
          {heals.map((h) => (
            <button type="button" className={cx('message', 'message-review', `heal-${h.heal!.state}`)} key={`h-${h.stepId}`} onClick={() => setHealStep(h.stepId)}>
              <span className="message-n num">{positionLabel(h)}</span>
              <span className="message-label">{healLabel(h.heal!)}</span>
              <span className="message-text">
                UI element {h.heal!.elementName} (<code>{locatorToString(h.heal!.oldLocator)}</code>) was not found, so the locator was automatically repaired
                to “<code>{locatorToString(h.heal!.newLocator)}</code>”.
                {h.heal!.warning && <span className="message-warn"> {h.heal!.warning}</span>}
              </span>
              <span className="message-cta">
                {h.heal!.state === 'unresolved' && !live ? 'Review' : 'View'}
                <ChevronRight size={15} />
              </span>
            </button>
          ))}
        </div>
      )}

      <Tabs<TabId>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'shots', label: 'Screenshots', count: shots.length },
          { id: 'log', label: 'Log' },
          { id: 'info', label: 'Run info' },
        ]}
        label="Run details"
      >

      {tab === 'shots' &&
        (shots.length === 0 ? (
          <div className="state">
            {!isTerminal(view.status) ? (
              pattern && view.status === 'queued' && r.status === 'running' ? (
                'This pattern runs after the ones before it.'
              ) : (
                <>
                  <Spinner /> Waiting for the first step…
                </>
              )
            ) : r.range && r.status === 'succeeded' && r.results.length === 0 ? (
              // A partial run whose steps are disabled or in a branch arm that was not taken: the log says which.
              'None of the requested steps was executed, so this run checked nothing. The log says why each step was skipped.'
            ) : pattern && view.results.length === 0 ? (
              'This pattern was not run.'
            ) : (
              'No screenshots were taken in this run.'
            )}
          </div>
        ) : (
          <div className="shots">
            {shots.map((s, i) => (
              <button
                type="button"
                key={s.stepId}
                className={cx('shot', s.status === 'failed' && 'is-failed', s.heal && 'is-healed')}
                onClick={() => (s.heal && s.heal.state === 'unresolved' ? setHealStep(s.stepId) : setLightbox(i))}
                title={sharedOf.has(s.stepId) ? `${s.sentence}\nShared step ${sharedLabel(sharedOf.get(s.stepId)!)}` : s.sentence}
              >
                <img src={shotUrl(s.screenshotKey!)} alt="" loading="lazy" />
                <span className="shot-foot">
                  <span className="shot-n num">{positionLabel(s)}</span>
                  {sharedOf.has(s.stepId) && (
                    <span className="shot-shared num">
                      <span className="sr-only">Shared step </span>S{sharedOf.get(s.stepId)!.number}
                      <span className="sr-only">: {sharedOf.get(s.stepId)!.name}</span>
                    </span>
                  )}
                  <span className="truncate">{s.sentence}</span>
                  {s.status !== 'passed' && <StatusIcon status={s.status} size={15} />}
                </span>
              </button>
            ))}
          </div>
        ))}

      {tab === 'log' && (
        <LogTab
          run={view}
          live={live}
          onOpenShot={(stepId) => {
            const i = shots.findIndex((x) => x.stepId === stepId)
            if (i >= 0) setLightbox(i)
          }}
        />
      )}
      {tab === 'info' && <InfoTab run={r} view={view} pattern={pattern} />}
      </Tabs>

      {lightbox != null && shots[lightbox] && <Lightbox shots={shots} index={lightbox} onIndex={setLightbox} onClose={() => setLightbox(null)} />}
      {healResult && <HealDialog run={r} result={healResult} live={live} onClose={() => setHealStep(null)} />}
    </Shell>
  )
}

/** The patterns of a data-driven run, as tabs: status, row number and the first values of the row. */
function PatternBar({ run, current, onSelect }: { run: Run; current: number; onSelect: (index: number) => void }) {
  const patterns = run.patterns ?? []
  // The row of tabs scrolls when there are many: keep the selected one in view (it may be chosen for the reader, e.g. the first failure).
  const strip = useRef<HTMLDivElement>(null)
  useEffect(() => {
    strip.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [current])
  return (
    <div className="patterns">
      <div className="patterns-tabs" ref={strip} role="tablist" aria-label="Patterns (data rows) of this run" onKeyDown={onTablistKeyDown}>
        {patterns.map((p) => {
          const status = p.status
          const values = Object.entries(p.values)
          const notRun = isTerminal(run.status) && !p.startedAt
          return (
            <button
              type="button"
              role="tab"
              key={p.index}
              aria-selected={p.index === current}
              tabIndex={p.index === current ? 0 : -1}
              className={cx('pattern', p.index === current && 'is-active')}
              title={values.map(([k, v]) => `${k} = ${v}`).join('\n')}
              onClick={() => onSelect(p.index)}
            >
              <StatusIcon status={status} size={16} decorative />
              <span className="pattern-n num">
                Pattern {p.index}
                <span className="sr-only">, {notRun ? 'not run' : STATUS_LABEL[status]}</span>
              </span>
              <span className="pattern-values">
                {values
                  .slice(0, 2)
                  .map(([, v]) => v || '(empty)')
                  .join(' · ')}
                {values.length > 2 && ' …'}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function healLabel(h: HealProposal): string {
  return h.state === 'approved' ? 'Repair approved' : h.state === 'rejected' ? 'Repair rejected' : 'Needs review'
}

// ---------- Log ----------

/** Size of .log-preview in app.css. */
const PREVIEW_W = 360
const PREVIEW_H = 240

function LogTab({ run, live, onOpenShot }: { run: Run; live: boolean; onOpenShot: (stepId: string) => void }) {
  const [wrap, setWrap] = useState(true)
  const [hover, setHover] = useState<{ key: string; top: number; left: number } | null>(null)
  // The screenshot preview of a step: under its row (above it near the bottom of the window), inside the
  // Steps pane, because the Console pane next to it is what the step list is read against.
  const preview = (row: HTMLElement, key: string) => {
    const rect = row.getBoundingClientRect()
    const below = rect.bottom + 6
    setHover({ key, top: below + PREVIEW_H > window.innerHeight - 8 ? Math.max(8, rect.top - 6 - PREVIEW_H) : below, left: Math.max(8, rect.right - PREVIEW_W) })
  }
  // Escape puts the preview away without moving the pointer or focus.
  const shown = hover !== null
  useEffect(() => {
    if (!shown) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setHover(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [shown])
  const byStep = useMemo(() => new Map(run.results.map((x) => [x.stepId, x])), [run.results])
  // The steps are listed as the run executed them: a shared step call is a heading, with its steps under it.
  const positions = useMemo(() => positionsOf(run.steps), [run.steps])
  const { from, to } = run.range ? flatRange(run.steps, run.range) : { from: 1, to: run.steps.length }
  const runningId = live && run.status === 'running' ? nextToRun(run.steps, run.range, (id) => byStep.has(id))?.id : undefined

  return (
    <div className="log">
      <div className="log-pane">
        <div className="log-head">Steps</div>
        <ol className="log-steps">
          {run.steps.map((s, i) => {
            const res = byStep.get(s.id)
            const out = s.disabled || i + 1 < from || i + 1 > to
            const label = positionLabel(positions[i])
            if (s.call) {
              // Not executed itself: it shows how its steps went.
              const inside = run.steps.filter((x) => x.origin?.callId === s.id).map((x) => byStep.get(x.id))
              const status = inside.some((x) => x?.status === 'failed') ? 'failed' : inside.some((x) => x?.status === 'healed') ? 'healed' : inside.some((x) => x) ? 'passed' : undefined
              return (
                <li key={s.id} className={cx('log-step', 'log-group', out && 'is-out')}>
                  <span className="log-n num">{label}</span>
                  <span className="log-sentence">
                    Shared step <Link to={`/t/${s.call.id}`}>{sharedLabel(s.call)}</Link>
                  </span>
                  <span className="log-meta num">{plural(inside.length, 'step')}</span>
                  <span className="log-status">{status ? <StatusIcon status={status} size={16} /> : null}</span>
                </li>
              )
            }
            return (
              <li
                key={s.id}
                className={cx('log-step', s.origin && 'is-inner', res && `is-${res.status}`, out && 'is-out')}
                onMouseEnter={(e) => res?.screenshotKey && preview(e.currentTarget, res.screenshotKey)}
                onMouseLeave={() => setHover(null)}
              >
                <span className="log-n num">{label}</span>
                <span className="log-sentence">
                  {res?.screenshotKey ? (
                    // A real control: the keyboard and touch get the screenshot too (focus previews it, activating opens it).
                    <button
                      type="button"
                      className="log-open"
                      aria-label={`${res.sentence}. Open the screenshot of step ${label}`}
                      onClick={() => onOpenShot(s.id)}
                      onFocus={(e) => e.currentTarget.matches(':focus-visible') && preview(e.currentTarget.closest('li')!, res.screenshotKey!)}
                      onBlur={() => setHover(null)}
                    >
                      {res.sentence}
                    </button>
                  ) : (
                    (res?.sentence ?? stepSentence(s))
                  )}
                  {res?.error && <span className="log-error">{res.error}</span>}
                </span>
                <span className="log-meta num">{res ? ms(res.durationMs) : ''}</span>
                <span className="log-status">{res ? <StatusIcon status={res.status} size={16} /> : s.id === runningId ? <StatusIcon status="running" size={16} /> : null}</span>
              </li>
            )
          })}
        </ol>
      </div>
      <div className="log-pane log-console">
        <div className="log-head">
          Console
          <label className="log-wrap">
            <input type="checkbox" className="check" checked={wrap} onChange={(e) => setWrap(e.target.checked)} /> Wrap lines
          </label>
        </div>
        <pre className={wrap ? 'is-wrap' : undefined}>{run.log || (live ? 'Waiting for output…' : 'No output.')}</pre>
      </div>
      {hover &&
        createPortal(
          <div className="log-preview" style={{ top: hover.top, left: hover.left }}>
            <img src={shotUrl(hover.key)} alt="" />
          </div>,
          document.body,
        )}
    </div>
  )
}

function InfoTab({ run, view, pattern }: { run: Run; view: Run; pattern?: RunPattern }) {
  const total = view.results.reduce((n, x) => n + x.durationMs, 0)
  const patternRows: [string, React.ReactNode][] =
    run.patterns && pattern
      ? [
          ['Patterns', run.patterns.length === 1 ? `Data row ${pattern.index} only (a partial run uses one row)` : `${run.patterns.length} data rows, run one after the other, each in a fresh browser`],
          [`Pattern ${pattern.index}`, `${STATUS_LABEL[view.status]}${pattern.startedAt ? `, ${duration(pattern.startedAt, pattern.finishedAt)}` : ', not run'}`],
          ...Object.entries(pattern.values).map(([k, v]) => [`\${${k}}`, v === '' ? '(empty)' : v] as [string, React.ReactNode]),
        ]
      : []
  const rows: [string, React.ReactNode][] = [
    ['Status', STATUS_LABEL[run.status]],
    [run.kind === 'shared' ? 'Shared step' : 'Test case', `${run.testCaseName} (${run.kind === 'shared' ? 'S' : '#'}${run.testCaseNumber})`],
    ['Browser', run.environment.browser],
    ['Device', `${deviceOf(run.environment.device).label}${deviceOf(run.environment.device).isMobile ? ' (emulated: phone viewport, user agent and touch)' : ''}`],
    ['Viewport', `${run.environment.viewport.width} × ${run.environment.viewport.height}`],
    ['Base URL', run.environment.baseUrl || '–'],
    ['Step range', run.range ? `${run.range.from}–${run.range.to} of ${topLevelCount(run.steps)}` : `All ${topLevelCount(run.steps)} steps`],
    ...(run.steps.some((s) => s.call) ? ([['Shared steps', `${run.steps.filter((s) => s.call).length} called, ${run.steps.filter((s) => s.origin).length} steps inside them (as they were when the run was created)`]] as [string, React.ReactNode][]) : []),
    ...patternRows,
    ['Self-healing', run.batchRunId ? 'On (batch run)' : 'Off (single run)'],
    ['Queued', dateTime(run.createdAt)],
    ['Started', dateTime(run.startedAt)],
    ['Finished', dateTime(run.finishedAt)],
    ['Duration', duration(run.startedAt, run.finishedAt)],
    ['Time in steps', ms(total)],
    ['Steps reported', `${view.results.length}${pattern && run.patterns && run.patterns.length > 1 ? ` in this pattern, ${run.results.length} in the run` : ''}`],
    ['Run id', <code key="id">{run.id}</code>],
  ]
  return (
    <TableWrap label="Run information">
      <table className="table info-table">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <th scope="row">{k}</th>
              <td className="num">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  )
}

// ---------- Lightbox ----------

function Lightbox({ shots, index, onIndex, onClose }: { shots: StepResult[]; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const s = shots[index]
  // A native modal dialog: Escape, the back gesture, focus containment and the return of focus come with it.
  const ref = useModalDialog(onClose, (el) => el.querySelector<HTMLElement>('[data-autofocus]'))
  return (
    <dialog
      ref={ref}
      className="lightbox"
      aria-label={`Screenshot of step ${positionLabel(s)}`}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft' && index > 0) onIndex(index - 1)
        if (e.key === 'ArrowRight' && index < shots.length - 1) onIndex(index + 1)
      }}
    >
      <header className="lightbox-bar">
        <span className="shot-n num">{positionLabel(s)}</span>
        <span className="lightbox-title">{s.sentence}</span>
        {s.status !== 'passed' && <StatusIcon status={s.status} size={16} />}
        <span className="lightbox-count num">
          {index + 1} / {shots.length}
        </span>
        <IconButton label="Previous screenshot" disabled={index === 0} onClick={() => onIndex(index - 1)}>
          <ChevronLeft size={18} />
        </IconButton>
        <IconButton label="Next screenshot" disabled={index === shots.length - 1} onClick={() => onIndex(index + 1)}>
          <ChevronRight size={18} />
        </IconButton>
        <IconButton label="Close" onClick={onClose} data-autofocus>
          <X size={18} />
        </IconButton>
      </header>
      {s.error && <div className="lightbox-error">{s.error}</div>}
      <div
        className="lightbox-stage"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose()
        }}
      >
        <img key={s.screenshotKey} src={shotUrl(s.screenshotKey!)} alt={s.sentence} />
      </div>
    </dialog>
  )
}

// ---------- Self-healing ----------

/** Shows the part of a full-page screenshot around `box`, with the box outlined. */
function Crop({ src, width, height, box }: { src: string; width: number; height: number; box: Box }) {
  const [broken, setBroken] = useState(false)
  const ASPECT = 4 / 3
  const regionW = Math.min(width, Math.max(box.w + 260, box.w * 2.2, 460))
  const regionH = regionW / ASPECT
  const clamp = (v: number, max: number) => Math.max(0, Math.min(v, Math.max(0, max)))
  const rx = clamp(box.x + box.w / 2 - regionW / 2, width - regionW)
  const ry = clamp(box.y + box.h / 2 - regionH / 2, height - regionH)
  const pct = (n: number, of: number) => `${(n / of) * 100}%`
  if (broken) {
    return (
      <div className="crop crop-missing">
        <ImageOff size={20} />
        <span>The screenshot is no longer available.</span>
      </div>
    )
  }
  return (
    <div className="crop">
      <img
        src={src}
        alt=""
        onError={() => setBroken(true)}
        style={{ width: pct(width, regionW), height: pct(height, regionH), left: pct(-rx, regionW), top: pct(-ry, regionH) }}
      />
      <span
        className="crop-box"
        style={{ left: pct(box.x - rx, regionW), top: pct(box.y - ry, regionH), width: pct(box.w, regionW), height: pct(box.h, regionH) }}
      />
    </div>
  )
}

function HealDialog({ run, result, live, onClose }: { run: Run; result: StepResult; live: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const heal = result.heal!
  // A step that came from a shared step points at a screen of that shared step, and is repaired there.
  const origin = run.steps.find((s) => s.id === result.stepId)?.origin
  const ownerId = origin?.shared.id ?? run.testCaseId
  const uis = useQuery({ queryKey: qk.uis(ownerId), queryFn: () => api.uis(ownerId), retry: false })
  const before: Ui | undefined = uis.data?.find((u) => u.id === heal.before.uiId)
  const decide = useMutation({
    mutationFn: (action: 'approve' | 'reject') => api.heal(run.id, result.stepId, action, result.pattern),
    onSuccess: (r) => {
      qc.setQueryData(qk.run(run.id), r)
      void qc.invalidateQueries({ queryKey: qk.testCase(ownerId) })
      void qc.invalidateQueries({ queryKey: qk.uis(ownerId) })
      if (origin) void qc.invalidateQueries({ queryKey: qk.sharedSteps(run.projectId) })
      if (run.batchRunId) void qc.invalidateQueries({ queryKey: qk.batchRun(run.batchRunId) })
      // The dialog closes on the decision, so this is said where it will be seen.
      if (r.results.find((x) => x.stepId === result.stepId && x.pattern === result.pattern)?.heal?.notSaved)
        toast('Approved, but no step uses this element any more (it was moved or deleted after the run), so the new locator was not saved to a step.', 'error')
      onClose()
    },
  })
  const open = heal.state === 'unresolved'
  // Rejecting fails the run for good, right next to Approve: it is asked for twice.
  const [rejecting, setRejecting] = useState(false)
  // A different repair of the same element that was approved earlier in this run (in another pattern, or
  // on another step that uses the element): approving this one replaces it.
  const target = run.steps.find((s) => s.id === result.stepId)?.target
  const sameElement = new Set(target ? run.steps.filter((s) => s.target?.uiId === target.uiId && s.target.elementId === target.elementId).map((s) => s.id) : [])
  const earlier = run.results.find(
    (x) => x !== result && x.heal?.state === 'approved' && sameElement.has(x.stepId) && (x.heal.newLocator.key !== heal.newLocator.key || x.heal.newLocator.value !== heal.newLocator.value),
  )
  const score = Math.round(heal.score * 100)

  return (
    <Dialog
      title={`Self-healing result, step ${positionLabel(result)}${result.pattern ? `, pattern ${result.pattern}` : ''}`}
      onClose={onClose}
      width={920}
      footer={
        open && live ? (
          <>
            <span className="heal-foot-note">The run is still in progress. You can approve or reject this repair when it has finished.</span>
            <Button onClick={onClose} data-autofocus>
              Close
            </Button>
          </>
        ) : open && rejecting ? (
          <>
            <span className="heal-foot-note" role="alert">
              <strong>Reject this repair?</strong> {result.pattern && (run.patterns?.length ?? 0) > 1 ? `Pattern ${result.pattern}, and with it the run, is` : 'The run is'} marked as failed, and the old locator
              stays. The decision is final: it cannot be changed afterwards, and a new run is needed to get another proposal.
            </span>
            <Button disabled={decide.isPending} onClick={() => setRejecting(false)} data-autofocus>
              Back
            </Button>
            <Button variant="danger" busy={decide.isPending} onClick={() => decide.mutate('reject')}>
              Reject the repair
            </Button>
          </>
        ) : open ? (
          <>
            <span className="heal-foot-note">
              {origin
                ? `This step belongs to shared step ${sharedLabel(origin.shared)}. Approving saves the new locator there, for every test case that calls it, and to the element on its captured screen (the screenshot is not retaken).`
                : 'Approving saves the new locator to the step and to the element on its captured screen (the screenshot is not retaken).'}{' '}
              {result.pattern && (run.patterns?.length ?? 0) > 1 ? 'The same repair in the other patterns of this run is approved with it. Rejecting marks this pattern, and so the run, as failed and changes nothing.' : 'Rejecting marks this run as failed and changes nothing.'}
              {earlier && (
                <strong>
                  {' '}
                  A different repair of this element (<code>{locatorToString(earlier.heal!.newLocator)}</code>) was already approved for step {positionLabel(earlier)}
                  {earlier.pattern ? ` in pattern ${earlier.pattern}` : ''}: approving this one replaces it.
                </strong>
              )}
            </span>
            <Button variant="danger" disabled={decide.isPending} onClick={() => setRejecting(true)}>
              Reject…
            </Button>
            <Button variant="primary" busy={decide.isPending && decide.variables === 'approve'} disabled={decide.isPending} onClick={() => decide.mutate('approve')} data-autofocus>
              {heal.warning ? 'Approve anyway' : 'Approve'}
            </Button>
          </>
        ) : (
          <>
            <span className="heal-foot-note">
              This repair was {heal.state}.
              {heal.notSaved && ` No step of the ${origin ? 'shared step' : 'test case'} used this element any more (it was moved or deleted after the run), so the new locator was not saved to a step.`}
            </span>
            <Button onClick={onClose} data-autofocus>
              Close
            </Button>
          </>
        )
      }
    >
      <p className="heal-sentence">{result.sentence}</p>
      {heal.warning && (
        <div className="banner banner-fail" role="alert">
          <AlertTriangle size={16} />
          <div>
            <strong>Warning</strong>
            <p>{heal.warning}</p>
          </div>
        </div>
      )}
      <div className="heal-cols">
        <section>
          <h3>Before</h3>
          {uis.isPending ? (
            <div className="crop crop-missing">
              <Spinner />
            </div>
          ) : before ? (
            <Crop src={shotUrl(before.screenshotKey)} width={before.width} height={before.height} box={heal.before.box} />
          ) : (
            <div className="crop crop-missing">
              <ImageOff size={20} />
              <span>The captured screen this step pointed to has been deleted.</span>
            </div>
          )}
          <table className="heal-table">
            <thead>
              <tr>
                <th>Element</th>
                <th>Locator</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{heal.elementName}</td>
                <td>
                  <code>{locatorToString(heal.oldLocator)}</code>
                </td>
              </tr>
            </tbody>
          </table>
        </section>
        <section>
          <h3>After</h3>
          <Crop src={shotUrl(heal.after.screenshotKey)} width={heal.after.width} height={heal.after.height} box={heal.after.box} />
          <table className="heal-table">
            <thead>
              <tr>
                <th>Element</th>
                <th>Locator</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{heal.elementName}</td>
                <td>
                  <code>{locatorToString(heal.newLocator)}</code>
                </td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>
      <div className="heal-score">
        <span>Similarity to the original element</span>
        <span className="meter" role="img" aria-label={`${score} percent`}>
          <span style={{ width: `${score}%` }} className={score < 60 ? 'is-low' : undefined} />
        </span>
        <strong className="num">{score}%</strong>
        <span className="muted">
          Compared by tag, text, label, attributes and position in the page.
          {heal.newCandidates.length > 1 && ` ${heal.newCandidates.length} locators were generated for the replacement.`}
        </span>
      </div>
    </Dialog>
  )
}
