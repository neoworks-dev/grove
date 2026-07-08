<script lang="ts">
  import { onDestroy } from 'svelte'
  import { store } from '../lib/store.svelte'
  import { languageExtension, editorTheme } from '../lib/editor'
  import { MergeView } from '@codemirror/merge'
  import { EditorState, type Extension } from '@codemirror/state'
  import { EditorView, lineNumbers, highlightSpecialChars } from '@codemirror/view'
  import UIPane from './UIPane.svelte'
  import type { DiffFile } from '../../../shared/types'

  let listWidth = $state(Number(localStorage.getItem('pane.diffList')) || 256)
  $effect(() => localStorage.setItem('pane.diffList', String(listWidth)))

  let diffHost = $state<HTMLDivElement>()
  let mergeView: MergeView | null = null

  let files = $state<DiffFile[]>([])
  let selected = $state<DiffFile | null>(null)
  let loading = $state(false)

  // The sides currently rendered, kept so a theme change can re-render them.
  let current: { original: string; modified: string; language: string } | null = null

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

  // Read-only extensions for one side of the diff.
  function sideExtensions(language: string): Extension {
    const theme = store.activeTheme
    return [
      lineNumbers(),
      highlightSpecialChars(),
      languageExtension(`x.${language}`),
      editorTheme(theme.palette, theme.scheme),
      EditorState.readOnly.of(true),
      EditorView.editable.of(false)
    ]
  }

  function destroyMerge(): void {
    mergeView?.destroy()
    mergeView = null
  }

  function renderMerge(original: string, modified: string, language: string): void {
    if (!diffHost) return
    current = { original, modified, language }
    destroyMerge()
    mergeView = new MergeView({
      a: { doc: original, extensions: sideExtensions(language) },
      b: { doc: modified, extensions: sideExtensions(language) },
      parent: diffHost,
      collapseUnchanged: { margin: 3, minSize: 4 },
      highlightChanges: true,
      gutter: true
    })
  }

  function clearDiff(): void {
    current = null
    destroyMerge()
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

  async function showDiff(file: DiffFile): Promise<void> {
    if (!store.selectedWorktreeId) return
    selected = file
    const sides = await window.workbench.git.diffSides(store.selectedWorktreeId, file)
    renderMerge(sides.original, sides.modified, sides.language)
  }

  const proposed = $derived(store.proposedDiff)

  // Git changes: reload on worktree/file change and auto-diff requests, but a
  // proposed change takes over the editor while it is pending.
  $effect(() => {
    if (store.proposedDiff) return
    store.selectedWorktreeId
    store.fsVersion[store.selectedWorktreeId ?? '']
    store.requestedDiffFile
    void loadFiles()
  })

  // Render a proposed (not-yet-applied) change from a pending Write/Edit.
  $effect(() => {
    const change = store.proposedDiff
    if (change) {
      selected = null
      renderMerge(change.original, change.modified, change.language)
    }
  })

  // Follow the active color theme (re-render current sides with the new theme).
  $effect(() => {
    store.activeTheme
    if (current) renderMerge(current.original, current.modified, current.language)
  })

  onDestroy(() => destroyMerge())
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
    <div bind:this={diffHost} class="min-h-0 flex-1 overflow-auto"></div>
  </div>
</div>
