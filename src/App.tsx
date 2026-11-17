import { MutationCache, QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom'
import { api, ApiError, qk } from './api'
import { Button, ErrorState, Loading, Logo, Shell, toastError, Toaster } from './components/ui'
import { Editor } from './editor/Editor'
import { BatchRunPage } from './pages/BatchRunPage'
import { ProjectPage } from './pages/ProjectPage'
import { ProjectsPage } from './pages/ProjectsPage'
import { RunPage } from './pages/RunPage'
import { TestCasePage } from './pages/TestCasePage'

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
  const signIn = useMutation({
    mutationFn: () => api.signIn(code.trim()),
    meta: { silent: true },
    onSuccess: () => qc.invalidateQueries(),
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
          if (code.trim()) signIn.mutate()
        }}
      >
        <Logo />
        <h1>Enter the access code</h1>
        <p className="muted">This workspace is private. Ask whoever shared the link for its code.</p>
        <input
          className="input"
          type="password"
          autoFocus
          autoComplete="off"
          aria-label="Access code"
          placeholder="Access code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          aria-invalid={signIn.isError}
        />
        {signIn.isError && (
          <p className="gate-error" role="alert">
            {signIn.error instanceof ApiError && signIn.error.status === 401 ? 'That code is not correct.' : signIn.error.message}
          </p>
        )}
        <Button type="submit" variant="primary" icon={<KeyRound size={16} />} busy={signIn.isPending} disabled={!code.trim()}>
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
          <Routes>
            <Route path="/" element={<ProjectsPage />} />
            <Route path="/p/:pid" element={<ProjectPage />} />
            <Route path="/t/:tid" element={<TestCasePage />} />
            <Route path="/t/:tid/edit" element={<Editor />} />
            <Route path="/r/:rid" element={<RunPage />} />
            <Route path="/b/:bid" element={<BatchRunPage />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </AccessGate>
      </BrowserRouter>
      <Toaster />
    </QueryClientProvider>
  )
}
