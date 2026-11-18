import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpToLine,
  Ban,
  ChevronDown,
  CircleAlert,
  CopyPlus,
  ChevronRight,
  ExternalLink,
  GripVertical,
  Layers,
  ArrowLeft,
  MoreHorizontal,
  MousePointerClick,
  Play,
  Plus,
  Search,
  SkipForward,
  Trash2,
} from 'lucide-react'
import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { CATEGORIES, COMMAND_BY_ID, COMMANDS, KEYS, sharedLabel, stepSentence, SWIPE_DIRECTIONS, validateSteps, type Category, type CommandDef } from '../../shared/commands'
import type { SharedLookup, SharedSource } from '../../shared/expand'
import type { CommandId, Step, StepResult, TestCase } from '../../shared/types'
import { Button, Dialog, Menu, onTablistKeyDown, Spinner, StatusIcon, type Anchor, type MenuItem } from '../components/ui'
import { cx, plural } from '../lib/format'
import { isComposing } from '../lib/hooks'
import { commandChoices, isNumeric, ROW_PARTS, stepDepths } from './model'

export interface StepListProps {
  steps: Step[]
  selectedId: string | null
  errors: Map<string, string>
  results: Map<string, StepResult>
  runningId: string | null
  pickFor: string | null
  focusId: string | null
  canRun: boolean
  /** The steps selected together (Shift+click, Shift+arrows): always consecutive, and more than one when present. */
  range: Set<string>
  /** The project's shared steps: undefined while loading. */
  sharedSteps: TestCase[] | undefined
  shared: SharedLookup
  /** Results of the steps inside shared step calls, by the id they have in the run (`callId.stepId`). */
  subResults: Map<string, StepResult>
  /** False in the editor of a shared step: shared steps do not nest. */
  canExtract: boolean
  onSelect: (id: string) => void
  /** Extend the selection from the selected step to this one. */
  onExtend: (id: string) => void
  onDeleteMany: (ids: string[]) => void
  onExtract: (ids: string[]) => void
  onChange: (id: string, patch: Partial<Step>, coalesce?: string) => void
  onCommand: (id: string, command: CommandId) => void
  onMove: (id: string, toIndex: number) => void
  onInsert: (index: number) => void
  onDuplicate: (id: string) => void
  onDelete: (id: string) => void
  onChip: (id: string) => void
  onRunRange: (from: number, to: number) => void
}

