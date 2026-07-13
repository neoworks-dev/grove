// Embedded-Neovim canvas session controller. Owns one `nvim --embed` session:
// the msgpack redraw stream, the canvas grid renderer, resize fitting, and
// keyboard/mouse/wheel forwarding. Bound to caller-provided DOM elements so a
// component only supplies markup and pane-specific effects (tab follow, diff
// build, …) through the callbacks below.
//
// If nvim exits unexpectedly (a crash, not a dispose), the session respawns in
// place a bounded number of times and re-runs onAttached, so a pane recovers
// instead of vanishing. Repeated failures within a short window are treated as
// fatal and handed to onFatal.

import { keymap } from '../keymap.svelte'
import { store } from '../store.svelte'
import { createGridState } from './types'
import { applyRedraw } from './grid'
import { encodeKeyEvent } from './keys'
import { measureCell, type CellMetrics, type FontSpec } from './metrics'
import { CanvasGridRenderer } from './canvasRenderer'
import type { GridRenderer } from './renderer'

export interface NvimSessionElements {
  host: HTMLDivElement
  canvas: HTMLCanvasElement
  input: HTMLDivElement
}

export interface NvimSessionCallbacks {
  // nvim attached and its id is live. Runs after the initial file (if any) is
  // loaded, on the first connect AND after every automatic restart — the place
  // to (re)build a diff split or re-open the active file.
  onAttached?: (id: string) => void | Promise<void>
  // A redraw batch was flushed to the canvas (drives minimap re-reads).
  onFlush?: () => void
  // The editor mode changed (grove-mapped name, e.g. 'normal' → 'operator').
  // Fires only on an actual transition, not on every redraw.
  onModeChange?: (mode: string) => void
  // nvim crashed (non-zero exit) and a restart is being attempted.
  // Informational — for logging/telemetry.
  onExited?: (exitCode: number) => void
  // The pane should close: either a clean `:q`/`:qa` (exit 0) or crash restarts
  // were exhausted.
  onClose?: () => void
  // Spawn failed — the runtime is missing. The component shows a hint.
  onUnavailable?: () => void
}

export interface NvimSessionConfig {
  leafId: string
  font: FontSpec
  // File to `:edit` on attach, or null to attach with an empty buffer (the
  // diff pane builds its own scratch buffers instead). A function is re-read on
  // each restart so the reconnected session opens the currently active file.
  initialFile?: string | null | (() => string | null)
}

const MOUSE_BUTTONS = ['left', 'middle', 'right']

// Tint the given 1-based line ranges as additions in the live buffer, replacing
// any previous inline-review highlight. Used by the accept/reject overlay.
const INLINE_PAINT_LUA = `
local ranges = ...
local ns = vim.api.nvim_create_namespace('grove_inline')
local buf = vim.api.nvim_get_current_buf()
vim.api.nvim_buf_clear_namespace(buf, ns, 0, -1)
local total = vim.api.nvim_buf_line_count(buf)
for _, r in ipairs(ranges) do
  local startLine = r.start - 1
  for line = startLine, startLine + r.count - 1 do
    if line >= 0 and line < total then
      vim.api.nvim_buf_set_extmark(buf, ns, line, 0, { line_hl_group = 'DiffAdd' })
    end
  end
end
`

const INLINE_CLEAR_LUA = `
local ns = vim.api.nvim_create_namespace('grove_inline')
vim.api.nvim_buf_clear_namespace(vim.api.nvim_get_current_buf(), ns, 0, -1)
`

// Resolve the buffer path and the selected line range. While in a visual mode
// it reads the live selection (`v` = anchor, `.` = cursor); otherwise it falls
// back to the last visual marks (`'<`/`'>`), so the range survives leaving
// visual — the path taken by the normal-mode inline-edit binding. A byte check
// (22 = Ctrl-V) covers visual-block without embedding a control char here.
const SELECTION_LUA = `
local mode = vim.fn.mode()
local first = mode:sub(1, 1)
local visual = first == 'v' or first == 'V' or mode:byte(1) == 22
local sp, ep
if visual then
  sp = vim.fn.getpos('v')
  ep = vim.fn.getpos('.')
else
  sp = vim.fn.getpos("'<")
  ep = vim.fn.getpos("'>")
end
local startLine, endLine = sp[2], ep[2]
if startLine == 0 or endLine == 0 then
  local cur = vim.api.nvim_win_get_cursor(0)
  startLine, endLine = cur[1], cur[1]
end
if startLine > endLine then startLine, endLine = endLine, startLine end
return { path = vim.api.nvim_buf_get_name(0), startLine = startLine, endLine = endLine }
`
// A pane that dies more than this many times inside the window is fatal — most
// likely a config/runtime fault a respawn won't fix.
const MAX_RESTARTS = 3
const RESTART_WINDOW_MS = 10_000
const RESTART_DELAY_MS = 150

