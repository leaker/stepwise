import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronRight, Copy, CopyPlus, MoreHorizontal, Pencil, Play, Plus, Trash2, X } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { isBuiltInVariable, validateSteps } from '../../shared/commands'
import type { BatchRun, Project, TestCase } from '../../shared/types'
import { baseUrlProblem } from '../../shared/url'
import { api, qk } from '../api'
import { Button, Confirm, DeviceChip, Dialog, Empty, ErrorState, Field, IconButton, Loading, MenuButton, Shell, StatusIcon, TableWrap, Tabs, toast } from '../components/ui'
import { clock, dateTime, isTerminal, plural, STATUS_LABEL } from '../lib/format'

type TabId = 'cases' | 'shared' | 'batches' | 'settings'

export function ProjectPage() {
  const { pid = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const tab = (['cases', 'shared', 'batches', 'settings'] as const).find((t) => t === params.get('tab')) ?? 'cases'
  const project = useQuery({ queryKey: qk.project(pid), queryFn: () => api.project(pid) })
  const cases = useQuery({
    queryKey: qk.testCases(pid),
    queryFn: () => api.testCases(pid),
    // The "Last run" column of a test case that is queued or running is followed until it has a result.
    refetchInterval: (q) => (q.state.data?.some((c) => c.lastRun && !isTerminal(c.lastRun.status)) ? 2000 : false),
  })
  const shared = useQuery({ queryKey: qk.sharedSteps(pid), queryFn: () => api.sharedSteps(pid) })
  const batches = useQuery({
    queryKey: qk.batchRuns(pid),
    queryFn: () => api.batchRuns(pid),
    refetchInterval: (q) => (q.state.data?.some((b) => !isTerminal(b.status)) ? 2000 : false),
  })

  if (project.isPending) return <Shell><Loading /></Shell>
  // Only when there is nothing to show: a list that is on screen stays there when a refresh of it fails.
  if (project.isError && !project.data) return <Shell><ErrorState error={project.error} onRetry={() => project.refetch()} /></Shell>
  const p = project.data
  if (!p) return <Shell><Loading /></Shell>

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
          { id: 'shared', label: 'Shared steps', count: shared.data?.length ?? 0 },
          { id: 'batches', label: 'Batch runs', count: batches.data?.length ?? p.batchRunCount ?? 0 },
          { id: 'settings', label: 'Settings' },
        ]}
        label="Project sections"
      >
      {tab === 'cases' &&
        (cases.data ? <TestCasesTab pid={pid} cases={cases.data} /> : cases.isError ? <ErrorState error={cases.error} onRetry={() => cases.refetch()} /> : <Loading />)}
      {tab === 'shared' &&
        (shared.data ? <SharedStepsTab pid={pid} list={shared.data} /> : shared.isError ? <ErrorState error={shared.error} onRetry={() => shared.refetch()} /> : <Loading />)}
      {tab === 'batches' &&
        (batches.data ? <BatchRunsTab batches={batches.data} /> : batches.isError ? <ErrorState error={batches.error} onRetry={() => batches.refetch()} /> : <Loading />)}
      {tab === 'settings' && <SettingsTab key={p.id} project={p} />}
      </Tabs>
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
      <TableWrap label="Test cases">
        <table className="table table-list">
          <thead>
            <tr>
              <th className="col-fit col-check">
                {/* The label is the click target: a 15px box alone is too small to hit. */}
                <label className="check-hit">
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
                </label>
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
                  <label className="check-hit">
                    <input type="checkbox" className="check" aria-label={`Select ${c.name}`} checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
                  </label>
                </td>
                <th scope="row" className="col-main">
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
                </th>
                <td className="col-fit" data-label="Device">
                  <DeviceChip device={c.device} />
                </td>
                <td className="col-fit num" data-label="Steps">
                  {c.steps.length}
                </td>
                <td className="col-fit" data-label="Last run">
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
      </TableWrap>
      {deleting && (
        <Confirm title="Delete test case?" confirmLabel="Delete test case" busy={remove.isPending} onConfirm={() => remove.mutate(deleting.id)} onClose={() => setDeleting(null)}>
          “{deleting.name}” (#{deleting.number}), its captured screens and the results of its single runs will be deleted. Its results inside batch runs are
          kept.
        </Confirm>
      )}
    </>
  )
}

