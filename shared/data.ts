// Data-driven tests. A test case can have a data table; a run of it executes the steps once per row
// ("pattern"), and inside a row ${COLUMN} reads that row's cell. Everything here is a pure function: the
// Worker, the data grid and the in-browser mock all use it.
import { isBuiltInVariable } from './commands'
import type { DataTable, RunPattern, RunStatus } from './types'

export const MAX_DATA_COLUMNS = 20
export const MAX_DATA_ROWS = 50
export const MAX_CELL_LENGTH = 2000
/**
 * Largest table as JSON, in UTF-8 bytes. The table is stored in one D1 value next to the steps and copied
 * into every run with the results and the log, and D1 holds 2 MB per row; the request body limit is 1 MB.
 */
export const MAX_DATA_BYTES = 256 * 1024
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

/** Size of the table the way it is stored. */
export const dataBytes = (table: DataTable): number => new TextEncoder().encode(JSON.stringify(table)).length

/** Everything that is wrong with a data table; empty when it can be saved. */
export function validateDataTable(table: DataTable): DataProblem[] {
  const problems: DataProblem[] = []
  if (table.columns.length > MAX_DATA_COLUMNS) problems.push({ message: `A data table can have at most ${MAX_DATA_COLUMNS} columns` })
  if (table.rows.length > MAX_DATA_ROWS) problems.push({ message: `A data table can have at most ${MAX_DATA_ROWS} rows` })
  if (table.columns.length === 0 && table.rows.length > 0) problems.push({ message: 'Add a column before adding rows' })
  const bytes = dataBytes(table)
  if (bytes > MAX_DATA_BYTES) problems.push({ message: `The table is too large: ${Math.ceil(bytes / 1024)} KB of at most ${MAX_DATA_BYTES / 1024} KB in total. Shorten cells or remove rows.` })
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

/**
 * The patterns of a run as they are reported. A run can end without its consumer finishing it (aborted
 * while queued, the time limit, a crash): the patterns that were still waiting or running then were not
 * run to their end, and take the run's verdict instead of staying `queued` / `running` for ever.
 */
export function settledPatterns(status: RunStatus, patterns: RunPattern[] | null): RunPattern[] | null {
  if (!patterns || status === 'queued' || status === 'running') return patterns
  return patterns.map((p) => (p.status === 'queued' || p.status === 'running' ? { ...p, status: status === 'aborted' ? 'aborted' : 'failed' } : p))
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

// ---- pasting and importing ----

/** A name for a new column that is not taken yet: COLUMN_1, COLUMN_2, ... */
export function freeColumnName(taken: string[]): string {
  for (let n = taken.length + 1; ; n++) if (!taken.includes(`COLUMN_${n}`)) return `COLUMN_${n}`
}

/**
 * Put a pasted block into the table with its top left cell at `at` (row -1 is the header: the column
 * names), growing the table as needed up to the limits. Pasted into the header, the first line names the
 * columns and the rest become rows, with one exception: a table that already has its columns named and
 * no rows yet is waiting for rows, so the block is rows (a first line that repeats the column names is
 * left out). `named`: the block's first line became column names; `rows`: how many of its lines are rows.
 */
export function pasteInto(table: DataTable, block: string[][], at: { r: number; c: number }): { table: DataTable; clipped: boolean; named: boolean; rows: number } {
  const columns = [...table.columns]
  const rows = table.rows.map((r) => [...r])
  let clipped = false
  const width = Math.max(...block.map((r) => r.length))
  const header = at.r < 0
  const awaitingRows = header && rows.length === 0 && columns.length > 0 && columns.every((c) => c.trim() !== '')
  const repeatsNames = awaitingRows && block[0].every((cell, i) => cell.trim() === (columns[at.c + i] ?? null))
  const named = header && !awaitingRows
  while (columns.length < at.c + width && columns.length < MAX_DATA_COLUMNS) {
    columns.push(freeColumnName(columns))
    for (const r of rows) r.push('')
  }
  if (at.c + width > columns.length) clipped = true
  const body = named || repeatsNames ? block.slice(1) : block
  const top = Math.max(0, at.r)
  while (rows.length < top + body.length && rows.length < MAX_DATA_ROWS) rows.push(columns.map(() => ''))
  if (top + body.length > rows.length) clipped = true
  if (named) block[0].forEach((name, i) => at.c + i < columns.length && (columns[at.c + i] = name.trim()))
  body.forEach((cells, i) => {
    const row = rows[top + i]
    if (row) cells.forEach((cell, j) => at.c + j < columns.length && (row[at.c + j] = cell))
  })
  return { table: { columns, rows }, clipped, named, rows: body.length }
}

/** The regional encoding a spreadsheet's plain "CSV" most likely has for someone who reads this language. */
const REGIONAL_ENCODINGS: [RegExp, string][] = [
  [/^zh-(tw|hk|mo|hant)/i, 'big5'],
  [/^zh/i, 'gb18030'],
  [/^ja/i, 'shift_jis'],
  [/^ko/i, 'euc-kr'],
]

/**
 * The text of an imported data file. UTF-8 (with or without a byte order mark) and UTF-16 with one are
 * read as what they are. Anything else is not UTF-8: it is read in the regional encoding that goes with
 * the user's languages when it is valid in that encoding (`guessed`, so the user can be told to check),
 * and not at all otherwise (null). It is never read as UTF-8 with the unreadable bytes replaced.
 */
export function decodeDataFile(bytes: Uint8Array, languages: readonly string[] = []): { text: string; encoding: string; guessed: boolean } | null {
  const strict = (encoding: string): string | null => {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(bytes)
    } catch {
      return null
    }
  }
  if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) {
    const encoding = bytes[0] === 0xff ? 'utf-16le' : 'utf-16be'
    const text = strict(encoding)
    return text === null ? null : { text, encoding: encoding.toUpperCase(), guessed: false }
  }
  const utf8 = strict('utf-8')
  if (utf8 !== null) return { text: utf8, encoding: 'UTF-8', guessed: false }
  const tried = new Set<string>()
  for (const language of languages) {
    const encoding = REGIONAL_ENCODINGS.find(([pattern]) => pattern.test(language))?.[1]
    if (!encoding || tried.has(encoding)) continue
    tried.add(encoding)
    const text = strict(encoding)
    if (text !== null) return { text, encoding: encoding === 'gb18030' ? 'GBK (GB 18030)' : encoding === 'shift_jis' ? 'Shift_JIS' : encoding === 'big5' ? 'Big5' : 'EUC-KR', guessed: true }
  }
  return null
}
