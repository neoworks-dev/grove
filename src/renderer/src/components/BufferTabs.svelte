<script lang="ts">
  // The editor buffer tab strip for the Neovim center pane, showing the row of
  // open files. Dirty state is optional: nvim owns its own buffers and passes
  // none.
  import Icon from '@iconify/svelte'
  import { store } from '../lib/store.svelte'

  interface Tab {
    path: string
    name: string
    pinned?: boolean
    worktreeId: string
    scratch?: boolean
  }

  // Ephemeral scratch buffers (batch rename, etc.) get an amber tint so they
  // read as distinct from real file tabs.
  function tabClass(tab: Tab): string {
    const active = store.activeTabPath === tab.path
    if (tab.scratch) {
      return active
        ? 'border-x border-amber/40 bg-amber-soft text-amber'
        : 'border-y border-line bg-amber-soft/40 text-amber hover:bg-amber-soft'
    }
    return active
      ? 'border-x border-line bg-elevated text-default'
      : 'border-y border-line text-dim hover:bg-hover hover:text-default'
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

<div class="flex h-7 shrink-0 items-stretch bg-surface">
  <div bind:this={stripEl} class="no-scrollbar min-w-0 flex-1 overflow-x-auto">
    <div class="flex h-full w-max items-stretch">
      {#each tabs as tab (tab.path)}
        <div
          data-tab={tab.path}
          class="group/tab flex h-7 shrink-0 cursor-pointer items-center px-3 text-xs {tabClass(
            tab
          )}"
        >
          <button class="flex cursor-pointer items-center gap-1" onclick={() => onSelect(tab.path)}>
            {#if tab.pinned}<Icon icon="ph:push-pin-fill" width="11" height="11" class="text-amber" />{/if}
            <span>{tab.name}</span>
            {#if dirtyPaths[tab.path]}<span class="text-amber">●</span>{/if}
          </button>
          <button
            class="inline-flex w-0 shrink-0 cursor-pointer items-center overflow-hidden text-dim opacity-0 transition-all duration-150 ease-out hover:text-red group-hover/tab:ml-1 group-hover/tab:w-3.5 group-hover/tab:opacity-100"
            title="Close tab"
            onclick={(event) => onClose(tab.path, event)}>✕</button
          >
        </div>
      {/each}
    </div>
  </div>
</div>
