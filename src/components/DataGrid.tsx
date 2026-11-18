// The data table of a data-driven test case: a small spreadsheet of named columns and string cells.
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Upload, X } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  describeDataProblem,
  MAX_CELL_LENGTH,
  MAX_DATA_BYTES,
  MAX_DATA_COLUMNS,
  MAX_DATA_ROWS,
  decodeDataFile,
  parseDelimited,
  parsePasted,
  pasteInto,
  freeColumnName as freeName,
  tableFromRows,
  validateDataTable,
} from '../../shared/data'
import type { DataTable, TestCase } from '../../shared/types'
import { api, qk } from '../api'
import { cx, plural } from '../lib/format'
import { isComposing } from '../lib/hooks'
import { Button, Confirm, IconButton, toast } from './ui'

export const EMPTY_TABLE: DataTable = { columns: [], rows: [] }

/** Row -1 is the header (the column names). */
interface Cell {
  r: number
  c: number
}

const LIMITS_NOTE = `Up to ${MAX_DATA_COLUMNS} columns, ${MAX_DATA_ROWS} rows, ${MAX_CELL_LENGTH} characters in a cell and ${MAX_DATA_BYTES / 1024} KB in total.`

/** Not a cell: the box shown in place of the grid while the table has no column. */
const EMPTY_BOX: Cell = { r: -2, c: 0 }

