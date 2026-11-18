// Data-driven tests. A test case can have a data table; a run of it executes the steps once per row
// ("pattern"), and inside a row ${COLUMN} reads that row's cell. Everything here is a pure function: the
// Worker, the data grid and the in-browser mock all use it.
import { isBuiltInVariable } from './commands'
import type { DataTable, RunPattern, RunStatus } from './types'

export const MAX_DATA_COLUMNS = 20
export const MAX_DATA_ROWS = 50
export const MAX_CELL_LENGTH = 2000
/** Same rule as project variables (worker/validate.ts). */
export const MAX_COLUMN_NAME_LENGTH = 60
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

// ---- CSV / TSV ----

/**
 * Parse text copied from a spreadsheet (tab separated) or a CSV file into rows of cells. The format is
 * decided by the first line: a tab in it means TSV. Quoted cells follow RFC 4180 in both: "" is a quote,
 * and a quoted cell may contain the delimiter and line breaks. A byte order mark and blank lines are
 * dropped; rows are not padded to the same length.
 */
export function parseDelimited(input: string, forced?: ',' | '\t'): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input
  if (text === '') return []
  const firstLine = text.split(/\r\n|\n|\r/, 1)[0]
  const delimiter = forced ?? (firstLine.includes('\t') ? '\t' : ',')
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  // A cell is only "quoted" when the quote is its first character; a quote in the middle is ordinary text.
  let atStart = true
  // Did the row have a quoted cell? `""` on a line of its own is an empty cell, not a blank line.
  let rowQuoted = false
  let i = 0
  const endCell = () => {
    row.push(cell)
    cell = ''
    atStart = true
  }
  const endRow = () => {
    endCell()
    if (row.length > 1 || row[0] !== '' || rowQuoted) rows.push(row)
    row = []
    rowQuoted = false
  }
  while (i < text.length) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i += 2
          continue
        }
        quoted = false
      } else cell += ch
      i++
      continue
    }
    if (ch === '"' && atStart) {
      quoted = true
      rowQuoted = true
      atStart = false
    } else if (ch === delimiter) endCell()
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      endRow()
    } else {
      cell += ch
      atStart = false
    }
    i++
  }
  // The last line, unless the text ended with a line break.
  if (cell !== '' || row.length > 0 || !atStart) endRow()
  return rows
}

/**
 * What was pasted into the grid. A spreadsheet copies cells tab separated. Text without a tab is taken as
 * CSV only when every line splits into the same number of cells (more than one); otherwise each line is
 * one cell, so a column of sentences with commas in them stays one column.
 */
export function parsePasted(text: string): string[][] {
  if (text.includes('\t')) return parseDelimited(text, '\t')
  const csv = parseDelimited(text, ',')
  if (csv.length > 0 && csv[0].length > 1 && csv.every((r) => r.length === csv[0].length)) return csv
  return parseDelimited(text, '\t')
}

/** A table from parsed rows whose first row holds the column names. Short rows are padded, long ones cut. */
export function tableFromRows(rows: string[][]): DataTable {
  const [head = [], ...body] = rows
  const columns = head.map((c) => c.trim())
  return { columns, rows: body.map((r) => columns.map((_, i) => r[i] ?? '')) }
}

// ---- validation ----

export interface DataProblem {
  /** 0-based data row. Absent for a problem with a column name or with the table as a whole. */
  row?: number
  /** 0-based column. Absent for a problem with the table as a whole. */
  column?: number
  message: string
}

/** Everything that is wrong with a data table; empty when it can be saved. */
export function validateDataTable(table: DataTable): DataProblem[] {
  const problems: DataProblem[] = []
  if (table.columns.length > MAX_DATA_COLUMNS) problems.push({ message: `A data table can have at most ${MAX_DATA_COLUMNS} columns` })
  if (table.rows.length > MAX_DATA_ROWS) problems.push({ message: `A data table can have at most ${MAX_DATA_ROWS} rows` })
  if (table.columns.length === 0 && table.rows.length > 0) problems.push({ message: 'Add a column before adding rows' })
  const seen = new Set<string>()
  table.columns.forEach((name, column) => {
    let message: string | null = null
    if (name === '') message = 'Name this column'
    else if (name.length > MAX_COLUMN_NAME_LENGTH) message = `A column name can have at most ${MAX_COLUMN_NAME_LENGTH} characters`
    else if (!NAME.test(name)) message = 'Use letters, digits and _ only, not starting with a digit'
    else if (isBuiltInVariable(name)) message = `${name} is a built-in variable; use another name`
    else if (seen.has(name)) message = `There is already a column named ${name}`
    seen.add(name)
    if (message) problems.push({ column, message })
  })
  table.rows.forEach((cells, row) => {
    if (cells.length !== table.columns.length) problems.push({ row, message: `Row ${row + 1} has ${cells.length} cells for ${table.columns.length} columns` })
    cells.forEach((cell, column) => {
      if (cell.length > MAX_CELL_LENGTH) problems.push({ row, column, message: `A cell can have at most ${MAX_CELL_LENGTH} characters` })
    })
  })
  return problems
}

