// The assistant's agent loop, driven by a scripted model: no API calls, no browser, no database.
import Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it } from 'vitest'
import { stepSentence } from '../../shared/commands'
import type { AssistantEvent, AssistantUsage, Step, Ui } from '../../shared/types'
import { describeModelError } from '../../worker/assistant/client'
import { runAssistant, type ModelClient, type ModelMessage, type ModelTurn, type SessionSink, type ToolHost, type ToolOutcome } from '../../worker/assistant/loop'
import { costOf, DEFAULT_MODEL } from '../../worker/assistant/models'
import { firstMessage, SYSTEM_PROMPT, TOOLS } from '../../worker/assistant/prompt'
import { asInput, checkStep, commandOf, optionalString, targetFrom, ToolInputError } from '../../worker/assistant/steps'
import { DEVICES } from '../../shared/devices'

// ---- scripted model ----

type Block = { text: string } | { tool: string; input: unknown; id?: string } | { thinking: string }
let nextId = 0

function turn(stop: ModelTurn['stop_reason'], blocks: Block[], extra: Partial<ModelTurn> = {}): ModelTurn {
  const content = blocks.map((b) =>
    'text' in b
      ? { type: 'text', text: b.text, citations: null }
      : 'thinking' in b
        ? { type: 'thinking', thinking: '', signature: b.thinking }
        : { type: 'tool_use', id: b.id ?? `toolu_${++nextId}`, name: b.tool, input: b.input },
  )
  return {
    content: content as ModelTurn['content'],
    stop_reason: stop,
    model: 'claude-opus-5-5',
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 } as ModelTurn['usage'],
    ...extra,
  }
}

function scripted(script: (ModelTurn | Error | ((messages: ModelMessage[]) => ModelTurn))[]) {
  const requests: ModelMessage[][] = []
  const model: ModelClient = {
    describeError: describeModelError,
    create: async (messages) => {
      requests.push(structuredClone(messages))
      const next = script[requests.length - 1]
      if (!next) throw new Error('the script has no more turns')
      if (next instanceof Error) throw next
      return typeof next === 'function' ? next(messages) : next
    },
  }
  return { model, requests }
}

// ---- in-memory session and tool host ----

function memorySink() {
  const events: Omit<AssistantEvent, 'at'>[] = []
  const state = { active: true, usage: null as AssistantUsage | null }
  const sink: SessionSink = {
    active: async () => state.active,
    event: async (e) => {
      if (state.active) events.push(e)
    },
    usage: async (u) => {
      state.usage = { ...u }
    },
  }
  return { sink, events, state }
}

const fingerprint = (text: string) => ({ tag: 'button', type: 'button' as const, text, label: '', attrs: {}, path: 'body>button', box: { x: 0, y: 0, w: 10, h: 10 } })
const LOGIN_UI: Ui = {
  id: 'ui1',
  testCaseId: 't1',
  name: 'UI1',
  url: 'http://app.test/demo/login.html',
  title: 'Sign in',
  width: 1280,
  height: 800,
  screenshotKey: 'ui/ui1.jpg',
  device: 'desktop',
  createdAt: '2026-01-01T00:00:00.000Z',
  elements: [
    { id: 'e1', name: '"Email" input area', type: 'input', box: { x: 0, y: 0, w: 10, h: 10 }, locators: [{ key: 'id', value: 'email' }, { key: 'css', value: 'input[name=email]' }], fingerprint: { ...fingerprint(''), tag: 'input', type: 'input' } },
    { id: 'e2', name: '"Sign in" button', type: 'button', box: { x: 0, y: 0, w: 10, h: 10 }, locators: [{ key: 'css', value: 'button[type=submit]' }], fingerprint: fingerprint('Sign in') },
  ],
}

