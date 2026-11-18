import { MutationCache, QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound } from 'lucide-react'
import { lazy, Suspense, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createBrowserRouter, Link, Outlet, RouterProvider } from 'react-router-dom'
import { api, ApiError, qk, setUnauthorizedHandler, type Session } from './api'
import { Button, ErrorState, Loading, Logo, Shell, toastError, Toaster } from './components/ui'
import { ProjectPage } from './pages/ProjectPage'
import { ProjectsPage } from './pages/ProjectsPage'
import { TestCasePage } from './pages/TestCasePage'

// The editor and the result pages are the heavy routes; the lists and the access form do not wait for them.
const Editor = lazy(() => import('./editor/Editor').then((m) => ({ default: m.Editor })))
const RunPage = lazy(() => import('./pages/RunPage').then((m) => ({ default: m.RunPage })))
const BatchRunPage = lazy(() => import('./pages/BatchRunPage').then((m) => ({ default: m.BatchRunPage })))

const queryClient: QueryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      refetchOnWindowFocus: false,
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
    },
  },
  mutationCache: new MutationCache({
    onError: (err, _vars, _ctx, mutation) => {
      if (!mutation.meta?.silent) toastError(err)
    },
  }),
})

// A request was refused for want of the access code: ask the server how the session stands, which brings up
// the access form. Queries, mutations and the editor's own saves all end up here. Only while the session was
// thought to be good, so the requests that fail while the form is up do not ask again and again.
setUnauthorizedHandler(() => {
  const known = queryClient.getQueryData<Session>(qk.session)
  if (!known || known.ok || !known.required) void queryClient.invalidateQueries({ queryKey: qk.session })
})

/**
 * The access form over a page that is already open. The page under it stays mounted, so nothing that was
 * typed there is lost while the code is entered again; a modal dialog makes it inert meanwhile. It cannot
 * be dismissed: it goes when the session is good.
 */
function GateOverlay({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const open = () => {
      if (!el.isConnected || el.open) return
      el.showModal()
      el.querySelector<HTMLElement>('input')?.focus()
    }
    const onCancel = (e: Event) => e.preventDefault()
    // A second Escape in a row is not cancelable in every browser: the dialog is opened again.
    const onClose = () => queueMicrotask(open)
    open()
    el.addEventListener('cancel', onCancel)
    el.addEventListener('close', onClose)
    return () => {
      el.removeEventListener('cancel', onCancel)
      el.removeEventListener('close', onClose)
      if (el.open) el.close()
    }
  }, [])
  return (
    <dialog ref={ref} className="gate-over" aria-label="Access code required">
      {children}
    </dialog>
  )
}

function AccessGate({ children }: { children: ReactNode }) {
  const qc = useQueryClient()
  const session = useQuery({ queryKey: qk.session, queryFn: api.session, staleTime: Infinity })
  const [code, setCode] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  // Mirrors the field's :user-invalid state, so aria-invalid turns true at the moment the red border appears.
  const [userInvalid, setUserInvalid] = useState(false)
  const syncInvalid = (el: HTMLInputElement) => setUserInvalid(el.matches(':user-invalid'))
  const signIn = useMutation({
    mutationFn: () => api.signIn(code.trim()),
    meta: { silent: true },
    onSuccess: () => qc.invalidateQueries(),
    // Focus goes back to the field: a screen reader reads its error (aria-describedby) on arrival.
    onError: () => {
      inputRef.current?.focus()
      inputRef.current?.select()
    },
  })

  // Once the app has been shown it stays mounted, whatever the session does afterwards (see GateOverlay).
  const entered = useRef(false)
  if (session.isPending) return <Loading />
  if (session.isError && !session.data) return <ErrorState error={session.error} onRetry={() => session.refetch()} />
  const authorized = !session.data.required || session.data.ok
  if (authorized) entered.current = true
  const expired = entered.current

  const form = (
      <form
        className="gate-card"
        onSubmit={(e) => {
          e.preventDefault()
          if (code.trim()) return signIn.mutate()
          // Only spaces: `required` is satisfied, so say what is wrong instead of doing nothing.
          const el = inputRef.current
          if (!el) return
          el.setCustomValidity('Enter the access code.')
          el.reportValidity()
          setUserInvalid(true)
        }}
      >
        <Logo />
        <h1>{expired ? 'Enter the access code again' : 'Enter the access code'}</h1>
        <p className="muted">
          {expired
            ? 'Your access to this workspace has ended (it lasts 30 days, and ends when the code is changed). Nothing on the page is lost: it is all still there once you are back in.'
            : 'This workspace is private. Ask whoever shared the link for its code.'}
        </p>
        <label className="sr-only" htmlFor="access-code">
          Access code
        </label>
        <input
          ref={inputRef}
          className="input"
          type="password"
          id="access-code"
          name="access-code"
          autoFocus
          required
          // The code is this workspace's password: let the browser's password manager save and fill it.
          autoComplete="current-password"
          enterKeyHint="go"
          placeholder="Access code"
          value={code}
          onChange={(e) => {
            setCode(e.target.value)
            // The rejected code is being changed: the server's verdict no longer describes the field.
            if (signIn.isError) signIn.reset()
          }}
          // React runs onInput before onChange: the "only spaces" message is withdrawn here, before the state is read.
          onInput={(e) => {
            e.currentTarget.setCustomValidity('')
            syncInvalid(e.currentTarget)
          }}
          onBlur={(e) => syncInvalid(e.currentTarget)}
          onInvalid={(e) => syncInvalid(e.currentTarget)}
          aria-invalid={signIn.isError || userInvalid}
          aria-describedby={signIn.isError ? 'access-code-error' : undefined}
        />
        {signIn.isError && (
          <p className="gate-error" id="access-code-error">
            {signIn.error instanceof ApiError && signIn.error.status === 401 ? 'That code is not correct.' : signIn.error.message}
          </p>
        )}
        <Button type="submit" variant="primary" icon={<KeyRound size={16} />} busy={signIn.isPending}>
          {expired ? 'Continue' : 'Open workspace'}
        </Button>
      </form>
  )
  if (!expired) return <div className="gate">{form}</div>
  return (
    <>
      {children}
      {!authorized && <GateOverlay>{form}</GateOverlay>}
    </>
  )
}

function NotFound() {
  return (
    <Shell>
      <div className="state">
        <span>
          This page does not exist. <Link to="/">Go to projects</Link>
        </span>
      </div>
    </Shell>
  )
}

function Root() {
  return (
    <AccessGate>
      <Suspense fallback={<Loading />}>
        <Outlet />
      </Suspense>
    </AccessGate>
  )
}

// A data router, for the editor's useBlocker: leaving it with steps that could not be saved asks first.
const router = createBrowserRouter([
  {
    element: <Root />,
    children: [
      { path: '/', element: <ProjectsPage /> },
      { path: '/p/:pid', element: <ProjectPage /> },
      { path: '/t/:tid', element: <TestCasePage /> },
      { path: '/t/:tid/edit', element: <Editor /> },
      { path: '/r/:rid', element: <RunPage /> },
      { path: '/b/:bid', element: <BatchRunPage /> },
      { path: '*', element: <NotFound /> },
    ],
  },
])

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster />
    </QueryClientProvider>
  )
}
