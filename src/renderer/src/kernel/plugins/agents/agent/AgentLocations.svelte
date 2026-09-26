<script lang="ts">
  // Places in the code an agent pointed at, as a card in the conversation.
  //
  // Nothing opens by itself: an answer naming four places used to open four
  // files and mark all of them. Here each place is a row, and picking one opens
  // that file with its lines marked and the agent's notes written above them —
  // replacing whatever the last pick marked, so one place is in view at a time.
  import Icon from '@iconify/svelte'
  import CrosshairIcon from 'phosphor-svelte/lib/CrosshairIcon'
  import { fileIcon } from '../../../../lib/icons'
  import type { CodeLocation } from '../../../../lib/agents/types'

  let {
    title,
    locations,
    root = '',
    onOpen
  }: {
    title?: string
    locations: CodeLocation[]
    /** The worktree the session runs in; paths show relative to it. */
    root?: string
    onOpen?: (location: CodeLocation) => void
  } = $props()

  // The row opened last, so the card shows which place is on screen.
  let openedIndex = $state<number | null>(null)

  /** A path as the user reads it: relative to the worktree when it is inside it. */
  function shownPath(path: string): string {
    const prefix = `${root}/`
    if (root && path.startsWith(prefix)) return path.slice(prefix.length)
    return path
  }

  /** The line range after the path, or nothing for a whole file. */
  function rangeOf(location: CodeLocation): string {
    if (location.startLine === undefined) return ''
    if (location.endLine === undefined || location.endLine === location.startLine) {
      return `:${location.startLine}`
    }
    return `:${location.startLine}-${location.endLine}`
  }

  /** Open one place and remember it as the one on screen. */
  function open(index: number): void {
    openedIndex = index
    onOpen?.(locations[index])
  }

  /** How many places the card holds, in words. */
  function countLabel(count: number): string {
    if (count === 1) return '1 location'
    return `${count} locations`
  }

  /** How many lines of a place are annotated, in words. */
  function noteCountLabel(count: number): string {
    if (count === 1) return '1 note'
    return `${count} notes`
  }
</script>

<div class="mb-3 overflow-hidden rounded-md border border-line bg-elevated" data-testid="agent-locations">
  <div class="flex items-center gap-1.5 border-b border-line px-2.5 py-1.5 text-2xs">
    <span class="text-violet"><CrosshairIcon size={12} /></span>
    <span class="min-w-0 flex-1 truncate font-medium text-default">
      {title ?? countLabel(locations.length)}
    </span>
    {#if title}
      <span class="shrink-0 text-dim">{countLabel(locations.length)}</span>
    {/if}
  </div>
  <ul>
    {#each locations as location, index (index)}
      <li>
        <button
          class="flex w-full flex-col gap-0.5 border-l-2 px-2.5 py-1.5 text-left transition-colors duration-100 hover:bg-hover"
          class:border-l-violet={openedIndex === index}
          class:bg-hover={openedIndex === index}
          class:border-l-transparent={openedIndex !== index}
          title="Open {shownPath(location.path)}{rangeOf(location)}"
          onclick={() => open(index)}
        >
          <span class="flex min-w-0 items-center gap-1.5 font-mono text-2xs">
            <Icon icon={fileIcon(location.path)} width="12" height="12" class="shrink-0" />
            <span class="min-w-0 truncate text-default">{shownPath(location.path)}</span>
            <span class="shrink-0 text-dim">{rangeOf(location)}</span>
            {#if location.annotations && location.annotations.length > 0}
              <span class="ml-auto shrink-0 text-dim" title="Annotated lines">
                {noteCountLabel(location.annotations.length)}
              </span>
            {/if}
          </span>
          {#if location.note}
            <span class="pl-[18px] text-2xs text-muted">{location.note}</span>
          {/if}
        </button>
      </li>
    {/each}
  </ul>
</div>