/** Where a problem is, in words: `row 3, column EMAIL`. */
export function describeDataProblem(table: DataTable, p: DataProblem): string {
  const column = p.column === undefined ? null : table.columns[p.column] || `${p.column + 1}`
  const where = p.row !== undefined ? `row ${p.row + 1}${column ? `, column ${column}` : ''}` : column ? `column ${column}` : ''
  return where ? `${where}: ${p.message}` : p.message
}

/** Does the table make runs data-driven? A table without rows (or without columns) does not. */
export const hasPatterns = (table: DataTable | null | undefined): table is DataTable => !!table && table.columns.length > 0 && table.rows.length > 0

/** The values of one row by column name. `row` is 1-based. */
export function rowValues(table: DataTable, row: number): Record<string, string> {
  const cells = table.rows[row - 1] ?? []
  return Object.fromEntries(table.columns.map((name, i) => [name, cells[i] ?? '']))
}

// ---- run time ----

/**
 * The variables a pattern starts with: a column wins over a project variable of the same name. The
 * engine then puts the built-ins on top, and a value stored by a step replaces whatever was there, so the
 * precedence is: stored by a step > row > project (built-in names stay reserved).
 */
export const runVariables = (project: Record<string, string>, row: Record<string, string> | null | undefined): Record<string, string> => ({ ...project, ...(row ?? {}) })

/**
 * Status of a run from its finished patterns: aborted if one was aborted, else failed if any failed, else
 * unresolved if any waits for a repair review, else succeeded.
 */
export function aggregateStatus(statuses: RunStatus[]): RunStatus {
  if (statuses.includes('aborted')) return 'aborted'
  if (statuses.includes('failed')) return 'failed'
  if (statuses.includes('unresolved')) return 'unresolved'
  if (statuses.some((s) => s === 'queued' || s === 'running')) return 'running'
  return 'succeeded'
}

/** `2 of 3 patterns passed`, for a list that shows a data-driven run as one line. */
export function patternSummary(patterns: RunPattern[]): string {
  const passed = patterns.filter((p) => p.status === 'succeeded').length
  // Not passed yet, but not failed either: say so, or "0 of 3 passed" reads as three failures.
  const review = patterns.filter((p) => p.status === 'unresolved').length
  return `${passed} of ${patterns.length} ${patterns.length === 1 ? 'pattern' : 'patterns'} passed${review ? `, ${review} ${review === 1 ? 'needs' : 'need'} review` : ''}`
}

// ---- log ----
// The log of a data-driven run is one text: the header, one section per pattern, and a summary. The
// section headings are what lets the report show one pattern at a time.

export const patternLogHeading = (index: number): string => `=== Pattern ${index} ===`
export const SUMMARY_LOG_HEADING = '=== Summary ==='
const HEADING = /^=== Pattern (\d+) ===$/

export interface SplitLog {
  /** Lines before the first pattern. */
  header: string
  /** By 1-based pattern index, heading line included. */
  patterns: Map<number, string>
  /** The summary and whatever was appended after it (aborts, repair decisions). */
  footer: string
}

export function splitLog(log: string): SplitLog {
  const header: string[] = []
  const footer: string[] = []
  const patterns = new Map<number, string[]>()
  let into = header
  for (const line of log.split('\n')) {
    const heading = HEADING.exec(line)
    if (heading) {
      into = []
      patterns.set(Number(heading[1]), into)
    } else if (line === SUMMARY_LOG_HEADING) into = footer
    into.push(line)
  }
  return { header: header.join('\n'), patterns: new Map([...patterns].map(([k, v]) => [k, v.join('\n')])), footer: footer.join('\n') }
}

/** What the report shows for one pattern: the header, that pattern's section, the summary. */
export function logOfPattern(log: string, index: number): string {
  const parts = splitLog(log)
  return [parts.header, parts.patterns.get(index) ?? '', parts.footer].filter((s) => s !== '').join('\n')
}