function SharedStepsTab({ pid, list }: { pid: string; list: TestCase[] }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [renaming, setRenaming] = useState<TestCase | null>(null)
  const [deleting, setDeleting] = useState<TestCase | null>(null)
  const refresh = () => void qc.invalidateQueries({ queryKey: qk.sharedSteps(pid) })
  const create = useMutation({
    mutationFn: () => api.createSharedStep(pid),
    onSuccess: (t) => {
      refresh()
      navigate(`/t/${t.id}/edit`)
    },
  })
  const duplicate = useMutation({ mutationFn: (id: string) => api.duplicateTestCase(id), onSuccess: refresh })
  const rename = useMutation({
    mutationFn: (v: { id: string; name: string }) => api.updateTestCase(v.id, { name: v.name }),
    onSuccess: (t) => {
      qc.setQueryData(qk.testCase(t.id), t)
      setRenaming(null)
      refresh()
    },
  })
  // The row whose menu opened the dialog is gone after a delete, and focus with it: it goes to "New shared step".
  const deleted = useRef<string | null>(null)
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteTestCase(id),
    onSuccess: (_, id) => {
      deleted.current = id
    },
    // Also after a refusal: the list of callers may be what changed.
    onSettled: () => {
      setDeleting(null)
      refresh()
    },
  })
  useEffect(() => {
    if (!deleted.current || list.some((t) => t.id === deleted.current)) return
    deleted.current = null
    document.querySelector<HTMLElement>('[data-new-shared]')?.focus()
  }, [list])
  const newButton = (
    <Button variant="primary" icon={<Plus size={16} />} busy={create.isPending} onClick={() => create.mutate()} data-new-shared>
      New shared step
    </Button>
  )

  if (list.length === 0) {
    return (
      <Empty title="No shared steps yet" action={newButton}>
        A shared step is a sequence of steps, such as signing in, that several test cases call with the “Shared step” command. Editing it changes every
        test case that calls it.
      </Empty>
    )
  }

  return (
    <>
      <div className="toolbar">
        <span className="muted">Test cases call these with the “Shared step” command. Editing one changes every test case that calls it.</span>
        <span className="toolbar-gap" />
        {newButton}
      </div>
      <TableWrap label="Shared steps">
        <table className="table table-list">
          <thead>
            <tr>
              <th className="col-fit">#</th>
              <th>Name</th>
              <th className="col-fit">Steps</th>
              <th>Used by</th>
              <th className="col-fit" />
            </tr>
          </thead>
          <tbody>
            {list.map((t) => {
              const usedBy = t.usedBy ?? []
              return (
                <tr key={t.id}>
                  <td className="col-fit num">
                    <span className="hash">S{t.number}</span>
                  </td>
                  <th scope="row" className="col-main">
                    <div className="cell-name">
                      <Link to={`/t/${t.id}`} title={t.name}>
                        {t.name}
                      </Link>
                    </div>
                    {t.description && (
                      <div className="cell-desc" title={t.description}>
                        {t.description}
                      </div>
                    )}
                    {/* Saved as it is (the editor saves while an If block is being written), but nothing that calls it can run. */}
                    {validateSteps(t.steps).length > 0 && (
                      <div className="cell-desc form-error">
                        Its If / Otherwise / End steps do not balance{usedBy.length > 0 ? `: ${plural(usedBy.length, 'test case')} that ${usedBy.length === 1 ? 'calls' : 'call'} it cannot run until it is` : ''}.
                      </div>
                    )}
                  </th>
                  <td className="col-fit num" data-label="Steps">
                    {t.steps.length}
                  </td>
                  <td data-label="Used by">
                    {usedBy.length === 0 ? (
                      <span className="muted">Not used</span>
                    ) : (
                      <span className="used-by-cell" title={usedBy.map((u) => `#${u.number} ${u.name}`).join('\n')}>
                        <span className="num">{plural(usedBy.length, 'test case')}</span>
                        <span className="muted">
                          {usedBy
                            .slice(0, 3)
                            .map((u) => `#${u.number}`)
                            .join(', ')}
                          {usedBy.length > 3 && ', …'}
                        </span>
                      </span>
                    )}
                  </td>
                  <td className="col-fit">
                    <MenuButton
                      className="icon-btn"
                      label={`Actions for ${t.name}`}
                      items={[
                        { label: 'Open in the editor', icon: <Pencil size={15} />, onSelect: () => navigate(`/t/${t.id}/edit`) },
                        { label: 'Rename', icon: <Pencil size={15} />, onSelect: () => setRenaming(t) },
                        { label: 'Duplicate', icon: <CopyPlus size={15} />, onSelect: () => duplicate.mutate(t.id) },
                        { label: 'Delete', icon: <Trash2 size={15} />, danger: true, onSelect: () => setDeleting(t) },
                      ]}
                    >
                      <MoreHorizontal size={16} />
                    </MenuButton>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </TableWrap>
      {renaming && <RenameDialog current={renaming.name} busy={rename.isPending} onSave={(name) => rename.mutate({ id: renaming.id, name })} onClose={() => setRenaming(null)} />}
      {deleting &&
        ((deleting.usedBy ?? []).length > 0 ? (
          // The server refuses this too; saying why here saves the round trip.
          <Dialog
            title="This shared step is in use"
            onClose={() => setDeleting(null)}
            width={460}
            footer={
              <Button onClick={() => setDeleting(null)} data-autofocus>
                Close
              </Button>
            }
          >
            <p className="confirm-text">
              “{deleting.name}” (S{deleting.number}) cannot be deleted while {plural(deleting.usedBy!.length, 'test case calls', 'test cases call')} it. Remove the
              step from:
            </p>
            <ul className="used-by">
              {deleting.usedBy!.map((u) => (
                <li key={u.id}>
                  <Link to={`/t/${u.id}/edit`}>{u.name}</Link> <span className="hash">#{u.number}</span>
                </li>
              ))}
            </ul>
          </Dialog>
        ) : (
          <Confirm title="Delete shared step?" confirmLabel="Delete shared step" busy={remove.isPending} onConfirm={() => remove.mutate(deleting.id)} onClose={() => setDeleting(null)}>
            “{deleting.name}” (S{deleting.number}) and its captured screens will be deleted. No test case calls it.
          </Confirm>
        ))}
    </>
  )
}

function RenameDialog({ current, busy, onSave, onClose }: { current: string; busy: boolean; onSave: (name: string) => void; onClose: () => void }) {
  const [name, setName] = useState(current)
  const clean = name.trim()
  return (
    <Dialog
      title="Rename shared step"
      onClose={onClose}
      onSubmit={() => clean && (clean === current ? onClose() : onSave(clean))}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" busy={busy} disabled={!clean}>
            Rename
          </Button>
        </>
      }
    >
      <Field label="Name" hint="Every test case that calls it shows the new name.">
        <input className="input" data-autofocus value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
      </Field>
    </Dialog>
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
    <TableWrap label="Batch runs">
      <table className="table table-list">
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
              <td className="col-fit num" data-label="Duration">
                {clock(b.startedAt, b.finishedAt)}
              </td>
              <td className="col-fit num" data-label="Started">
                {dateTime(b.startedAt ?? b.createdAt)}
              </td>
              <td className="col-fit">
                <ChevronRight size={16} className="muted" aria-hidden />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
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
  // What the last copy did, for a moment: shown on the button and announced to screen readers.
  const [copied, setCopied] = useState<{ ok: boolean; n: number } | null>(null)

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
  // The rows the message is about: they are marked invalid and point at it.
  const badKeys = new Set(
    rows.filter((r) => (badRow ? r.key === badRow.key : duplicate ? r.name.trim() === duplicate : builtIn ? r.name.trim() === builtIn : false)).map((r) => r.key),
  )
  const varErrorId = `${useId()}-var-error`
  // Announced a moment after typing stops, through one polite live region, instead of on every keystroke.
  const [announced, setAnnounced] = useState('')
  useEffect(() => {
    const t = window.setTimeout(() => setAnnounced(varError ?? ''), 500)
    return () => window.clearTimeout(t)
  }, [varError])
  const variables = Object.fromEntries(rows.filter((r) => r.name.trim()).map((r) => [r.name.trim(), r.value]))
  const urlError = baseUrlProblem(baseUrl)
  const dirty =
    name.trim() !== project.name ||
    description !== project.description ||
    baseUrl.trim() !== project.baseUrl ||
    JSON.stringify(variables) !== JSON.stringify(project.variables)

  const save = useMutation({
    mutationFn: async () => {
      const sent = { name: name.trim(), description, baseUrl: baseUrl.trim(), variables }
      return { sent, saved: await api.updateProject(project.id, sent) }
    },
    onSuccess: ({ sent, saved: p }) => {
      // The server stores the values in its own spelling (a base URL without the slash at its end): the fields
      // show what was stored, or the form would go on saying "Unsaved changes". A field edited meanwhile is left.
      setName((v) => (v.trim() === sent.name ? p.name : v))
      setBaseUrl((v) => (v.trim() === sent.baseUrl ? p.baseUrl : v))
      qc.setQueryData(qk.project(p.id), p)
      void qc.invalidateQueries({ queryKey: qk.projects })
      toast('Settings saved')
    },
  })

  // With an access code, a script sends it as a bearer token (the browser's session cookie is not readable).
  // The snippet names an environment variable: the code itself is never put on the page.
  const session = useQuery({ queryKey: qk.session, queryFn: api.session, staleTime: Infinity })
  const withCode = session.data?.required === true
  const curl = `curl -X POST "${location.origin}/api/projects/${project.id}/batch-runs" \\\n${withCode ? '  -H "Authorization: Bearer $STEPWISE_ACCESS_CODE" \\\n' : ''}  -H "content-type: application/json" \\\n  -d '{"trigger":"api"}'`
  useEffect(() => {
    if (!copied) return
    const t = window.setTimeout(() => setCopied(null), 1500)
    return () => window.clearTimeout(t)
  }, [copied])

  return (
    <div className="settings">
      <form
        className="panel"
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim() && !varError && !urlError) save.mutate()
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
          <input className="input" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={2000} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://staging.example.com" aria-invalid={!!urlError} />
        </Field>
        {urlError && (
          <p className="form-error" role="alert">
            {urlError}
          </p>
        )}

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
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
                aria-invalid={badKeys.has(r.key)}
                aria-describedby={badKeys.has(r.key) ? varErrorId : undefined}
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
            <p className="form-error" id={varErrorId}>
              {varError}
            </p>
          )}
          <span className="sr-only" role="status">
            {announced}
          </span>
        </div>
        <div className="panel-foot">
          <Button type="submit" variant="primary" busy={save.isPending} disabled={!dirty || !name.trim() || !!varError || !!urlError}>
            Save settings
          </Button>
          {dirty && <span className="muted">Unsaved changes</span>}
        </div>
      </form>

      <section className="panel">
        <h2>Run from CI</h2>
        <p className="muted">
          This request starts a batch run of every test case ({plural(project.testCaseCount ?? 0, 'test case')} now) and returns its id. Poll{' '}
          <code>GET /api/batch-runs/&lt;id&gt;</code> until <code>status</code> is no longer <code>queued</code> or <code>running</code>.{' '}
          {withCode ? (
            <>
              This workspace has an access code: both requests send it as <code>Authorization: Bearer</code>, here from the environment variable{' '}
              <code>STEPWISE_ACCESS_CODE</code>, which you set to the code in your CI’s secrets.
            </>
          ) : (
            <>
              If the workspace gets an access code, both requests need the header <code>Authorization: Bearer &lt;code&gt;</code>.
            </>
          )}
        </p>
        <div className="snippet">
          <pre>{curl}</pre>
          <Button
            size="sm"
            icon={copied?.ok ? <Check size={14} /> : <Copy size={14} />}
            onClick={() => {
              // Clipboard access can be denied; say so instead of failing silently. A new object restarts the timer.
              navigator.clipboard.writeText(curl).then(
                () => setCopied((c) => ({ ok: true, n: (c?.n ?? 0) + 1 })),
                () => setCopied((c) => ({ ok: false, n: (c?.n ?? 0) + 1 })),
              )
            }}
          >
            {copied ? (copied.ok ? 'Copied' : 'Copy failed') : 'Copy'}
          </Button>
          <span className="sr-only" role="status">
            {copied ? (copied.ok ? 'Copied' : 'Copy failed') : ''}
          </span>
        </div>
      </section>
    </div>
  )
}
