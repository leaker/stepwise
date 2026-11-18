import { MutationCache, QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound } from 'lucide-react'
import { lazy, Suspense, useRef, useState, type ReactNode } from 'react'
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom'
import { api, ApiError, qk } from './api'
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
      if (err instanceof ApiError && err.status === 401) void queryClient.invalidateQueries({ queryKey: qk.session })
      if (!mutation.meta?.silent) toastError(err)
    },
  }),
})

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

  if (session.isPending) return <Loading />
  if (session.isError) return <ErrorState error={session.error} onRetry={() => session.refetch()} />
  if (!session.data.required || session.data.ok) return <>{children}</>

  return (
    <div className="gate">
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
        <h1>Enter the access code</h1>
        <p className="muted">This workspace is private. Ask whoever shared the link for its code.</p>
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
            e.target.setCustomValidity('')
            setCode(e.target.value)
            // The rejected code is being changed: the server's verdict no longer describes the field.
            if (signIn.isError) signIn.reset()
          }}
          onInput={(e) => syncInvalid(e.currentTarget)}
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
          Open workspace
        </Button>
      </form>
    </div>
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

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AccessGate>
          <Suspense fallback={<Loading />}>
            <Routes>
              <Route path="/" element={<ProjectsPage />} />
              <Route path="/p/:pid" element={<ProjectPage />} />
              <Route path="/t/:tid" element={<TestCasePage />} />
              <Route path="/t/:tid/edit" element={<Editor />} />
              <Route path="/r/:rid" element={<RunPage />} />
              <Route path="/b/:bid" element={<BatchRunPage />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
        </AccessGate>
      </BrowserRouter>
      <Toaster />
    </QueryClientProvider>
  )
}
