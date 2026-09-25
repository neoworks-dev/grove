<script lang="ts">
  // Embedded Neovim editor: a canvas-rendered ext_linegrid UI bound to a
  // vendored `nvim --embed` sidecar in main. The session/canvas/input plumbing
  // lives in NvimCanvasSession; this component adds the editor-specific chrome
  // (buffer tabs, minimap) and effects (tab follow, reveal, theme, keymap sync).
  import { onMount, onDestroy } from 'svelte'
  import { store } from '../lib/store.svelte'
  import { layout } from '../lib/layout.svelte'
  import { keymap, type Direction } from '../lib/keymap.svelte'
  import { commands } from '../lib/commands.svelte'
  import BufferTabs from './BufferTabs.svelte'
  import Minimap from './Minimap.svelte'
  import WhichKey from './WhichKey.svelte'
  import InlineEditPrompt from './InlineEditPrompt.svelte'
  import InlineReviewOverlay from './InlineReviewOverlay.svelte'
  import ReviewHeaderBar from './ReviewHeaderBar.svelte'
  import ReviewOverlay from './ReviewOverlay.svelte'
  import NvimGridSurface from './NvimGridSurface.svelte'
  import NvimSplitDivider from './NvimSplitDivider.svelte'
  import FileViewerHost from './FileViewerHost.svelte'
  import { fileViewers, type FileViewer } from '../lib/fileViewers.svelte'
  import { editorOverlays } from '../lib/editorOverlays.svelte'
  import { review } from '../lib/review.svelte'
  import { settings } from '../lib/settings.svelte'
  import { NvimCanvasSession } from '../lib/nvim/session'
  import { resolveNvimWindowPosition, type NvimWindowPlacement } from '../lib/nvim/multigrid'
  import type { NvimSessionCallbacks, NvimSessionElements } from '../lib/nvim/session'
  import {
    adoptParkedSession,
    parkNvimSession,
    registerNvimSession,
    unregisterNvimSession
  } from '../lib/nvim/registry'
  import { scratchFor, closeScratch } from '../lib/nvim/scratch.svelte'
  import { leaveDiff, restoreDiff } from '../lib/nvim/diffTabs'
  import { editorHasContent } from '../lib/nvim/visibility'
  import { closedTabPaths } from '../lib/nvim/closedTabs'
  import {
    nvimGroupLabels,
    nvimLeaderBindings,
    type NvimGroup,
    type NvimMapping
  } from '../lib/nvimKeymap'
  import { splitDividers } from '../lib/nvim/splitDividers'
  import { splitReplacement, swapTabs, type SplitWindow } from '../lib/nvim/splitTabs'
  import { operatorHintEntries, operatorTitle } from '../lib/nvimOperatorHints'
  import { decodeNvimKey, nextPending, pendingHint } from '../lib/nvimPendingKeys'
  import { references } from '../lib/references.svelte'
  import { nvimSetup } from '../lib/nvim/setup.svelte'
  import WaveSpinner from './WaveSpinner.svelte'

  let { leafId }: { leafId: string } = $props()

  let hostEl = $state<HTMLDivElement>()
  let canvasEl = $state<HTMLCanvasElement>()
  // Hidden contenteditable rather than a textarea: it receives keydown and IME
  // composition, but does not trip the keymap's INPUT/TEXTAREA guard, so the
  // space leader still works while nvim is in normal mode.
  let inputEl = $state<HTMLDivElement>()
  let unavailable = $state(false)
  nvimSetup.watch()

  // The template gates native multigrid surfaces on the live session. In runes
  // mode a plain variable never invalidates that branch after onMount assigns
  // it, leaving floats present in state but absent from the DOM.
  let session = $state.raw<NvimCanvasSession | null>(null)
  // Leaf id this pane's session is registered under. Tracked separately from the
  // `leafId` prop because the layout can rename a mounted pane's leaf, and the
  // registry entry has to follow it.
  let registeredLeafId = leafId
  let disposeNvimBindings: (() => void) | null = null
  let lastPushedPath: string | null = null
  // Cached operator-pending maps (plugin text objects); refetched with the
  // normal-mode keymap since it rarely changes mid-session.
  let operatorMaps: NvimMapping[] = []
  // Cached normal-mode maps, used to decide whether a half-typed nvim sequence
  // is still going somewhere (see nvimPendingKeys).
  let normalMaps: NvimMapping[] = []
  // Keys nvim has taken but not yet acted on ('5', 'g', '5g'), rebuilt from the
  // on_key stream below.
  let pendingNvimKeys = ''
  let disposePendingKeys: (() => void) | null = null
  let disposeReferences: (() => void) | null = null

  // Reactive mirrors for the child overlays: the session id once attached, and a
  // tick bumped on each redraw flush so the minimap re-reads the buffer view.
  let nvimId = $state<string | null>(null)
  let minimapTick = $state(0)
  // Files open inside this pane's nvim, reported by the autocmd below. The same
  // snapshot attaches a directly-entered file (`gd`, `:e`, tag jumps) to Grove's
  // tab strip; the count also keeps the editor visible during that handoff.
  let nvimFileCount = $state(0)
  // Absolute paths of buffers with unsaved changes, keyed for tab lookup.
  let dirtyPaths = $state<Record<string, boolean>>({})
  // The current tab page's file windows and the focused window, which the tab
  // strip folds into one `a | b | c` tab while there is more than one.
  let splitWindows = $state<SplitWindow[]>([])
  let currentWin = $state(0)
  let disposeBufferWatch: (() => void) | null = null
  let disposeKeymapWatch: (() => void) | null = null
  // Git gutter for the minimap: the open file's changed-line ranges.
  let diffMarkers = $state<{ start: number; count: number; kind: 'add' | 'del' | 'mod' }[]>([])
  let nvimWindows = $state<NvimWindowPlacement[]>([])
  // nvim's windows other than the primary one, drawn inside this pane where
  // nvim placed them. See applyWindowPlacements.
  let embeddedWindows = $state<NvimWindowPlacement[]>([])
  const floatingWindows = $derived(
    nvimWindows.filter((entry) => entry.kind === 'float' && !entry.hidden)
  )
  // The grid nvim's cursor is on, i.e. the focused window.
  let cursorGrid = $state(0)
  // Neovim reserves zindex 100 and above for transient editor UI such as
  // completion menus. Those surfaces already draw their own chrome and must not
  // acquire Grove's modal backdrop or close button. Below that, only a float
  // the cursor is in (Lazy, Mason) is modal; a preview the cursor never
  // entered (hover, line diagnostics, Inspect) sits over the text undimmed.
  const modalFloatingWindows = $derived(
    floatingWindows.filter((entry) => entry.zindex < 100 && entry.grid === cursorGrid)
  )

  function isTransientFloat(entry: NvimWindowPlacement): boolean {
    return entry.zindex >= 100
  }

  // Room between a Grove-framed float's border and its text, in pixels.
  const FLOAT_PADDING = 8

  /** Padding around a float's text: none for transient UI, which frames itself. */
  function floatPadding(entry: NvimWindowPlacement): number {
    if (isTransientFloat(entry)) return 0
    return FLOAT_PADDING
  }

  function floatStyle(entry: NvimWindowPlacement): string {
    const cellWidth = session?.cellWidth ?? 8
    const cellHeight = session?.cellHeight ?? 18
    const padding = floatPadding(entry)
    const maxWidth = Math.max(80, (hostEl?.clientWidth ?? entry.width * cellWidth) - 24)
    const maxHeight = Math.max(60, (hostEl?.clientHeight ?? entry.height * cellHeight) - 24)
    const width = Math.min(entry.width * cellWidth + 2 * padding, maxWidth)
    const height = Math.min(entry.height * cellHeight + 2 * padding, maxHeight)
    const position = resolveNvimWindowPosition(nvimWindows, entry)
    // The frame grows sideways around the text and vertically away from nvim's
    // anchor, so it never covers the line the float was opened from.
    let left = (session?.screenColToPixel(position.col) ?? position.col * cellWidth) - padding
    let top = session?.screenRowToPixel(position.row) ?? position.row * cellHeight
    if (entry.anchor?.startsWith('S')) top -= 2 * padding
    left = Math.max(0, Math.min(left, (hostEl?.clientWidth ?? left + width) - width))
    // Completion surfaces must keep Neovim's below-cursor anchor even when the
    // full menu does not fit. The pane clips the excess at its bottom edge;
    // shifting the whole menu upward is what made it cover the edited row.
    top = isTransientFloat(entry)
      ? Math.max(0, top)
      : Math.max(0, Math.min(top, (hostEl?.clientHeight ?? top + height) - height))
    return `left:${left}px;top:${top}px;width:${width}px;height:${height}px;padding:${padding}px;z-index:${40 + (entry.compindex ?? entry.zindex)}`
  }

  /**
   * Draw every window of this pane's nvim inside the pane, where nvim put it:
   * splits are nvim's own, laid out and sized by nvim as in any nvim UI. The
   * primary window is the pane's main canvas; the rest get a surface each.
   */
  function applyWindowPlacements(windows: NvimWindowPlacement[]): void {
    if (!session) return
    const primaryWin = session.primaryWin
    const embed = windows.filter(
      (entry) => entry.kind === 'normal' && !entry.hidden && entry.win !== primaryWin
    )
    session.setEmbeddedWindows(embed.map((entry) => entry.win))
    embeddedWindows = embed
  }

  // One divider per separator between the pane's splits (see splitDividers).
  const dividers = $derived(splitDividers(nvimWindows))

  /** Place an embedded window on the pane, at the box Neovim gave it. */
  function embeddedStyle(entry: NvimWindowPlacement): string {
    if (!session) return 'display:none'
    const left = session.screenColToPixel(entry.col)
    const top = session.screenRowToPixel(entry.row)
    const width = session.screenColToPixel(entry.col + entry.width) - left
    const height = session.screenRowToPixel(entry.row + entry.height) - top
    return `left:${left}px;top:${top}px;width:${width}px;height:${height}px`
  }

  // Fetch the active file's git hunks and map them to minimap gutter markers.
  async function loadDiffMarkers(): Promise<void> {
    const worktreeId = store.selectedWorktreeId
    const root = store.selectedWorktree?.path
    const path = store.activeTabPath
    if (!worktreeId || !root || !path || !path.startsWith(`${root}/`)) {
      diffMarkers = []
      return
    }
    const relPath = path.slice(root.length + 1)
    try {
      const { hunks } = await window.workbench.git.diffHunks(worktreeId, {
        path: relPath,
        changeType: 'modified',
        staged: false
      })
      diffMarkers = hunks.map((hunk) => {
        if (hunk.originalCount === 0) {
          return { start: hunk.modifiedStart, count: Math.max(1, hunk.modifiedCount), kind: 'add' }
        }
        if (hunk.modifiedCount === 0) {
          return { start: hunk.modifiedStart + 1, count: 1, kind: 'del' }
        }
        return { start: hunk.modifiedStart, count: hunk.modifiedCount, kind: 'mod' }
      })
    } catch {
      diffMarkers = []
    }
  }

  // Reload the gutter when the file switches or the fs watcher reports a change.
  $effect(() => {
    void nvimId
    store.activeTabPath
    store.fsVersion[store.selectedWorktreeId ?? '']
    void loadDiffMarkers()
  })

  const activeTabs = $derived(
    store.tabs.filter((tab) => tab.worktreeId === store.selectedWorktreeId)
  )

  // The active tab when a registered viewer claims it (an image, a PDF, a
  // plugin's .docx): the pane shows that viewer in nvim's place, and nvim keeps
  // its session, hidden, for the next text tab.
  const activeViewer = $derived(viewerTabFor(store.activeTabPath))
  let viewerHost = $state<FileViewerHost>()

  /** The viewer showing `path` in the selected worktree, or null for a text file. */
  function viewerTabFor(
    path: string | null
  ): { worktreeId: string; path: string; viewer: FileViewer } | null {
    const worktreeId = store.selectedWorktreeId
    if (path === null || worktreeId === null) return null
    const viewer = fileViewers.viewerFor(path)
    if (viewer === null) return null
    return { worktreeId, path, viewer }
  }

  /** Whether a viewer rather than nvim shows `path`. */
  function hasViewer(path: string): boolean {
    return fileViewers.viewerFor(path) !== null
  }

  /** The file nvim should open on start: the active tab, unless a viewer shows it. */
  function initialNvimFile(): string | null {
    const path = store.activeTabPath
    if (path === null || hasViewer(path)) return null
    return path
  }

  // Nothing open anywhere → cover the editor with the empty state instead of
  // showing nvim's blank scratch buffer. The session stays alive underneath so
  // opening a file is instant.
  const showEditor = $derived(
    editorHasContent({
      tabCount: activeTabs.length,
      visibleBufferCount: nvimFileCount,
      reviewOwnsPane: review.ownerNvimId !== null && review.ownerNvimId === nvimId
    })
  )

  // "Go to File" is contributed by the files pane; run it through the registry
  // rather than reaching into that component.
  function openFileFinder(): void {
    const finder = commands.commands.find((entry) => entry.id === 'files.find')
    if (finder) void finder.run()
  }

  function selectTab(path: string): void {
    store.activeTabPath = path
  }

  /** Focuses one window of the split tab; the buffer snapshot then follows its file. */
  function selectSplit(win: number): void {
    const id = session?.id
    if (!id) return
    void window.workbench.nvim.request(id, 'nvim_set_current_win', [win]).catch(() => {})
  }

  /** Closes one window of the split tab; its file keeps its buffer and gets its own tab back. */
  function closeSplit(win: number, event: MouseEvent): void {
    event.stopPropagation()
    const id = session?.id
    if (!id) return
    void window.workbench.nvim.request(id, 'nvim_win_close', [win, false]).catch(() => {})
  }

  function closeTab(path: string, event: MouseEvent): void {
    event.stopPropagation()
    if (scratchFor(path)) {
      closeScratch(path)
      return
    }
    store.closeTab(path)
  }

  // Every file tab open in any worktree, as of the last run of the effect below.
  // Across worktrees, so switching worktree does not read as closing its tabs.
  let knownFileTabPaths: string[] = []

  // Mirror every tab close into nvim — the strip, the buffer menu, close
  // others. A buffer left behind is what nvim falls back to when the current
  // one goes, and the buffer-state snapshot then brings its tab back.
  $effect(() => {
    const paths = Object.values(store.tabsByWorktree)
      .flat()
      .filter((tab) => !tab.scratch)
      .map((tab) => tab.path)
    const closed = closedTabPaths(knownFileTabPaths, paths)
    knownFileTabPaths = paths
    const id = session?.id
    if (!id || closed.length === 0) return
    void deleteBuffers(id, closed, store.activeTabPath)
  })

  /**
   * Drops closed tabs' buffers from nvim, so they are neither shown nor fallen
   * back to. A diff is left first: deleting the file's buffer closes its window
   * and would leave the diff's base window as the one still on screen.
   */
  async function deleteBuffers(
    id: string,
    paths: string[],
    nextPath: string | null
  ): Promise<void> {
    await leaveDiff(id, nextPath ?? '').catch(() => {})
    for (const path of paths) {
      if (path === lastPushedPath) lastPushedPath = null
      await window.workbench.nvim
        .request(id, 'nvim_exec_lua', [CLOSE_BUFFER_LUA, [path]])
        .catch(() => {})
    }
  }

  function cssVar(name: string, fallback: string): string {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    return value || fallback
  }

  function fontSize(): number {
    const configured = settings.get<number>('workbench.nvimFontSize')
    if (typeof configured === 'number' && configured > 4) return configured
    return 13
  }

  // The group names nvim's which-key specs give leader prefixes, from which-key's
  // parsed spec list (it has no public getter). Empty when which-key is absent.
  const WHICH_KEY_GROUPS_LUA = `
local ok, config = pcall(require, 'which-key.config')
if not ok or type(config.mappings) ~= 'table' then return {} end
local leader = vim.g.mapleader or '\\\\'
local localLeader = vim.g.maplocalleader or '\\\\'
local groups = {}
for _, mapping in ipairs(config.mappings) do
  local name = mapping.desc
  if type(name) == 'function' then
    local called, value = pcall(name)
    name = called and value or nil
  end
  if mapping.group and type(mapping.lhs) == 'string' and type(name) == 'string' then
    local lhs = mapping.lhs:gsub('<[lL]eader>', leader):gsub('<[lL]ocal[lL]eader>', localLeader)
    table.insert(groups, { lhs = lhs, name = name })
  end
end
return groups
`

  /** Global and buffer-local maps of one mode; buffer-local ones first, so they win. */
  async function nvimMaps(id: string, mode: string): Promise<NvimMapping[]> {
    const [bufferMaps, globalMaps] = await Promise.all([
      window.workbench.nvim.request(id, 'nvim_buf_get_keymap', [0, mode]),
      window.workbench.nvim.request(id, 'nvim_get_keymap', [mode])
    ])
    const maps: NvimMapping[] = []
    if (Array.isArray(bufferMaps)) maps.push(...(bufferMaps as NvimMapping[]))
    if (Array.isArray(globalMaps)) maps.push(...(globalMaps as NvimMapping[]))
    return maps
  }

  /** The which-key group names nvim's config registered. */
  async function nvimGroups(id: string): Promise<NvimGroup[]> {
    const result = await window.workbench.nvim
      .request(id, 'nvim_exec_lua', [WHICH_KEY_GROUPS_LUA, []])
      .catch(() => [])
    if (!Array.isArray(result)) return []
    return result as NvimGroup[]
  }

  /** Replays a leader map's lhs into this pane's nvim. */
  function forwardToNvim(lhs: string): void {
    if (session?.id) void window.workbench.nvim.input(session.id, lhs)
  }

  // Surface nvim's own leader maps in grove's which-key, from normal mode and
  // `x` mode (charwise, linewise and block visual alike), each under its
  // which-key group. Refetched on attach, on buffer
  // change and whenever nvim reports new maps (grove_keymap_changed).
  async function syncNvimKeymap(): Promise<void> {
    const id = session?.id
    if (!id) return
    try {
      const [normal, visual, operator, groups] = await Promise.all([
        nvimMaps(id, 'n'),
        nvimMaps(id, 'x'),
        nvimMaps(id, 'o'),
        nvimGroups(id)
      ])
      if (!session?.id) return
      normalMaps = normal
      operatorMaps = operator
      const labels = nvimGroupLabels(groups)
      const bindings = nvimLeaderBindings(normal, visual, 'editor', forwardToNvim, labels)
      disposeNvimBindings?.()
      const disposeBindings = keymap.registerBindings(bindings)
      const disposeLabels = keymap.registerPrefixLabels('editor', labels)
      disposeNvimBindings = () => {
        disposeBindings()
        disposeLabels()
      }
    } catch {
      // session gone
    }
  }

  // Reports how many windows currently show a named buffer and which buffers
  // hold unsaved changes, once now and again whenever either could change.
  // Windows rather than the buffer list for the count: a hidden buffer isn't on
  // screen, so it shouldn't keep the editor up. The unsaved set spans all loaded
  // buffers, because a modified file keeps its tab dot while hidden behind
  // another. The notify is scheduled because BufDelete/WinClosed fire before the
  // change lands.
  const BUFFER_STATE_LUA = `
local function count_visible()
  local total = 0
  for _, tab in ipairs(vim.api.nvim_list_tabpages()) do
    for _, win in ipairs(vim.api.nvim_tabpage_list_wins(tab)) do
      local buf = vim.api.nvim_win_get_buf(win)
      if vim.api.nvim_buf_get_name(buf) ~= '' then
        total = total + 1
      end
    end
  end
  return total
end

-- Absolute paths of every loaded buffer with unsaved changes. Unnamed buffers
-- are skipped: grove has no tab to mark for them.
local function modified_paths()
  local paths = {}
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_loaded(buf) and vim.bo[buf].modified then
      local name = vim.api.nvim_buf_get_name(buf)
      if name ~= '' then
        table.insert(paths, name)
      end
    end
  end
  return paths
end

-- Only ordinary file buffers become Grove tabs. Quickfix/help/terminal buffers
-- are native nvim surfaces, while named scratch buffers already have explicit
-- scratch:// tabs managed by Grove.
local function active_file()
  local buf = vim.api.nvim_get_current_buf()
  if vim.bo[buf].buftype ~= '' then return nil end
  local name = vim.api.nvim_buf_get_name(buf)
  if name == '' then return nil end
  return name
end

-- The current tab page's file windows in window order, for the tab strip's
-- \`a | b | c\` split tab. Diff windows are left out: a diff tab already names
-- both of its sides.
local function file_splits()
  local splits = {}
  for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    local buf = vim.api.nvim_win_get_buf(win)
    local name = vim.api.nvim_buf_get_name(buf)
    local floating = vim.api.nvim_win_get_config(win).relative ~= ''
    if not floating and not vim.wo[win].diff and vim.bo[buf].buftype == '' and name ~= '' then
      table.insert(splits, { win = win, path = name })
    end
  end
  return splits
end

local function snapshot()
  return {
    count = count_visible(),
    modified = modified_paths(),
    active = active_file(),
    splits = file_splits(),
    win = vim.api.nvim_get_current_win(),
  }
end

local group = vim.api.nvim_create_augroup('GroveBufferCount', { clear = true })
vim.api.nvim_create_autocmd(
  {
    'BufWinEnter', 'BufEnter', 'BufDelete', 'BufWipeout', 'BufFilePost',
    'WinEnter', 'WinNew', 'WinClosed', 'TabEnter', 'BufModifiedSet', 'BufWritePost'
  },
  {
    group = group,
    callback = function()
      vim.schedule(function()
        vim.rpcnotify(0, 'grove_buffers', snapshot())
      end)
    end,
  }
)

-- Entering or leaving a diff moves windows in or out of the split tab.
vim.api.nvim_create_autocmd('OptionSet', {
  group = group,
  pattern = 'diff',
  callback = function()
    vim.schedule(function()
      vim.rpcnotify(0, 'grove_buffers', snapshot())
    end)
  end,
})

-- :bd / :bw on a file buffer closes its Grove tab. Terminal, help and
-- quickfix buffers never had one.
vim.api.nvim_create_autocmd('BufDelete', {
  group = group,
  callback = function(args)
    if vim.bo[args.buf].buftype ~= '' then return end
    local name = vim.api.nvim_buf_get_name(args.buf)
    if name == '' then return end
    vim.schedule(function()
      vim.rpcnotify(0, 'grove_buffer_closed', name)
    end)
  end,
})

return snapshot()
`

  // Drops a file's buffer when its grove tab closes. Modified buffers survive,
  // so an unsaved edit is never thrown away behind the user's back. Left to
  // itself nvim refills the buffer's windows with some other listed buffer —
  // a diff's base side, a scratch — which then stays on screen with no tab, so
  // those windows get an empty buffer first, wiped as soon as anything replaces it.
  const CLOSE_BUFFER_LUA = `
local path = ...
local buf = vim.fn.bufnr(path)
if buf <= 0 or vim.bo[buf].modified then return end
local windows = vim.fn.win_findbuf(buf)
if #windows > 0 then
  local empty = vim.api.nvim_create_buf(true, false)
  vim.bo[empty].bufhidden = 'wipe'
  for _, win in ipairs(windows) do
    vim.api.nvim_win_set_buf(win, empty)
  end
end
pcall(vim.api.nvim_buf_delete, buf, {})
`

  interface BufferSnapshot {
    count?: number
    modified?: unknown
    active?: unknown
    splits?: unknown
    win?: unknown
  }

  /** Keeps the well-formed entries of nvim's split window list. */
  function toSplitWindows(splits: unknown): SplitWindow[] {
    if (!Array.isArray(splits)) return []
    return splits.filter(
      (entry): entry is SplitWindow =>
        typeof entry?.win === 'number' && typeof entry?.path === 'string'
    )
  }

  /** Turns nvim's list of unsaved buffer paths into the lookup BufferTabs takes. */
  function toDirtyPaths(paths: unknown): Record<string, boolean> {
    if (!Array.isArray(paths)) return {}
    const dirty: Record<string, boolean> = {}
    for (const path of paths) {
      if (typeof path === 'string') dirty[path] = true
    }
    return dirty
  }

  /**
   * Attach a file entered from inside nvim to Grove's tab model. Claiming the
   * path before updating the reactive active tab prevents the tab-follow effect
   * from redundantly :edit-ing the buffer that nvim has already opened.
   */
  function attachActiveBuffer(path: unknown): void {
    if (typeof path !== 'string' || path === '') return
    const worktreeId = store.selectedWorktreeId
    if (!worktreeId) return
    const name = path.split(/[\\/]/).pop() || path
    lastPushedPath = path
    store.attachEditorTab({ worktreeId, path, name })
  }

  /**
   * When a split window switches file, swaps the two files' tabs so the split
   * tab stays where it is and the file it let go of reappears where the new one
   * stood, rather than the split tab sliding to wherever the new file sat.
   */
  function keepSplitTabInPlace(previous: SplitWindow[], next: SplitWindow[]): void {
    const replacement = splitReplacement(previous, next)
    if (replacement === null) return
    store.tabs = swapTabs(store.tabs, replacement.left, replacement.entered)
  }

  /** Applies one snapshot from the buffer-state autocmd to the pane's state. */
  function applyBufferSnapshot(snapshot: BufferSnapshot): void {
    if (typeof snapshot.count === 'number') nvimFileCount = snapshot.count
    dirtyPaths = toDirtyPaths(snapshot.modified)
    if (typeof snapshot.win === 'number') currentWin = snapshot.win
    attachActiveBuffer(snapshot.active)
    const nextSplits = toSplitWindows(snapshot.splits)
    keepSplitTabInPlace(splitWindows, nextSplits)
    splitWindows = nextSplits
  }

  /** Closes the tab of a file whose buffer was deleted inside nvim (`:bd`). */
  function closeDeletedBuffer(path: unknown): void {
    if (typeof path !== 'string' || path === '') return
    if (path === lastPushedPath) lastPushedPath = null
    store.closeTab(path)
  }

  /**
   * Install the buffer-state autocmd in a freshly attached session and subscribe
   * to its notifications, so the pane knows whether nvim has anything on screen,
   * attaches directly-entered files to Grove tabs, and tracks unsaved buffers.
   */
  function watchBufferState(id: string): void {
    disposeBufferWatch?.()
    disposeBufferWatch = window.workbench.on('event:nvim-notify', (payload) => {
      const event = payload as { id: string; method: string; args: unknown[] }
      if (event.id !== id) return
      if (event.method === 'grove_buffers') {
        applyBufferSnapshot((event.args?.[0] ?? {}) as BufferSnapshot)
        return
      }
      if (event.method === 'grove_buffer_closed') closeDeletedBuffer(event.args?.[0])
    })
    void window.workbench.nvim
      .request(id, 'nvim_exec_lua', [BUFFER_STATE_LUA, []])
      .then((snapshot) => {
        // A worktree rebind can replace the session while this initial snapshot
        // is in flight; never attach the old worktree's active file to the new one.
        if (session?.id === id) applyBufferSnapshot((snapshot ?? {}) as BufferSnapshot)
      })
      .catch(() => {})
  }

  /**
   * Re-read nvim's mappings when something has just added some. The keymap is
   * synced on attach and on opening a file, which is before anything that maps
   * keys *onto* the file it opened — the pull-request review keys land in that
   * gap, and without this they are typed straight past grove's leader layer.
   */
  function watchKeymapChanges(id: string): void {
    disposeKeymapWatch?.()
    disposeKeymapWatch = window.workbench.on('event:nvim-notify', (payload) => {
      const event = payload as { id: string; method: string }
      if (event.id !== id || event.method !== 'grove_keymap_changed') return
      void syncNvimKeymap()
    })
  }

  // Streams every typed key back to grove while nvim is in normal or visual
  // mode, so the which-key overlay can show nvim's pending sequences (counts,
  // `g`/`z`/`[` layers, half-typed mappings). Nvim reports pending keys nowhere
  // else without ext_messages, which grove does not attach with. Keys produced
  // by mappings or feedkeys have an empty `typed` and are ignored — only what
  // the user actually pressed builds the sequence.
  const PENDING_KEYS_LUA = `
local ns = vim.api.nvim_create_namespace('grove_pending_keys')
vim.on_key(function(key, typed)
  local pressed = typed
  if pressed == nil or pressed == '' then return end
  local ok, state = pcall(vim.api.nvim_get_mode)
  if not ok then return end
  local mode = state.mode
  local head = mode:sub(1, 1)
  if head ~= 'n' and head ~= 'v' and head ~= 'V' and head ~= '\\22' then return end
  pcall(vim.rpcnotify, 0, 'grove_pending_keys', { key = pressed, mode = mode })
end, ns)
`

  /**
   * Install the on_key hook in a freshly attached session and turn its key
   * stream into which-key panels for nvim's pending sequences.
   */
  function watchPendingKeys(id: string): void {
    disposePendingKeys?.()
    pendingNvimKeys = ''
    disposePendingKeys = window.workbench.on('event:nvim-notify', (payload) => {
      const event = payload as { id: string; method: string; args: unknown[] }
      if (event.id !== id || event.method !== 'grove_pending_keys') return
      const data = (event.args?.[0] ?? {}) as { key?: string; mode?: string }
      if (typeof data.key !== 'string') return
      handlePendingKey(data.key, data.mode || '')
    })
    void window.workbench.nvim.request(id, 'nvim_exec_lua', [PENDING_KEYS_LUA, []]).catch(() => {})
  }

  // Neovim owns the `gr` mapping because it knows when an LSP client is
  // attached; its notification hands the multi-result presentation to Grove.
  // Goto requests with several answers arrive as `grove_locations`, already
  // resolved, and open the same picker.
  function watchReferences(id: string): void {
    disposeReferences?.()
    disposeReferences = window.workbench.on('event:nvim-notify', (payload) => {
      const event = payload as { id: string; method: string; args: unknown[] }
      if (event.id !== id) return
      if (event.method === 'grove_references') {
        clearPendingKeys()
        const data = (event.args?.[0] ?? {}) as { symbol?: unknown }
        references.show(id, typeof data.symbol === 'string' ? data.symbol : '')
      }
      if (event.method === 'grove_locations') {
        clearPendingKeys()
        showLocations(id, event.args?.[0])
      }
    })
  }

  /** Opens the location picker on a `grove_locations` notification's payload. */
  function showLocations(id: string, payload: unknown): void {
    const data = (payload ?? {}) as { label?: unknown; symbol?: unknown; locations?: unknown }
    let label = 'Locations'
    if (typeof data.label === 'string') label = data.label
    let symbol = ''
    if (typeof data.symbol === 'string') symbol = data.symbol
    references.showLocations(id, label, symbol, data.locations)
  }

  // Hides the pending panel without churning keymap state on every keystroke.
  function clearPendingKeys(): void {
    pendingNvimKeys = ''
    if (keymap.hintTitle !== null) keymap.hideHints()
  }

  /**
   * Fold one typed key into the pending sequence and show (or drop) its panel.
   * Operator-pending mode is left to handleModeChange, which knows the operator.
   */
  function handlePendingKey(raw: string, mode: string): void {
    if (mode.startsWith('no')) {
      pendingNvimKeys = ''
      return
    }
    const key = decodeNvimKey(raw)
    if (key === null) {
      clearPendingKeys()
      return
    }
    pendingNvimKeys = nextPending(pendingNvimKeys, key, normalMaps)
    const hint = pendingHint(pendingNvimKeys, normalMaps)
    if (!hint) {
      clearPendingKeys()
      return
    }
    keymap.showHints(hint.title, hint.entries)
  }

  // Surface the operator-pending which-key panel when nvim enters (e.g.) `d`,
  // sourcing the pending operator from v:operator so the title matches. Hidden
  // on any transition back out of operator-pending mode.
  async function handleModeChange(mode: string): Promise<void> {
    // A mode change means whatever was half-typed either ran or was abandoned.
    pendingNvimKeys = ''
    if (mode !== 'operator') {
      keymap.hideHints()
      return
    }
    const id = session?.id
    if (!id) return
    let operator = ''
    try {
      const value = await window.workbench.nvim.request(id, 'nvim_get_vvar', ['operator'])
      if (typeof value === 'string') operator = value
    } catch {
      // session gone
    }
    // The operator may have completed while the query was in flight (fast `dw`).
    if (keymap.mode !== 'operator') return
    keymap.showHints(operatorTitle(operator), operatorHintEntries(operator, operatorMaps))
  }

  // Callbacks the session drives this component through. Built here rather than
  // inline because an adopted session has to be re-pointed at the new component
  // instance's state.
  function sessionCallbacks(): NvimSessionCallbacks {
    return {
      onAttached: (id) => {
        // Claim the current path so the tab-follow effect doesn't re-edit it;
        // a fresh session (start or restart) already opened it via initialFile.
        lastPushedPath = store.activeTabPath
        nvimId = id
        void syncNvimKeymap()
        watchBufferState(id)
        watchKeymapChanges(id)
        watchPendingKeys(id)
        watchReferences(id)
        // A renderer reload leaves a gated review's preview in the buffer with
        // nothing left to take it down; this editor is attaching fresh, so
        // whatever is flagged as previewed is stale by definition.
        void session?.clearStalePreviews()
      },
      onFlush: () => {
        minimapTick += 1
      },
      onModeChange: (mode) => {
        void handleModeChange(mode)
      },
      onCursorGridChanged: (grid) => {
        cursorGrid = grid
      },
      onWindowsChanged: (windows) => {
        nvimWindows = windows
        applyWindowPlacements(windows)
      },
      onExited: (exitCode) => {
        console.warn(`nvim editor pane crashed (code ${exitCode}); restarting`)
        nvimId = null
        nvimFileCount = 0
        dirtyPaths = {}
        splitWindows = []
      },
      onClose: () => {
        nvimId = null
        layout.closeLeaf(leafId)
      },
      onUnavailable: () => {
        unavailable = true
      }
    }
  }

  // Take over the session this leaf's previous component instance parked, so a
  // layout change that rebuilds the pane doesn't restart nvim.
  function adoptSession(elements: NvimSessionElements): boolean {
    const parked = adoptParkedSession(leafId)
    if (!parked) return false
    session = parked
    session.reattach(elements, sessionCallbacks())
    registeredLeafId = leafId
    registerNvimSession(leafId, session)
    const id = session.id
    if (!id) return true
    lastPushedPath = store.activeTabPath
    nvimId = id
    void syncNvimKeymap()
    watchBufferState(id)
    watchPendingKeys(id)
    watchReferences(id)
    return true
  }

  onMount(() => {
    keymap.setPaneMode(leafId, 'normal')
    if (!hostEl || !canvasEl || !inputEl) return
    const elements = { host: hostEl, canvas: canvasEl, input: inputEl }
    if (adoptSession(elements)) return
    const font = {
      family: cssVar('--font-mono', 'monospace'),
      sizePx: fontSize() * layout.fontScale(leafId)
    }
    session = new NvimCanvasSession(
      elements,
      { leafId, font, initialFile: initialNvimFile },
      sessionCallbacks()
    )
    registeredLeafId = leafId
    registerNvimSession(leafId, session)
    void session.start()
  })

  // Re-key the session when the layout renames this pane's leaf. Without this
  // the registry keeps the old id, so `nvimSessionFor(leafId)` misses and every
  // overlay that compares its own leafId against a session's stops rendering —
  // the pane still works, but nothing anchored to it does.
  $effect(() => {
    const current = leafId
    if (!session || current === registeredLeafId) return
    unregisterNvimSession(registeredLeafId)
    session.setLeafId(current)
    registerNvimSession(current, session)
    registeredLeafId = current
  })

  // Spatial pane nav focuses the leaf container; pull focus into the input so
  // keys reach nvim. Skipped while the empty state covers the pane — typing into
  // a buffer nobody can see is worse than dropping the keys. A file viewer
  // hides nvim the same way, so it takes the focus instead.
  $effect(() => {
    if (keymap.activePane !== leafId || !showEditor) return
    if (activeViewer !== null) {
      viewerHost?.focus()
      return
    }
    session?.focus()
  })

  // Where focusing this pane puts the keyboard: the viewer when one is showing,
  // nvim's input otherwise. Pane navigation and a closing overlay both come
  // through here, so neither leaves focus on the leaf while keys belong inside.
  $effect(() => keymap.registerPaneFocus(leafId, focusFromNavigation))
  $effect(() =>
    keymap.registerPaneNavigator(leafId, { move: moveToWindow, enter: enterFromEdge })
  )

  // Steps to nvim's window in a direction and reports whether there was one.
  const MOVE_WINDOW_LUA = `
local direction = ...
local before = vim.api.nvim_get_current_win()
vim.cmd('wincmd ' .. direction)
return vim.api.nvim_get_current_win() ~= before
`

  const OPPOSITE_DIRECTION: Record<Direction, Direction> = { h: 'l', l: 'h', j: 'k', k: 'j' }

  /**
   * Ctrl-h/j/k/l inside the editor: nvim's split in that direction first, so
   * focus only leaves the pane from the window at its edge.
   */
  async function moveToWindow(dir: Direction): Promise<boolean> {
    const id = session?.id
    if (!id || !showEditor) return false
    const moved = await window.workbench.nvim
      .request(id, 'nvim_exec_lua', [MOVE_WINDOW_LUA, [dir]])
      .catch(() => false)
    return moved === true
  }

  /** Arriving from a neighbouring pane lands on the split at that edge. */
  function enterFromEdge(dir: Direction): void {
    const id = session?.id
    if (!id || !showEditor) return
    void window.workbench.nvim
      .request(id, 'nvim_command', [`999wincmd ${OPPOSITE_DIRECTION[dir]}`])
      .catch(() => {})
  }

  /** Focuses what this pane shows; false leaves it to the leaf, e.g. under the empty state. */
  function focusFromNavigation(): boolean {
    if (!showEditor) return false
    if (activeViewer !== null && viewerHost) {
      viewerHost.focus()
      return true
    }
    if (!session) return false
    session.focus()
    return true
  }

  // Per-pane font zoom: re-measure nvim's cell when this pane's scale changes.
  $effect(() => {
    const scale = layout.fontScale(leafId)
    session?.setFontSize(fontSize() * scale)
  })

  // Follow the selected worktree: each worktree is its own editor (own buffers,
  // own cwd), so on a switch the session rebinds nvim to the new worktree.
  // Initialized to the spawn-time worktree so the first real switch rebinds.
  let boundWorktreeId: string | null = store.selectedWorktreeId
  $effect(() => {
    const worktreeId = store.selectedWorktreeId
    if (!session || !worktreeId || boundWorktreeId === worktreeId) return
    boundWorktreeId = worktreeId
    // Let the rebound session open the new worktree's active tab itself.
    lastPushedPath = null
    void session.rebind(worktreeId)
  })

  // Follow grove's active tab into nvim (finder/tree opens).
  $effect(() => {
    const path = store.activeTabPath
    const id = session?.id
    if (!id || !path || path === lastPushedPath) return
    lastPushedPath = path
    void followTab(id, path)
  })

  /**
   * Show grove's active tab in this pane's nvim.
   *
   * A review is shown in the buffer for the file it is about, so the file it
   * opened is already on screen — re-opening it would only drop the proposal a
   * gated review is previewing. Any *other* file is a request to stop looking at
   * the review, so it is closed first; the batch stays queued and can be
   * reopened from the chat.
   */
  async function followTab(id: string, path: string): Promise<void> {
    if (review.ownerNvimId !== null && review.ownerNvimId === id) {
      if (path === review.showingPath) return
      await review.cancel()
    }

    // A viewer shows this one; nvim would only load its bytes as text.
    if (hasViewer(path)) return

    // Scratch tabs map to a live nvim buffer, not a file: switch the window to
    // it (only in the pane that owns the buffer) rather than :edit-ing a path.
    const scratch = scratchFor(path)
    if (scratch && scratch.nvimId !== id) return
    // Out of the last diff: its base window, and diff mode unless this tab is a
    // diff too.
    await leaveDiff(id, path).catch(showRestoreError)
    if (scratch) {
      await window.workbench.nvim
        .request(id, 'nvim_set_current_buf', [scratch.bufnr])
        .catch(() => {})
      await restoreDiff(id, path).catch(showRestoreError)
      return
    }
    try {
      await window.workbench.nvim.request(id, 'nvim_cmd', [{ cmd: 'edit', args: [path] }, {}])
      syncNvimKeymap()
    } catch {
      // session gone, or the file vanished between the click and the open
      return
    }
    // A tab opened as a diff lost its other side when it was left.
    await restoreDiff(id, path).catch(showRestoreError)
  }

  /** Reports a diff that could not be closed or rebuilt on switching tabs. */
  function showRestoreError(err: unknown): void {
    store.setError(`Could not switch the diff: ${(err as Error).message}`)
  }

  // Jump to a specific line when a search result (ripgrep) is accepted. Claim
  // lastPushedPath so the tab-follow effect doesn't also re-edit the file.
  $effect(() => {
    const target = store.revealTarget
    const id = session?.id
    if (!id || !target) return
    store.revealTarget = null
    if (hasViewer(target.path)) return
    lastPushedPath = target.path
    void revealLine(target.path, target.line)
  })

  async function revealLine(path: string, line: number): Promise<void> {
    const id = session?.id
    if (!id) return
    try {
      await window.workbench.nvim.request(id, 'nvim_cmd', [{ cmd: 'edit', args: [path] }, {}])
      await window.workbench.nvim.request(id, 'nvim_win_set_cursor', [0, [line, 0]])
      // Center the target line and drop to the first non-blank column.
      await window.workbench.nvim.request(id, 'nvim_cmd', [
        { cmd: 'normal', args: ['zz^'], bang: true },
        {}
      ])
    } catch {
      // session gone or file vanished
    }
    session?.focus()
  }

  // Restyle nvim when grove's theme changes.
  $effect(() => {
    void store.activeTheme
    void session?.pushTheme()
  })

  onDestroy(() => {
    disposeNvimBindings?.()
    disposeBufferWatch?.()
    disposeKeymapWatch?.()
    disposePendingKeys?.()
    disposeReferences?.()
    keymap.hideHints()
    unregisterNvimSession(registeredLeafId)
    // Park rather than dispose: the layout rebuilds this component whenever the
    // split tree changes shape, and the remounted pane adopts the session. A
    // park nobody claims is disposed by the registry's grace timer.
    if (session) parkNvimSession(registeredLeafId, session)
  })
