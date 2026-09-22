<script lang="ts">
  // One tag. Tags are read-only markers, so the menu is comparing against one
  // and merging it in — not checking it out, which would detach HEAD.
  import TagIcon from 'phosphor-svelte/lib/TagIcon'
  import DotsThreeIcon from 'phosphor-svelte/lib/DotsThreeIcon'
  import ContextMenu from '../../../components/ContextMenu.svelte'
  import RowAction from './RowAction.svelte'
  import { relativeTime } from '../../../lib/time'
  import { tagMenu } from './refMenus'
  import type { TagRef } from '../../../../../shared/types'

  let {
    worktreeId,
    worktreePath,
    tag,
    currentBranch,
    onChanged
  }: {
    worktreeId: string
    worktreePath: string
    tag: TagRef
    currentBranch: string
    onChanged: () => void
  } = $props()

  let menu = $state<{ x: number; y: number } | null>(null)

  const context = $derived({ worktreeId, worktreePath, currentBranch, onChanged })

  /** Opens the menu at the pointer. */
  function openMenu(event: MouseEvent): void {
    event.preventDefault()
    event.stopPropagation()
    menu = { x: event.clientX, y: event.clientY }
  }

  /** The tooltip: when the tag was made, and its message or commit subject. */
  function details(): string {
    return `${tag.name} · ${new Date(tag.date).toLocaleString()}\n${tag.subject}`
  }
</script>

<div
  class="group/row flex w-full cursor-default items-center gap-1 py-[3px] pr-2 pl-1 text-xs text-muted select-none hover:bg-hover"
  role="treeitem"
  tabindex="-1"
  aria-selected="false"
  aria-label={tag.name}
  title={details()}
  oncontextmenu={openMenu}
>
  <span class="w-3 shrink-0"></span>
  <span class="grid w-4 shrink-0 place-items-center text-dim"><TagIcon size={12} /></span>
  <span class="min-w-0 flex-1 truncate">{tag.name}</span>
  <div class="hidden shrink-0 items-center group-hover/row:flex">
    <RowAction icon={DotsThreeIcon} title="More actions" onclick={openMenu} />
  </div>
  <span class="shrink-0 font-mono text-2xs text-dim group-hover/row:hidden">
    {relativeTime(tag.date)}
  </span>
</div>

{#if menu}
  <ContextMenu x={menu.x} y={menu.y} items={tagMenu(context, tag)} onClose={() => (menu = null)} />
{/if}
