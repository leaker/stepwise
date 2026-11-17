import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Check, ChevronDown, CloudAlert, ListPlus, Play, Plus, Redo2, Sparkles, Square, Undo2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { COMMAND_BY_ID, DEFAULT_COMMAND, stepSentence } from '../../shared/commands'
import { DEVICE_IDS, DEVICES, deviceOf } from '../../shared/devices'
import type { AssistantSession, CommandId, DeviceId, Step, StepResult, Ui, UiElement } from '../../shared/types'
import { api, qk } from '../api'
import { Button, Confirm, DeviceIcon, ErrorState, IconButton, Loading, MenuButton, Spinner, StatusIcon, toast, toastError } from '../components/ui'
import { cx, isTerminal, STATUS_LABEL, uid } from '../lib/format'
import { AssistantPanel } from './AssistantPanel'
import { changeCommand, makeTarget, newStep, sameStep, stepErrors } from './model'
import { CommandPalette, StepList } from './StepList'
import { UiPanel, type Inspect } from './UiPanel'

type SaveState = 'saved' | 'unsaved' | 'saving' | 'error'
const SPLIT_KEY = 'stepwise.editor.split'
const ASSISTANT_KEY = 'stepwise.editor.assistant'
const isActiveSession = (s: AssistantSession) => s.status === 'queued' || s.status === 'running'
const errorText = (e: unknown) => (e instanceof Error ? e.message : 'The request failed')

export function Editor() {
  const { tid = '' } = useParams()
  return <EditorInner key={tid} tid={tid} />
}

