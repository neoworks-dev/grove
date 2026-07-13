<script lang="ts">
  // Git diff viewer backed by one embedded Neovim session. The two sides are
  // scratch buffers shown in a scrollbound vertical split (not nvim's diff
  // mode), so sync-scroll and future per-line affordances stay under app
  // control. Changed line ranges come from `git diff` (never computed in JS)
  // and are painted with extmark line highlights.
  import { onMount, onDestroy } from 'svelte'
  import { store } from '../lib/store.svelte'
  import { layout } from '../lib/layout.svelte'
  import { settings } from '../lib/settings.svelte'
  import { NvimCanvasSession } from '../lib/nvim/session'
  import EdgePanel from './EdgePanel.svelte'
  import type { DiffFile } from '../../../shared/types'

  let { leafId }: { leafId: string } = $props()

  let hostEl = $state<HTMLDivElement>()
  let canvasEl = $state<HTMLCanvasElement>()
  let inputEl = $state<HTMLDivElement>()
  let unavailable = $state(false)
  let ready = $state(false)
  // Bumped on every (re)attach so the reactive load re-runs after a restart,
  // rebuilding the diff into the fresh session.
  let attachSeq = $state(0)

  let session: NvimCanvasSession | null = null

  let files = $state<DiffFile[]>([])
  let selected = $state<DiffFile | null>(null)
  let loading = $state(false)

  const proposed = $derived(store.proposedDiff)

  const badge: Record<string, string> = {
    added: 'text-green',
    modified: 'text-amber',
    deleted: 'text-red',
    renamed: 'text-blue',
    untracked: 'text-violet'
  }

  function fileKey(file: DiffFile): string {
    return `${file.staged ? 'S' : 'U'}:${file.changeType}:${file.path}`
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

  // Split a file's text into buffer lines, dropping the single trailing newline
  // git content carries so line counts match the on-disk file.
  function toLines(text: string): string[] {
    if (text === '') return []
    const body = text.endsWith('\n') ? text.slice(0, -1) : text
    return body.split('\n')
  }

  interface DiffPayload {
    path: string
    original: string[]
    modified: string[]
    removed: number[][]
    added: number[][]
    allAdded: boolean
  }

  async function buildDiff(payload: DiffPayload): Promise<void> {
    const id = session?.id
    if (!id) return
    try {
      await window.workbench.nvim.request(id, 'nvim_exec_lua', [LUA_BUILD_DIFF, [payload]])
    } catch {
      // session gone
    }
  }

  async function showDiff(file: DiffFile): Promise<void> {
    const worktreeId = store.selectedWorktreeId
    if (!worktreeId) return
    selected = file
    // Snapshot the reactive proxy: Electron IPC cannot clone a Svelte $state
    // Proxy ("An object could not be cloned").
    const snapshot = $state.snapshot(file)
    const [sides, hunks] = await Promise.all([
      window.workbench.git.diffSides(worktreeId, snapshot),
      window.workbench.git.diffHunks(worktreeId, snapshot)
    ])
    const original = toLines(sides.original)
    const modified = toLines(sides.modified)
    const removed: number[][] = []
    const added: number[][] = []
    for (const hunk of hunks.hunks) {
      if (hunk.originalCount > 0) removed.push([hunk.originalStart, hunk.originalCount])
      if (hunk.modifiedCount > 0) added.push([hunk.modifiedStart, hunk.modifiedCount])
    }
    await buildDiff({
      path: file.path,
      original,
      modified,
      removed,
      added,
      allAdded: original.length === 0
    })
  }

  // A proposed (not-yet-applied) change has no git hunks; show the two sides
  // side by side, marking a pure addition when there is no original.
  async function showProposed(change: {
    path: string
    original: string
    modified: string
  }): Promise<void> {
    const original = toLines(change.original)
    const modified = toLines(change.modified)
    await buildDiff({
      path: change.path,
      original,
      modified,
      removed: [],
      added: [],
      allAdded: original.length === 0
    })
  }

  async function loadFiles(): Promise<void> {
    const worktreeId = store.selectedWorktreeId
    if (!worktreeId) return
    loading = true
    try {
      files = await window.workbench.git.changedFiles(worktreeId)
      // Prefer a file the agent just touched (auto-diff), else keep the current
      // selection, else the first file.
      const requested = store.requestedDiffFile
      const target =
        (requested && files.find((file) => file.path === requested)) ||
        (selected && files.find((file) => fileKey(file) === fileKey(selected!))) ||
        files[0]
      if (requested) store.requestedDiffFile = null
      if (target) {
        await showDiff(target)
      } else {
        selected = null
        await clearDiff()
      }
    } catch (err) {
      store.setError((err as Error).message)
    } finally {
      loading = false
    }
  }

  async function clearDiff(): Promise<void> {
    await buildDiff({ path: '', original: [], modified: [], removed: [], added: [], allAdded: false })
  }

  onMount(() => {
    if (!hostEl || !canvasEl || !inputEl) return
    const font = { family: cssVar('--font-mono', 'monospace'), sizePx: fontSize() }
    session = new NvimCanvasSession(
      { host: hostEl, canvas: canvasEl, input: inputEl },
      { leafId, font, initialFile: null },
      {
        onAttached: () => {
          ready = true
          attachSeq += 1
        },
        onExited: (exitCode) => {
          console.warn(`nvim diff pane crashed (code ${exitCode}); restarting`)
        },
        onClose: () => layout.closeLeaf(leafId),
        onUnavailable: () => {
          unavailable = true
        }
      }
    )
    void session.start()
  })

  // Git changes: reload on worktree/file change, auto-diff requests, and every
  // (re)attach, but a proposed change takes over the view while it is pending.
  $effect(() => {
    attachSeq
    if (!ready || store.proposedDiff) return
    store.selectedWorktreeId
    store.fsVersion[store.selectedWorktreeId ?? '']
    store.requestedDiffFile
    void loadFiles()
  })

  // Render a proposed change from a pending Write/Edit.
  $effect(() => {
    attachSeq
    const change = store.proposedDiff
    if (!ready || !change) return
    selected = null
    void showProposed(change)
  })

  // Repaint syntax when grove's theme changes.
  $effect(() => {
    void store.activeTheme
    void session?.pushTheme()
  })

  onDestroy(() => session?.dispose())
</script>

<div class="flex h-full min-h-0">
  <EdgePanel
    side="right"
    bind:size={layout.paneSizes.diffList}
    min={160}
    max={480}
    class="border-r border-line"
  >
    <div class="flex h-full flex-col">
      <div class="flex items-center justify-between px-3 py-2">
        <span class="text-2xs font-semibold uppercase tracking-caps text-dim">Changes</span>
        <button class="text-dim hover:text-default" title="Refresh" onclick={loadFiles}>⟳</button>
      </div>
      {#if proposed}
        <p class="px-3 py-4 text-xs text-amber">
          Reviewing a proposed change — approve or deny it in the Agent panel.
        </p>
      {:else}
        <div class="min-h-0 flex-1 overflow-auto">
          {#each files as file (fileKey(file))}
            <button
              class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs {selected &&
              fileKey(selected) === fileKey(file)
                ? 'bg-surface'
                : 'hover:bg-hover'}"
              onclick={() => showDiff(file)}
            >
              <span class="w-4 shrink-0 font-mono {badge[file.changeType]}"
                >{file.changeType[0].toUpperCase()}</span
              >
              <span class="truncate">{file.path}</span>
              {#if file.staged}<span class="ml-auto text-2xs text-green">staged</span>{/if}
            </button>
          {/each}
          {#if !loading && files.length === 0}
            <p class="px-3 py-4 text-xs text-dim">No changes vs HEAD.</p>
          {/if}
        </div>
      {/if}
    </div>
  </EdgePanel>

  <div bind:this={hostEl} class="relative min-h-0 flex-1 overflow-hidden bg-canvas" role="none">
    {#if unavailable}
      <div class="flex h-full items-center justify-center text-dim">
        Neovim runtime missing — run `bun scripts/fetch-nvim.ts` and reopen this pane.
      </div>
    {:else}
      <canvas bind:this={canvasEl} class="block h-full w-full"></canvas>
      <div
        bind:this={inputEl}
        contenteditable="true"
        class="absolute left-0 top-0 h-0 w-0 overflow-hidden opacity-0 outline-none"
        role="textbox"
        tabindex="0"
        aria-label="Neovim diff input"
      ></div>
    {/if}
  </div>
</div>

<script lang="ts" module>
  // Builds the two-buffer diff inside nvim. Receives one table arg with the
  // sides as line lists and the changed ranges ({start, count}, 1-based).
  // Reuses the existing session by collapsing to one window and wiping the
  // previous scratch buffers each rebuild.
  const LUA_BUILD_DIFF = `
local a = ...
pcall(function() vim.cmd('silent! only') end)
if _grove_diff and _grove_diff.bufs then
  for _, b in ipairs(_grove_diff.bufs) do
    if vim.api.nvim_buf_is_valid(b) then pcall(vim.api.nvim_buf_delete, b, { force = true }) end
  end
end
_grove_diff = nil

if not a.path or a.path == '' then return end

local ft = vim.filetype.match({ filename = a.path }) or ''
local function mkbuf(lines)
  local b = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_lines(b, 0, -1, false, lines)
  vim.bo[b].buftype = 'nofile'
  vim.bo[b].swapfile = false
  if ft ~= '' then vim.bo[b].filetype = ft end
  vim.bo[b].modifiable = false
  return b
end

local lb = mkbuf(a.original)
local rb = mkbuf(a.modified)

local lw = vim.api.nvim_get_current_win()
vim.api.nvim_win_set_buf(lw, lb)
vim.cmd('rightbelow vsplit')
local rw = vim.api.nvim_get_current_win()
vim.api.nvim_win_set_buf(rw, rb)
for _, w in ipairs({ lw, rw }) do
  vim.wo[w].number = true
  vim.wo[w].wrap = false
  vim.wo[w].scrollbind = true
  vim.wo[w].cursorbind = true
end
vim.api.nvim_set_current_win(rw)
vim.cmd('syncbind')

local ns = vim.api.nvim_create_namespace('grove_diff')
local function paint(buf, ranges, group)
  local total = vim.api.nvim_buf_line_count(buf)
  for _, r in ipairs(ranges) do
    for i = 0, r[2] - 1 do
      local line = r[1] - 1 + i
      if line >= 0 and line < total then
        vim.api.nvim_buf_set_extmark(buf, ns, line, 0, { line_hl_group = group })
      end
    end
  end
end

if a.allAdded then
  paint(rb, { { 1, vim.api.nvim_buf_line_count(rb) } }, 'DiffAdd')
else
  paint(lb, a.removed, 'DiffDelete')
  paint(rb, a.added, 'DiffAdd')
end

_grove_diff = { bufs = { lb, rb } }
`
</script>
