<script lang="ts">
  import { onDestroy } from 'svelte'
  import { store } from '../lib/store.svelte'
  import { setupMonaco } from '../lib/monaco'
  import UIPane from './UIPane.svelte'
  import type { DiffFile } from '../../../shared/types'
  import type * as Monaco from 'monaco-editor'

  let listWidth = $state(Number(localStorage.getItem('pane.diffList')) || 256)
  $effect(() => localStorage.setItem('pane.diffList', String(listWidth)))

  let diffHost = $state<HTMLDivElement>()
  let diffEditor: Monaco.editor.IStandaloneDiffEditor | null = null
  let monaco: typeof Monaco | null = null

  let files = $state<DiffFile[]>([])
  let selected = $state<DiffFile | null>(null)
  let loading = $state(false)

  function fileKey(file: DiffFile): string {
    return `${file.staged ? 'S' : 'U'}:${file.changeType}:${file.path}`
  }

  const badge: Record<string, string> = {
    added: 'text-green',
    modified: 'text-amber',
    deleted: 'text-red',
    renamed: 'text-blue',
    untracked: 'text-violet'
  }

  async function loadFiles(): Promise<void> {
    if (!store.selectedWorktreeId) return
    loading = true
    try {
      files = await window.workbench.git.changedFiles(store.selectedWorktreeId)
      // Prefer a file the agent just touched (auto-diff), else keep/pick first.
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
        clearDiff()
      }
    } catch (err) {
      store.setError((err as Error).message)
    } finally {
      loading = false
    }
  }

  function ensureDiffEditor(): void {
    if (diffEditor || !diffHost) return
    monaco = setupMonaco()
    diffEditor = monaco.editor.createDiffEditor(diffHost, {
      theme: store.monacoTheme,
      automaticLayout: true,
      readOnly: true,
      renderSideBySide: true,
      fontSize: 13,
      fontFamily: 'Geist Mono, monospace',
      minimap: { enabled: false }
    })
  }

  function clearDiff(): void {
    diffEditor?.setModel(null)
  }

  async function showDiff(file: DiffFile): Promise<void> {
    if (!store.selectedWorktreeId) return
    selected = file
    ensureDiffEditor()
    if (!diffEditor || !monaco) return
    const sides = await window.workbench.git.diffSides(store.selectedWorktreeId, file)
    const original = monaco.editor.createModel(sides.original, sides.language)
    const modified = monaco.editor.createModel(sides.modified, sides.language)
    const old = diffEditor.getModel()
    diffEditor.setModel({ original, modified })
    old?.original.dispose()
    old?.modified.dispose()
  }

  const proposed = $derived(store.proposedDiff)

  // Render a proposed (not-yet-applied) change from a pending Write/Edit.
  async function showProposed(change: {
    original: string
    modified: string
    language: string
  }): Promise<void> {
    ensureDiffEditor()
    if (!diffEditor || !monaco) return
    selected = null
    const original = monaco.editor.createModel(change.original, change.language)
    const modified = monaco.editor.createModel(change.modified, change.language)
    const old = diffEditor.getModel()
    diffEditor.setModel({ original, modified })
    old?.original.dispose()
    old?.modified.dispose()
  }

  // Git changes: reload on worktree/file change and auto-diff requests, but a
  // proposed change takes over the editor while it is pending.
  $effect(() => {
    if (store.proposedDiff) return
    store.selectedWorktreeId
    store.fsVersion[store.selectedWorktreeId ?? '']
    store.requestedDiffFile
    void loadFiles()
  })

  $effect(() => {
    const change = store.proposedDiff
    if (change) void showProposed(change)
  })

  // Follow the active color theme (Monaco themes are global).
  $effect(() => {
    if (monaco) monaco.editor.setTheme(store.monacoTheme)
  })

  onDestroy(() => diffEditor?.dispose())
</script>

<div class="flex h-full min-h-0">
  <!-- Changed files -->
  <UIPane side="right" bind:size={listWidth} min={160} max={480} class="border-r border-line">
    <div class="flex h-full flex-col">
    <div class="flex items-center justify-between px-3 py-2">
      <span class="text-2xs font-semibold uppercase tracking-caps text-dim">Changes</span>
      <button class="text-dim hover:text-default" title="Refresh" onclick={loadFiles}>⟳</button>
    </div>
    {#if proposed}
      <p class="px-3 py-4 text-xs text-amber">Reviewing a proposed change — approve or deny it in the Agent panel.</p>
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
  </UIPane>

  <!-- Diff editor -->
  <div class="flex min-w-0 flex-1 flex-col">
    <div class="border-b border-line px-3 py-1.5 font-mono text-xs text-muted">
      {#if proposed}
        {proposed.path}
        <span class="ml-2 text-amber">(proposed change · pending approval)</span>
      {:else}
        {selected ? selected.path : 'Select a file'}
        {#if selected}
          <span class="ml-2 text-dim">({selected.staged ? 'staged' : 'working tree'} vs HEAD)</span>
        {/if}
      {/if}
    </div>
    <div bind:this={diffHost} class="min-h-0 flex-1"></div>
  </div>
</div>
