// The assistant's model table: which model a deployment runs, how each one is asked, and what it costs.
import { describe, expect, it } from 'vitest'
import type { UiElement } from '../../shared/types'
import { costOf, DEFAULT_MODEL, hasPrice, MODELS, overrideAllowed, priceOf, requestSettings, resolveModel, sessionModel, SUPPORTED_MODELS } from '../../worker/assistant/models'
import { listElements } from '../../worker/assistant/steps'

const tokens = (inputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheWriteTokens = 0) => ({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens })

describe('model selection', () => {
  it('uses ASSISTANT_MODEL when it names a supported model and the default otherwise', () => {
    expect(SUPPORTED_MODELS).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'])
    expect(SUPPORTED_MODELS).toContain(DEFAULT_MODEL)
    expect(resolveModel(undefined)).toEqual({ model: DEFAULT_MODEL })
    expect(resolveModel('  ')).toEqual({ model: DEFAULT_MODEL })
    expect(resolveModel(' claude-opus-5-5 ')).toEqual({ model: 'claude-opus-5-5' })
    // Never sent to the API: its price, and with it the session budget, would be unknown.
    expect(resolveModel('claude-opus-5-5-20260401')).toEqual({ model: DEFAULT_MODEL, invalid: 'claude-opus-5-5-20260401' })
    expect(resolveModel('constructor')).toEqual({ model: DEFAULT_MODEL, invalid: 'constructor' })
  })

  it('lets a session choose its model only on a local dev server that opted in', () => {
    const dev = { ASSISTANT_DEV_OVERRIDE: '1' }
    expect(overrideAllowed(dev, 'http://localhost:5173/api/test-cases/t/assistant')).toBe(true)
    expect(overrideAllowed(dev, 'http://127.0.0.1:8787/api/x')).toBe(true)
    // The var alone is not enough: a deployed Worker is never addressed as localhost.
    expect(overrideAllowed(dev, 'https://stepwise.example.com/api/x')).toBe(false)
    expect(overrideAllowed(dev, 'https://localhost.example.com/api/x')).toBe(false)
    expect(overrideAllowed({}, 'http://localhost:5173/api/x')).toBe(false)
    expect(overrideAllowed({ ASSISTANT_DEV_OVERRIDE: 'true' }, 'http://localhost:5173/api/x')).toBe(false)

    const override = { model: 'claude-sonnet-5-5', effort: 'low' }
    expect(sessionModel({ ...dev, ASSISTANT_MODEL: 'claude-opus-5-5' }, override)).toEqual({ model: 'claude-sonnet-5-5', effort: 'low' })
    // The consumer checks the var again: a queue message cannot switch models by itself.
    expect(sessionModel({ ASSISTANT_MODEL: 'claude-opus-5-5' }, override)).toEqual({ model: 'claude-opus-5-5' })
    expect(sessionModel(dev, { model: 'gpt-x', effort: 'extreme' })).toEqual({ model: DEFAULT_MODEL })
    expect(sessionModel(dev, undefined)).toEqual({ model: DEFAULT_MODEL })
  })
})

