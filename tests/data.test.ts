// The pure parts of data-driven tests: reading CSV / TSV, validating a data table, combining statuses,
// splitting a run's log by pattern, and which value a variable has in a pattern.
import { describe, expect, it } from 'vitest'
import {
  aggregateStatus,
  describeDataProblem,
  hasPatterns,
  logOfPattern,
  MAX_CELL_LENGTH,
  MAX_DATA_COLUMNS,
  MAX_DATA_ROWS,
  parseDelimited,
  parsePasted,
  patternLogHeading,
  patternSummary,
  rowValues,
  runVariables,
  splitLog,
  SUMMARY_LOG_HEADING,
  tableFromRows,
  validateDataTable,
} from '../shared/data'
import type { DataTable } from '../shared/types'

describe('parseDelimited', () => {
  it('reads plain CSV with LF, CRLF and CR line ends', () => {
    expect(parseDelimited('a,b\n1,2\n')).toEqual([['a', 'b'], ['1', '2']])
    expect(parseDelimited('a,b\r\n1,2\r\n')).toEqual([['a', 'b'], ['1', '2']])
    expect(parseDelimited('a,b\r1,2')).toEqual([['a', 'b'], ['1', '2']])
  })

  it('handles quotes: commas, line breaks and doubled quotes inside a quoted cell', () => {
    const text = 'NAME,NOTE\n"Doe, Jane","said ""hi""\nand left"\nplain,"" \n'
    expect(parseDelimited(text)).toEqual([
      ['NAME', 'NOTE'],
      ['Doe, Jane', 'said "hi"\nand left'],
      ['plain', ' '],
    ])
  })

  it('treats a quote in the middle of an unquoted cell as text', () => {
    expect(parseDelimited('5" nail,x')).toEqual([['5" nail', 'x']])
  })

  it('drops a byte order mark and blank lines, keeps empty cells', () => {
    expect(parseDelimited('﻿EMAIL,PASSWORD\n\na@x.test,\n,\n""\n')).toEqual([['EMAIL', 'PASSWORD'], ['a@x.test', ''], ['', ''], ['']])
    expect(parseDelimited('')).toEqual([])
    expect(parseDelimited('\n\n')).toEqual([])
  })

  it('reads tab separated text when the first line has a tab, commas then being ordinary text', () => {
    expect(parseDelimited('EMAIL\tNOTE\na@x.test\tone, two\n')).toEqual([['EMAIL', 'NOTE'], ['a@x.test', 'one, two']])
    // What a spreadsheet copies for a cell with a line break in it.
    expect(parseDelimited('A\tB\n"line 1\nline 2"\tx')).toEqual([['A', 'B'], ['line 1\nline 2', 'x']])
  })

  it('does not pad or cut rows', () => {
    expect(parseDelimited('a,b,c\n1\n1,2,3,4')).toEqual([['a', 'b', 'c'], ['1'], ['1', '2', '3', '4']])
  })
})

describe('parsePasted', () => {
  it('takes tabs as cell separators', () => {
    expect(parsePasted('a\tb\r\n1\t2\r\n')).toEqual([['a', 'b'], ['1', '2']])
  })
  it('takes commas as separators only when every line has the same number of cells', () => {
    expect(parsePasted('a,b\n1,2')).toEqual([['a', 'b'], ['1', '2']])
    expect(parsePasted('Hello, world\nplain')).toEqual([['Hello, world'], ['plain']])
    expect(parsePasted('one\ntwo')).toEqual([['one'], ['two']])
  })
})

describe('tableFromRows', () => {
  it('uses the first row as column names and squares the rest', () => {
    expect(tableFromRows([[' EMAIL ', 'PASSWORD'], ['a'], ['b', 'c', 'extra']])).toEqual({ columns: ['EMAIL', 'PASSWORD'], rows: [['a', ''], ['b', 'c']] })
    expect(tableFromRows([])).toEqual({ columns: [], rows: [] })
  })
})