export function StepList(p: StepListProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<{ id: string; anchor: Anchor } | null>(null)
  const [cmdMenu, setCmdMenu] = useState<{ id: string; anchor: Anchor } | null>(null)
  const [sharedMenu, setSharedMenu] = useState<{ id: string; anchor: Anchor } | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const depths = useMemo(() => stepDepths(p.steps), [p.steps])

  useEffect(() => {
    if (!p.focusId) return
    const row = listRef.current?.querySelector<HTMLElement>(`[data-step="${p.focusId}"]`)
    row?.scrollIntoView({ block: 'nearest' })
    row?.querySelector<HTMLElement>('input.step-input, select.step-input')?.focus()
  }, [p.focusId])

  useEffect(() => {
    if (!p.selectedId) return
    listRef.current?.querySelector<HTMLElement>(`[data-step="${p.selectedId}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [p.selectedId])

  const indexFromPointer = (clientY: number): number => {
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-step]') ?? [])
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect()
      if (clientY < r.top + r.height / 2) return i
    }
    return rows.length
  }

  // Announced to screen readers, which do not see a row change places.
  const [moved, setMoved] = useState('')
  // A row that changes places is taken out of the document and put back, which drops focus to the page. When
  // the move came from the row's menu button, focus goes back to that button in the row's new place.
  const refocusMenu = useRef<string | null>(null)
  useEffect(() => {
    const id = refocusMenu.current
    if (!id) return
    refocusMenu.current = null
    listRef.current?.querySelector<HTMLElement>(`[data-step="${id}"] .step-more`)?.focus()
  }, [p.steps])
  const move = (step: Step, toIndex: number) => {
    if (menu && 'el' in menu.anchor) refocusMenu.current = step.id
    p.onMove(step.id, toIndex)
    const at = toIndex > p.steps.indexOf(step) ? toIndex : toIndex + 1
    setMoved(`Step moved to position ${at} of ${p.steps.length}.`)
  }

  const menuStep = menu ? p.steps.find((s) => s.id === menu.id) : undefined
  const menuIndex = menuStep ? p.steps.indexOf(menuStep) : -1
  // Opened on a step of a multi-selection, the menu's group actions apply to all of it.
  const group = menuStep ? (p.range.has(menuStep.id) ? p.steps.filter((s) => p.range.has(s.id)) : [menuStep]) : []
  const many = group.length > 1
  const extractProblem = group.some((s) => s.command === 'shared_step')
    ? 'A shared step cannot call another shared step.'
    : validateSteps(group).length
      ? 'Select whole If … End branch blocks.'
      : undefined
  const menuItems: MenuItem[] = menuStep
    ? [
        { label: 'Insert command above', icon: <ArrowUpToLine size={15} />, onSelect: () => p.onInsert(menuIndex) },
        { label: 'Insert command below', icon: <ArrowDownToLine size={15} />, onSelect: () => p.onInsert(menuIndex + 1) },
        { type: 'separator' },
        // The keyboard and screen reader way to reorder; dragging the grip does the same with a pointer.
        { label: 'Move up', icon: <ArrowUp size={15} />, disabled: menuIndex === 0, onSelect: () => move(menuStep, menuIndex - 1) },
        { label: 'Move down', icon: <ArrowDown size={15} />, disabled: menuIndex === p.steps.length - 1, onSelect: () => move(menuStep, menuIndex + 2) },
        { label: 'Duplicate', icon: <CopyPlus size={15} />, onSelect: () => p.onDuplicate(menuStep.id) },
        {
          label: menuStep.disabled ? 'Enable' : 'Disable',
          icon: <Ban size={15} />,
          hint: '⌘/',
          onSelect: () => p.onChange(menuStep.id, { disabled: !menuStep.disabled }),
        },
        ...(COMMAND_BY_ID[menuStep.command]?.assertion
          ? [
              {
                label: 'Continue on failure',
                checked: !!menuStep.continueOnFailure,
                icon: <SkipForward size={15} />,
                onSelect: () => p.onChange(menuStep.id, { continueOnFailure: !menuStep.continueOnFailure }),
              } satisfies MenuItem,
            ]
          : []),
        ...(p.canExtract
          ? [
              {
                label: many ? `Move ${group.length} steps to a new shared step` : 'Move to a new shared step',
                desc: extractProblem ?? (many ? undefined : 'Shift+click another step first to move several.'),
                icon: <Layers size={15} />,
                disabled: !!extractProblem,
                onSelect: () => p.onExtract(group.map((s) => s.id)),
              } satisfies MenuItem,
            ]
          : []),
        { type: 'separator' },
        { label: 'Run up to this step', icon: <Play size={15} />, disabled: !p.canRun, onSelect: () => p.onRunRange(1, menuIndex + 1) },
        {
          label: 'Run only this step',
          desc: menuIndex > 0 ? `Steps 1–${menuIndex} run first as set-up, so this step starts on the right page.` : undefined,
          icon: <Play size={15} />,
          disabled: !p.canRun,
          onSelect: () => p.onRunRange(menuIndex + 1, menuIndex + 1),
        },
        { type: 'separator' },
        {
          label: many ? `Delete ${group.length} steps` : 'Delete',
          icon: <Trash2 size={15} />,
          danger: true,
          hint: 'Del',
          onSelect: () => (many ? p.onDeleteMany(group.map((s) => s.id)) : p.onDelete(menuStep.id)),
        },
      ]
    : []

  const cmdStep = cmdMenu ? p.steps.find((s) => s.id === cmdMenu.id) : undefined
  const cmdItems: MenuItem[] = useMemo(() => {
    if (!cmdStep) return []
    const choices = commandChoices(cmdStep)
    const out: MenuItem[] = []
    for (const cat of CATEGORIES) {
      const inCat = choices.filter((c) => c.category === cat)
      if (!inCat.length) continue
      out.push({ type: 'heading', label: cat })
      for (const c of inCat) out.push({ label: c.label, checked: c.id === cmdStep.command, onSelect: () => p.onCommand(cmdStep.id, c.id) })
    }
    return out
  }, [cmdStep, p])

  const sharedMenuStep = sharedMenu ? p.steps.find((s) => s.id === sharedMenu.id) : undefined
  const sharedItems: MenuItem[] = !sharedMenuStep
    ? []
    : !p.sharedSteps
      ? [{ label: 'Loading shared steps…', disabled: true, onSelect: () => {} }]
      : p.sharedSteps.length === 0
        ? [{ label: 'This project has no shared steps', disabled: true, onSelect: () => {} }]
        : p.sharedSteps.map((t) => ({ label: sharedLabel(t), checked: t.id === sharedMenuStep.value, onSelect: () => p.onChange(sharedMenuStep.id, { value: t.id }) }))

  return (
    <>
    <div
      ref={listRef}
      className="steps"
      role="list"
      aria-label="Steps"
      onDragOver={(e) => {
        if (!dragId) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        const i = indexFromPointer(e.clientY)
        if (i !== dropIndex) setDropIndex(i)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropIndex(null)
      }}
      onDrop={(e) => {
        e.preventDefault()
        if (dragId && dropIndex != null) p.onMove(dragId, dropIndex)
        setDragId(null)
        setDropIndex(null)
      }}
    >
      {p.steps.map((step, i) => (
        <StepRow
          key={step.id}
          step={step}
          index={i}
          depth={depths[i]}
          selected={step.id === p.selectedId}
          inRange={p.range.has(step.id)}
          sharedTarget={step.command === 'shared_step' && step.value ? p.shared(step.value) : undefined}
          // Only while the call still shows a result: an edited call has not been run.
          subResults={p.results.has(step.id) ? p.subResults : undefined}
          sharedOpen={sharedMenu?.id === step.id}
          onSharedMenu={(anchor) => setSharedMenu({ id: step.id, anchor })}
          onExtend={() => p.onExtend(step.id)}
          error={p.errors.get(step.id)}
          result={p.results.get(step.id)}
          running={step.id === p.runningId}
          picking={step.id === p.pickFor}
          dragging={step.id === dragId}
          dropBefore={dropIndex === i}
          dropAfter={dropIndex === p.steps.length && i === p.steps.length - 1}
          cmdOpen={cmdMenu?.id === step.id}
          // Opened from the row's menu button, not as a context menu at the pointer.
          menuOpen={menu?.id === step.id && 'el' in menu.anchor}
          onSelect={() => p.onSelect(step.id)}
          onChange={(patch, coalesce) => p.onChange(step.id, patch, coalesce)}
          onChip={() => p.onChip(step.id)}
          onMenu={(anchor) => {
            if (!p.range.has(step.id)) p.onSelect(step.id)
            setMenu({ id: step.id, anchor })
          }}
          onCmdMenu={(anchor) => setCmdMenu({ id: step.id, anchor })}
          onDragStart={() => setDragId(step.id)}
          onDragEnd={() => {
            setDragId(null)
            setDropIndex(null)
          }}
        />
      ))}
      {menu && menuStep && <Menu anchor={menu.anchor} items={menuItems} onClose={() => setMenu(null)} />}
      {cmdMenu && cmdStep && <Menu anchor={cmdMenu.anchor} items={cmdItems} onClose={() => setCmdMenu(null)} />}
      {sharedMenu && sharedMenuStep && <Menu anchor={sharedMenu.anchor} items={sharedItems} onClose={() => setSharedMenu(null)} />}
    </div>
    <span className="sr-only" role="status">
      {moved}
    </span>
    <span className="sr-only" role="status">
      {p.range.size > 1 ? `${p.range.size} steps selected.` : ''}
    </span>
    </>
  )
}

interface RowProps {
  step: Step
  index: number
  depth: number
  selected: boolean
  /** Part of a multi-selection. */
  inRange: boolean
  /** The shared step a call points at, when it exists. */
  sharedTarget?: SharedSource
  subResults?: Map<string, StepResult>
  sharedOpen: boolean
  onSharedMenu: (anchor: Anchor) => void
  onExtend: () => void
  error?: string
  result?: StepResult
  running: boolean
  picking: boolean
  dragging: boolean
  dropBefore: boolean
  dropAfter: boolean
  cmdOpen: boolean
  menuOpen: boolean
  onSelect: () => void
  onChange: (patch: Partial<Step>, coalesce?: string) => void
  onChip: () => void
  onMenu: (anchor: Anchor) => void
  onCmdMenu: (anchor: Anchor) => void
  onDragStart: () => void
  onDragEnd: () => void
}

function StepRow(p: RowProps) {
  const { step } = p
  const rowRef = useRef<HTMLDivElement>(null)
  const def: CommandDef | undefined = COMMAND_BY_ID[step.command]
  const parts = ROW_PARTS[step.command] ?? []
  const status = p.result?.status
  const failText = p.result?.status === 'failed' ? p.result.error : undefined
  const [previewOpen, setPreviewOpen] = useState(false)
  const previewId = `${useId()}-shared`
  const target = p.sharedTarget

  return (
    <div
      ref={rowRef}
      role="listitem"
      data-step={step.id}
      aria-current={p.selected || undefined}
      className={cx(
        'step',
        p.selected && 'is-selected',
        p.inRange && 'is-in-range',
        step.disabled && 'is-disabled',
        p.dragging && 'is-dragging',
        p.dropBefore && 'drop-before',
        p.dropAfter && 'drop-after',
        status && `is-${status}`,
        p.error && 'has-error',
        step.command === 'comment' && 'is-comment',
      )}
      onMouseDown={(e) => {
        if (e.shiftKey && e.button === 0) {
          // Extends the selection; the default would select text and move focus into the row.
          e.preventDefault()
          p.onExtend()
          return
        }
        // The menu of a multi-selection is opened on one of its rows: that must not collapse it.
        if (p.inRange && (e.button === 2 || (e.target as HTMLElement).closest('.step-more'))) return
        p.onSelect()
      }}
      onFocusCapture={() => {
        if (!p.inRange) p.onSelect()
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        p.onMenu({ x: e.clientX, y: e.clientY })
      }}
    >
      <span
        className="step-grip"
        draggable
        title="Drag to reorder"
        aria-hidden
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', step.id)
          if (rowRef.current) e.dataTransfer.setDragImage(rowRef.current, 12, 16)
          p.onDragStart()
        }}
        onDragEnd={p.onDragEnd}
      >
        <GripVertical size={14} />
      </span>
      <span className="step-n num">{p.index + 1}</span>
      <div className="step-main" style={p.depth ? { paddingInlineStart: 8 + p.depth * 18 } : undefined}>
        <div className="step-line">
          {step.command === 'shared_step' ? (
            // A call does not turn into another command: what it does is chosen with the chip next to it.
            <span className="step-cmd is-static">{def?.label}</span>
          ) : (
            <button
              type="button"
              className="step-cmd"
              aria-haspopup="menu"
              aria-expanded={p.cmdOpen}
              title={`${def?.label ?? step.command} (change command)`}
              onClick={(e) => p.onCmdMenu({ el: e.currentTarget })}
            >
              <span className="truncate">{def?.label ?? step.command}</span>
              <ChevronDown size={14} />
            </button>
          )}
          {parts.map((part, i) => {
            if (part.kind === 'shared')
              return (
                <Fragment key={i}>
                  <button
                    type="button"
                    className={cx('step-chip', !target && 'is-empty')}
                    aria-haspopup="menu"
                    aria-expanded={p.sharedOpen}
                    title={target ? `${sharedLabel(target)} (choose another shared step)` : 'Choose the shared step to call'}
                    onClick={(e) => p.onSharedMenu({ el: e.currentTarget })}
                  >
                    <Layers size={14} />
                    <span className="truncate">{target ? sharedLabel(target) : step.value ? 'Shared step not found' : 'Choose shared step'}</span>
                  </button>
                  {target && (
                    <>
                      <button
                        type="button"
                        className="step-mini"
                        aria-expanded={previewOpen}
                        aria-controls={previewId}
                        aria-label={`${previewOpen ? 'Hide' : 'Show'} the steps of ${sharedLabel(target)}`}
                        title={previewOpen ? 'Hide its steps' : 'Show its steps'}
                        onClick={() => setPreviewOpen(!previewOpen)}
                      >
                        {previewOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        <span className="num">{plural(target.steps.length, 'step')}</span>
                      </button>
                      <Link className="step-mini" to={`/t/${target.id}/edit`} aria-label={`Open ${sharedLabel(target)} in the editor`} title="Open this shared step in the editor">
                        <ExternalLink size={14} />
                        <span>Open</span>
                      </Link>
                    </>
                  )}
                </Fragment>
              )
            if (part.kind === 'word')
              return (
                <span className="step-word" key={i}>
                  {part.text}
                </span>
              )
            if (part.kind === 'target')
              return step.target ? (
                <button type="button" className="step-chip" key={i} title={`${step.target.name}\n${step.target.locator.key}=${step.target.locator.value}`} onClick={p.onChip}>
                  <span className="truncate">{step.target.name}</span>
                </button>
              ) : (
                <button type="button" className={cx('step-chip is-empty', p.picking && 'is-picking')} key={i} onClick={p.onChip}>
                  <MousePointerClick size={14} />
                  <span>{p.picking ? 'Pick an element on the screen…' : 'Choose UI element'}</span>
                </button>
              )
            if (part.kind === 'variable')
              return (
                <input
                  key={i}
                  className="step-input step-var mono"
                  aria-label={def?.variable ?? 'Variable'}
                  placeholder="VARIABLE"
                  spellCheck={false}
                  value={step.variable ?? ''}
                  onChange={(e) => p.onChange({ variable: e.target.value.replace(/[^A-Za-z0-9_]/g, '') }, `${step.id}:variable`)}
                />
              )
            if (step.command === 'press_key') {
              const keys = step.value && !KEYS.includes(step.value) ? [step.value, ...KEYS] : KEYS
              return (
                <select key={i} className="step-input step-key" aria-label="Key" value={step.value ?? 'Enter'} onChange={(e) => p.onChange({ value: e.target.value })}>
                  {keys.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
              )
            }
            if (step.command === 'swipe') {
              const directions = step.value && !SWIPE_DIRECTIONS.includes(step.value) ? [step.value, ...SWIPE_DIRECTIONS] : SWIPE_DIRECTIONS
              return (
                <select
                  key={i}
                  className="step-input step-key"
                  aria-label="Direction"
                  title="The direction the finger moves: swiping up shows what is further down the page"
                  value={step.value ?? 'up'}
                  onChange={(e) => p.onChange({ value: e.target.value })}
                >
                  {directions.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              )
            }
            return (
              <input
                key={i}
                className={cx('step-input', isNumeric(step.command) ? 'step-num num' : 'step-value')}
                aria-label={def?.value ?? 'Value'}
                placeholder={def?.value}
                inputMode={isNumeric(step.command) ? 'decimal' : undefined}
                spellCheck={false}
                value={step.value ?? ''}
                title={step.value && step.value.length > 24 ? step.value : undefined}
                onChange={(e) => p.onChange({ value: e.target.value }, `${step.id}:value`)}
              />
            )
          })}
          {step.continueOnFailure && (
            <span className="step-flag" title="If this assertion fails, the run records it and keeps going">
              continues on failure
            </span>
          )}
        </div>
        {target && previewOpen && (
          // Read-only: a shared step is edited in its own editor, for every test case that calls it.
          <ol className="step-shared" id={previewId} aria-label={`Steps of ${sharedLabel(target)}`}>
            {target.steps.length === 0 && <li className="is-none">No steps yet. Open it to add some.</li>}
            {target.steps.map((inner, j) => {
              const res = p.subResults?.get(`${step.id}.${inner.id}`)
              return (
                <li key={inner.id} className={cx(inner.disabled && 'is-disabled', res && `is-${res.status}`)}>
                  <span className="step-shared-n num">
                    {p.index + 1}.{j + 1}
                  </span>
                  <span className="step-shared-text">
                    {stepSentence(inner)}
                    {res?.status === 'failed' && res.error && <span className="step-shared-error">{res.error}</span>}
                  </span>
                  {res && <StatusIcon status={res.status} size={14} />}
                </li>
              )
            })}
          </ol>
        )}
        {(p.error || failText) && (
          <p className={cx('step-msg', p.error ? 'is-warn' : 'is-fail')} role={p.error ? undefined : 'alert'}>
            {p.error ?? failText}
          </p>
        )}
      </div>
      <span className="step-status">
        {p.running ? (
          <StatusIcon status="running" size={16} />
        ) : status ? (
          <StatusIcon status={status} size={16} />
        ) : p.error ? (
          <CircleAlert size={16} className="st st-review" role="img" aria-label="Has an error" />
        ) : null}
      </span>
      <button
        type="button"
        className="step-more"
        aria-label={`Actions for step ${p.index + 1}`}
        aria-haspopup="menu"
        aria-expanded={p.menuOpen}
        onClick={(e) => {
          e.stopPropagation()
          p.onMenu({ el: e.currentTarget })
        }}
      >
        <MoreHorizontal size={16} />
      </button>
    </div>
  )
}

// ---------- Command palette ----------

type PaletteTab = Category | 'All'

export interface PaletteShared {
  /** The project's shared steps; undefined while loading. */
  list: TestCase[] | undefined
  creating: boolean
  /** Create a shared step and add a call to it. */
  onCreate: () => void
}

/**
 * `shared`: offer the "Shared step" command, which then asks which one (omitted in the editor of a shared
 * step, where a call is not allowed). onPick gets the shared step's id as `value`.
 */
export function CommandPalette({ onPick, onClose, position, shared }: { onPick: (id: CommandId, value?: string) => void; onClose: () => void; position: string; shared?: PaletteShared }) {
  const [tab, setTab] = useState<PaletteTab>('All')
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  // The second page of the dialog: which shared step to call.
  const [choosing, setChoosing] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const q = query.trim().toLowerCase()
  const list = COMMANDS.filter((c) => (shared || c.id !== 'shared_step') && (q ? c.label.toLowerCase().includes(q) || c.category.toLowerCase().includes(q) : tab === 'All' || c.category === tab))
  const sharedList = (shared?.list ?? []).filter((t) => !q || sharedLabel(t).toLowerCase().includes(q))
  const count = choosing ? sharedList.length : list.length
  const current = Math.min(active, Math.max(0, count - 1))
  const pick = (id: CommandId) => {
    if (id !== 'shared_step') return onPick(id)
    setChoosing(true)
    setQuery('')
    setActive(0)
  }
  const leave = () => {
    setChoosing(false)
    setQuery('')
    setActive(0)
  }

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [current, tab, q, choosing])
  // The control that was clicked is gone after the page change: the search field takes the focus.
  useEffect(() => {
    searchRef.current?.focus()
  }, [choosing])

  return (
    <Dialog title={choosing ? `Add a shared step call ${position}` : `Add command ${position}`} onClose={onClose} width={600}>
      <div
        className="palette"
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setActive(Math.min(count - 1, current + 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActive(Math.max(0, current - 1))
          } else if (e.key === 'Enter' && current < count && !(e.target as HTMLElement).closest('[role="tab"], .palette-back, .palette-empty')) {
            e.preventDefault()
            // Not the Enter that confirms an input method's conversion in the search field.
            if (isComposing(e)) return
            if (choosing) onPick('shared_step', sharedList[current].id)
            else pick(list[current].id)
          }
        }}
      >
        <div className="palette-search">
          <Search size={16} />
          <input
            ref={searchRef}
            data-autofocus
            aria-label={choosing ? 'Search shared steps' : 'Search commands'}
            placeholder={choosing ? 'Search shared steps' : 'Search commands'}
            enterKeyHint="search"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
            }}
          />
        </div>
        {choosing && (
          <div className="palette-back">
            <Button size="sm" icon={<ArrowLeft size={14} />} onClick={leave}>
              All commands
            </Button>
            <span className="muted">Choose the shared step to call.</span>
          </div>
        )}
        {choosing && (
          <div className="palette-list" role="listbox" ref={listRef} aria-label="Shared steps">
            {!shared?.list ? (
              <p className="palette-empty">
                <Spinner size={14} /> Loading shared steps…
              </p>
            ) : shared.list.length === 0 ? (
              <div className="palette-empty">
                <p>
                  This project has no shared steps yet. A shared step is a sequence of steps kept in one place and called from several test cases, such as
                  signing in.
                </p>
                <Button variant="primary" icon={<Plus size={14} />} busy={shared.creating} onClick={shared.onCreate}>
                  Create a shared step
                </Button>
              </div>
            ) : sharedList.length === 0 ? (
              <p className="palette-empty">No shared step matches “{query}”.</p>
            ) : (
              sharedList.map((t, i) => (
                <button
                  key={t.id}
                  type="button"
                  role="option"
                  aria-selected={i === current}
                  className={cx('palette-item', i === current && 'is-active')}
                  onMouseMove={() => i !== current && setActive(i)}
                  onClick={() => onPick('shared_step', t.id)}
                >
                  <Layers size={14} />
                  <span className="palette-label">{sharedLabel(t)}</span>
                  <span className="palette-cat">{plural(t.steps.length, 'step')}</span>
                </button>
              ))
            )}
          </div>
        )}
        {!choosing && (
        <div className="palette-tabs" role="tablist" aria-label="Command categories" onKeyDown={onTablistKeyDown}>
          {(['All', ...CATEGORIES] as PaletteTab[]).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={!q && t === tab}
              tabIndex={t === tab ? 0 : -1}
              className={cx('palette-tab', !q && t === tab && 'is-active')}
              onClick={() => {
                setTab(t)
                setQuery('')
                setActive(0)
              }}
            >
              {t}
            </button>
          ))}
        </div>
        )}
        {!choosing && (
        <div className="palette-list" role="listbox" ref={listRef} aria-label="Commands">
          {list.length === 0 && <p className="palette-empty">No command matches “{query}”.</p>}
          {list.map((c, i) => (
            <button
              key={c.id}
              type="button"
              role="option"
              aria-selected={i === current}
              className={cx('palette-item', i === current && 'is-active')}
              onMouseMove={() => i !== current && setActive(i)}
              onClick={() => pick(c.id)}
            >
              <Plus size={14} />
              <span className="palette-label">{c.label}</span>
              {c.target && (
                <span className="palette-note">
                  <MousePointerClick size={13} /> then pick an element
                </span>
              )}
              {c.id === 'shared_step' && (
                <span className="palette-note">
                  <Layers size={13} /> then choose which one
                </span>
              )}
              <span className="palette-cat">{c.category}</span>
            </button>
          ))}
        </div>
        )}
      </div>
    </Dialog>
  )
}
