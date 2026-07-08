<script lang="ts">
  import Icon from '@iconify/svelte'
  import { fileFinder } from '../lib/filefinder.svelte'
  import { store, openFileInEditor, revealInTree } from '../lib/store.svelte'
  import { fileIcon } from '../lib/icons'

  let query = $state('')
  let files = $state<string[]>([])
  let activeIndex = $state(0)
  let inputEl = $state<HTMLInputElement>()

  const RESULT_CAP = 200
  const worktreeId = $derived(store.selectedWorktreeId)
  const worktreeRoot = $derived(store.selectedWorktree?.path || '')

  // Substring match on the relative path. An empty query lists everything
  // (capped) so the overlay is useful before typing.
  const results = $derived.by<string[]>(() => {
    const q = query.trim().toLowerCase()
    if (!q) return files.slice(0, RESULT_CAP)
    return files.filter((file) => file.toLowerCase().includes(q)).slice(0, RESULT_CAP)
  })

  // Load the file list and reset each time the overlay opens.
  $effect(() => {
    if (!fileFinder.open) return
    query = ''
    activeIndex = 0
    queueMicrotask(() => inputEl?.focus())
    if (!worktreeId) {
      files = []
      return
    }
    void window.workbench.files
      .listAll(worktreeId)
      .then((list) => (files = list))
      .catch(() => (files = []))
  })

  // Keep the selection in range as the filtered list changes.
  $effect(() => {
    if (activeIndex >= results.length) activeIndex = Math.max(0, results.length - 1)
  })

  function open(file: string): void {
    if (!worktreeId) return
    openFileInEditor(worktreeId, `${worktreeRoot}/${file}`)
    revealInTree(file)
    fileFinder.close()
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      fileFinder.close()
    } else if (event.key === 'ArrowDown' || (event.ctrlKey && event.key === 'j')) {
      event.preventDefault()
      activeIndex = Math.min(activeIndex + 1, results.length - 1)
    } else if (event.key === 'ArrowUp' || (event.ctrlKey && event.key === 'k')) {
      event.preventDefault()
      activeIndex = Math.max(activeIndex - 1, 0)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      if (results[activeIndex]) open(results[activeIndex])
    }
  }
</script>

{#if fileFinder.open}
  <div
    class="fixed inset-0 z-modal flex items-start justify-center bg-black/50 pt-[10vh]"
    role="button"
    tabindex="0"
    onclick={() => fileFinder.close()}
    onkeydown={(event) => event.key === 'Escape' && fileFinder.close()}
  >
    <div
      class="flex h-[64vh] w-[620px] max-w-[92vw] flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-overlay"
      role="dialog"
      tabindex="0"
      onclick={(event) => event.stopPropagation()}
      onkeydown={onKeyDown}
    >
      <div class="flex items-center gap-2 border-b border-line px-3">
        <span class="font-mono text-xs text-dim">›</span>
        <input
          bind:this={inputEl}
          bind:value={query}
          class="w-full bg-transparent py-3 text-sm outline-none"
          placeholder="Search files by name…"
        />
        <span class="shrink-0 font-mono text-2xs text-dim">{results.length}</span>
      </div>

      <div class="min-h-0 flex-1 overflow-auto">
        {#each results as file, index (file)}
          <button
            class="flex w-full items-center gap-2 px-3 py-1.5 text-left {index === activeIndex
              ? 'bg-hover'
              : ''} hover:bg-hover"
            onmousemove={() => (activeIndex = index)}
            onclick={() => open(file)}
          >
            <Icon icon={fileIcon(file)} width="16" height="16" class="shrink-0" />
            <span class="truncate text-xs text-muted">{file}</span>
          </button>
        {/each}
        {#if results.length === 0}
          <p class="px-3 py-4 text-xs text-dim">
            {query.trim() ? 'No files match.' : 'No files.'}
          </p>
        {/if}
      </div>
    </div>
  </div>
{/if}
