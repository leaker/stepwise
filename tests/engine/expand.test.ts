// Expanding shared step calls into a run's step list, and the numbering that goes with it. Pure functions.
import { describe, expect, it } from 'vitest'
import { stepSentence } from '../../shared/commands'
import { callProblems, expandSteps, flatRange, positionLabel, positionsOf, reportedSteps, topLevelCount, type SharedSource } from '../../shared/expand'
import type { Step } from '../../shared/types'

const s = (id: string, command: Step['command'] = 'comment', fields: Partial<Step> = {}): Step => ({ id, command, ...fields })
const call = (id: string, sharedId: string, fields: Partial<Step> = {}): Step => s(id, 'shared_step', { value: sharedId, ...fields })

const signIn: SharedSource = { id: 'sh1', projectId: 'p1', number: 1, name: 'Sign in', steps: [s('a', 'navigate', { value: '/login' }), s('b', 'comment', { value: 'typed', disabled: true }), s('c', 'press_key', { value: 'Enter' })] }
const sources: Record<string, SharedSource> = {
  sh1: signIn,
  other: { ...signIn, id: 'other', projectId: 'p2' },
  nested: { id: 'nested', projectId: 'p1', number: 2, name: 'Outer', steps: [call('n1', 'sh1')] },
  open: { id: 'open', projectId: 'p1', number: 3, name: 'Open branch', steps: [s('i', 'if_variable_equals', { variable: 'X', value: '1' }), s('j')] },
  empty: { id: 'empty', projectId: 'p1', number: 4, name: 'Nothing', steps: [] },
}
const lookup = (id: string) => sources[id]

describe('expandSteps', () => {
  it('keeps the call as a marker row and copies the shared step after it, each step knowing where it came from', () => {
    const { steps, problems } = expandSteps([s('one'), call('two', 'sh1'), s('three')], lookup, 'p1')
    expect(problems).toEqual([])
    expect(steps.map((x) => x.id)).toEqual(['one', 'two', 'two.a', 'two.b', 'two.c', 'three'])
    const ref = { id: 'sh1', number: 1, name: 'Sign in' }
    expect(steps[1]).toEqual({ id: 'two', command: 'shared_step', value: 'sh1', call: ref })
    expect(steps[2]).toEqual({ id: 'two.a', command: 'navigate', value: '/login', origin: { callId: 'two', stepId: 'a', shared: ref } })
    // A disabled step of the shared step is copied and stays disabled.
    expect(steps[3].disabled).toBe(true)
    // The marker names the shared step by itself: a report can be read after the shared step was renamed or deleted.
    expect(stepSentence(steps[1])).toBe('Shared step S1: Sign in')
  })

  it('gives the steps of two calls of the same shared step different ids', () => {
    const { steps } = expandSteps([call('x', 'sh1'), call('y', 'sh1')], lookup, 'p1')
    expect(new Set(steps.map((x) => x.id)).size).toBe(steps.length)
    expect(steps.filter((x) => x.origin).map((x) => x.origin!.callId)).toEqual(['x', 'x', 'x', 'y', 'y', 'y'])
  })

  it('leaves a disabled call alone, even when its shared step is gone', () => {
    const { steps, problems } = expandSteps([call('x', 'sh1', { disabled: true }), call('y', 'gone', { disabled: true })], lookup, 'p1')
    expect(problems).toEqual([])
    expect(steps).toEqual([call('x', 'sh1', { disabled: true }), call('y', 'gone', { disabled: true })])
  })

  it('expands a call to an empty shared step to just its marker', () => {
    expect(expandSteps([call('x', 'empty')], lookup, 'p1').steps.map((x) => x.id)).toEqual(['x'])
  })

  it('never trusts `call` or `origin` that came in with the steps', () => {
    const forged = { ...s('one'), call: { id: 'sh1', number: 9, name: 'Forged' }, origin: { callId: 'q', stepId: 'r', shared: { id: 'sh1', number: 9, name: 'Forged' } } }
    expect(expandSteps([forged], lookup, 'p1').steps).toEqual([s('one')])
  })

  it('reports a call that cannot run, on the call, and does not expand it', () => {
    const cases: [Step, string][] = [
      [call('x', 'gone'), 'The shared step this step calls no longer exists'],
      [call('x', 'other'), 'The shared step this step calls belongs to another project'],
      [call('x', 'nested'), 'Shared step S2 calls another shared step, which is not supported'],
      [call('x', 'open'), 'Shared step S3 has an unbalanced If / Otherwise / End branch'],
      [s('x', 'shared_step'), 'No shared step chosen'],
    ]
    for (const [step, message] of cases) {
      const { steps, problems } = expandSteps([s('one'), step], lookup, 'p1')
      expect(problems).toEqual([{ stepId: 'x', message }])
      expect(steps.map((y) => y.id)).toEqual(['one', 'x'])
      expect(steps[1].call).toBeUndefined()
      expect(callProblems([s('one'), step], lookup, 'p1')).toEqual(problems)
    }
  })

  it('refuses any call inside a shared step', () => {
    expect(expandSteps([call('x', 'sh1')], lookup, 'p1', true).problems).toEqual([{ stepId: 'x', message: 'A shared step cannot call another shared step' }])
  })
})

describe('numbering of an expanded list', () => {
  const run = expandSteps([s('one'), call('two', 'sh1'), s('three'), call('four', 'sh1')], lookup, 'p1').steps

  it('counts a call as one step and numbers its steps 2.1, 2.2, ...', () => {
    expect(positionsOf(run).map(positionLabel)).toEqual(['1', '2', '2.1', '2.2', '2.3', '3', '4', '4.1', '4.2', '4.3'])
    expect(topLevelCount(run)).toBe(4)
  })

  it('turns a range of the test case into positions of the flat list; a range that ends on a call includes all of it', () => {
    expect(flatRange(run, { from: 1, to: 2 })).toEqual({ from: 1, to: 5 })
    expect(flatRange(run, { from: 2, to: 2 })).toEqual({ from: 2, to: 5 })
    expect(flatRange(run, { from: 3, to: 4 })).toEqual({ from: 6, to: 10 })
    expect(flatRange(run, { from: 3, to: 3 })).toEqual({ from: 6, to: 6 })
  })

  it('lists the steps a run reports on: no marker rows, no disabled steps, nothing outside the range', () => {
    expect(reportedSteps(run, null).map((x) => x.id)).toEqual(['one', 'two.a', 'two.c', 'three', 'four.a', 'four.c'])
    expect(reportedSteps(run, { from: 2, to: 3 }).map((x) => x.id)).toEqual(['two.a', 'two.c', 'three'])
  })

  it('is the identity for a list without shared steps (runs stored before shared steps existed)', () => {
    const old = [s('a'), s('b'), s('c')]
    expect(positionsOf(old)).toEqual([{ number: 1 }, { number: 2 }, { number: 3 }])
    expect(flatRange(old, { from: 2, to: 3 })).toEqual({ from: 2, to: 3 })
    expect(topLevelCount(old)).toBe(3)
  })
})

describe('stepSentence for a call', () => {
  it('names the shared step when it can be looked up, and says so when it cannot', () => {
    expect(stepSentence(call('x', 'sh1'), lookup)).toBe('Shared step S1: Sign in')
    expect(stepSentence(call('x', 'gone'), lookup)).toBe('Shared step (deleted)')
    expect(stepSentence(call('x', 'sh1'))).toBe('Shared step')
    expect(stepSentence(s('x', 'shared_step'), lookup)).toBe('Shared step (none chosen)')
  })
})
