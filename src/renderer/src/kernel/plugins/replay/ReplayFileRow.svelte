<script lang="ts">
  // One file a replay step (or a comparison of two) changed. Clicking it opens
  // the change; the row's second action opens the file as that state left it
  // beside the working tree as it is now.
  import Icon from '@iconify/svelte'
  import ArrowsLeftRightIcon from 'phosphor-svelte/lib/ArrowsLeftRightIcon'
  import RowAction from '../gitChanges/RowAction.svelte'
  import { STATUS_COLOUR, baseName, directoryName } from '../gitChanges/changeTree'
  import { fileIcon } from '../../../lib/icons'
  import { store } from '../../../lib/store.svelte'
  import type { TreeFileChange } from '../../../../../shared/types'

  let {
    file,
    onOpen,
    onCompareWithNow
  }: {
    file: TreeFileChange
    onOpen: (file: TreeFileChange) => void
    onCompareWithNow: (file: TreeFileChange) => void
  } = $props()

  /** The file's icon in the active pack; reads the pack so a switch repaints it. */
  function iconFor(path: string): string {
    void store.iconPack
    return fileIcon(baseName(path))
  }
</script>

<div
  class="group/row flex w-full cursor-pointer items-center gap-1 py-[3px] pr-2 pl-6 text-xs text-muted select-none hover:bg-hover"
  role="treeitem"
  tabindex="-1"
  aria-selected="false"
  title={file.path}
  onclick={() => onOpen(file)}
  onkeydown={(event) => event.key === 'Enter' && onOpen(file)}
>
  <Icon icon={iconFor(file.path)} width="16" height="16" class="shrink-0" />
  <span class="min-w-0 truncate" class:line-through={file.status === 'deleted'}>
    {baseName(file.path)}
  </span>
  <span class="min-w-0 flex-1 truncate text-2xs text-dim">{directoryName(file.path)}</span>
  <span class="hidden group-hover/row:flex">
    <RowAction
      icon={ArrowsLeftRightIcon}
      title="Compare with the working tree"
      onclick={() => onCompareWithNow(file)}
    />
  </span>
  {#if file.added >= 0}
    <span class="shrink-0 font-mono text-2xs text-green">+{file.added}</span>
    <span class="shrink-0 font-mono text-2xs text-red">−{file.removed}</span>
  {/if}
  <span class="w-3 shrink-0 text-center font-mono text-2xs {STATUS_COLOUR[file.status]}">
    {file.status[0].toUpperCase()}
  </span>
</div>