/** A host with the real input validation (worker/assistant/steps.ts) over an in-memory test case and a canned capture. */
function memoryHost(initial: Step[] = []) {
  const steps = [...initial]
  const uis: Ui[] = []
  const calls: string[] = []
  const host: ToolHost = {
    call: async (name, raw): Promise<ToolOutcome> => {
      calls.push(name)
      try {
        const input = asInput(raw)
        if (name === 'capture_screen') {
          uis.push(LOGIN_UI)
          return { content: [{ type: 'text', text: JSON.stringify({ ui_id: LOGIN_UI.id, elements: LOGIN_UI.elements.map((e) => ({ element_id: e.id, name: e.name })) }) }], event: `Captured screen of ${LOGIN_UI.url} (UI1, 2 elements)` }
        }
        if (name === 'add_step') {
          const command = commandOf(input.command)
          const step: Step = { id: `s${steps.length + 1}`, command }
          const uiId = optionalString(input, 'ui_id')
          if (uiId) step.target = targetFrom(uis, uiId, optionalString(input, 'element_id'), 'desktop')
          const value = optionalString(input, 'value')
          if (value !== undefined) step.value = value
          checkStep(step, () => null)
          steps.push(step)
          return { content: JSON.stringify({ step: steps.length }), event: `Added step ${steps.length}: ${stepSentence(step)}` }
        }
        if (name === 'run_steps') return { content: JSON.stringify({ status: 'passed' }), event: `Ran steps 1-${steps.length}: all passed` }
        if (name === 'crash') throw new Error('boom')
        return { content: `There is no tool named "${name}".`, isError: true, event: `Unknown tool ${name}` }
      } catch (e) {
        if (!(e instanceof ToolInputError)) throw e
        return { content: e.message, isError: true, event: 'Could not add a step', detail: e.message }
      }
    },
  }
  return { host, steps, calls }
}

const run = (model: ModelClient, host: ToolHost, sink: SessionSink, extra: Partial<Parameters<typeof runAssistant>[0]> = {}) =>
  runAssistant({ model, host, sink, task: 'Sign in with the demo account', modelName: 'claude-opus-5-5', ...extra })

const toolResults = (message: ModelMessage) => (message.content as { type: string; tool_use_id: string; is_error?: boolean; content: unknown }[]).filter((b) => b.type === 'tool_result')

