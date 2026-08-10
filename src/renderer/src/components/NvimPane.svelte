<script lang="ts">
  // Embedded Neovim editor: a canvas-rendered ext_linegrid UI bound to a
  // vendored `nvim --embed` sidecar in main. The session/canvas/input plumbing
  // lives in NvimCanvasSession; this component adds the editor-specific chrome
  // (buffer tabs, minimap) and effects (tab follow, reveal, theme, keymap sync).
  import { onMount, onDestroy } from 'svelte'
  import { store } from '../lib/store.svelte'
  import { layout } from '../lib/layout.svelte'
  import { keymap } from '../lib/keymap.svelte'
  import { commands } from '../lib/commands.svelte'
  import BufferTabs from './BufferTabs.svelte'
  import Minimap from './Minimap.svelte'
  import WhichKey from './WhichKey.svelte'
  import InlineEditPrompt from './InlineEditPrompt.svelte'
  import InlineReviewOverlay from './InlineReviewOverlay.svelte'
  import ReviewHeaderBar from './ReviewHeaderBar.svelte'
  import ReviewOverlay from './ReviewOverlay.svelte'
  import { review } from '../lib/review.svelte'
  import { settings } from '../lib/settings.svelte'
  import { NvimCanvasSession } from '../lib/nvim/session'
  import type { NvimSessionCallbacks, NvimSessionElements } from '../lib/nvim/session'
  import {
    adoptParkedSession,
    parkNvimSession,
    registerNvimSession,
    unregisterNvimSession
  } from '../lib/nvim/registry'
  import { scratchFor, closeScratch } from '../lib/nvim/scratch.svelte'
  import { editorHasContent } from '../lib/nvim/visibility'
  import { nvimKeymapBindings, type NvimMapping } from '../lib/nvimKeymap'
  import { operatorHintEntries, operatorTitle } from '../lib/nvimOperatorHints'
  import { decodeNvimKey, nextPending, pendingHint } from '../lib/nvimPendingKeys'

  let { leafId }: { leafId: string } = $props()

  let hostEl = $state<HTMLDivElement>()
  let canvasEl = $state<HTMLCanvasElement>()
  // Hidden contenteditable rather than a textarea: it receives keydown and IME
  // composition, but does not trip the keymap's INPUT/TEXTAREA guard, so the
  // space leader still works while nvim is in normal mode.
  let inputEl = $state<HTMLDivElement>()
  let unavailable = $state(false)

  let session: NvimCanvasSession | null = null
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

  // Reactive mirrors for the child overlays: the session id once attached, and a
  // tick bumped on each redraw flush so the minimap re-reads the buffer view.
  let nvimId = $state<string | null>(null)
  let minimapTick = $state(0)
  // Files open inside this pane's nvim, reported by the autocmd below. Grove tabs
  // don't cover buffers opened from within nvim (`:e`), so both are consulted
  // before deciding the editor has nothing to show.
  let nvimFileCount = $state(0)
  let disposeBufferWatch: (() => void) | null = null
  // Git gutter for the minimap: the open file's changed-line ranges.
  let diffMarkers = $state<{ start: number; count: number; kind: 'add' | 'del' | 'mod' }[]>([])

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

  function closeTab(path: string, event: MouseEvent): void {
    event.stopPropagation()
    if (scratchFor(path)) {
      closeScratch(path)
      return
    }
    store.closeTab(path)
    // nvim keeps the buffer (and keeps showing it) unless it is told otherwise,
    // which would leave a closed file on screen with no tab for it.
    const id = session?.id
    if (!id) return
    if (path === lastPushedPath) lastPushedPath = null
    void window.workbench.nvim
      .request(id, 'nvim_exec_lua', [CLOSE_BUFFER_LUA, [path]])
      .catch(() => {})
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

  // Surface nvim's own leader maps in grove's which-key. Global + buffer-local
  // normal-mode maps are refetched on attach and on buffer change (plugins and
  // buffers register maps lazily); buffer-local entries win on collision.
  async function syncNvimKeymap(): Promise<void> {
    const id = session?.id
    if (!id) return
    try {
      const [bufferMaps, globalMaps, bufferOmaps, globalOmaps] = await Promise.all([
        window.workbench.nvim.request(id, 'nvim_buf_get_keymap', [0, 'n']),
        window.workbench.nvim.request(id, 'nvim_get_keymap', ['n']),
        window.workbench.nvim.request(id, 'nvim_buf_get_keymap', [0, 'o']),
        window.workbench.nvim.request(id, 'nvim_get_keymap', ['o'])
      ])
      if (!session?.id || !Array.isArray(bufferMaps) || !Array.isArray(globalMaps)) return
      const mappings = [...bufferMaps, ...globalMaps] as NvimMapping[]
      normalMaps = mappings
      const bindings = nvimKeymapBindings(mappings, 'editor', 'normal', (lhs) => {
        if (session?.id) void window.workbench.nvim.input(session.id, lhs)
      })
      disposeNvimBindings?.()
      disposeNvimBindings = keymap.registerBindings(bindings)
      const omaps: NvimMapping[] = []
      if (Array.isArray(bufferOmaps)) omaps.push(...(bufferOmaps as NvimMapping[]))
      if (Array.isArray(globalOmaps)) omaps.push(...(globalOmaps as NvimMapping[]))
      operatorMaps = omaps
    } catch {
      // session gone
    }
  }

  // Reports how many windows currently show a named buffer, once now and again
  // whenever that could change. Windows rather than the buffer list: a hidden
  // buffer isn't on screen, so it shouldn't keep the editor up. The notify is
  // scheduled because BufDelete/WinClosed fire before the change lands.
  const BUFFER_COUNT_LUA = `
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

local group = vim.api.nvim_create_augroup('GroveBufferCount', { clear = true })
vim.api.nvim_create_autocmd(
  { 'BufWinEnter', 'BufEnter', 'BufDelete', 'BufWipeout', 'BufFilePost', 'WinEnter', 'WinClosed', 'TabEnter' },
  {
    group = group,
    callback = function()
      vim.schedule(function()
        vim.rpcnotify(0, 'grove_buffers', { count = count_visible() })
      end)
    end,
  }
)

return count_visible()
`

  // Drops a file's buffer when its grove tab closes. Modified buffers survive
  // (no force), so an unsaved edit is never thrown away behind the user's back.
  const CLOSE_BUFFER_LUA = `
local path = ...
local buf = vim.fn.bufnr(path)
if buf > 0 then
  pcall(vim.api.nvim_buf_delete, buf, {})
end
`

  /**
   * Install the visible-buffer autocmd in a freshly attached session and
   * subscribe to its notifications, so the pane knows whether nvim has anything
   * on screen even for buffers grove never opened a tab for.
   */
  function watchBufferCount(id: string): void {
    disposeBufferWatch?.()
    disposeBufferWatch = window.workbench.on('event:nvim-notify', (payload) => {
      const event = payload as { id: string; method: string; args: unknown[] }
      if (event.id !== id || event.method !== 'grove_buffers') return
      const data = (event.args?.[0] ?? {}) as { count?: number }
      if (typeof data.count === 'number') nvimFileCount = data.count
    })
    void window.workbench.nvim
      .request(id, 'nvim_exec_lua', [BUFFER_COUNT_LUA, []])
      .then((count) => {
        if (typeof count === 'number') nvimFileCount = count
      })
      .catch(() => {})
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
        watchBufferCount(id)
        watchPendingKeys(id)
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
      onExited: (exitCode) => {
        console.warn(`nvim editor pane crashed (code ${exitCode}); restarting`)
        nvimId = null
        nvimFileCount = 0
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
    watchBufferCount(id)
    watchPendingKeys(id)
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
      { leafId, font, initialFile: () => store.activeTabPath },
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
  // a buffer nobody can see is worse than dropping the keys.
  $effect(() => {
    if (keymap.activePane === leafId && showEditor) session?.focus()
  })

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

    // Scratch tabs map to a live nvim buffer, not a file: switch the window to
    // it (only in the pane that owns the buffer) rather than :edit-ing a path.
    const scratch = scratchFor(path)
    if (scratch) {
      if (scratch.nvimId !== id) return
      await window.workbench.nvim
        .request(id, 'nvim_set_current_buf', [scratch.bufnr])
        .catch(() => {})
      return
    }
    try {
      await window.workbench.nvim.request(id, 'nvim_cmd', [{ cmd: 'edit', args: [path] }, {}])
      syncNvimKeymap()
    } catch {
      // session gone, or the file vanished between the click and the open
    }
  }

  // Jump to a specific line when a search result (ripgrep) is accepted. Claim
  // lastPushedPath so the tab-follow effect doesn't also re-edit the file.
  $effect(() => {
    const target = store.revealTarget
    const id = session?.id
    if (!id || !target) return
    store.revealTarget = null
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
    disposePendingKeys?.()
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
    <BufferTabs tabs={activeTabs} onSelect={selectTab} onClose={closeTab} />
  {/if}
  <ReviewHeaderBar {leafId} />

  <div bind:this={hostEl} class="relative min-h-0 flex-1 overflow-hidden bg-surface" role="none">
    {#if unavailable}
      <div class="flex h-full items-center justify-center text-dim">
        Neovim runtime missing — run `bun scripts/fetch-nvim.ts` and reopen this pane.
      </div>
    {:else}
      <canvas bind:this={canvasEl} class="block h-full w-full"></canvas>
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
      <!-- Which-key rides over the buffer it applies to, clear of the minimap.
           Only the focused pane shows it, so split editors don't each draw one. -->
      {#if keymap.activeLeafId === leafId}
        <div class="pointer-events-none absolute bottom-3 right-[72px] z-30">
          <WhichKey inline />
        </div>
      {/if}
      <InlineEditPrompt {leafId} />
      <InlineReviewOverlay {leafId} tick={minimapTick} />
      <ReviewOverlay {leafId} tick={minimapTick} />
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
</div>
