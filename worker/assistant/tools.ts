// The assistant's tools, run against the same database rows and engine code paths the HTTP API uses.
// A tool never throws for something the model can fix: it returns an error result with what to do instead.
import { COMMAND_BY_ID, stepSentence, validateSteps } from '../../shared/commands'
import { deviceOf } from '../../shared/devices'
import type { Step, Ui } from '../../shared/types'
import { getProjectRow, getTestCaseRow, newId, now, resolveBaseUrl, toUi, type TestCaseRow, type UiRow } from '../db'
import { errorMessage, HttpError, type Env } from '../env'
import { captureScreen, trialRun, type BrowserLease } from '../runner'
import { assertNavigateTargetsAllowed, isHostAllowed, resolveUrl } from '../validate'
import type { ToolHost, ToolOutcome, ToolResultContent } from './loop'
import type { TaskContext } from './prompt'
import { asInput, checkStep, commandOf, DEFAULT_VALUE, optionalInt, optionalString, requiredInt, stepIndex, targetFrom, ToolInputError, type Input } from './steps'

const json = (value: unknown): string => JSON.stringify(value)
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

interface Loaded {
  row: TestCaseRow
  steps: Step[]
  baseUrl: string
  variables: Record<string, string>
}

export interface AssistantTools extends ToolHost {
  /** The test case as it is now, for the first message of the conversation. */
  context(): Promise<TaskContext>
}

