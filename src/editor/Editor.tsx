import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Check, ChevronDown, CloudAlert, ListPlus, Table2, Play, Plus, Redo2, Sparkles, Square, Undo2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useParams } from 'react-router-dom'
import { COMMAND_BY_ID, DEFAULT_COMMAND, sharedLabel, stepSentence } from '../../shared/commands'
import { hasPatterns } from '../../shared/data'
import { DEVICE_IDS, DEVICES, deviceOf } from '../../shared/devices'
import { positionLabel, reportedSteps } from '../../shared/expand'
import type { AssistantSession, CommandId, DeviceId, Step, StepResult, TestCase, Ui, UiElement } from '../../shared/types'
import { api, ApiError, qk } from '../api'
import { DataGrid, useDataDraft } from '../components/DataGrid'
import { Button, Confirm, DeviceIcon, Dialog, ErrorState, Field, IconButton, Loading, MenuButton, Spinner, StatusIcon, toast, toastError } from '../components/ui'
import { cx, isTerminal, plural, STATUS_LABEL, uid } from '../lib/format'
import { AssistantPanel } from './AssistantPanel'
import { changeCommand, makeTarget, newStep, sameStep, sharedLookup, stepErrors } from './model'
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
  // A shared step is edited here like a test case; it cannot call other shared steps, so it does not load them.
  const isShared = tc.data?.kind === 'shared'
  // Asked for again whenever the editor opens or the window gets the focus back: a call row shows the shared step's
  // steps and its problems, and those are edited on another page (or in another tab).
  const sharedQuery = useQuery({ queryKey: qk.sharedSteps(pid ?? ''), queryFn: () => api.sharedSteps(pid!), enabled: !!pid && !isShared, staleTime: 0, refetchOnMount: 'always', refetchOnWindowFocus: true })
  const shared = useMemo(() => sharedLookup(sharedQuery.data), [sharedQuery.data])

  // ----- steps, history, autosave -----
  const [steps, setSteps] = useState<Step[]>([])
  const [ready, setReady] = useState(false)
  const stepsRef = useRef<Step[]>(steps)
  const hist = useRef<{ undo: Step[][]; redo: Step[][]; key: string | null }>({ undo: [], redo: [], key: null })
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const save = useRef<{ dirty: boolean; timer: number; inflight: Promise<boolean> | null }>({ dirty: false, timer: 0, inflight: null })
  // While the assistant edits the steps on the server, the editor only follows: nothing here may change or save them.
  const lockedRef = useRef(false)
  // The revision of the steps on the server that the steps on screen are based on. Every save says so, and the
  // server refuses one that is based on an older list than it has.
  const revRef = useRef<string | undefined>(undefined)
  // The steps were changed somewhere else (another tab, an approved repair) since this editor loaded them.
  // Editing stops until the saved steps are loaded: saving would undo that other change.
  const [conflict, setConflict] = useState(false)

  useEffect(() => {
    if (ready || !tc.data || !tc.isFetchedAfterMount) return
    stepsRef.current = tc.data.steps
    revRef.current = tc.data.stepsRev
    setSteps(tc.data.steps)
    setReady(true)
  }, [ready, tc.data, tc.isFetchedAfterMount])

  /** Put the steps the server has on screen as the new starting point: nothing here is unsaved after this. */
  const adopt = useCallback((saved: TestCase) => {
    const s = save.current
    window.clearTimeout(s.timer)
    s.dirty = false
    revRef.current = saved.stepsRev
    if (JSON.stringify(saved.steps) !== JSON.stringify(stepsRef.current)) {
      stepsRef.current = saved.steps
      setSteps(saved.steps)
    }
    setSaveState('saved')
  }, [])

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
      s.inflight = api.updateTestCase(tid, { steps: snapshot, baseStepsRev: revRef.current }).then(
        (next) => {
          revRef.current = next.stepsRev
          qc.setQueryData(qk.testCase(tid), next)
          // The test cases that call this shared step show its steps and check them: they must not go on using the old ones.
          if (next.kind === 'shared') void qc.invalidateQueries({ queryKey: qk.sharedSteps(next.projectId) })
          return true
        },
        (err) => {
          const code = err instanceof ApiError ? err.code : undefined
          if (code === 'steps_changed') {
            // Trying again cannot work, and must not: the banner offers to load the saved steps.
            setConflict(true)
          } else {
            s.dirty = true
            // The assistant was started on this test case somewhere else: finding its session locks the editor
            // and loads its steps when it is done.
            if (code === 'assistant_busy') void qc.invalidateQueries({ queryKey: qk.assistant(tid) })
            toastError(err)
          }
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
  // Undo and Redo change the list without moving focus, so a screen reader is told what happened. A repeat
  // of the same message gets a trailing no-break space: a live region only speaks when its text changes.
  const [histMsg, setHistMsg] = useState('')
  const announceHistory = useCallback((text: string) => setHistMsg((prev) => (prev === text ? `${text}\u00a0` : text)), [])
  const undo = useCallback(() => {
    if (lockedRef.current) return
    const h = hist.current
    const prev = h.undo.pop()
    if (!prev) return
    h.redo.push(stepsRef.current)
    h.key = null
    apply(prev)
    announceHistory(`Undone. ${plural(prev.length, 'step')}.`)
  }, [apply, announceHistory])
  const redo = useCallback(() => {
    if (lockedRef.current) return
    const h = hist.current
    const next = h.redo.pop()
    if (!next) return
    h.undo.push(stepsRef.current)
    h.key = null
    apply(next)
    announceHistory(`Redone. ${plural(next.length, 'step')}.`)
  }, [apply, announceHistory])

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
  // The far end of a multi-selection that starts at the selected step (Shift+click, Shift+arrows).
  const [rangeEndId, setRangeEndId] = useState<string | null>(null)
  const range = useMemo(() => {
    const a = steps.findIndex((s) => s.id === selectedId)
    const b = steps.findIndex((s) => s.id === rangeEndId)
    if (a < 0 || b < 0 || a === b) return new Set<string>()
    return new Set(steps.slice(Math.min(a, b), Math.max(a, b) + 1).map((s) => s.id))
  }, [steps, selectedId, rangeEndId])
  // Whatever selects another step ends the multi-selection.
  useEffect(() => setRangeEndId(null), [selectedId])
  const rangeRef = useRef(range)
  rangeRef.current = range

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
      setRangeEndId(null)
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

  const removeSteps = useCallback(
    (ids: string[]) => {
      if (lockedRef.current || ids.length === 0) return
      const gone = new Set(ids)
      const cur = stepsRef.current
      const first = cur.findIndex((s) => gone.has(s.id))
      const next = cur.filter((s) => !gone.has(s.id))
      commit(next)
      setSelectedId(next[Math.min(Math.max(0, first), next.length - 1)]?.id ?? null)
      if (pickForId && gone.has(pickForId)) setPickForId(null)
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
  const errors = useMemo(
    () => stepErrors(steps, { lookup: sharedQuery.data ? shared : undefined, projectId: pid ?? '', nested: isShared }),
    [steps, shared, sharedQuery.data, pid, isShared],
  )
  // ----- data -----
  // A data-driven test case: a full run executes every data row; a partial run and a capture use one of them.
  const table = tc.data && hasPatterns(tc.data.data) ? tc.data.data : null
  const [dataRow, setDataRow] = useState(1)
  const row = table ? Math.min(dataRow, table.rows.length) : undefined
  const start = useMutation({
    mutationFn: async (range: { from: number; to: number } | null) => {
      if (!(await flush())) throw new Error('The steps could not be saved, so the run was not started.')
      return api.startRun(tid, range, row)
    },
    onSuccess: (r) => {
      qc.setQueryData(qk.run(r.id), r)
      setRunId(r.id)
    },
  })
  const abort = useMutation({ mutationFn: () => api.abortRun(runId!), onSuccess: (r) => qc.setQueryData(qk.run(r.id), r) })
  const runData = runId ? run.data : undefined
  const running = start.isPending || (!!runData && !isTerminal(runData.status))
  // The step list shows one pattern of a data-driven run: the one that is running, afterwards the first that
  // did not pass (the run page has them all).
  const shownPattern = useMemo(() => {
    const patterns = runData?.patterns
    if (!patterns) return undefined
    const live = !isTerminal(runData.status)
    return ((live && patterns.find((p) => p.status === 'running')) || patterns.find((p) => isTerminal(p.status) && p.status !== 'succeeded') || (live && patterns.findLast((p) => isTerminal(p.status))) || patterns[0]).index
  }, [runData?.patterns, runData?.status])
  const reported = useMemo(
    () => new Map<string, StepResult>((runData?.results ?? []).filter((r) => r.pattern === shownPattern).map((r) => [r.stepId, r])),
    [runData?.results, shownPattern],
  )
  // A row only shows a result while the step is still what the run executed; an edited step has not been run.
  const results = useMemo(() => {
    const ran = new Map((runData?.steps ?? []).map((s) => [s.id, s]))
    // The run has every shared step call expanded: the results of a call's steps are shown on the call.
    const inside = new Map<string, StepResult[]>()
    for (const s of runData?.steps ?? []) {
      const result = s.origin && reported.get(s.id)
      if (!result) continue
      const list = inside.get(s.origin!.callId)
      if (list) list.push(result)
      else inside.set(s.origin!.callId, [result])
    }
    const current = new Map<string, StepResult>()
    for (const s of steps) {
      const then = ran.get(s.id)
      if (!then || !sameStep(s, then)) continue
      const result = then.call ? callResult(s, inside.get(s.id)) : reported.get(s.id)
      if (result) current.set(s.id, result)
    }
    return current
  }, [steps, reported, runData?.steps])
  /** The step of this editor that a step of the run belongs to: for a step inside a shared step, its call. */
  const ownerOf = useCallback((stepId: string) => runData?.steps.find((s) => s.id === stepId)?.origin?.callId ?? stepId, [runData?.steps])
  const expected = useMemo(() => (runData ? reportedSteps(runData.steps, runData.range) : []), [runData])
  const runningId = useMemo(() => {
    if (!runData || runData.status !== 'running') return null
    const next = expected.find((s) => !reported.has(s.id))
    return next ? (next.origin?.callId ?? next.id) : null
  }, [runData, expected, reported])
  const finished = runData && isTerminal(runData.status) ? runData : null
  useEffect(() => {
    if (!finished) return
    void qc.invalidateQueries({ queryKey: qk.runs(tid) })
    void qc.invalidateQueries({ queryKey: qk.testCase(tid), refetchType: 'none' })
    const failed = finished.results.find((r) => r.status === 'failed' && r.pattern === shownPattern)
    if (failed) setSelectedId(ownerOf(failed.stepId))
    // A partial run that executed none of its steps "succeeded" without checking anything: say so, and why.
    if (finished.range && finished.status === 'succeeded' && finished.results.length === 0) {
      const { from, to } = finished.range
      const why = /^\[[\d.]+\] skipped: (.*)$/m.exec(finished.log)?.[1]
      const row = finished.patterns?.length === 1 ? ` (data row ${finished.patterns[0].index})` : ''
      toast(`${from === to ? `Step ${from} was` : `Steps ${from}–${to} were`} not executed${row}${why ? `: ${why}` : ''}. Nothing was checked.`, 'error')
    }
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
  // The session whose edits the editor is following; it stays set until the final state has been loaded.
  const [following, setFollowing] = useState<string | null>(null)
  const followingRef = useRef<string | null>(null)
  followingRef.current = following
  const sessionsQuery = useQuery({
    queryKey: qk.assistant(tid),
    queryFn: () => api.assistantSessions(tid),
    enabled: assistantStatus.data?.enabled === true,
    staleTime: 0,
    // A list that could not be loaded is asked for again: "no sessions" must be something the server said.
    // So is one that does not have the session being followed (an answer that was on its way before the
    // session was created): without it the editor would stay locked with nothing to wait for.
    refetchInterval: (q) =>
      q.state.status === 'error' ? 5000 : q.state.data?.some(isActiveSession) || (followingRef.current && !q.state.data?.some((s) => s.id === followingRef.current)) ? 1500 : false,
  })
  const sessions = useMemo(() => sessionsQuery.data ?? [], [sessionsQuery.data])
  const activeSession = sessions.find(isActiveSession)
  const beforeAssistant = useRef<Step[] | null>(null)
  const ask = useMutation({
    mutationFn: async (message: string) => {
      if (lockedRef.current && !followingRef.current) throw new Error('The steps were changed somewhere else. Load the saved steps first.')
      if (!(await flush())) throw new Error('The steps could not be saved, so the assistant was not started.')
      const before = stepsRef.current
      // A list request that is under way was answered before the session exists; it must not replace the list that has it.
      await qc.cancelQueries({ queryKey: qk.assistant(tid) })
      const session = await api.askAssistant(tid, message)
      beforeAssistant.current = before
      return session
    },
    onSuccess: (session) => {
      qc.setQueryData<AssistantSession[]>(qk.assistant(tid), (old) => [...(old ?? []).filter((s) => s.id !== session.id), session])
      setFollowing(session.id)
    },
    onError: (err) => {
      // A session this tab does not know of is running (started in another tab): show it and follow it.
      if (err instanceof ApiError && err.status === 409) void qc.invalidateQueries({ queryKey: qk.assistant(tid) })
      toastError(err)
    },
  })
  const abortAssistant = useMutation({
    mutationFn: (sid: string) => api.abortAssistant(sid),
    onSuccess: (session) => qc.setQueryData<AssistantSession[]>(qk.assistant(tid), (old) => (old ?? []).map((s) => (s.id === session.id ? session : s))),
    onError: toastError,
  })
  useEffect(() => {
    if (activeSession) setFollowing(activeSession.id)
  }, [activeSession?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const assisting = ask.isPending || !!activeSession || !!following
  const locked = assisting || conflict
  lockedRef.current = locked
  const reload = useMutation({
    mutationFn: () => Promise.all([api.testCase(tid), api.uis(tid)]),
    onSuccess: ([saved, savedUis]) => {
      // What was on screen stays one undo away: undoing puts it back as a new edit on top of the saved steps.
      const mine = stepsRef.current
      qc.setQueryData(qk.testCase(tid), saved)
      qc.setQueryData(qk.uis(tid), savedUis)
      adopt(saved)
      if (JSON.stringify(mine) !== JSON.stringify(saved.steps)) {
        const h = hist.current
        h.undo.push(mine)
        h.redo = []
        h.key = null
      }
      setPickForId(null)
      setConflict(false)
      toast('Loaded the saved steps. Undo brings back what was on screen here.')
    },
    onError: toastError,
  })

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
        // The assistant owns the steps now: an edit made here that could not be saved (the session was started
        // in another tab) is dropped with them, and must not be saved over its work afterwards.
        adopt(nextCase)
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
  const CONFLICT_NOTE = 'The steps were changed somewhere else. Load the saved steps first.'
  const unavailable = conflict ? CONFLICT_NOTE : assisting ? 'The assistant is editing the steps. Wait for it to finish, or abort it.' : enabledCount === 0 ? 'Add a step before running.' : null
  const blocked = unavailable ?? (errors.size > 0 ? 'Fix the highlighted steps before running.' : null)
  const startRun = (range: { from: number; to: number } | null) => {
    if (running) return
    // A partial run executes the steps up to its last one: what is wrong further down (a branch that is still
    // being built, a step without an element) does not stop it, as it does not stop the engine.
    const problems = range ? stepErrors(steps, { lookup: sharedQuery.data ? shared : undefined, projectId: pid ?? '', nested: isShared }, range.to) : errors
    const reason = unavailable ?? (problems.size > 0 ? (range ? `Fix the highlighted steps up to step ${range.to} before running them.` : 'Fix the highlighted steps before running.') : null)
    if (reason) {
      toast(reason, 'error')
      const first = steps.find((s) => problems.has(s.id))
      if (first) setSelectedId(first.id)
      return
    }
    if (range && steps.slice(range.from - 1, range.to).every((s) => s.disabled)) return toast(range.from === range.to ? `Step ${range.from} is disabled, so there is nothing to run.` : `Steps ${range.from}–${range.to} are all disabled, so there is nothing to run.`, 'error')
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
      return api.capture(tid, 'afterStepId' in req && row ? { ...req, row } : req)
    },
    onSuccess: (res) => {
      qc.setQueryData<Ui[]>(qk.uis(tid), (old) => [...(old ?? []).filter((u) => u.id !== res.ui.id), res.ui])
      setCurrentUiId(res.ui.id)
      setInspect(null)
      if (res.replayError) {
        setReplayError({ uiId: res.ui.id, stepId: res.replayError.stepId, message: res.replayError.message })
      } else {
        setReplayError(null)
        // Assertions set to continue on failure did not stop the replay: the capture is of the page asked for.
        const numbers = [...new Set((res.tolerated ?? []).map((f) => stepsRef.current.findIndex((s) => s.id === f.stepId) + 1).filter((n) => n > 0))]
        const passing = numbers.length ? ` On the way, the assertion${numbers.length === 1 ? '' : 's'} at step${numbers.length === 1 ? '' : 's'} ${numbers.join(', ')} failed and the replay continued.` : ''
        toast(`Captured “${res.ui.name}” with ${res.ui.elements.length} elements.${passing}`)
      }
    },
  })
  // ----- shared steps -----
  const createShared = useMutation({
    mutationFn: () => api.createSharedStep(pid!, { device: tc.data?.device }),
    onSuccess: (created) => {
      void qc.invalidateQueries({ queryKey: qk.sharedSteps(created.projectId) })
      qc.setQueryData(qk.sharedSteps(created.projectId), (old: typeof sharedQuery.data) => [...(old ?? []), created])
      const at = palette?.index ?? stepsRef.current.length
      insertAt(Math.min(at, stepsRef.current.length), newStep('shared_step', { value: created.id }))
      setPalette(null)
      toast(`Created shared step ${sharedLabel(created)}. Use “Open” on the step to add its steps.`)
    },
  })
  // The steps (by id) that "Move to a new shared step" was asked for; the dialog asks for the name.
  const [extracting, setExtracting] = useState<string[] | null>(null)
  const extract = useMutation({
    mutationFn: async (name: string) => {
      // The server moves the steps it has stored, so it must have the ones on screen.
      if (!(await flush())) throw new Error('The steps could not be saved, so nothing was moved.')
      const before = stepsRef.current
      return { before, ...(await api.extractShared(tid, { stepIds: extracting ?? [], name: name.trim() || undefined })) }
    },
    onSuccess: ({ before, testCase, shared: created }) => {
      qc.setQueryData(qk.testCase(tid), testCase)
      revRef.current = testCase.stepsRev
      void qc.invalidateQueries({ queryKey: qk.sharedSteps(testCase.projectId) })
      // One undo step puts the steps back in the test case; the shared step stays in the project.
      const h = hist.current
      h.undo.push(before)
      h.redo = []
      h.key = null
      stepsRef.current = testCase.steps
      setSteps(testCase.steps)
      const callId = testCase.steps.find((s) => s.command === 'shared_step' && s.value === created.id)?.id ?? null
      setSelectedId(callId)
      setExtracting(null)
      // The rows the dialog was opened from are gone; the keyboard goes on from the call that replaced them.
      if (callId) window.setTimeout(() => setFocusId(callId), 0)
      toast(`Moved ${plural(created.steps.length, 'step')} to shared step ${sharedLabel(created)}`)
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
    return { n: i + 1, sentence: i >= 0 ? stepSentence(steps[i], shared) : null, message: replayError.message }
  }, [replayError, ui?.id, steps, shared])
  const capturing = capture.isPending
    ? 'afterStepId' in capture.variables
      ? `Replaying steps 1–${Math.max(1, steps.findIndex((s) => s.id === (capture.variables as { afterStepId: string }).afterStepId) + 1)}, then capturing…`
      : 'Opening the URL and capturing…'
    : null

  const LOCKED_NOTE = conflict ? CONFLICT_NOTE : 'The assistant is working on this test case. Wait for it to finish, or abort it.'
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
      if (document.querySelector('dialog:modal, .popover')) return
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
      // Keys that belong to an input method's conversion are not shortcuts.
      if (e.isComposing || e.keyCode === 229) return
      if (e.key === 'Escape') {
        if (rangeRef.current.size) setRangeEndId(null)
        else if (pickForId) setPickForId(null)
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
      // An element outline on the screenshot has its own arrow keys (they move between the outlines). Delete
      // still removes the selected step while one has focus, as it does right after clicking an element.
      const onOutline = !!t.closest?.('.el-box')
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        e.preventDefault()
        if (rangeRef.current.size) removeSteps([...rangeRef.current])
        else removeStep(selectedId)
      } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !onOutline) {
        const cur = stepsRef.current
        if (!cur.length) return
        e.preventDefault()
        const move = (id: string | null) => {
          const i = cur.findIndex((s) => s.id === id)
          return i < 0 ? 0 : Math.max(0, Math.min(cur.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))
        }
        // With Shift the selected step stays where it is and the other end of the selection moves.
        if (e.shiftKey && selectedId) setRangeEndId(cur[move(rangeEndId ?? selectedId)].id)
        else select(cur[move(selectedId)].id)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [undo, redo, commit, removeStep, removeSteps, select, selectedId, rangeEndId, pickForId, inspect])

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
        <Link to={`/t/${tid}`} className="ed-back" title={isShared ? 'Back to the shared step' : 'Back to the test case'}>
          <ArrowLeft size={16} />
          <span>Back</span>
        </Link>
        <nav className="ed-crumbs" aria-label="Breadcrumb">
          <Link to={`/p/${t.projectId}${isShared ? '?tab=shared' : ''}`} className="truncate" title={project.data?.name}>
            {project.data?.name ?? 'Project'}
          </Link>
          <span aria-hidden>/</span>
          <span className="truncate ed-crumb-current" title={t.name}>
            {t.name}
          </span>
          <span className="ed-hash num" title={isShared ? 'Shared step: test cases call it with the “Shared step” command' : undefined}>
            {isShared ? `S${t.number}` : `#${t.number}`}
          </span>
        </nav>
        <SaveBadge state={saveState} onRetry={() => (conflict ? reload.mutate() : void flush())} />
        <MenuButton
          className="ed-device"
          label={isShared ? 'Device this shared step is captured on (a test case that calls it runs it on its own device)' : 'Device this test case is captured and run on'}
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
          className="ed-device ed-asst-toggle"
          aria-pressed={assistantOpen}
          title={assistantOpen ? 'Close the assistant' : 'Build steps by describing the test'}
          onClick={() => toggleAssistant(!assistantOpen)}
        >
          {assisting ? <Spinner size={13} /> : <Sparkles size={14} />}
          <span>Assistant</span>
        </button>
        {!isShared && <DataControl testCase={t} />}
        {table && table.rows.length > 1 && (
          <select
            className="ed-row"
            aria-label="Data row for partial runs and captures"
            title="The data row that “Run up to this step”, “Run only this step” and captures use. A full run executes every row."
            value={row}
            disabled={running}
            onChange={(e) => setDataRow(Number(e.target.value))}
          >
            {table.rows.map((_, i) => (
              <option key={i} value={i + 1}>
                Row {i + 1}
              </option>
            ))}
          </select>
        )}
        <span className="ed-gap" />
        <div className="ed-run" aria-live="polite">
          {runData ? (
            <>
              <span className={cx('ed-run-status', `status-${runData.status}`)}>
                <StatusIcon status={runData.status} size={16} />
                {STATUS_LABEL[runData.status]}
                {runData.range && <span className="ed-run-range num">steps {runData.range.from === runData.range.to ? runData.range.from : `${runData.range.from}–${runData.range.to}`}</span>}
                {runData.patterns && runData.patterns.length > 1 && shownPattern && (
                  <span className="ed-run-range num">
                    pattern {shownPattern}/{runData.patterns.length}
                  </span>
                )}
                {runData.patterns?.length === 1 && <span className="ed-run-range num">row {runData.patterns[0].index}</span>}
                {!isTerminal(runData.status) && runData.steps.length > 0 && (
                  <span className="ed-run-range num">
                    {reported.size} / {expected.length}
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
          <Button className="ed-run-btn" variant="primary" icon={<Play size={14} />} busy={start.isPending} title={blocked ?? (table ? `Run every step once for each of the ${table.rows.length} data rows, each in a fresh cloud browser` : 'Run every step in a fresh cloud browser')} aria-disabled={!!blocked} onClick={() => startRun(null)}>
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
          {conflict && (
            <div className="ed-locked is-error" role="alert">
              <CloudAlert size={14} aria-hidden />
              <span>These steps were changed somewhere else (another tab, an approved repair or the assistant) after this page loaded them, so the last change here was not saved. Load the saved steps to go on; undo then brings back what is on screen now.</span>
              <Button size="sm" busy={reload.isPending} onClick={() => reload.mutate()}>
                Load saved steps
              </Button>
            </div>
          )}
          {assisting && !conflict && !syncError && (
            <div className="ed-locked" role="status">
              <Sparkles size={14} aria-hidden />
              <span>The assistant is editing the steps. They are read-only until it finishes.</span>
            </div>
          )}
          {assisting && !conflict && syncError && (
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
                canRun={!running && !unavailable}
                range={range}
                sharedSteps={sharedQuery.data}
                shared={shared}
                subResults={reported}
                canExtract={!isShared}
                onSelect={select}
                onExtend={(id) => {
                  if (!selectedRef.current) select(id)
                  else setRangeEndId(id)
                }}
                onDeleteMany={removeSteps}
                onExtract={setExtracting}
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

      <span className="sr-only" role="status">
        {histMsg}
      </span>

      {extracting && (
        <ExtractDialog count={extracting.length} busy={extract.isPending} onSubmit={(name) => extract.mutate(name)} onClose={() => !extract.isPending && setExtracting(null)} />
      )}

      {palette && (
        <CommandPalette
          position={palette.index >= steps.length ? 'at the end' : `as step ${palette.index + 1}`}
          onClose={() => setPalette(null)}
          shared={isShared ? undefined : { list: sharedQuery.data, creating: createShared.isPending, onCreate: () => createShared.mutate() }}
          onPick={(command: CommandId, value?: string) => {
            const step = newStep(command, value === undefined ? {} : { value })
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

/** What a shared step call shows as its own result: the outcome of the steps inside it. */
function callResult(call: Step, inside: StepResult[] | undefined): StepResult | undefined {
  if (!inside?.length) return undefined
  const failed = inside.find((r) => r.status === 'failed')
  const status = failed ? 'failed' : inside.some((r) => r.status === 'healed') ? 'healed' : 'passed'
  return {
    stepId: call.id,
    number: inside[0].number,
    status,
    sentence: '',
    durationMs: inside.reduce((n, r) => n + r.durationMs, 0),
    ...(failed ? { error: `Step ${positionLabel(failed)}: ${failed.error ?? 'failed'}` } : {}),
  }
}

/**
 * The Data button of the top bar and its dialog: the data table, edited without leaving the editor. It is
 * saved by itself (it is not part of the step history). The draft lives here, not in the dialog, so a
 * dialog dismissed by accident still has the unsaved table when it is opened again.
 */
function DataControl({ testCase }: { testCase: TestCase }) {
  const [open, setOpen] = useState(false)
  const { draft, setDraft, dirty, problems, save, discard } = useDataDraft(testCase)
  const rows = hasPatterns(testCase.data) ? testCase.data.rows.length : 0
  return (
    <>
      <button type="button" className="ed-device ed-data-toggle" title="Data table: the test case runs once for every row" onClick={() => setOpen(true)}>
        <Table2 size={14} />
        <span>
          {rows ? `Data (${plural(rows, 'row')})` : 'Data'}
          {dirty && !open && <span className="ed-data-dirty"> · unsaved</span>}
        </span>
      </button>
      {/* In the body, not in the top bar: the bar restyles the buttons and focus rings inside it. */}
      {open &&
        createPortal(
        <Dialog
          title="Data"
          width={920}
          onClose={() => !save.isPending && setOpen(false)}
          footer={
            <>
              {save.isError ? (
                <span className="form-error heal-foot-note" role="alert">
                  {save.error.message}
                </span>
              ) : (
                <span className="muted heal-foot-note">{dirty ? 'Unsaved changes' : ''}</span>
              )}
              <Button
                disabled={save.isPending}
                onClick={() => {
                  discard()
                  setOpen(false)
                }}
              >
                {dirty ? 'Discard changes' : 'Close'}
              </Button>
              <Button variant="primary" busy={save.isPending} disabled={!dirty || problems.length > 0} onClick={() => save.mutate(undefined, { onSuccess: () => setOpen(false) })}>
                Save data
              </Button>
            </>
          }
        >
          <p className="muted data-intro">
            With data, a run executes the steps once for every row, each in a fresh browser, and a step reads a cell as <code>{'${COLUMN}'}</code>. “Run up to
            this step”, “Run only this step” and captures use one row; with more than one row it is chosen next to this button.
          </p>
          <DataGrid value={draft} onChange={setDraft} disabled={save.isPending} />
        </Dialog>,
          document.body,
        )}
    </>
  )
}

function ExtractDialog({ count, busy, onSubmit, onClose }: { count: number; busy: boolean; onSubmit: (name: string) => void; onClose: () => void }) {
  const [name, setName] = useState('')
  return (
    <Dialog
      title={count === 1 ? 'Move this step to a new shared step' : `Move ${count} steps to a new shared step`}
      onClose={onClose}
      onSubmit={() => onSubmit(name)}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={busy}>
            Move
          </Button>
        </>
      }
    >
      <Field label="Name of the shared step" hint="The steps move there, and this test case calls it in their place. Other test cases can call it too; editing it changes all of them.">
        <input className="input" data-autofocus value={name} maxLength={120} placeholder="New shared step" onChange={(e) => setName(e.target.value)} />
      </Field>
    </Dialog>
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
