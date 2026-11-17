import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, Pencil } from 'lucide-react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { stepSentence } from '../../shared/commands'
import type { TestCase } from '../../shared/types'
import { api, qk } from '../api'
import { DeviceChip, Empty, ErrorState, InlineEdit, Loading, Shell, StatusIcon } from '../components/ui'
import { dateTime, duration, isTerminal, plural, STATUS_LABEL } from '../lib/format'

export function TestCasePage() {
  const { tid = '' } = useParams()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const tc = useQuery({ queryKey: qk.testCase(tid), queryFn: () => api.testCase(tid) })
  const pid = tc.data?.projectId
  const project = useQuery({ queryKey: qk.project(pid ?? ''), queryFn: () => api.project(pid!), enabled: !!pid })
  const runs = useQuery({
    queryKey: qk.runs(tid),
    queryFn: () => api.runs(tid),
    refetchInterval: (q) => (q.state.data?.some((r) => !isTerminal(r.status)) ? 1500 : false),
  })
  const update = useMutation({
    mutationFn: (b: { name?: string; description?: string }) => api.updateTestCase(tid, b),
    onSuccess: (next: TestCase) => {
      qc.setQueryData(qk.testCase(tid), next)
      void qc.invalidateQueries({ queryKey: qk.testCases(next.projectId) })
    },
  })

  if (tc.isPending) return <Shell><Loading /></Shell>
  if (tc.isError) return <Shell><ErrorState error={tc.error} onRetry={() => tc.refetch()} /></Shell>
  const t = tc.data
  const enabled = t.steps.filter((s) => !s.disabled)

  return (
    <Shell crumbs={[{ label: project.data?.name ?? 'Project', to: `/p/${t.projectId}` }, { label: t.name }]}>
      <div className="page-head">
        <div className="page-head-main">
          <h1 className="title-row">
            <InlineEdit label="test case name" value={t.name} onSave={(name) => update.mutate({ name })} />
            <span className="hash">#{t.number}</span>
            <DeviceChip device={t.device} />
          </h1>
          <div className="page-sub">
            <InlineEdit label="description" multiline value={t.description} placeholder="Add a description" onSave={(description) => update.mutate({ description })} />
          </div>
        </div>
        <div className="page-actions">
          <Link to={`/t/${t.id}/edit`} className="btn btn-primary">
            <Pencil size={15} />
            <span className="btn-label">Edit test case</span>
          </Link>
        </div>
      </div>

      <div className="split">
        <section className="panel">
          <h2>Steps</h2>
          {t.steps.length === 0 ? (
            <p className="muted">No steps yet. Open the editor to capture a screen and add the first step.</p>
          ) : (
            <>
              <ol className="outline">
                {t.steps.map((s, i) => (
                  <li key={s.id} className={s.disabled ? 'is-disabled' : undefined}>
                    <span className="outline-n num">{i + 1}</span>
                    <span className="truncate" title={stepSentence(s)}>
                      {stepSentence(s)}
                    </span>
                  </li>
                ))}
              </ol>
              <p className="muted outline-foot">
                {plural(t.steps.length, 'step')}
                {enabled.length !== t.steps.length && `, ${t.steps.length - enabled.length} disabled`}. Updated {dateTime(t.updatedAt)}.
              </p>
            </>
          )}
        </section>

        <section>
          <h2 className="section-title">Recent runs</h2>
          {runs.isPending ? (
            <Loading />
          ) : runs.isError ? (
            <ErrorState error={runs.error} onRetry={() => runs.refetch()} />
          ) : runs.data.length === 0 ? (
            <Empty title="Not run yet">Run this test case from the editor to see its results here.</Empty>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Status</th>
                    <th className="col-fit">Started</th>
                    <th className="col-fit">Duration</th>
                    <th className="col-fit" />
                  </tr>
                </thead>
                <tbody>
                  {runs.data.map((r) => (
                    <tr key={r.id} className="row-link" onClick={() => navigate(`/r/${r.id}`)}>
                      <td>
                        <Link to={`/r/${r.id}`} className="status-text status-link" onClick={(e) => e.stopPropagation()}>
                          <StatusIcon status={r.status} />
                          {STATUS_LABEL[r.status]}
                        </Link>
                        {r.range && <span className="chip chip-quiet">Steps {r.range.from === r.range.to ? r.range.from : `${r.range.from}–${r.range.to}`}</span>}
                      </td>
                      <td className="col-fit num">{dateTime(r.startedAt ?? r.createdAt)}</td>
                      <td className="col-fit num">{duration(r.startedAt, r.finishedAt)}</td>
                      <td className="col-fit">
                        <ChevronRight size={16} className="muted" aria-hidden />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </Shell>
  )
}