describe('assistant loop', () => {
  it('builds steps from a capture and finishes with a summary', async () => {
    const { model, requests } = scripted([
      turn('tool_use', [{ thinking: 'sig-1' }, { tool: 'capture_screen', input: { after_step: 0, url: '/login.html' } }]),
      turn('tool_use', [
        { tool: 'add_step', input: { command: 'navigate', value: '${BASE_URL}/login.html' } },
        { tool: 'add_step', input: { command: 'input', ui_id: 'ui1', element_id: 'e1', value: 'demo@example.com' } },
        { tool: 'add_step', input: { command: 'click', ui_id: 'ui1', element_id: 'e2' } },
      ]),
      turn('tool_use', [{ tool: 'run_steps', input: {} }]),
      turn('end_turn', [{ text: 'The test signs in with the demo account. The run passed.' }]),
    ])
    const { host, steps } = memoryHost()
    const { sink, events, state } = memorySink()

    expect(await run(model, host, sink)).toEqual({ status: 'done' })

    expect(steps.map(stepSentence)).toEqual(['Navigate to "${BASE_URL}/login.html"', 'Input "demo@example.com" to "Email" input area', 'Click "Sign in" button'])
    // The recommended locator is the first candidate; the step keeps them all.
    expect(steps[1].target).toMatchObject({ uiId: 'ui1', elementId: 'e1', locator: { key: 'id', value: 'email' } })
    expect(steps[1].target?.candidates).toHaveLength(2)

    expect(events.map((e) => `${e.kind}: ${e.text}`)).toEqual([
      'tool: Captured screen of http://app.test/demo/login.html (UI1, 2 elements)',
      'tool: Added step 1: Navigate to "${BASE_URL}/login.html"',
      'tool: Added step 2: Input "demo@example.com" to "Email" input area',
      'tool: Added step 3: Click "Sign in" button',
      'tool: Ran steps 1-3: all passed',
      'assistant: The test signs in with the demo account. The run passed.',
    ])
    expect(events[1]).toMatchObject({ tool: 'add_step' })

    // The conversation is append-only: each request is the previous one plus the assistant turn (unchanged,
    // thinking block included) and one user message carrying a result for every tool call of that turn.
    expect(requests).toHaveLength(4)
    expect(requests[0]).toEqual([{ role: 'user', content: 'Sign in with the demo account' }])
    for (let i = 1; i < requests.length; i++) expect(requests[i].slice(0, requests[i - 1].length)).toEqual(requests[i - 1])
    expect((requests[1][1].content as { type: string }[])[0]).toEqual({ type: 'thinking', thinking: '', signature: 'sig-1' })
    expect(requests[2]).toHaveLength(5)
    expect(toolResults(requests[2][4])).toHaveLength(3)
    const ids = (requests[2][3].content as { type: string; id: string }[]).map((b) => b.id)
    expect(toolResults(requests[2][4]).map((r) => r.tool_use_id)).toEqual(ids)

    expect(state.usage).toMatchObject({ turns: 4, inputTokens: 400, outputTokens: 80, cacheReadTokens: 4000, cacheWriteTokens: 200 })
        expect(state.usage!.costUsd).toBeCloseTo((400 * 4 + 200 * 5 + 4000 * 0.2 + 80 * 20) / 1e6, 10)
  })

  it('returns invalid tool input as an error result and keeps going', async () => {
    const { model, requests } = scripted([
      turn('tool_use', [{ tool: 'capture_screen', input: { after_step: 0 } }]),
      turn('tool_use', [
        { tool: 'add_step', input: { command: 'tap', ui_id: 'ui1', element_id: 'e2' } },
        { tool: 'add_step', input: { command: 'click', ui_id: 'ui1', element_id: 'nope' } },
        { tool: 'add_step', input: { command: 'click' } },
        { tool: 'add_step', input: { command: 'navigate' } },
        { tool: 'add_step', input: { command: 'press_key', value: 'Return' } },
        { tool: 'add_step', input: 'click the button' },
        { tool: 'no_such_tool', input: {} },
      ]),
      turn('tool_use', [{ tool: 'add_step', input: { command: 'click', ui_id: 'ui1', element_id: 'e2' } }]),
      turn('end_turn', [{ text: 'Done.' }]),
    ])
    const { host, steps } = memoryHost()
    const { sink, events } = memorySink()

    expect(await run(model, host, sink)).toEqual({ status: 'done' })
    expect(steps.map(stepSentence)).toEqual(['Click "Sign in" button'])

    const results = toolResults(requests[2][4])
    expect(results).toHaveLength(7)
    expect(results.every((r) => r.is_error === true)).toBe(true)
    const messages = results.map((r) => String(r.content))
    expect(messages[0]).toContain('Unknown command "tap"')
    expect(messages[1]).toContain('has no element "nope"')
    expect(messages[2]).toContain('pass ui_id and element_id')
    expect(messages[3]).toContain('navigate needs value')
    expect(messages[4]).toContain('press_key takes one of: Enter')
    expect(messages[5]).toContain('must be a JSON object')
    expect(messages[6]).toContain('no tool named "no_such_tool"')
    expect(events.filter((e) => e.failed)).toHaveLength(7)
    // The good call after the errors is a normal result.
    expect(toolResults(requests[3][6])[0].is_error).toBeUndefined()
  })

  it('turns a crashing tool into an error result instead of ending the session', async () => {
    const { model, requests } = scripted([turn('tool_use', [{ tool: 'crash', input: {} }]), turn('end_turn', [{ text: 'I could not do that.' }])])
    const { sink, events } = memorySink()
    expect(await run(model, memoryHost().host, sink)).toEqual({ status: 'done' })
    expect(toolResults(requests[1][2])[0]).toMatchObject({ is_error: true, content: 'The tool failed unexpectedly: boom' })
    expect(events[0]).toMatchObject({ kind: 'tool', failed: true, detail: 'boom' })
  })

  it('stops when the session is aborted, without running the remaining tools', async () => {
    const { host, calls, steps } = memoryHost()
    const { sink, state, events } = memorySink()
    const { model, requests } = scripted([
      turn('tool_use', [{ tool: 'capture_screen', input: { after_step: 0 } }]),
      () => {
        state.active = false // the user aborts while the model is answering
        return turn('tool_use', [{ tool: 'add_step', input: { command: 'click', ui_id: 'ui1', element_id: 'e2' } }, { text: 'never shown' }])
      },
      turn('end_turn', [{ text: 'unreachable' }]),
    ])
    expect(await run(model, host, sink)).toEqual({ status: 'aborted' })
    expect(calls).toEqual(['capture_screen'])
    expect(steps).toHaveLength(0)
    expect(requests).toHaveLength(2)
    expect(events).toHaveLength(1)
  })

  it('does not call the model for a session that was aborted while queued', async () => {
    const { model, requests } = scripted([])
    const { sink, state } = memorySink()
    state.active = false
    expect(await run(model, memoryHost().host, sink)).toEqual({ status: 'aborted' })
    expect(requests).toHaveLength(0)
  })

  it('stops at the turn cap and keeps what was built', async () => {
    const again = () => turn('tool_use', [{ tool: 'run_steps', input: {} }])
    const { model, requests } = scripted([again, again, again, again, again])
    const { sink, events } = memorySink()
    const result = await run(model, memoryHost().host, sink, { maxTurns: 3 })
    expect(result).toEqual({ status: 'failed', error: 'Stopped after 3 model turns without finishing. The steps built so far are kept.' })
    expect(requests).toHaveLength(3)
    expect(events.at(-1)).toEqual({ kind: 'error', text: 'Stopped after 3 model turns without finishing. The steps built so far are kept.' })
  })

  it('stops at the time limit', async () => {
    let clock = 0
    const { model, requests } = scripted([
      () => {
        clock += 13 * 60_000
        return turn('tool_use', [{ tool: 'run_steps', input: {} }])
      },
      turn('end_turn', [{ text: 'unreachable' }]),
    ])
    const result = await run(model, memoryHost().host, memorySink().sink, { now: () => clock })
    expect(result).toMatchObject({ status: 'failed', error: expect.stringContaining('12 minute limit') })
    expect(requests).toHaveLength(1)
  })

  it('calls a model request that was cut short by the time limit what it is, and a slow model a slow model', async () => {
    let clock = 0
    const late = scripted([
      () => {
        clock += 11 * 60_000
        return turn('tool_use', [{ tool: 'run_steps', input: {} }])
      },
      () => {
        // One minute was left for this request, and it took it.
        clock += 60_000
        throw new Anthropic.APIConnectionTimeoutError()
      },
    ])
    const out = memorySink()
    const result = await run(late.model, memoryHost().host, out.sink, { now: () => clock })
    expect(result).toMatchObject({ status: 'failed', error: expect.stringContaining('12 minute limit') })
    expect((result as { error: string }).error).toContain('The steps built so far are kept.')

    clock = 0
    const slow = scripted([new Anthropic.APIConnectionTimeoutError()])
    expect(await run(slow.model, memoryHost().host, memorySink().sink, { now: () => clock })).toMatchObject({ status: 'failed', error: expect.stringContaining('did not answer in time') })
  })

  it('holds the time limit between the tool calls of one reply, and tells the tools when it is', async () => {
    let clock = 0
    const seen: { name: string; deadline: number }[] = []
    let turns = 0
    const host: ToolHost = {
      beginTurn: () => void turns++,
      call: async (name, _input, context) => {
        seen.push({ name, deadline: context.deadline })
        clock += 7 * 60_000 // a long run
        return { content: 'ok', event: `ran ${name}` }
      },
    }
    const { model, requests } = scripted([turn('tool_use', [{ tool: 'run_steps', input: {} }, { tool: 'run_steps', input: {} }, { tool: 'capture_screen', input: { after_step: 1 } }]), turn('end_turn', [{ text: 'unreachable' }])])
    const { sink, events } = memorySink()
    const result = await run(model, host, sink, { now: () => clock })
    expect(result).toMatchObject({ status: 'failed', error: expect.stringContaining('12 minute limit') })
    // Two runs took 14 minutes: the third call is not started, and the model is not asked again.
    expect(seen).toEqual([
      { name: 'run_steps', deadline: 12 * 60_000 },
      { name: 'run_steps', deadline: 12 * 60_000 },
    ])
    expect(turns).toBe(1)
    expect(requests).toHaveLength(1)
    expect(events.map((e) => e.text)).toEqual(['ran run_steps', 'ran run_steps', expect.stringContaining('12 minute limit')])
  })

  it('stops a session whose estimated cost reaches the limit', async () => {
    const pricey = () => turn('tool_use', [{ tool: 'run_steps', input: {} }], { usage: { input_tokens: 200_000, output_tokens: 10_000 } as ModelTurn['usage'] }) // $1.00 a turn
    const { model, requests } = scripted([pricey, pricey, pricey, pricey])
    const { sink, state } = memorySink()
    const result = await run(model, memoryHost().host, sink, { maxCostUsd: 2 })
    expect(result).toMatchObject({ status: 'failed', error: expect.stringContaining('cost limit (about $2)') })
    expect(requests).toHaveLength(2)
    expect(state.usage!.costUsd).toBeCloseTo(2, 10)
  })

  it('counts every attempt of a request that fell back to another model, each at its own price', async () => {
    const iteration = (type: string, model: string | null, input: number, output: number) => ({ type, model, input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: null })
    const { model } = scripted([
      // An ordinary turn: one entry, which repeats the top-level numbers.
      turn('tool_use', [{ tool: 'run_steps', input: {} }], { usage: { input_tokens: 1000, output_tokens: 100, iterations: [iteration('message', 'claude-opus-5-5', 1000, 100)] } as unknown as ModelTurn['usage'] }),
      // Declined by the assistant's model after 40 output tokens, then answered by the fallback model: the
      // top-level usage only covers the attempt that produced the message.
      turn('tool_use', [{ tool: 'run_steps', input: {} }], {
        model: 'claude-opus-5',
        usage: { input_tokens: 2000, output_tokens: 300, iterations: [iteration('message', 'claude-opus-5-5', 2000, 40), iteration('fallback_message', 'claude-opus-5', 2000, 300)] } as unknown as ModelTurn['usage'],
      }),
      // A model this code has no price for.
      turn('end_turn', [{ text: 'Done.' }], { model: 'claude-next', usage: { input_tokens: 500, output_tokens: 50, iterations: null } as unknown as ModelTurn['usage'] }),
    ])
    const { sink, state } = memorySink()
    expect(await run(model, memoryHost().host, sink)).toEqual({ status: 'done' })
    const u = state.usage!
    expect(u).toMatchObject({ model: 'claude-opus-5-5', otherModels: ['claude-opus-5', 'claude-next'], costIncomplete: true, turns: 3, inputTokens: 1000 + 2000 + 2000 + 500, outputTokens: 100 + 40 + 300 + 50 })
    const opus55 = (1000 * 4 + 100 * 20 + 2000 * 4 + 40 * 20 + 500 * 4 + 50 * 20) / 1e6
    const opus5 = (2000 * 5 + 300 * 25) / 1e6
    expect(u.costUsd).toBeCloseTo(opus55 + opus5, 10)
  })

  it('treats a refusal as a failed session and runs none of its tool calls', async () => {
    const refusal = turn('refusal', [{ tool: 'add_step', input: { command: 'click', ui_id: 'ui1', element_id: 'e2' } }], {
      stop_details: { type: 'refusal', category: 'cyber', explanation: null } as ModelTurn['stop_details'],
    })
    const { model } = scripted([refusal])
    const { host, calls } = memoryHost()
    const { sink, events } = memorySink()
    const result = await run(model, host, sink)
    expect(result).toMatchObject({ status: 'failed', error: expect.stringContaining('declined this request (safety category: cyber)') })
    expect(calls).toEqual([])
    expect(events).toEqual([{ kind: 'error', text: (result as { error: string }).error }])
  })

  it('does not run tools from a reply that was cut off', async () => {
    const { model } = scripted([turn('max_tokens', [{ text: 'Adding the steps now.' }, { tool: 'add_step', input: { command: 'click' } }])])
    const { host, calls } = memoryHost()
    const { sink, events } = memorySink()
    expect(await run(model, host, sink)).toMatchObject({ status: 'failed', error: expect.stringContaining('cut off') })
    expect(calls).toEqual([])
    expect(events.map((e) => e.kind)).toEqual(['assistant', 'error'])
  })

  it('fails the session with a readable message when the API errors', async () => {
    const cases: [Error, string][] = [
      [Anthropic.APIError.generate(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, undefined, new Headers()), 'rejected the API key'],
      [Anthropic.APIError.generate(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, undefined, new Headers()), 'rate limited'],
      [Anthropic.APIError.generate(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, undefined, new Headers()), 'having trouble'],
      [new Anthropic.APIConnectionTimeoutError(), 'did not answer in time'],
      [new TypeError('fetch failed'), 'Unexpected error while asking the model: fetch failed'],
    ]
    for (const [error, expected] of cases) {
      const { model } = scripted([turn('tool_use', [{ tool: 'capture_screen', input: { after_step: 0 } }]), error])
      const { sink, events, state } = memorySink()
      const result = await run(model, memoryHost().host, sink)
      expect(result).toMatchObject({ status: 'failed', error: expect.stringContaining(expected) })
      expect(events.at(-1)).toMatchObject({ kind: 'error', text: expect.stringContaining(expected) })
      // The capture of the first turn happened and its usage is recorded.
      expect(events[0].kind).toBe('tool')
      expect(state.usage?.turns).toBe(1)
    }
  })
})

