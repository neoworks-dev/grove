// Embedded-Neovim canvas session controller. Owns one `nvim --embed` session:
// the msgpack redraw stream, the canvas grid renderer, resize fitting, and
// keyboard/mouse/wheel forwarding. Bound to caller-provided DOM elements so a
// component only supplies markup and pane-specific effects (tab follow, review
// markup, …) through the callbacks below.
//
// If nvim exits unexpectedly (a crash, not a dispose), the session respawns in
// place a bounded number of times and re-runs onAttached, so a pane recovers
// instead of vanishing. Repeated failures within a short window are treated as
// fatal and handed to onFatal.

import { keymap } from '../keymap.svelte'
import { keyDispatch } from '../keyDispatch'
import { store } from '../store.svelte'
import { createGridState, type DirtyState, type GridState } from './types'
import { encodeKeyEvent } from './keys'
import { measureCell, type CellMetrics, type FontSpec } from './metrics'
import { CanvasGridRenderer } from './canvasRenderer'
import type { GridRenderer } from './renderer'
import {
  applyMultigridRedraw,
  createMultigridState,
  nvimGridSpan,
  type MultigridState,
  type NvimGridSpan,
  type NvimWindowPlacement
} from './multigrid'
import { nvimBlockingPrompt } from './blockingPrompt'
import { nvimPrompts } from './prompts.svelte'
import { nvimPopupMenu } from './popupMenu.svelte'
import { WheelAccumulator } from './wheel'

export interface NvimSessionElements {
  host: HTMLDivElement
  canvas: HTMLCanvasElement
  input: HTMLDivElement
}

export interface NvimSessionCallbacks {
  // nvim attached and its id is live. Runs after the initial file (if any) is
  // loaded, on the first connect AND after every automatic restart — the place
  // to re-open the active file.
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
  // Window topology changed. The owner projects floats into overlays and
  // ordinary nvim windows into Grove split leaves.
  onWindowsChanged?: (windows: NvimWindowPlacement[]) => void
}

export interface NvimSessionConfig {
  leafId: string
  font: FontSpec
  // File to `:edit` on attach, or null to attach with an empty buffer. A
  // function is re-read on each restart so the reconnected session opens the
  // currently active file.
  initialFile?: string | null | (() => string | null)
}

const MOUSE_BUTTONS = ['left', 'middle', 'right']

// Hand the app theme to nvim. The theme is kept in vim.g.grove_theme as well:
// on a first launch nvim answers this while its config is still installing
// plugins, before grove_apply_theme exists, and the config applies the kept
// theme itself once it gets that far.
const APPLY_THEME_LUA = `
local palette, scheme = ...
vim.g.grove_theme = { palette = palette, scheme = scheme }
if type(_G.grove_apply_theme) == 'function' then
  _G.grove_apply_theme(palette, scheme)
end
`

/** Whether nvim's cursor is in the message grid shown on the cmdline row. */
function messageHasCursorIn(
  state: MultigridState,
  message: NvimWindowPlacement | undefined
): boolean {
  if (!message) return false
  return state.cursorGrid === message.grid
}

// Re-read one file from disk if this editor has it open and unedited. `checktime`
// rather than `edit!` so the cursor, marks and undo history survive, and so a
// buffer the user has unsaved work in is never silently thrown away.
//
// Except on a buffer opened for a path that did not exist yet: `checktime`
// answers the file's arrival with W13 ("File has been created after editing
// started"), a prompt that blocks this very request and that no autocmd can
// intercept — W13 does not fire FileChangedShell. An empty buffer has no
// cursor, marks or undo worth keeping, so read the new file straight in.
const REFRESH_FILE_LUA = `
local path = ...
local buf = vim.fn.bufnr(vim.fn.fnameescape(path))
if buf == -1 or not vim.api.nvim_buf_is_loaded(buf) then return false end
if vim.bo[buf].modified then return false end

local function isEmpty(bufnr)
  if vim.api.nvim_buf_line_count(bufnr) > 1 then return false end
  local first = vim.api.nvim_buf_get_lines(bufnr, 0, 1, false)[1]
  return first == nil or first == ''
end

local command = 'checktime'
if isEmpty(buf) then command = 'edit!' end
vim.api.nvim_buf_call(buf, function()
  vim.cmd(command)
end)
return true
`

// Mark up a change under review in the live buffer, replacing any previous
// markup: added lines tinted as additions, replaced lines shown above them as
// virtual lines tinted as deletions. Used by the accept/reject overlay.
const INLINE_PAINT_LUA = `
local ranges, removed = ...
local ns = vim.api.nvim_create_namespace('grove_inline')
local buf = vim.api.nvim_get_current_buf()
vim.api.nvim_buf_clear_namespace(buf, ns, 0, -1)
local total = vim.api.nvim_buf_line_count(buf)

for _, r in ipairs(ranges or {}) do
  local startLine = r.start - 1
  for line = startLine, startLine + r.count - 1 do
    if line >= 0 and line < total then
      vim.api.nvim_buf_set_extmark(buf, ns, line, 0, { line_hl_group = 'DiffAdd' })
    end
  end
end

for _, entry in ipairs(removed or {}) do
  local line = math.max(0, math.min(entry.line - 1, total - 1))
  local virt = {}
  for _, text in ipairs(entry.lines) do
    virt[#virt + 1] = { { text, 'DiffDelete' } }
  end
  if #virt > 0 then
    vim.api.nvim_buf_set_extmark(buf, ns, line, 0, { virt_lines = virt, virt_lines_above = true })
  end
end
`

