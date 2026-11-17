import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronRight, Copy, CopyPlus, MoreHorizontal, Play, Plus, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { isBuiltInVariable } from '../../shared/commands'
import type { BatchRun, Project, TestCase } from '../../shared/types'
import { api, qk } from '../api'
import { Button, Confirm, DeviceChip, Empty, ErrorState, Field, IconButton, Loading, MenuButton, Shell, StatusIcon, Tabs, toast } from '../components/ui'
import { clock, dateTime, isTerminal, plural, STATUS_LABEL } from '../lib/format'

type TabId = 'cases' | 'batches' | 'settings'

export function ProjectPage() {
  const { pid = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const tab = (['cases', 'batches', 'settings'] as const).find((t) => t === params.get('tab')) ?? 'cases'
  const project = useQuery({ queryKey: qk.project(pid), queryFn: () => api.project(pid) })
  const cases = useQuery({ queryKey: qk.testCases(pid), queryFn: () => api.testCases(pid) })
  const batches = useQuery({
    queryKey: qk.batchRuns(pid),
    queryFn: () => api.batchRuns(pid),
    refetchInterval: (q) => (q.state.data?.some((b) => !isTerminal(b.status)) ? 2000 : false),
  })

  if (project.isPending) return <Shell><Loading /></Shell>
  if (project.isError) return <Shell><ErrorState error={project.error} onRetry={() => project.refetch()} /></Shell>
  const p = project.data

  return (
    <Shell crumbs={[{ label: p.name }]}>
      <div className="page-head">
        <div className="page-head-main">
          <h1>{p.name}</h1>
          {p.description && <p className="page-sub">{p.description}</p>}
        </div>
      </div>
      <Tabs<TabId>
        value={tab}
        onChange={(id) => setParams(id === 'cases' ? {} : { tab: id }, { replace: true })}
        tabs={[
          { id: 'cases', label: 'Test cases', count: cases.data?.length ?? p.testCaseCount ?? 0 },
          { id: 'batches', label: 'Batch runs', count: batches.data?.length ?? p.batchRunCount ?? 0 },
          { id: 'settings', label: 'Settings' },
        ]}
      />
      {tab === 'cases' &&
        (cases.isPending ? <Loading /> : cases.isError ? <ErrorState error={cases.error} onRetry={() => cases.refetch()} /> : <TestCasesTab pid={pid} cases={cases.data} />)}
      {tab === 'batches' &&
        (batches.isPending ? <Loading /> : batches.isError ? <ErrorState error={batches.error} onRetry={() => batches.refetch()} /> : <BatchRunsTab batches={batches.data} />)}
      {tab === 'settings' && <SettingsTab key={p.id} project={p} />}
    </Shell>
  )
}

function TestCasesTab({ pid, cases }: { pid: string; cases: TestCase[] }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [deleting, setDeleting] = useState<TestCase | null>(null)
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: qk.testCases(pid) })
    void qc.invalidateQueries({ queryKey: qk.project(pid) })
  }
  const create = useMutation({
    mutationFn: () => api.createTestCase(pid, { name: 'New test' }),
    onSuccess: (tc) => {
      refresh()
      navigate(`/t/${tc.id}/edit`)
    },
  })
  const duplicate = useMutation({ mutationFn: (id: string) => api.duplicateTestCase(id), onSuccess: refresh })
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteTestCase(id),
    onSuccess: (_r, id) => {
      setDeleting(null)
      setSelected((s) => {
        const n = new Set(s)
        n.delete(id)
        return n
      })
      refresh()
    },
  })
  const picked = useMemo(() => cases.filter((c) => selected.has(c.id)).map((c) => c.id), [cases, selected])
  const batch = useMutation({
    mutationFn: () => api.startBatchRun(pid, picked.length ? picked : undefined),
    onSuccess: (b) => {
      void qc.invalidateQueries({ queryKey: qk.batchRuns(pid) })
      navigate(`/b/${b.id}`)
    },
  })
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  const allChecked = cases.length > 0 && picked.length === cases.length

  if (cases.length === 0) {
    return (
      <Empty
        title="No test cases yet"
        action={
          <Button variant="primary" icon={<Plus size={16} />} busy={create.isPending} onClick={() => create.mutate()}>
            New test case
          </Button>
        }
      >
        A test case is a list of steps run in a real browser. Start one, capture a screen, and click its elements to build steps.
      </Empty>
    )
  }

  return (
    <>
      <div className="toolbar">
        <span className="muted">{picked.length ? `${picked.length} selected` : 'Batch runs execute test cases top to bottom.'}</span>
        <span className="toolbar-gap" />
        <Button icon={<Play size={15} />} busy={batch.isPending} onClick={() => batch.mutate()}>
          {picked.length ? `Run batch (${picked.length})` : 'Run batch (all)'}
        </Button>
        <Button variant="primary" icon={<Plus size={16} />} busy={create.isPending} onClick={() => create.mutate()}>
          New test case
        </Button>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="col-fit">
                <input
                  type="checkbox"
                  className="check"
                  aria-label="Select all test cases"
                  checked={allChecked}
                  ref={(el) => {
                    if (el) el.indeterminate = picked.length > 0 && !allChecked
                  }}
                  onChange={() => setSelected(allChecked ? new Set() : new Set(cases.map((c) => c.id)))}
                />
              </th>
              <th>Name</th>
              <th className="col-fit">Device</th>
              <th className="col-fit">Steps</th>
              <th className="col-fit">Last run</th>
              <th className="col-fit" />
            </tr>
          </thead>
          <tbody>
            {cases.map((c) => (
              <tr key={c.id}>
                <td className="col-fit">
                  <input type="checkbox" className="check" aria-label={`Select ${c.name}`} checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
                </td>
                <td className="col-main">
                  <div className="cell-name">
                    <Link to={`/t/${c.id}`} title={c.name}>
                      {c.name}
                    </Link>
                    <span className="hash">#{c.number}</span>
                  </div>
                  {c.description && (
                    <div className="cell-desc" title={c.description}>
                      {c.description}
                    </div>
                  )}
                </td>
                <td className="col-fit">
                  <DeviceChip device={c.device} />
                </td>
                <td className="col-fit num">{c.steps.length}</td>
                <td className="col-fit">
                  {c.lastRun ? (
                    <Link to={`/r/${c.lastRun.id}`} className="last-run" title={`${STATUS_LABEL[c.lastRun.status]} · ${dateTime(c.lastRun.finishedAt)}`}>
                      <StatusIcon status={c.lastRun.status} />
                    </Link>
                  ) : (
                    <span className="muted" title="Never run">
                      –
                    </span>
                  )}
                </td>
                <td className="col-fit">
                  <MenuButton
                    className="icon-btn"
                    label={`Actions for ${c.name}`}
                    items={[
                      { label: 'Duplicate', icon: <CopyPlus size={15} />, onSelect: () => duplicate.mutate(c.id) },
                      { label: 'Delete', icon: <Trash2 size={15} />, danger: true, onSelect: () => setDeleting(c) },
                    ]}
                  >
                    <MoreHorizontal size={16} />
                  </MenuButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {deleting && (
        <Confirm title="Delete test case?" confirmLabel="Delete test case" busy={remove.isPending} onConfirm={() => remove.mutate(deleting.id)} onClose={() => setDeleting(null)}>
          “{deleting.name}” (#{deleting.number}) and its captured screens will be deleted. Results of past runs are kept.
        </Confirm>
      )}
    </>
  )
}

export function CountPills({ counts }: { counts: BatchRun['counts'] }) {
  const items = [
    ['succeeded', counts.succeeded],
    ['failed', counts.failed],
    ['unresolved', counts.unresolved],
    ['aborted', counts.aborted],
  ] as const
  return (
    <span className="counts">
      {items.map(([status, n]) => (
        <span key={status} className={n ? 'count' : 'count is-zero'} title={`${n} ${STATUS_LABEL[status].toLowerCase()}`}>
          <StatusIcon status={status} size={15} />
          <span className="num">{n}</span>
        </span>
      ))}
      <span className="muted num">of {counts.total}</span>
    </span>
  )
}

function BatchRunsTab({ batches }: { batches: BatchRun[] }) {
  const navigate = useNavigate()
  if (batches.length === 0) {
    return (
      <Empty title="No batch runs yet">
        A batch run executes several test cases in a row and repairs broken locators along the way. Start one from the Test cases tab, or trigger it from CI
        with the command under Settings.
      </Empty>
    )
  }
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th className="col-fit">Status</th>
            <th className="col-fit">#</th>
            <th>Results</th>
            <th className="col-fit">Duration</th>
            <th className="col-fit">Started</th>
            <th className="col-fit" />
          </tr>
        </thead>
        <tbody>
          {batches.map((b) => (
            <tr key={b.id} className="row-link" onClick={() => navigate(`/b/${b.id}`)}>
              <td className="col-fit">
                <span className="status-text">
                  <StatusIcon status={b.status} />
                  {STATUS_LABEL[b.status]}
                </span>
              </td>
              <td className="col-fit">
                <Link to={`/b/${b.id}`} onClick={(e) => e.stopPropagation()} className="num">
                  #{b.number}
                </Link>
              </td>
              <td>
                <CountPills counts={b.counts} />
                {b.trigger === 'api' && <span className="chip chip-quiet">API</span>}
              </td>
              <td className="col-fit num">{clock(b.startedAt, b.finishedAt)}</td>
              <td className="col-fit num">{dateTime(b.startedAt ?? b.createdAt)}</td>
              <td className="col-fit">
                <ChevronRight size={16} className="muted" aria-hidden />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

interface VarRow {
  key: number
  name: string
  value: string
}
let rowKey = 1
const toRows = (v: Record<string, string>): VarRow[] => Object.entries(v).map(([name, value]) => ({ key: rowKey++, name, value }))
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

function SettingsTab({ project }: { project: Project }) {
  const qc = useQueryClient()
  const [name, setName] = useState(project.name)
  const [description, setDescription] = useState(project.description)
  const [baseUrl, setBaseUrl] = useState(project.baseUrl)
  const [rows, setRows] = useState<VarRow[]>(() => toRows(project.variables))
  const [copied, setCopied] = useState(false)

  const names = rows.map((r) => r.name.trim()).filter(Boolean)
  const badRow = rows.find((r) => r.name.trim() && !VAR_NAME.test(r.name.trim()))
  const duplicate = names.find((n, i) => names.indexOf(n) !== i)
  const builtIn = names.find(isBuiltInVariable)
  const varError = badRow
    ? `“${badRow.name}” is not a valid name. Use letters, digits and underscores, starting with a letter.`
    : duplicate
      ? `“${duplicate}” is defined twice.`
      : builtIn
        ? builtIn === 'BASE_URL'
          ? 'BASE_URL is built in. Set it with the Base URL field.'
          : `${builtIn} is built in (every run sets it), so it cannot be a project variable. Use another name.`
        : null
  const variables = Object.fromEntries(rows.filter((r) => r.name.trim()).map((r) => [r.name.trim(), r.value]))
  const dirty =
    name.trim() !== project.name ||
    description !== project.description ||
    baseUrl.trim() !== project.baseUrl ||
    JSON.stringify(variables) !== JSON.stringify(project.variables)

  const save = useMutation({
    mutationFn: () => api.updateProject(project.id, { name: name.trim(), description, baseUrl: baseUrl.trim(), variables }),
    onSuccess: (p) => {
      qc.setQueryData(qk.project(p.id), p)
      void qc.invalidateQueries({ queryKey: qk.projects })
      toast('Settings saved')
    },
  })

  const curl = `curl -X POST "${location.origin}/api/projects/${project.id}/batch-runs" \\\n  -H "content-type: application/json" \\\n  -d '{"trigger":"api"}'`
  useEffect(() => {
    if (!copied) return
    const t = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(t)
  }, [copied])

  return (
    <div className="settings">
      <form
        className="panel"
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim() && !varError) save.mutate()
        }}
      >
        <h2>Project</h2>
        <Field label="Name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        </Field>
        <Field label="Description">
          <textarea className="input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="Base URL" hint={<>Available in steps as <code>{'${BASE_URL}'}</code>. Relative Navigate URLs resolve against it.</>}>
          <input className="input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://staging.example.com" />
        </Field>

        <h2 className="panel-gap">Variables</h2>
        <p className="muted">
          Shared by every test case in this project. Use one in any step value as <code>{'${NAME}'}</code>.
        </p>
        <div className="vars">
          {rows.map((r, i) => (
            <div className="var-row" key={r.key}>
              <input
                className="input mono"
                aria-label={`Variable ${i + 1} name`}
                placeholder="NAME"
                value={r.name}
                onChange={(e) => setRows(rows.map((x) => (x.key === r.key ? { ...x, name: e.target.value } : x)))}
              />
              <input
                className="input"
                aria-label={`Variable ${i + 1} value`}
                placeholder="Value"
                value={r.value}
                onChange={(e) => setRows(rows.map((x) => (x.key === r.key ? { ...x, value: e.target.value } : x)))}
              />
              <IconButton label="Remove variable" onClick={() => setRows(rows.filter((x) => x.key !== r.key))}>
                <X size={16} />
              </IconButton>
            </div>
          ))}
          <div>
            <Button size="sm" icon={<Plus size={14} />} onClick={() => setRows([...rows, { key: rowKey++, name: '', value: '' }])}>
              Add variable
            </Button>
          </div>
          {varError && (
            <p className="form-error" role="alert">
              {varError}
            </p>
          )}
        </div>
        <div className="panel-foot">
          <Button type="submit" variant="primary" busy={save.isPending} disabled={!dirty || !name.trim() || !!varError}>
            Save settings
          </Button>
          {dirty && <span className="muted">Unsaved changes</span>}
        </div>
      </form>

      <section className="panel">
        <h2>Run from CI</h2>
        <p className="muted">
          This request starts a batch run of every test case ({plural(project.testCaseCount ?? 0, 'test case')} now) and returns its id. Poll{' '}
          <code>GET /api/batch-runs/&lt;id&gt;</code> until <code>status</code> is no longer <code>queued</code> or <code>running</code>. If the workspace has
          an access code, send the session cookie with both requests.
        </p>
        <div className="snippet">
          <pre>{curl}</pre>
          <Button
            size="sm"
            icon={copied ? <Check size={14} /> : <Copy size={14} />}
            onClick={() => {
              void navigator.clipboard.writeText(curl).then(() => setCopied(true))
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      </section>
    </div>
  )
}
