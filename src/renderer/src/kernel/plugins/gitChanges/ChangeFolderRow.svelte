<script lang="ts">
  // A folder in the tree layout. Staging from here stages every change under it.
  import Icon from '@iconify/svelte'
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon'
  import MinusIcon from 'phosphor-svelte/lib/MinusIcon'
  import RowAction from './RowAction.svelte'
  import { store } from '../../../lib/store.svelte'
  import { folderIcon } from '../../../lib/icons'
  import { baseName, type FolderRow } from './changeTree'

  let {
    row,
    staged,
    collapsed,
    busy,
    onToggleCollapsed,
    onToggleStaged
  }: {
    row: FolderRow
    staged: boolean
    collapsed: boolean
    busy: boolean
    onToggleCollapsed: () => void
    onToggleStaged: () => void
  } = $props()

  /** The folder's icon in the active pack; reads the pack so a switch repaints it. */
  function iconFor(folder: FolderRow, isCollapsed: boolean): string {
    void store.iconPack
    return folderIcon(baseName(folder.path), !isCollapsed)
  }
</script>

<div
  class="group/row flex w-full cursor-pointer items-center gap-1 py-[3px] pr-2 text-xs text-muted select-none hover:bg-hover"
  style:padding-left="{row.depth * 12 + 4}px"
  role="treeitem"
  tabindex="-1"
  aria-selected="false"
  aria-expanded={!collapsed}
  title={row.path}
  onclick={onToggleCollapsed}
  onkeydown={(event) => event.key === 'Enter' && onToggleCollapsed()}
>
  <span class="w-3 shrink-0 text-center text-2xs text-dim">{collapsed ? '▸' : '▾'}</span>
  <Icon icon={iconFor(row, collapsed)} width="16" height="16" class="shrink-0" />
  <span class="min-w-0 flex-1 truncate">{row.name}</span>
  <div class="hidden shrink-0 items-center group-hover/row:flex">
    {#if staged}
      <RowAction icon={MinusIcon} title="Unstage folder" disabled={busy} onclick={onToggleStaged} />
    {:else}
      <RowAction icon={PlusIcon} title="Stage folder" disabled={busy} onclick={onToggleStaged} />
    {/if}
  </div>
  <span class="shrink-0 font-mono text-2xs text-dim group-hover/row:hidden">{row.fileCount}</span>
</div>