describe('assistant prompt', () => {
  it('keeps the cached prefix free of per-request content', () => {
    // Tools render first and are cached with the system prompt: both must be byte-identical between requests.
    expect(TOOLS.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name).toSorted())
    for (const tool of TOOLS) {
      expect(tool.strict).toBe(true)
      expect(tool.input_schema.additionalProperties).toBe(false)
    }
    expect(SYSTEM_PROMPT).toContain('- assert_text_equals: Assert UI element equals. Needs: element, value (Expected text).')
    expect(SYSTEM_PROMPT).toContain('- store_url: Store URL. Needs: variable (Variable).')
    expect(SYSTEM_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}/)
  })

  it('puts the test case, its device and its steps in the first message', () => {
    const steps: Step[] = [
      { id: 'a', command: 'navigate', value: '${BASE_URL}/login.html' },
      { id: 'b', command: 'wait_seconds', value: '2', disabled: true },
    ]
    const text = firstMessage({ testCaseName: '#3 Sign in', device: DEVICES.iphone, baseUrl: 'http://app.test/demo', variableNames: ['SITE_VERSION'], steps }, 'Check the welcome message')
    expect(text).toContain('Device: iPhone 15, 393x852 (emulated phone')
    expect(text).toContain('1. Navigate to "${BASE_URL}/login.html"\n2. Wait for 2 seconds (disabled)')
    expect(text).toContain('Project variables: SITE_VERSION')
    expect(text.endsWith('Request from the user:\nCheck the welcome message')).toBe(true)
    expect(firstMessage({ testCaseName: 'x', device: DEVICES.desktop, baseUrl: '', variableNames: [], steps: [] }, 'y')).toContain('(no steps yet)')
  })
})