describe('request settings', () => {
  it('sets effort explicitly for every model and never sends a thinking or sampling parameter', () => {
    for (const model of SUPPORTED_MODELS) {
      const settings = requestSettings(model)
      expect(settings.model).toBe(model)
      expect(settings.output_config).toEqual({ effort: MODELS[model].effort })
      expect(settings.max_tokens).toBe(16000)
      expect(Object.keys(settings)).not.toEqual(expect.arrayContaining(['thinking', 'temperature', 'tool_choice']))
    }
    expect(requestSettings('claude-sonnet-5-5', 'low').output_config).toEqual({ effort: 'low' })
  })

  it('asks for the server-side refusal fallback only where the model has one', () => {
    for (const model of ['claude-sonnet-5-5', 'claude-opus-5-5'] as const) {
      expect(requestSettings(model)).toMatchObject({ betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
    }
    // Haiku 5.5 has no server-side fallback: the parameter is left out together with its beta header.
    const haiku = requestSettings('claude-haiku-5-5')
    expect(haiku).not.toHaveProperty('fallbacks')
    expect(haiku).not.toHaveProperty('betas')
  })
})

describe('pricing', () => {
  it('prices each model from its own rate card, cache writes at 1.25x input', () => {
    const u = tokens(1_000_000, 1_000_000, 1_000_000, 1_000_000)
    expect(costOf('claude-opus-5-5', u)).toBeCloseTo(4 + 20 + 0.2 + 5, 10)
    expect(costOf('claude-sonnet-5-5', u)).toBeCloseTo(2 + 10 + 0.1 + 2.5, 10)
    // Models a declined request can fall back to.
    expect(costOf('claude-opus-5', u)).toBeCloseTo(5 + 25 + 0.5 + 6.25, 10)
    expect(costOf('claude-sonnet-5', u)).toBeCloseTo(2 + 10 + 0.2 + 2.5, 10)
  })

  it('moves Haiku 5.5 to its second rate card when the prompt of a request is over 100K tokens', () => {
    // Prompt = uncached input + cache reads + cache writes of that request.
    const short = tokens(10_000, 1_000, 80_000, 10_000)
    expect(priceOf('claude-haiku-5-5', short)).toEqual({ input: 0.1, output: 0.5, cacheRead: 0.01 })
    expect(costOf('claude-haiku-5-5', short)).toBeCloseTo((10_000 * 0.1 + 10_000 * 0.125 + 80_000 * 0.01 + 1_000 * 0.5) / 1e6, 12)
    const long = tokens(10_000, 1_000, 80_000, 10_001)
    expect(priceOf('claude-haiku-5-5', long)).toEqual({ input: 0.5, output: 2.5, cacheRead: 0.05 })
    expect(costOf('claude-haiku-5-5', long)).toBeCloseTo((10_000 * 0.5 + 10_001 * 0.625 + 80_000 * 0.05 + 1_000 * 2.5) / 1e6, 12)
    // Output does not count towards the prompt, and the other models have a single card.
    expect(priceOf('claude-haiku-5-5', tokens(100_000, 500_000))).toEqual({ input: 0.1, output: 0.5, cacheRead: 0.01 })
    expect(priceOf('claude-opus-5-5', tokens(900_000, 0))).toEqual({ input: 4, output: 20, cacheRead: 0.2 })
  })

  it('charges a model without a known price like the session model', () => {
    const u = tokens(1000, 100)
    expect(hasPrice('claude-next')).toBe(false)
    expect(priceOf('claude-next', u)).toBeUndefined()
    expect(costOf('claude-next', u, 'claude-opus-5-5')).toBe(costOf('claude-opus-5-5', u))
    expect(costOf('claude-next', u)).toBe(costOf(DEFAULT_MODEL, u))
    for (const model of [...SUPPORTED_MODELS, 'claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-5']) expect(hasPrice(model)).toBe(true)
    expect(hasPrice('toString')).toBe(false)
  })
})

describe('the element list of a capture', () => {
  const el = (id: string, type: UiElement['type'], name: string, text = '', locators = 1): UiElement => ({
    id,
    name,
    type,
    box: { x: 0, y: 0, w: 10, h: 10 },
    locators: Array.from({ length: locators }, () => ({ key: 'css' as const, value: `#${id}` })),
    fingerprint: { tag: 'div', type, text, label: '', attrs: {}, path: 'body>div', box: { x: 0, y: 0, w: 10, h: 10 } },
  })

  it('is one line per element: the id and the name, with the text only when the name does not show it', () => {
    const { lines, omitted } = listElements([
      el('e1', 'button', '"Sign in" button', 'Sign in'),
      el('e2', 'input', '"Email" input area'),
      el('e3', 'button', '"Close" button', '×'),
      el('e4', 'text', '"Line one\nline two" text', 'Line one\n  line two'),
      el('e5', 'link', '"Ghost" link', 'Ghost', 0),
    ])
    expect(lines).toEqual(['e1 "Sign in" button', 'e2 "Email" input area', 'e3 "Close" button | text: ×', 'e4 "Line one line two" text'])
    // An element no step could use is not offered, and is not counted as left out either.
    expect(omitted).toBe(0)
  })

  it('keeps the controls of a very long page and says how many texts were left out', () => {
    const page = Array.from({ length: 12 }, (_, i) => (i % 3 === 0 ? el(`e${i + 1}`, 'link', `"Link ${i + 1}" link`) : el(`e${i + 1}`, 'text', `"Text ${i + 1}" text`)))
    const { lines, omitted } = listElements(page, 6)
    // 4 links and the first 2 texts, in page order.
    expect(lines.map((l) => l.split(' ')[0])).toEqual(['e1', 'e2', 'e3', 'e4', 'e7', 'e10'])
    expect(omitted).toBe(6)
    expect(listElements(page).omitted).toBe(0)
  })
})