export function DataGrid({ value, onChange, disabled }: { value: DataTable; onChange: (next: DataTable) => void; disabled?: boolean }) {
  const id = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  // The cell to focus once the table has re-rendered (after a row or column was added or removed).
  const [focus, setFocus] = useState<Cell | null>(null)
  const [status, setStatus] = useState('')
  const [pendingImport, setPendingImport] = useState<{ table: DataTable; note: string } | null>(null)
  const problems = useMemo(() => validateDataTable(value), [value])
  // The first problem of each cell (or column name, row 'h'), as its index in `problems`.
  const byCell = useMemo(() => {
    const map = new Map<string, number>()
    problems.forEach((p, i) => {
      const key = `${p.row ?? 'h'}:${p.column}`
      if (p.column !== undefined && !map.has(key)) map.set(key, i)
    })
    return map
  }, [problems])
  const problemId = (i: number) => `${id}-problem-${i}`

  useEffect(() => {
    if (!focus) return
    const root = rootRef.current
    if (focus.r === EMPTY_BOX.r) root?.querySelector<HTMLElement>('.data-empty')?.focus()
    else root?.querySelector<HTMLInputElement>(`input[data-r="${focus.r}"][data-c="${focus.c}"]`)?.focus()
    setFocus(null)
  }, [focus])

  const say = (text: string) => setStatus((prev) => (prev === text ? `${text} ` : text))
  const empty = value.columns.length === 0

  const addColumn = () => {
    if (value.columns.length >= MAX_DATA_COLUMNS) return
    onChange({ columns: [...value.columns, freeName(value.columns)], rows: value.rows.map((r) => [...r, '']) })
    setFocus({ r: -1, c: value.columns.length })
  }
  const addRow = () => {
    if (value.rows.length >= MAX_DATA_ROWS || empty) return
    onChange({ columns: value.columns, rows: [...value.rows, value.columns.map(() => '')] })
    setFocus({ r: value.rows.length, c: 0 })
  }
  const removeColumn = (c: number) => {
    const columns = value.columns.filter((_, i) => i !== c)
    // Without columns there is no table: its rows go with the last column.
    onChange(columns.length ? { columns, rows: value.rows.map((r) => r.filter((_, i) => i !== c)) } : EMPTY_TABLE)
    say(`Column ${value.columns[c] || c + 1} removed`)
    // The grid goes with its last column; the box that replaces it takes the focus the removed button had.
    setFocus(columns.length ? { r: -1, c: Math.min(c, columns.length - 1) } : EMPTY_BOX)
  }
  const removeRow = (r: number) => {
    const rows = value.rows.filter((_, i) => i !== r)
    onChange({ columns: value.columns, rows })
    say(`Row ${r + 1} removed`)
    setFocus(rows.length ? { r: Math.min(r, rows.length - 1), c: 0 } : { r: -1, c: 0 })
  }
  const setName = (c: number, name: string) => onChange({ columns: value.columns.map((x, i) => (i === c ? name : x)), rows: value.rows })
  const setCell = (r: number, c: number, text: string) => onChange({ columns: value.columns, rows: value.rows.map((row, i) => (i === r ? row.map((x, j) => (j === c ? text : x)) : row)) })

  const onPaste = (e: React.ClipboardEvent, cell: Cell) => {
    const text = e.clipboardData.getData('text/plain')
    // A single value is an ordinary paste into the field.
    if (!/[\t\r\n]/.test(text.replace(/[\r\n]+$/, ''))) return
    e.preventDefault()
    const block = parsePasted(text)
    if (block.length === 0) return
    const { table, clipped, named, rows: pastedRows } = pasteInto(value, block, cell)
    onChange(table)
    const width = plural(Math.max(...block.map((r) => r.length)), 'cell')
    const note = `Pasted ${named ? `the column names and ${plural(pastedRows, 'row')}` : plural(pastedRows, 'row')} of ${width}${clipped ? `. Some of it did not fit: ${LIMITS_NOTE}` : ''}`
    say(note)
    // Nothing on screen shows that part of the block was dropped, so that is said visibly too.
    if (clipped) toast(note)
  }

  // Up, Down and Enter move between rows as in a spreadsheet; Tab moves between cells as in any form.
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, cell: Cell) => {
    if (isComposing(e) || e.altKey || e.metaKey || e.ctrlKey) return
    const down = e.key === 'ArrowDown' || (e.key === 'Enter' && !e.shiftKey)
    const up = e.key === 'ArrowUp' || (e.key === 'Enter' && e.shiftKey)
    if (!down && !up) return
    e.preventDefault()
    const r = cell.r + (down ? 1 : -1)
    if (r < -1) return
    if (r >= value.rows.length) {
      // Enter on the last row starts the next one.
      if (e.key === 'Enter' && value.rows.length < MAX_DATA_ROWS) {
        onChange({ columns: value.columns, rows: [...value.rows, value.columns.map(() => '')] })
        setFocus({ r, c: cell.c })
      }
      return
    }
    setFocus({ r, c: cell.c })
  }

  const importFile = async (file: File) => {
    let bytes: Uint8Array
    try {
      bytes = new Uint8Array(await file.arrayBuffer())
    } catch {
      return toast(`Could not read ${file.name}`, 'error')
    }
    // A spreadsheet's plain "CSV" is in the computer's regional encoding, not UTF-8: read as UTF-8 its
    // Chinese or Japanese cells would come out as replacement characters without anyone being told.
    const decoded = decodeDataFile(bytes, [...navigator.languages])
    if (!decoded) return toast(`${file.name} is not UTF-8 text, so its cells cannot be read reliably. Save it as “CSV UTF-8” in your spreadsheet and import it again.`, 'error')
    const parsed = parseDelimited(decoded.text)
    if (parsed.length === 0) return toast(`${file.name} is empty`, 'error')
    const full = tableFromRows(parsed)
    const table: DataTable = { columns: full.columns.slice(0, MAX_DATA_COLUMNS), rows: full.rows.slice(0, MAX_DATA_ROWS).map((r) => r.slice(0, MAX_DATA_COLUMNS)) }
    const cut = full.columns.length > table.columns.length || full.rows.length > table.rows.length
    const guessed = decoded.guessed ? `. The file is not UTF-8, so it was read as ${decoded.encoding}: check that the cells look right, or save it as “CSV UTF-8” and import it again` : ''
    const note = `Imported ${plural(table.columns.length, 'column')} and ${plural(table.rows.length, 'row')} from ${file.name}${guessed}${cut ? `. The file has more (${full.columns.length} columns, ${full.rows.length} rows): ${LIMITS_NOTE}` : ''}`
    if (empty) {
      onChange(table)
      say(note)
      toast(note)
    } else setPendingImport({ table, note })
  }

  const cellProps = (cell: Cell) => {
    const problem = byCell.get(`${cell.r < 0 ? 'h' : cell.r}:${cell.c}`)
    return {
      'data-r': cell.r,
      'data-c': cell.c,
      disabled,
      'aria-invalid': problem !== undefined || undefined,
      'aria-describedby': problem !== undefined ? problemId(problem) : undefined,
      title: problem !== undefined ? problems[problem].message : undefined,
      onPaste: (e: React.ClipboardEvent) => onPaste(e, cell),
      onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => onKeyDown(e, cell),
    }
  }

  return (
    <div className="data" ref={rootRef}>
      <div className="data-bar">
        <Button size="sm" icon={<Plus size={14} />} disabled={disabled || value.columns.length >= MAX_DATA_COLUMNS} onClick={addColumn}>
          Add column
        </Button>
        <Button size="sm" icon={<Plus size={14} />} disabled={disabled || empty || value.rows.length >= MAX_DATA_ROWS} onClick={addRow}>
          Add row
        </Button>
        <Button size="sm" icon={<Upload size={14} />} disabled={disabled} onClick={() => fileRef.current?.click()}>
          Import CSV
        </Button>
        <input
          ref={fileRef}
          type="file"
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          accept=".csv,.tsv,text/csv,text/tab-separated-values,text/plain"
          onChange={(e) => {
            const file = e.target.files?.[0]
            // The same file can be chosen again.
            e.target.value = ''
            if (file) void importFile(file)
          }}
        />
        {!empty && (
          <span className="muted data-count num">
            {plural(value.columns.length, 'column')}, {plural(value.rows.length, 'row')}
          </span>
        )}
      </div>

      {empty ? (
        // Something to focus, so a block copied from a spreadsheet can be pasted before there is any cell.
        <div className="data-empty" tabIndex={disabled ? -1 : 0} role="group" aria-label="Data table, empty. Paste a table here, add a column or import a CSV file." onPaste={(e) => onPaste(e, { r: -1, c: 0 })}>
          <p>
            <strong>No data.</strong> The test case runs once.
          </p>
          <p className="muted">
            Add a column, import a CSV file, or click here and paste cells copied from a spreadsheet (the first row names the columns). Each row is then one
            run of the steps, and a step reads a cell as <code>{'${COLUMN}'}</code>. Pasted text without tabs is split at commas when it has several lines
            with the same number of cells; a single line goes into one cell.
          </p>
        </div>
      ) : (
        <div className="data-scroll" role="region" aria-label="Data table" tabIndex={-1}>
          <table className="data-grid">
            <thead>
              <tr>
                <th scope="col" className="data-n">
                  <span className="sr-only">Row</span>
                </th>
                {value.columns.map((name, c) => (
                  <th scope="col" key={c}>
                    <span className="data-head">
                      <input
                        className="input mono"
                        aria-label={`Name of column ${c + 1}`}
                        placeholder="NAME"
                        value={name}
                        spellCheck={false}
                        autoCapitalize="none"
                        autoCorrect="off"
                        onChange={(e) => setName(c, e.target.value)}
                        {...cellProps({ r: -1, c })}
                      />
                      <IconButton label={`Remove column ${name || c + 1}`} disabled={disabled} onClick={() => removeColumn(c)}>
                        <X size={15} />
                      </IconButton>
                    </span>
                  </th>
                ))}
                <th className="data-end" />
              </tr>
            </thead>
            <tbody>
              {value.rows.map((row, r) => (
                <tr key={r}>
                  <th scope="row" className="data-n num">
                    {r + 1}
                  </th>
                  {value.columns.map((name, c) => (
                    <td key={c}>
                      <input className="input" aria-label={`Row ${r + 1}, ${name || `column ${c + 1}`}`} value={row[c] ?? ''} onChange={(e) => setCell(r, c, e.target.value)} {...cellProps({ r, c })} />
                    </td>
                  ))}
                  <td className="data-end">
                    <IconButton label={`Remove row ${r + 1}`} disabled={disabled} onClick={() => removeRow(r)}>
                      <X size={15} />
                    </IconButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {value.rows.length === 0 && <p className="muted data-norows">No rows yet: the test case runs once, without these columns. Add a row, or paste rows copied from a spreadsheet into a column name.</p>}
        </div>
      )}

      {problems.length > 0 && (
        <ul className={cx('form-error', 'data-problems')}>
          {problems.slice(0, 5).map((p, i) => (
            <li key={i} id={problemId(i)}>
              {describeDataProblem(value, p)}
            </li>
          ))}
          {problems.length > 5 && <li>and {problems.length - 5} more</li>}
        </ul>
      )}
      <span className="sr-only" role="status">
        {status}
      </span>

      {pendingImport && (
        <Confirm
          title="Replace the data?"
          confirmLabel="Replace"
          onClose={() => setPendingImport(null)}
          onConfirm={() => {
            onChange(pendingImport.table)
            say(pendingImport.note)
            toast(pendingImport.note)
            setPendingImport(null)
          }}
        >
          The file replaces the {plural(value.columns.length, 'column')} and {plural(value.rows.length, 'row')} that are here now. Nothing is saved until you
          save the data.
        </Confirm>
      )}
    </div>
  )
}

const same = (a: DataTable, b: DataTable) => JSON.stringify(a) === JSON.stringify(b)

// Unsaved drafts by test case id, with the saved table each started from. A draft outlives the component
// that edits it, so a stray click on a link (or going from the test case page to the editor and back) does
// not throw away a table that is saved explicitly; leaving the app is guarded by `beforeunload` below.
const drafts = new Map<string, { base: DataTable; draft: DataTable }>()

/** The data table of a test case as a draft that is saved explicitly, for the test case page and the editor. */
export function useDataDraft(testCase: TestCase) {
  const qc = useQueryClient()
  const saved = testCase.data ?? EMPTY_TABLE
  const [draft, setLocal] = useState<DataTable>(() => {
    const kept = drafts.get(testCase.id)
    return kept && same(kept.base, saved) ? kept.draft : saved
  })
  // What the draft started from: when the saved table changes under it (a save, another tab), start again from that.
  const [base, setBase] = useState(saved)
  const setDraft = (next: DataTable) => {
    if (same(next, saved)) drafts.delete(testCase.id)
    else drafts.set(testCase.id, { base: saved, draft: next })
    setLocal(next)
  }
  if (!same(base, saved)) {
    setBase(saved)
    setDraft(saved)
  }
  const dirty = !same(draft, saved)
  // A reload or closing the tab would lose the draft: ask first, as the editor does for unsaved steps.
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])
  const problems = useMemo(() => validateDataTable(draft), [draft])
  const save = useMutation({
    mutationFn: () => api.updateTestCase(testCase.id, { data: draft.columns.length ? draft : null }),
    onSuccess: (next) => {
      qc.setQueryData(qk.testCase(next.id), next)
      void qc.invalidateQueries({ queryKey: qk.testCases(next.projectId) })
      toast(next.data ? `Data saved: ${plural(next.data.rows.length, 'row')}` : 'Data removed')
    },
  })
  return { draft, setDraft, dirty, problems, save, discard: () => setDraft(saved) }
}
