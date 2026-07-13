// ext_linegrid redraw state machine. Applies a batch of redraw events (as
// forwarded by main, one array per event: [name, ...tuples]) to the grid and
// reports which rows changed. Unknown events are ignored for forward
// compatibility. Only grid 1 exists (no ext_multigrid).

import type { Cell, DirtyState, GridState, ModeInfo } from './types'
import { defineHighlight } from './highlights'

const OUTER_GRID = 1

export function applyRedraw(state: GridState, events: unknown[]): DirtyState {
  const dirty: DirtyState = { all: false, rows: new Set(), flushed: false }
  for (const event of events) {
    if (!Array.isArray(event) || typeof event[0] !== 'string') continue
    const [name, ...batches] = event
    for (const batch of batches) {
      if (!Array.isArray(batch)) continue
      applyEvent(state, dirty, name, batch)
    }
    if (name === 'flush') dirty.flushed = true
  }
  return dirty
}

function applyEvent(state: GridState, dirty: DirtyState, name: string, args: unknown[]): void {
  switch (name) {
    case 'grid_resize':
      applyResize(state, dirty, args as [number, number, number])
      break
    case 'grid_line':
      applyLine(state, dirty, args)
      break
    case 'grid_scroll':
      applyScroll(state, dirty, args as number[])
      break
    case 'grid_clear':
      if (args[0] === OUTER_GRID) clearGrid(state, dirty)
      break
    case 'grid_cursor_goto':
      if (args[0] === OUTER_GRID) {
        state.cursor.row = args[1] as number
        state.cursor.col = args[2] as number
      }
      break
    case 'hl_attr_define':
      defineHighlight(state, args[0] as number, (args[1] ?? {}) as Record<string, unknown>)
      break
    case 'default_colors_set':
      applyDefaultColors(state, dirty, args as number[])
      break
    case 'mode_info_set':
      applyModeInfo(state, args)
      break
    case 'mode_change':
      state.modeName = String(args[0])
      state.modeIdx = (args[1] as number) ?? 0
      break
    case 'busy_start':
      state.cursor.visible = false
      break
    case 'busy_stop':
      state.cursor.visible = true
      break
    default:
      break
  }
}

function emptyRow(cols: number): Cell[] {
  const row: Cell[] = []
  for (let i = 0; i < cols; i += 1) row.push({ text: ' ', hlId: 0 })
  return row
}

function applyResize(state: GridState, dirty: DirtyState, args: [number, number, number]): void {
  const [grid, cols, rows] = args
  if (grid !== OUTER_GRID) return
  const next: Cell[][] = []
  for (let rowIdx = 0; rowIdx < rows; rowIdx += 1) {
    const existing = state.lines[rowIdx]
    const row = emptyRow(cols)
    if (existing) {
      const keep = Math.min(cols, existing.length)
      for (let colIdx = 0; colIdx < keep; colIdx += 1) row[colIdx] = existing[colIdx]
    }
    next.push(row)
  }
  state.cols = cols
  state.rows = rows
  state.lines = next
  dirty.all = true
}

// grid_line: [grid, row, colStart, cells, wrap] where cells are
// [text, hl_id?, repeat?]; hl_id carries over from the previous cell.
function applyLine(state: GridState, dirty: DirtyState, args: unknown[]): void {
  const [grid, row, colStart, cells] = args as [number, number, number, unknown[]]
  if (grid !== OUTER_GRID) return
  const line = state.lines[row]
  if (!line) return
  let col = colStart
  let hlId = 0
  for (const cell of cells) {
    if (!Array.isArray(cell)) continue
    const text = String(cell[0])
    if (cell.length > 1) hlId = cell[1] as number
    const repeat = cell.length > 2 ? (cell[2] as number) : 1
    for (let i = 0; i < repeat; i += 1) {
      if (col >= state.cols) break
      line[col] = { text, hlId }
      col += 1
    }
  }
  dirty.rows.add(row)
}

// grid_scroll: [grid, top, bot, left, right, rows, cols] — move the region
// up (rows > 0) or down (rows < 0). Vacated rows will be repainted by
// following grid_line events, but are marked dirty so stale content never
// survives a frame.
function applyScroll(state: GridState, dirty: DirtyState, args: number[]): void {
  const [grid, top, bot, left, right, rows] = args
  if (grid !== OUTER_GRID) return
  if (rows > 0) {
    for (let row = top; row < bot - rows; row += 1) {
      copyRowSpan(state, row + rows, row, left, right)
      dirty.rows.add(row)
    }
    for (let row = bot - rows; row < bot; row += 1) dirty.rows.add(row)
    return
  }
  for (let row = bot - 1; row >= top - rows; row -= 1) {
    copyRowSpan(state, row + rows, row, left, right)
    dirty.rows.add(row)
  }
  for (let row = top; row < top - rows; row += 1) dirty.rows.add(row)
}

function copyRowSpan(state: GridState, from: number, to: number, left: number, right: number): void {
  const source = state.lines[from]
  const target = state.lines[to]
  if (!source || !target) return
  for (let col = left; col < right; col += 1) {
    target[col] = source[col]
  }
}

function clearGrid(state: GridState, dirty: DirtyState): void {
  for (const row of state.lines) {
    for (let col = 0; col < row.length; col += 1) row[col] = { text: ' ', hlId: 0 }
  }
  dirty.all = true
}

function applyDefaultColors(state: GridState, dirty: DirtyState, args: number[]): void {
  const [fg, bg, sp] = args
  if (typeof fg === 'number' && fg >= 0) state.defaults.fg = fg
  if (typeof bg === 'number' && bg >= 0) state.defaults.bg = bg
  if (typeof sp === 'number' && sp >= 0) state.defaults.sp = sp
  dirty.all = true
}

// mode_info_set: [cursor_style_enabled, mode_info[]]
function applyModeInfo(state: GridState, args: unknown[]): void {
  const infos = args[1]
  if (!Array.isArray(infos)) return
  const modes: ModeInfo[] = []
  for (const info of infos) {
    const record = (info ?? {}) as Record<string, unknown>
    const shape = record.cursor_shape
    modes.push({
      name: String(record.name ?? ''),
      cursorShape: shape === 'horizontal' || shape === 'vertical' ? shape : 'block',
      cellPercentage: typeof record.cell_percentage === 'number' ? record.cell_percentage : 100,
      attrId: typeof record.attr_id === 'number' ? record.attr_id : 0
    })
  }
  state.modes = modes
}
