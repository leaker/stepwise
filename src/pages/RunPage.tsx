import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ChevronLeft, ChevronRight, ImageOff, Pencil, Square, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useParams } from 'react-router-dom'
import { stepSentence } from '../../shared/commands'
import { deviceOf } from '../../shared/devices'
import { locatorToString, type Box, type HealProposal, type Run, type StepResult, type Ui } from '../../shared/types'
import { api, qk, shotUrl } from '../api'
import { Button, DeviceChip, Dialog, ErrorState, IconButton, Loading, Shell, Spinner, StatusIcon, Tabs } from '../components/ui'
import { cx, dateTime, duration, isTerminal, ms, STATUS_LABEL } from '../lib/format'
import { useTick } from '../lib/hooks'

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

  if (run.isPending) return <Shell><Loading /></Shell>
  if (run.isError) return <Shell><ErrorState error={run.error} onRetry={() => run.refetch()} /></Shell>
  const r = run.data
  const failures = r.results.filter((x) => x.status === 'failed')
  const heals = r.results.filter((x) => x.heal)
  const shots = r.results.filter((x) => x.screenshotKey)
  const healResult = healStep ? r.results.find((x) => x.stepId === healStep && x.heal) : undefined

  const crumbs = [
    { label: project.data?.name ?? 'Project', to: `/p/${r.projectId}` },
    ...(r.batchRunId ? [{ label: 'Batch run', to: `/b/${r.batchRunId}` }] : []),
    { label: r.testCaseName, to: `/t/${r.testCaseId}` },
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
              <Link to={`/t/${r.testCaseId}`}>{r.testCaseName}</Link> <span className="hash">#{r.testCaseNumber}</span>
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
            </div>
          </div>
        </div>
        <div className="page-actions">
          {live && (
            <Button icon={<Square size={14} />} busy={abort.isPending} onClick={() => abort.mutate()}>
              Abort
            </Button>
          )}
          <Link to={`/t/${r.testCaseId}/edit`} className="btn">
            <Pencil size={15} />
            <span className="btn-label">Edit test case</span>
          </Link>
        </div>
      </div>

      {(failures.length > 0 || heals.length > 0) && (
        <div className="messages">
          {failures.map((f) => (
            <div className="message message-fail" key={`f-${f.stepId}`}>
              <span className="message-n num">{f.number}</span>
              <span className="message-label">Failed</span>
              <span className="message-text">{f.error || 'The step failed.'}</span>
            </div>
          ))}
          {heals.map((h) => (
            <button type="button" className={cx('message', 'message-review', `heal-${h.heal!.state}`)} key={`h-${h.stepId}`} onClick={() => setHealStep(h.stepId)}>
              <span className="message-n num">{h.number}</span>
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
      />

      {tab === 'shots' &&
        (shots.length === 0 ? (
          <div className="state">{live ? <><Spinner /> Waiting for the first step…</> : 'No screenshots were taken in this run.'}</div>
        ) : (
          <div className="shots">
            {shots.map((s, i) => (
              <button
                type="button"
                key={s.stepId}
                className={cx('shot', s.status === 'failed' && 'is-failed', s.heal && 'is-healed')}
                onClick={() => (s.heal && s.heal.state === 'unresolved' ? setHealStep(s.stepId) : setLightbox(i))}
                title={s.sentence}
              >
                <img src={shotUrl(s.screenshotKey!)} alt="" loading="lazy" />
                <span className="shot-foot">
                  <span className="shot-n num">{s.number}</span>
                  <span className="truncate">{s.sentence}</span>
                  {s.status !== 'passed' && <StatusIcon status={s.status} size={15} />}
                </span>
              </button>
            ))}
          </div>
        ))}

      {tab === 'log' && <LogTab run={r} live={live} />}
      {tab === 'info' && <InfoTab run={r} />}

      {lightbox != null && shots[lightbox] && <Lightbox shots={shots} index={lightbox} onIndex={setLightbox} onClose={() => setLightbox(null)} />}
      {healResult && <HealDialog run={r} result={healResult} live={live} onClose={() => setHealStep(null)} />}
    </Shell>
  )
}

function healLabel(h: HealProposal): string {
  return h.state === 'approved' ? 'Repair approved' : h.state === 'rejected' ? 'Repair rejected' : 'Needs review'
}

// ---------- Log ----------

/** Size of .log-preview in app.css. */
const PREVIEW_W = 360
const PREVIEW_H = 240

function LogTab({ run, live }: { run: Run; live: boolean }) {
  const [wrap, setWrap] = useState(true)
  const [hover, setHover] = useState<{ key: string; top: number; left: number } | null>(null)
  const byStep = useMemo(() => new Map(run.results.map((x) => [x.stepId, x])), [run.results])
  const from = run.range?.from ?? 1
  const to = run.range?.to ?? run.steps.length
  const runningId = live && run.status === 'running' ? run.steps.find((s, i) => !s.disabled && i + 1 >= from && i + 1 <= to && !byStep.has(s.id))?.id : undefined

  return (
    <div className="log">
      <div className="log-pane">
        <div className="log-head">Steps</div>
        <ol className="log-steps">
          {run.steps.map((s, i) => {
            const res = byStep.get(s.id)
            const out = s.disabled || i + 1 < from || i + 1 > to
            return (
              <li
                key={s.id}
                className={cx('log-step', res && `is-${res.status}`, out && 'is-out')}
                onMouseEnter={(e) => {
                  if (!res?.screenshotKey) return
                  // Stay inside the Steps pane, under the row (above it near the bottom of the window): the
                  // Console pane next to it is what the step list is read against.
                  const rect = e.currentTarget.getBoundingClientRect()
                  const below = rect.bottom + 6
                  setHover({ key: res.screenshotKey, top: below + PREVIEW_H > window.innerHeight - 8 ? Math.max(8, rect.top - 6 - PREVIEW_H) : below, left: Math.max(8, rect.right - PREVIEW_W) })
                }}
                onMouseLeave={() => setHover(null)}
              >
                <span className="log-n num">{i + 1}</span>
                <span className="log-sentence" title={res?.sentence ?? stepSentence(s)}>
                  {res?.sentence ?? stepSentence(s)}
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

function InfoTab({ run }: { run: Run }) {
  const total = run.results.reduce((n, x) => n + x.durationMs, 0)
  const rows: [string, React.ReactNode][] = [
    ['Status', STATUS_LABEL[run.status]],
    ['Test case', `${run.testCaseName} (#${run.testCaseNumber})`],
    ['Browser', run.environment.browser],
    ['Device', `${deviceOf(run.environment.device).label}${deviceOf(run.environment.device).isMobile ? ' (emulated: phone viewport, user agent and touch)' : ''}`],
    ['Viewport', `${run.environment.viewport.width} × ${run.environment.viewport.height}`],
    ['Base URL', run.environment.baseUrl || '–'],
    ['Step range', run.range ? `${run.range.from}–${run.range.to} of ${run.steps.length}` : `All ${run.steps.length} steps`],
    ['Self-healing', run.batchRunId ? 'On (batch run)' : 'Off (single run)'],
    ['Queued', dateTime(run.createdAt)],
    ['Started', dateTime(run.startedAt)],
    ['Finished', dateTime(run.finishedAt)],
    ['Duration', duration(run.startedAt, run.finishedAt)],
    ['Time in steps', ms(total)],
    ['Steps reported', `${run.results.length}`],
    ['Run id', <code key="id">{run.id}</code>],
  ]
  return (
    <div className="table-wrap">
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
    </div>
  )
}

// ---------- Lightbox ----------

function Lightbox({ shots, index, onIndex, onClose }: { shots: StepResult[]; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const s = shots[index]
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowLeft' && index > 0) onIndex(index - 1)
      if (e.key === 'ArrowRight' && index < shots.length - 1) onIndex(index + 1)
    }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [index, shots.length, onIndex, onClose])
  return createPortal(
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={`Screenshot of step ${s.number}`}>
      <header className="lightbox-bar">
        <span className="shot-n num">{s.number}</span>
        <span className="truncate lightbox-title" title={s.sentence}>
          {s.sentence}
        </span>
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
        <IconButton label="Close" onClick={onClose} autoFocus>
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
    </div>,
    document.body,
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
  const uis = useQuery({ queryKey: qk.uis(run.testCaseId), queryFn: () => api.uis(run.testCaseId), retry: false })
  const before: Ui | undefined = uis.data?.find((u) => u.id === heal.before.uiId)
  const decide = useMutation({
    mutationFn: (action: 'approve' | 'reject') => api.heal(run.id, result.stepId, action),
    onSuccess: (r) => {
      qc.setQueryData(qk.run(run.id), r)
      void qc.invalidateQueries({ queryKey: qk.testCase(run.testCaseId) })
      void qc.invalidateQueries({ queryKey: qk.uis(run.testCaseId) })
      if (run.batchRunId) void qc.invalidateQueries({ queryKey: qk.batchRun(run.batchRunId) })
      onClose()
    },
  })
  const open = heal.state === 'unresolved'
  const score = Math.round(heal.score * 100)

  return (
    <Dialog
      title={`Self-healing result, step ${result.number}`}
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
        ) : open ? (
          <>
            <span className="heal-foot-note">
              Approving saves the new locator to the step and to the element on its captured screen (the screenshot is not retaken). Rejecting marks this
              run as failed and changes nothing.
            </span>
            <Button variant="danger" busy={decide.isPending && decide.variables === 'reject'} disabled={decide.isPending} onClick={() => decide.mutate('reject')}>
              Reject
            </Button>
            <Button variant="primary" busy={decide.isPending && decide.variables === 'approve'} disabled={decide.isPending} onClick={() => decide.mutate('approve')} data-autofocus>
              {heal.warning ? 'Approve anyway' : 'Approve'}
            </Button>
          </>
        ) : (
          <>
            <span className="heal-foot-note">This repair was {heal.state}.</span>
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
