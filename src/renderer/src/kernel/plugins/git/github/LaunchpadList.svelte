<script lang="ts">
  // Launchpad's list: the column headings once at the top, then each group
  // under a heading that folds it away. Narrower than WIDE_PX the author,
  // assignee and branch columns are left out, so the list still reads beside
  // an open thread.
  import FloatingScrollbar from '@neoworks-dev/ui/FloatingScrollbar'
  import CaretDownIcon from 'phosphor-svelte/lib/CaretDownIcon'
  import CaretRightIcon from 'phosphor-svelte/lib/CaretRightIcon'
  import ClockIcon from 'phosphor-svelte/lib/ClockIcon'
  import PushPinIcon from 'phosphor-svelte/lib/PushPinIcon'
  import LaunchpadRow from './LaunchpadRow.svelte'
  import { optionColour } from './board'
  import { pinKey, type LaunchpadGroup } from './launchpad'
  import { github, toggleChecked, togglePin } from './store.svelte'
  import type { GithubItem } from '../../../../../../shared/types'

  let {
    groups,
    onopen
  }: {
    groups: LaunchpadGroup[]
    onopen: (item: GithubItem) => void
  } = $props()

  const WIDE_PX = 640
  const NARROW_COLUMNS = '18px 20px 28px 48px minmax(0, 1fr)'
  const WIDE_COLUMNS = `${NARROW_COLUMNS} 48px 72px minmax(0, 160px)`

  let width = $state(0)
  let folded = $state<string[]>([])

  const wide = $derived(width >= WIDE_PX)
  const columns = $derived(wide ? WIDE_COLUMNS : NARROW_COLUMNS)

  /** Folds a group away, or opens it again. */
  function toggleFold(id: string): void {
    if (folded.includes(id)) {
      folded = folded.filter((entry) => entry !== id)
      return
    }
    folded = [...folded, id]
  }

  /** Whether an item's thread is the one open on the right. */
  function isSelected(item: GithubItem): boolean {
    const selection = github.selection
    if (!selection) return false
    return selection.number === item.number && selection.kind === item.kind
  }
</script>

<div class="flex min-h-0 flex-1 flex-col" bind:clientWidth={width}>
  <div
    class="grid shrink-0 items-center gap-2 border-b border-line px-2 py-1 pl-[10px] text-2xs uppercase tracking-caps text-faint"
    style:grid-template-columns={columns}
  >
    <span></span>
    <span class="grid place-items-center"><PushPinIcon size={11} /></span>
    <span><ClockIcon size={11} /></span>
    <span>Status</span>
    <span>Item</span>
    {#if wide}
      <span>Author</span>
      <span>Assignees</span>
      <span>Branch</span>
    {/if}
  </div>

  <FloatingScrollbar class="min-h-0 flex-1">
    <div>
      {#each groups as group (group.id)}
        <button
          class="flex w-full items-center gap-1.5 border-b border-line bg-surface px-2 py-1 text-left text-2xs font-semibold uppercase tracking-caps text-muted hover:bg-hover"
          aria-expanded={!folded.includes(group.id)}
          onclick={() => toggleFold(group.id)}
        >
          {#if folded.includes(group.id)}
            <CaretRightIcon size={10} />
          {:else}
            <CaretDownIcon size={10} />
          {/if}
          {#if group.colour !== undefined}
            <span class="size-2 rounded-full" style:background={optionColour(group.colour)}></span>
          {/if}
          {group.title}
          <span class="font-mono font-normal text-dim">{group.items.length}</span>
        </button>
        {#if !folded.includes(group.id)}
          {#each group.items as item (item.kind + item.number)}
            <LaunchpadRow
              {item}
              {columns}
              {wide}
              selected={isSelected(item)}
              checked={github.checked.includes(item.number)}
              pinned={github.pins.includes(pinKey(item))}
              pinnedOnGithub={item.isPinned === true}
              onselect={() => onopen(item)}
              ontoggle={() => toggleChecked(item.number)}
              onpin={() => togglePin(item)}
            />
          {/each}
        {/if}
      {/each}
    </div>
  </FloatingScrollbar>
</div>
