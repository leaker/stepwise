import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MoreHorizontal, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { Project } from '../../shared/types'
import { baseUrlProblem } from '../../shared/url'
import { api, qk } from '../api'
import { Button, Confirm, Dialog, Empty, ErrorState, Field, Loading, MenuButton, Shell, TableWrap } from '../components/ui'

function CreateProjectDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const create = useMutation({
    mutationFn: () => api.createProject({ name: name.trim(), description: description.trim(), baseUrl: baseUrl.trim() }),
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: qk.projects })
      navigate(`/p/${p.id}`)
    },
  })
  const urlError = baseUrlProblem(baseUrl)
  return (
    <Dialog
      title="New project"
      onClose={onClose}
      onSubmit={() => name.trim() && !urlError && create.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" busy={create.isPending} disabled={!name.trim() || !!urlError}>
            Create project
          </Button>
        </>
      }
    >
      <Field label="Name">
        <input className="input" data-autofocus value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="Checkout web app" />
      </Field>
      <Field label="Description">
        <textarea className="input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this project tests" />
      </Field>
      <Field label="Base URL" hint={<>Available in steps as <code>{'${BASE_URL}'}</code>. Relative Navigate URLs resolve against it.</>}>
        {/* Not type="url": "localhost:3000/app" passes the browser's check (it reads "localhost:" as a scheme). */}
        <input className="input" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={2000} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://staging.example.com" aria-invalid={!!urlError} />
      </Field>
      {urlError && (
        <p className="form-error" role="alert">
          {urlError}
        </p>
      )}
    </Dialog>
  )
}

export function ProjectsPage() {
  const qc = useQueryClient()
  const projects = useQuery({ queryKey: qk.projects, queryFn: api.projects })
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<Project | null>(null)
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteProject(id),
    onSuccess: () => {
      setDeleting(null)
      void qc.invalidateQueries({ queryKey: qk.projects })
    },
  })

  return (
    <Shell>
      <div className="page-head">
        <div className="page-head-main">
          <h1>Projects</h1>
          <p className="page-sub">A project groups the test cases for one site and the batch runs that execute them together.</p>
        </div>
        <div className="page-actions">
          <Button variant="primary" icon={<Plus size={16} />} onClick={() => setCreating(true)}>
            New project
          </Button>
        </div>
      </div>

      {!projects.data ? (
        projects.isError ? (
          <ErrorState error={projects.error} onRetry={() => projects.refetch()} />
        ) : (
          <Loading />
        )
      ) : projects.data.length === 0 ? (
        <Empty
          title="No projects yet"
          action={
            <Button variant="primary" icon={<Plus size={16} />} onClick={() => setCreating(true)}>
              New project
            </Button>
          }
        >
          Create a project, capture a screen of your site, and build the first test by picking elements from it.
        </Empty>
      ) : (
        <TableWrap label="Projects">
          <table className="table table-list">
            <thead>
              <tr>
                <th>Project</th>
                <th className="col-fit">Test cases</th>
                <th className="col-fit">Batch runs</th>
                <th className="col-fit" />
              </tr>
            </thead>
            <tbody>
              {projects.data.map((p) => (
                <tr key={p.id}>
                  <th scope="row" className="col-main">
                    <div className="cell-name">
                      <Link to={`/p/${p.id}`} title={p.name}>
                        {p.name}
                      </Link>
                    </div>
                    {p.description && (
                      <div className="cell-desc" title={p.description}>
                        {p.description}
                      </div>
                    )}
                  </th>
                  <td className="col-fit num" data-label="Test cases">
                    {p.testCaseCount ?? 0}
                  </td>
                  <td className="col-fit num" data-label="Batch runs">
                    {p.batchRunCount ?? 0}
                  </td>
                  <td className="col-fit">
                    <MenuButton
                      className="icon-btn"
                      label={`Actions for ${p.name}`}
                      items={[{ label: 'Delete project', icon: <Trash2 size={15} />, danger: true, onSelect: () => setDeleting(p) }]}
                    >
                      <MoreHorizontal size={16} />
                    </MenuButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}

      {creating && <CreateProjectDialog onClose={() => setCreating(false)} />}
      {deleting && (
        <Confirm
          title="Delete project?"
          confirmLabel="Delete project"
          busy={remove.isPending}
          onConfirm={() => remove.mutate(deleting.id)}
          onClose={() => setDeleting(null)}
        >
          “{deleting.name}” and all of its test cases, captured screens and run results will be deleted. This cannot be undone.
        </Confirm>
      )}
    </Shell>
  )
}