// Put proposed content into the buffer for a file without touching the file.
// The buffer is left unmodifiable and reported unmodified so nothing can save
// it over the real thing; PREVIEW_END_LUA reverses both.
const PREVIEW_FILE_LUA = `
local path, content = ...
vim.cmd('edit ' .. vim.fn.fnameescape(path))
local buf = vim.api.nvim_get_current_buf()
vim.bo[buf].modifiable = true
vim.api.nvim_buf_set_lines(buf, 0, -1, false, vim.split(content, '\\n', { plain = true }))
vim.bo[buf].modifiable = false
vim.bo[buf].modified = false
-- Flagged so a preview can be recognised and dropped even by a renderer that
-- has forgotten about it (a reload mid-review).
vim.b[buf].grove_preview = true
return true
`

// Drop a preview: reload the file from disk and hand the buffer back.
const PREVIEW_END_LUA = `
local path = ...
local buf = vim.fn.bufnr(vim.fn.fnameescape(path))
if buf == -1 or not vim.api.nvim_buf_is_loaded(buf) then return false end
vim.bo[buf].modifiable = true
vim.b[buf].grove_preview = nil
vim.api.nvim_buf_call(buf, function()
  vim.cmd('silent! edit!')
end)
return true
`

// Drop every preview this editor still holds. Run on attach: a renderer reload
// leaves the buffers previewed but nothing left to end them, and an
// unmodifiable buffer full of content the file does not have is worse than a
// lost review.
const PREVIEW_CLEAR_ALL_LUA = `
local cleared = 0
for _, buf in ipairs(vim.api.nvim_list_bufs()) do
  if vim.api.nvim_buf_is_loaded(buf) and vim.b[buf].grove_preview then
    vim.bo[buf].modifiable = true
    vim.b[buf].grove_preview = nil
    vim.api.nvim_buf_call(buf, function()
      vim.cmd('silent! edit!')
    end)
    cleared = cleared + 1
  end
end
return cleared
`

const INLINE_CLEAR_LUA = `
local ns = vim.api.nvim_create_namespace('grove_inline')
vim.api.nvim_buf_clear_namespace(vim.api.nvim_get_current_buf(), ns, 0, -1)
`

// Centre a line in the window. The line is clamped rather than trusted: a mark
// computed against a rebuilt buffer can outrun the one actually loaded, and
// nvim_win_set_cursor errors out instead of clamping by itself.
const REVEAL_LINE_LUA = `
local line = ...
local total = vim.api.nvim_buf_line_count(0)
if line > total then line = total end
if line < 1 then line = 1 end
vim.api.nvim_win_set_cursor(0, { line, 0 })
vim.cmd('normal! zz^')
return line
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
local lines = vim.api.nvim_buf_get_lines(0, startLine - 1, endLine, false)
return {
  path = vim.api.nvim_buf_get_name(0),
  startLine = startLine,
  endLine = endLine,
  text = table.concat(lines, '\\n')
}
`
// Buffer path plus the 1-based cursor line of the active window. Used to pin the
// file the user is currently editing (Harpoon-style marks).
const ACTIVE_FILE_LUA = `
local cur = vim.api.nvim_win_get_cursor(0)
return { path = vim.api.nvim_buf_get_name(0), line = cur[1] }
`
// A pane that dies more than this many times inside the window is fatal — most
// likely a config/runtime fault a respawn won't fix.
const MAX_RESTARTS = 3
const RESTART_WINDOW_MS = 10_000
const RESTART_DELAY_MS = 150

export class NvimCanvasSession {
  // Not readonly: a session outlives its component. Restructuring the layout
  // tree rebuilds the Svelte subtree around a pane, and the session is handed
  // to the new component instance (see reattach) rather than killing nvim.
  private elements: NvimSessionElements
  private callbacks: NvimSessionCallbacks
  private readonly config: NvimSessionConfig

  private nvimId: string | null = null
  private destroyed = false
  private started = false
  private leafEl: HTMLElement | null = null
  private stopRedraw: (() => void) | null = null
  private stopExit: (() => void) | null = null
  private stopKeySink: (() => void) | null = null
  private observer: ResizeObserver | null = null
  private renderer: GridRenderer | null = null
  private metrics: CellMetrics | null = null

  private grid = createGridState()
  private multigrid = createMultigridState()
  private primaryGridId = 1
  private embeddedWindows = new Set<number>()
  private externalSurfaces = new Map<
    number,
    {
      host: HTMLElement
      renderer: CanvasGridRenderer
      observer: ResizeObserver
      sizeCanvas: () => void
    }
  >()
  private renderScheduled = false
  private pendingDirtyRows = new Set<number>()
  private pendingDirtyAll = false
  private composing = false
  private hasFocus = false
  private lastCursorRow = 0
  private lastCursorGrid = 1
  private lastMode = 'normal'

  private fitScheduled = false
  private lastWidth = 0
  private lastHeight = 0
  // Trailing-edge timer for nvim_ui_try_resize: a drag changes the host box
  // every frame, and each try_resize costs nvim a full-screen redraw.
  private nvimResizeTimer: ReturnType<typeof setTimeout> | null = null
  private pendingGridSize: { cols: number; rows: number } | null = null
  private lastNvimResizeAt = 0

  private dragButton: string | null = null
  private verticalWheel = new WheelAccumulator()
  private horizontalWheel = new WheelAccumulator()
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

  // The layout reuses a mounted pane under a new leaf id when it rebuilds its
  // tree. The session outlives that, so it has to be told, or everything keyed
  // by leafId (the registry, overlays comparing against it) silently stops
  // matching the pane the user is actually looking at.
  setLeafId(leafId: string): void {
    this.config.leafId = leafId
    // The dispatcher keys pane sinks by leaf id, so the sink has to move with
    // the rename. Left behind under the old id it is never looked up again and
    // every unclaimed key is dropped instead of reaching nvim.
    if (!this.stopKeySink) return
    this.stopKeySink()
    this.stopKeySink = keyDispatch.registerPaneSink(leafId, this.onKeydown)
  }

