// Neovim ext_multigrid state router. Grid drawing remains in the small,
// independently tested grid reducer; this module owns window placement and
// routes each redraw tuple to the grid it belongs to.

import { applyRedraw } from './grid'
import { createGridState, type DirtyState, type GridState } from './types'

export interface NvimWindowPlacement {
  grid: number
  win: number
  kind: 'normal' | 'float' | 'external' | 'message'
  row: number
  col: number
  width: number
  height: number
  anchor?: string
  anchorGrid?: number
  focusable: boolean
  zindex: number
  compindex?: number
  screenRow?: number
  screenCol?: number
  hidden: boolean
}

export interface MultigridState {
  grids: Map<number, GridState>
  windows: Map<number, NvimWindowPlacement>
  primaryGrid: number | null
  cursorGrid: number
}

export interface MultigridDirty {
  grids: Map<number, DirtyState>
  placementsChanged: boolean
  flushed: boolean
}

export interface NvimWindowScreenPosition {
  row: number
  col: number
}

const GRID_EVENTS = new Set([
  'grid_resize',
  'grid_line',
  'grid_scroll',
  'grid_clear',
  'grid_cursor_goto'
])

const GLOBAL_EVENTS = new Set([
  'hl_attr_define',
  'default_colors_set',
  'mode_info_set',
  'mode_change',
  'busy_start',
  'busy_stop'
])

export function createMultigridState(): MultigridState {
  return {
    grids: new Map([[1, createGridState(1)]]),
    windows: new Map(),
    primaryGrid: null,
    cursorGrid: 1
  }
}

/**
 * Resolves a window's top-left position, including nested float anchors. Newer
 * nvim versions provide the final screen position directly; the recursive path
 * keeps the compositor correct for older protocol payloads.
 */
export function resolveNvimWindowPosition(
  windows: Iterable<NvimWindowPlacement>,
  target: NvimWindowPlacement
): NvimWindowScreenPosition {
  const byGrid = new Map([...windows].map((entry) => [entry.grid, entry]))

  function resolve(entry: NvimWindowPlacement, visited: Set<number>): NvimWindowScreenPosition {
    if (typeof entry.screenRow === 'number' && typeof entry.screenCol === 'number') {
      return { row: entry.screenRow, col: entry.screenCol }
    }

    let row = entry.row
    let col = entry.col
    const anchor = entry.anchorGrid === undefined ? undefined : byGrid.get(entry.anchorGrid)
    if (anchor && anchor.grid !== entry.grid && !visited.has(anchor.grid)) {
      visited.add(entry.grid)
      const origin = resolve(anchor, visited)
      row += origin.row
      col += origin.col
    }
    if (entry.anchor?.includes('S')) row -= entry.height
    if (entry.anchor?.includes('E')) col -= entry.width
    return { row, col }
  }

  return resolve(target, new Set())
}

export function applyMultigridRedraw(state: MultigridState, events: unknown[]): MultigridDirty {
  const result: MultigridDirty = {
    grids: new Map(),
    placementsChanged: false,
    flushed: false
  }
  for (const event of events) {
    if (!Array.isArray(event) || typeof event[0] !== 'string') continue
    const [name, ...batches] = event
    if (name === 'flush') {
      result.flushed = true
      continue
    }
    for (const args of batches) {
      if (!Array.isArray(args)) continue
      if (GRID_EVENTS.has(name)) {
        const id = args[0]
        if (typeof id !== 'number') continue
        const grid = ensureGrid(state, id)
        const oldCursor = { ...grid.cursor }
        const changed = applyRedraw(grid, [[name, args]])
        if (name === 'grid_cursor_goto') {
          state.cursorGrid = id
          changed.rows.add(oldCursor.row)
          changed.rows.add(grid.cursor.row)
        }
        mergeDirty(result.grids, id, changed)
        if (name === 'grid_resize') {
          const placement = state.windows.get(id)
          if (placement) {
            state.windows.set(id, { ...placement, width: grid.cols, height: grid.rows })
            result.placementsChanged = true
          }
        }
      } else if (GLOBAL_EVENTS.has(name)) {
        for (const [id, grid] of state.grids) {
          mergeDirty(result.grids, id, applyRedraw(grid, [[name, args]]))
        }
      } else if (applyPlacement(state, name, args)) {
        result.placementsChanged = true
      }
    }
  }
  return result
}

