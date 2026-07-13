<script lang="ts">
  // The editor buffer tab strip, shared by the CodeMirror and Neovim center
  // panes so both show the same row of open files. Dirty state is optional:
  // CodeMirror tracks unsaved edits per path; nvim owns its own buffers and
  // passes none.
  import Icon from '@iconify/svelte'
  import { store } from '../lib/store.svelte'

  interface Tab {
    path: string
    name: string
    pinned?: boolean
    worktreeId: string
  }

  let {
    tabs,
    dirtyPaths = {},
    onSelect,
    onClose
  }: {
    tabs: Tab[]
    dirtyPaths?: Record<string, boolean>
    onSelect: (path: string) => void
    onClose: (path: string, event: MouseEvent) => void
  } = $props()

  let stripEl = $state<HTMLDivElement>()

  // Keep the active tab visible when it changes (opened via finder/tree while
  // the strip is scrolled elsewhere).
  $effect(() => {
    const active = store.activeTabPath
    if (!stripEl || !active) return
    for (const el of stripEl.querySelectorAll<HTMLElement>('[data-tab]')) {
      if (el.dataset.tab !== active) continue
      el.scrollIntoView({ inline: 'nearest', block: 'nearest' })
      return
    }
  })
</script>

<div class="flex h-8 shrink-0 items-stretch">
  <div bind:this={stripEl} class="no-scrollbar min-w-0 flex-1 overflow-x-auto">
    <div class="flex h-full w-max items-stretch">
      {#each tabs as tab (tab.path)}
        <div
          data-tab={tab.path}
          class="group/tab flex h-8 shrink-0 cursor-pointer items-center gap-1 px-3 text-xs {store.activeTabPath ===
          tab.path
            ? 'border-x border-line bg-elevated text-default'
            : 'border-y border-line text-dim hover:bg-hover hover:text-default'}"
        >
          <button class="flex cursor-pointer items-center gap-1" onclick={() => onSelect(tab.path)}>
            {#if tab.pinned}<Icon icon="ph:push-pin-fill" width="11" height="11" class="text-amber" />{/if}
            <span>{tab.name}</span>
            {#if dirtyPaths[tab.path]}<span class="text-amber">●</span>{/if}
          </button>
          <button
            class="invisible cursor-pointer text-dim hover:text-red group-hover/tab:visible"
            title="Close tab"
            onclick={(event) => onClose(tab.path, event)}>✕</button
          >
        </div>
      {/each}
    </div>
  </div>
</div>
