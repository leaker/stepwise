// A D1Database for tests: the project's real migrations on an in-memory SQLite (node:sqlite), behind the
// part of the D1 API the Worker uses. The SQL under test is the SQL that runs in production.
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const MIGRATIONS = resolve(fileURLToPath(new URL('../../migrations', import.meta.url)))

class Statement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly args: SQLInputValue[] = [],
  ) {}

  bind(...args: unknown[]): Statement {
    return new Statement(this.db, this.sql, args as SQLInputValue[])
  }

  private rows(): Record<string, unknown>[] {
    return this.db.prepare(this.sql).all(...this.args) as Record<string, unknown>[]
  }

  async first<T>(): Promise<T | null> {
    return (this.rows()[0] as T | undefined) ?? null
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.rows() as T[] }
  }

  async run(): Promise<{ meta: { changes: number } }> {
    const info = this.db.prepare(this.sql).run(...this.args)
    return { meta: { changes: Number(info.changes) } }
  }
}

export function memoryD1(): D1Database {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) db.exec(readFileSync(resolve(MIGRATIONS, file), 'utf8'))
  const d1 = {
    prepare: (sql: string) => new Statement(db, sql),
    batch: async (statements: Statement[]) => {
      const out = []
      for (const s of statements) out.push(await s.all())
      return out
    },
  }
  return d1 as unknown as D1Database
}

/** A project with one test case; returns their ids. */
export async function seedTestCase(db: D1Database, o: { baseUrl?: string; variables?: Record<string, string>; steps?: unknown[] } = {}): Promise<{ projectId: string; testCaseId: string }> {
  const n = Math.random().toString(36).slice(2, 10)
  const projectId = `p${n}`
  const testCaseId = `t${n}`
  const at = '2026-01-01T00:00:00.000Z'
  await db.prepare('INSERT INTO projects (id, name, base_url, variables, created_at) VALUES (?, ?, ?, ?, ?)').bind(projectId, `Project ${n}`, o.baseUrl ?? 'https://shop.example', JSON.stringify(o.variables ?? {}), at).run()
  await db
    .prepare('INSERT INTO test_cases (id, project_id, number, name, steps, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?)')
    .bind(testCaseId, projectId, 'Case', JSON.stringify(o.steps ?? []), at, at)
    .run()
  return { projectId, testCaseId }
}
