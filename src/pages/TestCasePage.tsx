import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, Pencil } from 'lucide-react'
import { useMemo } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { stepSentence } from '../../shared/commands'
import { patternSummary } from '../../shared/data'
import type { TestCase } from '../../shared/types'
import { sharedLookup } from '../editor/model'
import { api, qk } from '../api'
import { DataGrid, useDataDraft } from '../components/DataGrid'
import { Button, DeviceChip, Empty, ErrorState, InlineEdit, Loading, Shell, StatusIcon, TableWrap } from '../components/ui'
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
  // To name the shared steps this test case calls.
  const calls = tc.data?.kind === 'test' && tc.data.steps.some((s) => s.command === 'shared_step')
  const sharedSteps = useQuery({ queryKey: qk.sharedSteps(pid ?? ''), queryFn: () => api.sharedSteps(pid!), enabled: !!pid && !!calls })
  const shared = useMemo(() => sharedLookup(sharedSteps.data), [sharedSteps.data])
  const update = useMutation({
    mutationFn: (b: { name?: string; description?: string }) => api.updateTestCase(tid, b),
    onSuccess: (next: TestCase) => {
      qc.setQueryData(qk.testCase(tid), next)
      void qc.invalidateQueries({ queryKey: next.kind === 'shared' ? qk.sharedSteps(next.projectId) : qk.testCases(next.projectId) })
    },
  })

  if (tc.isPending) return <Shell><Loading /></Shell>
  if (tc.isError) return <Shell><ErrorState error={tc.error} onRetry={() => tc.refetch()} /></Shell>
  const t = tc.data
  const enabled = t.steps.filter((s) => !s.disabled)
  const isShared = t.kind === 'shared'
  const what = isShared ? 'shared step' : 'test case'
  const crumbs = [
    { label: project.data?.name ?? 'Project', to: `/p/${t.projectId}` },
    ...(isShared ? [{ label: 'Shared steps', to: `/p/${t.projectId}?tab=shared` }] : []),
    { label: t.name },
  ]

  return (
    <Shell crumbs={crumbs}>
      <div className="page-head">
        <div className="page-head-main">
          <h1 className="title-row">
            <InlineEdit label={`${what} name`} value={t.name} onSave={(name) => update.mutate({ name })} />
            <span className="hash">{isShared ? `S${t.number}` : `#${t.number}`}</span>
            {isShared && <span className="chip chip-quiet">Shared step</span>}
            <DeviceChip device={t.device} />
          </h1>
          <div className="page-sub">
            <InlineEdit label="description" multiline value={t.description} placeholder="Add a description" onSave={(description) => update.mutate({ description })} />
          </div>
        </div>
        <div className="page-actions">
          <Link to={`/t/${t.id}/edit`} className="btn btn-primary">
            <Pencil size={15} />
            <span className="btn-label">Edit {what}</span>
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
                    <span>
                      {stepSentence(s, sharedSteps.data ? shared : undefined)}
                      {s.command === 'shared_step' && s.value && shared(s.value) && (
                        <>
                          {' '}
                          <Link to={`/t/${s.value}`} className="outline-link">
                            ({plural(shared(s.value)!.steps.length, 'step')})
                          </Link>
                        </>
                      )}
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
          {isShared && (
            <>
              <h2 className="panel-gap">Used by</h2>
              {!t.usedBy?.length ? (
                <p className="muted">No test case calls this shared step yet. Add it to a test case in the editor with the “Shared step” command.</p>
              ) : (
                <ul className="used-by">
                  {t.usedBy.map((u) => (
                    <li key={u.id}>
                      <Link to={`/t/${u.id}`}>{u.name}</Link> <span className="hash">#{u.number}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="muted outline-foot">Editing these steps changes every test case that calls them. It runs on the device of the test case that calls it.</p>
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
            <Empty title="Not run yet">
              {isShared
                ? 'A shared step runs as part of the test cases that call it. To try it by itself, run it from the editor.'
                : 'Run this test case from the editor to see its results here.'}
            </Empty>
          ) : (
            <TableWrap label="Recent runs">
              <table className="table table-list">
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
                        {r.patterns && (
                          <span className="chip chip-quiet">{r.patterns.length === 1 ? `Data row ${r.patterns[0].index}` : isTerminal(r.status) ? patternSummary(r.patterns) : `${r.patterns.length} patterns`}</span>
                        )}
                      </td>
                      <td className="col-fit num" data-label="Started">
                        {dateTime(r.startedAt ?? r.createdAt)}
                      </td>
                      <td className="col-fit num" data-label="Duration">
                        {duration(r.startedAt, r.finishedAt)}
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
        </section>
      </div>
      {!isShared && <DataPanel testCase={t} />}
    </Shell>
  )
}

/** The data table of the test case. Saved explicitly: a half-typed table should not change what the next run does. */
function DataPanel({ testCase }: { testCase: TestCase }) {
  const { draft, setDraft, dirty, problems, save, discard } = useDataDraft(testCase)
  return (
    <form
      className="panel data-panel"
      id="data"
      onSubmit={(e) => {
        e.preventDefault()
        if (dirty && problems.length === 0) save.mutate()
      }}
    >
      <h2>Data</h2>
      <p className="muted">
        With data, a run executes the steps once for every row (a pattern), one after the other, each in a fresh browser. A step reads a cell as{' '}
        <code>{'${COLUMN}'}</code>; a column wins over a project variable of the same name.
      </p>
      <DataGrid value={draft} onChange={setDraft} disabled={save.isPending} />
      {save.isError && (
        <p className="form-error" role="alert">
          {save.error.message}
        </p>
      )}
      <div className="panel-foot">
        <Button type="submit" variant="primary" busy={save.isPending} disabled={!dirty || problems.length > 0}>
          Save data
        </Button>
        <Button disabled={!dirty || save.isPending} onClick={discard}>
          Discard changes
        </Button>
        {dirty && <span className="muted">Unsaved changes</span>}
      </div>
    </form>
  )
}
