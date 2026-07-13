<script lang="ts">
  // Git changes for the selected worktree, shown as a sidebar view. Clicking a
  // file opens it in the editor and paints its uncommitted hunks with the
  // floating accept/reject overlay — no separate diff pane. Staging and the
  // ship-it chain live in the footer.
  import { store } from '../lib/store.svelte'
  import { inlineEdit } from '../lib/inlineEdit.svelte'
  import ShipItBar from './ShipItBar.svelte'
  import type { DiffFile } from '../../../shared/types'

  let files = $state<DiffFile[]>([])
  let loading = $state(false)
  let selectedKey = $state<string | null>(null)

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

  function absPathFor(file: DiffFile): string | null {
    const root = store.selectedWorktree?.path
    if (!root) return null
    return `${root}/${file.path}`
  }

  async function loadFiles(): Promise<void> {
    const worktreeId = store.selectedWorktreeId
    if (!worktreeId) {
      files = []
      return
    }
    loading = true
    try {
      files = await window.workbench.git.changedFiles(worktreeId)
    } catch (err) {
      store.setError((err as Error).message)
    } finally {
      loading = false
    }
  }

  async function reviewFile(file: DiffFile): Promise<void> {
    const worktreeId = store.selectedWorktreeId
    const absPath = absPathFor(file)
    if (!worktreeId || !absPath) return
    selectedKey = fileKey(file)
    if (file.changeType === 'deleted') {
      // A deleted file has no buffer to review; just surface the change.
      return
    }
    await inlineEdit.reviewWorkingTreeFile(worktreeId, file, absPath)
  }

  async function toggleStage(file: DiffFile): Promise<void> {
    const worktreeId = store.selectedWorktreeId
    if (!worktreeId) return
    const snapshot = $state.snapshot(file)
    try {
      if (file.staged) {
        await window.workbench.git.unstage(worktreeId, [snapshot.path])
      } else {
        await window.workbench.git.stage(worktreeId, [snapshot.path])
      }
      await loadFiles()
    } catch (err) {
      store.setError((err as Error).message)
    }
  }

  // Reload on worktree switch and whenever the fs watcher reports a change.
  $effect(() => {
    store.selectedWorktreeId
    store.fsVersion[store.selectedWorktreeId ?? '']
    void loadFiles()
  })

  // An agent-touched file (fs watcher) is auto-selected for review context.
  $effect(() => {
    const requested = store.requestedDiffFile
    if (!requested) return
    store.requestedDiffFile = null
    const match = files.find((file) => file.path === requested)
    if (match) selectedKey = fileKey(match)
  })
</script>

<div class="flex h-full flex-col">
  <div class="flex items-center justify-between px-3 py-2">
    <span class="text-2xs font-semibold uppercase tracking-caps text-dim">Changes</span>
    <button class="text-dim hover:text-default" title="Refresh" onclick={loadFiles}>⟳</button>
  </div>

  <div class="min-h-0 flex-1 overflow-auto">
    {#each files as file (fileKey(file))}
      <div
        class="flex w-full items-center gap-2 pr-2 text-xs {selectedKey === fileKey(file)
          ? 'bg-surface'
          : 'hover:bg-hover'}"
      >
        <button
          class="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-3 text-left"
          onclick={() => reviewFile(file)}
        >
          <span class="w-4 shrink-0 font-mono {badge[file.changeType]}"
            >{file.changeType[0].toUpperCase()}</span
          >
          <span class="truncate">{file.path}</span>
        </button>
        <button
          class="shrink-0 rounded px-1 text-2xs {file.staged
            ? 'text-green hover:text-red'
            : 'text-dim hover:text-green'}"
          title={file.staged ? 'Unstage' : 'Stage'}
          onclick={() => toggleStage(file)}
        >
          {file.staged ? 'staged ✓' : 'stage +'}
        </button>
      </div>
    {/each}
    {#if !loading && files.length === 0}
      <p class="px-3 py-4 text-xs text-dim">No changes vs HEAD.</p>
    {/if}
  </div>

  {#if store.selectedWorktreeId}
    <ShipItBar worktreeId={store.selectedWorktreeId} {files} onChanged={loadFiles} />
  {/if}
</div>
