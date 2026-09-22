<script lang="ts">
  // A file one commit changed. Clicking it opens that change: the file as the
  // commit left it beside the file as its parent had it.
  import Icon from '@iconify/svelte'
  import { store } from '../../../lib/store.svelte'
  import { fileIcon } from '../../../lib/icons'
  import { STATUS_COLOUR, baseName, directoryName } from './changeTree'
  import type { DiffFile } from '../../../../../shared/types'

  let {
    file,
    depth,
    onOpen
  }: {
    file: DiffFile
    depth: number
    onOpen: (file: DiffFile) => void
  } = $props()

  /** The path, or where it was renamed from and to. */
  function fileTitle(changed: DiffFile): string {
    if (changed.oldPath) return `${changed.oldPath} → ${changed.path}`
    return changed.path
  }

  /** The file's icon in the active pack; reads the pack so a switch repaints it. */
  function iconFor(changed: DiffFile): string {
    void store.iconPack
    return fileIcon(baseName(changed.path))
  }
</script>

<div
  class="group/row flex w-full cursor-pointer items-center gap-1 py-[3px] pr-2 text-xs text-muted select-none hover:bg-hover"
  style:padding-left="{depth * 12 + 4}px"
  role="treeitem"
  tabindex="-1"
  aria-selected="false"
  title={fileTitle(file)}
  onclick={() => onOpen(file)}
  onkeydown={(event) => event.key === 'Enter' && onOpen(file)}
>
  <span class="w-3 shrink-0"></span>
  <Icon icon={iconFor(file)} width="16" height="16" class="shrink-0" />
  <span class="min-w-0 truncate" class:line-through={file.changeType === 'deleted'}>
    {baseName(file.path)}
  </span>
  <span class="min-w-0 flex-1 truncate text-2xs text-dim">{directoryName(file.path)}</span>
  <span class="w-3 shrink-0 text-center font-mono text-2xs {STATUS_COLOUR[file.changeType]}">
    {file.changeType[0].toUpperCase()}
  </span>
</div>