export class NvimCanvasSession {
  private readonly elements: NvimSessionElements
  private readonly callbacks: NvimSessionCallbacks
  private readonly config: NvimSessionConfig

  private nvimId: string | null = null
  private destroyed = false
  private started = false
  private leafEl: HTMLElement | null = null
  private stopRedraw: (() => void) | null = null
  private stopExit: (() => void) | null = null
  private observer: ResizeObserver | null = null
  private renderer: GridRenderer | null = null
  private metrics: CellMetrics | null = null

  private grid = createGridState()
  private renderScheduled = false
  private pendingDirtyRows = new Set<number>()
  private pendingDirtyAll = false
  private composing = false
  private lastCursorRow = 0
  private lastMode = 'normal'

  private fitScheduled = false
  private lastWidth = 0
  private lastHeight = 0

  private dragButton: string | null = null
  private lastDragRow = -1
  private lastDragCol = -1

  // Restart bookkeeping: count failures inside a sliding window.
  private restartCount = 0
  private windowStart = 0

  constructor(
    elements: NvimSessionElements,
    config: NvimSessionConfig,
    callbacks: NvimSessionCallbacks = {}
  ) {
    this.elements = elements
    this.config = config
    this.callbacks = callbacks
  }

  get id(): string | null {
    return this.nvimId
  }

  get leafId(): string {
    return this.config.leafId
  }

  get cellHeight(): number {
    return this.metrics?.cellHeight ?? 0
  }

  // The 1-based buffer line at the top of the viewport (`line('w0')`), for
  // placing overlays by screen row. Null when no session is live.
  async viewportTop(): Promise<number | null> {
    const id = this.nvimId
    if (!id) return null
    try {
      const top = await window.workbench.nvim.request(id, 'nvim_exec_lua', [
        "return vim.fn.line('w0')",
        []
      ])
      return typeof top === 'number' ? top : null
    } catch {
      return null
    }
  }

  // Tint the given 1-based line ranges as an inline-review highlight.
  async paintInlineReview(ranges: { start: number; count: number }[]): Promise<void> {
    const id = this.nvimId
    if (!id) return
    try {
      await window.workbench.nvim.request(id, 'nvim_exec_lua', [INLINE_PAINT_LUA, [ranges]])
    } catch {
      // session gone
    }
  }

  async clearInlineReview(): Promise<void> {
    const id = this.nvimId
    if (!id) return
    try {
      await window.workbench.nvim.request(id, 'nvim_exec_lua', [INLINE_CLEAR_LUA, []])
    } catch {
      // session gone
    }
  }

  // Reload the current buffer from disk (`:edit!`), discarding in-memory edits —
  // used after an inline-review reject rewrites the file underneath it.
  async reloadBuffer(): Promise<void> {
    const id = this.nvimId
    if (!id) return
    try {
      await window.workbench.nvim.request(id, 'nvim_cmd', [{ cmd: 'edit', bang: true }, {}])
    } catch {
      // session gone
    }
  }

  // Where to place the inline-edit prompt for a selection. Anchors it at the
  // selection's first row when the selection is visible and fits the viewport;
  // otherwise (scrolled off-screen or taller than the page) asks to be centered.
  async promptPlacement(
    startLine: number,
    endLine: number
  ): Promise<{ centered: boolean; y: number }> {
    const id = this.nvimId
    if (!id || !this.metrics) return { centered: true, y: 0 }
    try {
      const view = await window.workbench.nvim.request(id, 'nvim_exec_lua', [
        "return { top = vim.fn.line('w0'), bottom = vim.fn.line('w$') }",
        []
      ])
      const range = view as { top?: number; bottom?: number }
      if (typeof range.top !== 'number' || typeof range.bottom !== 'number') {
        return { centered: true, y: 0 }
      }
      const visibleRows = range.bottom - range.top + 1
      const selectionRows = endLine - startLine + 1
      const onPage = startLine >= range.top && startLine <= range.bottom
      const fits = selectionRows <= visibleRows
      if (!onPage || !fits) return { centered: true, y: 0 }
      return { centered: false, y: (startLine - range.top) * this.metrics.cellHeight }
    } catch {
      return { centered: true, y: 0 }
    }
  }

  focus(): void {
    this.elements.input.focus()
  }