function ensureGrid(state: MultigridState, id: number): GridState {
  const found = state.grids.get(id)
  if (found) return found
  const source = state.grids.get(1)
  const grid = createGridState(id)
  if (source) {
    grid.hl = new Map(source.hl)
    grid.defaults = { ...source.defaults }
    grid.modes = source.modes.map((mode) => ({ ...mode }))
    grid.modeIdx = source.modeIdx
    grid.modeName = source.modeName
  }
  state.grids.set(id, grid)
  return grid
}

function mergeDirty(target: Map<number, DirtyState>, id: number, next: DirtyState): void {
  const current = target.get(id)
  if (!current) {
    target.set(id, next)
    return
  }
  current.all ||= next.all
  current.flushed ||= next.flushed
  for (const row of next.rows) current.rows.add(row)
}

function applyPlacement(state: MultigridState, name: string, args: unknown[]): boolean {
  if (name === 'win_pos') {
    const [grid, win, row, col, width, height] = args as number[]
    if (![grid, win, row, col, width, height].every((value) => typeof value === 'number')) {
      return false
    }
    state.windows.set(grid, {
      grid,
      win,
      kind: 'normal',
      row,
      col,
      width,
      height,
      focusable: true,
      zindex: 0,
      hidden: false
    })
    const primary = state.primaryGrid === null ? undefined : state.windows.get(state.primaryGrid)
    if (!primary || primary.hidden) state.primaryGrid = grid
    return true
  }
  if (name === 'win_float_pos') {
    const [
      grid,
      win,
      anchor,
      anchorGrid,
      row,
      col,
      focusable,
      zindex,
      compindex,
      screenRow,
      screenCol
    ] = args
    if (typeof grid !== 'number' || typeof win !== 'number') return false
    const current = state.grids.get(grid)
    state.windows.set(grid, {
      grid,
      win,
      kind: 'float',
      row: Number(row) || 0,
      col: Number(col) || 0,
      width: current?.cols ?? 0,
      height: current?.rows ?? 0,
      anchor: String(anchor ?? 'NW'),
      anchorGrid: typeof anchorGrid === 'number' ? anchorGrid : 1,
      focusable: focusable !== false,
      zindex: typeof zindex === 'number' ? zindex : 50,
      compindex: typeof compindex === 'number' ? compindex : undefined,
      screenRow: typeof screenRow === 'number' ? screenRow : undefined,
      screenCol: typeof screenCol === 'number' ? screenCol : undefined,
      hidden: false
    })
    return true
  }
  if (name === 'win_external_pos') {
    const [grid, win] = args
    if (typeof grid !== 'number' || typeof win !== 'number') return false
    const current = state.grids.get(grid)
    state.windows.set(grid, {
      grid,
      win,
      kind: 'external',
      row: 0,
      col: 0,
      width: current?.cols ?? 0,
      height: current?.rows ?? 0,
      focusable: true,
      zindex: 0,
      hidden: false
    })
    return true
  }
  if (name === 'msg_set_pos') {
    const [grid, row] = args
    if (typeof grid !== 'number' || typeof row !== 'number') return false
    // Grid zero is Neovim's sentinel for removing the externalized message
    // surface, not a drawable grid. Drop the previous message placement so a
    // later real msg grid (normally grid 3) becomes the compositor source.
    if (grid === 0) {
      let changed = false
      for (const [id, placement] of state.windows) {
        if (placement.kind !== 'message') continue
        state.windows.delete(id)
        changed = true
      }
      return changed
    }
    const current = state.grids.get(grid)
    state.windows.set(grid, {
      grid,
      win: 0,
      kind: 'message',
      row,
      col: 0,
      width: current?.cols ?? 0,
      height: 1,
      focusable: true,
      zindex: 200,
      hidden: false
    })
    return true
  }
  if (name === 'win_hide') {
    const grid = args[0]
    const placement = typeof grid === 'number' ? state.windows.get(grid) : undefined
    if (!placement) return false
    state.windows.set(grid as number, { ...placement, hidden: true })
    if (state.primaryGrid === grid) {
      state.primaryGrid =
        [...state.windows.values()].find(
          (entry) => entry.kind === 'normal' && !entry.hidden && entry.grid !== grid
        )?.grid ?? null
    }
    return true
  }
  if (name === 'win_close' || name === 'grid_destroy') {
    const grid = args[0]
    if (typeof grid !== 'number') return false
    const changed = state.windows.delete(grid)
    state.grids.delete(grid)
    if (state.primaryGrid === grid) {
      state.primaryGrid =
        [...state.windows.values()].find((entry) => entry.kind === 'normal')?.grid ?? null
    }
    return changed
  }
  return false
}
