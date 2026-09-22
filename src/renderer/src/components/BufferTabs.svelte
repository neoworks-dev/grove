<script lang="ts">
  // The editor buffer tab strip for the Neovim center pane, showing the row of
  // open files. Dirty state is optional; NvimPane sources it from nvim's
  // 'modified' flag and marks those tabs with a dot ahead of the file icon.
  import Icon from '@iconify/svelte'
  import ArrowsLeftRightIcon from 'phosphor-svelte/lib/ArrowsLeftRightIcon'
  import { store, type TabDiff } from '../lib/store.svelte'
  import { fileIcon } from '../lib/icons'
  import PaneControls from './PaneControls.svelte'

  interface Tab {
    path: string
    name: string
    pinned?: boolean
    worktreeId: string
    scratch?: boolean
    diff?: TabDiff
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
        {@const tinted = tab.scratch || tab.diff !== undefined}
        <!-- Floating pills: inactive tabs sit flat on the strip, the active one
             lifts to elevated. Ephemeral scratch buffers (batch rename, a
             commit's revision) and files open as one side of a diff get an
             amber tint so they read as distinct from plain file tabs; a diff
             also names the two sides it is between. -->
        <div
          data-tab={tab.path}
          class="group/tab flex h-6 shrink-0 cursor-pointer items-center rounded-md px-2 text-xs {!active &&
          tinted
            ? 'bg-amber-soft/40'
            : ''}"
          class:bg-elevated={active && !tinted}
          class:text-default={active && !tinted}
          class:text-dim={!active && !tinted}
          class:hover:bg-hover={!active && !tinted}
          class:hover:text-default={!active && !tinted}
          class:text-amber={tinted}
          class:bg-amber-soft={active && tinted}
          class:hover:bg-amber-soft={!active && tinted}
        >
          <button class="flex cursor-pointer items-center gap-1.5" onclick={() => onSelect(tab.path)}>
            {#if tab.pinned}<Icon icon="ph:push-pin-fill" width="11" height="11" class="text-amber" />{/if}
            <!-- Unsaved marker sits ahead of the file icon, so a scanning eye
                 finds every dirty tab in one straight column. -->
            {#if dirtyPaths[tab.path]}<span
                class="shrink-0 text-[8px] leading-none text-amber"
                title="Unsaved changes">●</span
              >{/if}
            <Icon icon={iconFor(tab)} width="13" height="13" class="shrink-0" />
            <span>{tab.name}</span>
            {#if tab.diff}
              <span
                class="flex max-w-56 items-center gap-0.5 font-mono text-2xs opacity-70"
                title="{tab.diff.left} ⇄ {tab.diff.right}"
              >
                <span class="truncate">{tab.diff.left}</span>
                <ArrowsLeftRightIcon size={10} class="shrink-0" />
                <span class="truncate">{tab.diff.right}</span>
              </span>
            {/if}
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
  <PaneControls class="ml-1.5" />
</div>
