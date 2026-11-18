// The assistant's chat panel: the transcript of the test case's sessions and the box to ask for more.
import { Camera, CircleAlert, Info, ListChecks, Pencil, Play, Plus, SendHorizontal, Sparkles, Square, Trash2, X } from 'lucide-react'
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import type { AssistantEvent, AssistantSession, AssistantStatus, AssistantToolName } from '../../shared/types'
import { Button, IconButton, Popover, Spinner } from '../components/ui'
import { cx } from '../lib/format'
import { isComposing } from '../lib/hooks'

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
  /** The status or the session list could not be loaded: shown instead of the transcript, with a way to try again. */
  loadError: { message: string; retrying: boolean; onRetry: () => void } | null
  sending: boolean
  aborting: boolean
  /** Resolves to whether the message was accepted. A message that was not is kept in the box. */
  onSend: (message: string) => Promise<boolean>
  onAbort: (sessionId: string) => void
  onClose: () => void
}

export function AssistantPanel(p: AssistantPanelProps) {
  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const active = p.sessions.find(isActive)
  const busy = !!active || p.sending
  const enabled = p.status?.enabled === true && !p.loadError
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
    void p.onSend(message).then((accepted) => {
      // Only a message the server took is cleared (and only if the box still holds it): a refused or failed
      // one stays where it was written, ready to be sent again.
      if (accepted) setDraft((d) => (d.trim() === message ? '' : d))
      else inputRef.current?.focus()
    })
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
        {p.loadError ? (
          <div className="asst-empty" role="alert">
            <CircleAlert size={20} aria-hidden />
            <p>
              <strong>The assistant could not be loaded.</strong> {p.loadError.message}
            </p>
            <Button size="sm" busy={p.loadError.retrying} onClick={p.loadError.onRetry}>
              Try again
            </Button>
            <p className="muted">Everything else in the editor keeps working.</p>
          </div>
        ) : p.status && !enabled ? (
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
          placeholder={enabled ? (busy ? 'The assistant is working…' : 'Describe a test, or what to change') : p.loadError ? 'The assistant could not be loaded' : p.status ? 'Not configured' : 'Loading…'}
          aria-label="Message to the assistant"
          enterKeyHint="send"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter is a new line. Not while an input method is composing text.
            if (e.key === 'Enter' && !e.shiftKey) {
              // isComposing() also covers Safari, which reports the confirming Enter as not composing.
              if (isComposing(e)) return
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
  const others = u.otherModels ?? []
  // The breakdown is a toggletip: a visible button opens it, so touch, keyboard and screen readers get it too.
  const [tip, setTip] = useState<HTMLElement | null>(null)
  return (
    <div className="asst-usage num">
      <span>
        {u.turns} {u.turns === 1 ? 'turn' : 'turns'} · {compact(input)} in{u.cacheReadTokens > 0 ? ` (${Math.round((u.cacheReadTokens / input) * 100)}% cached)` : ''} · {compact(u.outputTokens)} out · {u.costIncomplete ? 'at least' : 'about'} ${u.costUsd < 0.01 ? u.costUsd.toFixed(3) : u.costUsd.toFixed(2)}
        {others.length > 0 && ` · partly answered by ${others.join(', ')}`}
      </span>
      <IconButton label="How this usage is counted" aria-expanded={!!tip} onClick={(e) => setTip(tip ? null : e.currentTarget)}>
        <Info size={13} />
      </IconButton>
      {tip && (
        <Popover anchor={{ el: tip }} align="end" onClose={() => setTip(null)}>
          <p className="tip-pop" role="tooltip">
            {u.model}
            {others.length > 0 && ` (and ${others.join(', ')}, which answered a request ${u.model} declined)`}: {u.inputTokens} input tokens, {u.cacheWriteTokens} written to the prompt cache,{' '}
            {u.cacheReadTokens} read from it, {u.outputTokens} output tokens. The cost is an estimate from list prices
            {u.costIncomplete ? `; a model without a known price was counted at the price of ${u.model}` : ''}.
          </p>
        </Popover>
      )}
    </div>
  )
}

// ---- a small markdown subset: paragraphs, lists, bold, inline code, code blocks, links as text ----

function inline(text: string): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]\n]+\]\([^)\s]+\))/g).map((part, i) => {
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) return <code key={i}>{part.slice(1, -1)}</code>
    if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>
    // The text is the model's, written after reading pages nobody vetted: a link is shown, never made clickable.
    const link = /^\[([^\]\n]+)\]\(([^)\s]+)\)$/.exec(part)
    if (link) return <Fragment key={i}>{link[1] === link[2] ? link[1] : `${link[1]} (${link[2]})`}</Fragment>
    return <Fragment key={i}>{part}</Fragment>
  })
}

export function renderMarkdown(source: string): ReactNode[] {
  const out: ReactNode[] = []
  const lines = source.replace(/\r/g, '').split('\n')
  let para: string[] = []
  let list: { ordered: boolean; start: number; items: string[] } | null = null
  let code: string[] | null = null
  // A blank line ends a paragraph at once, but a list only when what follows is not its next item: models
  // write "loose" lists with a blank line between the items, and each item must not become a list of its own.
  let gap = false
  const flush = () => {
    if (para.length) out.push(<p key={out.length}>{inline(para.join(' '))}</p>)
    para = []
    if (list) {
      const items = list.items.map((item, i) => <li key={i}>{inline(item)}</li>)
      out.push(
        list.ordered ? (
          <ol key={out.length} start={list.start}>
            {items}
          </ol>
        ) : (
          <ul key={out.length}>{items}</ul>
        ),
      )
    }
    list = null
    gap = false
  }
  for (const raw of lines) {
    const line = raw.trim()
    if (code) {
      if (line.startsWith('```')) {
        out.push(
          <pre key={out.length}>
            <code>{code.join('\n')}</code>
          </pre>,
        )
        code = null
      } else code.push(raw)
      continue
    }
    const bullet = /^[-*•]\s+(.*)$/.exec(line)
    const numbered = /^(\d+)[.)]\s+(.*)$/.exec(line)
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    if (line === '') {
      if (list) gap = true
      else flush()
    } else if (line.startsWith('```')) {
      flush()
      code = []
    } else if (heading) {
      flush()
      out.push(
        <p key={out.length}>
          <strong>{inline(heading[1])}</strong>
        </p>,
      )
    } else if (bullet || numbered) {
      const ordered = !!numbered
      if (para.length || (list && list.ordered !== ordered)) flush()
      list ??= { ordered, start: numbered ? Number(numbered[1]) : 1, items: [] }
      list.items.push(numbered ? numbered[2] : bullet![1])
      gap = false
    } else if (list && !gap) list.items[list.items.length - 1] += ` ${line}`
    else {
      if (list) flush()
      para.push(line)
    }
  }
  // A code block the model never closed still shows what it holds.
  if (code) out.push(<pre key={out.length}>{(code as string[]).join('\n')}</pre>)
  flush()
  return out
}
