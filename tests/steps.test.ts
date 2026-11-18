// Rules about steps that the editor, the Worker and the assistant share: how a step reads as a sentence,
// what the editor refuses before the server does, and which step of a run is the one being executed.
import { describe, expect, it } from 'vitest'
import { MAX_ELEMENT_NAME, MAX_LOCATOR_LENGTH, MAX_STEP_TEXT, stepSentence } from '../shared/commands'
import { nextToRun } from '../shared/expand'
import type { ElementRef, Step } from '../shared/types'
import { changeCommand, commandChoices, limitError, stepErrors } from '../src/editor/model'

const target = (name = '"Email" input area'): ElementRef => ({
  uiId: 'ui1',
  elementId: 'e1',
  name,
  locator: { key: 'id', value: 'email' },
  candidates: [{ key: 'id', value: 'email' }],
  fingerprint: { tag: 'input', type: 'input', text: '', label: 'Email', attrs: {}, path: 'body>input', box: { x: 0, y: 0, w: 10, h: 10 } },
})

describe('stepSentence', () => {
  it('puts values in as they are, whatever they contain', () => {
    // In a replacement string these would be patterns: $$ a single $, $& the placeholder itself.
    for (const value of ['pa$$word', 'a$&b', "$`x$'", '$1', '{target}', '{variable}']) {
      expect(stepSentence({ id: 's', command: 'input', value, target: target() })).toBe(`Input ${JSON.stringify(value)} to "Email" input area`)
      expect(stepSentence({ id: 's', command: 'comment', value })).toBe(`// ${value}`)
    }
    expect(stepSentence({ id: 's', command: 'store_fixed', value: '$&', variable: 'A' })).toBe('Store "$&" to A')
  })

  it('does not substitute inside an element name', () => {
    expect(stepSentence({ id: 's', command: 'input', value: 'x', target: target('{value} $& field') })).toBe('Input "x" to {value} $& field')
    expect(stepSentence({ id: 's', command: 'store_text', variable: 'V', target: target('{variable}') })).toBe('Store the text of {variable} to V')
  })
})

describe('what the editor refuses before the server does', () => {
  it('reports a text the server would not store, also on a disabled step', () => {
    const long: Step = { id: 'a', command: 'input', value: 'x'.repeat(MAX_STEP_TEXT + 1), target: target() }
    expect(limitError(long)).toMatch(/too long to be saved/)
    expect(limitError({ ...long, value: 'x'.repeat(MAX_STEP_TEXT) })).toBeNull()
    expect(stepErrors([{ ...long, disabled: true }]).get('a')).toMatch(/too long to be saved/)
    expect(limitError({ id: 'b', command: 'click', target: target('n'.repeat(MAX_ELEMENT_NAME + 1)) })).toMatch(/name of the UI element/)
    const t = target()
    expect(limitError({ id: 'c', command: 'click', target: { ...t, candidates: [{ key: 'css', value: 'a'.repeat(MAX_LOCATOR_LENGTH + 1) }] } })).toMatch(/locator/)
  })

  it('reports an assertion or a selection that names nothing: it would pass on any page', () => {
    const steps: Step[] = [
      { id: 'a', command: 'assert_text_contains', target: target() },
      { id: 'b', command: 'assert_url_contains', value: ' ' },
      { id: 'c', command: 'assert_title_contains', value: '' },
      { id: 'd', command: 'select', value: '', target: target() },
      { id: 'e', command: 'assert_url_equals' },
      // Legitimate: this is how a field is checked to be empty, and how a field is cleared.
      { id: 'f', command: 'assert_text_equals', value: '', target: target() },
      { id: 'g', command: 'input', value: '', target: target() },
      { id: 'h', command: 'assert_text_contains', value: '${EXPECTED}', target: target() },
      { id: 'i', command: 'assert_url_contains', value: '', disabled: true },
    ]
    expect([...stepErrors(steps).keys()]).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
})

describe('changing the command of a row', () => {
  it('drops the element when the new command does not act on one', () => {
    const picked: Step = { id: 'a', command: 'wait_seconds', value: '1', target: target() }
    // A row that carries an element is only offered element commands; one that got a hidden element this
    // way was stuck with them.
    expect(commandChoices(picked).every((c) => c.target)).toBe(true)
    const next = changeCommand({ id: 'a', command: 'click' }, 'wait_seconds')
    expect(next.target).toBeUndefined()
    expect(changeCommand({ ...picked, command: 'click' }, 'hover').target).toEqual(target())
    expect(changeCommand({ id: 'a', command: 'click', target: target() }, 'navigate').target).toBeUndefined()
  })
})

describe('nextToRun', () => {
  const steps: Step[] = [
    { id: '1', command: 'navigate', value: '/' },
    { id: '2', command: 'if_exists', target: target() },
    { id: '3', command: 'click', target: target() },
    { id: '4', command: 'end_if' },
    { id: '5', command: 'click', target: target() },
    { id: '6', command: 'click', target: target(), disabled: true },
    { id: '7', command: 'click', target: target() },
  ]
  const after = (...done: string[]) => nextToRun(steps, null, (id) => done.includes(id))?.id

  it('is the first step without a result after the last one that has one', () => {
    expect(after()).toBe('1')
    expect(after('1')).toBe('2')
    // The branch was not taken: step 3 never gets a result, and the run is past it.
    expect(after('1', '2', '4')).toBe('5')
    expect(after('1', '2', '4', '5')).toBe('7')
    expect(after('1', '2', '4', '5', '7')).toBeUndefined()
  })

  it('stays inside the range of a partial run', () => {
    expect(nextToRun(steps, { from: 5, to: 5 }, () => false)?.id).toBe('5')
    expect(nextToRun(steps, { from: 5, to: 5 }, (id) => id === '5')).toBeUndefined()
  })
})