  // The current editor selection (buffer path + 1-based inclusive line range).
  // Returns null when no session is live or the buffer is unnamed (scratch).
  async getVisualSelection(): Promise<{
    path: string
    startLine: number
    endLine: number
  } | null> {
    const id = this.nvimId
    if (!id) return null
    try {
      const result = await window.workbench.nvim.request(id, 'nvim_exec_lua', [SELECTION_LUA, []])
      if (!result || typeof result !== 'object') return null
      const selection = result as { path?: string; startLine?: number; endLine?: number }
      if (!selection.path || !selection.startLine || !selection.endLine) return null
      return {
        path: selection.path,
        startLine: selection.startLine,
        endLine: selection.endLine
      }
    } catch {
      return null
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  // One-time setup (renderer, metrics, DOM listeners, resize observer) followed
  // by the first connect. Restarts skip setup and only reconnect.
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    const { host, canvas, input } = this.elements
    await document.fonts.ready
    if (this.destroyed) return
    this.metrics = measureCell(this.config.font)
    this.renderer = new CanvasGridRenderer()
    this.renderer.attach(canvas)
    this.renderer.setFont(this.config.font, this.metrics)

    const { cols, rows } = this.gridSize()
    this.renderer.resize(cols, rows, window.devicePixelRatio)
    this.lastWidth = host.clientWidth
    this.lastHeight = host.clientHeight

    this.observer = new ResizeObserver(() => this.scheduleFit())
    this.observer.observe(host)
    this.leafEl = (host.closest('[data-leaf]') as HTMLElement | null) ?? null
    this.leafEl?.addEventListener('focusin', this.onLeafFocus)
    host.addEventListener('mousedown', this.onMouseDown)
    host.addEventListener('wheel', this.onWheel, { passive: false })
    input.addEventListener('keydown', this.onKeydown)
    input.addEventListener('compositionstart', this.onComposition)
    input.addEventListener('compositionend', this.onComposition)
    input.addEventListener('focus', this.onInputFocus)

    await this.connect()
  }

  // Spawn nvim, wire the redraw/exit stream, attach the UI, and run onAttached.
  // Reused verbatim for the initial start and every restart.
  private async connect(): Promise<void> {
    if (this.destroyed || !this.renderer) return
    let spawnedId: string
    try {
      spawnedId = await window.workbench.nvim.spawn(store.selectedWorktreeId)
    } catch {
      this.callbacks.onUnavailable?.()
      return
    }
    if (this.destroyed) {
      void window.workbench.nvim.kill(spawnedId)
      return
    }
    this.nvimId = spawnedId

    // Subscribe before attaching: nvim emits its first redraw batch on
    // ui_attach and Electron drops events that have no listener, so the
    // subscription must exist first or the canvas stays blank until a resize.
    this.stopRedraw?.()
    this.stopExit?.()
    this.stopRedraw = window.workbench.on('event:nvim-redraw', (payload) => {
      const event = payload as { id: string; events: unknown[] }
      if (event.id === this.nvimId) this.handleRedraw(event.events)
    })
    this.stopExit = window.workbench.on('event:nvim-exit', (payload) => {
      const event = payload as { id: string; exitCode?: number }
      if (event.id !== this.nvimId) return
      this.nvimId = null
      if (this.destroyed) return
      this.handleUnexpectedExit(event.exitCode ?? 0)
    })

    const { cols, rows } = this.gridSize()
    // A fresh session repaints the whole grid on attach.
    this.pendingDirtyAll = true
    await window.workbench.nvim.attach(this.nvimId, cols, rows, this.resolveInitialFile() ?? undefined)
    void this.pushTheme()
    await this.callbacks.onAttached?.(this.nvimId)
    this.elements.input.focus()
  }

  private resolveInitialFile(): string | null {
    const initial = this.config.initialFile
    if (typeof initial === 'function') return initial()
    return initial ?? null
  }

  // nvim exited on its own. A clean exit (0) is the user quitting (:q / :qa) —
  // close the pane. A crash respawns, unless we've failed too often lately.
  private handleUnexpectedExit(exitCode: number): void {
    if (exitCode === 0) {
      this.callbacks.onClose?.()
      return
    }
    this.callbacks.onExited?.(exitCode)
    const now = performance.now()
    if (now - this.windowStart > RESTART_WINDOW_MS) {
      this.windowStart = now
      this.restartCount = 0
    }
    this.restartCount += 1
    if (this.restartCount > MAX_RESTARTS) {
      this.callbacks.onClose?.()
      return
    }
    setTimeout(() => {
      if (!this.destroyed) void this.connect()
    }, RESTART_DELAY_MS)
  }

  dispose(): void {
    this.destroyed = true
    const { host, input } = this.elements
    window.removeEventListener('mousemove', this.onMouseMove)
    window.removeEventListener('mouseup', this.onMouseUp)
    this.leafEl?.removeEventListener('focusin', this.onLeafFocus)
    host.removeEventListener('mousedown', this.onMouseDown)
    host.removeEventListener('wheel', this.onWheel)
    input.removeEventListener('keydown', this.onKeydown)
    input.removeEventListener('compositionstart', this.onComposition)
    input.removeEventListener('compositionend', this.onComposition)
    input.removeEventListener('focus', this.onInputFocus)
    this.stopRedraw?.()
    this.stopExit?.()
    this.observer?.disconnect()
    if (this.nvimId) void window.workbench.nvim.kill(this.nvimId)
    this.renderer?.dispose()
  }

  async pushTheme(): Promise<void> {
    if (!this.nvimId) return
    try {
      await window.workbench.nvim.request(this.nvimId, 'nvim_exec_lua', [
        'grove_apply_theme(...)',
        [store.activeTheme.palette]
      ])
    } catch {
      // session already gone
    }
  }

  // ── Rendering ──────────────────────────────────────────────────

  private gridSize(): { cols: number; rows: number } {
    const { host } = this.elements
    if (!this.metrics) return { cols: 80, rows: 24 }
    return {
      cols: Math.max(2, Math.floor(host.clientWidth / this.metrics.cellWidth)),
      rows: Math.max(2, Math.floor(host.clientHeight / this.metrics.cellHeight))
    }
  }

  private scheduleRender(): void {
    if (this.renderScheduled) return
    this.renderScheduled = true
    requestAnimationFrame(() => {
      this.renderScheduled = false
      if (!this.renderer) return
      this.renderer.render(this.grid, {
        all: this.pendingDirtyAll,
        rows: this.pendingDirtyRows,
        flushed: true
      })
      this.pendingDirtyAll = false
      this.pendingDirtyRows = new Set()
    })
  }

  private handleRedraw(events: unknown[]): void {
    const dirty = applyRedraw(this.grid, events)
    if (dirty.all) this.pendingDirtyAll = true
    for (const row of dirty.rows) this.pendingDirtyRows.add(row)
    const mode = this.mapMode(this.grid.modeName)
    keymap.setPaneMode(this.config.leafId, mode)
    if (mode !== this.lastMode) {
      this.lastMode = mode
      this.callbacks.onModeChange?.(mode)
    }
    // Cursor moves without row edits still need a repaint: the vacated row (to
    // erase the old block) and the new row.
    this.pendingDirtyRows.add(this.lastCursorRow)
    this.pendingDirtyRows.add(this.grid.cursor.row)
    this.lastCursorRow = this.grid.cursor.row
    if (dirty.flushed || dirty.all) {
      this.scheduleRender()
      this.callbacks.onFlush?.()
    }
  }

  // Coalesced resize → nvim_ui_try_resize (nvim answers with grid_resize).
  private scheduleFit(): void {
    if (this.fitScheduled) return
    this.fitScheduled = true
    requestAnimationFrame(() => {
      this.fitScheduled = false
      const { host } = this.elements
      if (!this.nvimId || !this.renderer) return
      const width = host.clientWidth
      const height = host.clientHeight
      if (width < 2 || height < 2) return
      if (width === this.lastWidth && height === this.lastHeight) return
      this.lastWidth = width
      this.lastHeight = height
      const { cols, rows } = this.gridSize()
      // Changing canvas dimensions clears it; repaint the current grid at once
      // so the pane never shows a half-blank buffer while waiting for nvim's
      // grid_resize redraw.
      this.renderer.resize(cols, rows, window.devicePixelRatio)
      this.pendingDirtyAll = true
      this.scheduleRender()
      void window.workbench.nvim.resize(this.nvimId, cols, rows)
    })
  }

  // Grove → nvim mode names, clamped to what a pane registers.
  private mapMode(name: string): string {
    if (name.startsWith('cmdline')) return 'cmdline'
    if (name === 'select' || name.startsWith('visual')) return 'visual'
    if (name === 'showmatch') return 'insert'
    if (name === 'operator') return 'operator'
    const known = ['normal', 'insert', 'visual', 'replace', 'terminal']
    if (known.includes(name)) return name
    return 'normal'
  }

  // ── Input forwarding ───────────────────────────────────────────

  private onKeydown = (event: KeyboardEvent): void => {
    if (!this.nvimId || this.composing) return
    // Grove's keybinds overlay nvim: give the keymap first refusal (it gates
    // itself by the reported mode, so leader/bare keys only fire in normal
    // mode). Whatever it doesn't claim falls through to nvim.
    if (keymap.handleKeyFromModePane(event)) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    const keys = encodeKeyEvent(event)
    if (!keys) return
    event.preventDefault()
    event.stopPropagation()
    void window.workbench.nvim.input(this.nvimId, keys)
  }

  private onComposition = (event: CompositionEvent): void => {
    if (event.type === 'compositionstart') {
      this.composing = true
      return
    }
    this.composing = false
    if (!this.nvimId || !event.data) return
    void window.workbench.nvim.input(this.nvimId, event.data.replaceAll('<', '<lt>'))
    this.elements.input.textContent = ''
  }

  private onInputFocus = (): void => {
    keymap.setPaneMode(this.config.leafId, this.mapMode(this.grid.modeName))
  }

  // Spatial pane nav focuses the leaf container; steer that into the hidden
  // input so keydown reaches nvim.
  private onLeafFocus = (event: FocusEvent): void => {
    if (event.target === this.leafEl) this.elements.input.focus()
  }

  private mouseModifier(event: MouseEvent | WheelEvent): string {
    let modifier = ''
    if (event.ctrlKey) modifier += 'C'
    if (event.shiftKey) modifier += 'S'
    if (event.altKey) modifier += 'A'
    return modifier
  }

  private cellAt(event: MouseEvent | WheelEvent): { row: number; col: number } | null {
    if (!this.metrics) return null
    const rect = this.elements.host.getBoundingClientRect()
    const col = Math.floor((event.clientX - rect.left) / this.metrics.cellWidth)
    const row = Math.floor((event.clientY - rect.top) / this.metrics.cellHeight)
    return { row: Math.max(0, row), col: Math.max(0, col) }
  }

  private onMouseDown = (event: MouseEvent): void => {
    // Alt+drag is the pane-relocation gesture (handled at the leaf level).
    if (event.altKey) return
    // Without preventDefault the browser moves focus to the focusable leaf
    // container after this handler, stealing keys from the hidden input.
    event.preventDefault()
    this.elements.input.focus()
    if (!this.nvimId) return
    const button = MOUSE_BUTTONS[event.button]
    const cell = this.cellAt(event)
    if (!button || !cell) return
    this.dragButton = button
    this.lastDragRow = cell.row
    this.lastDragCol = cell.col
    void window.workbench.nvim.inputMouse(
      this.nvimId,
      button,
      'press',
      this.mouseModifier(event),
      cell.row,
      cell.col
    )
    window.addEventListener('mousemove', this.onMouseMove)
    window.addEventListener('mouseup', this.onMouseUp)
  }

  private onMouseMove = (event: MouseEvent): void => {
    if (!this.nvimId || !this.dragButton) return
    const cell = this.cellAt(event)
    if (!cell) return
    if (cell.row === this.lastDragRow && cell.col === this.lastDragCol) return
    this.lastDragRow = cell.row
    this.lastDragCol = cell.col
    void window.workbench.nvim.inputMouse(
      this.nvimId,
      this.dragButton,
      'drag',
      this.mouseModifier(event),
      cell.row,
      cell.col
    )
  }

  private onMouseUp = (event: MouseEvent): void => {
    window.removeEventListener('mousemove', this.onMouseMove)
    window.removeEventListener('mouseup', this.onMouseUp)
    const button = this.dragButton
    this.dragButton = null
    if (!this.nvimId || !button) return
    const cell = this.cellAt(event)
    if (!cell) return
    void window.workbench.nvim.inputMouse(
      this.nvimId,
      button,
      'release',
      this.mouseModifier(event),
      cell.row,
      cell.col
    )
  }

  private onWheel = (event: WheelEvent): void => {
    if (!this.nvimId) return
    const cell = this.cellAt(event)
    if (!cell) return
    event.preventDefault()
    const modifier = this.mouseModifier(event)
    if (event.deltaY !== 0) {
      const action = event.deltaY > 0 ? 'down' : 'up'
      void window.workbench.nvim.inputMouse(this.nvimId, 'wheel', action, modifier, cell.row, cell.col)
    }
    if (event.deltaX !== 0) {
      const action = event.deltaX > 0 ? 'right' : 'left'
      void window.workbench.nvim.inputMouse(this.nvimId, 'wheel', action, modifier, cell.row, cell.col)
    }
  }
}
