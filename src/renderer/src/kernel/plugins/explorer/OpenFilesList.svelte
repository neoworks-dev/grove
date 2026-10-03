<script lang="ts">
  // The selected worktree's open editor tabs as a list: the file's name, the
  // folder it sits in, and a close button on hover. Scratch buffers are left
  // out — they have no file to show, and only the editor knows how to close one.
  import FloatingScrollbar from '@neoworks-dev/ui/FloatingScrollbar'
  import Icon from '@iconify/svelte'
  import XIcon from 'phosphor-svelte/lib/XIcon'
  import RowAction from '../gitChanges/RowAction.svelte'
  import { fileIcon } from '../../../lib/icons'
  import { openFileInEditor, store, type EditorTab } from '../../../lib/store.svelte'

  let { tabs, worktreePath }: { tabs: EditorTab[]; worktreePath: string } = $props()

  /** File-type icon for a tab, tracking the active icon pack. */
  function iconFor(tab: EditorTab): string {
    store.iconPack
    return fileIcon(tab.name)
  }

  /** The folder a tab's file sits in, relative to the worktree; empty at its root. */
  function folderOf(tab: EditorTab): string {
    let relative = tab.path
    if (relative.startsWith(worktreePath + '/')) {
      relative = relative.slice(worktreePath.length + 1)
    }
    const slash = relative.lastIndexOf('/')
    if (slash === -1) return ''
    return relative.slice(0, slash)
  }

  /** Shows the tab in the editor. */
  function open(tab: EditorTab): void {
    openFileInEditor(tab.worktreeId, tab.path)
  }
</script>

<FloatingScrollbar class="max-h-[35vh] min-h-0">
  <div class="pb-1">
    {#each tabs as tab (tab.path)}
      {@const folder = folderOf(tab)}
      <div
        class="group/row flex w-full cursor-pointer select-none items-center gap-1.5 py-[3px] pr-2 pl-4 text-xs hover:bg-hover"
        role="button"
        tabindex="-1"
        title={tab.path}
        onclick={() => open(tab)}
        onkeydown={(event) => {
          if (event.key === 'Enter') open(tab)
        }}
      >
        <Icon icon={iconFor(tab)} width="16" height="16" class="shrink-0" />
        <span
          class={[
            'min-w-0 truncate',
            tab.path === store.activeTabPath && 'text-default',
            tab.path !== store.activeTabPath && 'text-muted'
          ]}>{tab.name}</span
        >
        <span class="min-w-0 flex-1 truncate text-2xs text-dim">{folder}</span>
        <span class="flex shrink-0 opacity-0 group-hover/row:opacity-100">
          <RowAction icon={XIcon} title="Close {tab.name}" onclick={() => store.closeTab(tab.path)} />
        </span>
      </div>
    {/each}
  </div>
</FloatingScrollbar>
