// Shared steps on the server: loading a project's shared steps for expansion, and finding who calls one.
import { expandSteps, type Expansion, type SharedLookup, type SharedSource } from '../shared/expand'
import type { Step } from '../shared/types'
import { isSharedRow, type TestCaseRow } from './db'
import { HttpError } from './env'

const parseSteps = (text: string): Step[] => {
  try {
    return JSON.parse(text) as Step[]
  } catch {
    return []
  }
}

const toSource = (r: Pick<TestCaseRow, 'id' | 'project_id' | 'number' | 'name' | 'steps'>): SharedSource => ({
  id: r.id,
  projectId: r.project_id,
  number: Math.abs(r.number),
  name: r.name,
  steps: parseSteps(r.steps),
})

/**
 * Look-up for the shared steps a list of steps calls. Loaded by id, not by project, so a call that points
 * into another project is found and can be reported as that instead of as "deleted".
 */
export async function sharedLookupFor(db: D1Database, lists: Step[][]): Promise<SharedLookup> {
  const ids = [...new Set(lists.flatMap((steps) => steps.filter((s) => s.command === 'shared_step' && s.value).map((s) => s.value!)))]
  const byId = new Map<string, SharedSource>()
  // D1 allows 100 bound parameters per statement.
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90)
    const { results } = await db
      .prepare(`SELECT id, project_id, number, name, steps FROM test_cases WHERE kind = 'shared' AND id IN (${chunk.map(() => '?').join(', ')})`)
      .bind(...chunk)
      .all<TestCaseRow>()
    for (const r of results) byId.set(r.id, toSource(r))
  }
  return (id) => byId.get(id)
}

/** The steps of a test case (or of a shared step run by itself) as a run executes them. */
export async function expandRow(db: D1Database, row: TestCaseRow, lookup?: SharedLookup): Promise<Expansion & { own: Step[] }> {
  const own = parseSteps(row.steps)
  const expansion = expandSteps(own, lookup ?? (await sharedLookupFor(db, [own])), row.project_id, isSharedRow(row))
  return { ...expansion, own }
}

/** 400 with the first problem, named by the step's number in the list it belongs to. */
export function assertExpanded(expansion: Expansion & { own: Step[] }, prefix = ''): void {
  const first = expansion.problems[0]
  if (first) throw new HttpError(400, `${prefix}Step ${expansion.own.findIndex((s) => s.id === first.stepId) + 1}: ${first.message}`)
}

/** Largest expanded step list a run may have: the snapshot is stored in one D1 value. */
export const MAX_RUN_STEPS = 500

export interface Caller {
  id: string
  number: number
  name: string
}

/** Test cases of the project that call each shared step, by shared step id. Disabled calls count: they still point at it. */
export async function callersByShared(db: D1Database, projectId: string): Promise<Map<string, Caller[]>> {
  // The LIKE only narrows the rows down; the steps are parsed to be sure.
  const { results } = await db
    .prepare(`SELECT id, number, name, steps FROM test_cases WHERE project_id = ? AND kind = 'test' AND steps LIKE '%"shared_step"%' ORDER BY number`)
    .bind(projectId)
    .all<TestCaseRow>()
  const out = new Map<string, Caller[]>()
  for (const r of results) {
    const called = new Set(parseSteps(r.steps).filter((s) => s.command === 'shared_step' && s.value).map((s) => s.value!))
    for (const id of called) {
      const list = out.get(id) ?? []
      list.push({ id: r.id, number: r.number, name: r.name })
      out.set(id, list)
    }
  }
  return out
}
