// The assistant's chat panel: the transcript of the test case's sessions and the box to ask for more.
import { Camera, CircleAlert, ListChecks, Pencil, Play, Plus, SendHorizontal, Sparkles, Square, Trash2, X } from 'lucide-react'
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import type { AssistantEvent, AssistantSession, AssistantStatus, AssistantToolName } from '../../shared/types'
import { Button, IconButton, Spinner } from '../components/ui'
import { cx } from '../lib/format'

export const EXAMPLE_PROMPTS = [
  'Sign in with the demo account and check the welcome message',
  'Check that signing in with a wrong password shows an error',
  'Reserve a room for two nights and check the confirmation page',
]

const isActive = (s: AssistantSession) => s.status === 'queued' || s.status === 'running'

export interface AssistantPanelProps {
  status: AssistantStatus | undefined
  sessions: AssistantSession[]
  loading: boolean
  sending: boolean
  aborting: boolean
  onSend: (message: string) => void
  onAbort: (sessionId: string) => void
  onClose: () => void
}

export function AssistantPanel(p: AssistantPanelProps) {
  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const active = p.sessions.find(isActive)
  const busy = !!active || p.sending
  const enabled = p.status?.enabled === true
  const eventCount = p.sessions.reduce((n, s) => n + s.events.length, 0)

  // Follow the transcript while it grows, unless the user scrolled up to read.
  const pinned = useRef(true)
  useEffect(() => {
    const el = scrollRef.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [eventCount, active?.status, p.sending])
  useEffect(() => {
    if (enabled) inputRef.current?.focus()
  }, [enabled])

  const send = (text: string) => {
    const message = text.trim()
    if (!message || busy || !enabled) return
    pinned.current = true
    p.onSend(message)
    setDraft('')
  }

  return (
    <aside className="asst" aria-label="Assistant">
      <div className="asst-head">
        <Sparkles size={15} aria-hidden />
        <h2>Assistant</h2>
        <span className="ed-gap" />
        <IconButton label="Close the assistant" onClick={p.onClose}>
          <X size={16} />
        </IconButton>
      </div>

      <div
        className="asst-scroll"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
      >
        {p.status && !enabled ? (
          <div className="asst-empty">
            <CircleAlert size={20} aria-hidden />
            <p>
              <strong>The assistant is not configured.</strong> It needs an Anthropic API key on this deployment:
            </p>
            <code className="asst-cmd">wrangler secret put ANTHROPIC_API_KEY</code>
            <p className="muted">Everything else in the editor works without it.</p>
          </div>
        ) : p.loading || !p.status ? (
          <div className="asst-empty">
            <Spinner size={18} />
          </div>
        ) : p.sessions.length === 0 && !p.sending ? (
          <div className="asst-empty">
            <p>
              <strong>Describe the test in your own words.</strong> The assistant opens the page in a cloud browser, adds the steps, and runs them to check its work.
            </p>
            <div className="asst-chips">
              {EXAMPLE_PROMPTS.map((text) => (
                <button key={text} type="button" className="asst-chip" onClick={() => send(text)}>
                  {text}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <ol className="asst-log">
            {p.sessions.map((s) => (
              <SessionView key={s.id} session={s} />
            ))}
          </ol>
        )}
        {active && (
          <div className="asst-working" role="status">
            <Spinner size={14} />
            <span>{active.status === 'queued' ? 'Starting…' : 'Working…'}</span>
            <span className="ed-gap" />
            <Button size="sm" icon={<Square size={11} />} busy={p.aborting} onClick={() => p.onAbort(active.id)}>
              Abort
            </Button>
          </div>
        )}
      </div>

      <form
        className="asst-form"
        onSubmit={(e) => {
          e.preventDefault()
          send(draft)
        }}
      >
        <textarea
          ref={inputRef}
          className="asst-input"
          rows={3}
          maxLength={2000}
          value={draft}
          disabled={!enabled}
          placeholder={enabled ? (busy ? 'The assistant is working…' : 'Describe a test, or what to change') : 'Not configured'}
          aria-label="Message to the assistant"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter is a new line. Not while an input method is composing text.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send(draft)
            }
          }}
        />
        <div className="asst-form-foot">
          <span className="muted">Enter to send, Shift+Enter for a new line</span>
          <Button type="submit" variant="primary" size="sm" icon={<SendHorizontal size={13} />} busy={p.sending} disabled={!enabled || busy || !draft.trim()}>
            Send
          </Button>
        </div>
      </form>
    </aside>
  )
}

const TOOL_ICON: Record<AssistantToolName, ReactNode> = {
  get_steps: <ListChecks size={13} />,
  capture_screen: <Camera size={13} />,
  add_step: <Plus size={13} />,
  update_step: <Pencil size={13} />,
  delete_step: <Trash2 size={13} />,
  run_steps: <Play size={13} />,
}

function SessionView({ session }: { session: AssistantSession }) {
  return (
    <li className="asst-session">
      {session.events.map((e, i) => (
        <EventView key={i} event={e} />
      ))}
      {session.usage && <Usage session={session} />}
    </li>
  )
}

function EventView({ event }: { event: AssistantEvent }) {
  if (event.kind === 'user') return <div className="asst-user">{event.text}</div>
  if (event.kind === 'assistant') return <div className="asst-text">{renderMarkdown(event.text)}</div>
  if (event.kind === 'error')
    return (
      <div className="asst-error">
        <CircleAlert size={14} aria-hidden />
        <span>{event.text}</span>
      </div>
    )
  return (
    <div className={cx('asst-tool', event.failed && 'is-failed')}>
      <span className="asst-tool-icon" aria-hidden>
        {(event.tool && TOOL_ICON[event.tool]) ?? <Sparkles size={13} />}
      </span>
      <span className="asst-tool-text">
        {event.text}
        {event.detail && <span className="asst-tool-detail">{event.detail}</span>}
      </span>
    </div>
  )
}

const compact = (n: number): string => (n < 1000 ? String(n) : n < 100_000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`)

function Usage({ session }: { session: AssistantSession }) {
  const u = session.usage!
  const input = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens
  return (
    <div className="asst-usage num" title={`${u.model}: ${u.inputTokens} input tokens, ${u.cacheWriteTokens} written to the prompt cache, ${u.cacheReadTokens} read from it, ${u.outputTokens} output tokens. The cost is an estimate from list prices.`}>
      {u.turns} {u.turns === 1 ? 'turn' : 'turns'} · {compact(input)} in{u.cacheReadTokens > 0 ? ` (${Math.round((u.cacheReadTokens / input) * 100)}% cached)` : ''} · {compact(u.outputTokens)} out · about ${u.costUsd < 0.01 ? u.costUsd.toFixed(3) : u.costUsd.toFixed(2)}
    </div>
  )
}

// ---- a small markdown subset: paragraphs, lists, bold, inline code ----

function inline(text: string): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, i) => {
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) return <code key={i}>{part.slice(1, -1)}</code>
    if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>
    return <Fragment key={i}>{part}</Fragment>
  })
}

export function renderMarkdown(source: string): ReactNode[] {
  const out: ReactNode[] = []
  const lines = source.replace(/\r/g, '').split('\n')
  let para: string[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  const flush = () => {
    if (para.length) out.push(<p key={out.length}>{inline(para.join(' '))}</p>)
    para = []
    if (list) {
      const items = list.items.map((item, i) => <li key={i}>{inline(item)}</li>)
      out.push(list.ordered ? <ol key={out.length}>{items}</ol> : <ul key={out.length}>{items}</ul>)
    }
    list = null
  }
  for (const raw of lines) {
    const line = raw.trim()
    const bullet = /^[-*•]\s+(.*)$/.exec(line)
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line)
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    if (line === '') flush()
    else if (heading) {
      flush()
      out.push(
        <p key={out.length}>
          <strong>{inline(heading[1])}</strong>
        </p>,
      )
    } else if (bullet || numbered) {
      const ordered = !!numbered
      if (para.length || (list && list.ordered !== ordered)) flush()
      list ??= { ordered, items: [] }
      list.items.push((bullet ?? numbered)![1])
    } else if (list) list.items[list.items.length - 1] += ` ${line}`
    else para.push(line)
  }
  flush()
  return out
}
