<script lang="ts">
  import { onMount } from 'svelte'
  import { search } from '../lib/search.svelte'
  import { store, openFileAtLine, revealInTree } from '../lib/store.svelte'
  import type { SearchMatch } from '../../../shared/types'

  let query = $state('')
  let results = $state<SearchMatch[]>([])
  let activeIndex = $state(0)
  let inputEl = $state<HTMLInputElement>()
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let reqId = 0
  let currentReq = ''

  const RESULT_CAP = 1000
  const worktreeId = $derived(store.selectedWorktreeId)
  const worktreeRoot = $derived(store.selectedWorktree?.path || '')

  // Reset + focus each time the overlay opens.
  $effect(() => {
    if (search.open) {
      query = ''
      results = []
      activeIndex = 0
      queueMicrotask(() => inputEl?.focus())
    } else {
      void window.workbench.search.cancel()
    }
  })

  function runSearch(): void {
    if (!worktreeId) return
    reqId += 1
    currentReq = String(reqId)
    results = []
    activeIndex = 0
    void window.workbench.search.ripgrep(worktreeId, query, currentReq)
  }

  function onQueryInput(): void {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(runSearch, 120)
  }

  onMount(() => {
    const offResult = window.workbench.on('event:search-result', (payload) => {
      const event = payload as { reqId: string; matches: SearchMatch[] }
      if (event.reqId !== currentReq) return
      if (results.length >= RESULT_CAP) return
      results = [...results, ...event.matches].slice(0, RESULT_CAP)
    })
    const offDone = window.workbench.on('event:search-done', () => {})
    return () => {
      offResult()
      offDone()
    }
  })

  // ── Preview of the selected match ──────────────────────────────
  const fileCache = new Map<string, string>()
  let previewLines = $state<{ n: number; text: string }[]>([])
  let previewFile = $state('')

  const selected = $derived(results[activeIndex] || null)

  $effect(() => {
    const match = selected
    if (!match || !worktreeId) {
      previewLines = []
      return
    }
    void loadPreview(match)
  })

  async function loadPreview(match: SearchMatch): Promise<void> {
    const abs = `${worktreeRoot}/${match.file}`
    let content = fileCache.get(abs)
    if (content === undefined) {
      content = await window.workbench.files.read(worktreeId!, abs).catch(() => '')
      fileCache.set(abs, content)
    }
    const lines = content.split('\n')
    const from = Math.max(0, match.line - 9)
    const to = Math.min(lines.length, match.line + 8)
    previewFile = match.file
    previewLines = lines.slice(from, to).map((text, index) => ({ n: from + index + 1, text }))
  }

  function open(match: SearchMatch): void {
    if (!worktreeId) return
    openFileAtLine(worktreeId, `${worktreeRoot}/${match.file}`, match.line)
    revealInTree(match.file)
    search.close()
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      search.close()
    } else if (event.key === 'ArrowDown' || (event.ctrlKey && event.key === 'j')) {
      event.preventDefault()
      activeIndex = Math.min(activeIndex + 1, results.length - 1)
    } else if (event.key === 'ArrowUp' || (event.ctrlKey && event.key === 'k')) {
      event.preventDefault()
      activeIndex = Math.max(activeIndex - 1, 0)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      if (selected) open(selected)
    }
  }
</script>

{#if search.open}
  <div
    class="fixed inset-0 z-modal flex items-start justify-center bg-black/50 pt-[10vh]"
    role="button"
    tabindex="0"
    onclick={() => search.close()}
    onkeydown={(event) => event.key === 'Escape' && search.close()}
  >
    <div
      class="flex h-[64vh] w-[860px] max-w-[92vw] flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-overlay"
      role="dialog"
      tabindex="0"
      onclick={(event) => event.stopPropagation()}
      onkeydown={onKeyDown}
    >
      <div class="flex items-center gap-2 border-b border-line px-3">
        <span class="font-mono text-xs text-dim">rg</span>
        <input
          bind:this={inputEl}
          bind:value={query}
          oninput={onQueryInput}
          class="w-full bg-transparent py-3 text-sm outline-none"
          placeholder="Search file contents…  (node_modules / .git excluded)"
        />
        <span class="shrink-0 font-mono text-2xs text-dim">{results.length}</span>
      </div>

      <div class="flex min-h-0 flex-1">
        <!-- Results -->
        <div class="w-[46%] shrink-0 overflow-auto border-r border-line">
          {#each results as match, index (index)}
            <button
              class="flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left {index ===
              activeIndex
                ? 'bg-hover'
                : ''} hover:bg-hover"
              onmousemove={() => (activeIndex = index)}
              onclick={() => open(match)}
            >
              <span class="flex w-full items-center gap-2">
                <span class="truncate font-mono text-2xs text-muted">{match.file}</span>
                <span class="ml-auto shrink-0 font-mono text-2xs text-dim">:{match.line}</span>
              </span>
              <span class="w-full truncate font-mono text-2xs text-dim">{match.text.trim()}</span>
            </button>
          {/each}
          {#if results.length === 0}
            <p class="px-3 py-4 text-xs text-dim">
              {query.trim() ? 'No matches.' : 'Type to search.'}
            </p>
          {/if}
        </div>

        <!-- Preview -->
        <div class="min-w-0 flex-1 overflow-auto bg-canvas">
          {#if previewLines.length > 0}
            <div class="border-b border-line px-3 py-1 font-mono text-2xs text-muted">
              {previewFile}
            </div>
            <pre class="px-2 py-1 font-mono text-2xs leading-relaxed">{#each previewLines as row (row.n)}<div
                  class="flex gap-3 {selected && row.n === selected.line
                    ? 'bg-amber-soft text-default'
                    : 'text-dim'}"
                ><span class="w-10 shrink-0 select-none text-right text-faint">{row.n}</span><span
                    class="whitespace-pre">{row.text}</span
                  ></div>{/each}</pre>
          {/if}
        </div>
      </div>
    </div>
  </div>
{/if}
