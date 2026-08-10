<script lang="ts">
  // The editor buffer tab strip for the Neovim center pane, showing the row of
  // open files. Dirty state is optional: nvim owns its own buffers and passes
  // none.
  import Icon from '@iconify/svelte'
  import { store } from '../lib/store.svelte'
  import { fileIcon } from '../lib/icons'

  interface Tab {
    path: string
    name: string
    pinned?: boolean
    worktreeId: string
    scratch?: boolean
  }

  /** File-type icon for a tab, tracking the active icon pack. */
  function iconFor(tab: Tab): string {
    store.iconPack
    return fileIcon(tab.name)
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

<div class="flex h-8 shrink-0 items-center bg-surface px-1.5">
  <div bind:this={stripEl} class="no-scrollbar min-w-0 flex-1 overflow-x-auto">
    <div class="flex w-max items-center gap-1">
      {#each tabs as tab (tab.path)}
        {@const active = store.activeTabPath === tab.path}
        <!-- Floating pills: inactive tabs sit flat on the strip, the active one
             lifts to elevated. Ephemeral scratch buffers (batch rename, etc.)
             get an amber tint so they read as distinct from real file tabs. -->
        <div
          data-tab={tab.path}
          class="group/tab flex h-6 shrink-0 cursor-pointer items-center rounded-md px-2 text-xs {!active &&
          tab.scratch
            ? 'bg-amber-soft/40'
            : ''}"
          class:bg-elevated={active && !tab.scratch}
          class:text-default={active && !tab.scratch}
          class:text-dim={!active && !tab.scratch}
          class:hover:bg-hover={!active && !tab.scratch}
          class:hover:text-default={!active && !tab.scratch}
          class:text-amber={tab.scratch}
          class:bg-amber-soft={active && tab.scratch}
          class:hover:bg-amber-soft={!active && tab.scratch}
        >
          <button class="flex cursor-pointer items-center gap-1.5" onclick={() => onSelect(tab.path)}>
            {#if tab.pinned}<Icon icon="ph:push-pin-fill" width="11" height="11" class="text-amber" />{/if}
            <Icon icon={iconFor(tab)} width="13" height="13" class="shrink-0" />
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