export function assistantTools(env: Env, testCaseId: string, appOrigin: string, browser: BrowserLease, active: () => Promise<boolean>): AssistantTools {
  const load = async (): Promise<Loaded> => {
    const row = await getTestCaseRow(env.DB, testCaseId)
    const project = await getProjectRow(env.DB, row.project_id)
    return {
      row,
      steps: JSON.parse(row.steps) as Step[],
      baseUrl: resolveBaseUrl(project.base_url, appOrigin),
      variables: JSON.parse(project.variables) as Record<string, string>,
    }
  }
  const loadUis = async (): Promise<Ui[]> => {
    const { results } = await env.DB.prepare('SELECT * FROM uis WHERE test_case_id = ? ORDER BY created_at, rowid').bind(testCaseId).all<UiRow>()
    return results.map(toUi)
  }
  /** The editor notices the change through updated_at and reloads the steps. */
  const saveSteps = async (steps: Step[]): Promise<void> => {
    if (steps.length > 500) throw new ToolInputError('A test case can have at most 500 steps.')
    await env.DB.prepare('UPDATE test_cases SET steps = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(steps), now(), testCaseId).run()
  }
  const urlProblem = (t: Loaded) => (value: string): string | null => {
    try {
      assertNavigateTargetsAllowed([{ id: 'x', command: 'navigate', value }], t.baseUrl, t.variables, env, appOrigin)
    } catch (e) {
      // "Step 1: host is not in this deployment's allowed hosts"
      return `${errorMessage(e).replace(/^Step 1: /, '')}. Tests in this deployment can only open allowed sites.`
    }
    const known = value.replace(/\$\{BASE_URL\}/g, t.baseUrl)
    if (!known.includes('${') && !resolveUrl(known, t.baseUrl)) return `"${clip(value, 80)}" is not a URL the test can open. Use an absolute http(s) URL${t.baseUrl ? ' or one built from ${BASE_URL}' : ''}.`
    return null
  }
  const listed = (steps: Step[]) =>
    steps.map((s, i) => ({
      step: i + 1,
      sentence: stepSentence(s),
      command: s.command,
      ...(s.target ? { element: s.target.name, ui_id: s.target.uiId, element_id: s.target.elementId } : {}),
      ...(s.value !== undefined ? { value: s.value } : {}),
      ...(s.variable !== undefined ? { variable: s.variable } : {}),
      ...(s.disabled ? { disabled: true } : {}),
    }))

  // ---- tools ----

  const getSteps = async (): Promise<ToolOutcome> => {
    const t = await load()
    return { content: json({ device: deviceOf(t.row.device).id, base_url: t.baseUrl, steps: listed(t.steps) }), event: `Read the steps (${t.steps.length})` }
  }

  const capture = async (input: Input): Promise<ToolOutcome> => {
    const afterStep = requiredInt(input, 'after_step')
    const urlText = optionalString(input, 'url', 2000)
    const t = await load()
    let replayTo: number | null = null
    let url: URL | null = null
    if (afterStep > 0) {
      replayTo = stepIndex(t.steps, afterStep, 'after_step') + 1
      assertNavigateTargetsAllowed(t.steps.slice(0, replayTo), t.baseUrl, t.variables, env, appOrigin)
    } else if (afterStep === 0) {
      const text = (urlText ?? '').trim() || t.baseUrl
      if (!text) throw new ToolInputError('The project has no base URL, so pass url: the absolute http(s) URL of the page to capture.')
      url = resolveUrl(text.replace(/\$\{BASE_URL\}/g, t.baseUrl), t.baseUrl)
      if (!url) throw new ToolInputError(`"${clip(text, 80)}" is not a URL that can be opened. Pass an absolute http(s) URL${t.baseUrl ? `, or a path relative to the base URL ${t.baseUrl}` : ''}.`)
      if (!isHostAllowed(url, env, appOrigin)) throw new ToolInputError(`${url.hostname} is not in this deployment's allowed hosts, so it cannot be opened. Tell the user if the test needs it.`)
    } else throw new ToolInputError('after_step must be 0 or a step number.')

    const res = await captureScreen(env, { testCase: t.row, steps: t.steps, baseUrl: t.baseUrl, variables: t.variables, replayTo, url, appOrigin, preview: true }, await browser.get())
    const { ui, replayError, preview } = res
    const failedAt = replayError ? t.steps.findIndex((s) => s.id === replayError.stepId) + 1 : 0
    const body = {
      ui_id: ui.id,
      name: ui.name,
      url: ui.url,
      title: ui.title,
      ...(replayError ? { replay_error: { step: failedAt, message: clip(replayError.message, 400) }, note: `The replay stopped at step ${failedAt}: the capture shows the page at that point, not after step ${afterStep}.` } : {}),
      ...(preview?.cropped ? { screenshot_note: 'The screenshot shows only the top of a long page; the element list covers the whole page.' } : {}),
      elements: ui.elements.map((e) => ({ element_id: e.id, name: e.name, type: e.type, ...(e.fingerprint.text ? { text: clip(e.fingerprint.text, 100) } : {}) })),
    }
    const content: ToolResultContent = [{ type: 'text', text: json(body) }]
    if (preview) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: preview.data } })
    const where = replayTo ? `after step ${replayTo}` : `of ${ui.url}`
    return {
      content,
      event: `Captured screen ${where} (${ui.name}, ${ui.elements.length} element${ui.elements.length === 1 ? '' : 's'})`,
      ...(replayError ? { detail: `The replay stopped at step ${failedAt}: ${clip(replayError.message, 300)}`, failed: true } : {}),
    }
  }

  const addStep = async (input: Input): Promise<ToolOutcome> => {
    const command = commandOf(input.command)
    const def = COMMAND_BY_ID[command]
    const uiId = optionalString(input, 'ui_id', 64)
    const elementId = optionalString(input, 'element_id', 64)
    const afterStep = optionalInt(input, 'after_step')
    const t = await load()
    if (afterStep !== undefined && (afterStep < 0 || afterStep > t.steps.length)) throw new ToolInputError(`after_step must be between 0 and ${t.steps.length}. Omit it to append at the end.`)
    const step: Step = { id: newId(), command }
    if (def.target || uiId || elementId) step.target = targetFrom(await loadUis(), uiId, elementId, deviceOf(t.row.device).id)
    const value = optionalString(input, 'value') ?? DEFAULT_VALUE[command]
    if (value !== undefined) step.value = value
    const variable = optionalString(input, 'variable', 60)?.trim()
    if (variable !== undefined) step.variable = variable
    checkStep(step, urlProblem(t))

    const at = afterStep ?? t.steps.length
    const next = [...t.steps]
    next.splice(at, 0, step)
    await saveSteps(next)
    const sentence = stepSentence(step)
    return { content: json({ step: at + 1, sentence, total_steps: next.length }), event: `Added step ${at + 1}: ${sentence}` }
  }

  const updateStep = async (input: Input): Promise<ToolOutcome> => {
    const t = await load()
    const index = stepIndex(t.steps, requiredInt(input, 'step'))
    const current = t.steps[index]
    const command = input.command === undefined || input.command === null ? current.command : commandOf(input.command)
    const def = COMMAND_BY_ID[command]
    const uiId = optionalString(input, 'ui_id', 64)
    const elementId = optionalString(input, 'element_id', 64)
    const step: Step = { ...current, command }
    if (uiId || elementId) step.target = targetFrom(await loadUis(), uiId, elementId, deviceOf(t.row.device).id)
    const value = optionalString(input, 'value')
    if (value !== undefined) step.value = value
    const variable = optionalString(input, 'variable', 60)?.trim()
    if (variable !== undefined) step.variable = variable
    if (command !== current.command) {
      // Parameters the new command does not have are dropped, as when the command is changed in the editor.
      if (!def.target) delete step.target
      if (!def.value) delete step.value
      else if (step.value === undefined && DEFAULT_VALUE[command] !== undefined) step.value = DEFAULT_VALUE[command]
      if (!def.variable) delete step.variable
      if (!def.assertion) delete step.continueOnFailure
    }
    if (typeof input.disabled === 'boolean') {
      if (input.disabled) step.disabled = true
      else delete step.disabled
    } else if (input.disabled !== undefined && input.disabled !== null) throw new ToolInputError('disabled must be true or false.')
    checkStep(step, urlProblem(t))

    const next = [...t.steps]
    next[index] = step
    await saveSteps(next)
    const sentence = stepSentence(step)
    return { content: json({ step: index + 1, sentence, ...(step.disabled ? { disabled: true } : {}) }), event: `Changed step ${index + 1}: ${sentence}${step.disabled ? ' (disabled)' : ''}` }
  }

  const deleteStep = async (input: Input): Promise<ToolOutcome> => {
    const t = await load()
    const index = stepIndex(t.steps, requiredInt(input, 'step'))
    const sentence = stepSentence(t.steps[index])
    const next = t.steps.filter((_, i) => i !== index)
    await saveSteps(next)
    return { content: json({ deleted: index + 1, sentence, total_steps: next.length }), event: `Removed step ${index + 1}: ${sentence}` }
  }

  const runSteps = async (input: Input): Promise<ToolOutcome> => {
    const t = await load()
    if (!t.steps.some((s) => !s.disabled)) throw new ToolInputError('The test case has no steps to run. Add steps first.')
    const from = optionalInt(input, 'from') ?? 1
    const to = optionalInt(input, 'to') ?? t.steps.length
    if (from < 1 || to < from || to > t.steps.length) throw new ToolInputError(`from/to must be within steps 1-${t.steps.length}, with from not after to.`)
    const whole = from === 1 && to === t.steps.length
    if (whole) {
      const problem = validateSteps(t.steps)[0]
      if (problem) throw new ToolInputError(`Step ${t.steps.findIndex((s) => s.id === problem.stepId) + 1}: ${problem.message}. Fix the branch structure, then run again.`)
    }
    assertNavigateTargetsAllowed(t.steps.slice(0, to), t.baseUrl, t.variables, env, appOrigin)

    const outcome = await trialRun(env, await browser.get(), {
      device: deviceOf(t.row.device),
      steps: t.steps,
      baseUrl: t.baseUrl,
      variables: t.variables,
      range: whole ? null : { from, to },
      appOrigin,
      shouldAbort: async () => !(await active()),
    })
    const steps = outcome.results.map((r) => ({ step: r.number, sentence: r.sentence, status: r.status, ...(r.error ? { error: clip(r.error, 500) } : {}) }))
    const firstFailed = outcome.results.find((r) => r.status === 'failed')
    const range = from === to ? `step ${from}` : `steps ${from}-${to}`
    const passed = outcome.status === 'succeeded'
    return {
      content: json({ status: passed ? 'passed' : outcome.status, steps, ...(firstFailed ? { first_error: { step: firstFailed.number, message: clip(firstFailed.error ?? 'failed', 500) } } : {}) }),
      event: `Ran ${range}: ${passed ? 'all passed' : firstFailed ? `step ${firstFailed.number} failed` : outcome.status}`,
      ...(firstFailed ? { detail: `${firstFailed.sentence}: ${clip(firstFailed.error ?? 'failed', 300)}` } : {}),
      ...(passed ? {} : { failed: true }),
    }
  }

  const tools: Record<string, (input: Input) => Promise<ToolOutcome>> = {
    get_steps: getSteps,
    capture_screen: capture,
    add_step: addStep,
    update_step: updateStep,
    delete_step: deleteStep,
    run_steps: runSteps,
  }
  const failedEvent: Record<string, string> = {
    get_steps: 'Could not read the steps',
    capture_screen: 'Could not capture the screen',
    add_step: 'Could not add a step',
    update_step: 'Could not change a step',
    delete_step: 'Could not remove a step',
    run_steps: 'Could not run the steps',
  }

  return {
    context: async () => {
      const t = await load()
      return { testCaseName: `#${t.row.number} ${t.row.name}`, device: deviceOf(t.row.device), baseUrl: t.baseUrl, variableNames: Object.keys(t.variables), steps: t.steps }
    },
    call: async (name, input) => {
      const tool = Object.hasOwn(tools, name) ? tools[name] : undefined
      if (!tool) return { content: `There is no tool named "${name}". Available: ${Object.keys(tools).join(', ')}.`, isError: true, event: `Unknown tool ${name}` }
      try {
        return await tool(asInput(input))
      } catch (e) {
        // What the model can act on: its own input, the target policy (400), a page that would not open (502),
        // no browser right now (503), the test case being gone (404). Anything else is a bug and goes to the loop.
        if (!(e instanceof ToolInputError) && !(e instanceof HttpError)) throw e
        return { content: e.message, isError: true, event: failedEvent[name], detail: clip(e.message, 300) }
      }
    },
  }
}