</script>

<div class="flex h-full min-h-0 w-full flex-col">
  {#if showEditor}
    <BufferTabs
      tabs={activeTabs}
      splits={splitWindows}
      {currentWin}
      {dirtyPaths}
      onSelect={selectTab}
      onClose={closeTab}
      onSelectSplit={selectSplit}
      onCloseSplit={closeSplit}
    />
  {/if}
  <ReviewHeaderBar {leafId} />

  <!-- nvim or a file viewer, never both: while a viewer shows, nvim's host is
       invisible — unfocusable, floats and all — but keeps its size, so the
       session neither resizes nor loses its buffers. -->
  <div class="relative min-h-0 flex-1">
    <div
      bind:this={hostEl}
      class="absolute inset-0 overflow-hidden bg-surface"
      class:invisible={activeViewer !== null && showEditor}
      role="none"
    >
      {#if unavailable}
        <div class="flex h-full items-center justify-center text-dim">
          Neovim runtime missing — run `bun scripts/fetch-nvim.ts` and reopen this pane.
        </div>
      {:else}
        <!-- Absolute, not `h-full w-full`: with a window embedded beside it the
           canvas covers the primary window's box rather than the whole pane,
           and the session puts it there. -->
        <canvas bind:this={canvasEl} class="absolute left-0 top-0 block"></canvas>
        {#if session}
          {#each embeddedWindows as embedded (embedded.grid)}
            <div class="absolute overflow-hidden" style={embeddedStyle(embedded)}>
              <NvimGridSurface
                {session}
                grid={embedded.grid}
                win={embedded.win}
                class="pointer-events-auto"
              />
            </div>
          {/each}
          {#each dividers as divider (divider.key)}
            <NvimSplitDivider {session} {divider} />
          {/each}
        {/if}
        {#if session && floatingWindows.length > 0}
          {#if modalFloatingWindows.length > 0}
            <div
              class="absolute inset-0 z-30 bg-black/25"
              role="presentation"
              onclick={(e) => {
                e.stopPropagation()
                for (const floating of modalFloatingWindows) session?.closeWindow(floating.win)
              }}
              onmousedown={(e) => e.stopPropagation()}
            ></div>
          {/if}
          {#each floatingWindows as floating (floating.grid)}
            <div
              class={isTransientFloat(floating)
                ? 'absolute overflow-hidden'
                : 'group absolute overflow-hidden rounded-lg border border-line bg-elevated shadow-2xl'}
              style={floatStyle(floating)}
            >
              <!-- Only a float the cursor is in needs a way out by mouse; a
                   preview closes on Escape or the next cursor move, and a ✕
                   would sit on its text. -->
              {#if modalFloatingWindows.includes(floating)}
                <button
                  class="absolute right-1.5 top-1.5 z-40 flex h-5 w-5 items-center justify-center rounded text-xs text-dim opacity-60 transition-opacity hover:bg-hover hover:text-default hover:opacity-100"
                  title="Close window"
                  onclick={(e) => {
                    e.stopPropagation()
                    session?.closeWindow(floating.win)
                  }}
                  onmousedown={(e) => e.stopPropagation()}
                >
                  ✕
                </button>
              {/if}
              <NvimGridSurface
                {session}
                grid={floating.grid}
                win={floating.win}
                class="pointer-events-auto"
              />
            </div>
          {/each}
        {/if}
        {#if nvimId}
          <Minimap
            {nvimId}
            tick={minimapTick}
            theme={store.activeTheme}
            {diffMarkers}
            class="absolute right-0 top-0 z-20 h-full w-[64px] border-l border-line"
          />
        {/if}
        <div
          bind:this={inputEl}
          contenteditable="true"
          class="absolute left-0 top-0 h-0 w-0 overflow-hidden opacity-0 outline-none"
          role="textbox"
          tabindex="0"
          aria-label="Neovim input"
        ></div>
        <InlineEditPrompt {leafId} />
        <InlineReviewOverlay {leafId} tick={minimapTick} />
        <ReviewOverlay {leafId} tick={minimapTick} />
        <!-- Whatever a plugin has put on the buffer: the GitHub pane's review
           comment box is the first, and it has to open over the line it is
           about. Each decides for itself whether this pane is the one. -->
        {#each editorOverlays.overlays as overlay (overlay.id)}
          <overlay.component {leafId} tick={minimapTick} />
        {/each}
        {#if nvimSetup.step !== null}
          <!-- First-run setup holds every editor back until it is done. -->
          <div
            class="absolute inset-0 z-40 flex flex-col items-center justify-center gap-2 bg-surface text-dim"
            role="status"
          >
            <div class="text-sm text-default">Setting up the editor</div>
            <div class="flex items-center gap-2 text-xs">
              <WaveSpinner count={3} />
              <span>{nvimSetup.step}…</span>
            </div>
            <div class="text-xs">Only on first launch, and after an update.</div>
          </div>
        {/if}
        {#if !showEditor}
          <div
            class="absolute inset-0 z-30 flex flex-col items-center justify-center gap-4 bg-surface text-dim"
          >
            <div class="text-sm">No file open</div>
            <div class="flex flex-wrap justify-center gap-2">
              <button
                class="rounded-md border border-line px-3 py-1.5 text-xs hover:bg-hover hover:text-default"
                onclick={openFileFinder}
              >
                Go to File
              </button>
              <button
                class="rounded-md border border-line px-3 py-1.5 text-xs hover:bg-hover hover:text-default"
                onclick={() => layout.ensurePane('files')}
              >
                Explorer
              </button>
            </div>
          </div>
        {/if}
      {/if}
    </div>
    {#if showEditor && activeViewer !== null}
      <div class="absolute inset-0">
        {#key activeViewer.path}
          <FileViewerHost
            bind:this={viewerHost}
            worktreeId={activeViewer.worktreeId}
            path={activeViewer.path}
            viewer={activeViewer.viewer}
          />
        {/key}
      </div>
    {/if}
    <!-- Which-key rides over the buffer or viewer it applies to, clear of the
         minimap. Only the focused pane shows it, so split editors don't each
         draw one. -->
    {#if keymap.activeLeafId === leafId}
      <div class="pointer-events-none absolute bottom-3 right-[72px] z-30">
        <WhichKey inline />
      </div>
    {/if}
  </div>
</div>