  // Re-measure the cell for a new font size and repaint. Called when the pane's
  // font zoom changes; before start() it only records the size so start() picks
  // it up. Cell metrics change even at the same px, so this always forces a
  // grid re-fit (the resize guard would otherwise skip an unchanged host box).
  setFontSize(sizePx: number): void {
    if (this.config.font.sizePx === sizePx) return
    this.config.font = { ...this.config.font, sizePx }
    if (!this.renderer || this.destroyed) return
    this.metrics = measureCell(this.config.font)
    this.renderer.setFont(this.config.font, this.metrics)
    for (const surface of this.externalSurfaces.values()) {
      surface.renderer.setFont(this.config.font, this.metrics)
    }
    const { host } = this.elements
    const width = host.clientWidth
    const height = host.clientHeight
    if (!this.nvimId || width < 2 || height < 2) return
    this.lastWidth = width
    this.lastHeight = height
    const { cols, rows } = this.gridSize()
    this.fitRendererToGrid()
    this.pendingDirtyAll = true
    this.scheduleRender()
    // A font change is a single deliberate event, so it goes to nvim at once —
    // and supersedes anything a drag left queued.
    this.pendingGridSize = { cols, rows }
    this.flushNvimResize()
  }

  get cellHeight(): number {
    return this.metrics?.cellHeight ?? 0
  }

  get cellWidth(): number {
    return this.metrics?.cellWidth ?? 0
  }

  /** The slice of Neovim's outer grid this pane draws. See nvimGridSpan. */
  private hostSpan(): NvimGridSpan {
    const outer = this.multigrid.grids.get(1)
    const drawnHere = [...this.multigrid.windows.values()].filter(
      (entry) =>
        entry.kind === 'normal' &&
        !entry.hidden &&
        (entry.grid === this.primaryGridId || this.embeddedWindows.has(entry.win))
    )
    return nvimGridSpan(
      drawnHere,
      {
        col: 0,
        cols: outer ? outer.cols : this.grid.cols,
        row: 0,
        rows: outer ? outer.rows : this.grid.rows
      },
      this.messageRow()
    )
  }

  /** The row the cmdline is composited onto, when one is showing. */
  private messageRow(): number | undefined {
    const message = [...this.multigrid.windows.values()].find(
      (entry) => entry.kind === 'message' && !entry.hidden
    )
    if (!message) return undefined
    return message.row
  }

  /**
   * Maps Neovim's global screen rows to the same distributed pixel edges used
   * by the primary canvas. Multiplying by the nominal font cell height drifts
   * by a few pixels because the renderer spreads the pane's remainder across
   * all rows.
   */
  screenRowToPixel(row: number): number {
    const span = this.hostSpan()
    if (span.rows < 1) return row * this.cellHeight
    return Math.round(((row - span.row) * this.elements.host.clientHeight) / span.rows)
  }

