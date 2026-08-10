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
import { createGridState, type GridState } from './types'
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

// Re-read one file from disk if this editor has it open and unedited. `checktime`
// rather than `edit!` so the cursor, marks and undo history survive, and so a
// buffer the user has unsaved work in is never silently thrown away.
const REFRESH_FILE_LUA = `
local path = ...
local buf = vim.fn.bufnr(vim.fn.fnameescape(path))
if buf == -1 or not vim.api.nvim_buf_is_loaded(buf) then return false end
if vim.bo[buf].modified then return false end
vim.api.nvim_buf_call(buf, function()
  vim.cmd('checktime')
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
  private renderScheduled = false
  private pendingDirtyRows = new Set<number>()
  private pendingDirtyAll = false
  private composing = false
  private hasFocus = false
  private lastCursorRow = 0
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
    const { host } = this.elements
    const width = host.clientWidth
    const height = host.clientHeight
    if (!this.nvimId || width < 2 || height < 2) return
    this.lastWidth = width
    this.lastHeight = height
    const { cols, rows } = this.gridSize()
    this.renderer.resize(cols, rows, window.devicePixelRatio, width, height)
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
    const { host, input } = this.elements
    this.observer = new ResizeObserver(() => this.scheduleFit())
    this.observer.observe(host)
    this.leafEl = (host.closest('[data-leaf]') as HTMLElement | null) ?? null
    this.leafEl?.addEventListener('focusin', this.onLeafFocus)
    host.addEventListener('mousedown', this.onMouseDown)
    host.addEventListener('wheel', this.onWheel, { passive: false })
    this.stopKeySink = keyDispatch.registerPaneSink(this.config.leafId, this.onKeydown)
    input.addEventListener('compositionstart', this.onComposition)
    input.addEventListener('compositionend', this.onComposition)
    input.addEventListener('focus', this.onInputFocus)
    input.addEventListener('blur', this.onInputBlur)
  }

  private unwireElements(): void {
    const { host, input } = this.elements
    this.observer?.disconnect()
    this.observer = null
    this.leafEl?.removeEventListener('focusin', this.onLeafFocus)
    this.leafEl = null
    host.removeEventListener('mousedown', this.onMouseDown)
    host.removeEventListener('wheel', this.onWheel)
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
    this.elements.input.focus()
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
    // Floor so the grid fits inside the pane; the renderer then spreads the
    // sub-cell remainder across the cells (distributed edges) to reach every
    // edge, so there's no gap and no row is clipped.
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
    if (this.hasFocus) return this.grid
    return { ...this.grid, cursor: { ...this.grid.cursor, visible: false } }
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
      // The renderer carries the last painted frame across the backing resize,
      // so the pane keeps showing real content until nvim's grid_resize redraw
      // arrives. Repainting the old grid here instead would draw it against the
      // new cell edges — the same cells at the wrong columns.
      this.renderer.resize(cols, rows, window.devicePixelRatio, width, height)
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
      void window.workbench.nvim.inputMouse(
        this.nvimId,
        'wheel',
        action,
        modifier,
        cell.row,
        cell.col
      )
    }
    if (event.deltaX !== 0) {
      const action = event.deltaX > 0 ? 'right' : 'left'
      void window.workbench.nvim.inputMouse(
        this.nvimId,
        'wheel',
        action,
        modifier,
        cell.row,
        cell.col
      )
    }
  }
}
