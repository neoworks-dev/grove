// Shared types for the embedded Neovim ext_linegrid UI. Rune-free plain TS
// so the grid state machine and helpers are bun-testable.

export interface Cell {
  text: string // '' = right half of a double-width char
  hlId: number
}

export interface HlAttrs {
  foreground?: number
  background?: number
  special?: number
  reverse?: boolean
  bold?: boolean
  italic?: boolean
  underline?: boolean
  undercurl?: boolean
  strikethrough?: boolean
}

export interface ResolvedColors {
  fg: string
  bg: string
  sp: string
}

export interface ModeInfo {
  name: string
  cursorShape: 'block' | 'horizontal' | 'vertical'
  cellPercentage: number
  attrId: number
}

export interface GridState {
  cols: number
  rows: number
  lines: Cell[][]
  hl: Map<number, HlAttrs>
  defaults: { fg: number; bg: number; sp: number }
  cursor: { row: number; col: number; visible: boolean }
  modes: ModeInfo[]
  modeIdx: number
  modeName: string
}

export interface DirtyState {
  all: boolean
  rows: Set<number>
  flushed: boolean
}

export function createGridState(): GridState {
  return {
    cols: 0,
    rows: 0,
    lines: [],
    hl: new Map(),
    defaults: { fg: 0xffffff, bg: 0x000000, sp: 0xff0000 },
    cursor: { row: 0, col: 0, visible: true },
    modes: [],
    modeIdx: 0,
    modeName: 'normal'
  }
}
