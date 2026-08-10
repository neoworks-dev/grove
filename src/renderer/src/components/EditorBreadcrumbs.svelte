<script lang="ts">
  // Bottom-bar breadcrumbs for the editor: the active file's path inside the
  // worktree (one step per directory, file-tree icon on the file) plus the
  // treesitter code scopes enclosing the cursor. Lives in the status bar but
  // pins itself horizontally under the nvim pane, re-measuring whenever the
  // layout (splits, docks, window) changes. Clicking a path step opens the
  // explorer revealed at that exact path.
  import { onMount } from 'svelte'
  import Icon from '@iconify/svelte'
  import CaretRightIcon from 'phosphor-svelte/lib/CaretRightIcon'
  import FunctionIcon from 'phosphor-svelte/lib/FunctionIcon'
  import { store } from '../lib/store.svelte'
  import { layout } from '../lib/layout.svelte'
  import { fileIcon } from '../lib/icons'

  const segments = $derived.by(() => {
    const path = store.activeTabPath
    const root = store.selectedWorktree?.path
    if (!path) return []
    const relative = root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
    return relative.split('/').filter((part) => part.length > 0)
  })

  /** Icon for the file step, tracking the active icon pack. */
  function iconFor(name: string): string {
    store.iconPack
    return fileIcon(name)
  }

  // Named code scopes (outer first) around the cursor, pushed by the editor's
  // treesitter autocmd.
  let codeNames = $state<string[]>([])

  // Reset the stale chain on file switches; the next cursor event refills it.
  $effect(() => {
    void store.activeTabPath
    codeNames = []
  })

  /** Open the explorer expanded and selected at the clicked breadcrumb step. */
  function revealInExplorer(index: number): void {
    layout.ensurePane('files')
    store.explorerRevealPath = segments.slice(0, index + 1).join('/')
  }

  // The bar flows inside the status bar (so it clips with it) but indents
  // itself so its content starts under the nvim pane's left edge and never
  // grows wider than the pane.
  let rootEl = $state<HTMLDivElement>()
  let marginLeft = $state(0)
  let paneWidth = $state(0)

  function measure(): void {
    const canvas = document.querySelector('[data-leaf] canvas')
    const leaf = canvas?.closest('[data-leaf]')
    if (!leaf) {
      paneWidth = 0
      return
    }
    const rect = leaf.getBoundingClientRect()
    paneWidth = rect.width
    if (!rootEl) return
    // Where the bar would naturally start with no indent; the margin bridges
    // the difference to the pane's left edge.
    const naturalLeft = rootEl.getBoundingClientRect().left - marginLeft
    marginLeft = Math.max(0, rect.left - naturalLeft)
  }

  // Re-measure after any layout change that can move the pane; the rAF lets
  // the DOM settle first.
  $effect(() => {
    void layout.tree
    void Object.values(layout.paneSizes)
    void layout.docks.left.open
    void layout.docks.left.size
    void layout.docks.right.open
    void layout.docks.right.size
    void segments
    void rootEl
    requestAnimationFrame(measure)
  })

  onMount(() => {
    measure()
    window.addEventListener('resize', measure)
    const stopContext = window.workbench.on('event:nvim-notify', (payload) => {
      const event = payload as { method: string; args: unknown[] }
      if (event.method !== 'grove_code_context') return
      const data = (event.args?.[0] ?? {}) as { names?: unknown }
      if (Array.isArray(data.names)) codeNames = data.names.filter((n) => typeof n === 'string')
    })
    return () => {
      window.removeEventListener('resize', measure)
      stopContext()
    }
  })
</script>

{#if segments.length > 0 && paneWidth > 0}
  <div
    bind:this={rootEl}
    class="no-scrollbar flex min-w-0 select-none items-center gap-1 overflow-x-auto px-2 text-xs text-muted"
    style="margin-left:{marginLeft}px;max-width:{paneWidth}px"
  >
    {#each segments as segment, index (index)}
      {@const isFile = index === segments.length - 1}
      {#if index > 0}
        <CaretRightIcon size={10} class="shrink-0 text-faint" />
      {/if}
      <button
        class="flex shrink-0 cursor-pointer items-center gap-1 hover:text-default"
        class:text-default={isFile}
        onclick={() => revealInExplorer(index)}
      >
        {#if isFile}
          <Icon icon={iconFor(segment)} width="13" height="13" class="shrink-0" />
        {/if}
        <span>{segment}</span>
      </button>
    {/each}
    {#each codeNames as name, index (index)}
      <CaretRightIcon size={10} class="shrink-0 text-faint" />
      <span class="flex shrink-0 items-center gap-1 text-dim">
        <FunctionIcon size={11} class="shrink-0" />
        <span>{name}</span>
      </span>
    {/each}
  </div>
{/if}