  /** Maps Neovim's global screen columns onto the primary canvas edges. */
  screenColToPixel(col: number): number {
    const span = this.hostSpan()
    if (span.cols < 1) return col * this.cellWidth
    return Math.round(((col - span.col) * this.elements.host.clientWidth) / span.cols)
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

  /**
   * Mark up a change under review inside the live buffer: added lines tinted,
   * and the lines they replaced shown above them as virtual lines.
   *
   * This is the only review surface — there is no separate diff window — so the
   * removed side has to be visible here or it is not visible at all.
   */
  async paintInlineReview(
    ranges: { start: number; count: number }[],
    removed: { line: number; lines: string[] }[] = []
  ): Promise<void> {
    const id = this.nvimId
    if (!id) return
    try {
      await window.workbench.nvim.request(id, 'nvim_exec_lua', [
        INLINE_PAINT_LUA,
        [ranges, removed]
      ])
    } catch {
      // session gone
    }
  }

  /**
   * Put a line on screen, centred, with the cursor on it. Used when something
   * other than the user decides what to look at — a review opening its first
   * hunk, which otherwise renders wherever the buffer was last left.
   */
  async revealLine(line: number): Promise<void> {
    const id = this.nvimId
    if (!id) return
    try {
      await window.workbench.nvim.request(id, 'nvim_exec_lua', [REVEAL_LINE_LUA, [line]])
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

  /**
   * Show content the file does not hold yet — an agent's proposed write, held at
   * its permission prompt — in the buffer for that file.
   *
   * The buffer is left unmodifiable and marked unmodified, so the preview cannot
   * be edited or saved over the real file; `reloadBuffer` puts the file back.
   * Nothing is written to disk: whether this content lands is the review's
   * decision, and for a gated write it is the agent's tool call that applies it.
   */
  async previewFile(path: string, content: string): Promise<void> {
    const id = this.nvimId
    if (!id) throw new Error('no editor session attached')
    await window.workbench.nvim.request(id, 'nvim_exec_lua', [PREVIEW_FILE_LUA, [path, content]])
  }

  /** Give a previewed buffer back to the user, editable and matching disk. */
  async endPreview(path: string): Promise<void> {
    const id = this.nvimId
    if (!id) return
    try {
      await window.workbench.nvim.request(id, 'nvim_exec_lua', [PREVIEW_END_LUA, [path]])
    } catch {
      // session gone
    }
  }

  /** Drop any preview left behind by a renderer that reloaded mid-review. */
  async clearStalePreviews(): Promise<void> {
    const id = this.nvimId
    if (!id) return
    try {
      await window.workbench.nvim.request(id, 'nvim_exec_lua', [PREVIEW_CLEAR_ALL_LUA, []])
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

  /**
   * Pick up a change made to a file on disk by something other than this editor
   * — an agent write, or a review being applied.
   *
   * An embedded nvim never gets a focus event, so nothing ever triggers its own
   * `checktime`; without this the buffer keeps showing the pre-write text and
   * writing it back would undo the change. A buffer with unsaved edits is left
   * alone: that is the user's work, and losing it would be worse.
   */
  async refreshFile(path: string): Promise<void> {
    const id = this.nvimId
    if (!id) return
    try {
      await window.workbench.nvim.request(id, 'nvim_exec_lua', [REFRESH_FILE_LUA, [path]])
    } catch {
      // session gone
    }
  }

  // Open a file in this session's window and resolve once nvim has loaded it, so
  // callers can safely paint extmarks against the freshly-loaded buffer.
  async openPath(path: string): Promise<void> {
    const id = this.nvimId
    if (!id) return
    try {
      await window.workbench.nvim.request(id, 'nvim_cmd', [{ cmd: 'edit', args: [path] }, {}])
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

  // The current editor selection: buffer path, 1-based inclusive line range and
  // the selected text as the buffer has it — unsaved edits included, which is
  // what the user is looking at. Returns null when no session is live or the
  // buffer is unnamed (scratch).
  async getVisualSelection(): Promise<{
    path: string
    startLine: number
    endLine: number
    text: string
  } | null> {
    const id = this.nvimId
    if (!id) return null
    try {
      const result = await window.workbench.nvim.request(id, 'nvim_exec_lua', [SELECTION_LUA, []])
      if (!result || typeof result !== 'object') return null
      const selection = result as {
        path?: string
        startLine?: number
        endLine?: number
        text?: string
      }
      if (!selection.path || !selection.startLine || !selection.endLine) return null
      return {
        path: selection.path,
        startLine: selection.startLine,
        endLine: selection.endLine,
        text: selection.text ?? ''
      }
    } catch {
      return null
    }
  }

  // The active buffer's file path and 1-based cursor line. Returns null when no
  // session is live or the buffer is unnamed (scratch/no file on disk).
  async getActiveFile(): Promise<{ path: string; line: number } | null> {
    const id = this.nvimId
    if (!id) return null
    try {
      const result = await window.workbench.nvim.request(id, 'nvim_exec_lua', [ACTIVE_FILE_LUA, []])
      if (!result || typeof result !== 'object') return null
      const active = result as { path?: string; line?: number }
      if (!active.path || !active.line) return null
      return { path: active.path, line: active.line }
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
    const { host, canvas } = this.elements
    await document.fonts.ready
    if (this.destroyed) return
    this.metrics = measureCell(this.config.font)
    this.renderer = new CanvasGridRenderer()
    this.renderer.attach(canvas)
    this.renderer.setFont(this.config.font, this.metrics)

    const { cols, rows } = this.gridSize()
    this.renderer.resize(cols, rows, window.devicePixelRatio, host.clientWidth, host.clientHeight)
    this.lastWidth = host.clientWidth
    this.lastHeight = host.clientHeight

    this.wireElements()

    await this.connect()
  }

  // Bind every listener that hangs off the pane's DOM. Split out of start() so
  // reattach can rebind them onto the elements of a rebuilt component.
  private wireElements(): void {
    const { host, input, canvas } = this.elements
    this.observer = new ResizeObserver(() => this.scheduleFit())
    this.observer.observe(host)
    this.leafEl = (host.closest('[data-leaf]') as HTMLElement | null) ?? null
    this.leafEl?.addEventListener('focusin', this.onLeafFocus)
    canvas.addEventListener('mousedown', this.onMouseDown)
    canvas.addEventListener('wheel', this.onWheel, { passive: false })
    this.stopKeySink = keyDispatch.registerPaneSink(this.config.leafId, this.onKeydown)
    input.addEventListener('compositionstart', this.onComposition)
    input.addEventListener('compositionend', this.onComposition)
    input.addEventListener('focus', this.onInputFocus)
    input.addEventListener('blur', this.onInputBlur)
  }

  private unwireElements(): void {
    const { host, input, canvas } = this.elements
    this.observer?.disconnect()
    this.observer = null
    this.leafEl?.removeEventListener('focusin', this.onLeafFocus)
    this.leafEl = null
    canvas.removeEventListener('mousedown', this.onMouseDown)
    canvas.removeEventListener('wheel', this.onWheel)
    this.stopKeySink?.()
    this.stopKeySink = null
    input.removeEventListener('compositionstart', this.onComposition)
    input.removeEventListener('compositionend', this.onComposition)
    input.removeEventListener('focus', this.onInputFocus)
    input.removeEventListener('blur', this.onInputBlur)
  }

  /**
   * Move this session onto a freshly mounted pane's elements, keeping nvim
   * alive. The layout rebuilds the component subtree around a pane whenever the
   * split tree changes shape (opening a pane beside it, dragging it elsewhere);
   * without this the pane's nvim would be killed and respawned each time.
   */
  reattach(elements: NvimSessionElements, callbacks: NvimSessionCallbacks): void {
    if (this.destroyed) return
    const previousCanvas = this.elements.canvas
    this.unwireElements()
    this.elements = elements
    this.callbacks = callbacks
    this.renderer?.attach(elements.canvas)
    // The rebuilt component brought a blank canvas. Copy the last frame onto it
    // before anything paints, so the pane never flashes empty; the fit below
    // then resizes it (preserving those pixels) and nvim's redraw replaces them.
    this.renderer?.carryFrom(previousCanvas)
    this.wireElements()
    // The replacement component starts with no Svelte window state. Replay the
    // live topology immediately so an already-open float/split does not vanish
    // until Neovim happens to emit another placement event.
    this.callbacks.onWindowsChanged?.([...this.multigrid.windows.values()])
    // Force a re-fit: the guard compares against the old box, and the pane's new
    // box is usually a different size (that is why the layout rebuilt it).
    this.lastWidth = 0
    this.lastHeight = 0
    this.scheduleFit()
  }

  // Spawn nvim, wire the redraw/exit stream, attach the UI, and run onAttached.
  // Reused verbatim for the initial start and every restart. `worktreeId`
  // overrides the spawn cwd (used by rebind on a worktree switch); it defaults
  // to the currently selected worktree.
  private async connect(worktreeId?: string): Promise<void> {
    if (this.destroyed || !this.renderer) return
    const target = worktreeId === undefined ? store.selectedWorktreeId : worktreeId
    // Spawning and attaching take long enough for focus to have moved on — a
    // worktree switch that also reveals another pane, say — and taking it back
    // then would undo that.
    const focusedAtStart = document.activeElement
    let spawnedId: string
    try {
      spawnedId = await window.workbench.nvim.spawn(target)
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
    await window.workbench.nvim.attach(
      this.nvimId,
      cols,
      rows,
      this.resolveInitialFile() ?? undefined
    )
    void this.pushTheme()
    await this.callbacks.onAttached?.(this.nvimId)
    if (document.activeElement === focusedAtStart) this.elements.input.focus()
  }

  // Re-point this session at a different worktree (the user switched worktrees).
  // Kills the current nvim without tripping the crash-restart path, then
  // reconnects against the new worktree so buffers/cwd/LSP match it. The fresh
  // session opens that worktree's active tab via initialFile.
  async rebind(worktreeId: string): Promise<void> {
    if (this.destroyed || !this.renderer) return
    const old = this.nvimId
    // Null the id first so the killed nvim's exit event is ignored (the exit
    // handler bails when the event id no longer matches this.nvimId).
    this.nvimId = null
    if (old) nvimPrompts.clear(old)
    if (old) void window.workbench.nvim.kill(old)
    await this.connect(worktreeId)
  }

  private resolveInitialFile(): string | null {
    const initial = this.config.initialFile
    if (typeof initial === 'function') return initial()
    return initial ?? null
  }

  // nvim exited on its own. A clean exit (0) is the user quitting (:q / :qa) —
  // close the pane. A crash respawns, unless we've failed too often lately.
  private handleUnexpectedExit(exitCode: number): void {
    if (this.nvimId) nvimPrompts.clear(this.nvimId)
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
    if (this.nvimResizeTimer) {
      clearTimeout(this.nvimResizeTimer)
      this.nvimResizeTimer = null
    }
    this.pendingGridSize = null
    window.removeEventListener('mousemove', this.onMouseMove)
    window.removeEventListener('mouseup', this.onMouseUp)
    this.unwireElements()
    this.stopRedraw?.()
    this.stopExit?.()
    if (this.nvimId) {
      nvimPrompts.clear(this.nvimId)
      void window.workbench.nvim.kill(this.nvimId)
    }
    this.renderer?.dispose()
    for (const surface of this.externalSurfaces.values()) {
      surface.observer.disconnect()
      surface.renderer.dispose()
    }
    this.externalSurfaces.clear()
  }

  async pushTheme(): Promise<void> {
    if (!this.nvimId) return
    try {
      await window.workbench.nvim.request(this.nvimId, 'nvim_exec_lua', [
        APPLY_THEME_LUA,
        [store.activeTheme.palette, store.activeTheme.scheme]
      ])
    } catch {
      // session already gone
    }
  }

  // ── Rendering ──────────────────────────────────────────────────

  private gridSize(): { cols: number; rows: number } {
    const { host } = this.elements
    if (!this.metrics) return { cols: 80, rows: 24 }
    const width = host.clientWidth
    const height = host.clientHeight
    // Floor so the grid fits inside the pane; the renderer then spreads the
    // sub-cell remainder across the cells (distributed edges) to reach every
    // edge, so there's no gap and no row is clipped.
    return {
      cols: Math.max(2, Math.floor(width / this.metrics.cellWidth)),
      rows: Math.max(2, Math.floor(height / this.metrics.cellHeight))
    }
  }

  /** The window whose grid this pane's own canvas paints. */
  get primaryWin(): number | null {
    const placement = [...this.multigrid.windows.values()].find(
      (entry) => entry.grid === this.primaryGridId && entry.kind === 'normal' && !entry.hidden
    )
    if (!placement) return null
    return placement.win
  }

  /**
   * nvim's windows besides the primary one, which the pane draws beside it.
   * Their presence is what makes the primary window a fraction of the pane
   * rather than all of it.
   */
  setEmbeddedWindows(wins: number[]): void {
    const changed =
      wins.length !== this.embeddedWindows.size ||
      wins.some((win) => !this.embeddedWindows.has(win))
    if (!changed) return
    this.embeddedWindows = new Set(wins)
    this.fitRendererToGrid()
    this.pendingDirtyAll = true
    this.scheduleRender()
  }

  /**
   * The box the primary window occupies inside the pane — the whole of it until
   * a window is embedded beside it, since the pane's slice of the grid is then
   * exactly that one window.
   */
  private primaryWindowBox(): { left: number; top: number; width: number; height: number } {
    const { host } = this.elements
    const whole = { left: 0, top: 0, width: host.clientWidth, height: host.clientHeight }
    const placement = [...this.multigrid.windows.values()].find(
      (entry) => entry.grid === this.primaryGridId && entry.kind === 'normal' && !entry.hidden
    )
    if (!placement) return whole
    const left = this.screenColToPixel(placement.col)
    const top = this.screenRowToPixel(placement.row)
    return {
      left,
      top,
      width: this.screenColToPixel(placement.col + placement.width) - left,
      height: this.screenRowToPixel(placement.row + this.paintedRows()) - top
    }
  }

  /**
   * Rows the primary canvas paints: the window's own, plus the cmdline row that
   * renderState composites onto the bottom of it. The canvas has to be sized for
   * both or the message lands outside the edges that were built for it.
   */
  private paintedRows(): number {
    const messageRow = this.messageRow()
    if (messageRow === undefined) return this.grid.rows
    return Math.max(this.grid.rows, messageRow + 1)
  }

  /**
   * Point the canvas's cell edges at the grid it actually paints, and put the
   * canvas where that grid's window is.
   *
   * `gridSize` is the outer UI size — the union of every surface this session
   * owns — because that is what Neovim has to be told to resize to. The canvas
   * paints only the primary window's grid, and the moment a second window
   * exists that grid is a fraction of the union: building the edges from the
   * union spreads a 43-column grid across a pane 87 columns wide, which draws
   * every glyph at half an advance, on top of the one before it.
   */
  private fitRendererToGrid(): void {
    if (!this.renderer) return
    const box = this.primaryWindowBox()
    if (box.width < 2 || box.height < 2) return
    const { canvas } = this.elements
    canvas.style.left = `${box.left}px`
    canvas.style.top = `${box.top}px`
    this.renderer.resize(
      this.grid.cols,
      this.paintedRows(),
      window.devicePixelRatio,
      box.width,
      box.height
    )
  }

  private scheduleRender(): void {
    if (this.renderScheduled) return
    this.renderScheduled = true
    requestAnimationFrame(() => {
      this.renderScheduled = false
      this.renderNow()
    })
  }

  // Paint the pending dirty set now, for callers already inside a frame.
  private renderNow(): void {
    if (!this.renderer) return
    this.renderer.render(this.renderState(), {
      all: this.pendingDirtyAll,
      rows: this.pendingDirtyRows,
      flushed: true
    })
    this.pendingDirtyAll = false
    this.pendingDirtyRows = new Set()
  }

  // The grid as painted: an unfocused pane hides its cursor, so only the pane
  // the user is typing into shows one.
  private renderState(): GridState {
    let state = this.grid
    const message = [...this.multigrid.windows.values()].find(
      (entry) => entry.kind === 'message' && !entry.hidden
    )
    if (message) {
      const messageGrid = this.multigrid.grids.get(message.grid)
      if (messageGrid?.lines[0]) {
        const rows = Math.max(state.rows, message.row + 1)
        const lines = [...state.lines]
        while (lines.length < rows) {
          lines.push(Array.from({ length: state.cols }, () => ({ text: ' ', hlId: 0 })))
        }
        lines[message.row] = messageGrid.lines[0]
        const messageHasCursor = messageHasCursorIn(this.multigrid, message)
        state = {
          ...state,
          rows,
          lines,
          cursor: messageHasCursor
            ? { ...messageGrid.cursor, row: message.row + messageGrid.cursor.row }
            : state.cursor
        }
      }
    }
    const cursorHere = messageHasCursorIn(this.multigrid, message) || this.cursorOnPrimary()
    if (this.hasFocus && cursorHere) return state
    return { ...state, cursor: { ...state.cursor, visible: false } }
  }

  // Whether nvim's cursor is in the primary window, rather than in a float or a
  // split mirrored elsewhere. Grid 1 is the outer grid, painted as the primary.
  private cursorOnPrimary(): boolean {
    const cursorGrid = this.multigrid.cursorGrid
    return cursorGrid === this.primaryGridId || cursorGrid === 1
  }

  // A grid mirrored outside the primary canvas, as painted: its cursor shows
  // only while nvim's cursor is actually in it and the pane has focus. Every
  // grid remembers where its cursor last was, so without this a float such as
  // noice's cmdline popup keeps a stale block on screen.
  private externalRenderState(gridId: number, grid: GridState): GridState {
    const visible = grid.cursor.visible && this.hasFocus && this.multigrid.cursorGrid === gridId
    if (visible === grid.cursor.visible) return grid
    return { ...grid, cursor: { ...grid.cursor, visible } }
  }

  private handleRedraw(events: unknown[]): void {
    const update = applyMultigridRedraw(this.multigrid, events)
    const primary = this.multigrid.primaryGrid ?? 1
    if (primary !== this.primaryGridId) {
      this.primaryGridId = primary
      this.pendingDirtyAll = true
    }
    this.grid = this.multigrid.grids.get(primary) ?? this.multigrid.grids.get(1) ?? this.grid
    // Neovim resizes the primary window whenever the windows beside it change —
    // a split, a close, a `:resize` — without the pane's own box moving, so the
    // ResizeObserver never fires and the edges would keep describing the grid as
    // it was before.
    if (
      this.renderer &&
      (this.renderer.gridCols !== this.grid.cols || this.renderer.gridRows !== this.paintedRows())
    ) {
      this.fitRendererToGrid()
      this.pendingDirtyAll = true
    }
    const dirty = update.grids.get(primary) ?? {
      all: false,
      rows: new Set<number>(),
      flushed: false
    }
    if (dirty.all) this.pendingDirtyAll = true
    for (const row of dirty.rows) this.pendingDirtyRows.add(row)
    for (const placement of this.multigrid.windows.values()) {
      if (placement.kind === 'message' && update.grids.has(placement.grid)) {
        this.pendingDirtyRows.add(placement.row)
      }
    }
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
    if (update.placementsChanged) {
      this.pendingDirtyAll = true
      // An embedded window moving is the primary window moving with it, and the
      // canvas is positioned on the primary window's box.
      if (this.embeddedWindows.size > 0) this.fitRendererToGrid()
      this.callbacks.onWindowsChanged?.([...this.multigrid.windows.values()])
    }
    this.syncBlockingPrompt()
    if (update.flushed || dirty.all) {
      this.markCursorGridChange(update.grids)
      this.scheduleRender()
      this.renderExternalSurfaces(update.grids)
      this.callbacks.onFlush?.()
    }
  }

  /**
   * Publish, or withdraw, the prompt this nvim has stopped on. While it waits,
   * every request grove has in flight behind it is stuck, so the prompt goes to
   * a window-level overlay rather than to this pane: the answer has to be
   * typeable from wherever focus happens to be.
   */
  private syncBlockingPrompt(): void {
    const id = this.nvimId
    if (!id) return
    const lines = nvimBlockingPrompt(this.multigrid)
    if (!lines) {
      nvimPrompts.clear(id)
      return
    }
    nvimPrompts.set(id, lines)
  }

  /** Bind one non-primary multigrid grid to a canvas owned by a float or pane. */
  attachGridSurface(
    gridId: number,
    host: HTMLElement,
    canvas: HTMLCanvasElement,
    resizeWin?: number
  ): () => void {
    this.detachGridSurface(gridId)
    const renderer = new CanvasGridRenderer()
    renderer.attach(canvas)
    if (this.metrics) renderer.setFont(this.config.font, this.metrics)
    // Split in two so a grid that Neovim resized on its own can rebuild its cell
    // edges without also asking Neovim to resize the window back — the request
    // that would answer with the very grid_resize that got us here.
    const sizeCanvas = (): void => {
      const grid = this.multigrid.grids.get(gridId)
      if (!grid || host.clientWidth < 1 || host.clientHeight < 1) return
      renderer.resize(
        grid.cols,
        grid.rows,
        window.devicePixelRatio,
        host.clientWidth,
        host.clientHeight
      )
      renderer.render(this.externalRenderState(gridId, grid), {
        all: true,
        rows: new Set(),
        flushed: true
      })
    }
    const fit = (): void => {
      sizeCanvas()
      if (resizeWin && this.nvimId && this.metrics) {
        const cols = Math.max(1, Math.floor(host.clientWidth / this.metrics.cellWidth))
        const rows = Math.max(1, Math.floor(host.clientHeight / this.metrics.cellHeight))
        void window.workbench.nvim
          .request(this.nvimId, 'nvim_win_set_width', [resizeWin, cols])
          .catch(() => {})
        void window.workbench.nvim
          .request(this.nvimId, 'nvim_win_set_height', [resizeWin, rows])
          .catch(() => {})
      }
    }
    const observer = new ResizeObserver(fit)
    observer.observe(host)
    this.externalSurfaces.set(gridId, { host, renderer, observer, sizeCanvas })
    fit()
    return () => this.detachGridSurface(gridId, renderer)
  }

  private detachGridSurface(gridId: number, expected?: CanvasGridRenderer): void {
    const surface = this.externalSurfaces.get(gridId)
    if (!surface || (expected && surface.renderer !== expected)) return
    surface.observer.disconnect()
    surface.renderer.dispose()
    this.externalSurfaces.delete(gridId)
  }

  private renderExternalSurfaces(dirty: Map<number, DirtyState>): void {
    for (const [gridId, surface] of this.externalSurfaces) {
      const grid = this.multigrid.grids.get(gridId)
      const changed = dirty.get(gridId)
      if (!grid || !changed) continue
      // Same invariant as the primary canvas: the edges have to describe the
      // grid being painted, and Neovim resizes these windows without the pane
      // they are mirrored into ever changing size.
      if (surface.renderer.gridCols !== grid.cols || surface.renderer.gridRows !== grid.rows) {
        surface.sizeCanvas()
        continue
      }
      surface.renderer.render(this.externalRenderState(gridId, grid), changed)
    }
  }

  // When nvim's cursor moves to another grid, the grid it left has to repaint
  // the row its block was on, and the one it entered the row it lands on.
  private markCursorGridChange(dirty: Map<number, DirtyState>): void {
    const cursorGrid = this.multigrid.cursorGrid
    if (cursorGrid === this.lastCursorGrid) return
    for (const gridId of [this.lastCursorGrid, cursorGrid]) {
      const grid = this.multigrid.grids.get(gridId)
      if (!grid) continue
      const entry = dirty.get(gridId)
      if (entry) {
        entry.rows.add(grid.cursor.row)
        continue
      }
      dirty.set(gridId, { all: false, rows: new Set([grid.cursor.row]), flushed: true })
    }
    this.lastCursorGrid = cursorGrid
  }

  focusWindow(win: number, focusInput = true): void {
    if (!this.nvimId) return
    void window.workbench.nvim.request(this.nvimId, 'nvim_set_current_win', [win])
    if (focusInput) this.elements.input.focus()
  }

  closeWindow(win: number): void {
    if (!this.nvimId) return
    void window.workbench.nvim.request(this.nvimId, 'nvim_win_close', [win, true]).catch(() => {})
  }

  closeFloatingWindows(): void {
    if (!this.nvimId) return
    for (const placement of this.multigrid.windows.values()) {
      if (placement.kind === 'float' && !placement.hidden) {
        this.closeWindow(placement.win)
      }
    }
  }

  /** Remember where a right-click landed, so nvim's menu for it opens there. */
  noteRightClick(x: number, y: number): void {
    if (!this.nvimId) return
    nvimPopupMenu.noteRightClick(this.nvimId, x, y)
  }

  inputMouseOnGrid(
    grid: number,
    button: string,
    action: string,
    modifier: string,
    row: number,
    col: number
  ): void {
    if (!this.nvimId) return
    void window.workbench.nvim.inputMouse(this.nvimId, button, action, modifier, row, col, grid)
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
      // The renderer carries the last painted frame across the backing resize,
      // so the pane keeps showing real content until nvim's grid_resize redraw
      // arrives. Repainting the old grid here instead would draw it against the
      // new cell edges — the same cells at the wrong columns.
      this.fitRendererToGrid()
      this.queueNvimResize(cols, rows)
    })
  }

  // Tell nvim about the new grid once the box has stopped changing. Mid-drag
  // the canvas keeps repainting the current grid at the new geometry, so the
  // pane tracks the pointer without nvim reflowing the buffer every frame.
  private static readonly RESIZE_SETTLE_MS = 90

  private queueNvimResize(cols: number, rows: number): void {
    this.pendingGridSize = { cols, rows }
    // Leading edge: a resize that isn't part of an ongoing drag (opening a
    // pane, toggling a dock) reflows immediately — waiting out the settle
    // window would leave the carried-over frame on screen for no reason.
    const settling = this.nvimResizeTimer !== null
    const quiet = performance.now() - this.lastNvimResizeAt > NvimCanvasSession.RESIZE_SETTLE_MS
    if (!settling && quiet) {
      this.flushNvimResize()
      // Still arm the timer: the frames that follow (a drag) coalesce into one
      // trailing resize with the final size.
      this.nvimResizeTimer = setTimeout(() => {
        this.nvimResizeTimer = null
        this.flushNvimResize()
      }, NvimCanvasSession.RESIZE_SETTLE_MS)
      return
    }
    if (this.nvimResizeTimer) clearTimeout(this.nvimResizeTimer)
    this.nvimResizeTimer = setTimeout(() => {
      this.nvimResizeTimer = null
      this.flushNvimResize()
    }, NvimCanvasSession.RESIZE_SETTLE_MS)
  }

  // Send the last queued grid size now, dropping the timer. Used when something
  // else resizes the grid (font zoom) and on teardown, so a stale trailing
  // resize can never land after it.
  private flushNvimResize(): void {
    if (this.nvimResizeTimer) {
      clearTimeout(this.nvimResizeTimer)
      this.nvimResizeTimer = null
    }
    const size = this.pendingGridSize
    this.pendingGridSize = null
    if (!size || !this.nvimId || this.destroyed) return
    this.lastNvimResizeAt = performance.now()
    void window.workbench.nvim.resize(this.nvimId, size.cols, size.rows)
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

  /**
   * Fallthrough sink for this pane: whatever grove's global key chain did not
   * claim becomes nvim input. Registered with the dispatcher rather than as a
   * listener on the hidden input, so overlay, dialog and keybind-capture
   * ownership apply to the editor too.
   *
   * Returns false without consuming when the key is not ours to forward — an
   * unencodable key (a lone modifier, or a dead key mid-composition) or focus
   * sitting on another widget inside this leaf, such as the inline edit prompt.
   */
  private onKeydown = (event: KeyboardEvent): boolean => {
    if (!this.nvimId || this.composing) return false
    if (document.activeElement !== this.elements.input) return false
    const keys = encodeKeyEvent(event)
    if (!keys) return false
    event.preventDefault()
    event.stopPropagation()
    void window.workbench.nvim.input(this.nvimId, keys)
    return true
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
    this.setFocusVisible(true)
  }

  private onInputBlur = (): void => {
    this.setFocusVisible(false)
  }

  // Show/hide the cursor with pane focus; repaint its row so the change lands.
  private setFocusVisible(hasFocus: boolean): void {
    if (this.hasFocus === hasFocus) return
    this.hasFocus = hasFocus
    this.pendingDirtyRows.add(this.grid.cursor.row)
    this.scheduleRender()
    const cursorGrid = this.multigrid.grids.get(this.multigrid.cursorGrid)
    if (!cursorGrid) return
    const dirty: DirtyState = { all: false, rows: new Set([cursorGrid.cursor.row]), flushed: true }
    this.renderExternalSurfaces(new Map([[this.multigrid.cursorGrid, dirty]]))
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
    const rect = this.elements.canvas.getBoundingClientRect()
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
    if (button === 'right') this.noteRightClick(event.clientX, event.clientY)
    this.dragButton = button
    this.lastDragRow = cell.row
    this.lastDragCol = cell.col
    void window.workbench.nvim.inputMouse(
      this.nvimId,
      button,
      'press',
      this.mouseModifier(event),
      cell.row,
      cell.col,
      this.primaryGridId
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
      cell.col,
      this.primaryGridId
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
      cell.col,
      this.primaryGridId
    )
  }

  private onWheel = (event: WheelEvent): void => {
    if (!this.nvimId) return
    const cell = this.cellAt(event)
    if (!cell) return
    event.preventDefault()
    this.scrollByWheel(event, this.primaryGridId, cell.row, cell.col)
  }

  /**
   * Scroll the window under a wheel event by the distance it travelled, one
   * nvim wheel step (one line, per the bundled 'mousescroll') at a time.
   */
  scrollByWheel(event: WheelEvent, grid: number, row: number, col: number): void {
    if (!this.nvimId || !this.metrics) return
    const { cellHeight, cellWidth } = this.metrics
    const page = this.elements.host.clientHeight
    const modifier = this.mouseModifier(event)
    const down = this.verticalWheel.lines(event.deltaY, event.deltaMode, cellHeight, page)
    this.sendWheel(grid, down > 0 ? 'down' : 'up', Math.abs(down), modifier, row, col)
    const right = this.horizontalWheel.lines(event.deltaX, event.deltaMode, cellWidth, page)
    this.sendWheel(grid, right > 0 ? 'right' : 'left', Math.abs(right), modifier, row, col)
  }

  private sendWheel(
    grid: number,
    action: string,
    steps: number,
    modifier: string,
    row: number,
    col: number
  ): void {
    if (!this.nvimId) return
    for (let step = 0; step < steps; step++) {
      void window.workbench.nvim.inputMouse(this.nvimId, 'wheel', action, modifier, row, col, grid)
    }
  }
}