describe('assistant routes without an API key', () => {
  it('reports the assistant as disabled and answers every other route with a 503', async () => {
    const { assistant } = await import('../../worker/api/assistant')
    const env = {} as never
    const status = await assistant.request('/assistant/status', {}, env)
    expect(await status.json()).toEqual({ enabled: false, model: DEFAULT_MODEL })
    // The configured model is reported when it is a supported one; anything else falls back to the default.
    const configured = await assistant.request('/assistant/status', {}, { ANTHROPIC_API_KEY: 'k', ASSISTANT_MODEL: 'claude-opus-5-5' } as never)
    expect(await configured.json()).toEqual({ enabled: true, model: 'claude-opus-5-5' })
    const unknown = await assistant.request('/assistant/status', {}, { ASSISTANT_MODEL: 'gpt-x' } as never)
    expect(await unknown.json()).toEqual({ enabled: false, model: DEFAULT_MODEL })
    const { HttpError } = await import('../../worker/env')
    assistant.onError((err, c) => (err instanceof HttpError ? c.json({ error: err.message }, err.status) : c.json({ error: 'Internal error' }, 500)))
    for (const [method, path] of [['POST', '/test-cases/t1/assistant'], ['GET', '/test-cases/t1/assistant'], ['GET', '/assistant/s1'], ['POST', '/assistant/s1/abort']]) {
      const res = await assistant.request(path, { method, body: method === 'POST' ? '{"message":"hi"}' : undefined }, env)
      expect(res.status).toBe(503)
      expect(((await res.json()) as { error: string }).error).toContain('ANTHROPIC_API_KEY')
    }
  })
})