describe('validateDataTable', () => {
  const ok: DataTable = { columns: ['EMAIL', 'PASSWORD'], rows: [['a', 'b']] }
  const messages = (t: DataTable) => validateDataTable(t).map((p) => describeDataProblem(t, p))

  it('accepts a sound table, and one without rows', () => {
    expect(validateDataTable(ok)).toEqual([])
    expect(validateDataTable({ columns: ['A'], rows: [] })).toEqual([])
    expect(validateDataTable({ columns: [], rows: [] })).toEqual([])
  })

  it('checks column names like project variables: syntax, length, built-ins, duplicates', () => {
    expect(messages({ columns: ['', '1ST', 'a-b', 'BASE_URL', 'DEVICE', 'X', 'X', 'Y'.repeat(61)], rows: [] })).toEqual([
      'column 1: Name this column',
      'column 1ST: Use letters, digits and _ only, not starting with a digit',
      'column a-b: Use letters, digits and _ only, not starting with a digit',
      'column BASE_URL: BASE_URL is a built-in variable; use another name',
      'column DEVICE: DEVICE is a built-in variable; use another name',
      'column X: There is already a column named X',
      `column ${'Y'.repeat(61)}: A column name can have at most 60 characters`,
    ])
  })

  it('enforces 20 columns, 50 rows and 2000 characters in a cell', () => {
    const columns = Array.from({ length: MAX_DATA_COLUMNS }, (_, i) => `C${i}`)
    const rows = Array.from({ length: MAX_DATA_ROWS }, () => columns.map(() => 'x'.repeat(MAX_CELL_LENGTH)))
    expect(validateDataTable({ columns, rows })).toEqual([])
    expect(messages({ columns: [...columns, 'ONE_MORE'], rows: [] })).toEqual(['A data table can have at most 20 columns'])
    expect(messages({ columns: ['A'], rows: Array.from({ length: 51 }, () => ['']) })).toEqual(['A data table can have at most 50 rows'])
    expect(messages({ columns: ['A', 'B'], rows: [['', ''], ['', 'x'.repeat(2001)]] })).toEqual(['row 2, column B: A cell can have at most 2000 characters'])
  })

  it('reports a row that does not have one cell per column, and rows without columns', () => {
    expect(messages({ columns: ['A', 'B'], rows: [['1']] })).toEqual(['row 1: Row 1 has 1 cells for 2 columns'])
    expect(messages({ columns: [], rows: [[]] })).toEqual(['Add a column before adding rows'])
  })
})

describe('patterns', () => {
  const table: DataTable = { columns: ['EMAIL', 'ROLE'], rows: [['a@x.test', 'admin'], ['b@x.test', '']] }

  it('a table makes runs data-driven only when it has columns and rows', () => {
    expect([hasPatterns(table), hasPatterns({ columns: ['A'], rows: [] }), hasPatterns({ columns: [], rows: [] }), hasPatterns(null)]).toEqual([true, false, false, false])
  })

  it('reads a row by its 1-based number', () => {
    expect(rowValues(table, 2)).toEqual({ EMAIL: 'b@x.test', ROLE: '' })
  })

  it('a column wins over a project variable of the same name; other project variables stay', () => {
    expect(runVariables({ EMAIL: 'project@x.test', TOKEN: 't' }, rowValues(table, 1))).toEqual({ EMAIL: 'a@x.test', TOKEN: 't', ROLE: 'admin' })
    expect(runVariables({ EMAIL: 'project@x.test' }, null)).toEqual({ EMAIL: 'project@x.test' })
  })

  it('combines pattern statuses: aborted, then failed, then unresolved, then succeeded', () => {
    expect(aggregateStatus(['succeeded', 'succeeded'])).toBe('succeeded')
    expect(aggregateStatus(['succeeded', 'unresolved', 'succeeded'])).toBe('unresolved')
    expect(aggregateStatus(['unresolved', 'failed', 'succeeded'])).toBe('failed')
    expect(aggregateStatus(['failed', 'aborted', 'aborted'])).toBe('aborted')
    expect(aggregateStatus(['succeeded', 'running', 'queued'])).toBe('running')
  })

  it('summarises a run in one line', () => {
    const p = (status: 'succeeded' | 'failed' | 'unresolved') => ({ index: 1, values: {}, status, startedAt: null, finishedAt: null })
    expect(patternSummary([p('succeeded'), p('failed'), p('succeeded')])).toBe('2 of 3 patterns passed')
    expect(patternSummary([p('unresolved'), p('succeeded'), p('unresolved')])).toBe('1 of 3 patterns passed, 2 need review')
    expect(patternSummary([p('succeeded')])).toBe('1 of 1 pattern passed')
  })
})

describe('the log of a data-driven run', () => {
  const log = ['Run r1', 'Started: now', patternLogHeading(1), '[1] navigate', 'Finished: succeeded', patternLogHeading(2), '[1] navigate', '[2] ERROR: no', SUMMARY_LOG_HEADING, 'Pattern 1: succeeded', 'Pattern 2: failed', 'Repair approved.'].join('\n')

  it('splits into the header, one section per pattern and the summary with what was appended after it', () => {
    const parts = splitLog(log)
    expect(parts.header).toBe('Run r1\nStarted: now')
    expect([...parts.patterns.keys()]).toEqual([1, 2])
    expect(parts.patterns.get(2)).toBe('=== Pattern 2 ===\n[1] navigate\n[2] ERROR: no')
    expect(parts.footer).toBe('=== Summary ===\nPattern 1: succeeded\nPattern 2: failed\nRepair approved.')
  })

  it('shows one pattern between the header and the summary', () => {
    expect(logOfPattern(log, 1)).toBe(['Run r1', 'Started: now', '=== Pattern 1 ===', '[1] navigate', 'Finished: succeeded', '=== Summary ===', 'Pattern 1: succeeded', 'Pattern 2: failed', 'Repair approved.'].join('\n'))
    // A pattern that has not started yet has no section.
    expect(logOfPattern('Run r1\n=== Pattern 1 ===\n[1] x', 2)).toBe('Run r1')
  })

  it('leaves the log of a run without patterns in the header', () => {
    expect(splitLog('a\nb')).toEqual({ header: 'a\nb', patterns: new Map(), footer: '' })
  })
})