function EditorInner({ tid }: { tid: string }) {
  const qc = useQueryClient()
  const tc = useQuery({ queryKey: qk.testCase(tid), queryFn: () => api.testCase(tid), staleTime: 0, refetchOnMount: 'always' })
  const pid = tc.data?.projectId
  const project = useQuery({ queryKey: qk.project(pid ?? ''), queryFn: () => api.project(pid!), enabled: !!pid })
  const uisQuery = useQuery({ queryKey: qk.uis(tid), queryFn: () => api.uis(tid), staleTime: 0, refetchOnMount: 'always' })
  const uis = useMemo(() => uisQuery.data ?? [], [uisQuery.data])

  // ----- steps, history, autosave -----
  const [steps, setSteps] = useState<Step[]>([])
  const [ready, setReady] = useState(false)
  const stepsRef = useRef<Step[]>(steps)
  const hist = useRef<{ undo: Step[][]; redo: Step[][]; key: string | null }>({ undo: [], redo: [], key: null })
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const save = useRef<{ dirty: boolean; timer: number; inflight: Promise<boolean> | null }>({ dirty: false, timer: 0, inflight: null })
  // While the assistant edits the steps on the server, the editor only follows: nothing here may change or save them.
  const lockedRef = useRef(false)

  useEffect(() => {
    if (ready || !tc.data || !tc.isFetchedAfterMount) return
    stepsRef.current = tc.data.steps
    setSteps(tc.data.steps)
    setReady(true)
  }, [ready, tc.data, tc.isFetchedAfterMount])

  const flush = useCallback(async (): Promise<boolean> => {
    const s = save.current
    window.clearTimeout(s.timer)
    for (;;) {
      // Another caller may start the next save the moment this one settles, so look again after waiting:
      // "saved" means no request in flight and nothing dirty.
      if (s.inflight) {
        await s.inflight
        continue
      }
      if (!s.dirty) return true
      s.dirty = false
      setSaveState('saving')
      const snapshot = stepsRef.current
      s.inflight = api.updateTestCase(tid, { steps: snapshot }).then(
        (next) => {
          qc.setQueryData(qk.testCase(tid), next)
          return true
        },
        (err) => {
          s.dirty = true
          toastError(err)
          return false
        },
      )
      const ok = await s.inflight
      s.inflight = null
      if (!ok) {
        setSaveState('error')
        return false
      }
      if (!s.dirty) {
        setSaveState('saved')
        return true
      }
    }
  }, [qc, tid])

  const apply = useCallback(
    (next: Step[]) => {
      if (lockedRef.current) return
      stepsRef.current = next
      setSteps(next)
      const s = save.current
      s.dirty = true
      setSaveState((v) => (v === 'saving' ? v : 'unsaved'))
      window.clearTimeout(s.timer)
      s.timer = window.setTimeout(() => void flush(), 700)
    },
    [flush],
  )

  /** Record an undo point and apply. Edits sharing a `coalesce` key (typing in one field) form one undo step. */
  const commit = useCallback(
    (next: Step[], coalesce?: string) => {
      if (lockedRef.current) return
      const h = hist.current
      if (!coalesce || coalesce !== h.key) {
        h.undo.push(stepsRef.current)
        if (h.undo.length > 200) h.undo.shift()
      }
      h.redo = []
      h.key = coalesce ?? null
      apply(next)
    },
    [apply],
  )
  const undo = useCallback(() => {
    if (lockedRef.current) return
    const h = hist.current
    const prev = h.undo.pop()
    if (!prev) return
    h.redo.push(stepsRef.current)
    h.key = null
    apply(prev)
  }, [apply])
  const redo = useCallback(() => {
    if (lockedRef.current) return
    const h = hist.current
    const next = h.redo.pop()
    if (!next) return
    h.undo.push(stepsRef.current)
    h.key = null
    apply(next)
  }, [apply])

  useEffect(() => {
    const s = save.current
    const warn = (e: BeforeUnloadEvent) => {
      if (s.dirty || s.inflight) e.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => {
      window.removeEventListener('beforeunload', warn)
      void flush()
    }
  }, [flush])

  // ----- selection, element picking, inspector -----
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [focusId, setFocusId] = useState<string | null>(null)
  const [pickForId, setPickForId] = useState<string | null>(null)
  const [inspect, setInspect] = useState<Inspect | null>(null)
  const [currentUiId, setCurrentUiId] = useState<string | null>(null)
  const [flash, setFlash] = useState(0)
  const [palette, setPalette] = useState<{ index: number } | null>(null)

  const selectedStep = steps.find((s) => s.id === selectedId) ?? null
  const pickFor = steps.find((s) => s.id === pickForId) ?? null
  const ui = uis.find((u) => u.id === currentUiId) ?? null

  useEffect(() => {
    if (uis.length && !uis.some((u) => u.id === currentUiId)) setCurrentUiId(uis[uis.length - 1].id)
  }, [uis, currentUiId])

  // Undo / redo can remove the step that is selected, being picked for or inspected.
  useEffect(() => {
    const has = (id: string | null | undefined) => !!id && steps.some((s) => s.id === id)
    if (selectedId && !has(selectedId)) setSelectedId(null)
    if (pickForId && !has(pickForId)) setPickForId(null)
    if (inspect?.stepId && !has(inspect.stepId)) setInspect(null)
  }, [steps, selectedId, pickForId, inspect])

  const selectedRef = useRef<string | null>(null)
  selectedRef.current = selectedId
  const select = useCallback(
    (id: string) => {
      if (selectedRef.current === id) return
      selectedRef.current = id
      setSelectedId(id)
      const t = stepsRef.current.find((s) => s.id === id)?.target
      if (t) {
        if (qc.getQueryData<Ui[]>(qk.uis(tid))?.some((x) => x.id === t.uiId)) setCurrentUiId(t.uiId)
        setFlash((n) => n + 1)
      }
      setInspect((i) => (i?.stepId && i.stepId !== id ? null : i))
    },
    [qc, tid],
  )

  const insertAt = useCallback(
    (index: number, step: Step) => {
      if (lockedRef.current) return
      const next = [...stepsRef.current]
      next.splice(index, 0, step)
      commit(next)
      setSelectedId(step.id)
    },
    [commit],
  )
  const insertIndex = () => {
    const i = stepsRef.current.findIndex((s) => s.id === selectedId)
    return i >= 0 ? i + 1 : stepsRef.current.length
  }

  const pickElement = (u: Ui, el: UiElement) => {
    if (lockedRef.current) {
      toast('The assistant is editing the steps. Wait for it to finish, or abort it.', 'error')
      return
    }
    const target = makeTarget(u, el)
    if (pickFor) {
      commit(stepsRef.current.map((s) => (s.id === pickFor.id ? { ...s, target } : s)))
      setPickForId(null)
      setSelectedId(pickFor.id)
      setFocusId(pickFor.id)
    } else {
      const text = el.fingerprint.text
      // A fingerprint keeps the first 120 characters only: a longer text can be checked with "contains", not "equals".
      const command = el.type === 'text' && text.length >= 120 ? 'assert_text_contains' : (DEFAULT_COMMAND[el.type] ?? 'click')
      // Text assertions start from what the screen showed at capture time, so the step is runnable as-is.
      const step = newStep(command, command === 'assert_text_equals' || command === 'assert_text_contains' ? { target, value: text } : { target })
      insertAt(insertIndex(), step)
      setFocusId(step.id)
    }
    setFlash((n) => n + 1)
    setInspect(null)
  }

  const onChip = (id: string) => {
    const step = stepsRef.current.find((s) => s.id === id)
    if (!step) return
    select(id)
    if (!step.target) {
      setPickForId(pickForId === id ? null : id)
      setInspect(null)
      return
    }
    if (uis.some((u) => u.id === step.target!.uiId)) setCurrentUiId(step.target.uiId)
    setFlash((n) => n + 1)
    setInspect({ uiId: step.target.uiId, elementId: step.target.elementId, stepId: id })
  }

  const removeStep = useCallback(
    (id: string) => {
      if (lockedRef.current) return
      const cur = stepsRef.current
      const i = cur.findIndex((s) => s.id === id)
      if (i < 0) return
      const next = cur.filter((s) => s.id !== id)
      commit(next)
      setSelectedId(next[Math.min(i, next.length - 1)]?.id ?? null)
      if (pickForId === id) setPickForId(null)
    },
    [commit, pickForId],
  )

  // ----- run -----
  const [runId, setRunId] = useState<string | null>(null)
  const run = useQuery({
    queryKey: qk.run(runId ?? ''),
    queryFn: () => api.run(runId!),
    enabled: !!runId,
    refetchInterval: (q) => (q.state.data && isTerminal(q.state.data.status) ? false : 1000),
  })
  const errors = useMemo(() => stepErrors(steps), [steps])
  const start = useMutation({
    mutationFn: async (range: { from: number; to: number } | null) => {
      if (!(await flush())) throw new Error('The steps could not be saved, so the run was not started.')
      return api.startRun(tid, range)
    },
    onSuccess: (r) => {
      qc.setQueryData(qk.run(r.id), r)
      setRunId(r.id)
    },
  })
  const abort = useMutation({ mutationFn: () => api.abortRun(runId!), onSuccess: (r) => qc.setQueryData(qk.run(r.id), r) })
  const runData = runId ? run.data : undefined
  const running = start.isPending || (!!runData && !isTerminal(runData.status))
  const reported = useMemo(() => new Map<string, StepResult>((runData?.results ?? []).map((r) => [r.stepId, r])), [runData?.results])
  // A row only shows a result while the step is still what the run executed; an edited step has not been run.
  const results = useMemo(() => {
    const ran = new Map((runData?.steps ?? []).map((s) => [s.id, s]))
    const current = new Map<string, StepResult>()
    for (const s of steps) {
      const result = reported.get(s.id)
      const then = ran.get(s.id)
      if (result && then && sameStep(s, then)) current.set(s.id, result)
    }
    return current
  }, [steps, reported, runData?.steps])
  const runningId = useMemo(() => {
    if (!runData || runData.status !== 'running') return null
    const from = runData.range?.from ?? 1
    const to = runData.range?.to ?? runData.steps.length
    return runData.steps.find((s, i) => !s.disabled && i + 1 >= from && i + 1 <= to && !reported.has(s.id))?.id ?? null
  }, [runData, reported])
  const finished = runData && isTerminal(runData.status) ? runData : null
  useEffect(() => {
    if (!finished) return
    void qc.invalidateQueries({ queryKey: qk.runs(tid) })
    void qc.invalidateQueries({ queryKey: qk.testCase(tid), refetchType: 'none' })
    const failed = finished.results.find((r) => r.status === 'failed')
    if (failed) setSelectedId(failed.stepId)
  }, [finished?.id, finished?.status]) // eslint-disable-line react-hooks/exhaustive-deps

  // ----- assistant -----
  const [assistantOpen, setAssistantOpen] = useState(() => {
    try {
      return localStorage.getItem(ASSISTANT_KEY) === '1'
    } catch {
      return false
    }
  })
  const toggleAssistant = (open: boolean) => {
    setAssistantOpen(open)
    try {
      localStorage.setItem(ASSISTANT_KEY, open ? '1' : '0')
    } catch {
      /* storage unavailable */
    }
  }
  const assistantStatus = useQuery({ queryKey: qk.assistantStatus, queryFn: api.assistantStatus, staleTime: 60_000 })
  const sessionsQuery = useQuery({
    queryKey: qk.assistant(tid),
    queryFn: () => api.assistantSessions(tid),
    enabled: assistantStatus.data?.enabled === true,
    staleTime: 0,
    // A list that could not be loaded is asked for again: "no sessions" must be something the server said.
    refetchInterval: (q) => (q.state.status === 'error' ? 5000 : q.state.data?.some(isActiveSession) ? 1500 : false),
  })
  const sessions = useMemo(() => sessionsQuery.data ?? [], [sessionsQuery.data])
  const activeSession = sessions.find(isActiveSession)
  // The session whose edits the editor is following; it stays set until the final state has been loaded.
  const [following, setFollowing] = useState<string | null>(null)
  const beforeAssistant = useRef<Step[] | null>(null)
  const ask = useMutation({
    mutationFn: async (message: string) => {
      if (!(await flush())) throw new Error('The steps could not be saved, so the assistant was not started.')
      const before = stepsRef.current
      const session = await api.askAssistant(tid, message)
      beforeAssistant.current = before
      return session
    },
    onSuccess: (session) => {
      qc.setQueryData<AssistantSession[]>(qk.assistant(tid), (old) => [...(old ?? []).filter((s) => s.id !== session.id), session])
      setFollowing(session.id)
    },
    onError: toastError,
  })
  const abortAssistant = useMutation({
    mutationFn: (sid: string) => api.abortAssistant(sid),
    onSuccess: (session) => qc.setQueryData<AssistantSession[]>(qk.assistant(tid), (old) => (old ?? []).map((s) => (s.id === session.id ? session : s))),
    onError: toastError,
  })
  useEffect(() => {
    if (activeSession) setFollowing(activeSession.id)
  }, [activeSession?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const locked = ask.isPending || !!activeSession || !!following
  lockedRef.current = locked

  // Whenever the followed session reports something new, load the steps and screens it left on the server.
  const followed = sessions.find((s) => s.id === following)
  const followedState = followed ? `${followed.events.length}:${followed.status}` : ''
  const syncSeq = useRef(0)
  // Set while the steps a finished session left on the server could not be loaded. The editor stays locked
  // until they are: unlocking with the old steps on screen would let the next edit save them over the new ones.
  const [syncError, setSyncError] = useState<string | null>(null)
  const [syncRetry, setSyncRetry] = useState(0)
  useEffect(() => {
    if (!followed) return
    const ended = !isActiveSession(followed)
    const seq = ++syncSeq.current
    let retry = 0
    void (async () => {
      try {
        const [nextCase, nextUis] = await Promise.all([api.testCase(tid), api.uis(tid)])
        if (seq !== syncSeq.current) return
        const known = new Set(stepsRef.current.map((s) => s.id))
        const added = nextCase.steps.filter((s) => !known.has(s.id))
        const hadUis = qc.getQueryData<Ui[]>(qk.uis(tid))?.length ?? 0
        qc.setQueryData(qk.testCase(tid), nextCase)
        qc.setQueryData(qk.uis(tid), nextUis)
        if (JSON.stringify(nextCase.steps) !== JSON.stringify(stepsRef.current)) {
          stepsRef.current = nextCase.steps
          setSteps(nextCase.steps)
        }
        // Selecting a row scrolls it into view: follow the newest step and the newest screen.
        if (added.length) setSelectedId(added[added.length - 1].id)
        if (nextUis.length > hadUis) setCurrentUiId(nextUis[nextUis.length - 1].id)
      } catch (err) {
        if (seq !== syncSeq.current) return
        // While the session runs, its next event brings another sync. After the last one there is none, so
        // this one is repeated until it works; the editor stays read-only meanwhile.
        if (ended) {
          setSyncError(err instanceof Error ? err.message : 'unknown error')
          retry = window.setTimeout(() => setSyncRetry((n) => n + 1), 3000)
        }
        return
      }
      if (seq !== syncSeq.current) return
      setSyncError(null)
      if (!ended) return
      // One undo entry for the whole session: undo puts the steps back to what they were before it.
      const before = beforeAssistant.current
      beforeAssistant.current = null
      if (before && JSON.stringify(before) !== JSON.stringify(stepsRef.current)) {
        const h = hist.current
        h.undo.push(before)
        h.redo = []
        h.key = null
      }
      setPickForId(null)
      setFollowing(null)
    })()
    return () => window.clearTimeout(retry)
  }, [following, followedState, syncRetry]) // eslint-disable-line react-hooks/exhaustive-deps

  const enabledCount = steps.filter((s) => !s.disabled).length
  const blocked = locked ? 'The assistant is editing the steps. Wait for it to finish, or abort it.' : errors.size > 0 ? 'Fix the highlighted steps before running.' : enabledCount === 0 ? 'Add a step before running.' : null
  const startRun = (range: { from: number; to: number } | null) => {
    if (running) return
    if (blocked) {
      toast(blocked, 'error')
      const first = steps.find((s) => errors.has(s.id))
      if (first) setSelectedId(first.id)
      return
    }
    start.mutate(range)
  }

  // ----- device -----
  const [pendingDevice, setPendingDevice] = useState<DeviceId | null>(null)
  const setDevice = useMutation({
    mutationFn: async (device: DeviceId) => {
      if (!(await flush())) throw new Error('The steps could not be saved, so the device was not changed.')
      return api.updateTestCase(tid, { device })
    },
    onSuccess: (next) => {
      qc.setQueryData(qk.testCase(tid), next)
      setPendingDevice(null)
      toast(`This test case now runs on ${DEVICES[next.device].label}`)
    },
    onError: toastError,
  })
  const chooseDevice = (device: DeviceId) => {
    if (device === tc.data?.device) return
    // Screens captured on another device may show a different layout than the test will run on.
    if (uis.some((u) => u.device !== device)) setPendingDevice(device)
    else setDevice.mutate(device)
  }

  // ----- capture -----
  // Belongs to the capture it happened on: it is only shown while that screen is.
  const [replayError, setReplayError] = useState<{ uiId: string; stepId: string; message: string } | null>(null)
  const capture = useMutation({
    mutationFn: async (req: { afterStepId: string } | { url: string }) => {
      if (!(await flush())) throw new Error('The steps could not be saved, so nothing was captured.')
      return api.capture(tid, req)
    },
    onSuccess: (res) => {
      qc.setQueryData<Ui[]>(qk.uis(tid), (old) => [...(old ?? []).filter((u) => u.id !== res.ui.id), res.ui])
      setCurrentUiId(res.ui.id)
      setInspect(null)
      if (res.replayError) {
        setReplayError({ uiId: res.ui.id, stepId: res.replayError.stepId, message: res.replayError.message })
      } else {
        setReplayError(null)
        toast(`Captured “${res.ui.name}” with ${res.ui.elements.length} elements`)
      }
    },
  })
  const captureAfter = useMemo(() => {
    const at = selectedId ? steps.findIndex((s) => s.id === selectedId) : -1
    const i = at >= 0 ? at : steps.length - 1
    return i >= 0 ? { id: steps[i].id, n: i + 1 } : null
  }, [steps, selectedId])
  const shownReplayError = useMemo(() => {
    if (!replayError || replayError.uiId !== ui?.id) return null
    const i = steps.findIndex((s) => s.id === replayError.stepId)
    return { n: i + 1, sentence: i >= 0 ? stepSentence(steps[i]) : null, message: replayError.message }
  }, [replayError, ui?.id, steps])
  const capturing = capture.isPending
    ? 'afterStepId' in capture.variables
      ? `Replaying steps 1–${Math.max(1, steps.findIndex((s) => s.id === (capture.variables as { afterStepId: string }).afterStepId) + 1)}, then capturing…`
      : 'Opening the URL and capturing…'
    : null

  const LOCKED_NOTE = 'The assistant is working on this test case. Wait for it to finish, or abort it.'
  const launch = (url: string) => {
    if (lockedRef.current) return toast(LOCKED_NOTE, 'error')
    if (stepsRef.current.length === 0) {
      const step = newStep('navigate', { value: url })
      insertAt(0, step)
      capture.mutate({ afterStepId: step.id })
    } else {
      capture.mutate({ url })
    }
  }

  // ----- keyboard -----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('.dialog-backdrop, .popover, .lightbox')) return
      const t = e.target as HTMLElement
      const editable = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable
      const inSteps = !!t.closest?.('.steps')
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'z') {
        if (editable && !inSteps) return
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
        return
      }
      if (mod && e.key.toLowerCase() === 'y') {
        if (editable && !inSteps) return
        e.preventDefault()
        redo()
        return
      }
      if (e.key === 'Escape') {
        if (pickForId) setPickForId(null)
        else if (inspect) setInspect(null)
        else if (editable) t.blur()
        return
      }
      if (mod && e.key === '/' && selectedId) {
        e.preventDefault()
        commit(stepsRef.current.map((s) => (s.id === selectedId ? { ...s, disabled: !s.disabled } : s)))
        return
      }
      if (editable || t.closest?.('.inspector')) return
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        e.preventDefault()
        removeStep(selectedId)
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const cur = stepsRef.current
        if (!cur.length) return
        e.preventDefault()
        const i = cur.findIndex((s) => s.id === selectedId)
        const next = i < 0 ? 0 : Math.max(0, Math.min(cur.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))
        select(cur[next].id)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [undo, redo, commit, removeStep, select, selectedId, pickForId, inspect])

  // ----- resizable split -----
  const [split, setSplit] = useState(() => {
    try {
      const v = Number(localStorage.getItem(SPLIT_KEY))
      return v >= 26 && v <= 60 ? v : 38
    } catch {
      return 38
    }
  })
  const bodyRef = useRef<HTMLDivElement>(null)
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault()
    const body = bodyRef.current
    if (!body) return
    let latest = split
    const move = (ev: PointerEvent) => {
      const r = body.getBoundingClientRect()
      const minPct = (400 / r.width) * 100
      latest = Math.max(Math.max(26, minPct), Math.min(60, ((ev.clientX - r.left) / r.width) * 100))
      setSplit(latest)
    }
    const up = () => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', up)
      document.body.classList.remove('is-resizing')
      try {
        localStorage.setItem(SPLIT_KEY, String(Math.round(latest)))
      } catch {
        /* storage unavailable */
      }
    }
    document.body.classList.add('is-resizing')
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', up)
  }

  if (tc.isError) return <div className="ed"><ErrorState error={tc.error} onRetry={() => tc.refetch()} /></div>
  if (!ready || !tc.data) return <div className="ed"><Loading label="Opening the editor…" /></div>
  const t = tc.data
  const lastRun = !runId ? t.lastRun : null

  return (
    <div className="ed">
      <header className="ed-top">
        <Link to={`/t/${tid}`} className="ed-back" title="Back to the test case">
          <ArrowLeft size={16} />
          <span>Back</span>
        </Link>
        <nav className="ed-crumbs" aria-label="Breadcrumb">
          <Link to={`/p/${t.projectId}`} className="truncate" title={project.data?.name}>
            {project.data?.name ?? 'Project'}
          </Link>
          <span aria-hidden>/</span>
          <span className="truncate ed-crumb-current" title={t.name}>
            {t.name}
          </span>
          <span className="ed-hash num">#{t.number}</span>
        </nav>
        <SaveBadge state={saveState} onRetry={() => void flush()} />
        <MenuButton
          className="ed-device"
          label="Device this test case is captured and run on"
          disabled={running || setDevice.isPending || locked}
          items={DEVICE_IDS.map((id) => ({
            label: DEVICES[id].label,
            desc: `${DEVICES[id].viewport.width} × ${DEVICES[id].viewport.height}${DEVICES[id].isMobile ? ', emulated phone with touch' : ''}`,
            icon: <DeviceIcon device={id} size={15} />,
            checked: id === t.device,
            onSelect: () => chooseDevice(id),
          }))}
        >
          {setDevice.isPending ? <Spinner size={13} /> : <DeviceIcon device={t.device} size={14} />}
          <span>{deviceOf(t.device).label}</span>
          <ChevronDown size={13} />
        </MenuButton>
        <button
          type="button"
          className={cx('ed-device ed-asst-toggle', assistantOpen && 'is-active')}
          aria-pressed={assistantOpen}
          title={assistantOpen ? 'Close the assistant' : 'Build steps by describing the test'}
          onClick={() => toggleAssistant(!assistantOpen)}
        >
          {locked ? <Spinner size={13} /> : <Sparkles size={14} />}
          <span>Assistant</span>
        </button>
        <span className="ed-gap" />
        <div className="ed-run" aria-live="polite">
          {runData ? (
            <>
              <span className={cx('ed-run-status', `status-${runData.status}`)}>
                <StatusIcon status={runData.status} size={16} />
                {STATUS_LABEL[runData.status]}
                {runData.range && <span className="ed-run-range num">steps {runData.range.from === runData.range.to ? runData.range.from : `${runData.range.from}–${runData.range.to}`}</span>}
                {!isTerminal(runData.status) && runData.steps.length > 0 && (
                  <span className="ed-run-range num">
                    {runData.results.length} / {runData.steps.filter((s, i) => !s.disabled && i + 1 >= (runData.range?.from ?? 1) && i + 1 <= (runData.range?.to ?? runData.steps.length)).length}
                  </span>
                )}
              </span>
              <Link to={`/r/${runData.id}`} className="ed-details">
                Details
              </Link>
            </>
          ) : start.isPending ? (
            <span className="ed-run-status">
              <Spinner size={15} /> Starting…
            </span>
          ) : lastRun ? (
            <>
              <span className="ed-run-status is-old" title="Result of the previous run">
                <StatusIcon status={lastRun.status} size={16} />
                Last run {STATUS_LABEL[lastRun.status].toLowerCase()}
              </span>
              <Link to={`/r/${lastRun.id}`} className="ed-details">
                Details
              </Link>
            </>
          ) : null}
        </div>
        {running && runData ? (
          <Button className="ed-run-btn" icon={<Square size={13} />} busy={abort.isPending} onClick={() => abort.mutate()}>
            Abort
          </Button>
        ) : (
          <Button className="ed-run-btn" variant="primary" icon={<Play size={14} />} busy={start.isPending} title={blocked ?? 'Run every step in a fresh cloud browser'} aria-disabled={!!blocked} onClick={() => startRun(null)}>
            {finished ? 'Run again' : 'Run'}
          </Button>
        )}
      </header>

      <div className={cx('ed-body', assistantOpen && 'has-asst')} ref={bodyRef} style={{ '--split': `${split}%` } as React.CSSProperties}>
        <section className="ed-left" aria-label="Steps">
          <div className="ed-left-head">
            <h2>
              Steps <span className="num muted">{steps.length}</span>
            </h2>
            {errors.size > 0 && <span className="ed-errcount">{errors.size} to fix</span>}
            <span className="ed-gap" />
            <IconButton label="Undo (⌘Z)" disabled={locked || hist.current.undo.length === 0} onClick={undo}>
              <Undo2 size={16} />
            </IconButton>
            <IconButton label="Redo (⇧⌘Z)" disabled={locked || hist.current.redo.length === 0} onClick={redo}>
              <Redo2 size={16} />
            </IconButton>
          </div>
          {locked && !syncError && (
            <div className="ed-locked" role="status">
              <Sparkles size={14} aria-hidden />
              <span>The assistant is editing the steps. They are read-only until it finishes.</span>
            </div>
          )}
          {locked && syncError && (
            <div className="ed-locked is-error" role="alert">
              <CloudAlert size={14} aria-hidden />
              <span>The assistant finished, but its steps could not be loaded ({syncError}). The steps stay read-only until they are. Trying again…</span>
              <Button size="sm" onClick={() => setSyncRetry((n) => n + 1)}>
                Retry now
              </Button>
            </div>
          )}
          <div className={cx('ed-left-scroll', locked && 'is-locked')} inert={locked}>
            {steps.length === 0 ? (
              <div className="steps-empty">
                <ListPlus size={22} />
                <p>
                  <strong>No steps yet.</strong> Capture a screen on the right and click one of its elements, or add a command below.
                </p>
              </div>
            ) : (
              <StepList
                steps={steps}
                selectedId={selectedId}
                errors={errors}
                results={results}
                runningId={runningId}
                pickFor={pickForId}
                focusId={focusId}
                canRun={!running && !blocked}
                onSelect={select}
                onChange={(id, patch, coalesce) => commit(stepsRef.current.map((s) => (s.id === id ? { ...s, ...patch } : s)), coalesce)}
                onCommand={(id, command) => commit(stepsRef.current.map((s) => (s.id === id ? changeCommand(s, command) : s)))}
                onMove={(id, toIndex) => {
                  const cur = stepsRef.current
                  const from = cur.findIndex((s) => s.id === id)
                  if (from < 0 || toIndex === from || toIndex === from + 1) return
                  const next = [...cur]
                  const [moved] = next.splice(from, 1)
                  next.splice(toIndex > from ? toIndex - 1 : toIndex, 0, moved)
                  commit(next)
                  setSelectedId(id)
                }}
                onInsert={(index) => setPalette({ index })}
                onDuplicate={(id) => {
                  const cur = stepsRef.current
                  const i = cur.findIndex((s) => s.id === id)
                  if (i >= 0) insertAt(i + 1, { ...structuredClone(cur[i]), id: uid() })
                }}
                onDelete={removeStep}
                onChip={onChip}
                onRunRange={(from, to) => startRun({ from, to })}
              />
            )}
          </div>
          <div className="ed-left-foot">
            <Button icon={<Plus size={15} />} disabled={locked} onClick={() => setPalette({ index: insertIndex() })}>
              Add command
            </Button>
            <span className="muted truncate">or click an element on the screen</span>
          </div>
        </section>

        <div className="ed-resize" role="separator" aria-orientation="vertical" aria-label="Resize panels" onPointerDown={startResize} onDoubleClick={() => setSplit(38)} />

        <UiPanel
          tid={tid}
          baseUrl={project.data?.baseUrl ?? ''}
          device={t.device}
          uis={uis}
          loading={uisQuery.isPending}
          currentUiId={ui?.id ?? null}
          onCurrentUi={setCurrentUiId}
          steps={steps}
          selectedStep={selectedStep}
          flash={flash}
          pickFor={pickFor}
          onCancelPick={() => setPickForId(null)}
          captureAfter={captureAfter}
          capturing={capturing}
          replayError={shownReplayError}
          onDismissReplayError={() => setReplayError(null)}
          locked={locked ? LOCKED_NOTE : null}
          onCaptureAfter={() => (lockedRef.current ? toast(LOCKED_NOTE, 'error') : captureAfter && capture.mutate({ afterStepId: captureAfter.id }))}
          onCaptureUrl={(url) => (lockedRef.current ? toast(LOCKED_NOTE, 'error') : capture.mutate({ url }))}
          onLaunch={launch}
          onPickElement={pickElement}
          inspect={inspect}
          onInspect={setInspect}
          onSaveElement={(ref, name, forStep) => {
            // The name belongs to the element: every step that uses it shows the new one. The locator choice is per step.
            let changed = false
            const next = stepsRef.current.map((s) => {
              if (!s.target) return s
              const mine = forStep?.stepId === s.id
              const same = s.target.uiId === ref.uiId && s.target.elementId === ref.elementId
              if (!mine && !(same && s.target.name !== name)) return s
              changed = true
              return { ...s, target: { ...s.target, ...(same || mine ? { name } : {}), ...(mine ? { locator: forStep.locator, candidates: forStep.candidates } : {}) } }
            })
            if (changed) commit(next)
          }}
        />

        {assistantOpen && (
          <AssistantPanel
            status={assistantStatus.data}
            sessions={sessions}
            loading={assistantStatus.isPending || (assistantStatus.data?.enabled === true && sessionsQuery.isPending)}
            // Without a status, or without ever having had the list, there is nothing to show but the problem.
            loadError={
              assistantStatus.isError && !assistantStatus.data
                ? { message: errorText(assistantStatus.error), retrying: assistantStatus.isFetching, onRetry: () => void assistantStatus.refetch() }
                : sessionsQuery.isError && !sessionsQuery.data
                  ? { message: errorText(sessionsQuery.error), retrying: sessionsQuery.isFetching, onRetry: () => void sessionsQuery.refetch() }
                  : null
            }
            sending={ask.isPending}
            aborting={abortAssistant.isPending}
            onSend={(message) =>
              ask.mutateAsync(message).then(
                () => true,
                () => false, // onError has shown why; the panel keeps the text
              )
            }
            onAbort={(sid) => abortAssistant.mutate(sid)}
            onClose={() => toggleAssistant(false)}
          />
        )}
      </div>

      {pendingDevice && (
        <Confirm
          title={`Switch to ${DEVICES[pendingDevice].label}?`}
          confirmLabel={`Switch to ${DEVICES[pendingDevice].label}`}
          busy={setDevice.isPending}
          onConfirm={() => setDevice.mutate(pendingDevice)}
          onClose={() => setPendingDevice(null)}
        >
          {(() => {
            const others = uis.filter((u) => u.device !== pendingDevice)
            const from = [...new Set(others.map((u) => DEVICES[u.device].label))].join(' and ')
            return `${others.length === 1 ? 'One captured screen of this test case was' : `${others.length} captured screens of this test case were`} taken on ${from}. They are kept and stay marked with their device, but on ${DEVICES[pendingDevice].label} the page can be laid out differently, and elements can move or hide (for example behind a menu button). Capture the screens again before picking more elements, and run the test to check the existing steps.`
          })()}
        </Confirm>
      )}

      {palette && (
        <CommandPalette
          position={palette.index >= steps.length ? 'at the end' : `as step ${palette.index + 1}`}
          onClose={() => setPalette(null)}
          onPick={(command: CommandId) => {
            const step = newStep(command)
            insertAt(Math.min(palette.index, stepsRef.current.length), step)
            setPalette(null)
            if (COMMAND_BY_ID[command].target) {
              setPickForId(step.id)
              setInspect(null)
            } else {
              // Wait for the dialog to hand focus back before moving it into the new row.
              window.setTimeout(() => setFocusId(step.id), 0)
            }
          }}
        />
      )}
    </div>
  )
}

function SaveBadge({ state, onRetry }: { state: SaveState; onRetry: () => void }) {
  if (state === 'error')
    return (
      <button type="button" className="ed-save is-error" onClick={onRetry} title="Saving failed. Click to try again.">
        <CloudAlert size={14} /> Not saved, retry
      </button>
    )
  return (
    <span className={cx('ed-save', `is-${state}`)} role="status">
      {state === 'saving' ? <Spinner size={13} /> : state === 'saved' ? <Check size={14} /> : <span className="ed-save-dot" />}
      {state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved' : 'Unsaved'}
    </span>
  )
}
