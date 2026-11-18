import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, Square } from 'lucide-react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { patternSummary } from '../../shared/data'
import type { RunStatus } from '../../shared/types'
import { api, qk } from '../api'
import { Button, DeviceChip, Empty, ErrorState, Loading, Shell, StaleNotice, StatusIcon, TableWrap } from '../components/ui'
import { clock, dateTime, isTerminal, STATUS_LABEL } from '../lib/format'
import { useTick } from '../lib/hooks'

export function BatchRunPage() {
  const { bid = '' } = useParams()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const batch = useQuery({
    queryKey: qk.batchRun(bid),
    queryFn: () => api.batchRun(bid),
    refetchInterval: (q) => (q.state.data && isTerminal(q.state.data.status) ? false : 1500),
  })
  const pid = batch.data?.projectId
  const project = useQuery({ queryKey: qk.project(pid ?? ''), queryFn: () => api.project(pid!), enabled: !!pid })
  const abort = useMutation({
    mutationFn: () => api.abortBatchRun(bid),
    onSuccess: (b) => {
      // The abort response may omit `runs`; keep the ones we have.
      qc.setQueryData(qk.batchRun(bid), (old: typeof b | undefined) => ({ ...b, runs: b.runs ?? old?.runs }))
      void qc.invalidateQueries({ queryKey: qk.batchRun(bid) })
    },
  })
  const live = !!batch.data && !isTerminal(batch.data.status)
  useTick(live)

  // A failed refresh of a report that is on screen (it is polled while it runs) does not take the report away.
  if (batch.isError && !batch.data) return <Shell><ErrorState error={batch.error} onRetry={() => batch.refetch()} /></Shell>
  const b = batch.data
  if (!b) return <Shell><Loading /></Shell>
  const runs = b.runs ?? []
  const summary: { status: RunStatus; n: number }[] = [
    { status: 'succeeded', n: b.counts.succeeded },
    { status: 'failed', n: b.counts.failed },
    { status: 'unresolved', n: b.counts.unresolved },
    { status: 'aborted', n: b.counts.aborted },
  ]

  return (
    <Shell
      crumbs={[
        { label: project.data?.name ?? 'Project', to: `/p/${b.projectId}` },
        { label: 'Batch runs', to: `/p/${b.projectId}?tab=batches` },
        { label: `#${b.number}` },
      ]}
    >
      <div className="page-head">
        <div className="page-head-main result-head">
          <StatusIcon status={b.status} size={34} />
          <div>
            <h1>
              Batch run #{b.number} <span className={`result-word status-${b.status}`}>{STATUS_LABEL[b.status]}</span>
            </h1>
            <p className="page-sub num">
              {b.trigger === 'api' ? 'Triggered by API' : 'Started manually'}, {dateTime(b.startedAt ?? b.createdAt)}. Duration {clock(b.startedAt, b.finishedAt)}.
            </p>
          </div>
        </div>
        <div className="page-actions">
          {live && (
            <Button icon={<Square size={14} />} busy={abort.isPending} onClick={() => abort.mutate()}>
              Abort
            </Button>
          )}
        </div>
      </div>

      {batch.isError && <StaleNotice live={live} />}

      <dl className="summary">
        <div className="summary-cell">
          <dt>Total</dt>
          <dd className="num">{b.counts.total}</dd>
        </div>
        {summary.map((s) => (
          <div className={s.n ? 'summary-cell' : 'summary-cell is-zero'} key={s.status}>
            <dt>
              <StatusIcon status={s.status} size={16} />
              {STATUS_LABEL[s.status]}
            </dt>
            <dd className="num">{s.n}</dd>
          </div>
        ))}
      </dl>

      {runs.length === 0 ? (
        <Empty title="No test cases in this batch run">The project had no test cases when this run started.</Empty>
      ) : (
        <TableWrap label="Test cases in this batch run">
          <table className="table table-list">
            <thead>
              <tr>
                <th className="col-fit">Status</th>
                <th className="col-fit">#</th>
                <th>Test case</th>
                <th className="col-fit">Device</th>
                <th className="col-fit">Duration</th>
                <th className="col-fit">Started</th>
                <th className="col-fit" />
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="row-link" onClick={() => navigate(`/r/${r.id}`)}>
                  <td className="col-fit">
                    <span className="status-text">
                      <StatusIcon status={r.status} size={20} />
                      {STATUS_LABEL[r.status]}
                    </span>
                  </td>
                  <td className="col-fit num">{r.order}</td>
                  <th scope="row" className="col-main">
                    <div className="cell-name">
                      <Link to={`/r/${r.id}`} onClick={(e) => e.stopPropagation()} title={r.testCaseName}>
                        {r.testCaseName}
                      </Link>
                      <span className="hash">#{r.testCaseNumber}</span>
                    </div>
                    {r.patterns && (
                      // A data-driven test case is one line of the batch, whatever its number of data rows.
                      <div className="cell-sub muted num">
                        {isTerminal(r.status) ? patternSummary(r.patterns) : `${r.patterns.filter((p) => isTerminal(p.status)).length} of ${r.patterns.length} patterns done`}
                      </div>
                    )}
                  </th>
                  <td className="col-fit" data-label="Device">
                    <DeviceChip device={r.environment.device} />
                  </td>
                  <td className="col-fit num" data-label="Duration">
                    {clock(r.startedAt, r.finishedAt)}
                  </td>
                  <td className="col-fit num" data-label="Started">
                    {dateTime(r.startedAt)}
                  </td>
                  <td className="col-fit">
                    <ChevronRight size={16} className="muted" aria-hidden />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </Shell>
  )
}
